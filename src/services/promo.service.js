const PromoCode = require('../models/PromoCode');
const PromoUsage = require('../models/PromoUsage');
const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const { withTransaction } = require('./transactionHelper.service');

const sessionOptions = (session) => (session ? { session } : {});

const isPromoCurrentlyValid = (promo) => {
  if (!promo || promo.isActive === false) return false;
  return !promo.expiresAt || new Date() <= new Date(promo.expiresAt);
};

const getUserUsageCount = async (promoId, userId, session) => (
  PromoUsage.countDocuments({ promoId, userId }, sessionOptions(session))
);

/**
 * Atomically consumes one activation slot and records a successful use.
 * It is called from the purchase transaction, not from the promo input step.
 */
const consumePromoUsage = async ({ promo, userId, orderId = null, discountAmount = 0, session = null }) => {
  const opts = sessionOptions(session);
  const usageCount = await getUserUsageCount(promo._id, userId, session);

  if (promo.maxPerUser !== -1 && usageCount >= promo.maxPerUser) {
    throw new Error('PROMO_USER_LIMIT');
  }

  const activationFilter = {
    _id: promo._id,
    isActive: true,
    ...(promo.maxActivations === -1 ? {} : { currentActivations: { $lt: promo.maxActivations } }),
  };
  const claimedPromo = await PromoCode.findOneAndUpdate(
    activationFilter,
    { $inc: { currentActivations: 1 } },
    { new: true, ...opts }
  );
  if (!claimedPromo) throw new Error('PROMO_GLOBAL_LIMIT');

  const usage = new PromoUsage({
    promoId: promo._id,
    userId,
    orderId,
    usageNumber: usageCount + 1,
    code: promo.code,
    type: promo.type,
    discountAmount: Number(discountAmount) || 0,
  });
  await usage.save(opts);
  return usage;
};

/**
 * Activates a promo for the next purchase. Discount promos are only reserved
 * here; their global/per-user counters are consumed after a successful order.
 * Balance promos are immediate credit operations and therefore consume usage
 * and write a ledger entry in one transaction.
 */
const activatePromoCode = async (user, codeStr) => {
  const lang = user?.language || 'ru';
  const isEn = lang === 'en';

  if (!codeStr || typeof codeStr !== 'string') {
    return { success: false, reason: isEn ? '❌ Please enter a promo code' : '❌ Введите промокод' };
  }

  const cleanCode = codeStr.trim().toUpperCase();
  const promo = await PromoCode.findOne({ code: cleanCode, isActive: true }).populate('productId');

  if (!isPromoCurrentlyValid(promo)) {
    return { success: false, reason: isEn ? '❌ Promo code not found, inactive or expired' : '❌ Промокод не найден, неактивен или истёк' };
  }

  const userUsageCount = await getUserUsageCount(promo._id, user._id);
  if (promo.maxPerUser !== -1 && userUsageCount >= promo.maxPerUser) {
    return { success: false, reason: isEn ? '❌ You have already used this promo code the maximum number of times' : '❌ Вы уже использовали этот промокод максимальное число раз' };
  }

  if (promo.maxActivations !== -1 && promo.currentActivations >= promo.maxActivations) {
    return { success: false, reason: isEn ? '❌ Promo code activation limit reached' : '❌ Превышен лимит использований промокода' };
  }

  if (promo.audienceCondition === 'repeat_only') {
    const completedOrders = await Order.countDocuments({ userId: user._id, status: 'completed' });
    if (completedOrders < 1) {
      return { success: false, reason: isEn ? '❌ This promo code is available only from your second purchase!' : '❌ Этот промокод доступен только со второй покупки!' };
    }
  } else if (promo.audienceCondition === 'first_only') {
    const completedOrders = await Order.countDocuments({ userId: user._id, status: 'completed' });
    if (completedOrders > 0) {
      return { success: false, reason: isEn ? '❌ This promo code is valid only for your first order!' : '❌ Этот промокод действует только на первый заказ!' };
    }
  }

  if (promo.type === 'balance') {
    let updatedUser = null;
    await withTransaction(async (session) => {
      const opts = sessionOptions(session);
      updatedUser = await User.findOneAndUpdate(
        { _id: user._id },
        { $inc: { balance: promo.value } },
        { new: true, ...opts }
      );
      if (!updatedUser) throw new Error('USER_NOT_FOUND');

      await consumePromoUsage({
        promo,
        userId: user._id,
        discountAmount: promo.value,
        session,
      });

      await new Transaction({
        userId: user._id,
        type: 'manual_credit',
        amount: promo.value,
        description: `Промокод на баланс: ${promo.code}`,
      }).save(opts);
    });

    return {
      success: true,
      type: 'balance',
      code: promo.code,
      bonusAmount: promo.value,
      newBalance: updatedUser.balance,
    };
  }

  await User.updateOne({ _id: user._id }, { $set: { activePromoCode: promo._id } });

  const rawProductId = promo.productId?._id || promo.productId || null;
  return {
    success: true,
    type: promo.type,
    code: promo.code,
    promoId: promo._id,
    value: promo.value,
    minOrderAmount: promo.minOrderAmount,
    productId: rawProductId ? rawProductId.toString() : null,
    productName: promo.productId?.name || null,
    minQuantity: promo.minQuantity || 1,
    discountTarget: promo.discountTarget || 'all',
    audienceCondition: promo.audienceCondition || 'all',
    isActive: true,
  };
};

/** Validates a promo and calculates its discount without mutating the ledger. */
const calculateDiscount = async (promo, orderAmount, productId = null, options = {}) => {
  const opts = typeof options === 'number' ? { qty: options } : (options || {});
  const lang = opts.lang || 'ru';
  const isEn = lang === 'en';

  if (!isPromoCurrentlyValid(promo)) {
    return { valid: false, reason: isEn ? '❌ Promo code not found, inactive or expired' : '❌ Промокод не найден или истёк' };
  }
  if (!['percent', 'fixed'].includes(promo.type)) {
    return { valid: false, reason: isEn ? '❌ Promo code is not a discount promo' : '❌ Это не скидочный промокод' };
  }

  const qty = Math.max(1, parseInt(opts.qty, 10) || 1);
  const userId = opts.userId || null;
  let userCompletedOrders = typeof opts.userCompletedOrders === 'number' ? opts.userCompletedOrders : null;

  if (promo.minOrderAmount && orderAmount < promo.minOrderAmount) {
    return {
      valid: false,
      reason: isEn
        ? `❌ Promo code requires a minimum order of ${promo.minOrderAmount} USDT`
        : `❌ Промокод действует только от ${promo.minOrderAmount} USDT`,
    };
  }

  const promoProdId = promo.productId?._id ? String(promo.productId._id) : (promo.productId ? String(promo.productId) : null);
  const targetProdId = productId?._id ? String(productId._id) : (productId ? String(productId) : null);
  if (promoProdId && (!targetProdId || promoProdId !== targetProdId)) {
    return {
      valid: false,
      reason: isEn
        ? '❌ Promo code is not valid for this product'
        : '❌ Промокод не распространяется на данный товар',
    };
  }

  if (promo.discountTarget === 'second_item' && qty < 2) {
    return {
      valid: false,
      reason: isEn
        ? '❌ Promo code applies to 2nd item (please order at least 2 pcs)'
        : '❌ Промокод действует на 2-ю единицу товара (добавьте от 2 шт.)',
    };
  }

  const minQty = Math.max(1, parseInt(promo.minQuantity, 10) || 1);
  if (minQty > 1 && qty < minQty) {
    return {
      valid: false,
      reason: isEn
        ? `❌ Promo code requires ordering at least ${minQty} pcs`
        : `❌ Промокод действует при заказе от ${minQty} шт.`,
    };
  }

  if (promo.audienceCondition === 'repeat_only' || promo.audienceCondition === 'first_only') {
    if (userCompletedOrders === null && userId) {
      userCompletedOrders = await Order.countDocuments({ userId, status: 'completed' });
    }

    const completedCount = userCompletedOrders !== null ? userCompletedOrders : 0;

    if (promo.audienceCondition === 'repeat_only') {
      if (completedCount < 1) {
        return {
          valid: false,
          reason: isEn
            ? '❌ This promo code is available only from your second purchase!'
            : '❌ Этот промокод доступен только со второй покупки!',
        };
      }
    } else if (promo.audienceCondition === 'first_only') {
      if (completedCount > 0) {
        return {
          valid: false,
          reason: isEn
            ? '❌ This promo code is valid only for your first order!'
            : '❌ Этот промокод действует только на первый заказ!',
        };
      }
    }
  }

  let discountAmount = 0;
  if (promo.discountTarget === 'second_item') {
    const unitPrice = orderAmount / qty;
    if (promo.type === 'percent') {
      discountAmount = (unitPrice * promo.value) / 100;
    } else if (promo.type === 'fixed') {
      discountAmount = Math.min(unitPrice, promo.value);
    }
  } else {
    if (promo.type === 'percent') {
      discountAmount = Math.min(orderAmount, (orderAmount * promo.value) / 100);
    } else if (promo.type === 'fixed') {
      discountAmount = Math.min(orderAmount, promo.value);
    }
  }

  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalPrice = Math.max(0, Math.round((orderAmount - discountAmount) * 100) / 100);

  return { valid: true, discountAmount, finalPrice };
};

const consumeDiscountPromo = async ({ promoId, userId, orderId, discountAmount, session = null }) => {
  const query = PromoCode.findById(promoId);
  if (session) query.session(session);
  const promo = await query;
  if (!isPromoCurrentlyValid(promo) || !['percent', 'fixed'].includes(promo.type)) {
    throw new Error('PROMO_UNAVAILABLE');
  }

  return consumePromoUsage({
    promo,
    userId,
    orderId,
    discountAmount,
    session,
  });
};

module.exports = {
  activatePromoCode,
  calculateDiscount,
  consumeDiscountPromo,
};

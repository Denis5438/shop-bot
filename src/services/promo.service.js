const PromoCode = require('../models/PromoCode');
const PromoUsage = require('../models/PromoUsage');
const User = require('../models/User');
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
  if (!codeStr || typeof codeStr !== 'string') {
    return { success: false, reason: '❌ Введите промокод' };
  }

  const cleanCode = codeStr.trim().toUpperCase();
  const promo = await PromoCode.findOne({ code: cleanCode, isActive: true });

  if (!isPromoCurrentlyValid(promo)) {
    return { success: false, reason: '❌ Промокод не найден, неактивен или истёк' };
  }

  const userUsageCount = await getUserUsageCount(promo._id, user._id);
  if (promo.maxPerUser !== -1 && userUsageCount >= promo.maxPerUser) {
    return { success: false, reason: '❌ Вы уже использовали этот промокод максимальное число раз' };
  }

  if (promo.maxActivations !== -1 && promo.currentActivations >= promo.maxActivations) {
    return { success: false, reason: '❌ Превышен лимит использований промокода' };
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

  return {
    success: true,
    type: promo.type,
    code: promo.code,
    promoId: promo._id,
    value: promo.value,
    minOrderAmount: promo.minOrderAmount,
    productId: promo.productId ? promo.productId.toString() : null,
    isActive: true,
  };
};

/** Validates a promo and calculates its discount without mutating the ledger. */
const calculateDiscount = (promo, orderAmount, productId = null) => {
  if (!isPromoCurrentlyValid(promo)) return { valid: false, reason: '❌ Промокод не найден или истёк' };
  if (!['percent', 'fixed'].includes(promo.type)) return { valid: false, reason: '❌ Это не скидочный промокод' };

  if (promo.minOrderAmount && orderAmount < promo.minOrderAmount) {
    return { valid: false, reason: `❌ Промокод действует только от ${promo.minOrderAmount} USDT` };
  }

  if (promo.productId && String(promo.productId) !== String(productId)) {
    return { valid: false, reason: '❌ Промокод не распространяется на данный товар' };
  }

  let discountAmount = 0;
  if (promo.type === 'percent') {
    discountAmount = Math.min(orderAmount, (orderAmount * promo.value) / 100);
  } else if (promo.type === 'fixed') {
    discountAmount = Math.min(orderAmount, promo.value);
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

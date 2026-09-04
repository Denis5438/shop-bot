const User = require('../models/User');
const Product = require('../models/Product');
const Key = require('../models/Key');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const PromoCode = require('../models/PromoCode');
const promoService = require('./promo.service');
const supplierManager = require('./supplierManager.service');
const { withTransaction } = require('./transactionHelper.service');
const { getEffectivePrice } = require('./orderPricing.service');
const { buildKeyQueryForProduct, resolveProductProvider } = require('./provider.service');
const logger = require('../config/logger');

const SUPPLIER_PROVIDERS = new Set(['jaha', 'akunding', 'canboso', 'trumpstore']);
const roundMoney = (value) => Number(Number(value || 0).toFixed(8));
const sessionOptions = (session) => (session ? { session } : {});

const getAvailableStock = async (product) => {
  const autoKeys = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
  if (autoKeys > 0) return autoKeys;

  if (SUPPLIER_PROVIDERS.has(product.provider) || product.type === 'manual') {
    return product.manualStock === -1 ? 9999 : Math.max(0, Number(product.manualStock) || 0);
  }
  return autoKeys;
};

/**
 * Returns the same effective prices used by the single-product checkout.
 * Discount allocation is deterministic so order prices and the purchase
 * ledger add up exactly to the displayed total.
 */
const getCart = async (user) => {
  const dbUser = await User.findById(user._id).populate({
    path: 'cart.productId',
    populate: { path: 'categoryId' },
  });

  if (!dbUser || !Array.isArray(dbUser.cart) || dbUser.cart.length === 0) {
    return {
      items: [],
      totalCount: 0,
      subtotal: 0,
      discountAmount: 0,
      finalTotal: 0,
      hasStockIssue: false,
      cartVersion: dbUser?.cartVersion || 0,
      activePromo: null,
    };
  }

  const validCart = [];
  let subtotal = 0;
  let totalCount = 0;
  let hasStockIssue = false;

  for (const item of dbUser.cart) {
    const product = item.productId;
    if (!product || !product.isActive) continue;

    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    const availableStock = await getAvailableStock(product);
    const isAvailable = availableStock >= qty;
    if (!isAvailable) hasStockIssue = true;

    const unitPrice = await getEffectivePrice(product, availableStock, null);
    const baseTotal = roundMoney(unitPrice * qty);
    subtotal = roundMoney(subtotal + baseTotal);
    totalCount += qty;

    validCart.push({
      product,
      productId: product._id,
      qty,
      availableStock,
      isAvailable,
      unitPrice,
      baseTotal,
      itemTotal: baseTotal,
    });
  }

  let activePromo = null;
  let discountAmount = 0;
  if (dbUser.activePromoCode) {
    activePromo = await PromoCode.findById(dbUser.activePromoCode).lean();
    if (
      !activePromo ||
      !activePromo.isActive ||
      (activePromo.expiresAt && new Date() > new Date(activePromo.expiresAt)) ||
      (activePromo.maxActivations !== -1 && activePromo.currentActivations >= activePromo.maxActivations)
    ) {
      activePromo = null;
    } else {
      const PromoUsage = require('../models/PromoUsage');
      const usageCount = await PromoUsage.countDocuments({ promoId: activePromo._id, userId: dbUser._id });
      if (activePromo.maxPerUser !== -1 && usageCount >= activePromo.maxPerUser) {
        activePromo = null;
      }
    }
    if (!activePromo) {
      await User.updateOne({ _id: dbUser._id }, { $set: { activePromoCode: null } }).catch(() => {});
    }
  }

  if (activePromo && validCart.length > 0) {
    const eligibleItems = activePromo.productId
      ? validCart.filter((item) => String(item.productId) === String(activePromo.productId))
      : validCart;
    const eligibleSubtotal = roundMoney(eligibleItems.reduce((sum, item) => sum + item.baseTotal, 0));
    const discountRes = promoService.calculateDiscount(
      activePromo,
      activePromo.productId ? eligibleSubtotal : subtotal,
      activePromo.productId || null
    );

    if (discountRes.valid && discountRes.discountAmount > 0 && eligibleSubtotal > 0) {
      discountAmount = Math.min(subtotal, roundMoney(discountRes.discountAmount));
      let allocated = 0;
      eligibleItems.forEach((item, index) => {
        const isLast = index === eligibleItems.length - 1;
        const part = isLast
          ? roundMoney(discountAmount - allocated)
          : roundMoney(discountAmount * item.baseTotal / eligibleSubtotal);
        allocated = roundMoney(allocated + part);
        item.itemTotal = roundMoney(Math.max(0, item.baseTotal - part));
        item.unitPrice = Number((item.itemTotal / item.qty).toFixed(2));
      });
    } else {
      activePromo = null;
    }
  }

  const finalTotal = roundMoney(validCart.reduce((sum, item) => sum + item.itemTotal, 0));
  discountAmount = roundMoney(subtotal - finalTotal);

  return {
    items: validCart,
    totalCount,
    subtotal,
    discountAmount,
    finalTotal,
    activePromo,
    hasStockIssue,
    cartVersion: dbUser.cartVersion || 0,
  };
};

const addToCart = async (userId, productId, qty = 1) => {
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'Пользователь не найден' };

  user.cart = user.cart || [];
  const existingIdx = user.cart.findIndex((item) => String(item.productId) === String(productId));
  if (existingIdx > -1) user.cart[existingIdx].qty += qty;
  else user.cart.push({ productId, qty, addedAt: new Date() });

  user.cartVersion = (user.cartVersion || 0) + 1;
  await user.save();
  const totalCount = user.cart.reduce((acc, it) => acc + (it.qty || 1), 0);
  return { success: true, totalCount };
};

const updateItemQty = async (userId, productId, delta) => {
  const user = await User.findById(userId);
  if (!user) return { success: false };

  user.cart = user.cart || [];
  const idx = user.cart.findIndex((item) => String(item.productId) === String(productId));
  if (idx > -1) {
    user.cart[idx].qty += delta;
    if (user.cart[idx].qty <= 0) user.cart.splice(idx, 1);
    user.cartVersion = (user.cartVersion || 0) + 1;
    await user.save();
  }
  return { success: true };
};

const removeFromCart = async (userId, productId) => {
  await User.updateOne(
    { _id: userId },
    { $pull: { cart: { productId } }, $inc: { cartVersion: 1 } }
  );
  return { success: true };
};

const clearCart = async (userId) => {
  await User.updateOne(
    { _id: userId },
    { $set: { cart: [] }, $inc: { cartVersion: 1 } }
  );
  return { success: true };
};

const createPurchaseTransactions = async (orders, userId, session) => {
  const opts = sessionOptions(session);
  for (const order of orders) {
    await new Transaction({
      userId,
      type: 'purchase',
      amount: -roundMoney(order.price),
      orderId: order._id,
      description: `Оплата корзины: ${order.productId}`,
    }).save(opts);
  }
};

/**
 * Multi-item checkout. All local inventory, balance, cart ownership, orders,
 * purchase ledger entries and promo consumption are committed together. API
 * supplier calls happen only after the transaction and reuse the order's
 * persistent idempotency key when retried.
 */
const checkoutCart = async (ctx) => {
  const initialUser = await User.findById(ctx.user._id);
  if (!initialUser) return { success: false, error: 'Пользователь не найден' };

  const cartData = await getCart(initialUser);
  if (cartData.items.length === 0) return { success: false, error: 'Корзина пуста' };
  if (cartData.hasStockIssue) {
    return {
      success: false,
      error: 'Некоторых товаров нет в наличии в нужном количестве. Пожалуйста, скорректируйте корзину.',
    };
  }

  const totalCost = cartData.finalTotal;
  if (initialUser.balance < totalCost) {
    const diff = roundMoney(totalCost - initialUser.balance);
    return {
      success: false,
      isInsufficientBalance: true,
      diff,
      totalCost,
      balance: initialUser.balance,
      error: `Недостаточно средств. Не хватает ${diff} USDT`,
    };
  }

  const cartVersion = cartData.cartVersion;
  const expectedPromoId = initialUser.activePromoCode || null;
  const orders = [];
  const supplierItems = [];
  const deliveryReports = [];
  let updatedUser = null;

  try {
    await withTransaction(async (session) => {
      const opts = sessionOptions(session);
      orders.length = 0;
      supplierItems.length = 0;
      deliveryReports.length = 0;

      const userFilter = {
        _id: initialUser._id,
        cartVersion,
        balance: { $gte: totalCost },
        activePromoCode: expectedPromoId,
      };
      updatedUser = await User.findOneAndUpdate(
        userFilter,
        {
          $inc: { balance: -totalCost, totalSpent: totalCost, cartVersion: 1 },
          $set: { cart: [], activePromoCode: null },
        },
        { new: true, ...opts }
      );

      if (!updatedUser) {
        const current = await User.findById(initialUser._id).select('balance cartVersion activePromoCode').session(session || null);
        if (current && current.cartVersion !== cartVersion) throw new Error('CART_CHANGED');
        throw new Error('INSUFFICIENT_BALANCE');
      }

      for (const item of cartData.items) {
        const product = await Product.findOne({ _id: item.productId, isActive: true }).session(session || null);
        if (!product) throw new Error('PRODUCT_CHANGED');

        const autoKeysAvailable = await Key.countDocuments(
          buildKeyQueryForProduct(product, { isUsed: false }),
          opts
        );
        const isAutoKeyProduct = autoKeysAvailable >= item.qty;
        const provider = resolveProductProvider(product);

        if (isAutoKeyProduct) {
          const allocatedKeys = [];
          for (let i = 0; i < item.qty; i += 1) {
            const key = await Key.findOneAndUpdate(
              buildKeyQueryForProduct(product, { isUsed: false }),
              { $set: { isUsed: true, usedAt: new Date() } },
              { new: true, ...opts }
            );
            if (!key) throw new Error('OUT_OF_STOCK');
            allocatedKeys.push(key);
          }

          let remainingPrice = item.itemTotal;
          for (let i = 0; i < allocatedKeys.length; i += 1) {
            const key = allocatedKeys[i];
            const isLast = i === allocatedKeys.length - 1;
            const orderPrice = isLast
              ? roundMoney(remainingPrice)
              : roundMoney(item.itemTotal / item.qty);
            remainingPrice = roundMoney(remainingPrice - orderPrice);

            const order = new Order({
              userId: initialUser._id,
              productId: product._id,
              provider,
              status: product.type === 'gpt_activation' ? 'awaiting_token' : 'completed',
              price: orderPrice,
              costPrice: product.costPrice || 0,
              keyId: key._id,
              deliveryData: product.type === 'gpt_activation' ? null : key.value,
              confirmedAt: product.type === 'gpt_activation' ? null : new Date(),
              activationResult: product.type === 'gpt_activation' ? null : 'Ключ выдан автоматически',
              qty: 1,
              warrantyDays: product.warrantyDays ?? 5,
              subscriptionDays: product.subscriptionDays ?? 30,
            });
            await order.save(opts);
            await Key.updateOne(
              { _id: key._id, isUsed: true, usedByOrder: null },
              { $set: { usedByOrder: order._id } },
              opts
            );
            orders.push(order);

            deliveryReports.push({
              name: product.name,
              qty: 1,
              isInstant: product.type !== 'gpt_activation',
              data: product.type === 'gpt_activation' ? 'Ожидается токен для активации.' : key.value,
            });
          }
        } else {
          if (!SUPPLIER_PROVIDERS.has(provider) && product.type !== 'manual') throw new Error('OUT_OF_STOCK');

          if (product.manualStock !== -1) {
            const stockResult = await Product.updateOne(
              { _id: product._id, manualStock: { $gte: item.qty } },
              { $inc: { manualStock: -item.qty } },
              opts
            );
            if (!stockResult.modifiedCount) throw new Error('OUT_OF_STOCK');
          }

          const order = new Order({
            userId: initialUser._id,
            productId: product._id,
            provider,
            status: 'pending',
            price: item.itemTotal,
            costPrice: roundMoney((product.costPrice || 0) * item.qty),
            qty: item.qty,
            warrantyDays: product.warrantyDays ?? 5,
            subscriptionDays: product.subscriptionDays ?? 30,
          });
          if (SUPPLIER_PROVIDERS.has(provider)) order.supplierIdempotencyKey = `ord-${order._id}`;
          await order.save(opts);
          orders.push(order);

          const supplierItem = SUPPLIER_PROVIDERS.has(provider)
            ? { order, product, qty: item.qty }
            : null;
          if (supplierItem) supplierItems.push(supplierItem);

          deliveryReports.push({
            name: product.name,
            qty: item.qty,
            isInstant: false,
            data: supplierItem
              ? 'Заказ создан. Ожидается подтверждение поставщика.'
              : 'Ручная выдача. Оператор скоро отправит данные.',
          });
        }

        await Product.updateOne({ _id: product._id }, { $set: { lastSoldAt: new Date() } }, opts);
      }

      if (cartData.activePromo && cartData.discountAmount > 0) {
        await promoService.consumeDiscountPromo({
          promoId: cartData.activePromo._id,
          userId: initialUser._id,
          orderId: orders[0]?._id || null,
          discountAmount: cartData.discountAmount,
          session,
        });
      }

      await createPurchaseTransactions(orders, initialUser._id, session);
    });
  } catch (err) {
    if (err.code === 'TRANSACTIONS_REQUIRED' || err.message === 'TRANSACTIONS_REQUIRED') {
      return { success: false, error: 'Оплата временно недоступна: MongoDB не поддерживает финансовые транзакции.' };
    }
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return { success: false, isInsufficientBalance: true, error: 'Недостаточно средств или баланс уже изменился.' };
    }
    if (err.message === 'CART_CHANGED') {
      return { success: false, error: 'Корзина изменилась. Обновите корзину и попробуйте снова.' };
    }
    if (err.message === 'OUT_OF_STOCK' || err.message === 'PRODUCT_CHANGED') {
      return { success: false, error: 'Товар только что закончился или был изменен. Обновите корзину.' };
    }
    if (String(err.message || '').startsWith('PROMO_')) {
      return { success: false, error: 'Промокод больше нельзя применить. Заказ не списан, попробуйте обновить корзину.' };
    }

    logger.error(`[Cart checkout] rollback: ${err.message}`, { stack: err.stack });
    return { success: false, error: 'Не удалось оформить корзину. Средства не списаны.' };
  }

  ctx.user = updatedUser || await User.findById(initialUser._id);
  if (ctx.session) ctx.session.activePromo = null;
  if (ctx.user) ctx.user.activePromoCode = null;

  for (const { order, product, qty } of supplierItems) {
    try {
      const suppRes = await supplierManager.fulfillSupplierOrder(product, qty, ctx.user, {
        orderId: order._id,
        idempotencyKey: order.supplierIdempotencyKey,
      });
      if (suppRes.success && suppRes.deliveryData) {
        await Order.updateOne(
          { _id: order._id, status: 'pending', supplierIdempotencyKey: order.supplierIdempotencyKey },
          {
            $set: {
              status: 'completed',
              confirmedAt: new Date(),
              deliveryData: String(suppRes.deliveryData),
              supplierOrderId: String(suppRes.orderNumber || suppRes.orderId || ''),
              activationResult: 'Автовыдача через API поставщика',
            },
          }
        );
        const report = deliveryReports.find((item) => item.name === product.name && item.qty === qty && !item.isInstant);
        if (report) {
          report.isInstant = true;
          report.data = String(suppRes.deliveryData);
        }
      } else {
        await Order.updateOne(
          { _id: order._id, status: 'pending' },
          { $set: { notes: `Ошибка API поставщика: ${suppRes.error || 'неизвестно'}` } }
        );
      }
    } catch (err) {
      logger.error(`[Cart supplier ${order._id}] ${err.message}`);
      await Order.updateOne(
        { _id: order._id, status: 'pending' },
        { $set: { notes: `Ошибка API поставщика: ${err.message}` } }
      ).catch(() => {});
    }
  }

  return {
    success: true,
    totalCost,
    itemsCount: cartData.items.length,
    totalQty: cartData.totalCount,
    deliveryReports,
  };
};

module.exports = {
  getCart,
  addToCart,
  updateItemQty,
  removeFromCart,
  clearCart,
  checkoutCart,
};

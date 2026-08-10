const User = require('../models/User');
const Product = require('../models/Product');
const Key = require('../models/Key');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const PromoCode = require('../models/PromoCode');
const promoService = require('./promo.service');
const supplierManager = require('./supplierManager.service');
const { buildKeyQueryForProduct, resolveProductProvider } = require('./provider.service');
const { toRub } = require('./currency.service');

/**
 * Получение актуального состояния корзины пользователя
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
    };
  }

  // Фильтруем удалённые или деактивированные товары
  const validCart = [];
  let subtotal = 0;
  let totalCount = 0;
  let hasStockIssue = false;

  for (const item of dbUser.cart) {
    const product = item.productId;
    if (!product || !product.isActive) continue;

    const qty = Math.max(1, parseInt(item.qty, 10) || 1);

    // Проверяем доступный остаток
    const autoKeys = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    let availableStock = autoKeys;
    if (autoKeys === 0) {
      if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider)) {
        availableStock = product.manualStock === -1 ? 9999 : (product.manualStock || 0);
      } else if (product.type === 'manual') {
        availableStock = product.manualStock === -1 ? 9999 : (product.manualStock || 0);
      }
    }

    const isAvailable = availableStock >= qty;
    if (!isAvailable) hasStockIssue = true;

    const itemTotal = parseFloat((product.price * qty).toFixed(2));
    subtotal += itemTotal;
    totalCount += qty;

    validCart.push({
      product,
      productId: product._id,
      qty,
      itemTotal,
      availableStock,
      isAvailable,
    });
  }

  subtotal = parseFloat(subtotal.toFixed(2));

  // Проверяем активный промокод
  let discountAmount = 0;
  let activePromo = null;

  if (dbUser.activePromoCode) {
    const promo = await PromoCode.findById(dbUser.activePromoCode).lean();
    if (promo && promo.isActive) {
      const discountRes = promoService.calculateDiscount(promo, subtotal);
      if (discountRes.valid) {
        discountAmount = discountRes.discountAmount;
        activePromo = promo;
      }
    }
  }

  const finalTotal = Math.max(0, parseFloat((subtotal - discountAmount).toFixed(2)));

  return {
    items: validCart,
    totalCount,
    subtotal,
    discountAmount,
    finalTotal,
    activePromo,
    hasStockIssue,
  };
};

/**
 * Добавление товара в корзину
 */
const addToCart = async (userId, productId, qty = 1) => {
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'Пользователь не найден' };

  user.cart = user.cart || [];
  const existingIdx = user.cart.findIndex((item) => String(item.productId) === String(productId));

  if (existingIdx > -1) {
    user.cart[existingIdx].qty += qty;
  } else {
    user.cart.push({ productId, qty, addedAt: new Date() });
  }

  await user.save();
  const totalCount = user.cart.reduce((acc, it) => acc + (it.qty || 1), 0);
  return { success: true, totalCount };
};

/**
 * Изменение количества товара в корзине (+1 или -1)
 */
const updateItemQty = async (userId, productId, delta) => {
  const user = await User.findById(userId);
  if (!user) return { success: false };

  user.cart = user.cart || [];
  const idx = user.cart.findIndex((item) => String(item.productId) === String(productId));

  if (idx > -1) {
    user.cart[idx].qty += delta;
    if (user.cart[idx].qty <= 0) {
      user.cart.splice(idx, 1);
    }
    await user.save();
  }

  return { success: true };
};

/**
 * Удаление позиции из корзины
 */
const removeFromCart = async (userId, productId) => {
  await User.updateOne(
    { _id: userId },
    { $pull: { cart: { productId } } }
  );
  return { success: true };
};

/**
 * Очистка корзины
 */
const clearCart = async (userId) => {
  await User.updateOne({ _id: userId }, { $set: { cart: [] } });
  return { success: true };
};

/**
 * Оформление и оплата всех товаров в корзине единым чеком
 */
const checkoutCart = async (ctx) => {
  const user = await User.findById(ctx.user._id);
  if (!user) return { success: false, error: 'Пользователь не найден' };

  const cartData = await getCart(user);
  if (cartData.items.length === 0) {
    return { success: false, error: 'Корзина пуста' };
  }

  if (cartData.hasStockIssue) {
    return {
      success: false,
      error: 'Некоторых товаров нет в наличии в нужном количестве. Пожалуйста, скорректируйте корзину.',
    };
  }

  const totalCost = cartData.finalTotal;

  if (user.balance < totalCost) {
    const diff = parseFloat((totalCost - user.balance).toFixed(2));
    return {
      success: false,
      isInsufficientBalance: true,
      diff,
      totalCost,
      balance: user.balance,
      error: `Недостаточно средств. Не хватает ${diff} USDT`,
    };
  }

  // 1. Списываем баланс пользователя
  user.balance = parseFloat((user.balance - totalCost).toFixed(8));
  user.totalSpent = parseFloat(((user.totalSpent || 0) + totalCost).toFixed(8));
  user.cart = [];
  user.activePromoCode = null;
  await user.save();

  // 2. Создаем транзакцию списания
  await Transaction.create({
    userId: user._id,
    type: 'purchase',
    amount: -totalCost,
    description: `Оплата корзины (${cartData.items.length} поз., ${cartData.totalCount} шт.)`,
  }).catch(() => {});

  const deliveryReports = [];
  const supplierProviders = ['jaha', 'akunding', 'canboso', 'trumpstore'];

  // 3. Выполняем выдачу/заказы по каждой позиции корзины
  for (const item of cartData.items) {
    const product = item.product;
    const qty = item.qty;
    const itemCost = item.itemTotal;
    const provider = resolveProductProvider(product);

    // А) Авто-выдача ключей из локальной базы
    const autoKeys = await Key.find(buildKeyQueryForProduct(product, { isUsed: false })).limit(qty);

    if (autoKeys.length >= qty) {
      const keyIds = autoKeys.map((k) => k._id);
      const keyValues = autoKeys.map((k) => k.value);

      await Key.updateMany(
        { _id: { $in: keyIds } },
        { $set: { isUsed: true, usedAt: new Date(), orderId: null } }
      );

      const order = await Order.create({
        userId: user._id,
        productId: product._id,
        provider: 'local',
        status: 'completed',
        price: itemCost,
        costPrice: product.costPrice || 0,
        keys: keyIds,
        deliveryData: keyValues.join('\n'),
        confirmedAt: new Date(),
        qty,
      });

      await Key.updateMany({ _id: { $in: keyIds } }, { $set: { orderId: order._id } });

      deliveryReports.push({
        name: product.name,
        qty,
        isInstant: true,
        data: keyValues.join('\n'),
      });
      continue;
    }

    // Б) Внешний поставщик через API (On-Demand)
    if (supplierProviders.includes(product.provider)) {
      const suppRes = await supplierManager.fulfillSupplierOrder(product, qty, user);

      if (suppRes.success && suppRes.deliveryData) {
        await Order.create({
          userId: user._id,
          productId: product._id,
          provider: product.provider,
          status: 'completed',
          price: itemCost,
          costPrice: (product.costPrice || 0) * qty,
          deliveryData: String(suppRes.deliveryData),
          supplierOrderId: String(suppRes.orderNumber || ''),
          confirmedAt: new Date(),
          qty,
        });

        deliveryReports.push({
          name: product.name,
          qty,
          isInstant: true,
          data: String(suppRes.deliveryData),
        });
      } else {
        // Ошибка поставщика — отправляем оператору
        const errNote = `Ошибка автовыкупа корзины: ${suppRes.error || 'неизвестно'}`;
        await Order.create({
          userId: user._id,
          productId: product._id,
          provider: product.provider,
          status: 'pending',
          price: itemCost,
          costPrice: (product.costPrice || 0) * qty,
          notes: errNote,
          qty,
        });

        deliveryReports.push({
          name: product.name,
          qty,
          isInstant: false,
          data: '⏳ Заказ передан оператору для ручной выдачи.',
        });
      }
      continue;
    }

    // В) Ручной товар (выдача оператором)
    if (product.manualStock !== -1) {
      await Product.updateOne({ _id: product._id }, { $inc: { manualStock: -qty } });
    }

    await Order.create({
      userId: user._id,
      productId: product._id,
      provider: 'local',
      status: 'pending',
      price: itemCost,
      qty,
    });

    deliveryReports.push({
      name: product.name,
      qty,
      isInstant: false,
      data: '⏳ Ручная выдача. Оператор скоро отправит данные.',
    });
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

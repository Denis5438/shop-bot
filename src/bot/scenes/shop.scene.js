const { Markup } = require('telegraf');
const Product = require('../../models/Product');
const Key = require('../../models/Key');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const { ITEMS_PER_PAGE } = require('../../config');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const {
  buildKeyQueryForProduct,
  resolveProductProvider,
} = require('../../services/provider.service');
const notif = require('../../services/notification.service');
const Seller = require('../../models/Seller');
const { mainKeyboard } = require('../keyboards/main.keyboard');
const { balanceHeader, errorScreen, escapeHtml } = require('../utils/ui');

const getEffectivePrice = async (product, stockCount) => {
  const settings = await getSettings();
  let price = product.price;

  if (settings?.smartPricing && product.type !== 'manual') {
    const rawStock = parseFloat(stockCount);
    if (!Number.isNaN(rawStock) && rawStock > 0 && rawStock < 10) {
      price = parseFloat((price * 1.2).toFixed(2));
    }
  }

  if (settings?.autoMarkdownEnabled && settings?.autoMarkdownPercent > 0 && settings?.autoMarkdownDays > 0) {
    const lastSaleBase = product.lastSoldAt || product.createdAt;
    const lastSaleAt = lastSaleBase instanceof Date ? lastSaleBase.getTime() : Date.now();
    const daysSinceLastSale = (Date.now() - lastSaleAt) / (1000 * 60 * 60 * 24);
    const periods = Math.floor(daysSinceLastSale / settings.autoMarkdownDays);

    if (periods > 0) {
      const discountMult = Math.pow(1 - (settings.autoMarkdownPercent / 100), periods);
      const discountedPrice = price * discountMult;
      const costLimit = product.costPrice || 0;
      price = parseFloat(Math.max(discountedPrice, costLimit).toFixed(2));
    }
  }

  return price;
};

const stockIndicator = (stock, t) => {
  if (stock === '∞') return t ? t('shop_stock_infinite') : '♾️ Unlimited';
  if (stock > 10) return t ? t('shop_stock_high', { count: stock }) : `🟢 ${stock} pcs`;
  if (stock > 3) return t ? t('shop_stock_medium', { count: stock }) : `🟡 ${stock} pcs — low`;
  if (stock > 0) return t ? t('shop_stock_low', { count: stock }) : `🔴 ${stock} pcs — last`;
  return t ? t('shop_out_of_stock') : '⛔ Out of stock';
};

const getStock = async (product) => {
  if (product.type === 'manual') return '∞';
  return Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
};

const buildShopKeyboard = async (products, page, totalPages, lang = 'ru', t = null) => {
  const buttons = [];

  for (const product of products) {
    const stock = await getStock(product);
    const effectivePrice = await getEffectivePrice(product, stock);
    const stockBadge = stock === '∞'
      ? '♾️'
      : stock === 0
        ? '⛔'
        : stock < 10 && effectivePrice > product.price
          ? `(${stock}) 🔥`
          : stock <= 3
            ? `(${stock}) 🔴`
            : `(${stock}) 🟢`;
    const displayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
    const label = `${product.icon} ${displayName} — ${effectivePrice} USDT ${stockBadge}`;
    buttons.push([Markup.button.callback(label, `shop:product:${product._id}:${page}`)]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push(Markup.button.callback('⬅️', `shop:page:${page - 1}`));
  navButtons.push(Markup.button.callback(`${page}/${totalPages}`, 'shop:noop'));
  if (page < totalPages) navButtons.push(Markup.button.callback('➡️', `shop:page:${page + 1}`));
  if (navButtons.length) buttons.push(navButtons);

  const refreshLabel = t ? t('btn_refresh') : '🔄 Refresh';
  const backLabel = t ? t('btn_back') : '⬅️ Back';
  buttons.push([
    Markup.button.callback(refreshLabel, `shop:page:${page}`),
    Markup.button.callback(backLabel, 'menu:main'),
  ]);

  return Markup.inlineKeyboard(buttons);
};

const showShopPage = async (ctx, page = 1) => {
  const t = ctx.t;
  const products = await Product.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 });

  if (products.length === 0) {
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(t('shop_empty'), mainKeyboard(t, ctx.isSeller));
      } catch (_) {
        await ctx.reply(t('shop_empty'), mainKeyboard(t, ctx.isSeller));
      }
      await ctx.answerCbQuery().catch(() => {});
    } else {
      await ctx.reply(t('shop_empty'), mainKeyboard(t, ctx.isSeller));
    }
    return;
  }

  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const paginated = products.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);
  const lang = ctx.user?.language || 'ru';
  const keyboard = await buildShopKeyboard(paginated, safePage, totalPages, lang, t);
  const text = t('shop_title');

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      await ctx.answerCbQuery('✅');
    } catch (err) {
      if (err.description?.includes('message is not modified')) {
        await ctx.answerCbQuery('✅').catch(() => {});
      } else {
        await ctx.answerCbQuery().catch(() => {});
      }
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
};

const showProduct = async (ctx, productId, fromPage = 1) => {
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery(ctx.t ? ctx.t('err_not_found') : '❌ Not found', { show_alert: true });
  }

  const t = ctx.t || ((k) => k);
  const stock = await getStock(product);
  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const description = lang === 'en' && product.descriptionEn ? product.descriptionEn : product.description;
  const effectivePrice = await getEffectivePrice(product, stock);
  const outOfStock = stock !== '∞' && stock === 0;

  let alertLine = '';
  if (effectivePrice > product.price) {
    alertLine = '\n' + t('shop_alert_high_demand');
  } else if (effectivePrice < product.price) {
    alertLine = '\n' + t('shop_alert_markdown');
  }

  const priceLabel = lang === 'en' ? '💰 Price' : '💰 Цена';
  const stockLabel = lang === 'en' ? '📦 Stock' : '📦 Наличие';

  const text =
    balanceHeader(ctx.user) +
    `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(name)}</b>\n\n` +
    `<blockquote>${priceLabel}: <b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)${alertLine}\n` +
    `${stockLabel}: ${stockIndicator(stock, t)}</blockquote>\n\n` +
    `${description ? `<blockquote expandable>📝 ${escapeHtml(description)}</blockquote>\n` : ''}`;

  const buttons = [];
  if (!outOfStock) {
    if (product.type === 'key') {
      buttons.push([Markup.button.callback(t('btn_buy'), `shop:qty:${productId}:${fromPage}:1`)]);
    } else {
      buttons.push([Markup.button.callback(t('btn_buy'), `shop:buy:${productId}:${fromPage}:1`)]);
    }
  } else {
    buttons.push([Markup.button.callback(t('shop_out_of_stock'), 'shop:noop')]);
  }
  if (product.type === 'gpt_activation') {
    buttons.push([Markup.button.callback(t('shop_check_token'), `shop:check_token:${productId}`)]);
  }
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  buttons.push([Markup.button.callback(t('shop_back_to_list'), `shop:page:${safePage}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
};

const showQuantitySelect = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  const product = await Product.findById(productId);
  const t = ctx.t || ((k) => k);

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && qty > stock) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const effectivePrice = await getEffectivePrice(product, stock);
  const total = parseFloat((effectivePrice * qty).toFixed(2));

  const text = t('shop_qty_title') + '\n\n' + t('shop_qty_total', { qty, total });

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const buttons = [
    [
      Markup.button.callback('➖', `shop:qty_dec:${productId}:${safePage}:${qty}`),
      Markup.button.callback(`${qty} шт`, 'shop:noop'),
      Markup.button.callback('➕', `shop:qty_inc:${productId}:${safePage}:${qty}`),
    ],
    [
      Markup.button.callback('5 шт', `shop:qty_set:${productId}:${safePage}:5`),
      Markup.button.callback('10 шт', `shop:qty_set:${productId}:${safePage}:10`),
      Markup.button.callback('20 шт', `shop:qty_set:${productId}:${safePage}:20`),
    ],
    [Markup.button.callback(t('shop_qty_confirm_btn'), `shop:buy:${productId}:${safePage}:${qty}`)],
    [Markup.button.callback(t('btn_back'), `shop:product:${productId}:${safePage}`)]
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
};

const confirmPurchase = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  const user = ctx.user;
  const product = await Product.findById(productId);
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && stock < qty) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const productName = lang === 'en' && product.nameEn ? product.nameEn : product.name;

  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));
  
  if (user.balance < totalCost) {
    const diff = parseFloat((totalCost - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${diff} USDT` : `💰 Пополнить на ${diff} USDT`;
    const otherLabel = lang === 'en' ? '💳 Other amount' : '💳 Другая сумма';
    const backLabel = t('btn_back');
    const text = t('product_not_enough', {
      price: totalCost,
      balance: user.balance.toFixed(2),
      diff
    });
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(topupLabel, `topup:quick:${diff}`)],
        [Markup.button.callback(otherLabel, 'menu:topup')],
        [Markup.button.callback(backLabel, `shop:product:${productId}:${safePage}`)],
      ]),
    }).catch(() => {});
    return ctx.answerCbQuery().catch(() => {});
  }

  const newBalance = (user.balance - totalCost).toFixed(2);
  const confirmBtnLabel = lang === 'en'
    ? `✅ Yes, buy for ${totalCost} USDT`
    : `✅ Да, купить за ${totalCost} USDT`;
  const backToProductLabel = lang === 'en' ? '⬅️ Back to product' : '⬅️ Вернуться к товару';

  let text;
  if (qty > 1) {
    text = t('product_buy_confirm_qty', {
      name: escapeHtml(productName),
      qty,
      price: totalCost,
      priceRub: toRub(totalCost),
      balance: user.balance.toFixed(2),
      newBalance
    });
  } else {
    text = t('product_buy_confirm', {
      name: escapeHtml(productName),
      price: effectivePrice,
      priceRub: toRub(effectivePrice),
      balance: user.balance.toFixed(2),
      newBalance
    });
  }

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(confirmBtnLabel, `shop:confirm:${productId}:${safePage}:${qty}`)],
      [Markup.button.callback(backToProductLabel, `shop:product:${productId}:${safePage}`)],
    ]),
  };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
};

const processPurchase = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  void fromPage;
  const user = ctx.user;
  const product = await Product.findById(productId);

  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && qty > stock) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));

  if (user.balance < totalCost) {
    const deficit = parseFloat((totalCost - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${deficit} USDT` : `💰 Пополнить на ${deficit} USDT`;
    const text = t('product_not_enough', {
      price: totalCost,
      balance: user.balance.toFixed(2),
      diff: deficit
    });
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(topupLabel, `topup:quick:${deficit}`)],
      [Markup.button.callback(t('btn_back'), `shop:product:${product._id}`)],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
    return ctx.answerCbQuery().catch(() => {});
  }

  const provider = resolveProductProvider(product);
  const isAutoKeyProduct = product.type === 'key';

  const User = require('../../models/User');
  const { withTransaction } = require('../../services/transactionHelper.service');

  let orders = [];
  let allocatedKeys = [];

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      const freshUser = await User.findById(user._id, null, sessionOptions);
      if (!freshUser || freshUser.balance < totalCost) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      if (isAutoKeyProduct) {
        // Резервируем qty ключей
        allocatedKeys = await Key.find(buildKeyQueryForProduct(product, { isUsed: false }))
          .limit(qty)
          .session(sessionOptions || null);
          
        if (allocatedKeys.length < qty) {
          throw new Error('OUT_OF_STOCK');
        }

        const keyIds = allocatedKeys.map(k => k._id);
        await Key.updateMany(
          { _id: { $in: keyIds } },
          { $set: { isUsed: true, usedAt: new Date() } },
          sessionOptions
        );
      }

      freshUser.balance = parseFloat((freshUser.balance - totalCost).toFixed(8));
      freshUser.totalSpent = parseFloat((freshUser.totalSpent + totalCost).toFixed(8));
      await freshUser.save(sessionOptions);
      ctx.user = freshUser;

      for (let i = 0; i < qty; i++) {
        const allocatedKey = allocatedKeys[i] || null;
        const order = new Order({
          userId: user._id,
          productId: product._id,
          provider,
          price: effectivePrice,
          costPrice: product.costPrice || 0,
          status: product.type === 'gpt_activation' ? 'awaiting_token' : isAutoKeyProduct ? 'completed' : 'pending',
          keyId: allocatedKey ? allocatedKey._id : null,
          confirmedAt: isAutoKeyProduct ? new Date() : null,
          activationResult: isAutoKeyProduct ? 'Ключ выдан автоматически' : null,
        });
        await order.save(sessionOptions);
        orders.push(order);

        if (allocatedKey) {
          allocatedKey.usedByOrder = order._id;
          await allocatedKey.save(sessionOptions);
        }
      }

      product.lastSoldAt = Date.now();
      await product.save(sessionOptions);

      await new Transaction({
        userId: user._id,
        type: 'purchase',
        amount: -totalCost,
        orderId: orders[0]._id, // Привязываем транзакцию к первому заказу для простоты
        description: `Покупка: ${product.name} (x${qty})`,
      }).save(sessionOptions);
    });
  } catch (err) {
    if (allocatedKeys.length > 0) {
      try {
        const keyIds = allocatedKeys.map(k => k._id);
        await Key.updateMany(
          { _id: { $in: keyIds }, usedByOrder: null },
          { $set: { isUsed: false, usedAt: null } }
        );
      } catch (_) {}
    }

    if (err.message === 'INSUFFICIENT_BALANCE') {
      return ctx.answerCbQuery(t('err_insufficient_balance'), { show_alert: true });
    }
    if (err.message === 'OUT_OF_STOCK') {
      return ctx.answerCbQuery(t('err_out_of_stock'), { show_alert: true });
    }

    await ctx.answerCbQuery('❌').catch(() => {});
    await errorScreen(ctx, {
      title: lang === 'en' ? '💥 Order failed' : '💥 Не удалось оформить заказ',
      message: lang === 'en'
        ? 'An unexpected error occurred. Money was not charged.\n\nYou can try again or contact support.'
        : 'Произошла непредвиденная ошибка. Деньги не списаны.\n\nМожно попробовать снова или обратиться в поддержку.',
      retryAction: `shop:buy:${productId}`,
      backAction: 'menu:main',
    });
    throw err;
  }

  // Начисление продавцу (sellerPayout холдируется) и уведомления
  const productDisplayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  let sellerTotalPayout = 0;

  if (product.sellerId && product.sellerPrice > 0) {
    try {
      const seller = await Seller.findById(product.sellerId);
      if (seller && seller.isActive) {
        const payoutPerItem = parseFloat(product.sellerPrice.toFixed(8));
        sellerTotalPayout = parseFloat((payoutPerItem * qty).toFixed(8));
        
        const orderIds = orders.map(o => o._id);
        await Order.updateMany(
          { _id: { $in: orderIds } },
          { $set: { sellerId: seller._id, sellerPayout: payoutPerItem } }
        );
        
        // Отправляем одно сводное уведомление продавцу
        const summaryOrder = { ...orders[0].toObject(), sellerPayout: sellerTotalPayout, qty };
        await notif.notifySellerNewOrder(seller, summaryOrder, product, ctx.user);
      }
    } catch (sellerErr) {
      const logger = require('../../config/logger');
      logger.error(`[Seller payout] Ошибка начисления продавцу: ${sellerErr.message}`);
    }
  }

  if (product.type !== 'key') {
    // Если купили несколько manual, то шлем несколько уведомлений админу
    for (const order of orders) {
      await notif.notifyAdminNewOrder(order, ctx.user, product);
    }
  }

  if (product.type === 'gpt_activation') {
    const orderLbl = lang === 'en' ? 'Order' : 'Заказ';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📋 ${orderLbl}: <code>${orders[0]._id}</code>\n` +
      `💰 ${chargedLbl}: <b>${totalCost} USDT</b>\n\n` +
      `⏳ ${lang === 'en' ? 'Requesting your token...' : 'Сейчас запрошу ваш токен...'}`;
    const opts = { parse_mode: 'HTML' };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
    await ctx.scene.enter('token_collection', { orderId: orders[0]._id.toString() });
  } else if (isAutoKeyProduct) {
    await grantReferralBonusForFirstCompletedOrder(orders[0].userId);

    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const qtyLbl = lang === 'en' ? 'Quantity' : 'Количество';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const keyLbl = lang === 'en' ? '🔑 <b>Your keys:</b>' : '🔑 <b>Ваши ключи:</b>';
    
    let keysText = '';
    if (qty === 1) {
      keysText = `<pre>${escapeHtml(allocatedKeys[0].value)}</pre>`;
    } else {
      allocatedKeys.forEach((k, idx) => {
        keysText += `${idx + 1}. <code>${escapeHtml(k.value)}</code>\n`;
      });
    }

    const text =
      `✅ <b>${lang === 'en' ? 'Order completed automatically' : 'Заказ выполнен автоматически'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📊 ${qtyLbl}: <b>${qty}</b>\n` +
      `💰 ${chargedLbl}: <b>${totalCost} USDT</b>\n\n` +
      `${keyLbl}\n${keysText}`;

    const buyMoreLabel = lang === 'en' ? '🛒 Buy more' : '🛒 Купить ещё';
    const menuLabel = t('back_to_menu');
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(buyMoreLabel, `shop:product:${product._id}`)],
        [Markup.button.callback(menuLabel, 'menu:main')],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  } else {
    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `💰 ${chargedLbl}: ${totalCost} USDT\n\n` +
      `⏳ ${lang === 'en' ? 'An operator will process your order shortly.' : 'Оператор обработает заказ в ближайшее время.'}`;

    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(t('back_to_menu'), 'menu:main')]]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  }

  if (product.type !== 'manual') {
    const remaining = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    const LOW_STOCK_THRESHOLD = 5;
    const LOW_STOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 часов

    if (remaining <= LOW_STOCK_THRESHOLD) {
      const lastNotifiedAt = product.lowStockNotifiedAt
        ? new Date(product.lowStockNotifiedAt).getTime()
        : 0;
      const elapsedMs = Date.now() - lastNotifiedAt;

      if (elapsedMs >= LOW_STOCK_COOLDOWN_MS) {
        await notif.notifyAdminLowStock(product, remaining);
        await Product.updateOne(
          { _id: product._id },
          { $set: { lowStockNotifiedAt: new Date() } }
        );
      }
    } else if (product.lowStockNotifiedAt) {
      // Запасы восполнили — сбрасываем флаг, чтобы в следующий раз уведомить сразу.
      await Product.updateOne(
        { _id: product._id },
        { $set: { lowStockNotifiedAt: null } }
      );
    }
  }
};

module.exports = { showShopPage, showProduct, confirmPurchase, processPurchase, showQuantitySelect };

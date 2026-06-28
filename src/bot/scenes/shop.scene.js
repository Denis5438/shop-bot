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
        await ctx.editMessageText(t('shop_empty'), mainKeyboard(t));
      } catch (_) {
        await ctx.reply(t('shop_empty'), mainKeyboard(t));
      }
      await ctx.answerCbQuery().catch(() => {});
    } else {
      await ctx.reply(t('shop_empty'), mainKeyboard(t));
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
    buttons.push([Markup.button.callback(t('btn_buy'), `shop:buy:${productId}:${fromPage}`)]);
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

const confirmPurchase = async (ctx, productId, fromPage = 1) => {
  const user = ctx.user;
  const product = await Product.findById(productId);
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && stock === 0) {
    return ctx.answerCbQuery(t('err_out_of_stock'), { show_alert: true });
  }

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const productName = lang === 'en' && product.nameEn ? product.nameEn : product.name;

  const effectivePrice = await getEffectivePrice(product, stock);
  if (user.balance < effectivePrice) {
    const diff = parseFloat((effectivePrice - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${diff} USDT` : `💰 Пополнить на ${diff} USDT`;
    const otherLabel = lang === 'en' ? '💳 Other amount' : '💳 Другая сумма';
    const backLabel = t('btn_back');
    const text = t('product_not_enough', {
      price: effectivePrice,
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

  const newBalance = (user.balance - effectivePrice).toFixed(2);
  const confirmBtnLabel = lang === 'en'
    ? `✅ Yes, buy for ${effectivePrice} USDT`
    : `✅ Да, купить за ${effectivePrice} USDT`;
  const backToProductLabel = lang === 'en' ? '⬅️ Back to product' : '⬅️ Вернуться к товару';

  const text = t('product_buy_confirm', {
    name: escapeHtml(productName),
    price: effectivePrice,
    priceRub: toRub(effectivePrice),
    balance: user.balance.toFixed(2),
    newBalance
  });

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(confirmBtnLabel, `shop:confirm:${productId}:${safePage}`)],
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

const processPurchase = async (ctx, productId, fromPage = 1) => {
  // fromPage принимается для консистентности flow (навигация из карточки товара),
  // сейчас не используется в UI покупки, но полезно при расширении (например, редирект).
  void fromPage;
  const user = ctx.user;
  const product = await Product.findById(productId);

  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  const effectivePrice = await getEffectivePrice(product, stock);

  if (user.balance < effectivePrice) {
    const deficit = parseFloat((effectivePrice - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${deficit} USDT` : `💰 Пополнить на ${deficit} USDT`;
    const text = t('product_not_enough', {
      price: effectivePrice,
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

  let order = null;
  let allocatedKey = null;

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      const freshUser = await User.findById(user._id, null, sessionOptions);
      if (!freshUser || freshUser.balance < effectivePrice) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // Резервируем ключ внутри транзакции — так при любом сбое вся операция
      // (списание баланса, создание заказа, выделение ключа) откатится атомарно.
      if (product.type !== 'manual') {
        allocatedKey = await Key.findOneAndUpdate(
          buildKeyQueryForProduct(product, { isUsed: false }),
          {
            $set: {
              isUsed: true,
              usedAt: new Date(),
            },
          },
          { new: true, ...(sessionOptions || {}) }
        );

        if (!allocatedKey) {
          throw new Error('OUT_OF_STOCK');
        }
      }

      freshUser.balance = parseFloat((freshUser.balance - effectivePrice).toFixed(8));
      freshUser.totalSpent = parseFloat((freshUser.totalSpent + effectivePrice).toFixed(8));
      await freshUser.save(sessionOptions);
      ctx.user = freshUser;

      order = new Order({
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

      product.lastSoldAt = Date.now();
      await product.save(sessionOptions);

      if (allocatedKey) {
        allocatedKey.usedByOrder = order._id;
        await allocatedKey.save(sessionOptions);
      }

      await new Transaction({
        userId: user._id,
        type: 'purchase',
        amount: -effectivePrice,
        orderId: order._id,
        description: `Покупка: ${product.name}`,
      }).save(sessionOptions);
    });
  } catch (err) {
    // Fallback: если транзакции не поддерживаются (standalone MongoDB) — пытаемся
    // руками освободить ключ, который мог остаться в состоянии isUsed=true.
    // В реплика-сете транзакция уже откатила изменения.
    if (allocatedKey && allocatedKey._id) {
      try {
        await Key.updateOne(
          { _id: allocatedKey._id, usedByOrder: null },
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

  if (product.type !== 'key') {
    await notif.notifyAdminNewOrder(order, ctx.user, product);
  }

  // ─── Начисление продавцу ─────────────────────────────────────────────────
  if (product.sellerId && product.sellerPrice > 0) {
    try {
      const seller = await Seller.findById(product.sellerId);
      if (seller && seller.isActive) {
        const payout = parseFloat(product.sellerPrice.toFixed(8));

        // Обновляем заказ — фиксируем сумму выплаты, но НЕ начисляем на баланс (холдируем)
        await Order.updateOne(
          { _id: order._id },
          { $set: { sellerId: seller._id, sellerPayout: payout } }
        );

        // Уведомляем продавца (только если он зарегистрирован в боте)
        await notif.notifySellerNewOrder(seller, { ...order.toObject(), sellerPayout: payout }, product, ctx.user);
      }
    } catch (sellerErr) {
      // Не ломаем основной flow при ошибке начисления продавцу
      const logger = require('../../config/logger');
      logger.error(`[Seller payout] Ошибка начисления продавцу: ${sellerErr.message}`);
    }
  }

  const productDisplayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;

  if (product.type === 'gpt_activation') {
    const orderLbl = lang === 'en' ? 'Order' : 'Заказ';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📋 ${orderLbl}: <code>${order._id}</code>\n` +
      `💰 ${chargedLbl}: <b>${effectivePrice} USDT</b>\n\n` +
      `⏳ ${lang === 'en' ? 'Requesting your token...' : 'Сейчас запрошу ваш токен...'}`;
    const opts = { parse_mode: 'HTML' };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
    await ctx.scene.enter('token_collection', { orderId: order._id.toString() });
  } else if (isAutoKeyProduct) {
    await grantReferralBonusForFirstCompletedOrder(order.userId);

    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const orderLbl = lang === 'en' ? 'Order' : 'Заказ';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const keyLbl = lang === 'en' ? '🔑 <b>Your key:</b>' : '🔑 <b>Ваш ключ:</b>';
    const text =
      `✅ <b>${lang === 'en' ? 'Order completed automatically' : 'Заказ выполнен автоматически'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📋 ${orderLbl}: <code>${order._id}</code>\n` +
      `💰 ${chargedLbl}: <b>${effectivePrice} USDT</b>\n\n` +
      `${keyLbl}\n<pre>${escapeHtml(allocatedKey.value)}</pre>`;

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
    const orderLbl = lang === 'en' ? 'Order' : 'Заказ';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📋 ${orderLbl}: <code>${order._id}</code>\n` +
      `💰 ${chargedLbl}: ${effectivePrice} USDT\n\n` +
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

module.exports = { showShopPage, showProduct, confirmPurchase, processPurchase };

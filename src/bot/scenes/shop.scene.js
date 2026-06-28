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

const stockIndicator = (stock) => {
  if (stock === '∞') return '♾️ Неограниченно';
  if (stock > 10) return `🟢 ${stock} шт.`;
  if (stock > 3) return `🟡 ${stock} шт. — мало`;
  if (stock > 0) return `🔴 ${stock} шт. — последние`;
  return '⛔ Нет в наличии';
};

const getStock = async (product) => {
  if (product.type === 'manual') return '∞';
  return Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
};

const buildShopKeyboard = async (products, page, totalPages, lang = 'ru') => {
  const buttons = [];

  for (const product of products) {
    const stock = await getStock(product);
    const effectivePrice = await getEffectivePrice(product, stock);
    const stockBadge = stock === '∞'
      ? '♾️'
      : stock === 0
        ? '(0 шт.) ⛔'
        : stock < 10 && effectivePrice > product.price
          ? `(${stock} шт.) 🔥`
          : stock <= 3
            ? `(${stock} шт.) 🔴`
            : `(${stock} шт.) 🟢`;
    const displayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
    const label = `${product.icon} ${displayName} — ${effectivePrice} USDT ${stockBadge}`;
    // Передаём page в callback_data — чтобы из карточки товара вернуться
    // ровно на ту страницу, с которой юзер пришёл.
    buttons.push([Markup.button.callback(label, `shop:product:${product._id}:${page}`)]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push(Markup.button.callback('⬅️', `shop:page:${page - 1}`));
  navButtons.push(Markup.button.callback(`${page}/${totalPages}`, 'shop:noop'));
  if (page < totalPages) navButtons.push(Markup.button.callback('➡️', `shop:page:${page + 1}`));
  if (navButtons.length) buttons.push(navButtons);

  buttons.push([
    Markup.button.callback('🔄 Обновить', `shop:page:${page}`),
    Markup.button.callback('⬅️ Назад', 'menu:main'),
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
  const keyboard = await buildShopKeyboard(paginated, safePage, totalPages, lang);
  const text = `🛒 <b>Магазин</b>\n\n<blockquote>💡 Выберите товар, чтобы посмотреть подробности и купить.</blockquote>`;

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      await ctx.answerCbQuery('✅ Обновлено');
    } catch (err) {
      if (err.description?.includes('message is not modified')) {
        await ctx.answerCbQuery('✅ Уже актуально');
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
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
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

  const text =
    balanceHeader(ctx.user) +
    `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(name)}</b>\n\n` +
    `<blockquote>💰 Цена: <b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)${alertLine}\n` +
    `📦 Наличие: ${stockIndicator(stock)}</blockquote>\n\n` +
    `${description ? `<blockquote expandable>📝 ${escapeHtml(description)}</blockquote>\n` : ''}`;

  const buttons = [];
  if (!outOfStock) {
    // Передаём page в buy-callback чтобы после покупки/отмены вернуться на ту же страницу.
    buttons.push([Markup.button.callback(t('btn_buy'), `shop:buy:${productId}:${fromPage}`)]);
  } else {
    buttons.push([Markup.button.callback(t('shop_out_of_stock'), 'shop:noop')]);
  }
  // Для GPT-активаций добавляем бесплатную pre-check токена — снижает долю failed.
  if (product.type === 'gpt_activation') {
    buttons.push([Markup.button.callback(t('shop_check_token'), `shop:check_token:${productId}`)]);
  }
  // "Назад к списку" возвращает на страницу, откуда пришёл пользователь.
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

  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && stock === 0) {
    return ctx.answerCbQuery('❌ Товар закончился', { show_alert: true });
  }

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);

  const effectivePrice = await getEffectivePrice(product, stock);
  if (user.balance < effectivePrice) {
    const diff = parseFloat((effectivePrice - user.balance).toFixed(2));
    const text =
      `❌ <b>Недостаточно средств</b>\n\n` +
      `💰 Цена: ${effectivePrice} USDT\n` +
      `💳 Баланс: ${user.balance.toFixed(2)} USDT\n` +
      `➖ Не хватает: ${diff} USDT (~${toRub(diff)} ₽)`;

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`💰 Пополнить на ${diff} USDT`, `topup:quick:${diff}`)],
        [Markup.button.callback('💳 Другая сумма', 'menu:topup')],
        [Markup.button.callback('⬅️ Назад', `shop:product:${productId}:${safePage}`)],
      ]),
    }).catch(() => {});
    return ctx.answerCbQuery().catch(() => {});
  }

  const newBalance = (user.balance - effectivePrice).toFixed(2);
  const text =
    `🛒 <b>Подтверждение покупки</b>\n\n` +
    `<blockquote>📦 Товар: ${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n` +
    `💰 Цена: <b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)</blockquote>\n\n` +
    `<blockquote>💳 Сейчас: ${user.balance.toFixed(2)} USDT\n` +
    `💳 После: <b>${newBalance} USDT</b></blockquote>\n\n` +
    `Подтвердите покупку.`;

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`✅ Да, купить за ${effectivePrice} USDT`, `shop:confirm:${productId}:${safePage}`)],
      [Markup.button.callback('⬅️ Вернуться к товару', `shop:product:${productId}:${safePage}`)],
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

  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const stock = await getStock(product);
  const effectivePrice = await getEffectivePrice(product, stock);

  if (user.balance < effectivePrice) {
    const deficit = parseFloat((effectivePrice - user.balance).toFixed(2));
    const text =
      `❌ <b>Недостаточно средств</b>\n\n` +
      `💰 Ваш баланс: <b>${user.balance.toFixed(2)} USDT</b>\n` +
      `🏷 Стоимость: <b>${effectivePrice} USDT</b>\n` +
      `📉 Не хватает: <b>${deficit} USDT</b>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`💰 Пополнить на ${deficit} USDT`, `topup:quick:${deficit}`)],
      [Markup.button.callback('⬅️ Назад', `shop:product:${product._id}`)],
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
      return ctx.answerCbQuery('❌ Недостаточно средств', { show_alert: true });
    }
    if (err.message === 'OUT_OF_STOCK') {
      return ctx.answerCbQuery('❌ Товар закончился', { show_alert: true });
    }

    // Неожиданная ошибка — показываем экран с retry/support/menu вместо голого alert.
    await ctx.answerCbQuery('❌ Ошибка при покупке').catch(() => {});
    await errorScreen(ctx, {
      title: '💥 Не удалось оформить заказ',
      message:
        `Произошла непредвиденная ошибка. Деньги не списаны.\n\n` +
        `Можно попробовать снова или обратиться в поддержку — мы разберёмся.`,
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

  if (product.type === 'gpt_activation') {
    const text =
      `✅ <b>Заказ создан</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} ${escapeHtml(product.name)}\n` +
      `📋 Заказ: <code>${order._id}</code>\n` +
      `💰 Списано: <b>${effectivePrice} USDT</b>\n\n` +
      `⏳ Сейчас запрошу ваш токен...`;
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

    const text =
      `✅ <b>Заказ выполнен автоматически</b>\n\n` +
      `📦 Товар: ${escapeHtml(product.icon || '📦')} ${escapeHtml(product.name)}\n` +
      `📋 Заказ: <code>${order._id}</code>\n` +
      `💰 Списано: <b>${effectivePrice} USDT</b>\n\n` +
      `🔑 <b>Ваш ключ:</b>\n<pre>${escapeHtml(allocatedKey.value)}</pre>`;

    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Купить ещё', `shop:product:${product._id}`)],
        [Markup.button.callback('⬅️ В главное меню', 'menu:main')],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  } else {
    const text =
      `✅ <b>Заказ создан</b>\n\n` +
      `📦 Товар: ${escapeHtml(product.icon || '📦')} ${escapeHtml(product.name)}\n` +
      `📋 Заказ: <code>${order._id}</code>\n` +
      `💰 Списано: ${effectivePrice} USDT\n\n` +
      `⏳ Оператор обработает заказ в ближайшее время.`;

    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
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

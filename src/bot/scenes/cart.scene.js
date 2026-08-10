const { Markup } = require('telegraf');
const cartService = require('../../services/cart.service');
const { escapeHtml } = require('../utils/ui');
const { toRub } = require('../../services/currency.service');

/**
 * Отображение экрана корзины пользователя
 */
const showCart = async (ctx) => {
  const user = ctx.user;
  const cartData = await cartService.getCart(user);

  if (cartData.items.length === 0) {
    const emptyText = `🛒 <b>Ваша корзина пуста</b>\n\n` +
      `Вы пока не добавили ни одного товара.\n` +
      `Перейдите в магазин и нажмите <b>«🛒 В корзину»</b> на любом товаре!`;

    const emptyButtons = [
      [Markup.button.callback('🛍 Перейти в магазин', 'menu:shop')],
      [Markup.button.callback('⬅️ Главное меню', 'menu:main')],
    ];

    const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) };
    if (ctx.callbackQuery) {
      await ctx.editMessageText(emptyText, opts).catch(() => {});
      await ctx.answerCbQuery().catch(() => {});
    } else {
      await ctx.reply(emptyText, opts);
    }
    return;
  }

  let text = `🛒 <b>Ваша корзина (${cartData.totalCount} шт.)</b>\n\n`;

  const buttons = [];

  cartData.items.forEach((item, index) => {
    const p = item.product;
    const stockWarning = !item.isAvailable ? ' ⚠️ <i>(недостаточно на складе)</i>' : '';

    text += `${index + 1}. <b>${escapeHtml(p.name)}</b>${stockWarning}\n` +
      `   └ <b>${item.qty} шт.</b> × $${p.price.toFixed(2)} = <b>$${item.itemTotal.toFixed(2)}</b>\n\n`;

    // Кнопки управления количеством для каждой позиции
    buttons.push([
      Markup.button.callback('➖', `cart:qty:${p._id}:-1`),
      Markup.button.callback(`📦 ${p.name.substring(0, 18)} (x${item.qty})`, `shop:product:${p._id}`),
      Markup.button.callback('➕', `cart:qty:${p._id}:1`),
      Markup.button.callback('🗑', `cart:remove:${p._id}`),
    ]);
  });

  text += `────────────────────\n`;
  text += `Сумма товаров: <b>$${cartData.subtotal.toFixed(2)}</b>\n`;

  if (cartData.discountAmount > 0 && cartData.activePromo) {
    text += `🎟 Скидка по промокоду (<code>${escapeHtml(cartData.activePromo.code)}</code>): <b>-$${cartData.discountAmount.toFixed(2)}</b>\n`;
  }

  text += `💰 <b>Итого к оплате: $${cartData.finalTotal.toFixed(2)} USDT</b> (≈ ${toRub(cartData.finalTotal)})\n`;
  text += `💳 Ваш баланс: <b>${user.balance.toFixed(2)} USDT</b>\n`;

  if (cartData.hasStockIssue) {
    text += `\n⚠️ <i>Пожалуйста, уменьшите количество позиций, которых нет на складе.</i>`;
  }

  // Кнопка оплаты или пополнения
  if (user.balance < cartData.finalTotal) {
    const deficit = parseFloat((cartData.finalTotal - user.balance).toFixed(2));
    buttons.push([
      Markup.button.callback(`💰 Пополнить на ${deficit} USDT`, `topup:quick:${deficit}`),
    ]);
  } else if (!cartData.hasStockIssue) {
    buttons.push([
      Markup.button.callback(`✅ Оплатить всю корзину ($${cartData.finalTotal.toFixed(2)})`, 'cart:checkout'),
    ]);
  }

  // Промокод и действия
  const promoBtn = cartData.activePromo
    ? Markup.button.callback(`🎟 Промокод: ${cartData.activePromo.code} (✅)`, 'cart:promo')
    : Markup.button.callback('🎟 Ввести промокод на скидку', 'cart:promo');

  buttons.push([promoBtn]);
  buttons.push([
    Markup.button.callback('🗑 Очистить корзину', 'cart:clear'),
    Markup.button.callback('🛍 В магазин', 'menu:shop'),
  ]);
  buttons.push([Markup.button.callback('⬅️ Главное меню', 'menu:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

/**
 * Быстрое добавление товара в корзину из карточки
 */
const handleAddToCart = async (ctx, productId) => {
  const res = await cartService.addToCart(ctx.user._id, productId, 1);
  if (res.success) {
    await ctx.answerCbQuery(`🛒 Добавлено в корзину! (Всего: ${res.totalCount} шт.)`, { show_alert: false }).catch(() => {});
  } else {
    await ctx.answerCbQuery('❌ Ошибка добавления в корзину', { show_alert: true }).catch(() => {});
  }
};

/**
 * Изменение количества позиции
 */
const handleUpdateQty = async (ctx, productId, delta) => {
  await cartService.updateItemQty(ctx.user._id, productId, parseInt(delta, 10) || 0);
  await showCart(ctx);
};

/**
 * Удаление позиции из корзины
 */
const handleRemoveItem = async (ctx, productId) => {
  await cartService.removeFromCart(ctx.user._id, productId);
  await ctx.answerCbQuery('🗑 Товар удалён из корзины').catch(() => {});
  await showCart(ctx);
};

/**
 * Очистка корзины
 */
const handleClearCart = async (ctx) => {
  await cartService.clearCart(ctx.user._id);
  await ctx.answerCbQuery('🗑 Корзина очищена').catch(() => {});
  await showCart(ctx);
};

/**
 * Оформление заказа из корзины
 */
const handleCheckout = async (ctx) => {
  await ctx.answerCbQuery('⏳ Оформляем заказ...').catch(() => {});

  const res = await cartService.checkoutCart(ctx);

  if (!res.success) {
    if (res.isInsufficientBalance) {
      await ctx.reply(`❌ <b>Недостаточно средств</b>\n\nСумма заказа: <b>${res.totalCost} USDT</b>\nВаш баланс: <b>${res.balance.toFixed(2)} USDT</b>\nНе хватает: <b>${res.diff} USDT</b>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`💰 Пополнить на ${res.diff} USDT`, `topup:quick:${res.diff}`)],
          [Markup.button.callback('🛒 Вернуться в корзину', 'menu:cart')],
        ]),
      });
      return;
    }

    await ctx.reply(`❌ ${res.error}`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🛒 В корзину', 'menu:cart')]]),
    });
    return;
  }

  // Успешная оплата и сводный чек выдачи
  let successText = `🎉 <b>Заказ успешно оплачен!</b>\n\n` +
    `📦 Позиций: <b>${res.itemsCount}</b> | Всего товаров: <b>${res.totalQty} шт.</b>\n` +
    `💰 Списано: <b>${res.totalCost.toFixed(2)} USDT</b>\n\n` +
    `────────────────────\n` +
    `<b>🔑 ВЫДАЧА ТОВАРОВ:</b>\n\n`;

  res.deliveryReports.forEach((rep, i) => {
    const icon = rep.isInstant ? '⚡' : '⏳';
    successText += `${i + 1}. ${icon} <b>${escapeHtml(rep.name)}</b> (x${rep.qty})\n` +
      `<code>${escapeHtml(rep.data)}</code>\n\n`;
  });

  successText += `<i>Все данные также сохранены в разделе «📜 Мои покупки» в вашем профиле.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📜 Мои покупки', 'profile:orders')],
    [Markup.button.callback('🛍 Продолжить покупки', 'menu:shop')],
    [Markup.button.callback('🏠 В главное меню', 'menu:main')],
  ]);

  await ctx.reply(successText, { parse_mode: 'HTML', ...keyboard });
};

module.exports = {
  showCart,
  handleAddToCart,
  handleUpdateQty,
  handleRemoveItem,
  handleClearCart,
  handleCheckout,
};

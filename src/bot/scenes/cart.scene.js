const { Markup } = require('telegraf');
const cartService = require('../../services/cart.service');
const { escapeHtml, formatDigitalItem, get2FAButtonLabel, has2FASecret, safeEditRich, isRichActive } = require('../utils/ui');
const { getSettings } = require('../../services/settingsCache.service');
const { toRub } = require('../../services/currency.service');

/**
 * Генерация Rich HTML для экрана корзины
 */
const buildCartRichHtml = ({
  text,
  cartData,
  userBalance = 0,
  lang = 'ru',
}) => {
  let richHtml = `${text}\n\n`;

  // Пустая корзина
  if (!cartData || !cartData.items || cartData.items.length === 0) {
    const catalogLabel = lang === 'en' ? '🛍 Go to Catalog' : '🛍 В каталог';
    const menuLabel = lang === 'en' ? '⬅️ Main Menu' : '⬅️ Главное меню';
    richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="primary" data="menu:shop">${escapeHtml(catalogLabel)}</tg-button></tg-button-row>\n`;
    richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="link" data="menu:main">${escapeHtml(menuLabel)}</tg-button></tg-button-row>`;
    return richHtml.trim();
  }

  // Непустая корзина: для каждого товара ряд [-] [📦 Название (xN)] [+] [🗑]
  for (const item of cartData.items) {
    const p = item.product;
    const pName = p?.name || 'Товар';
    const pId = p?._id || item.productId;
    const title = `📦 ${pName.substring(0, 18)} (x${item.qty})`;
    richHtml += `<tg-button-row align="left">` +
      `<tg-button type="callback_data" style="primary" data="cart:qty:${pId}:-1">➖</tg-button>` +
      `<tg-button type="callback_data" style="link" data="shop:product:${pId}">${escapeHtml(title)}</tg-button>` +
      `<tg-button type="callback_data" style="primary" data="cart:qty:${pId}:1">➕</tg-button>` +
      `<tg-button type="callback_data" style="danger" data="cart:remove:${pId}">🗑</tg-button>` +
      `</tg-button-row>\n`;
  }

  // Кнопка оплаты или пополнения
  if (userBalance < cartData.finalTotal) {
    const deficit = parseFloat((cartData.finalTotal - userBalance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${deficit} USDT` : `💰 Пополнить на ${deficit} USDT`;
    richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="primary" data="topup:quick:${deficit}">${escapeHtml(topupLabel)}</tg-button></tg-button-row>\n`;
  } else if (!cartData.hasStockIssue) {
    const payLabel = lang === 'en' ? `✅ Checkout All ($${cartData.finalTotal.toFixed(2)})` : `✅ Оплатить корзину ($${cartData.finalTotal.toFixed(2)})`;
    richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="success" data="cart:checkout">${escapeHtml(payLabel)}</tg-button></tg-button-row>\n`;
  }

  // Кнопка промокода
  const promoLabel = cartData.activePromo
    ? `🎟 ${lang === 'en' ? 'Promo' : 'Промокод'}: ${cartData.activePromo.code} (✅)`
    : (lang === 'en' ? '🎟 Apply Promo Code' : '🎟 Ввести промокод на скидку');
  richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="primary" data="cart:promo">${escapeHtml(promoLabel)}</tg-button></tg-button-row>\n`;

  // Очистить корзину / В каталог
  const clearLabel = lang === 'en' ? '🗑 Clear Cart' : '🗑 Очистить корзину';
  const toCatalogLabel = lang === 'en' ? '🛍 To Catalog' : '🛍 В каталог';
  richHtml += `<tg-button-row align="left">` +
    `<tg-button type="callback_data" style="danger" data="cart:clear">${escapeHtml(clearLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:shop">${escapeHtml(toCatalogLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  // Главное меню
  const mainMenuLabel = lang === 'en' ? '⬅️ Main Menu' : '⬅️ Главное меню';
  richHtml += `<tg-button-row align="left"><tg-button type="callback_data" style="link" data="menu:main">${escapeHtml(mainMenuLabel)}</tg-button></tg-button-row>`;

  return richHtml.trim();
};

/**
 * Отображение экрана корзины пользователя
 */
const showCart = async (ctx) => {
  const user = ctx.user;
  const lang = ctx.user?.language || 'ru';
  const cartData = await cartService.getCart(user);

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);

  if (cartData.items.length === 0) {
    const emptyText = lang === 'en'
      ? `🛒 <b>Your Cart is Empty</b>\n\n<blockquote>Add products from the catalog using the <b>«🛒 To Cart»</b> button!</blockquote>`
      : `🛒 <b>Ваша корзина пуста</b>\n\n<blockquote>Добавьте понравившиеся товары из каталога с помощью кнопки <b>«🛒 В корзину»</b>!</blockquote>`;

    const emptyButtons = [
      [Markup.button.callback(lang === 'en' ? '🛍 Go to Catalog' : '🛍 В каталог', 'menu:shop')],
      [Markup.button.callback(lang === 'en' ? '⬅️ Main Menu' : '⬅️ Главное меню', 'menu:main')],
    ];

    const richHtml = buildCartRichHtml({ text: emptyText, cartData, userBalance: user.balance, lang });
    return await safeEditRich(ctx, { richHtml, classicText: emptyText, classicKeyboard: emptyButtons, isRich });
  }

  let text = lang === 'en'
    ? `🛒 <b>Your Cart (${cartData.totalCount} pcs)</b>\n\n`
    : `🛒 <b>Ваша корзина (${cartData.totalCount} шт.)</b>\n\n`;

  const buttons = [];

  cartData.items.forEach((item, index) => {
    const p = item.product;
    const stockWarning = !item.isAvailable ? (lang === 'en' ? ' ⚠️ <i>(out of stock)</i>' : ' ⚠️ <i>(недостаточно на складе)</i>') : '';

    text += `${index + 1}. <b>${escapeHtml(p.name)}</b>${stockWarning}\n` +
      `   └ <b>${item.qty} шт.</b> × $${item.unitPrice.toFixed(2)} = <b>$${item.itemTotal.toFixed(2)}</b>\n\n`;

    // Кнопки управления количеством для каждой позиции
    buttons.push([
      Markup.button.callback('➖', `cart:qty:${p._id}:-1`),
      Markup.button.callback(`📦 ${p.name.substring(0, 18)} (x${item.qty})`, `shop:product:${p._id}`),
      Markup.button.callback('➕', `cart:qty:${p._id}:1`),
      Markup.button.callback('🗑', `cart:remove:${p._id}`),
    ]);
  });

  text += `────────────────────\n`;
  text += `${lang === 'en' ? 'Subtotal' : 'Сумма товаров'}: <b>$${cartData.subtotal.toFixed(2)}</b>\n`;

  if (cartData.discountAmount > 0 && cartData.activePromo) {
    text += `🎟 ${lang === 'en' ? 'Promo Discount' : 'Скидка по промокоду'} (<code>${escapeHtml(cartData.activePromo.code)}</code>): <b>-$${cartData.discountAmount.toFixed(2)}</b>\n`;
  } else if (cartData.promoReason) {
    text += `🎟 <i>${escapeHtml(cartData.promoReason)}</i>\n`;
  }

  text += `💰 <b>${lang === 'en' ? 'Total to pay' : 'Итого к оплате'}: $${cartData.finalTotal.toFixed(2)} USDT</b> (≈ ${toRub(cartData.finalTotal)} ₽)\n`;
  text += `💳 ${lang === 'en' ? 'Your balance' : 'Ваш баланс'}: <b>${user.balance.toFixed(2)} USDT</b>\n`;

  if (cartData.hasStockIssue) {
    text += `\n⚠️ <i>${lang === 'en' ? 'Please adjust items that are out of stock.' : 'Пожалуйста, уменьшите количество позиций, которых нет на складе.'}</i>`;
  }

  // Кнопка оплаты или пополнения
  if (user.balance < cartData.finalTotal) {
    const deficit = parseFloat((cartData.finalTotal - user.balance).toFixed(2));
    buttons.push([
      Markup.button.callback(lang === 'en' ? `💰 Top up ${deficit} USDT` : `💰 Пополнить на ${deficit} USDT`, `topup:quick:${deficit}`),
    ]);
  } else if (!cartData.hasStockIssue) {
    buttons.push([
      Markup.button.callback(lang === 'en' ? `✅ Checkout All ($${cartData.finalTotal.toFixed(2)})` : `✅ Оплатить корзину ($${cartData.finalTotal.toFixed(2)})`, 'cart:checkout'),
    ]);
  }

  // Промокод и действия
  const promoBtn = cartData.activePromo
    ? Markup.button.callback(`🎟 ${lang === 'en' ? 'Promo' : 'Промокод'}: ${cartData.activePromo.code} (✅)`, 'cart:promo')
    : Markup.button.callback(lang === 'en' ? '🎟 Apply Promo Code' : '🎟 Ввести промокод на скидку', 'cart:promo');

  buttons.push([promoBtn]);
  buttons.push([
    Markup.button.callback(lang === 'en' ? '🗑 Clear Cart' : '🗑 Очистить корзину', 'cart:clear'),
    Markup.button.callback(lang === 'en' ? '🛍 To Catalog' : '🛍 В каталог', 'menu:shop'),
  ]);
  buttons.push([Markup.button.callback(lang === 'en' ? '⬅️ Main Menu' : '⬅️ Главное меню', 'menu:main')]);

  const richHtml = buildCartRichHtml({ text, cartData, userBalance: user.balance, lang });
  await safeEditRich(ctx, { richHtml, classicText: text, classicKeyboard: buttons, isRich });
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

  const userLang = ctx.user?.language || 'ru';
  res.deliveryReports.forEach((rep, i) => {
    const icon = rep.isInstant ? '⚡' : '⏳';
    const itemData = rep.isInstant ? formatDigitalItem(rep.data, userLang) : `<i>${escapeHtml(rep.data)}</i>`;
    successText += `${i + 1}. ${icon} <b>${escapeHtml(rep.name)}</b> (x${rep.qty})\n` +
      `${itemData}\n\n`;
  });

  successText += `<i>Все данные также сохранены в разделе «📜 Мои покупки» в вашем профиле.</i>`;

  const twoFaReports = res.deliveryReports.filter(
    (rep) => rep.isInstant && rep.orderId && has2FASecret(rep.data)
  );
  const kbRows = [];
  twoFaReports.forEach((rep, idx) => {
    const label = twoFaReports.length === 1
      ? get2FAButtonLabel(userLang)
      : `${get2FAButtonLabel(userLang)} (#${idx + 1})`;
    kbRows.push([Markup.button.callback(label, `profile:order:2fa:${rep.orderId}`)]);
  });
  kbRows.push([Markup.button.callback('📜 Мои покупки', 'profile:orders')]);
  kbRows.push([Markup.button.callback('🛍 Продолжить покупки', 'menu:shop')]);
  kbRows.push([Markup.button.callback('🏠 В главное меню', 'menu:main')]);

  const keyboard = Markup.inlineKeyboard(kbRows);

  await ctx.reply(successText, { parse_mode: 'HTML', ...keyboard });
};

module.exports = {
  showCart,
  buildCartRichHtml,
  handleAddToCart,
  handleUpdateQty,
  handleRemoveItem,
  handleClearCart,
  handleCheckout,
};

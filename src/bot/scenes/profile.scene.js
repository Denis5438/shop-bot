const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const TopupRequest = require('../../models/TopupRequest');
const { toRub } = require('../../services/currency.service');
const { ORDER_STATUS_LABELS } = require('../constants/ux');
const { escapeHtml, formatDateTimeMSK, formatDateMSK, safeEdit } = require('../utils/ui');
const { getAllWithProgress, renderAchievementsText } = require('../../services/achievements.service');

const PER_PAGE = 5;
const ACTIVE_STATUSES = ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry', 'preorder_pending'];

// Уровень пользователя по сумме потраченного.
// Возвращает { emoji, labelKey } - вызывающий код использует ctx.t(labelKey)
// для локализации на язык пользователя.
const getLevel = (totalSpent) => {
  if (totalSpent >= 50) return { emoji: '💎', labelKey: 'level_vip' };
  if (totalSpent >= 20) return { emoji: '🥇', labelKey: 'level_experienced' };
  if (totalSpent >= 5)  return { emoji: '🥈', labelKey: 'level_regular' };
  return { emoji: '🌱', labelKey: 'level_new' };
};

// Возвращает локализованный статус заказа. Ключ статуса → ключ в локали.
const localizedOrderStatus = (ctx, status) => {
  const key = `order_status_${status}`;
  const localized = ctx.t ? ctx.t(key) : null;
  // Если перевод не найден (не добавлен новый статус в локаль) - fallback на RU-мапку.
  return localized && localized !== key ? localized : (ORDER_STATUS_LABELS[status] || status);
};

// Показ профиля пользователя
const showProfile = async (ctx) => {
  const user = ctx.user;

  // Оба запроса параллельно
  const [ordersCount, activeOrder] = await Promise.all([
    Order.countDocuments({ userId: user._id }),
    // Незавершённый заказ (awaiting_token)
    Order.findOne({ userId: user._id, status: 'awaiting_token' })
      .populate('productId', 'name icon')
      .lean(),
  ]);
  const createdAt = new Date(user.createdAt).toLocaleDateString('ru-RU');
  const level = getLevel(user.totalSpent);

  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const levelLabel = t(level.labelKey).replace(/^[^\s]+\s/, ''); // убираем эмодзи в начале для подписи

  let bannerText = '';
  if (activeOrder) {
    const icon = activeOrder.productId?.icon || '📦';
    const name = activeOrder.productId?.name || 'Товар';
    bannerText = `<blockquote>${t('profile_banner_unfinished', { icon, name })}</blockquote>\n\n`;
  }

  const text =
    `👤 <b>${lang === 'en' ? 'My Profile' : 'Мой профиль'}</b>\n\n` +
    bannerText +
    `<blockquote>${level.emoji} ${t('profile_level')}: <b>${levelLabel}</b>\n\n` +
    `🆔 ${t('profile_id')}: <code>${user.telegramId}</code>\n` +
    `📛 ${t('profile_name')}: ${escapeHtml(user.firstName)}${user.lastName ? ' ' + escapeHtml(user.lastName) : ''}\n\n` +
    `💰 ${t('profile_balance')}: <b>${user.balance.toFixed(2)} USDT</b>  (~${toRub(user.balance)} ₽)\n` +
    `📦 ${t('profile_orders')}: ${ordersCount}\n` +
    `💸 ${t('profile_spent')}: ${user.totalSpent.toFixed(2)} USDT\n\n` +
    `🔗 ${t('profile_ref_code')}: <code>${escapeHtml(user.referralCode)}</code>\n` +
    `📅 ${t('profile_joined')}: ${createdAt}</blockquote>`;

  const btnStyleLabel = user.btnStyle === 'classic'
    ? (lang === 'en' ? '🎨 Theme: 🔘 Classic' : '🎨 Стиль: 🔘 Прозрачные')
    : (lang === 'en' ? '🎨 Theme: 🟢 Colored' : '🎨 Стиль: 🟢 Цветные');

  const buttons = [];
  if (activeOrder) {
    buttons.push([Markup.button.callback(
      t('profile_continue_activation'),
      `profile:continue_order:${activeOrder._id}`
    )]);
  }
  buttons.push([
    Markup.button.callback(t('btn_orders'), 'profile:orders'),
    Markup.button.callback(lang === 'en' ? '💳 Top-up History' : '💳 История пополнений', 'profile:topups'),
  ]);
  buttons.push([
    Markup.button.callback(lang === 'en' ? '🎟 Promo Code' : '🎟 Промокод', 'user:activate_promo'),
    Markup.button.callback(t('profile_achievements_btn'), 'profile:achievements'),
  ]);
  buttons.push([
    Markup.button.callback(btnStyleLabel, 'profile:toggle_btn_style'),
  ]);
  buttons.push([Markup.button.callback(t('btn_back'), 'menu:main')]);

  const keyboard = Markup.inlineKeyboard(buttons);
  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

// Смена языка
const showLanguageSelect = async (ctx) => {
  const text = '🌐 <b>Выберите язык / Choose language:</b>';
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🇷🇺 Русский', 'lang:ru'),
      Markup.button.callback('🇬🇧 English', 'lang:en'),
    ],
    [Markup.button.callback('⬅️ Назад', 'menu:profile')],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

// История заказов с фильтром и пагинацией
const showOrders = async (ctx, filter = 'all', page = 1) => {
  const user = ctx.user;

  const query = { userId: user._id };
  if (filter === 'active') {
    query.status = { $in: ACTIVE_STATUSES };
  }

  const total = await Order.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  page = Math.min(Math.max(1, page), totalPages);

  // Display-only список: узкий populate + lean
  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * PER_PAGE)
    .limit(PER_PAGE)
    .populate('productId', 'name nameEn icon')
    .lean();

  const t = ctx.t || ((k) => k);
  const filterLabel = filter === 'active' ? t('orders_filter_active') : t('orders_filter_all');

  if (orders.length === 0) {
    const emptyMsg = filter === 'active' ? t('orders_empty_active') : t('orders_empty_all');

    const emptyButtons = [];
    if (filter === 'active') {
      emptyButtons.push([Markup.button.callback(t('orders_show_all'), 'profile:orders:all:1')]);
    }
    emptyButtons.push([Markup.button.callback(t('orders_to_shop'), 'menu:shop')]);
    emptyButtons.push([Markup.button.callback(t('btn_back'), 'menu:profile')]);

    return await safeEdit(ctx, emptyMsg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
  }

  let text = `${filterLabel}  ·  ${t('orders_page')} ${page}/${totalPages}\n\n`;
  for (const order of orders) {
    const date = new Date(order.createdAt).toLocaleDateString('ru-RU');
    const status = localizedOrderStatus(ctx, order.status);
    const productName = escapeHtml(order.productId?.name || 'Товар удалён');
    const qtyText = order.qty > 1 ? ` (x${order.qty})` : '';
    text += `<blockquote>${escapeHtml(order.productId?.icon || '📦')} <b>${productName}${qtyText}</b>\n`;
    text += `   ${status}  ·  ${order.price} USDT  ·  ${date}\n`;
    text += `   <code>${order._id}</code></blockquote>\n\n`;
  }

  const detailBtns = orders.map(o => [
    Markup.button.callback(`🔍 Заказ #${o._id.toString().slice(-6)}: ${escapeHtml(o.productId?.name || 'Товар').slice(0, 20)}`, `profile:order:detail:${o._id}`)
  ]);

  // Кнопки депо/деталей и фильтра
  const buttons = [...detailBtns];
  buttons.push([
    Markup.button.callback(filter === 'all'    ? t('orders_tab_all') : '📋 ' + t('orders_tab_all').replace('☑️ ', ''), 'profile:orders:all:1'),
    Markup.button.callback(filter === 'active' ? t('orders_tab_active') : '📋 ' + t('orders_tab_active').replace('🔄 ', ''), 'profile:orders:active:1'),
  ]);

  // Навигация
  if (totalPages > 1) {
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `profile:orders:${filter}:${page - 1}`));
    nav.push(Markup.button.callback(`${page}/${totalPages}`, 'shop:noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `profile:orders:${filter}:${page + 1}`));
    buttons.push(nav);
  }

  buttons.push([Markup.button.callback(t('btn_back'), 'menu:profile')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

// №20 Достижения: отдельный экран со списком ачивок + прогрессом
const showAchievements = async (ctx) => {
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const items = await getAllWithProgress(ctx.user._id);
  const text = renderAchievementsText(items, lang);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(t('profile_back_to_profile'), 'menu:profile')],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

const showOrderDetail = async (ctx, orderId) => {
  const order = await Order.findById(orderId)
    .populate('productId')
    .populate('keyId')
    .populate('replacedKeyId');

  if (!order || order.userId.toString() !== ctx.user._id.toString()) {
    return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });
  }

  const lang = ctx.user?.language || 'ru';

  const product = order.productId;
  const productName = escapeHtml(product?.name || 'Товар');
  const date = new Date(order.createdAt).toLocaleDateString('ru-RU');
  const statusLbl = localizedOrderStatus(ctx, order.status);

  const warrantyDays = order.warrantyDays ?? product?.warrantyDays ?? 5;
  const confirmedBase = order.confirmedAt || order.createdAt;
  const warrantyExpiresAt = new Date(confirmedBase.getTime() + warrantyDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  const isWarrantyActive = now < warrantyExpiresAt && order.status === 'completed';

  let warrantyStr = '';
  if (order.status === 'completed' && warrantyDays > 0) {
    if (isWarrantyActive) {
      const diffMs = warrantyExpiresAt.getTime() - now.getTime();
      const daysLeft = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      warrantyStr = `🛡 <b>Гарантия:</b> ${lang === 'en' ? `Active (${daysLeft} of ${warrantyDays} days left)` : `Активна (осталось ${daysLeft} дн. из ${warrantyDays})`}`;
    } else {
      warrantyStr = `🛡 <b>Гарантия:</b> ${lang === 'en' ? `Expired (${warrantyDays} days)` : `Истёкла (${warrantyDays} дн.)`}`;
    }
  }

  const subscriptionDays = order.subscriptionDays ?? product?.subscriptionDays ?? 0;
  let subscriptionStr = '';
  if (order.status === 'completed' && subscriptionDays > 0) {
    const subscriptionExpiresAt = new Date(confirmedBase.getTime() + subscriptionDays * 24 * 60 * 60 * 1000);
    const isSubActive = now < subscriptionExpiresAt;
    if (isSubActive) {
      const subDiffMs = subscriptionExpiresAt.getTime() - now.getTime();
      const subDaysLeft = Math.max(1, Math.ceil(subDiffMs / (1000 * 60 * 60 * 24)));
      const untilDate = subscriptionExpiresAt.toLocaleDateString('ru-RU');
      subscriptionStr = `⏳ <b>Подписка:</b> ${lang === 'en' ? `Active (${subDaysLeft} of ${subscriptionDays} days left, until ${untilDate})` : `Активна (осталось ${subDaysLeft} дн. из ${subscriptionDays}, до ${untilDate})`}`;
    } else {
      subscriptionStr = `⏳ <b>Подписка:</b> ${lang === 'en' ? `Expired (${subscriptionDays} days)` : `Истёкла (${subscriptionDays} дн.)`}`;
    }
  }

  let replacementStr = '';
  if (order.replacementStatus === 'pending') {
    replacementStr = `\n⏳ <b>Статус замены:</b> На рассмотрении модератором`;
  } else if (order.replacementStatus === 'approved') {
    replacementStr = `\n✅ <b>Статус замены:</b> Заявка одобрена (новый аккаунт выдан)`;
  } else if (order.replacementStatus === 'rejected') {
    const reason = order.replacementRejectReason ? ` (${escapeHtml(order.replacementRejectReason)})` : '';
    replacementStr = `\n❌ <b>Статус замены:</b> Отклонена${reason}`;
  }

  let issuedDataStr = '';
  const itemValue = order.replacedKeyId?.value || order.deliveryData || order.keyId?.value;
  if (itemValue) {
    const { formatDigitalItem } = require('../utils/ui');
    issuedDataStr = `\n\n📦 <b>Выданные данные товара:</b>\n${formatDigitalItem(itemValue, lang)}`;
  }

  const text =
    `📋 <b>Детали заказа</b> <code>${order._id}</code>\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(product?.icon || '📦')} ${productName}\n` +
    `💰 <b>Сумма:</b> ${order.price} USDT\n` +
    `📅 <b>Дата:</b> ${date}\n` +
    `🔘 <b>Статус:</b> ${statusLbl}\n` +
    (warrantyStr ? `${warrantyStr}\n` : '') +
    (subscriptionStr ? `${subscriptionStr}\n` : '') +
    replacementStr +
    issuedDataStr;

  const buttons = [];

  if (order.status === 'preorder_pending') {
    buttons.push([Markup.button.callback('❌ Отменить предзаказ (вернуть деньги)', `profile:cancel_preorder:${order._id}`)]);
  }

  if (isWarrantyActive && order.replacementStatus === 'none') {
    buttons.push([Markup.button.callback('🔄 Запросить замену по гарантии', `profile:warranty:claim:${order._id}`)]);
  }

  buttons.push([Markup.button.callback('⬅️ К заказам', 'profile:orders:all:1')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const cancelPreorder = async (ctx, orderId) => {
  // Атомарный захват заказа: статус меняется ТОЛЬКО из preorder_pending.
  // Раньше два быстрых нажатия возвращали деньги дважды.
  const order = await Order.findOneAndUpdate(
    { _id: orderId, userId: ctx.user._id, status: 'preorder_pending' },
    { $set: { status: 'cancelled' } },
    { new: true }
  ).populate('productId');
  if (!order) {
    return ctx.answerCbQuery('❌ Заказ не найден или предзаказ уже не в очереди', { show_alert: true });
  }

  const User = require('../../models/User');
  try {
    await User.updateOne({ _id: ctx.user._id }, { $inc: { balance: order.price } });
    ctx.user.balance = parseFloat((ctx.user.balance + order.price).toFixed(8));
  } catch (refundErr) {
    // Откатываем статус заказа обратно, чтобы деньги не пропали
    await Order.updateOne({ _id: order._id }, { $set: { status: 'preorder_pending' } }).catch(() => {});
    return ctx.answerCbQuery('❌ Ошибка возврата средств. Попробуйте ещё раз.', { show_alert: true });
  }

  const Transaction = require('../../models/Transaction');
  await new Transaction({
    userId: ctx.user._id,
    type: 'refund',
    amount: order.price,
    orderId: order._id,
    description: 'Отмена предзаказа',
  }).save().catch(() => {});

  const isRu = (ctx.user.language || 'ru') === 'ru';
  const alertMsg = isRu
    ? `✅ Предзаказ отменён. ${order.price} USDT возвращены на ваш баланс!`
    : `✅ Pre-order cancelled. ${order.price} USDT returned to your balance!`;

  await ctx.answerCbQuery(alertMsg, { show_alert: true });
  await showOrderDetail(ctx, orderId);
};

const toggleBtnStyle = async (ctx) => {
  if (ctx.user) {
    const nextStyle = ctx.user.btnStyle === 'classic' ? 'colored' : 'classic';
    ctx.user.btnStyle = nextStyle;
    await User.updateOne({ _id: ctx.user._id }, { $set: { btnStyle: nextStyle } });
    const lang = ctx.user.language || 'ru';
    const alertText = nextStyle === 'classic'
      ? (lang === 'en' ? '🔘 Theme updated: Classic transparent buttons!' : '🔘 Тема обновлена: Прозрачные классические кнопки!')
      : (lang === 'en' ? '🟢 Theme updated: Colored buttons!' : '🟢 Тема обновлена: Яркие цветные кнопки!');
    await ctx.answerCbQuery(alertText).catch(() => {});
  }
  await showProfile(ctx);
};

const TOPUPS_PER_PAGE = 5;

const getTopupMethodLabel = (method, network, lang = 'ru') => {
  if (method === 'platega') return lang === 'en' ? '⚡ SBP (Platega)' : '⚡ СБП (Авто)';
  if (method === 'card') return lang === 'en' ? '🏦 IDBank Card' : '🏦 Карта IDBank';
  if (method === 'bybit') {
    const netStr = network ? ` (${network.toUpperCase()})` : '';
    return `📊 Bybit${netStr}`;
  }
  return lang === 'en' ? '💳 Top-up' : '💳 Пополнение';
};

const getTopupStatusBadge = (status, lang = 'ru') => {
  if (status === 'confirmed') return lang === 'en' ? '✅ Confirmed' : '✅ Зачислено';
  if (status === 'rejected') return lang === 'en' ? '❌ Rejected' : '❌ Отклонено';
  return lang === 'en' ? '⏳ In progress' : '⏳ В обработке';
};

// История пополнений пользователя с пагинацией
const showTopupHistory = async (ctx, page = 1) => {
  const user = ctx.user;
  const lang = user?.language || 'ru';
  const t = ctx.t || ((k) => k);

  const total = await TopupRequest.countDocuments({ userId: user._id });
  const totalPages = Math.max(1, Math.ceil(total / TOPUPS_PER_PAGE));
  page = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);

  const requests = await TopupRequest.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .skip((page - 1) * TOPUPS_PER_PAGE)
    .limit(TOPUPS_PER_PAGE)
    .lean();

  const title = lang === 'en' ? '💳 <b>Top-up History</b>' : '💳 <b>История пополнений баланса</b>';

  if (requests.length === 0) {
    const emptyText = `${title}\n\n` +
      `<blockquote>` +
      (lang === 'en' ? 'ℹ️ You have no top-up history yet.' : 'ℹ️ У вас пока нет операций пополнения баланса.') +
      `</blockquote>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'en' ? '➕ Top Up Balance' : '➕ Пополнить баланс', 'menu:topup')],
      [Markup.button.callback(t('btn_back'), 'menu:profile')],
    ]);
    return safeEdit(ctx, emptyText, { parse_mode: 'HTML', ...keyboard });
  }

  let text = `${title}\n\n`;
  const buttons = [];

  requests.forEach((req, idx) => {
    const num = (page - 1) * TOPUPS_PER_PAGE + idx + 1;
    const methodStr = getTopupMethodLabel(req.method, req.network, lang);
    const statusStr = getTopupStatusBadge(req.status, lang);
    const dateStr = formatDateMSK(req.createdAt) || new Date(req.createdAt).toLocaleDateString('ru-RU');
    const amountUSDT = req.amount ? req.amount.toFixed(2) : '0.00';
    const amountRUB = req.amountRub ? ` (~${req.amountRub} ₽)` : '';

    text += `<b>${num}.</b> ${methodStr} — <b>${amountUSDT} USDT</b>${amountRUB}\n` +
      `   ${lang === 'en' ? 'Status' : 'Статус'}: ${statusStr} | 📅 ${dateStr}\n\n`;

    buttons.push([Markup.button.callback(
      `🔍 #${num} ${methodStr} (${amountUSDT} USDT)`,
      `profile:topup:detail:${req._id}`
    )]);
  });

  // Пагинация
  const navRow = [];
  if (page > 1) {
    navRow.push(Markup.button.callback('⬅️ Назад', `profile:topups:page:${page - 1}`));
  }
  navRow.push(Markup.button.callback(`📄 ${page}/${totalPages}`, 'profile:noop'));
  if (page < totalPages) {
    navRow.push(Markup.button.callback('Вперёд ➡️', `profile:topups:page:${page + 1}`));
  }
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    Markup.button.callback(lang === 'en' ? '➕ Top Up Balance' : '➕ Пополнить баланс', 'menu:topup'),
    Markup.button.callback(t('btn_back'), 'menu:profile'),
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// Детальный просмотр заявки на пополнение
const showTopupDetail = async (ctx, requestId) => {
  const user = ctx.user;
  const lang = user?.language || 'ru';
  const t = ctx.t || ((k) => k);

  const request = await TopupRequest.findOne({ _id: requestId, userId: user._id }).lean();
  if (!request) {
    return ctx.answerCbQuery(lang === 'en' ? '❌ Top-up not found' : '❌ Заявка не найдена', { show_alert: true });
  }

  const methodStr = getTopupMethodLabel(request.method, request.network, lang);
  const statusStr = getTopupStatusBadge(request.status, lang);
  const createdStr = formatDateTimeMSK(request.createdAt) || new Date(request.createdAt).toLocaleString('ru-RU');
  const processedStr = request.processedAt
    ? (formatDateTimeMSK(request.processedAt) || new Date(request.processedAt).toLocaleString('ru-RU'))
    : null;

  const amountUSDT = request.amount ? request.amount.toFixed(2) : '0.00';
  const amountRUB = request.amountRub ? `${request.amountRub} ₽` : (request.amount ? `~${toRub(request.amount)} ₽` : '-');

  let text = `💳 <b>${lang === 'en' ? 'Top-up Request Details' : 'Детали заявки на пополнение'}</b>\n\n` +
    `<blockquote>` +
    `📋 ID: <code>${request._id}</code>\n` +
    `💳 ${lang === 'en' ? 'Method' : 'Способ'}: <b>${methodStr}</b>\n` +
    `💰 ${lang === 'en' ? 'Amount' : 'Сумма'}: <b>${amountUSDT} USDT</b> (${amountRUB})\n` +
    `📊 ${lang === 'en' ? 'Status' : 'Статус'}: <b>${statusStr}</b>\n` +
    `📅 ${lang === 'en' ? 'Created' : 'Создана'}: ${createdStr}\n`;

  if (processedStr) {
    text += `⏱ ${lang === 'en' ? 'Processed' : 'Обработана'}: ${processedStr}\n`;
  }

  if (request.txid) {
    text += `🔗 TXID / Хэш: <code>${escapeHtml(request.txid)}</code>\n`;
  }

  if (request.notes) {
    text += `💬 ${lang === 'en' ? 'Note' : 'Примечание'}: <i>${escapeHtml(request.notes)}</i>\n`;
  }

  text += `</blockquote>`;

  const buttons = [
    [Markup.button.callback(lang === 'en' ? '⬅️ Back to History' : '⬅️ К истории пополнений', 'profile:topups')],
    [Markup.button.callback(t('btn_back'), 'menu:profile')],
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

module.exports = {
  showProfile,
  showLanguageSelect,
  showOrders,
  showOrderDetail,
  showTopupHistory,
  showTopupDetail,
  showAchievements,
  cancelPreorder,
  toggleBtnStyle,
};

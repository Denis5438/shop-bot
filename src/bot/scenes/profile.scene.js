const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const { toRub } = require('../../services/currency.service');
const { ORDER_STATUS_LABELS } = require('../constants/ux');
const { escapeHtml } = require('../utils/ui');
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
    ? (lang === 'en' ? '🎨 Button Theme: 🔘 Classic' : '🎨 Стиль кнопок: 🔘 Прозрачные')
    : (lang === 'en' ? '🎨 Button Theme: 🟢 Colored' : '🎨 Стиль кнопок: 🟢 Цветные');

  const buttons = [];
  if (activeOrder) {
    buttons.push([Markup.button.callback(
      t('profile_continue_activation'),
      `profile:continue_order:${activeOrder._id}`
    )]);
  }
  buttons.push([Markup.button.callback(t('btn_orders'), 'profile:orders')]);
  buttons.push([Markup.button.callback('🎟 Активировать промокод', 'user:activate_promo')]);
  buttons.push([Markup.button.callback(t('profile_achievements_btn'), 'profile:achievements')]);
  buttons.push([Markup.button.callback(btnStyleLabel, 'profile:toggle_btn_style')]);
  buttons.push([Markup.button.callback(t('btn_back'), 'menu:main')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
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

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
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

    try {
      return await ctx.editMessageText(emptyMsg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
    } catch (_) {
      return await ctx.reply(emptyMsg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
    }
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

  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
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

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
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
  if (order.status === 'completed') {
    if (isWarrantyActive) {
      const diffMs = warrantyExpiresAt.getTime() - now.getTime();
      const daysLeft = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      warrantyStr = `🛡 <b>Гарантия:</b> 🟢 Активна (осталось ${daysLeft} дн. из ${warrantyDays})`;
    } else {
      warrantyStr = `🛡 <b>Гарантия:</b> 🔴 Истёкла (${warrantyDays} дн.)`;
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
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
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

module.exports = {
  showProfile,
  showLanguageSelect,
  showOrders,
  showOrderDetail,
  showAchievements,
  cancelPreorder,
  toggleBtnStyle,
};

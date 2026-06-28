const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const { toRub } = require('../../services/currency.service');
const { mainKeyboard } = require('../keyboards/main.keyboard');
const { ORDER_STATUS_LABELS } = require('../constants/ux');
const { escapeHtml } = require('../utils/ui');
const { getAllWithProgress, renderAchievementsText } = require('../../services/achievements.service');

const PER_PAGE = 5;
const ACTIVE_STATUSES = ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'];

// Уровень пользователя по сумме потраченного.
// Возвращает { emoji, labelKey } — вызывающий код использует ctx.t(labelKey)
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
  // Если перевод не найден (не добавлен новый статус в локаль) — fallback на RU-мапку.
  return localized && localized !== key ? localized : (ORDER_STATUS_LABELS[status] || status);
};

// Показ профиля пользователя
const showProfile = async (ctx) => {
  const user = ctx.user;

  const ordersCount = await Order.countDocuments({ userId: user._id });
  const createdAt = new Date(user.createdAt).toLocaleDateString('ru-RU');
  const level = getLevel(user.totalSpent);

  // Проверяем незавершённый заказ (awaiting_token)
  const activeOrder = await Order.findOne({ userId: user._id, status: 'awaiting_token' })
    .populate('productId');

  const t = ctx.t || ((k) => k);
  const levelLabel = t(level.labelKey).replace(/^[^\s]+\s/, ''); // убираем эмодзи в начале для подписи

  let bannerText = '';
  if (activeOrder) {
    const icon = activeOrder.productId?.icon || '📦';
    const name = activeOrder.productId?.name || 'Товар';
    bannerText = `<blockquote>${t('profile_banner_unfinished', { icon, name })}</blockquote>\n\n`;
  }

  const text =
    `👤 <b>Мой профиль</b>\n\n` +
    bannerText +
    `<blockquote>${level.emoji} ${t('profile_level')}: <b>${levelLabel}</b>\n\n` +
    `🆔 ${t('profile_id')}: <code>${user.telegramId}</code>\n` +
    `📛 ${t('profile_name')}: ${escapeHtml(user.firstName)}${user.lastName ? ' ' + escapeHtml(user.lastName) : ''}\n\n` +
    `💰 ${t('profile_balance')}: <b>${user.balance.toFixed(2)} USDT</b>  (~${toRub(user.balance)} ₽)\n` +
    `📦 ${t('profile_orders')}: ${ordersCount}\n` +
    `💸 ${t('profile_spent')}: ${user.totalSpent.toFixed(2)} USDT\n\n` +
    `🔗 ${t('profile_ref_code')}: <code>${escapeHtml(user.referralCode)}</code>\n` +
    `📅 ${t('profile_joined')}: ${createdAt}</blockquote>`;

  const buttons = [];
  if (activeOrder) {
    buttons.push([Markup.button.callback(
      t('profile_continue_activation'),
      `profile:continue_order:${activeOrder._id}`
    )]);
  }
  buttons.push([Markup.button.callback(t('btn_orders'), 'profile:orders')]);
  buttons.push([Markup.button.callback(t('profile_achievements_btn'), 'profile:achievements')]);
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

  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * PER_PAGE)
    .limit(PER_PAGE)
    .populate('productId');

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
    text += `<blockquote>${escapeHtml(order.productId?.icon || '📦')} <b>${escapeHtml(order.productId?.name || 'Товар удалён')}</b>\n`;
    text += `   ${status}  ·  ${order.price} USDT  ·  ${date}\n`;
    text += `   <code>${order._id}</code></blockquote>\n\n`;
  }

  // Кнопки фильтра
  const buttons = [];
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
  const items = await getAllWithProgress(ctx.user._id);
  const text = renderAchievementsText(items);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(t('profile_back_to_profile'), 'menu:profile')],
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
};

module.exports = { showProfile, showLanguageSelect, showOrders, showAchievements };

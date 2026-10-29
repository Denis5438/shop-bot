const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const User = require('../../models/User');
const TopupRequest = require('../../models/TopupRequest');
const { toRub } = require('../../services/currency.service');
const { ORDER_STATUS_LABELS } = require('../constants/ux');
const { escapeHtml, formatDateTimeMSK, formatDateMSK, safeEdit, safeEditRich, isRichActive, toRichHtmlText, has2FASecret, get2FAButtonLabel } = require('../utils/ui');
const { getSettings } = require('../../services/settingsCache.service');
const { getAllWithProgress, renderAchievementsText } = require('../../services/achievements.service');

const PER_PAGE = 5;
const ACTIVE_STATUSES = ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry', 'preorder_pending'];

const STATUS_EMOJIS = {
  preorder_pending:      '⏳',
  pending:               '⏳',
  awaiting_token:        '🔑',
  awaiting_confirmation: '👁',
  activating:            '⚙️',
  completed:             '✅',
  cancelled:             '❌',
  failed:                '💔',
  retry:                 '🔄',
  disputed:              '⚖️',
};

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

const buildProfileRichHtml = ({
  text,
  activeOrder = null,
  btnStyleLabel,
  layoutLabel,
  isColored = true,
  t = (k) => k,
  lang = 'ru',
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  if (activeOrder) {
    const activeLabel = t('profile_continue_activation') || (lang === 'en' ? '▶️ Continue activation' : '▶️ Продолжить активацию');
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="success" data="profile:continue_order:${activeOrder._id}">${escapeHtml(activeLabel)}</tg-button></tg-button-row>\n`;
  }

  const ordersLabel = t('btn_orders') || (lang === 'en' ? '📦 My Orders' : '📦 Мои покупки');
  const topupsLabel = lang === 'en' ? '💳 Top-up History' : '💳 История пополнений';
  const mainStyle = isColored ? 'primary' : 'link';

  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:orders">${escapeHtml(ordersLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:topups">${escapeHtml(topupsLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  const promoLabel = lang === 'en' ? '🎟 Promo Code' : '🎟 Промокод';
  const refLabel = t('btn_referral') || (lang === 'en' ? '👥 Referrals' : '👥 Рефералы');
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="${mainStyle}" data="user:activate_promo">${escapeHtml(promoLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:referral">${escapeHtml(refLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  const achLabel = t('profile_achievements_btn') || (lang === 'en' ? '🏆 Achievements' : '🏆 Достижения');
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:achievements">${escapeHtml(achLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:toggle_btn_style">${escapeHtml(btnStyleLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  const backLabel = t('btn_back') || (lang === 'en' ? '⬅️ Main Menu' : '⬅️ Главное меню');
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="${mainStyle}" data="profile:toggle_btn_layout">${escapeHtml(layoutLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="${mainStyle}" data="menu:main">${escapeHtml(backLabel)}</tg-button>` +
    `</tg-button-row>`;

  return richHtml.trim();
};

const buildOrdersRichHtml = ({
  text,
  orders = [],
  filter = 'all',
  page = 1,
  totalPages = 1,
  lang = 'ru',
  t = (k) => k,
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  if (orders.length === 0) {
    if (filter === 'active') {
      richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:orders:all:1">${escapeHtml(t('orders_show_all'))}</tg-button></tg-button-row>\n`;
    }
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="menu:shop">${escapeHtml(t('orders_to_shop'))}</tg-button></tg-button-row>\n`;
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu:profile">${escapeHtml(t('btn_back'))}</tg-button></tg-button-row>`;
    return richHtml.trim();
  }

  // 1. Детали каждого заказа
  for (const o of orders) {
    const rawName = (lang === 'en' && o.productId?.nameEn ? o.productId.nameEn : o.productId?.name) || (lang === 'en' ? 'Deleted item' : 'Товар удалён');
    const statusEmoji = STATUS_EMOJIS[o.status] || '📦';
    const trimmedName = rawName.length > 18 ? rawName.slice(0, 17) + '…' : rawName;
    const btnLabel = `🧾 ${trimmedName} · ${o.price} USDT · ${statusEmoji}`;
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:order:detail:${o._id}">${escapeHtml(btnLabel)}</tg-button></tg-button-row>\n`;
  }

  // 2. Вкладки фильтра
  const allLabel = filter === 'all' ? t('orders_tab_all') : '📋 ' + t('orders_tab_all').replace('☑️ ', '');
  const activeLabel = filter === 'active' ? t('orders_tab_active') : '📋 ' + t('orders_tab_active').replace('🔄 ', '');
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="${filter === 'all' ? 'success' : 'primary'}" data="profile:orders:all:1">${escapeHtml(allLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="${filter === 'active' ? 'success' : 'primary'}" data="profile:orders:active:1">${escapeHtml(activeLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  // 3. Пагинация
  if (totalPages > 1) {
    let navBtns = '';
    if (page > 1) {
      navBtns += `<tg-button type="callback_data" style="primary" data="profile:orders:${filter}:${page - 1}">⬅️</tg-button>`;
    }
    navBtns += `<tg-button type="callback_data" style="link" data="shop:noop">${page}/${totalPages}</tg-button>`;
    if (page < totalPages) {
      navBtns += `<tg-button type="callback_data" style="primary" data="profile:orders:${filter}:${page + 1}">➡️</tg-button>`;
    }
    richHtml += `<tg-button-row align="center">${navBtns}</tg-button-row>\n`;
  }

  // 4. Назад
  richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu:profile">${escapeHtml(t('btn_back'))}</tg-button></tg-button-row>`;

  return richHtml.trim();
};

const buildOrderDetailRichHtml = ({
  text,
  order,
  itemValue,
  isCompleted,
  isWarrantyActive,
  lang = 'ru',
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  // 1. 2FA кнопка
  if (itemValue && has2FASecret(itemValue)) {
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="success" data="profile:order:2fa:${order._id}">${escapeHtml(get2FAButtonLabel(lang))}</tg-button></tg-button-row>\n`;
  }

  // 2. Отправка данных в чат
  if (isCompleted && itemValue) {
    const sendDataLabel = lang === 'en' ? '📨 Send data to chat' : '📨 Прислать данные в чат';
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:order:send_data:${order._id}">${escapeHtml(sendDataLabel)}</tg-button></tg-button-row>\n`;
  }

  // 3. Действия покупателя escrow
  if (order.status === 'awaiting_confirmation' && order.sellerId) {
    const confirmLabel = lang === 'en' ? '✅ Confirm receipt (Everything works)' : '✅ Подтвердить получение (Всё работает)';
    const disputeLabel = lang === 'en' ? '⚠️ Open dispute (Problem with product)' : '⚠️ Открыть спор (Проблема с товаром)';
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="success" data="buyer:confirm_order:${order._id}">${escapeHtml(confirmLabel)}</tg-button></tg-button-row>\n`;
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="buyer:dispute_order:${order._id}">${escapeHtml(disputeLabel)}</tg-button></tg-button-row>\n`;
  }

  // 4. Отмена предзаказа
  if (order.status === 'preorder_pending') {
    const cancelLabel = lang === 'en' ? '❌ Cancel pre-order (refund)' : '❌ Отменить предзаказ (вернуть деньги)';
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="danger" data="profile:cancel_preorder:${order._id}">${escapeHtml(cancelLabel)}</tg-button></tg-button-row>\n`;
  }

  // 5. Замена по гарантии
  if (isWarrantyActive && order.replacementStatus === 'none') {
    const claimLabel = lang === 'en' ? '🔄 Request warranty replacement' : '🔄 Запросить замену по гарантии';
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:warranty:claim:${order._id}">${escapeHtml(claimLabel)}</tg-button></tg-button-row>\n`;
  }

  // 6. Назад к заказам
  const backLabel = lang === 'en' ? '⬅️ To orders' : '⬅️ К заказам';
  richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="link" data="profile:orders:all:1">${escapeHtml(backLabel)}</tg-button></tg-button-row>`;

  return richHtml.trim();
};

// Показ профиля пользователя
const showProfile = async (ctx) => {
  const user = ctx.user;

  // Все запросы параллельно
  const [ordersCount, activeOrder, referralsCount] = await Promise.all([
    Order.countDocuments({ userId: user._id }),
    // Незавершённый заказ (awaiting_token)
    Order.findOne({ userId: user._id, status: 'awaiting_token' })
      .populate('productId', 'name icon')
      .lean(),
    User.countDocuments({ referredBy: user._id }),
  ]);
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const createdAt = new Date(user.createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU');
  const level = getLevel(user.totalSpent);
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
    `<blockquote>${level.emoji} ${t('profile_level')}: <b>${levelLabel}</b>\n` +
    `🆔 ${t('profile_id')}: <code>${user.telegramId}</code>\n` +
    `👑 ${t('profile_name')}: <b>${escapeHtml(user.firstName)}${user.lastName ? ' ' + escapeHtml(user.lastName) : ''}</b></blockquote>\n\n` +
    `<blockquote>💰 ${t('profile_balance')}: <b>${user.balance.toFixed(2)} USDT</b> (~${toRub(user.balance)} ₽)\n` +
    `📦 ${t('profile_orders')}: <b>${ordersCount}</b>\n` +
    `💸 ${t('profile_spent')}: <b>${user.totalSpent.toFixed(2)} USDT</b></blockquote>\n\n` +
    `<blockquote>🔗 ${t('profile_ref_code')}: <code>${escapeHtml(user.referralCode)}</code>\n` +
    `👥 ${lang === 'en' ? 'Invited friends' : 'Приглашено друзей'}: <b>${referralsCount}</b>\n` +
    `📅 ${t('profile_joined')}: ${createdAt}</blockquote>`;

  const settings = await getSettings();
  const globalMode = settings?.globalButtonsMode || 'by_user';
  const isLocked = globalMode === 'force_rich' || globalMode === 'force_classic';

  const btnStyleLabel = user.btnStyle === 'classic'
    ? (lang === 'en' ? '🎨 Theme: 🔘 Classic' : '🎨 Цвет: 🔘 Прозрачные')
    : (lang === 'en' ? '🎨 Theme: 🟢 Colored' : '🎨 Цвет: 🟢 Цветные');

  let layoutLabel;
  if (isLocked) {
    layoutLabel = lang === 'en' ? '📱 Buttons: 🔒 Locked' : '📱 Кнопки: 🔒 Зафиксировано';
  } else {
    layoutLabel = user.buttonLayout === 'classic'
      ? (lang === 'en' ? '📱 Buttons: 🔘 Bottom (Classic)' : '📱 Кнопки: 🔘 Снизу (Классика)')
      : (lang === 'en' ? '📱 Buttons: 🟢 In text (New)' : '📱 Кнопки: 🟢 В тексте (Новые)');
  }

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
    Markup.button.callback(t('btn_referral'), 'profile:referral'),
  ]);
  buttons.push([
    Markup.button.callback(t('profile_achievements_btn'), 'profile:achievements'),
    Markup.button.callback(btnStyleLabel, 'profile:toggle_btn_style'),
  ]);
  buttons.push([
    Markup.button.callback(layoutLabel, 'profile:toggle_btn_layout'),
    Markup.button.callback(t('btn_back'), 'menu:main'),
  ]);

  const isRich = isRichActive(ctx, settings);
  const richHtml = buildProfileRichHtml({
    text,
    activeOrder,
    btnStyleLabel,
    layoutLabel,
    isColored: user.btnStyle !== 'classic',
    t,
    lang,
  });

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
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

    const settings = await getSettings();
    const isRich = isRichActive(ctx, settings);
    const richHtml = buildOrdersRichHtml({
      text: emptyMsg,
      orders: [],
      filter,
      page: 1,
      totalPages: 1,
      lang: ctx.user?.language || 'ru',
      t,
    });

    return await safeEditRich(ctx, {
      richHtml,
      classicText: emptyMsg,
      classicKeyboard: emptyButtons,
      isRich,
    });
  }

  const lang = ctx.user?.language || 'ru';
  let text = `${filterLabel}  ·  ${t('orders_page')} ${page}/${totalPages}\n\n`;
  for (const order of orders) {
    const date = new Date(order.createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU');
    const status = localizedOrderStatus(ctx, order.status);
    const rawName = (lang === 'en' && order.productId?.nameEn ? order.productId.nameEn : order.productId?.name) || (lang === 'en' ? 'Deleted item' : 'Товар удалён');
    const productName = escapeHtml(rawName);
    const qtyText = order.qty > 1 ? ` (x${order.qty})` : '';
    text += `<blockquote>${escapeHtml(order.productId?.icon || '📦')} <b>${productName}${qtyText}</b>\n`;
    text += `   ${status}  ·  ${order.price} USDT  ·  ${date}\n`;
    text += `   <code>${order._id}</code></blockquote>\n\n`;
  }
  const detailBtns = orders.map((o) => {
    const rawName = (lang === 'en' && o.productId?.nameEn ? o.productId.nameEn : o.productId?.name) || (lang === 'en' ? 'Deleted item' : 'Товар удалён');
    const statusEmoji = STATUS_EMOJIS[o.status] || '📦';
    const trimmedName = rawName.length > 18 ? rawName.slice(0, 17) + '…' : rawName;
    const btnLabel = `🧾 ${trimmedName} · ${o.price} USDT · ${statusEmoji}`;
    return [Markup.button.callback(btnLabel, `profile:order:detail:${o._id}`)];
  });

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

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = buildOrdersRichHtml({
    text,
    orders,
    filter,
    page,
    totalPages,
    lang,
    t,
  });

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
};

// №20 Достижения: отдельный экран со списком ачивок + прогрессом
const showAchievements = async (ctx) => {
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const items = await getAllWithProgress(ctx.user._id);
  const text = renderAchievementsText(items, lang);

  const backLabel = t('profile_back_to_profile') || (lang === 'en' ? '⬅️ Back to profile' : '⬅️ Назад в профиль');
  const keyboard = [
    [Markup.button.callback(backLabel, 'menu:profile')],
  ];

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = `${toRichHtmlText(text)}<br><br><tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu:profile">${escapeHtml(backLabel)}</tg-button></tg-button-row>`;

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: keyboard,
    isRich,
  });
};

const showOrderDetail = async (ctx, orderId) => {
  const mongoose = require('mongoose');
  const lang = ctx.user?.language || 'ru';

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
  }

  let order = await Order.findById(orderId)
    .populate('productId')
    .populate('keyId')
    .populate('replacedKeyId');

  if (!order || !ctx.user?._id || order.userId.toString() !== ctx.user._id.toString()) {
    return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
  }

  let product = order.productId;
  const { resolveOrderProvider } = require('../../services/provider.service');
  const provider = resolveOrderProvider(order, product);
  const isSupplier = ['jaha', 'akunding', 'canboso', 'trumpstore'].includes(provider);

  if (isSupplier && order.supplierOrderId && ['pending', 'activating', 'retry'].includes(order.status)) {
    try {
      const supplierManager = require('../../services/supplierManager.service');
      const suppRes = await supplierManager.getSupplierOrder(provider, order.supplierOrderId);
      if (suppRes && suppRes.success && suppRes.deliveryData) {
        const completed = await Order.findOneAndUpdate(
          { _id: order._id, status: { $in: ['pending', 'activating', 'retry'] } },
          {
            $set: {
              status: 'completed',
              confirmedAt: order.confirmedAt || new Date(),
              deliveryData: String(suppRes.deliveryData),
              supplierOrderId: String(suppRes.orderNumber || order.supplierOrderId),
              activationResult: 'Автовыдача через API поставщика (проверка статуса) ⚡',
              nextRetryAt: null,
            },
          },
          { new: true }
        ).populate('productId').populate('keyId').populate('replacedKeyId');

        if (completed) {
          order = completed;
          product = order.productId;
          if (ctx.user?._id) {
            const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
            await grantReferralBonusForFirstCompletedOrder(ctx.user._id).catch(() => {});
          }
        }
      }
    } catch (_) {}
  }
  const productName = escapeHtml(
    (lang === 'en' && product?.nameEn ? product.nameEn : product?.name) ||
    (lang === 'en' ? 'Product' : 'Товар')
  );
  const date = new Date(order.createdAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU');
  const statusLbl = localizedOrderStatus(ctx, order.status);

  const warrantyDays = order.warrantyDays ?? product?.warrantyDays ?? 5;
  const confirmedBase = order.confirmedAt || order.createdAt;
  const warrantyExpiresAt = new Date(confirmedBase.getTime() + warrantyDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  const isWarrantyActive = now < warrantyExpiresAt && order.status === 'completed';

  let warrantyStr = '';
  if (order.status === 'completed' && warrantyDays > 0) {
    const warrantyTitle = lang === 'en' ? 'Warranty' : 'Гарантия';
    if (warrantyDays < 1) {
      const totalHours = Math.round(warrantyDays * 24);
      if (isWarrantyActive) {
        const diffMs = warrantyExpiresAt.getTime() - now.getTime();
        const hoursLeft = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60)));
        warrantyStr = `🛡 <b>${warrantyTitle}:</b> ${lang === 'en' ? `Active (${hoursLeft} of ${totalHours} hours left)` : `Активна (осталось ${hoursLeft} ч. из ${totalHours} ч.)`}`;
      } else {
        warrantyStr = `🛡 <b>${warrantyTitle}:</b> ${lang === 'en' ? `Expired (${totalHours} hours)` : `Истёкла (${totalHours} ч.)`}`;
      }
    } else {
      if (isWarrantyActive) {
        const diffMs = warrantyExpiresAt.getTime() - now.getTime();
        const daysLeft = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
        warrantyStr = `🛡 <b>${warrantyTitle}:</b> ${lang === 'en' ? `Active (${daysLeft} of ${warrantyDays} days left)` : `Активна (осталось ${daysLeft} дн. из ${warrantyDays})`}`;
      } else {
        warrantyStr = `🛡 <b>${warrantyTitle}:</b> ${lang === 'en' ? `Expired (${warrantyDays} days)` : `Истёкла (${warrantyDays} дн.)`}`;
      }
    }
  }

  const subscriptionDays = order.subscriptionDays ?? product?.subscriptionDays ?? 0;
  let subscriptionStr = '';
  if (order.status === 'completed' && subscriptionDays > 0) {
    const subscriptionTitle = lang === 'en' ? 'Subscription' : 'Подписка';
    const subscriptionExpiresAt = new Date(confirmedBase.getTime() + subscriptionDays * 24 * 60 * 60 * 1000);
    const isSubActive = now < subscriptionExpiresAt;
    const untilDate = subscriptionExpiresAt.toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU');
    if (isSubActive) {
      const subDiffMs = subscriptionExpiresAt.getTime() - now.getTime();
      const subDaysLeft = Math.max(1, Math.ceil(subDiffMs / (1000 * 60 * 60 * 24)));
      subscriptionStr = `⏳ <b>${subscriptionTitle}:</b> ${lang === 'en' ? `Active (${subDaysLeft} of ${subscriptionDays} days left, until ${untilDate})` : `Активна (осталось ${subDaysLeft} дн. из ${subscriptionDays}, до ${untilDate})`}`;
    } else {
      subscriptionStr = `⏳ <b>${subscriptionTitle}:</b> ${lang === 'en' ? `Expired (${subscriptionDays} days)` : `Истёкла (${subscriptionDays} дн.)`}`;
    }
  }

  let replacementStr = '';
  const repTitle = lang === 'en' ? 'Replacement status' : 'Статус замены';
  if (order.replacementStatus === 'pending') {
    replacementStr = `\n⏳ <b>${repTitle}:</b> ${lang === 'en' ? 'Under moderator review' : 'На рассмотрении модератором'}`;
  } else if (order.replacementStatus === 'approved') {
    replacementStr = `\n✅ <b>${repTitle}:</b> ${lang === 'en' ? 'Request approved (new account issued)' : 'Заявка одобрена (новый аккаунт выдан)'}`;
  } else if (order.replacementStatus === 'rejected') {
    const reason = order.replacementRejectReason ? ` (${escapeHtml(order.replacementRejectReason)})` : '';
    replacementStr = `\n❌ <b>${repTitle}:</b> ${lang === 'en' ? 'Rejected' : 'Отклонена'}${reason}`;
  }

  let issuedDataStr = '';
  const itemValue = order.replacedKeyId?.value || order.deliveryData || order.keyId?.value;
  const isCompleted = order.status === 'completed';

  if (itemValue) {
    const { formatDigitalItem } = require('../utils/ui');
    const formattedData = formatDigitalItem(itemValue, lang);

    if (isCompleted) {
      const dataHeader = lang === 'en' ? '🔐 <b>Account access details:</b>' : '🔐 <b>Данные для доступа к аккаунту:</b>';
      const fullHeader = lang === 'en' ? '📋 <b>Full credentials (tap to copy all):</b>' : '📋 <b>Вся связка (нажмите для копирования целиком):</b>';
      const copyTip = lang === 'en'
        ? '💡 <i>Tap any field above to copy it, or tap the block below to copy full credentials.</i>'
        : '💡 <i>Нажмите на нужное поле выше для копирования или на блок ниже, чтобы скопировать всю связку целиком.</i>';

      const maxPreLen = 1500;
      const safeCopyVal = itemValue.length > maxPreLen ? `${itemValue.slice(0, maxPreLen)}...` : itemValue;

      issuedDataStr =
        `\n\n${dataHeader}\n` +
        `${formattedData}\n\n` +
        `${fullHeader}\n` +
        `<pre><code>${escapeHtml(safeCopyVal)}</code></pre>\n` +
        `${copyTip}`;
    } else {
      const genericHeader = lang === 'en' ? '📦 <b>Issued data:</b>' : '📦 <b>Выданные данные товара:</b>';
      issuedDataStr = `\n\n${genericHeader}\n${formattedData}`;
    }
  }

  const orderTitle = lang === 'en' ? 'Order Details' : 'Детали заказа';
  const itemLabel = lang === 'en' ? 'Product' : 'Товар';
  const sumLabel = lang === 'en' ? 'Amount' : 'Сумма';
  const dateLabel = lang === 'en' ? 'Date' : 'Дата';
  const statusLabel = lang === 'en' ? 'Status' : 'Статус';

  const text =
    `📋 <b>${orderTitle}</b> <code>${order._id}</code>\n\n` +
    `📦 <b>${itemLabel}:</b> ${escapeHtml(product?.icon || '📦')} ${productName}\n` +
    `💰 <b>${sumLabel}:</b> ${order.price} USDT\n` +
    `📅 <b>${dateLabel}:</b> ${date}\n` +
    `🔘 <b>${statusLabel}:</b> ${statusLbl}\n` +
    (warrantyStr ? `${warrantyStr}\n` : '') +
    (subscriptionStr ? `${subscriptionStr}\n` : '') +
    replacementStr +
    issuedDataStr;

  const buttons = [];
  const { has2FASecret, get2FAButtonLabel } = require('../utils/ui');

  // Кнопка получения 6-значного кода 2FA (только если в выданных данных есть валидный ключ 2FA)
  if (itemValue && has2FASecret(itemValue)) {
    buttons.push([
      Markup.button.callback(
        get2FAButtonLabel(lang),
        `profile:order:2fa:${order._id}`
      ),
    ]);
  }

  // Кнопка "Прислать данные в чат" для выполненных заказов с выданными данными
  if (isCompleted && itemValue) {
    buttons.push([
      Markup.button.callback(
        lang === 'en' ? '📨 Send data to chat' : '📨 Прислать данные в чат',
        `profile:order:send_data:${order._id}`
      ),
    ]);
  }

  if (order.status === 'awaiting_confirmation' && order.sellerId) {
    buttons.push([
      Markup.button.callback(
        lang === 'en' ? '✅ Confirm receipt (Everything works)' : '✅ Подтвердить получение (Всё работает)',
        `buyer:confirm_order:${order._id}`
      ),
    ]);
    buttons.push([
      Markup.button.callback(
        lang === 'en' ? '⚠️ Open dispute (Problem with product)' : '⚠️ Открыть спор (Проблема с товаром)',
        `buyer:dispute_order:${order._id}`
      ),
    ]);
  }

  if (order.status === 'preorder_pending') {
    buttons.push([Markup.button.callback(lang === 'en' ? '❌ Cancel pre-order (refund)' : '❌ Отменить предзаказ (вернуть деньги)', `profile:cancel_preorder:${order._id}`)]);
  }

  if (isWarrantyActive && order.replacementStatus === 'none') {
    buttons.push([Markup.button.callback(lang === 'en' ? '🔄 Request warranty replacement' : '🔄 Запросить замену по гарантии', `profile:warranty:claim:${order._id}`)]);
  }

  if (['pending', 'activating', 'retry'].includes(order.status)) {
    buttons.push([
      Markup.button.callback(
        lang === 'en' ? '🔄 Refresh status' : '🔄 Обновить статус',
        `profile:order:detail:${order._id}`
      ),
    ]);
  }

  buttons.push([Markup.button.callback(lang === 'en' ? '⬅️ To orders' : '⬅️ К заказам', 'profile:orders:all:1')]);

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = buildOrderDetailRichHtml({
    text,
    order,
    itemValue,
    isCompleted,
    isWarrantyActive,
    lang,
  });

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
};

const showOrder2FA = async (ctx, orderId) => {
  const mongoose = require('mongoose');
  const lang = ctx.user?.language || 'ru';

  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
  }

  const order = await Order.findById(orderId)
    .populate('productId')
    .populate('keyId')
    .populate('replacedKeyId');

  const orderUserId = order?.userId?._id ? order.userId._id.toString() : order?.userId?.toString();
  if (!order || !ctx.user?._id || orderUserId !== ctx.user._id.toString()) {
    return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
  }

  const itemValue = order.replacedKeyId?.value || order.deliveryData || order.keyId?.value;
  const { extract2FAAccounts, format2FACodeMessage } = require('../utils/ui');
  const accounts = extract2FAAccounts(itemValue);

  if (!accounts.length) {
    return ctx.answerCbQuery(
      lang === 'en' ? '❌ 2FA key is not available for this order' : '❌ Ключ 2FA для этого заказа отсутствует',
      { show_alert: true }
    );
  }

  const text = format2FACodeMessage(accounts, lang);
  const refreshLabel = lang === 'en' ? '🔄 Refresh 6-digit code' : '🔄 Обновить 6-значный код';
  const backOrderLabel = lang === 'en' ? '📋 Back to order' : '📋 К заказу';
  const buttons = [
    [
      Markup.button.callback(
        refreshLabel,
        `profile:order:2fa_refresh:${order._id}`
      ),
    ],
    [
      Markup.button.callback(
        backOrderLabel,
        `profile:order:${order._id}`
      ),
    ],
  ];

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = `${toRichHtmlText(text)}<br><br>` +
    `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:order:2fa_refresh:${order._id}">${escapeHtml(refreshLabel)}</tg-button></tg-button-row>\n` +
    `<tg-button-row align="center"><tg-button type="callback_data" style="link" data="profile:order:${order._id}">${escapeHtml(backOrderLabel)}</tg-button></tg-button-row>`;

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
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

const toggleBtnLayout = async (ctx) => {
  const settings = await getSettings();
  const globalMode = settings?.globalButtonsMode || 'by_user';
  const lang = ctx.user?.language || 'ru';

  if (globalMode === 'force_rich' || globalMode === 'force_classic') {
    const alertMsg = lang === 'en'
      ? '⚠️ Button layout is locked by shop administrator'
      : '⚠️ Формат кнопок зафиксирован администратором магазина';
    return ctx.answerCbQuery(alertMsg, { show_alert: true });
  }

  if (ctx.user) {
    const nextLayout = ctx.user.buttonLayout === 'classic' ? 'rich' : 'classic';
    ctx.user.buttonLayout = nextLayout;
    await User.updateOne({ _id: ctx.user._id }, { $set: { buttonLayout: nextLayout } });
    const alertMsg = nextLayout === 'classic'
      ? (lang === 'en' ? '🔘 Button layout: Below message (Classic)' : '🔘 Формат кнопок: Снизу сообщения (Классика)')
      : (lang === 'en' ? '🟢 Button layout: Inside message (New)' : '🟢 Формат кнопок: Внутри сообщения (Новые)');
    await ctx.answerCbQuery(alertMsg, { show_alert: true }).catch(() => {});
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

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = buildTopupHistoryRichHtml({
    text,
    requests,
    page,
    totalPages,
    lang,
    t,
  });

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
};

const buildTopupHistoryRichHtml = ({
  text,
  requests = [],
  page = 1,
  totalPages = 1,
  lang = 'ru',
  t = (k) => k,
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  requests.forEach((req, idx) => {
    const num = (page - 1) * TOPUPS_PER_PAGE + idx + 1;
    const methodStr = getTopupMethodLabel(req.method, req.network, lang);
    const amountUSDT = req.amount ? req.amount.toFixed(2) : '0.00';
    const label = `🔍 #${num} ${methodStr} (${amountUSDT} USDT)`;
    richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:topup:detail:${req._id}">${escapeHtml(label)}</tg-button></tg-button-row>\n`;
  });

  if (totalPages > 1) {
    let navBtns = '';
    if (page > 1) {
      navBtns += `<tg-button type="callback_data" style="primary" data="profile:topups:page:${page - 1}">⬅️</tg-button>`;
    }
    navBtns += `<tg-button type="callback_data" style="link" data="profile:noop">${page}/${totalPages}</tg-button>`;
    if (page < totalPages) {
      navBtns += `<tg-button type="callback_data" style="primary" data="profile:topups:page:${page + 1}">➡️</tg-button>`;
    }
    richHtml += `<tg-button-row align="center">${navBtns}</tg-button-row>\n`;
  }

  const addTopupLabel = lang === 'en' ? '➕ Top Up Balance' : '➕ Пополнить баланс';
  const backLabel = t('btn_back') || (lang === 'en' ? '⬅️ Back' : '⬅️ Назад');
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="success" data="menu:topup">${escapeHtml(addTopupLabel)}</tg-button>` +
    `<tg-button type="callback_data" style="link" data="menu:profile">${escapeHtml(backLabel)}</tg-button>` +
    `</tg-button-row>`;

  return richHtml.trim();
};

const buildTopupDetailRichHtml = ({
  text,
  lang = 'ru',
  t = (k) => k,
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;
  const backToHistLabel = lang === 'en' ? '⬅️ Back to History' : '⬅️ К истории пополнений';
  const backLabel = t('btn_back') || (lang === 'en' ? '⬅️ Back' : '⬅️ Назад');
  richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="primary" data="profile:topups">${escapeHtml(backToHistLabel)}</tg-button></tg-button-row>\n`;
  richHtml += `<tg-button-row align="center"><tg-button type="callback_data" style="link" data="menu:profile">${escapeHtml(backLabel)}</tg-button></tg-button-row>`;
  return richHtml.trim();
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

  const settings = await getSettings();
  const isRich = isRichActive(ctx, settings);
  const richHtml = buildTopupDetailRichHtml({
    text,
    lang,
    t,
  });

  await safeEditRich(ctx, {
    richHtml,
    classicText: text,
    classicKeyboard: buttons,
    isRich,
  });
};

module.exports = {
  showProfile,
  showLanguageSelect,
  showOrders,
  showOrderDetail,
  showOrder2FA,
  showTopupHistory,
  showTopupDetail,
  showAchievements,
  cancelPreorder,
  toggleBtnStyle,
  toggleBtnLayout,
  buildProfileRichHtml,
  buildOrdersRichHtml,
  buildOrderDetailRichHtml,
  buildTopupHistoryRichHtml,
  buildTopupDetailRichHtml,
  STATUS_EMOJIS,
};

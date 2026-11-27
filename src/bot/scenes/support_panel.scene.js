const { Markup } = require('telegraf');
const mongoose = require('mongoose');
const supportService = require('../../services/support.service');
const supportNotify = require('../../services/supportNotify.service');
const { getSettings } = require('../../services/settingsCache.service');
const { isSupportOrAbove, isModeratorOrAbove, isAdminOrAbove } = require('../middlewares/auth');
const { safeEdit, escapeHtml, formatDateTimeMSK, fmtUSDT } = require('../utils/ui');
const { ORDER_STATUS_LABELS } = require('../constants/ux');
const SupportTicket = require('../../models/SupportTicket');
const User = require('../../models/User');
const logger = require('../../config/logger');

const QUEUE_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 10;
const RECENT_MESSAGES_LIMIT = 8;

const TICKET_STATUS_LABELS = {
  open: '🆕 Ожидает ответа',
  in_progress: '💬 В работе',
  escalated: '🔺 Эскалирован',
  closed: '✅ Закрыт',
};

const TICKET_STATUS_EMOJI = {
  open: '🆕',
  in_progress: '💬',
  escalated: '🔺',
  closed: '✅',
};

const ROLE_BADGES = {
  superadmin: '👑 Владелец',
  admin: '🔧 Админ',
  moderator: '🛡 Модератор',
  support: '🎧 Саппорт',
};

const SENDER_ROLE_LABELS = {
  user: '👤 Клиент',
  support: '🎧 Саппорт',
  moderator: '🛡 Модератор',
  admin: '🔧 Админ',
  superadmin: '👑 Владелец',
  system: '⚙️ Система',
};

const MEDIA_TAG_LABELS = {
  photo: '[📷 Фото]',
  document: '[📎 Документ]',
  video: '[🎥 Видео]',
};

const MAX_INPUT_TEXT_LEN = 2500;
const MAX_TELEGRAM_HTML_LEN = 3850;

const truncate = (str, maxLen) => {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
};

const clearStaleSessionActions = (ctx) => {
  if (!ctx?.session) return;
  ctx.session.userAction = null;
  ctx.session.topup = null;
  ctx.session.adminAction = null;
  ctx.session.staffAdminAction = null;
  ctx.session.step = null;
};

/**
 * Проверяет права сотрудника и безопасность группового чата поддержки.
 * В групповых чатах действия разрешены ТОЛЬКО в привязанном settings.supportChatId.
 */
const ensureSupportContextAccess = async (ctx) => {
  if (!ctx.user || !isSupportOrAbove(ctx.user)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('⛔ Нет прав', { show_alert: true }).catch(() => {});
    }
    return false;
  }

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    const settings = await getSettings();
    if (!settings?.supportChatId || Number(ctx.chat.id) !== Number(settings.supportChatId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('⛔ Нет прав', { show_alert: true }).catch(() => {});
      }
      return false;
    }
  }

  return true;
};

const formatStaffIdentity = (staffObj, fallbackTelegramId) => {
  if (staffObj && typeof staffObj === 'object') {
    if (staffObj.username) return `@${escapeHtml(staffObj.username)}`;
    if (staffObj.firstName) return `${escapeHtml(staffObj.firstName)} (<code>${staffObj.telegramId || fallbackTelegramId || '?'}</code>)`;
    if (staffObj.telegramId) return `<code>${staffObj.telegramId}</code>`;
  }
  if (fallbackTelegramId) return `<code>${fallbackTelegramId}</code>`;
  return '<i>Не назначен</i>';
};

const formatOrderBrief = (order) => {
  if (!order || typeof order !== 'object') return '';
  const productName = escapeHtml(truncate(order.productId?.name || 'Товар', 80));
  const statusLabel = ORDER_STATUS_LABELS[order.status] || escapeHtml(truncate(order.status || '—', 40));
  const priceStr = typeof order.price === 'number' ? fmtUSDT(order.price) : '—';
  const qtyStr = order.qty && order.qty > 1 ? ` ×${order.qty}` : '';
  return `${productName}${qtyStr} — ${statusLabel} (${priceStr})`;
};

const formatMessageLine = (m, maxRawLen = 280) => {
  const roleLabel = SENDER_ROLE_LABELS[m.senderRole] || '💬 Сообщение';
  const timeStr = m.createdAt ? formatDateTimeMSK(m.createdAt) : '';
  const mediaTag = m.mediaType ? `${MEDIA_TAG_LABELS[m.mediaType] || '[📎 Вложение]'} ` : '';
  const rawText = String(m.text || '').trim();
  const safeBody = rawText ? escapeHtml(truncate(rawText, maxRawLen)) : (mediaTag ? '' : '<i>(пусто)</i>');
  return `<b>${roleLabel}</b>${timeStr ? ` <i>(${timeStr})</i>` : ''}:\n${mediaTag}${safeBody}`;
};

/**
 * Безопасно собирает HTML-блок <blockquote> из списка сообщений в пределах maxBudget символов,
 * не разрезая HTML-теги и сущности (усечение происходит ДО escapeHtml).
 */
const buildSafeMessagesBlock = (msgs, maxBudget, keepLatest = true) => {
  if (!msgs.length) return '<i>Сообщений пока нет.</i>';

  const safeBudget = Math.max(250, maxBudget - 40); // запас на <blockquote></blockquote> и маркер обрезки
  const ordered = keepLatest ? [...msgs].reverse() : msgs;
  const chosen = [];
  let usedLen = 0;

  for (const m of ordered) {
    let block = formatMessageLine(m, 280);
    const separatorLen = chosen.length > 0 ? 2 : 0;
    if (usedLen + separatorLen + block.length > safeBudget) {
      if (chosen.length === 0) {
        // Даже одно сообщение длиннее бюджета — обрезаем сырой текст ДО escapeHtml
        const approxRoom = Math.max(40, Math.floor((safeBudget - 100) / 2));
        block = formatMessageLine(m, approxRoom);
        if (block.length <= safeBudget) {
          chosen.push(block);
        }
      }
      break;
    }
    chosen.push(block);
    usedLen += separatorLen + block.length;
  }

  if (keepLatest) chosen.reverse();
  const prefix = chosen.length < msgs.length ? '<i>… (часть текста скрыта по лимиту длины)</i>\n\n' : '';
  return `<blockquote>${prefix}${chosen.join('\n\n')}</blockquote>`;
};

const promptToOpenPrivateChat = async (ctx, alertText) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(alertText, { show_alert: true }).catch(() => {});
  }
  const botUsername = ctx.botInfo?.username;
  if (botUsername) {
    const kb = Markup.inlineKeyboard([
      [Markup.button.url('💬 Открыть ЛС бота', `https://t.me/${botUsername}?start=support`)],
    ]);
    await ctx.reply(escapeHtml(alertText), { parse_mode: 'HTML', ...kb }).catch(() => {});
  }
};

/**
 * Собирает текст и клавиатуру детальной карточки тикета для сотрудника.
 */
const buildTicketCardPayload = async (ticketId, staffUser) => {
  const detail = await supportService.getTicketDetail(ticketId);
  if (!detail || !detail.ticket) return null;

  const {
    ticket,
    messages = [],
    userOrdersCount = 0,
    lastOrder = null,
  } = detail;

  const settings = await getSettings();
  const quickReplies = Array.isArray(settings?.supportQuickReplies) ? settings.supportQuickReplies : [];

  const statusText = TICKET_STATUS_LABELS[ticket.status] || escapeHtml(truncate(ticket.status, 40));
  const topicText = escapeHtml(truncate(ticket.topicLabel || ticket.topic || 'Общий вопрос', 80));
  const buyerObj = ticket.userId && typeof ticket.userId === 'object' ? ticket.userId : null;
  const buyerTelegramId = ticket.telegramId || buyerObj?.telegramId || '?';
  const buyerNamePart = buyerObj?.username
    ? `@${escapeHtml(truncate(buyerObj.username, 64))}`
    : (buyerObj?.firstName ? escapeHtml(truncate(buyerObj.firstName, 64)) : 'Пользователь');

  const lines = [
    `🎫 <b>Тикет #${escapeHtml(truncate(ticket.ticketNumber || String(ticket._id), 32))}</b>`,
    `📌 <b>Статус:</b> ${statusText}${ticket.priority === 'high' ? ' 🔥' : ''}`,
    `🏷 <b>Тема:</b> ${topicText}`,
    `👨‍💻 <b>Ответственный:</b> ${formatStaffIdentity(ticket.assignedTo, ticket.assignedTelegramId)}`,
    '',
    `👤 <b>Клиент:</b> ${buyerNamePart} (ID: <code>${buyerTelegramId}</code>)`,
    `🛍 <b>Заказов клиента:</b> ${userOrdersCount}`,
  ];

  const linkedOrder = ticket.orderId && typeof ticket.orderId === 'object' && ticket.orderId._id
    ? ticket.orderId
    : null;

  if (linkedOrder) {
    lines.push(`🔗 <b>Привязанный заказ:</b> ${formatOrderBrief(linkedOrder)}`);
  } else if (ticket.orderId) {
    lines.push(`🔗 <b>Привязанный заказ:</b> <code>${escapeHtml(String(ticket.orderId))}</code>`);
  }

  if (lastOrder && (!linkedOrder || String(lastOrder._id) !== String(linkedOrder._id))) {
    lines.push(`📦 <b>Последний заказ:</b> ${formatOrderBrief(lastOrder)}`);
  }

  if (ticket.status === 'escalated' || ticket.escalationReason) {
    lines.push('');
    lines.push(`🔺 <b>Причина эскалации:</b> ${escapeHtml(truncate(ticket.escalationReason || 'Не указана', 300))}`);
  }

  if (ticket.rating) {
    lines.push(`⭐ <b>Оценка клиента:</b> ${'⭐'.repeat(ticket.rating)} (${ticket.rating}/5)`);
  }

  lines.push('');
  const recentMessages = messages.slice(-RECENT_MESSAGES_LIMIT);
  if (messages.length > RECENT_MESSAGES_LIMIT) {
    lines.push(`💬 <b>Переписка</b> <i>(последние ${recentMessages.length} из ${messages.length})</i>:`);
  } else {
    lines.push(`💬 <b>Переписка (${messages.length}):</b>`);
  }

  const headerText = lines.join('\n');
  const msgBudget = MAX_TELEGRAM_HTML_LEN - headerText.length - 1;
  const messagesBlock = buildSafeMessagesBlock(recentMessages, msgBudget, true);
  const text = `${headerText}\n${messagesBlock}`;

  const isClosed = ticket.status === 'closed';
  const isAssignedToMe = Boolean(
    ticket.assignedTelegramId &&
    staffUser?.telegramId &&
    Number(ticket.assignedTelegramId) === Number(staffUser.telegramId)
  );
  const isUnassigned = !ticket.assignedTo && !ticket.assignedTelegramId;
  const tid = String(ticket._id);

  const buttons = [];

  if (!isClosed) {
    if (isUnassigned || (ticket.status === 'escalated' && !isAssignedToMe && isModeratorOrAbove(staffUser))) {
      buttons.push([Markup.button.callback('✋ Взять в работу', `sp:take:${tid}`)]);
    }

    if (isAssignedToMe || isModeratorOrAbove(staffUser)) {
      buttons.push([Markup.button.callback('💬 Ответить (текст/фото)', `sp:rep:${tid}`)]);

      // Быстрые шаблоны ответов (по 2 в ряд, callback_data <= 64 байт)
      for (let i = 0; i < quickReplies.length; i += 2) {
        const row = [];
        const tpl1 = String(quickReplies[i] || '').trim();
        if (tpl1) {
          row.push(Markup.button.callback(`⚡ ${truncate(tpl1, 20)}`, `sp:tpl:${tid}:${i}`));
        }
        if (i + 1 < quickReplies.length) {
          const tpl2 = String(quickReplies[i + 1] || '').trim();
          if (tpl2) {
            row.push(Markup.button.callback(`⚡ ${truncate(tpl2, 20)}`, `sp:tpl:${tid}:${i + 1}`));
          }
        }
        if (row.length) buttons.push(row);
      }

      const actionRow = [];
      if (ticket.status !== 'escalated') {
        actionRow.push(Markup.button.callback('🔺 Передать модератору/админу', `sp:esc:${tid}`));
      }
      actionRow.push(Markup.button.callback('✅ Решено / Закрыть', `sp:cls:${tid}`));
      buttons.push(actionRow);
    }
  }

  if (messages.length > RECENT_MESSAGES_LIMIT) {
    buttons.push([Markup.button.callback(`📜 Полная история (${messages.length})`, `sp:hist:${tid}:1`)]);
  }

  const backRow = [Markup.button.callback('⬅️ К очередям', 'sp:home')];
  if (staffUser?.role === 'moderator') {
    backRow.push(Markup.button.callback('🛡 Модер-панель', 'adm_sup:hub'));
  }
  buttons.push(backRow);

  return {
    ticket,
    text,
    keyboard: Markup.inlineKeyboard(buttons),
  };
};

/**
 * Главная панель сотрудника поддержки (/support, /sapport, /sup, sp:home, sp:q:<tab>:<page>).
 */
const showSupportPanel = async (ctx, tab = 'waiting', page = 1) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    return promptToOpenPrivateChat(ctx, '🎧 Панель саппорта работает в ЛС бота.');
  }

  if (ctx.session) {
    clearStaleSessionActions(ctx);
    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;
  }

  const isMod = isModeratorOrAbove(ctx.user);
  let serviceTab = tab === 'esc' ? 'escalated' : tab;
  if (!['waiting', 'mine', 'escalated', 'closed'].includes(serviceTab)) {
    serviceTab = 'waiting';
  }
  if (serviceTab === 'escalated' && !isMod) {
    serviceTab = 'waiting';
  }
  const cbTab = serviceTab === 'escalated' ? 'esc' : serviceTab;
  const safePageNum = Math.max(1, parseInt(page, 10) || 1);

  const [counts, queueRes, todayStats] = await Promise.all([
    supportService.getQueuesCounts(ctx.user._id).catch(() => ({})),
    supportService.getQueue({
      tab: serviceTab,
      staffUserId: ctx.user._id,
      page: safePageNum,
      limit: QUEUE_PAGE_SIZE,
    }).catch(() => ({ items: [], total: 0 })),
    supportService.getStaffActivityStats(ctx.user._id, 'today').catch(() => ({})),
  ]);

  const cWait = counts?.waiting ?? 0;
  const cMine = counts?.mine ?? 0;
  const cEsc = counts?.escalated ?? counts?.esc ?? 0;
  const cClosed = counts?.closed ?? 0;

  let tickets = queueRes?.tickets || queueRes?.items || (Array.isArray(queueRes) ? queueRes : []);
  const total = queueRes?.total ?? tickets.length;
  const totalPages = queueRes?.totalPages ?? Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  let currentPage = Math.min(safePageNum, totalPages);

  if (safePageNum > totalPages && total > 0) {
    const retryRes = await supportService.getQueue({
      tab: serviceTab,
      staffUserId: ctx.user._id,
      page: totalPages,
      limit: QUEUE_PAGE_SIZE,
    }).catch(() => ({ items: [], total }));
    tickets = retryRes?.tickets || retryRes?.items || (Array.isArray(retryRes) ? retryRes : []);
    currentPage = totalPages;
  }

  const onDuty = ctx.user?.supportOnDuty !== false;
  const dutyText = onDuty ? '🟢 На смене' : '🔴 Оффлайн';
  const roleBadge = ROLE_BADGES[ctx.user.role] || '🎧 Саппорт';

  const tabTitles = {
    waiting: '⏳ Ожидают ответа',
    mine: '💬 Мои в работе',
    escalated: '🔺 Эскалации',
    closed: '✅ Закрытые',
  };

  const takenToday = todayStats?.takenCount ?? 0;
  const closedToday = todayStats?.closedCount ?? 0;
  const repliesToday = todayStats?.repliesCount ?? 0;

  const lines = [
    `🎧 <b>Панель поддержки</b> · ${roleBadge}`,
    `Статус смены: <b>${dutyText}</b>`,
    '',
    `<blockquote>📊 <b>Сегодня:</b> взято <b>${takenToday}</b> · ответов <b>${repliesToday}</b> · закрыто <b>${closedToday}</b></blockquote>`,
    '',
    `📂 <b>Очередь: ${tabTitles[serviceTab]}</b> (стр. ${currentPage}/${totalPages})`,
  ];

  if (!tickets.length) {
    lines.push('<i>Тикетов в этой очереди пока нет.</i>');
  } else {
    lines.push('');
    for (const tk of tickets) {
      const sEmoji = TICKET_STATUS_EMOJI[tk.status] || '🎫';
      const buyerTag = tk.userId?.username
        ? `@${escapeHtml(tk.userId.username)}`
        : `ID <code>${tk.telegramId || '?'}</code>`;
      const topicShort = escapeHtml(truncate(tk.topicLabel || tk.topic || 'Вопрос', 30));
      const timeStr = tk.lastMessageAt ? formatDateTimeMSK(tk.lastMessageAt) : formatDateTimeMSK(tk.createdAt);
      lines.push(`${sEmoji} <b>#${escapeHtml(tk.ticketNumber)}</b> · ${topicShort} — ${buyerTag} <i>(${timeStr})</i>`);
    }
  }

  const buttons = [
    [Markup.button.callback(onDuty ? '🔴 Уйти со смены' : '🟢 Выйти на смену', 'sp:duty')],
  ];

  const markTab = (tKey, label) => (serviceTab === tKey ? `• ${label} •` : label);

  const tabRow1 = [
    Markup.button.callback(markTab('waiting', `⏳ Ожидают (${cWait})`), 'sp:q:waiting:1'),
    Markup.button.callback(markTab('mine', `💬 Мои (${cMine})`), 'sp:q:mine:1'),
  ];
  buttons.push(tabRow1);

  const tabRow2 = [];
  if (isMod) {
    tabRow2.push(Markup.button.callback(markTab('escalated', `🔺 Эскал. (${cEsc})`), 'sp:q:esc:1'));
  }
  tabRow2.push(Markup.button.callback(markTab('closed', `✅ Закрытые (${cClosed})`), 'sp:q:closed:1'));
  buttons.push(tabRow2);

  for (const tk of tickets) {
    const sEmoji = TICKET_STATUS_EMOJI[tk.status] || '🎫';
    const topicLabel = truncate(tk.topicLabel || tk.topic || 'Вопрос', 22);
    buttons.push([
      Markup.button.callback(`${sEmoji} #${tk.ticketNumber} · ${topicLabel}`, `sp:v:${tk._id}`),
    ]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️', `sp:q:${cbTab}:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'sp:noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('➡️', `sp:q:${cbTab}:${currentPage + 1}`));
    }
    buttons.push(navRow);
  }

  if (ctx.user.role === 'moderator') {
    buttons.push([Markup.button.callback('🛡 Модер-панель', 'adm_sup:hub')]);
  } else if (isAdminOrAbove(ctx.user)) {
    buttons.push([Markup.button.callback('🎧 Настройки саппортов', 'adm_sup:hub')]);
  }

  buttons.push([Markup.button.callback('⬅️ В главное меню', 'menu:main')]);

  return safeEdit(ctx, lines.join('\n'), Markup.inlineKeyboard(buttons));
};

/**
 * Переключение статуса смены саппорта (🟢 На смене / 🔴 Оффлайн).
 */
const toggleDuty = async (ctx) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  try {
    const res = await supportService.toggleDuty(ctx.user);
    if (typeof res === 'boolean') {
      ctx.user.supportOnDuty = res;
    } else if (res && typeof res.supportOnDuty === 'boolean') {
      ctx.user.supportOnDuty = res.supportOnDuty;
    } else {
      const fresh = await User.findById(ctx.user._id).select('supportOnDuty').lean();
      if (fresh) ctx.user.supportOnDuty = fresh.supportOnDuty;
    }

    const msg = ctx.user.supportOnDuty !== false ? '🟢 Вы вышли на смену' : '🔴 Вы ушли со смены';
    await ctx.answerCbQuery(msg).catch(() => {});
  } catch (err) {
    logger.error(`[SupportPanel] toggleDuty error: ${err.message}`);
    await ctx.answerCbQuery('❌ Не удалось переключить смену', { show_alert: true }).catch(() => {});
  }

  return showSupportPanel(ctx, 'waiting', 1);
};

/**
 * Показывает подробную карточку тикета сотруднику.
 */
const showTicketForStaff = async (ctx, ticketId) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    return promptToOpenPrivateChat(ctx, '🎧 Просмотр карточки тикета доступен в ЛС бота.');
  }

  if (ctx.session) {
    clearStaleSessionActions(ctx);
    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;
  }

  const payload = await buildTicketCardPayload(ticketId, ctx.user);
  if (!payload) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  return safeEdit(ctx, payload.text, payload.keyboard);
};

/**
 * Полная пагинированная история переписки по тикету (sp:hist:<id>:<page>).
 */
const showTicketHistory = async (ctx, ticketId, page = 1) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  const detail = await supportService.getTicketDetail(ticketId);
  if (!detail || !detail.ticket) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  const { ticket, messages = [] } = detail;
  const totalPages = Math.max(1, Math.ceil(messages.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const slice = messages.slice((safePage - 1) * HISTORY_PAGE_SIZE, safePage * HISTORY_PAGE_SIZE);

  const headerText =
    `📜 <b>История тикета #${escapeHtml(truncate(ticket.ticketNumber, 32))}</b> (стр. ${safePage}/${totalPages})\n`;
  const msgBudget = MAX_TELEGRAM_HTML_LEN - headerText.length - 1;
  const messagesBlock = slice.length
    ? buildSafeMessagesBlock(slice, msgBudget, false)
    : '<i>Сообщений нет.</i>';
  const text = `${headerText}\n${messagesBlock}`;

  const tid = String(ticket._id);
  const buttons = [];
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 1) nav.push(Markup.button.callback('⬅️', `sp:hist:${tid}:${safePage - 1}`));
    nav.push(Markup.button.callback(`${safePage}/${totalPages}`, 'sp:noop'));
    if (safePage < totalPages) nav.push(Markup.button.callback('➡️', `sp:hist:${tid}:${safePage + 1}`));
    buttons.push(nav);
  }
  buttons.push([Markup.button.callback('⬅️ Назад к тикету', `sp:v:${tid}`)]);

  return safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
};

/**
 * Атомарный захват тикета в работу (sp:take:<id>), в ЛС или из группового чата supportChatId.
 */
const takeTicket = async (ctx, ticketId) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  clearStaleSessionActions(ctx);
  if (ctx.session) {
    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;
  }

  const res = await supportService.claimTicket({ ticketId, staffUser: ctx.user });
  if (!res || !res.ok) {
    let holder = 'другой сотрудник';
    const existing = res?.ticket || (await SupportTicket.findById(ticketId).populate('assignedTo', 'username firstName telegramId').lean());
    if (existing?.assignedTo?.username) {
      holder = `@${existing.assignedTo.username}`;
    } else if (existing?.assignedTelegramId) {
      holder = `ID ${existing.assignedTelegramId}`;
    } else if (res?.reason) {
      holder = res.reason;
    }

    await ctx.answerCbQuery(`❌ Тикет уже взял ${holder}`, { show_alert: true }).catch(() => {});
    if (existing) {
      await supportNotify.syncTicketCardInChats(existing).catch(() => {});
    }
    if (ctx.chat?.type === 'private') {
      return showTicketForStaff(ctx, ticketId);
    }
    return;
  }

  const ticket = res.ticket;
  await supportNotify.syncTicketCardInChats(ticket).catch(() => {});

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    await ctx.answerCbQuery(`✋ Вы взяли тикет #${ticket.ticketNumber}! Карточка отправлена вам в ЛС.`).catch(() => {});
    try {
      const payload = await buildTicketCardPayload(ticket._id, ctx.user);
      if (payload) {
        await ctx.telegram.sendMessage(ctx.user.telegramId, payload.text, {
          parse_mode: 'HTML',
          ...payload.keyboard,
        });
      }
    } catch (err) {
      logger.warn(`[SupportPanel] Не удалось отправить карточку #${ticket.ticketNumber} в ЛС ${ctx.user.telegramId}: ${err.message}`);
      const botUsername = ctx.botInfo?.username;
      if (botUsername) {
        await ctx.reply(
          `✋ <b>${formatStaffIdentity(ctx.user, ctx.user.telegramId)}</b> взял тикет <b>#${escapeHtml(ticket.ticketNumber)}</b>.\n` +
          `Откройте ЛС бота, чтобы ответить клиенту:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('💬 Ответить в ЛС бота', `https://t.me/${botUsername}?start=support`)],
            ]),
          }
        ).catch(() => {});
      }
    }
    return;
  }

  await ctx.answerCbQuery(`✋ Тикет #${ticket.ticketNumber} взят в работу`).catch(() => {});
  return showTicketForStaff(ctx, ticketId);
};

/**
 * Запуск режима текстового/медиа ответа по тикету (sp:rep:<id>).
 */
const startStaffReply = async (ctx, ticketId) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    try {
      const payload = await buildTicketCardPayload(ticketId, ctx.user);
      if (payload) {
        await ctx.telegram.sendMessage(ctx.user.telegramId, payload.text, {
          parse_mode: 'HTML',
          ...payload.keyboard,
        });
        return ctx.answerCbQuery('💬 Карточка тикета отправлена вам в ЛС бота').catch(() => {});
      }
    } catch (_) {
      // fallback ниже
    }
    return promptToOpenPrivateChat(ctx, '💬 Чтобы написать ответ, откройте ЛС бота.');
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }
  if (ticket.status === 'closed') {
    return ctx.answerCbQuery('✅ Тикет уже закрыт', { show_alert: true }).catch(() => {});
  }
  if (
    ticket.assignedTelegramId &&
    Number(ticket.assignedTelegramId) !== Number(ctx.user.telegramId) &&
    !isModeratorOrAbove(ctx.user)
  ) {
    return ctx.answerCbQuery('❌ Тикет находится в работе у другого сотрудника', { show_alert: true }).catch(() => {});
  }

  ctx.session = ctx.session || {};
  clearStaleSessionActions(ctx);
  ctx.session.supportAction = 'staff_reply_text';
  ctx.session.activeTicketId = String(ticket._id);

  const text =
    `💬 <b>Ответ по тикету #${escapeHtml(ticket.ticketNumber)}</b>\n\n` +
    `Отправьте текстовое сообщение, фото или документ — оно сразу будет доставлено клиенту.\n` +
    `<i>Для отмены нажмите кнопку ниже.</i>`;

  return safeEdit(
    ctx,
    text,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `sp:v:${ticket._id}`)]])
  );
};

/**
 * Мгновенная отправка быстрого шаблона ответа (sp:tpl:<id>:<idx>).
 */
const sendQuickTemplate = async (ctx, ticketId, idx) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  const settings = await getSettings();
  const quickReplies = Array.isArray(settings?.supportQuickReplies) ? settings.supportQuickReplies : [];
  const tplIndex = parseInt(idx, 10);

  if (Number.isNaN(tplIndex) || tplIndex < 0 || tplIndex >= quickReplies.length) {
    return ctx.answerCbQuery('❌ Шаблон не найден', { show_alert: true }).catch(() => {});
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }
  if (ticket.status === 'closed') {
    return ctx.answerCbQuery('✅ Тикет уже закрыт', { show_alert: true }).catch(() => {});
  }
  if (
    ticket.assignedTelegramId &&
    Number(ticket.assignedTelegramId) !== Number(ctx.user.telegramId) &&
    !isModeratorOrAbove(ctx.user)
  ) {
    return ctx.answerCbQuery('❌ Тикет находится в работе у другого сотрудника', { show_alert: true }).catch(() => {});
  }

  const templateText = String(quickReplies[tplIndex] || '').trim();
  if (!templateText) {
    return ctx.answerCbQuery('❌ Пустой шаблон', { show_alert: true }).catch(() => {});
  }

  const replyRes = await supportService.addReply({
    ticketId: ticket._id,
    senderUser: ctx.user,
    text: templateText,
    mediaType: null,
    mediaFileId: null,
  });

  if (!replyRes || !replyRes.ok) {
    if (replyRes?.ticket) {
      await supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {});
    }
    const errMsg = replyRes?.reason === 'TICKET_CLOSED'
      ? '✅ Тикет уже закрыт'
      : '❌ Не удалось отправить ответ';
    await ctx.answerCbQuery(errMsg, { show_alert: true }).catch(() => {});
    if (ctx.chat?.type === 'private') {
      return showTicketForStaff(ctx, ticket._id);
    }
    return;
  }

  const ticketDoc = replyRes.ticket;
  const msgDoc = replyRes.message;

  await supportNotify.notifyBuyerStaffReply(ticketDoc, ctx.user, msgDoc).catch(() => {});
  await supportNotify.syncTicketCardInChats(ticketDoc).catch(() => {});

  await ctx.answerCbQuery('⚡ Быстрый ответ отправлен').catch(() => {});

  if (ctx.chat?.type === 'private') {
    return showTicketForStaff(ctx, ticket._id);
  }
};

/**
 * Запуск эскалации тикета модератору/админу с вводом причины (sp:esc:<id>).
 */
const startEscalate = async (ctx, ticketId) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    return promptToOpenPrivateChat(ctx, '🔺 Передача тикета с причиной доступна в ЛС бота.');
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }
  if (ticket.status === 'closed') {
    return ctx.answerCbQuery('✅ Тикет уже закрыт', { show_alert: true }).catch(() => {});
  }

  ctx.session = ctx.session || {};
  clearStaleSessionActions(ctx);
  ctx.session.supportAction = 'staff_escalate_reason';
  ctx.session.activeTicketId = String(ticket._id);

  const text =
    `🔺 <b>Передача тикета #${escapeHtml(ticket.ticketNumber)} модератору/админу</b>\n\n` +
    `Напишите краткую причину передачи (например: нужен возврат, сложный спор, технический баг):`;

  return safeEdit(
    ctx,
    text,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `sp:v:${ticket._id}`)]])
  );
};

/**
 * Закрытие тикета сотрудником поддержки (sp:cls:<id>).
 */
const closeTicketByStaff = async (ctx, ticketId) => {
  if (!(await ensureSupportContextAccess(ctx))) return;

  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const existing = detail?.ticket;
  if (!existing) {
    return ctx.answerCbQuery('❌ Тикет не найден', { show_alert: true }).catch(() => {});
  }
  if (existing.status === 'closed') {
    return ctx.answerCbQuery('✅ Тикет уже закрыт', { show_alert: true }).catch(() => {});
  }
  if (
    existing.assignedTelegramId &&
    Number(existing.assignedTelegramId) !== Number(ctx.user.telegramId) &&
    !isModeratorOrAbove(ctx.user)
  ) {
    return ctx.answerCbQuery('❌ Тикет находится в работе у другого сотрудника', { show_alert: true }).catch(() => {});
  }

  const closeRes = await supportService.closeTicket({
    ticketId: existing._id,
    actorUser: ctx.user,
    reason: 'resolved',
  });
  if (!closeRes || !closeRes.ok) {
    await ctx.answerCbQuery('✅ Тикет уже закрыт', { show_alert: true }).catch(() => {});
    if (ctx.chat?.type === 'private') {
      return showTicketForStaff(ctx, existing._id);
    }
    return;
  }
  const ticketDoc = closeRes.ticket;

  await supportNotify.notifyTicketClosedToBuyer(ticketDoc).catch(() => {});
  await supportNotify.syncTicketCardInChats(ticketDoc).catch(() => {});

  await ctx.answerCbQuery('✅ Тикет закрыт').catch(() => {});

  if (ctx.chat?.type === 'private') {
    return showTicketForStaff(ctx, existing._id);
  }
};

const extractMessagePayload = (message) => {
  if (!message) return { text: '', mediaType: null, mediaFileId: null };
  let mediaType = null;
  let mediaFileId = null;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    mediaType = 'photo';
    mediaFileId = message.photo[message.photo.length - 1].file_id;
  } else if (message.document?.file_id) {
    mediaType = 'document';
    mediaFileId = message.document.file_id;
  } else if (message.video?.file_id) {
    mediaType = 'video';
    mediaFileId = message.video.file_id;
  }

  const text = String(message.text || message.caption || '').trim();
  return { text, mediaType, mediaFileId };
};

/**
 * Обработчик текстового и медиа-ввода сотрудника из input.routes.js.
 * Возвращает true, если сообщение обработано.
 */
const handleStaffTextInput = async (ctx) => {
  const action = ctx.session?.supportAction;
  if (action !== 'staff_reply_text' && action !== 'staff_escalate_reason') {
    return false;
  }

  if (!ctx.user || !isSupportOrAbove(ctx.user)) {
    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;
    return false;
  }

  const ticketId = ctx.session?.activeTicketId;
  if (!ticketId || !mongoose.Types.ObjectId.isValid(ticketId)) {
    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;
    return false;
  }

  if (action === 'staff_reply_text') {
    const { text: rawText, mediaType, mediaFileId } = extractMessagePayload(ctx.message);
    if (!rawText && !mediaFileId) {
      await ctx.reply('⚠️ Отправьте текстовое сообщение, фото или документ.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `sp:v:${ticketId}`)]]),
      });
      return true;
    }

    const text = rawText.slice(0, MAX_INPUT_TEXT_LEN);

    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;

    const replyRes = await supportService.addReply({
      ticketId,
      senderUser: ctx.user,
      text,
      mediaType,
      mediaFileId,
    });

    if (!replyRes || !replyRes.ok) {
      if (replyRes?.ticket) {
        await supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {});
      }
      const errText = replyRes?.reason === 'TICKET_CLOSED'
        ? '⚠️ <b>Тикет уже закрыт</b> — ответ не доставлен.'
        : '❌ <b>Не удалось отправить ответ</b> (тикет не найден или закрыт).';
      await ctx.reply(errText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎫 Открыть тикет', `sp:v:${ticketId}`)],
          [Markup.button.callback('🎧 В панель саппорта', 'sp:home')],
        ]),
      });
      return true;
    }

    const ticketDoc = replyRes.ticket;
    const msgDoc = replyRes.message;

    await supportNotify.notifyBuyerStaffReply(ticketDoc, ctx.user, msgDoc).catch(() => {});
    await supportNotify.syncTicketCardInChats(ticketDoc).catch(() => {});

    const ticketNum = escapeHtml(ticketDoc?.ticketNumber || '');
    await ctx.reply(
      `✅ <b>Ответ отправлен клиенту</b> (тикет #${ticketNum}).`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🎫 Открыть #${ticketDoc?.ticketNumber || 'тикет'}`, `sp:v:${ticketId}`)],
          [Markup.button.callback('🎧 В панель саппорта', 'sp:home')],
        ]),
      }
    );
    return true;
  }

  if (action === 'staff_escalate_reason') {
    const { text: rawText } = extractMessagePayload(ctx.message);
    if (!rawText) {
      await ctx.reply('⚠️ Напишите текстом причину передачи тикета модератору/админу.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `sp:v:${ticketId}`)]]),
      });
      return true;
    }

    const text = rawText.slice(0, MAX_INPUT_TEXT_LEN);

    ctx.session.supportAction = null;
    ctx.session.activeTicketId = null;

    const escRes = await supportService.escalateTicket({
      ticketId,
      staffUser: ctx.user,
      reason: text,
    });

    if (!escRes || !escRes.ok) {
      await ctx.reply(
        '⚠️ <b>Не удалось передать тикет</b> (возможно, он уже закрыт или не найден).',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('🎧 В панель саппорта', 'sp:home')]]),
        }
      );
      return true;
    }

    const ticketDoc = escRes.ticket;

    await supportNotify.notifyEscalation(ticketDoc, ctx.user, text).catch(() => {});
    await supportNotify.syncTicketCardInChats(ticketDoc).catch(() => {});

    const ticketNum = escapeHtml(ticketDoc?.ticketNumber || '');
    await ctx.reply(
      `🔺 <b>Тикет #${ticketNum} передан модератору/админу.</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🎧 В панель саппорта', 'sp:home')]]),
      }
    );
    return true;
  }

  return false;
};

/**
 * Обрабатывает Reply сотрудника в подключённом групповом чате supportChatId
 * на карточку тикета бота (по groupMessageId или #SUP-XXXX в тексте).
 */
const handleGroupReply = async (ctx) => {
  if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
    return false;
  }
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) return false;

  const isBotMsg = ctx.botInfo?.id
    ? Number(replyTo.from?.id) === Number(ctx.botInfo.id)
    : Boolean(replyTo.from?.is_bot);
  if (!isBotMsg) return false;

  if (!ctx.user || !isSupportOrAbove(ctx.user)) {
    return false;
  }

  const settings = await getSettings();
  if (!settings?.supportChatId || Number(ctx.chat.id) !== Number(settings.supportChatId)) {
    return false;
  }

  const { text: rawText, mediaType, mediaFileId } = extractMessagePayload(ctx.message);
  if (rawText.startsWith('/')) return false;
  if (!rawText && !mediaFileId) return false;

  let ticket = await SupportTicket.findOne({
    groupChatId: Number(ctx.chat.id),
    groupMessageId: Number(replyTo.message_id),
  });

  if (!ticket) {
    const refText = String(replyTo.text || replyTo.caption || '');
    const match = refText.match(/#?(SUP-[A-Z0-9-]+)/i);
    if (match) {
      ticket = await SupportTicket.findOne({ ticketNumber: match[1].toUpperCase() });
    }
  }

  if (!ticket || ticket.status === 'closed') {
    return false;
  }

  if (
    ticket.assignedTelegramId &&
    Number(ticket.assignedTelegramId) !== Number(ctx.user.telegramId) &&
    !isModeratorOrAbove(ctx.user)
  ) {
    await ctx.reply(
      `⛔ Тикет <b>#${escapeHtml(ticket.ticketNumber)}</b> находится в работе у другого сотрудника.`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id,
      }
    ).catch(() => {});
    return true;
  }

  const text = rawText.slice(0, MAX_INPUT_TEXT_LEN);

  const replyRes = await supportService.addReply({
    ticketId: ticket._id,
    senderUser: ctx.user,
    text,
    mediaType,
    mediaFileId,
  });

  if (!replyRes || !replyRes.ok) {
    if (replyRes?.ticket) {
      await supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {});
    }
    await ctx.reply(
      `⚠️ Тикет <b>#${escapeHtml(ticket.ticketNumber)}</b> уже закрыт — сообщение клиенту не отправлено.`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id,
      }
    ).catch(() => {});
    return true;
  }

  const ticketDoc = replyRes.ticket;
  const msgDoc = replyRes.message;

  await supportNotify.notifyBuyerStaffReply(ticketDoc, ctx.user, msgDoc).catch(() => {});
  await supportNotify.syncTicketCardInChats(ticketDoc).catch(() => {});

  await ctx.reply(
    `✅ Ответ отправлен клиенту по <b>#${escapeHtml(ticket.ticketNumber)}</b>`,
    {
      parse_mode: 'HTML',
      reply_to_message_id: ctx.message.message_id,
    }
  ).catch(() => {});

  return true;
};

module.exports = {
  showSupportPanel,
  toggleDuty,
  showTicketForStaff,
  showTicketHistory,
  takeTicket,
  startStaffReply,
  sendQuickTemplate,
  startEscalate,
  closeTicketByStaff,
  handleStaffTextInput,
  handleGroupReply,
  buildTicketCardPayload,
  ensureSupportContextAccess,
};

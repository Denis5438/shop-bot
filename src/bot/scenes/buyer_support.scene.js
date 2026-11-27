const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const logger = require('../../config/logger');
const supportService = require('../../services/support.service');
const supportNotify = require('../../services/supportNotify.service');
const { getSettings } = require('../../services/settingsCache.service');
const { escapeHtml, formatDateTimeMSK, safeEdit } = require('../utils/ui');

const VALID_TOPICS = ['order', 'payment', 'product', 'general'];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const PAGE_SIZE = 5;

const TOPIC_META = {
  order: {
    ru: '📦 Проблема с заказом',
    en: '📦 Order Issue',
  },
  payment: {
    ru: '💳 Оплата / Пополнение',
    en: '💳 Payment / Top-up',
  },
  product: {
    ru: '❓ Вопрос по товару',
    en: '❓ Product Question',
  },
  general: {
    ru: '💬 Другой вопрос',
    en: '💬 General Question',
  },
};

const STATUS_BADGE = {
  open: { icon: '🆕', ru: 'Открыто (ожидает ответа)', en: 'Open (awaiting reply)' },
  in_progress: { icon: '💬', ru: 'В работе', en: 'In progress' },
  escalated: { icon: '🔺', ru: 'Передано старшему специалисту', en: 'Escalated to senior staff' },
  closed: { icon: '✅', ru: 'Закрыто', en: 'Closed' },
};

const getLang = (ctx) => (ctx.user?.language === 'en' ? 'en' : 'ru');

const getTopicLabel = (topic, lang = 'ru') => {
  const meta = TOPIC_META[topic] || TOPIC_META.general;
  return meta[lang] || meta.ru;
};

const tr = (ctx, key, fallbackRu, fallbackEn) => {
  if (typeof ctx.t === 'function') {
    const val = ctx.t(key);
    if (val && val !== key) return val;
  }
  return getLang(ctx) === 'en' ? fallbackEn : fallbackRu;
};

const MAX_INPUT_TEXT_LEN = 2500;
const MAX_MSG_PREVIEW_RAW = 450;
const MAX_MSG_PREVIEW_ESCAPED = 550;
const MAX_DETAIL_HTML_LEN = 3800;

const escapeTruncatedText = (rawText, maxRaw = MAX_MSG_PREVIEW_RAW, maxEscaped = MAX_MSG_PREVIEW_ESCAPED) => {
  const str = String(rawText || '').trim();
  if (!str) return '';
  let cut = str.length > maxRaw ? str.slice(0, maxRaw) : str;
  let wasCut = str.length > maxRaw;
  let escaped = escapeHtml(cut);
  while (escaped.length > maxEscaped && cut.length > 0) {
    cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, Math.ceil((escaped.length - maxEscaped) / 4))));
    wasCut = true;
    escaped = escapeHtml(cut);
  }
  return wasCut ? `${escaped}…` : escaped;
};

const extractMessagePayload = (ctx) => {
  const msg = ctx.message || {};
  const rawText = (msg.text || msg.caption || '').trim();
  let mediaType = null;
  let mediaFileId = null;

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    mediaType = 'photo';
    mediaFileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document?.file_id) {
    mediaType = 'document';
    mediaFileId = msg.document.file_id;
  } else if (msg.video?.file_id) {
    mediaType = 'video';
    mediaFileId = msg.video.file_id;
  }

  let text = rawText.slice(0, MAX_INPUT_TEXT_LEN);
  if (!text && mediaType) {
    text = mediaType === 'photo' ? '[Фото]' : (mediaType === 'document' ? '[Документ]' : '[Видео]');
  }

  return { text, mediaType, mediaFileId };
};

const clearStaleInputStates = (ctx) => {
  if (!ctx.session) return;
  ctx.session.userAction = null;
  ctx.session.topup = null;
  ctx.session.adminAction = null;
  ctx.session.staffAdminAction = null;
  ctx.session.step = null;
  ctx.session.tokenCheck = null;
  ctx.session.customerSearchMsgId = null;
};

const clearBuyerSupportSession = (ctx) => {
  if (!ctx.session) return;
  ctx.session.supportAction = null;
  ctx.session.supportTopic = null;
  ctx.session.supportOrderId = null;
  ctx.session.activeTicketId = null;
};

/**
 * Шаг 1: Выбор темы нового обращения (+ проверка анти-спам лимита).
 */
const startNewTicket = async (ctx) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);
  clearStaleInputStates(ctx);
  clearBuyerSupportSession(ctx);

  const settings = await getSettings().catch(() => ({}));
  const maxOpen = Number(settings?.supportMaxOpenPerUser) || 3;
  const activeCount = await supportService.countUserActiveTickets(ctx.user._id).catch(() => 0);

  if (activeCount >= maxOpen) {
    const text = lang === 'en'
      ? `⚠️ <b>Active ticket limit reached (${activeCount}/${maxOpen})</b>\n\nPlease wait for a reply on your open tickets or close resolved ones in «My Tickets».`
      : `⚠️ <b>Достигнут лимит открытых обращений (${activeCount}/${maxOpen})</b>\n\nДождитесь ответа по текущим тикетам или закройте неактуальные в разделе «Мои обращения».`;

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')],
      [Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:support')],
    ]);
    return safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  }

  const title = lang === 'en'
    ? '💬 <b>New Support Ticket</b>\n\nPlease choose a topic for your question:'
    : '💬 <b>Новое обращение в поддержку</b>\n\nВыберите тему вашего вопроса:';

  const buttons = [
    [Markup.button.callback(getTopicLabel('order', lang), 'sup:top:order')],
    [Markup.button.callback(getTopicLabel('payment', lang), 'sup:top:payment')],
    [Markup.button.callback(getTopicLabel('product', lang), 'sup:top:product')],
    [Markup.button.callback(getTopicLabel('general', lang), 'sup:top:general')],
    [Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:support')],
  ];

  return safeEdit(ctx, title, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

/**
 * Шаг 2: Выбор темы -> для заказа подтягиваем последние 3 заказа, иначе просим текст/скрин.
 */
const handleTopicSelection = async (ctx, topic) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);

  if (!VALID_TOPICS.includes(topic)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Unknown topic' : '❌ Неизвестная тема', { show_alert: true }).catch(() => {});
    }
    return;
  }

  ctx.session = ctx.session || {};
  clearStaleInputStates(ctx);
  ctx.session.supportTopic = topic;
  ctx.session.supportOrderId = null;

  if (topic === 'order') {
    const orders = await Order.find({ userId: ctx.user._id })
      .sort({ createdAt: -1 })
      .limit(3)
      .populate('productId', 'name')
      .lean();

    if (orders.length > 0) {
      const buttons = orders.map((o) => {
        const rawName = o.productId?.name || (lang === 'en' ? 'Order' : 'Заказ');
        const shortName = rawName.length > 24 ? `${rawName.slice(0, 23)}…` : rawName;
        const priceStr = Number(o.price || 0).toFixed(2);
        return [Markup.button.callback(`📦 ${shortName} · ${priceStr} USDT`, `sup:ord:${o._id}`)];
      });

      buttons.push([
        Markup.button.callback(
          lang === 'en' ? '📝 Other / No order' : '📝 Другой / без заказа',
          'sup:ord:none'
        ),
      ]);
      buttons.push([Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'sup:new')]);

      const prompt = lang === 'en'
        ? '📦 <b>Select the order</b> related to your question, or tap «Other / No order»:'
        : '📦 <b>Выберите заказ</b>, по которому возник вопрос, или нажмите «Другой / без заказа»:';

      return safeEdit(ctx, prompt, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
  }

  ctx.session.supportAction = 'buyer_new_text';
  const topicText = escapeHtml(getTopicLabel(topic, lang));
  const prompt = lang === 'en'
    ? `✍️ <b>Describe your question</b>\n\n📌 Topic: <i>${topicText}</i>\n\nSend a message, screenshot, or document below:`
    : `✍️ <b>Опишите ваш вопрос</b>\n\n📌 Тема: <i>${topicText}</i>\n\nОтправьте текст, скриншот или документ в ответном сообщении:`;

  return safeEdit(ctx, prompt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(tr(ctx, 'btn_cancel', '❌ Отмена', '❌ Cancel'), 'menu:support')]]),
  });
};

/**
 * Шаг 3: Выбор заказа (или «без заказа») -> запрос описания проблемы.
 */
const handleOrderSelection = async (ctx, orderIdOrNone) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);
  ctx.session = ctx.session || {};
  if (!VALID_TOPICS.includes(ctx.session.supportTopic)) {
    ctx.session.supportTopic = 'order';
  }

  let selectedOrder = null;
  if (orderIdOrNone && orderIdOrNone !== 'none') {
    if (!OBJECT_ID_RE.test(String(orderIdOrNone))) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true }).catch(() => {});
      }
      return;
    }
    selectedOrder = await Order.findOne({ _id: orderIdOrNone, userId: ctx.user._id })
      .populate('productId', 'name')
      .lean();
    if (!selectedOrder) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true }).catch(() => {});
      }
      return;
    }
    ctx.session.supportOrderId = String(selectedOrder._id);
  } else {
    ctx.session.supportOrderId = null;
  }

  ctx.session.supportAction = 'buyer_new_text';
  const topicText = escapeHtml(getTopicLabel(ctx.session.supportTopic, lang));
  const orderLine = selectedOrder
    ? `\n📦 ${lang === 'en' ? 'Order' : 'Заказ'}: <b>${escapeHtml(selectedOrder.productId?.name || String(selectedOrder._id).slice(-6))}</b>`
    : '';

  const prompt = lang === 'en'
    ? `✍️ <b>Describe your question</b>\n\n📌 Topic: <i>${topicText}</i>${orderLine}\n\nSend a message, screenshot, or document below:`
    : `✍️ <b>Опишите ваш вопрос</b>\n\n📌 Тема: <i>${topicText}</i>${orderLine}\n\nОтправьте текст, скриншот или документ в ответном сообщении:`;

  return safeEdit(ctx, prompt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(tr(ctx, 'btn_cancel', '❌ Отмена', '❌ Cancel'), 'menu:support')]]),
  });
};

/**
 * Обработка текстового / медиа-ввода от покупателя (создание тикета или ответ в существующий).
 */
const handleBuyerTextInput = async (ctx) => {
  if (!ctx.user?._id) return false;
  const session = ctx.session || {};
  const action = session.supportAction;
  if (action !== 'buyer_new_text' && action !== 'buyer_reply_text') {
    return false;
  }

  const lang = getLang(ctx);
  const { text, mediaType, mediaFileId } = extractMessagePayload(ctx);

  if (!text && !mediaFileId) {
    await ctx.reply(
      lang === 'en'
        ? '⚠️ Please send text, a photo, or a document.'
        : '⚠️ Пожалуйста, отправьте текстовое сообщение, фото или документ.',
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return true;
  }

  if (action === 'buyer_new_text') {
    const topic = VALID_TOPICS.includes(session.supportTopic) ? session.supportTopic : 'general';
    const orderId = session.supportOrderId && OBJECT_ID_RE.test(String(session.supportOrderId))
      ? session.supportOrderId
      : null;

    clearBuyerSupportSession(ctx);

    try {
      const created = await supportService.createTicket({
        user: ctx.user,
        topic,
        topicLabel: getTopicLabel(topic, 'ru'),
        orderId,
        text,
        mediaType,
        mediaFileId,
      });

      const ticket = created?.ticket || created;
      const firstMessage = created?.firstMessage || created?.message || {
        text,
        mediaType,
        mediaFileId,
        senderRole: 'user',
      };

      await supportNotify.notifyNewTicket(ticket, ctx.user, firstMessage).catch((err) => {
        logger.error(`buyer_support notifyNewTicket: ${err.message}`);
      });

      const ticketNum = escapeHtml(ticket?.ticketNumber || '');
      const topicSafe = escapeHtml(getTopicLabel(topic, lang));
      const msg = lang === 'en'
        ? `✅ <b>Ticket #${ticketNum} created!</b>\n\n📌 Topic: ${topicSafe}\n⏳ Our support team has been notified and will respond here shortly.`
        : `✅ <b>Обращение #${ticketNum} создано!</b>\n\n📌 Тема: ${topicSafe}\n⏳ Команда поддержки получила уведомление и скоро ответит вам прямо здесь.`;

      const buttons = [];
      if (ticket?._id) {
        buttons.push([
          Markup.button.callback(
            lang === 'en' ? '💬 Open Ticket' : '💬 Открыть обращение',
            `sup:v:${ticket._id}`
          ),
        ]);
      }
      buttons.push([Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')]);
      buttons.push([Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:main')]);

      await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (err) {
      if (err?.code === 'TOO_MANY_OPEN_TICKETS' || err?.message === 'TOO_MANY_OPEN_TICKETS') {
        const limitMsg = lang === 'en'
          ? '⚠️ You have reached the maximum number of open tickets. Close resolved tickets in «My Tickets» before opening a new one.'
          : '⚠️ Достигнут лимит открытых обращений. Закройте неактуальные тикеты в разделе «Мои обращения» перед созданием нового.';
        await ctx.reply(limitMsg, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')],
            [Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:support')],
          ]),
        });
        return true;
      }
      logger.error(`buyer_support createTicket: ${err.message}`);
      await ctx.reply(tr(ctx, 'error', '❌ Произошла ошибка. Попробуйте позже.', '❌ An error occurred. Please try again later.')).catch(() => {});
    }
    return true;
  }

  // action === 'buyer_reply_text'
  const ticketId = session.activeTicketId;
  clearBuyerSupportSession(ctx);

  if (!ticketId || !OBJECT_ID_RE.test(String(ticketId))) {
    return true;
  }

  try {
    const detail = await supportService.getTicketDetail(ticketId);
    const existingTicket = detail?.ticket;
    if (!existingTicket || String(existingTicket.userId?._id || existingTicket.userId) !== String(ctx.user._id)) {
      await ctx.reply(lang === 'en' ? '❌ Ticket not found.' : '❌ Обращение не найдено.').catch(() => {});
      return true;
    }
    if (existingTicket.status === 'closed') {
      await ctx.reply(
        lang === 'en' ? '⚠️ This ticket is already closed.' : '⚠️ Это обращение уже закрыто.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(tr(ctx, 'btn_ask_support', '💬 Задать вопрос саппортам в боте', '💬 Ask Support in Bot'), 'sup:new')],
            [Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')],
          ]),
        }
      );
      return true;
    }

    const replyRes = await supportService.addReply({
      ticketId,
      senderUser: ctx.user,
      text,
      mediaType,
      mediaFileId,
    });

    if (!replyRes?.ok) {
      if (replyRes?.ticket && typeof supportNotify.syncTicketCardInChats === 'function') {
        await supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {});
      }
      const isClosed = replyRes?.reason === 'TICKET_CLOSED';
      const errMsg = isClosed
        ? (lang === 'en' ? '⚠️ This ticket is already closed.' : '⚠️ Это обращение уже закрыто.')
        : (lang === 'en' ? '❌ Ticket not found or unavailable.' : '❌ Обращение не найдено или недоступно.');
      await ctx.reply(errMsg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '💬 Open Ticket' : '💬 Открыть обращение', `sup:v:${ticketId}`)],
          [Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')],
        ]),
      }).catch(() => {});
      return true;
    }

    const ticket = replyRes.ticket || existingTicket;
    const savedMsg = replyRes.message || { text, mediaType, mediaFileId, senderRole: 'user' };

    await supportNotify.notifyStaffBuyerReply(ticket, ctx.user, savedMsg).catch((err) => {
      logger.error(`buyer_support notifyStaffBuyerReply: ${err.message}`);
    });

    const ticketNum = escapeHtml(ticket?.ticketNumber || existingTicket.ticketNumber || '');
    const sentText = lang === 'en'
      ? `✅ Reply added to ticket <b>#${ticketNum}</b>.`
      : `✅ Сообщение отправлено в обращение <b>#${ticketNum}</b>.`;

    await ctx.reply(sentText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'en' ? '💬 Open Ticket' : '💬 Открыть обращение', `sup:v:${ticketId}`)],
        [Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1')],
      ]),
    });
  } catch (err) {
    logger.error(`buyer_support buyer_reply_text: ${err.message}`);
    await ctx.reply(tr(ctx, 'error', '❌ Произошла ошибка. Попробуйте позже.', '❌ An error occurred. Please try again later.')).catch(() => {});
  }
  return true;
};

/**
 * Список обращений пользователя с пагинацией.
 */
const showMyTickets = async (ctx, page = 1) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);
  clearBuyerSupportSession(ctx);

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const res = await supportService.getUserTickets(ctx.user._id, safePage, PAGE_SIZE);
  const tickets = Array.isArray(res) ? res : (res?.tickets || res?.items || []);
  const total = typeof res?.total === 'number' ? res.total : tickets.length;
  const totalPages = Math.max(1, res?.totalPages || Math.ceil(total / PAGE_SIZE) || 1);

  if (tickets.length === 0) {
    const emptyText = lang === 'en'
      ? '📋 <b>My Tickets</b>\n\n📭 You have no support tickets yet.'
      : '📋 <b>Мои обращения</b>\n\n📭 У вас пока нет обращений в поддержку.';
    return safeEdit(ctx, emptyText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(tr(ctx, 'btn_ask_support', '💬 Задать вопрос саппортам в боте', '💬 Ask Support in Bot'), 'sup:new')],
        [Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:support')],
      ]),
    });
  }

  const lines = [
    lang === 'en'
      ? `📋 <b>My Tickets</b> (${total}) — page ${safePage}/${totalPages}`
      : `📋 <b>Мои обращения</b> (${total}) — стр. ${safePage}/${totalPages}`,
    '',
  ];

  const buttons = [];
  for (const ticket of tickets) {
    const badge = STATUS_BADGE[ticket.status] || STATUS_BADGE.open;
    const topicText = getTopicLabel(ticket.topic, lang);
    const shortTopic = topicText.length > 22 ? `${topicText.slice(0, 21)}…` : topicText;
    const numSafe = escapeHtml(ticket.ticketNumber || '');
    lines.push(`${badge.icon} <b>#${numSafe}</b> · ${escapeHtml(topicText)} — <i>${badge[lang]}</i>`);
    buttons.push([
      Markup.button.callback(`${badge.icon} #${ticket.ticketNumber} · ${shortTopic}`, `sup:v:${ticket._id}`),
    ]);
  }

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 1) nav.push(Markup.button.callback('⬅️', `sup:my:${safePage - 1}`));
    nav.push(Markup.button.callback(`${safePage}/${totalPages}`, 'shop:noop'));
    if (safePage < totalPages) nav.push(Markup.button.callback('➡️', `sup:my:${safePage + 1}`));
    buttons.push(nav);
  }

  buttons.push([Markup.button.callback(tr(ctx, 'btn_ask_support', '💬 Задать вопрос саппортам в боте', '💬 Ask Support in Bot'), 'sup:new')]);
  buttons.push([Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:support')]);

  return safeEdit(ctx, lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

/**
 * Детали конкретного тикета покупателя + история переписки + кнопки действий / оценки.
 */
const showTicketDetail = async (ctx, ticketId) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);
  clearBuyerSupportSession(ctx);

  if (!OBJECT_ID_RE.test(String(ticketId || ''))) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket || String(ticket.userId?._id || ticket.userId) !== String(ctx.user._id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const badge = STATUS_BADGE[ticket.status] || STATUS_BADGE.open;
  const topicLabel = getTopicLabel(ticket.topic, lang);

  const lines = [
    `🎫 <b>#${escapeHtml(ticket.ticketNumber)}</b>`,
    `${badge.icon} ${lang === 'en' ? 'Status' : 'Статус'}: <b>${badge[lang]}</b>`,
    `📌 ${lang === 'en' ? 'Topic' : 'Тема'}: ${escapeHtml(topicLabel)}`,
  ];

  if (ticket.orderId) {
    const ordName = ticket.orderId?.productId?.name || String(ticket.orderId?._id || ticket.orderId).slice(-6);
    lines.push(`📦 ${lang === 'en' ? 'Order' : 'Заказ'}: <code>${escapeHtml(ordName)}</code>`);
  }

  if (ticket.rating) {
    lines.push(`⭐ ${lang === 'en' ? 'Your rating' : 'Ваша оценка'}: <b>${'⭐'.repeat(ticket.rating)} (${ticket.rating}/5)</b>`);
  }

  lines.push('');
  lines.push(lang === 'en' ? '<b>Conversation:</b>' : '<b>Переписка:</b>');

  const buttons = [];
  const footerLines = [];
  if (ticket.status !== 'closed') {
    buttons.push([
      Markup.button.callback(lang === 'en' ? '💬 Reply' : '💬 Ответить', `sup:re:${ticket._id}`),
      Markup.button.callback(lang === 'en' ? '✅ Close Ticket' : '✅ Закрыть вопрос', `sup:cl:${ticket._id}`),
    ]);
  } else if (!ticket.rating) {
    footerLines.push('');
    footerLines.push(lang === 'en' ? '⭐ <b>Please rate our support:</b>' : '⭐ <b>Оцените работу поддержки:</b>');
    buttons.push([1, 2, 3, 4, 5].map((n) => Markup.button.callback(`${n}⭐`, `sup:rt:${ticket._id}:${n}`)));
  }

  const headerLen = lines.join('\n').length;
  const footerLen = footerLines.join('\n').length;
  const omitNotice = lang === 'en' ? '<i>… earlier messages hidden …</i>' : '<i>… ранние сообщения скрыты …</i>';
  const msgBudget = Math.max(300, MAX_DETAIL_HTML_LEN - headerLen - footerLen - omitNotice.length - 16);

  const recent = messages.slice(-8);
  if (recent.length === 0) {
    lines.push(lang === 'en' ? '<i>No messages yet</i>' : '<i>Сообщений пока нет</i>');
  } else {
    const renderedMsgs = [];
    let usedLen = 0;
    let truncatedHistory = false;

    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      let who;
      if (m.senderRole === 'user') {
        who = lang === 'en' ? '👤 You' : '👤 Вы';
      } else if (m.senderRole === 'system') {
        who = lang === 'en' ? '⚙️ System' : '⚙️ Система';
      } else {
        who = lang === 'en' ? '🎧 Support' : '🎧 Поддержка';
      }
      const timeStr = m.createdAt ? ` <i>(${formatDateTimeMSK(m.createdAt)})</i>` : '';
      const mediaTag = m.mediaType ? ` [${escapeHtml(m.mediaType)}]` : '';
      const body = escapeTruncatedText(m.text || '');
      const entry = `<b>${who}</b>${timeStr}:${mediaTag}\n${body}`;

      if (renderedMsgs.length > 0 && usedLen + entry.length + 1 > msgBudget) {
        truncatedHistory = true;
        break;
      }
      renderedMsgs.push(entry);
      usedLen += entry.length + 1;
    }

    if (truncatedHistory) {
      lines.push(omitNotice);
    }
    for (let i = renderedMsgs.length - 1; i >= 0; i--) {
      lines.push(renderedMsgs[i]);
    }
  }

  if (footerLines.length > 0) {
    lines.push(...footerLines);
  }

  buttons.push([
    Markup.button.callback(tr(ctx, 'btn_my_tickets', '📋 Мои обращения', '📋 My Tickets'), 'sup:my:1'),
    Markup.button.callback(tr(ctx, 'btn_back', '⬅️ Назад', '⬅️ Back'), 'menu:main'),
  ]);

  return safeEdit(ctx, lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

/**
 * Запуск ответа покупателя в открытый тикет.
 */
const startBuyerReply = async (ctx, ticketId) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);

  if (!OBJECT_ID_RE.test(String(ticketId || ''))) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket || String(ticket.userId?._id || ticket.userId) !== String(ctx.user._id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  if (ticket.status === 'closed') {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '⚠️ Ticket is already closed' : '⚠️ Обращение уже закрыто', { show_alert: true }).catch(() => {});
    }
    return showTicketDetail(ctx, ticketId);
  }

  ctx.session = ctx.session || {};
  clearStaleInputStates(ctx);
  ctx.session.supportAction = 'buyer_reply_text';
  ctx.session.activeTicketId = String(ticket._id);

  const prompt = lang === 'en'
    ? `💬 <b>Reply to ticket #${escapeHtml(ticket.ticketNumber)}</b>\n\nSend text, a screenshot, or a document:`
    : `💬 <b>Ответ в обращение #${escapeHtml(ticket.ticketNumber)}</b>\n\nОтправьте текст, скриншот или документ:`;

  return safeEdit(ctx, prompt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(tr(ctx, 'btn_cancel', '❌ Отмена', '❌ Cancel'), `sup:v:${ticket._id}`)]]),
  });
};

/**
 * Закрытие тикета самим покупателем.
 */
const closeByBuyer = async (ctx, ticketId) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);

  if (!OBJECT_ID_RE.test(String(ticketId || ''))) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  const detail = await supportService.getTicketDetail(ticketId);
  const ticket = detail?.ticket;
  if (!ticket || String(ticket.userId?._id || ticket.userId) !== String(ctx.user._id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Ticket not found' : '❌ Обращение не найдено', { show_alert: true }).catch(() => {});
    }
    return;
  }

  if (ticket.status === 'closed') {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? 'Already closed' : 'Уже закрыто').catch(() => {});
    }
    return showTicketDetail(ctx, ticketId);
  }

  const closedRes = await supportService.closeTicket({
    ticketId,
    actorUser: ctx.user,
    reason: 'user_closed',
  });

  const updatedTicket = closedRes?.ticket || closedRes;
  if (updatedTicket && typeof supportNotify.syncTicketCardInChats === 'function') {
    await supportNotify.syncTicketCardInChats(updatedTicket).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(lang === 'en' ? '✅ Ticket closed' : '✅ Обращение закрыто').catch(() => {});
  }

  return showTicketDetail(ctx, ticketId);
};

/**
 * Выставление оценки 1..5 закрытому тикету покупателем.
 */
const handleRating = async (ctx, ticketId, rating) => {
  if (!ctx.user?._id) return;
  const lang = getLang(ctx);
  const numRating = parseInt(rating, 10);

  if (!OBJECT_ID_RE.test(String(ticketId || '')) || Number.isNaN(numRating) || numRating < 1 || numRating > 5) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(lang === 'en' ? '❌ Invalid rating' : '❌ Некорректная оценка', { show_alert: true }).catch(() => {});
    }
    return;
  }

  const res = await supportService.rateTicket({
    ticketId,
    userId: ctx.user._id,
    rating: numRating,
  });

  if (res?.ok === false) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(res.reason || (lang === 'en' ? '⚠️ Cannot rate ticket' : '⚠️ Не удалось сохранить оценку'), { show_alert: true }).catch(() => {});
    }
    return;
  }

  const updatedTicket = res?.ticket || res;
  if (updatedTicket && typeof supportNotify.syncTicketCardInChats === 'function') {
    await supportNotify.syncTicketCardInChats(updatedTicket).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(
      lang === 'en' ? `Thanks for rating (${numRating}⭐)!` : `Спасибо за оценку (${numRating}⭐)!`
    ).catch(() => {});
  }

  return showTicketDetail(ctx, ticketId);
};

module.exports = {
  startNewTicket,
  handleTopicSelection,
  handleOrderSelection,
  handleBuyerTextInput,
  showMyTickets,
  showTicketDetail,
  startBuyerReply,
  closeByBuyer,
  handleRating,
};

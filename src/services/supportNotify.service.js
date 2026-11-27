const { Markup } = require('telegraf');
const logger = require('../config/logger');
const { SUPERADMIN_IDS, ADMIN_IDS } = require('../config');
const notif = require('./notification.service');
const { getSettings, invalidateCache } = require('./settingsCache.service');
const { escapeHtml, formatDateTimeMSK } = require('../bot/utils/ui');
const SupportTicket = require('../models/SupportTicket');
const SupportMessage = require('../models/SupportMessage');
const Settings = require('../models/Settings');
const User = require('../models/User');

let botInstance = null;
let cachedBotUsername = null;

const setBot = (bot) => {
  botInstance = bot;
};

const setBotUsername = (username) => {
  if (username) cachedBotUsername = String(username).replace(/^@/, '');
};

const getBot = () => botInstance || notif.getBotInstance();

const resolveBotUsername = async (bot) => {
  if (cachedBotUsername) return cachedBotUsername;
  if (bot?.botInfo?.username) {
    cachedBotUsername = bot.botInfo.username;
    return cachedBotUsername;
  }
  try {
    const me = await bot.telegram.getMe();
    if (me?.username) {
      cachedBotUsername = me.username;
      return cachedBotUsername;
    }
  } catch (_) {}
  return null;
};

const formatUserLabel = (user, fallbackTelegramId = null) => {
  if (user?.username) return `@${escapeHtml(user.username)}`;
  if (user?.firstName) return escapeHtml(user.firstName);
  if (fallbackTelegramId != null) return `ID ${escapeHtml(fallbackTelegramId)}`;
  return 'Пользователь';
};

const truncateText = (text, maxLen = 400) => {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
};

/**
 * Обрезает сырой текст ДО escapeHtml и гарантирует, что результат после экранирования
 * не превысит maxEscapedLen и не порвёт HTML-сущности или теги.
 */
const escapeAndFitHtml = (rawText, maxRawLen = 1800, maxEscapedLen = 3200) => {
  let raw = truncateText(rawText, maxRawLen);
  let escaped = escapeHtml(raw);
  while (escaped.length > maxEscapedLen && raw.length > 10) {
    const nextLen = Math.max(1, Math.floor(raw.length * (maxEscapedLen / escaped.length) * 0.9) - 1);
    raw = `${raw.slice(0, nextLen)}…`;
    escaped = escapeHtml(raw);
  }
  return escaped;
};

const extractMigrateToChatId = (err) => {
  const pid =
    err?.response?.parameters?.migrate_to_chat_id ||
    err?.parameters?.migrate_to_chat_id ||
    null;
  const num = Number(pid);
  return Number.isFinite(num) && num < 0 ? num : null;
};

const persistMigratedSupportChat = async (oldChatId, newChatId) => {
  try {
    const current = await Settings.findOne({ name: 'global' });
    if (current && Number(current.supportChatId) === Number(oldChatId)) {
      current.supportChatId = Number(newChatId);
      await current.save();
      invalidateCache(current);
      logger.info(`[supportNotify] Чат саппортов мигрировал: ${oldChatId} -> ${newChatId}`);
      return true;
    }
  } catch (err) {
    logger.warn(`[supportNotify] Ошибка обновления supportChatId при миграции: ${err.message}`);
  }
  return false;
};

const STATUS_BADGES = {
  open: '🆕 Ожидает ответа',
  in_progress: '🟡 В работе',
  escalated: '🔺 ЭСКАЛАЦИЯ (Высокий приоритет)',
  closed: '✅ Закрыт',
};

const CLOSE_REASON_LABELS = {
  resolved: 'Решено поддержкой',
  user_closed: 'Закрыто покупателем',
  auto_timeout: 'Авто-закрытие по таймауту',
};

const buildStaffCard = (ticket, buyerUser = null, firstMessage = null, botUsername = null, includeBotLink = false) => {
  const buyer = buyerUser || (typeof ticket.userId === 'object' ? ticket.userId : null);
  const assignee = typeof ticket.assignedTo === 'object' ? ticket.assignedTo : null;

  const statusLabel = STATUS_BADGES[ticket.status] || escapeHtml(ticket.status);
  const topicLabel = escapeHtml(ticket.topicLabel || ticket.topic || 'Общий вопрос');
  const buyerLabel = formatUserLabel(buyer, ticket.telegramId);
  const createdStr = ticket.createdAt ? formatDateTimeMSK(ticket.createdAt) : '';

  let text =
    `🎫 <b>Обращение #${escapeHtml(ticket.ticketNumber)}</b>\n` +
    `📌 <b>Статус:</b> ${statusLabel}\n` +
    `📂 <b>Тема:</b> ${topicLabel}\n` +
    `👤 <b>Покупатель:</b> ${buyerLabel} (<code>${escapeHtml(ticket.telegramId)}</code>)\n`;

  if (ticket.orderId) {
    const oid = ticket.orderId?._id || ticket.orderId;
    text += `🧾 <b>Заказ:</b> <code>${escapeHtml(oid)}</code>\n`;
  }

  if (assignee || ticket.assignedTelegramId) {
    const staffLabel = formatUserLabel(assignee, ticket.assignedTelegramId);
    text += `🎧 <b>В работе у:</b> ${staffLabel}\n`;
  }

  if (ticket.status === 'escalated' && ticket.escalationReason) {
    text += `⚠️ <b>Причина эскалации:</b> <i>${escapeAndFitHtml(ticket.escalationReason, 200, 350)}</i>\n`;
  }

  if (ticket.status === 'closed') {
    const closeLabel = CLOSE_REASON_LABELS[ticket.closeReason] || 'Закрыт';
    text += `🔒 <b>Закрытие:</b> ${escapeHtml(closeLabel)}\n`;
    if (ticket.rating) {
      text += `⭐ <b>Оценка:</b> ${ticket.rating}/5\n`;
    }
  }

  if (createdStr) {
    text += `🕒 <b>Создан:</b> ${escapeHtml(createdStr)}\n`;
  }

  if (firstMessage?.text) {
    text += `\n💬 <b>Сообщение:</b>\n<blockquote>${escapeAndFitHtml(firstMessage.text, 500, 1200)}</blockquote>`;
  }

  const tid = String(ticket._id);
  const rows = [];
  if (ticket.status === 'open' || ticket.status === 'escalated') {
    rows.push([
      Markup.button.callback('✋ Взять в работу', `sp:take:${tid}`),
      Markup.button.callback('👁 Карточка', `sp:v:${tid}`),
    ]);
  } else if (ticket.status === 'in_progress') {
    rows.push([
      Markup.button.callback('👁 Карточка / Ответить', `sp:v:${tid}`),
    ]);
  } else {
    rows.push([
      Markup.button.callback('👁 История тикета', `sp:v:${tid}`),
    ]);
  }

  if (includeBotLink && botUsername) {
    rows.push([Markup.button.url('🤖 Открыть в ЛС бота', `https://t.me/${botUsername}?start=support`)]);
  }

  return { text, keyboard: Markup.inlineKeyboard(rows) };
};

const sendMediaMessage = async (bot, chatId, mediaType, mediaFileId, text, extra = {}) => {
  if (!mediaType || !mediaFileId) {
    return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
  }
  const caption = text && text.length <= 950 ? text : undefined;
  const mediaOpts = { parse_mode: 'HTML', ...(caption ? { caption } : {}), ...extra };

  let sent = null;
  if (mediaType === 'photo') {
    sent = await bot.telegram.sendPhoto(chatId, mediaFileId, mediaOpts);
  } else if (mediaType === 'video') {
    sent = await bot.telegram.sendVideo(chatId, mediaFileId, mediaOpts);
  } else if (mediaType === 'document') {
    sent = await bot.telegram.sendDocument(chatId, mediaFileId, mediaOpts);
  } else {
    return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
  }

  if (!caption && text) {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
  }
  return sent;
};

const findFallbackStaffRecipients = async () => {
  let staff = await User.find({
    role: { $in: ['support', 'moderator'] },
    supportOnDuty: { $ne: false },
    isBanned: { $ne: true },
  }).select('telegramId').lean();

  if (staff.length === 0) {
    staff = await User.find({
      role: { $in: ['support', 'moderator'] },
      isBanned: { $ne: true },
    }).select('telegramId').lean();
  }

  if (staff.length === 0) {
    staff = await User.find({
      role: { $in: ['admin', 'superadmin'] },
      supportOnDuty: { $ne: false },
      isBanned: { $ne: true },
    }).select('telegramId').lean();
  }

  const ids = [...new Set(staff.map((s) => Number(s.telegramId)).filter(Boolean))];
  if (ids.length === 0 && Array.isArray(ADMIN_IDS) && ADMIN_IDS.length > 0) {
    return [...new Set(ADMIN_IDS.map(Number).filter(Boolean))];
  }
  return ids;
};

const notifyNewTicket = async (ticket, buyerUser = null, firstMessage = null) => {
  const bot = getBot();
  if (!bot || !ticket) return { ok: false, mode: 'none' };

  const settings = await getSettings();
  const botUsername = await resolveBotUsername(bot);

  if (settings?.supportChatId) {
    let groupChatId = Number(settings.supportChatId);
    const { text, keyboard } = buildStaffCard(ticket, buyerUser, firstMessage, botUsername, true);
    const sendGroupCard = async (targetChatId) => {
      const sent = await bot.telegram.sendMessage(targetChatId, text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
      await SupportTicket.updateOne(
        { _id: ticket._id },
        { $set: { groupChatId: targetChatId, groupMessageId: sent.message_id } }
      );
      if (firstMessage?.mediaType && firstMessage?.mediaFileId) {
        await sendMediaMessage(
          bot,
          targetChatId,
          firstMessage.mediaType,
          firstMessage.mediaFileId,
          `📎 Вложение к обращению #${escapeHtml(ticket.ticketNumber)}`,
          { reply_to_message_id: sent.message_id }
        ).catch(() => {});
      }
      return { ok: true, mode: 'group', chatId: targetChatId, messageId: sent.message_id };
    };

    try {
      return await sendGroupCard(groupChatId);
    } catch (err) {
      const migratedId = extractMigrateToChatId(err);
      if (migratedId) {
        await persistMigratedSupportChat(groupChatId, migratedId);
        groupChatId = migratedId;
        try {
          return await sendGroupCard(groupChatId);
        } catch (retryErr) {
          logger.warn(`[supportNotify] Повтор в мигрированный чат ${groupChatId} не удался: ${retryErr.message}`);
        }
      } else {
        logger.warn(`[supportNotify] Не удалось отправить тикет в чат ${groupChatId}, fallback на ЛС: ${err.message}`);
      }
    }
  }

  // Fallback / стандартный режим: ДМ дежурным support/moderator
  const recipients = await findFallbackStaffRecipients();
  const { text, keyboard } = buildStaffCard(ticket, buyerUser, firstMessage, botUsername, false);
  const staffNotifyMessages = [];

  for (const chatId of recipients) {
    try {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
      staffNotifyMessages.push({ chatId, messageId: sent.message_id });
      if (firstMessage?.mediaType && firstMessage?.mediaFileId) {
        await sendMediaMessage(
          bot,
          chatId,
          firstMessage.mediaType,
          firstMessage.mediaFileId,
          `📎 Вложение к #${escapeHtml(ticket.ticketNumber)}`,
          { reply_to_message_id: sent.message_id }
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn(`[supportNotify] Не удалось отправить тикет сотруднику ${chatId}: ${err.message}`);
    }
  }

  if (staffNotifyMessages.length > 0) {
    await SupportTicket.updateOne(
      { _id: ticket._id },
      { $set: { staffNotifyMessages } }
    ).catch(() => {});
  }

  return { ok: true, mode: 'dm', count: staffNotifyMessages.length };
};

const syncTicketCardInChats = async (ticketOrId) => {
  const bot = getBot();
  if (!bot || !ticketOrId) return;

  const ticketId = ticketOrId._id || ticketOrId;
  const ticket = await SupportTicket.findById(ticketId)
    .populate('userId', 'telegramId username firstName')
    .populate('assignedTo', 'telegramId username firstName role')
    .lean();
  if (!ticket) return;

  const firstMessage = await SupportMessage.findOne({ ticketId: ticket._id })
    .sort({ createdAt: 1 })
    .lean();

  const botUsername = await resolveBotUsername(bot);

  if (ticket.groupChatId && ticket.groupMessageId) {
    const { text, keyboard } = buildStaffCard(ticket, ticket.userId, firstMessage, botUsername, true);
    await bot.telegram.editMessageText(
      ticket.groupChatId,
      ticket.groupMessageId,
      undefined,
      text,
      { parse_mode: 'HTML', ...keyboard }
    ).catch((err) => {
      if (!String(err?.description || err?.message || '').includes('message is not modified')) {
        logger.warn(`[supportNotify] sync group card error: ${err.message}`);
      }
    });
  }

  if (Array.isArray(ticket.staffNotifyMessages) && ticket.staffNotifyMessages.length > 0) {
    const { text, keyboard } = buildStaffCard(ticket, ticket.userId, firstMessage, botUsername, false);
    for (const ref of ticket.staffNotifyMessages) {
      if (!ref?.chatId || !ref?.messageId) continue;
      await bot.telegram.editMessageText(
        ref.chatId,
        ref.messageId,
        undefined,
        text,
        { parse_mode: 'HTML', ...keyboard }
      ).catch(() => {});
    }
  }
};

const notifyBuyerStaffReply = async (ticket, staffUser, msg) => {
  const bot = getBot();
  if (!bot || !ticket) return;

  const buyerChatId = ticket.telegramId || ticket.userId?.telegramId;
  if (!buyerChatId) return;

  const roleLabels = {
    support: 'Оператор поддержки',
    moderator: 'Модератор',
    admin: 'Администратор',
    superadmin: 'Главный администратор',
  };
  const roleLabel = roleLabels[staffUser?.role] || 'Сотрудник поддержки';
  const tid = String(ticket._id);

  const text =
    `💬 <b>Ответ поддержки по обращению #${escapeHtml(ticket.ticketNumber)}</b>\n` +
    `🎧 <i>${escapeHtml(roleLabel)}</i>\n\n` +
    `${escapeAndFitHtml(msg?.text || '', 1800, 3200)}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💬 Ответить', `sup:re:${tid}`),
      Markup.button.callback('✅ Вопрос решён', `sup:cl:${tid}`),
    ],
    [Markup.button.callback('📋 Открыть обращение', `sup:v:${tid}`)],
  ]);

  try {
    await sendMediaMessage(bot, buyerChatId, msg?.mediaType, msg?.mediaFileId, text, keyboard);
  } catch (err) {
    logger.warn(`[supportNotify] notifyBuyerStaffReply error (${buyerChatId}): ${err.message}`);
  }
};

const notifyStaffBuyerReply = async (ticket, buyerUser, msg) => {
  const bot = getBot();
  if (!bot || !ticket) return;

  const buyer = buyerUser || (typeof ticket.userId === 'object' ? ticket.userId : null);
  const buyerLabel = formatUserLabel(buyer, ticket.telegramId);
  const tid = String(ticket._id);

  const text =
    `📨 <b>Ответ покупателя по #${escapeHtml(ticket.ticketNumber)}</b>\n` +
    `👤 <b>От:</b> ${buyerLabel} (<code>${escapeHtml(ticket.telegramId)}</code>)\n\n` +
    `${escapeAndFitHtml(msg?.text || '', 1800, 3200)}`;

  const buttons = ticket.assignedTo
    ? [[Markup.button.callback('👁 Открыть и ответить', `sp:v:${tid}`)]]
    : [[
        Markup.button.callback('✋ Взять', `sp:take:${tid}`),
        Markup.button.callback('👁 Открыть', `sp:v:${tid}`),
      ]];
  const keyboard = Markup.inlineKeyboard(buttons);

  if (ticket.assignedTelegramId) {
    try {
      await sendMediaMessage(bot, ticket.assignedTelegramId, msg?.mediaType, msg?.mediaFileId, text, keyboard);
      return;
    } catch (err) {
      logger.warn(`[supportNotify] notifyStaffBuyerReply DM error: ${err.message}`);
    }
  }

  const settings = await getSettings();
  if (settings?.supportChatId) {
    const groupChatId = Number(settings.supportChatId);
    try {
      await sendMediaMessage(bot, groupChatId, msg?.mediaType, msg?.mediaFileId, text, {
        ...keyboard,
        ...(ticket.groupMessageId ? { reply_to_message_id: ticket.groupMessageId } : {}),
      });
      return;
    } catch (err) {
      const migratedId = extractMigrateToChatId(err);
      if (migratedId) {
        await persistMigratedSupportChat(groupChatId, migratedId);
        try {
          await sendMediaMessage(bot, migratedId, msg?.mediaType, msg?.mediaFileId, text, keyboard);
          return;
        } catch (retryErr) {
          logger.warn(`[supportNotify] notifyStaffBuyerReply migrated group error: ${retryErr.message}`);
        }
      } else {
        logger.warn(`[supportNotify] notifyStaffBuyerReply group error: ${err.message}`);
      }
    }
  }

  const recipients = await findFallbackStaffRecipients();
  for (const chatId of recipients) {
    try {
      await sendMediaMessage(bot, chatId, msg?.mediaType, msg?.mediaFileId, text, keyboard);
    } catch (_) {}
  }
};

const notifyEscalation = async (ticket, staffUser, reason = '') => {
  const bot = getBot();
  if (!bot || !ticket) return;

  await syncTicketCardInChats(ticket).catch(() => {});

  const supervisors = await User.find({
    role: { $in: ['moderator', 'admin', 'superadmin'] },
    isBanned: { $ne: true },
  }).select('telegramId').lean();

  const recipientIds = [...new Set([
    ...supervisors.map((u) => Number(u.telegramId)),
    ...(Array.isArray(SUPERADMIN_IDS) ? SUPERADMIN_IDS.map(Number) : []),
    ...(Array.isArray(ADMIN_IDS) ? ADMIN_IDS.map(Number) : []),
  ].filter(Boolean))];

  const tid = String(ticket._id);
  const staffLabel = formatUserLabel(staffUser, staffUser?.telegramId);
  const cleanReason = reason || ticket.escalationReason || 'Не указана';

  const text =
    `🔺 <b>ЭСКАЛАЦИЯ тикета #${escapeHtml(ticket.ticketNumber)}</b>\n\n` +
    `📂 <b>Тема:</b> ${escapeHtml(ticket.topicLabel || ticket.topic || 'Общий вопрос')}\n` +
    `👤 <b>Передал:</b> ${staffLabel}\n` +
    `📝 <b>Причина:</b> <i>${escapeAndFitHtml(cleanReason, 1800, 3200)}</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✋ Взять в работу', `sp:take:${tid}`),
      Markup.button.callback('👁 Открыть', `sp:v:${tid}`),
    ],
  ]);

  for (const chatId of recipientIds) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      logger.warn(`[supportNotify] notifyEscalation error (${chatId}): ${err.message}`);
    }
  }
};

const notifyTicketClosedToBuyer = async (ticket) => {
  const bot = getBot();
  if (!bot || !ticket) return;

  const buyerChatId = ticket.telegramId || ticket.userId?.telegramId;
  if (!buyerChatId) return;

  const reasonText = CLOSE_REASON_LABELS[ticket.closeReason] || 'Обращение закрыто';
  const tid = String(ticket._id);

  const text =
    `✅ <b>Обращение #${escapeHtml(ticket.ticketNumber)} закрыто</b>\n` +
    `📌 <b>Причина:</b> ${escapeHtml(reasonText)}\n\n` +
    `⭐ <i>Пожалуйста, оцените качество работы поддержки:</i>`;

  const ratingButtons = [1, 2, 3, 4, 5].map((n) =>
    Markup.button.callback(`${n}⭐`, `sup:rt:${tid}:${n}`)
  );

  try {
    await bot.telegram.sendMessage(buyerChatId, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([ratingButtons]),
    });
  } catch (err) {
    logger.warn(`[supportNotify] notifyTicketClosedToBuyer error (${buyerChatId}): ${err.message}`);
  }
};

const notifySlaReminder = async (ticket) => {
  const bot = getBot();
  if (!bot || !ticket) return;

  const settings = await getSettings();
  const waitMins = Math.max(1, Math.floor((Date.now() - new Date(ticket.createdAt).getTime()) / 60000));
  const tid = String(ticket._id);

  const text =
    `⏰ <b>SLA-напоминание!</b>\n\n` +
    `Тикет <b>#${escapeHtml(ticket.ticketNumber)}</b> ожидает ответа уже <b>${waitMins} мин.</b>\n` +
    `📂 <b>Тема:</b> ${escapeHtml(ticket.topicLabel || ticket.topic || 'Общий вопрос')}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✋ Взять в работу', `sp:take:${tid}`),
      Markup.button.callback('👁 Открыть', `sp:v:${tid}`),
    ],
  ]);

  if (settings?.supportChatId) {
    const groupChatId = Number(settings.supportChatId);
    try {
      await bot.telegram.sendMessage(groupChatId, text, {
        parse_mode: 'HTML',
        ...keyboard,
        ...(ticket.groupMessageId ? { reply_to_message_id: ticket.groupMessageId } : {}),
      });
      return;
    } catch (err) {
      const migratedId = extractMigrateToChatId(err);
      if (migratedId) {
        await persistMigratedSupportChat(groupChatId, migratedId);
        try {
          await bot.telegram.sendMessage(migratedId, text, {
            parse_mode: 'HTML',
            ...keyboard,
          });
          return;
        } catch (retryErr) {
          logger.warn(`[supportNotify] notifySlaReminder migrated group error: ${retryErr.message}`);
        }
      } else {
        logger.warn(`[supportNotify] notifySlaReminder group error: ${err.message}`);
      }
    }
  }

  const recipients = await findFallbackStaffRecipients();
  for (const chatId of recipients) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
    } catch (_) {}
  }
};

const notifyOwnerRoleChange = async ({ actorUser, targetUser, oldRole, newRole, reason = '' }) => {
  const bot = getBot();
  if (!bot || !targetUser) return;

  let ownerIds = Array.isArray(SUPERADMIN_IDS) ? SUPERADMIN_IDS.map(Number).filter(Boolean) : [];
  if (ownerIds.length === 0) {
    const dbOwners = await User.find({ role: 'superadmin' }).select('telegramId').lean();
    ownerIds = dbOwners.map((u) => Number(u.telegramId)).filter(Boolean);
  }
  ownerIds = [...new Set(ownerIds)];

  const targetLabel = formatUserLabel(targetUser, targetUser.telegramId);
  const actorLabel = formatUserLabel(actorUser, actorUser?.telegramId);

  let text =
    `🛡 <b>Изменение роли сотрудника</b>\n\n` +
    `👤 <b>Пользователь:</b> ${targetLabel} (<code>${escapeHtml(targetUser.telegramId)}</code>)\n` +
    `📊 <b>Роль:</b> <code>${escapeHtml(oldRole)}</code> → <code>${escapeHtml(newRole)}</code>\n` +
    `👮 <b>Изменил:</b> ${actorLabel} (<code>${escapeHtml(actorUser?.telegramId || '')}</code>)`;

  if (reason) {
    text += `\n📝 <b>Причина:</b> <i>${escapeHtml(reason)}</i>`;
  }

  for (const ownerId of ownerIds) {
    try {
      await bot.telegram.sendMessage(ownerId, text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.warn(`[supportNotify] notifyOwnerRoleChange error (${ownerId}): ${err.message}`);
    }
  }
};

module.exports = {
  setBot,
  setBotUsername,
  notifyNewTicket,
  syncTicketCardInChats,
  notifyBuyerStaffReply,
  notifyStaffBuyerReply,
  notifyEscalation,
  notifyTicketClosedToBuyer,
  notifySlaReminder,
  notifyOwnerRoleChange,
};

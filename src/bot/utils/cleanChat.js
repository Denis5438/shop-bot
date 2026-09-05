const { getSettings } = require('../../services/settingsCache.service');

/**
 * Проверяет, включён ли режим 'Чистый чат' в настройках бота.
 */
const isCleanChatEnabled = async () => {
  try {
    const settings = await getSettings();
    return Boolean(settings?.cleanChatEnabled);
  } catch (_) {
    return false;
  }
};

/**
 * Удаляет предыдущее сохранённое сообщение бота и (при наличии) команду пользователя.
 */
const cleanPreviousBotMessage = async (ctx) => {
  if (!ctx || !ctx.chat?.id) return;
  const enabled = await isCleanChatEnabled();
  if (!enabled) return;

  // Если это команда (начинается со слэша /start, /menu), удаляем её сообщение
  if (ctx.message?.message_id && typeof ctx.message.text === 'string' && ctx.message.text.startsWith('/')) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  // Удаляем предыдущее сообщение меню бота
  if (ctx.session?.lastBotMsgId) {
    const oldId = ctx.session.lastBotMsgId;
    ctx.session.lastBotMsgId = null;
    ctx.telegram.deleteMessage(ctx.chat.id, oldId).catch(() => {});
  }
};

/**
 * Сохраняет ID последнего отправленного меню бота в сессии пользователя.
 */
const saveBotMessage = (ctx, msgId) => {
  if (!ctx || !msgId) return;
  ctx.session = ctx.session || {};
  ctx.session.lastBotMsgId = msgId;
};

module.exports = {
  isCleanChatEnabled,
  cleanPreviousBotMessage,
  saveBotMessage,
};

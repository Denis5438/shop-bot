const RequiredChannel = require('../../models/RequiredChannel');
const { getSettings } = require('../../services/settingsCache.service');

/**
 * Проверяет подписку пользователя на ВСЕ активные обязательные каналы.
 * Возвращает объект:
 * {
 *   isEnabled: boolean, // Включена ли ОП в целом
 *   allSubscribed: boolean, // Подписан ли юзер на ВСЕ каналы
 *   results: Array<{ channel, isSubscribed: boolean }>
 * }
 */
const checkUserSubscriptions = async (telegram, userId) => {
  const settings = await getSettings();
  if (!settings?.requiredChannelsEnabled) {
    return { isEnabled: false, allSubscribed: true, results: [] };
  }

  const channels = await RequiredChannel.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
  if (!channels.length) {
    return { isEnabled: true, allSubscribed: true, results: [] };
  }

  const results = [];
  let allSubscribed = true;

  for (const ch of channels) {
    let isSubscribed = false;
    try {
      const member = await telegram.getChatMember(ch.chatId, userId);
      isSubscribed = Boolean(member && ['creator', 'administrator', 'member', 'restricted'].includes(member.status));
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      // Если пользователь явно не состоит в канале или не найден в чате
      if (
        msg.includes('user not found') ||
        msg.includes('participant_id_invalid') ||
        msg.includes('user_not_participant')
      ) {
        isSubscribed = false;
      } else if (msg.includes('chat not found') || msg.includes('bot was kicked') || msg.includes('not enough rights') || msg.includes('forbidden')) {
        // Если у самого бота нет прав на канал - не блокируем пользователя наглухо
        console.warn(`[ChannelCheck] Bot lacks access to channel ${ch.chatId}: ${err.message}`);
        isSubscribed = true;
      } else {
        console.warn(`[ChannelCheck] Error checking subscription for chat ${ch.chatId} user ${userId}: ${err.message}`);
        isSubscribed = false;
      }
    }

    if (isSubscribed) {
      recordChannelSubscription(ch._id, userId);
    } else {
      allSubscribed = false;
    }

    results.push({ channel: ch, isSubscribed });
  }

  return { isEnabled: true, allSubscribed, results };
};

const recordChannelSubscription = async (channelId, userId) => {
  const strUserId = String(userId);
  await RequiredChannel.findOneAndUpdate(
    { _id: channelId, verifiedUserIds: { $ne: strUserId } },
    {
      $addToSet: { verifiedUserIds: strUserId },
      $inc: { subscribersCount: 1 },
    }
  ).catch((err) => console.warn(`[ChannelCheck] Failed to record subscription: ${err.message}`));
};

module.exports = { checkUserSubscriptions };

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
      isSubscribed = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
    } catch (err) {
      console.warn(`[ChannelCheck] Failed to check status for chat ${ch.chatId} user ${userId}:`, err.message);
      // Если у бота нет доступа или ID канала неверный — не блокируем наглухо, считаем временно подписанным
      isSubscribed = true;
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

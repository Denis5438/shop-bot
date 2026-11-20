const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const logger = require('../config/logger');
const notif = require('./notification.service');
const { getSettings } = require('./settingsCache.service');
const { withTransaction } = require('./transactionHelper.service');

/**
 * Выдаёт реферальный бонус (если применимо) и проверяет достижения
 * как для покупателя, так и для реферера.
 *
 * Это единая «точка после completed-заказа». Вызывается из всех мест,
 * где заказ переходит в `completed`. Благодаря идемпотентности обоих
 * сервисов - повторные вызовы безопасны.
 */
const grantReferralBonusForFirstCompletedOrder = async (userId) => {
  let result = { granted: false, reason: 'not_eligible' };

  try {
    const settings = await getSettings();
    const bonusAmount = Number(settings?.referralBonus || 0.5);

    if (!bonusAmount || bonusAmount <= 0) {
      try {
        const { checkAndGrantAchievements } = require('./achievements.service');
        await checkAndGrantAchievements(userId);
      } catch (_) {}
      return { granted: false, reason: 'disabled' };
    }

    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      const user = await User.findById(userId, null, sessionOptions);
      if (!user || !user.referredBy || user.referralBonusGrantedAt) {
        result = { granted: false, reason: 'not_eligible' };
        return;
      }

      // [SEC-CAT-04] Anti-Sybil protection: referral bonus requires at least one completed order >= 3.00 USDT
      const qualifyingOrder = await Order.findOne(
        { userId: user._id, status: 'completed', price: { $gte: 3.00 } },
        null,
        sessionOptions
      );

      if (!qualifyingOrder) {
        result = { granted: false, reason: 'order_below_threshold' };
        return;
      }

      const claimedUser = await User.findOneAndUpdate(
        {
          _id: user._id,
          referredBy: { $ne: null },
          referralBonusGrantedAt: null,
        },
        {
          $set: { referralBonusGrantedAt: new Date() },
        },
        {
          new: false,
          ...sessionOptions,
        }
      );

      if (!claimedUser) {
        result = { granted: false, reason: 'already_granted' };
        return;
      }

      // Атомарный $inc: read-modify-write через save() терял параллельные
      // начисления двум рефералам одного реферера (last-write-wins).
      const referrer = await User.findOneAndUpdate(
        { _id: claimedUser.referredBy },
        { $inc: { balance: bonusAmount } },
        { new: true, ...(sessionOptions || {}) }
      );
      if (!referrer) {
        await User.updateOne(
          { _id: user._id },
          { $set: { referralBonusGrantedAt: null } },
          sessionOptions
        );
        result = { granted: false, reason: 'referrer_not_found' };
        return;
      }

      await new Transaction({
        userId: referrer._id,
        type: 'referral_bonus',
        amount: bonusAmount,
        description: `Реферальный бонус за первую покупку пользователя ${claimedUser.telegramId}`,
      }).save(sessionOptions);

      result = {
        granted: true,
        amount: bonusAmount,
        referrerId: referrer._id,
        referrerTelegramId: referrer.telegramId,
        referrerBalance: referrer.balance,
        referredTelegramId: claimedUser.telegramId,
      };
    });

    if (result.granted && result.referrerTelegramId) {
      // Сброс кэша middleware - бонус должен быть виден рефереру сразу
      try {
        require('../bot/middlewares/user').invalidateUserCache(result.referrerTelegramId);
      } catch (_) {}
      await notif.sendToUser(
        result.referrerTelegramId,
        `🎁 <b>Реферальный бонус начислен!</b>\n\n` +
        `👤 Ваш реферал <code>${result.referredTelegramId}</code> завершил первую покупку.\n` +
        `💰 Начислено: <b>+${result.amount.toFixed(2)} USDT</b>\n` +
        `💳 Новый баланс: <b>${result.referrerBalance.toFixed(2)} USDT</b>`
      );
    }

    // №20 Достижения: проверяем ачивки и для покупателя, и для реферера
    // (у обоих мог измениться прогресс). Ошибки не ломают основной flow.
    try {
      const { checkAndGrantAchievements } = require('./achievements.service');
      await checkAndGrantAchievements(userId);
      if (result.granted) {
        if (result.referrerId) {
          await checkAndGrantAchievements(result.referrerId);
        } else if (result.referrerTelegramId) {
          const referrerUser = await User.findOne({ telegramId: result.referrerTelegramId });
          if (referrerUser) {
            await checkAndGrantAchievements(referrerUser._id);
          }
        }
      }
    } catch (err) {
      logger.error(`[Referral] achievements check failed: ${err.message}`);
    }

    return result;
  } catch (err) {
    logger.error(`Referral bonus error for user ${userId}: ${err.message}`, { stack: err.stack });
    return { granted: false, reason: 'error' };
  }
};

module.exports = { grantReferralBonusForFirstCompletedOrder };

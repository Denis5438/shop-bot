const { Markup } = require('telegraf');
const User = require('../../models/User');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { escapeHtml, safeEdit } = require('../utils/ui');

const mongoose = require('mongoose');

/**
 * Получение расширенной реферальной статистики пользователя:
 * - referralsCount: всего приглашено
 * - activeBuyersCount: совершили хотя бы одну completed покупку
 * - conversionPct: процент конверсии в покупки
 * - totalEarned: заработано с реферальных бонусов (USDT)
 */
const getReferralStats = async (userId) => {
  if (!userId) {
    return {
      referralsCount: 0,
      activeBuyersCount: 0,
      conversionPct: 0,
      totalEarned: 0,
    };
  }

  const referrals = await User.find({ referredBy: userId }).select('_id').lean();
  const referralsCount = referrals.length;
  const referralIds = referrals.map((r) => r._id);

  const activeBuyersCount = referralIds.length > 0
    ? (await Order.distinct('userId', { userId: { $in: referralIds }, status: 'completed' })).length
    : 0;

  const conversionPct = referralsCount > 0
    ? Math.round((activeBuyersCount / referralsCount) * 100)
    : 0;

  const userObjectId = mongoose.Types.ObjectId.isValid(userId)
    ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
    : userId;

  const earned = await Transaction.aggregate([
    { $match: { userId: userObjectId, type: 'referral_bonus' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalEarned = Math.abs(earned[0]?.total || 0);

  return {
    referralsCount,
    activeBuyersCount,
    conversionPct,
    totalEarned,
  };
};

const showReferral = async (ctx) => {
  const user = ctx.user;
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  let botUsername = ctx.botInfo?.username;
  if (!botUsername) {
    try {
      const botInfo = await ctx.telegram.getMe();
      botUsername = botInfo?.username;
    } catch (_) {}
  }
  const refCode = user.referralCode || '';
  const link = `https://t.me/${botUsername || 'bot'}?start=${refCode}`;

  const [{ referralsCount, activeBuyersCount, conversionPct, totalEarned }, freshUser] = await Promise.all([
    getReferralStats(user._id),
    User.findById(user._id).select('balance').lean().catch(() => null),
  ]);

  const settings = await getSettings();
  const refBonus = settings?.referralBonus || 0.5;

  const balance = typeof freshUser?.balance === 'number'
    ? freshUser.balance
    : (typeof user.balance === 'number' ? user.balance : 0);
  const balanceStr = `${balance.toFixed(2)} USDT (~${toRub(balance)} ₽)`;

  const conversionStr = lang === 'en'
    ? `${activeBuyersCount} of ${referralsCount} (${conversionPct}%)`
    : `${activeBuyersCount} из ${referralsCount} (${conversionPct}%)`;

  const title = lang === 'en' ? 'Referral Program' : 'Реферальная программа';
  const yourLink = lang === 'en' ? 'Your personal link' : 'Ваша пригласительная ссылка';
  const bonusLine = lang === 'en'
    ? `Bonus per 1st referral purchase: <b>+${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`
    : `Бонус за первую покупку друга: <b>+${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`;
  const invitedLine = lang === 'en'
    ? `Invited friends: <b>${referralsCount}</b>`
    : `Приглашено друзей: <b>${referralsCount}</b>`;
  const buyersLine = lang === 'en'
    ? `Active buyers: <b>${activeBuyersCount}</b>`
    : `Совершили покупки: <b>${activeBuyersCount}</b>`;
  const conversionLine = lang === 'en'
    ? `Order conversion: <b>${conversionStr}</b>`
    : `Конверсия в заказы: <b>${conversionStr}</b>`;
  const earnedLine = lang === 'en'
    ? `Total earned from referrals: <b>${totalEarned.toFixed(2)} USDT</b> (~${toRub(totalEarned)} ₽)`
    : `Заработано с рефералов: <b>${totalEarned.toFixed(2)} USDT</b> (~${toRub(totalEarned)} ₽)`;
  const balanceLine = lang === 'en'
    ? `Your current balance: <b>${balanceStr}</b>`
    : `Ваш текущий баланс: <b>${balanceStr}</b>`;
  const footer = lang === 'en'
    ? '<i>Send your link to friends. Bonus is credited automatically after their first purchase.</i>'
    : '<i>Отправьте ссылку друзьям. Бонус начисляется сразу после первой покупки приглашённого пользователя.</i>';

  const text =
    `🎁 <b>${title}</b>\n\n` +
    `🔗 <b>${yourLink}:</b>\n<code>${escapeHtml(link)}</code>\n\n` +
    `<blockquote>💸 ${bonusLine}\n` +
    `👥 ${invitedLine}\n` +
    `🛍 ${buyersLine}\n` +
    `📊 ${conversionLine}\n` +
    `💰 ${earnedLine}\n` +
    `💳 ${balanceLine}</blockquote>\n\n` +
    footer;

  const shareText = encodeURIComponent(lang === 'en' ? 'Get licensed keys & subscriptions with instant delivery!' : 'Покупай лицензионные подписки и ключи с моментальной выдачей!');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${shareText}`;

  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([
      [Markup.button.url(lang === 'en' ? '📤 Share Link' : '📤 Поделиться ссылкой', shareUrl)],
      [Markup.button.callback(t('btn_back'), 'menu:main')],
    ]),
  };

  await safeEdit(ctx, text, extra);
};

module.exports = {
  showReferral,
  getReferralStats,
  giveReferralBonus: grantReferralBonusForFirstCompletedOrder,
};

const { Markup } = require('telegraf');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { escapeHtml } = require('../utils/ui');

const showReferral = async (ctx) => {
  const user = ctx.user;
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${user.referralCode}`;

  const referralsCount = await User.countDocuments({ referredBy: user._id });
  const earned = await Transaction.aggregate([
    { $match: { userId: user._id, type: 'referral_bonus' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalEarned = Math.abs(earned[0]?.total || 0);

  const settings = await getSettings();
  const refBonus = settings?.referralBonus || 0.5;

  const title = lang === 'en' ? 'Referral Program' : 'Реферальная программа';
  const yourLink = lang === 'en' ? 'Your link' : 'Ваша ссылка';
  const bonusLine = lang === 'en'
    ? `Bonus for first completed referral purchase: <b>${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`
    : `Бонус за первую завершённую покупку реферала: <b>${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`;
  const invitedLine = lang === 'en' ? `Invited: ${referralsCount}` : `Приглашено: ${referralsCount}`;
  const earnedLine = lang === 'en' ? `Earned: ${totalEarned.toFixed(2)} USDT` : `Заработано: ${totalEarned.toFixed(2)} USDT`;
  const footer = lang === 'en'
    ? 'Share your link with friends. The bonus is credited automatically after the first completed purchase of an invited user.'
    : 'Поделитесь ссылкой с друзьями. Бонус начисляется автоматически после первой завершённой покупки приглашённого пользователя.';

  const text =
    `🎁 <b>${title}</b>\n\n` +
    `🔗 ${yourLink}:\n<code>${escapeHtml(link)}</code>\n\n` +
    `💸 ${bonusLine}\n\n` +
    `👥 ${invitedLine}\n` +
    `💰 ${earnedLine}\n\n` +
    footer;

  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([[Markup.button.callback(t('btn_back'), 'menu:main')]]),
  };

  try {
    await ctx.editMessageText(text, extra);
  } catch (_) {
    await ctx.reply(text, extra);
  }
};

module.exports = {
  showReferral,
  giveReferralBonus: grantReferralBonusForFirstCompletedOrder,
};

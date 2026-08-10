const { Markup } = require('telegraf');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { escapeHtml, safeEdit } = require('../utils/ui');

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
  const yourLink = lang === 'en' ? 'Your personal link' : 'Ваша пригласительная ссылка';
  const bonusLine = lang === 'en'
    ? `Bonus per 1st referral purchase: <b>+${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`
    : `Бонус за первую покупку друга: <b>+${refBonus} USDT</b> (~${toRub(refBonus)} ₽)`;
  const invitedLine = lang === 'en' ? `Invited friends: <b>${referralsCount}</b>` : `Приглашено друзей: <b>${referralsCount}</b>`;
  const earnedLine = lang === 'en' ? `Total earned: <b>${totalEarned.toFixed(2)} USDT</b>` : `Всего заработано: <b>${totalEarned.toFixed(2)} USDT</b>`;
  const footer = lang === 'en'
    ? '<i>Send your link to friends. Bonus is credited automatically after their first purchase.</i>'
    : '<i>Отправьте ссылку друзьям. Бонус начисляется сразу после первой покупки приглашённого пользователя.</i>';

  const text =
    `🎁 <b>${title}</b>\n\n` +
    `🔗 <b>${yourLink}:</b>\n<code>${escapeHtml(link)}</code>\n\n` +
    `<blockquote>💸 ${bonusLine}\n` +
    `👥 ${invitedLine}\n` +
    `💰 ${earnedLine}</blockquote>\n\n` +
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
  giveReferralBonus: grantReferralBonusForFirstCompletedOrder,
};

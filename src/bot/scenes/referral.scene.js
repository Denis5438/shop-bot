const { Markup } = require('telegraf');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { escapeHtml } = require('../utils/ui');

const showReferral = async (ctx) => {
  const user = ctx.user;
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

  const text =
    `🎁 <b>Реферальная программа</b>\n\n` +
    `🔗 Ваша ссылка:\n<code>${escapeHtml(link)}</code>\n\n` +
    `💸 Бонус за первую завершённую покупку реферала: <b>${refBonus} USDT</b> (~${toRub(refBonus)} ₽)\n\n` +
    `👥 Приглашено: ${referralsCount}\n` +
    `💰 Заработано: ${totalEarned.toFixed(2)} USDT\n\n` +
    `Поделитесь ссылкой с друзьями. Бонус начисляется автоматически после первой завершённой покупки приглашённого пользователя.`;

  const extra = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:main')]]),
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

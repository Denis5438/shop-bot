const { Markup } = require('telegraf');
const { adminMainKeyboard } = require('../../keyboards/admin.keyboard');
const Order = require('../../../models/Order');
const TopupRequest = require('../../../models/TopupRequest');
const SellerWithdrawal = require('../../../models/SellerWithdrawal');
const User = require('../../../models/User');

const showAdminMain = async (ctx) => {
  const pendingOrders = await Order.countDocuments({
    status: { $in: ['pending', 'awaiting_confirmation'] },
  });
  const pendingPayments = await TopupRequest.countDocuments({ status: 'pending' });
  const pendingSellerWithdrawals = await SellerWithdrawal.countDocuments({ status: 'pending' });
  const pendingDisputes = await Order.countDocuments({ status: 'disputed' });

  // Статистика за сегодня
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayOrders = await Order.countDocuments({ status: 'completed', confirmedAt: { $gte: todayStart } });
  const todayRevAgg = await Order.aggregate([
    { $match: { status: 'completed', confirmedAt: { $gte: todayStart } } },
    { $group: { _id: null, total: { $sum: '$price' } } },
  ]);
  const todayRevenue = (todayRevAgg[0]?.total || 0).toFixed(2);
  const newUsersToday = await User.countDocuments({ createdAt: { $gte: todayStart } });

  const sellerLine = pendingSellerWithdrawals > 0
    ? `\n💸 Заявки продавцов: <b>${pendingSellerWithdrawals}</b>`
    : '';
  const disputesLine = pendingDisputes > 0
    ? `\n⚠️ Активные споры: <b>${pendingDisputes}</b>`
    : '';

  const text =
    `👨‍💻 <b>Панель Управления</b>\n\n` +
    `<blockquote>💵 Продано за сегодня: <b>${todayRevenue} USDT</b>\n` +
    `📦 Заказов выполнено: <b>${todayOrders}</b>\n` +
    `🔴 Требуют внимания (заказы): <b>${pendingOrders}</b>\n` +
    `💳 Новые платежи: <b>${pendingPayments}</b>\n` +
    `👥 Новых юзеров: <b>${newUsersToday}</b>${sellerLine}${disputesLine}</blockquote>`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...adminMainKeyboard({ pendingOrders, pendingPayments, pendingSellerWithdrawals, pendingDisputes }),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...adminMainKeyboard({ pendingOrders, pendingPayments, pendingSellerWithdrawals, pendingDisputes }),
    });
  }
};

module.exports = { showAdminMain };

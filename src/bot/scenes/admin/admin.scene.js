const { Markup } = require('telegraf');
const { adminMainKeyboard } = require('../../keyboards/admin.keyboard');
const Order = require('../../../models/Order');
const TopupRequest = require('../../../models/TopupRequest');
const User = require('../../../models/User');

const showAdminMain = async (ctx) => {
  const pendingOrders = await Order.countDocuments({
    status: { $in: ['pending', 'awaiting_confirmation'] },
  });
  const pendingPayments = await TopupRequest.countDocuments({ status: 'pending' });

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

  const text =
    `👨‍💻 <b>Панель Управления</b>\n\n` +
    `<blockquote>💵 Продано за сегодня: <b>${todayRevenue} USDT</b>\n` +
    `📦 Заказов выполнено: <b>${todayOrders}</b>\n` +
    `🔴 Требуют внимания (заказы): <b>${pendingOrders}</b>\n` +
    `💳 Новые платежи: <b>${pendingPayments}</b>\n` +
    `👥 Новых юзеров: <b>${newUsersToday}</b></blockquote>`;

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...adminMainKeyboard({ pendingOrders, pendingPayments }) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...adminMainKeyboard({ pendingOrders, pendingPayments }) });
  }
};

module.exports = { showAdminMain };

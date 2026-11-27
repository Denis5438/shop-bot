const { adminMainKeyboard, moderatorMainKeyboard } = require('../../keyboards/admin.keyboard');
const Order = require('../../../models/Order');
const TopupRequest = require('../../../models/TopupRequest');
const SellerWithdrawal = require('../../../models/SellerWithdrawal');
const User = require('../../../models/User');
const SupportTicket = require('../../../models/SupportTicket');

const showAdminMain = async (ctx) => {
  // Модератор видит только безопасную сводку тикетов поддержки и ограниченную клавиатуру
  if (ctx.user?.role === 'moderator') {
    const [openCount, inProgressCount, escalatedCount, onDutyCount] = await Promise.all([
      SupportTicket.countDocuments({ status: 'open' }),
      SupportTicket.countDocuments({ status: 'in_progress' }),
      SupportTicket.countDocuments({ status: 'escalated' }),
      User.countDocuments({
        role: { $in: ['support', 'moderator'] },
        isBanned: { $ne: true },
        supportOnDuty: { $ne: false },
      }),
    ]);

    const text =
      `🛡 <b>Панель модератора</b>\n\n` +
      `<blockquote>⏳ Ожидают ответа: <b>${openCount}</b>\n` +
      `💬 В работе: <b>${inProgressCount}</b>\n` +
      `🔺 Эскалировано: <b>${escalatedCount}</b>\n` +
      `🟢 Саппортов на смене: <b>${onDutyCount}</b></blockquote>`;

    const keyboard = moderatorMainKeyboard({
      activeSupportTickets: openCount + escalatedCount,
    });

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (_) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    }
    return;
  }

  // Статистика за сегодня
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Все счётчики параллельно: раньше 9 последовательных запросов = сумма их
  // задержек на каждое открытие /admin
  const [
    pendingOrders,
    pendingPayments,
    pendingSellerWithdrawals,
    pendingDisputes,
    pendingWarranties,
    pendingPreorders,
    todayStats,
    newUsersToday,
    activeSupportTickets,
  ] = await Promise.all([
    Order.countDocuments({ status: { $in: ['pending', 'awaiting_confirmation'] } }),
    TopupRequest.countDocuments({ status: 'pending' }),
    SellerWithdrawal.countDocuments({ status: 'pending' }),
    Order.countDocuments({ status: 'disputed' }),
    Order.countDocuments({ replacementStatus: 'pending' }),
    Order.countDocuments({ status: 'preorder_pending' }),
    // Заказы и выручка за сегодня одной агрегацией
    Order.aggregate([
      { $match: { status: 'completed', confirmedAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$price' }, count: { $sum: 1 } } },
    ]),
    User.countDocuments({ createdAt: { $gte: todayStart } }),
    SupportTicket.countDocuments({ status: { $in: ['open', 'escalated'] } }),
  ]);

  const todayOrders = todayStats[0]?.count || 0;
  const todayRevenue = (todayStats[0]?.total || 0).toFixed(2);

  const preordersLine = pendingPreorders > 0
    ? `\n⏳ Ожидают предзаказов: <b>${pendingPreorders}</b>`
    : '';
  const sellerLine = pendingSellerWithdrawals > 0
    ? `\n💸 Заявки продавцов: <b>${pendingSellerWithdrawals}</b>`
    : '';
  const disputesLine = pendingDisputes > 0
    ? `\n⚠️ Активные споры: <b>${pendingDisputes}</b>`
    : '';
  const warrantiesLine = pendingWarranties > 0
    ? `\n🛡 Запросы замен по гарантии: <b>${pendingWarranties}</b>`
    : '';

  const text =
    `👨‍💻 <b>Панель Управления</b>\n\n` +
    `<blockquote>💵 Продано за сегодня: <b>${todayRevenue} USDT</b>\n` +
    `📦 Заказов выполнено: <b>${todayOrders}</b>\n` +
    `🔴 Требуют внимания (заказы): <b>${pendingOrders}</b>\n` +
    `💳 Новые платежи: <b>${pendingPayments}</b>\n` +
    `👥 Новых юзеров: <b>${newUsersToday}</b>${preordersLine}${sellerLine}${disputesLine}${warrantiesLine}</blockquote>`;

  const keyboard = adminMainKeyboard({
    pendingOrders,
    pendingPayments,
    pendingSellerWithdrawals,
    pendingDisputes,
    pendingWarranties,
    pendingPreorders,
    activeSupportTickets,
  });

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...keyboard,
    });
  }
};

module.exports = { showAdminMain };

const { Markup } = require('telegraf');
const axios = require('axios');
const Order = require('../../../models/Order');
const User = require('../../../models/User');
const Key = require('../../../models/Key');
const TopupRequest = require('../../../models/TopupRequest');
const Transaction = require('../../../models/Transaction');
const { toRub, getRate, getUpdatedAt } = require('../../../services/currency.service');
const { escapeHtml } = require('../../utils/ui');

// Вспомогательная функция: начало/конец периода
const getPeriodRange = (period) => {
  const now = new Date();
  let from;

  switch (period) {
    case 'day':
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week':
      const day = now.getDay() || 7;
      from = new Date(now);
      from.setDate(now.getDate() - day + 1);
      from.setHours(0, 0, 0, 0);
      break;
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'year':
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(0); // Всё время
  }

  return { from, to: now };
};

const PERIOD_LABELS = {
  day: 'Сегодня',
  week: 'Эта неделя',
  month: 'Этот месяц',
  year: 'Этот год',
  all: 'Всё время',
};

// Конвертация суммы в нужную валюту
const formatAmount = (usdt, currency) => {
  const rate = getRate();
  switch (currency) {
    case 'RUB': return `${Math.round(usdt * rate).toLocaleString('ru-RU')} ₽`;
    case 'USD': return `$${usdt.toFixed(2)}`;
    default: return `${usdt.toFixed(2)} USDT`;
  }
};

// Статистика (общая)
const showStats = async (ctx) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // Все счётчики параллельно (раньше - 11 последовательных запросов);
  // выручка всего/за месяц/за сегодня - одной агрегацией через $facet
  const [
    totalUsers,
    pendingOrders,
    orderStats,
    keyStats,
    approvedReplacements,
    rejectedReplacements,
  ] = await Promise.all([
    User.countDocuments(),
    Order.countDocuments({ status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation'] } }),
    Order.aggregate([
      { $match: { status: 'completed' } },
      {
        $facet: {
          total: [{ $group: { _id: null, total: { $sum: '$price' }, count: { $sum: 1 } } }],
          month: [
            { $match: { confirmedAt: { $gte: monthStart } } },
            { $group: { _id: null, total: { $sum: '$price' } } },
          ],
          today: [
            { $match: { confirmedAt: { $gte: today } } },
            { $count: 'count' },
          ],
        },
      },
    ]),
    Key.aggregate([
      { $group: { _id: '$isUsed', cnt: { $sum: 1 } } },
    ]),
    Order.countDocuments({ replacementStatus: 'approved' }),
    Order.countDocuments({ replacementStatus: 'rejected' }),
  ]);

  const totalOrders = orderStats[0]?.total[0]?.count || 0;
  const totalRevenue = orderStats[0]?.total[0]?.total || 0;
  const monthRevenue = orderStats[0]?.month[0]?.total || 0;
  const todayOrders = orderStats[0]?.today[0]?.count || 0;

  const keysFree = keyStats.find((k) => k._id === false)?.cnt || 0;
  const keysUsed = keyStats.find((k) => k._id === true)?.cnt || 0;
  const keysTotal = keysFree + keysUsed;

  const replacementRate = totalOrders > 0 ? ((approvedReplacements / totalOrders) * 100).toFixed(1) : '0';

  const text =
    `📊 <b>Статистика магазина</b>\n\n` +
    `👥 Всего пользователей: <b>${totalUsers}</b>\n` +
    `📦 Выполнено заказов: <b>${totalOrders}</b>\n` +
    `⏳ Ожидают обработки: <b>${pendingOrders}</b>\n` +
    `✅ Заказов сегодня: <b>${todayOrders}</b>\n\n` +
    `💰 Выручка всего: <b>${totalRevenue.toFixed(2)} USDT</b> (~${toRub(totalRevenue)} ₽)\n` +
    `💰 Выручка за месяц: <b>${monthRevenue.toFixed(2)} USDT</b> (~${toRub(monthRevenue)} ₽)\n\n` +
    `🔑 Ключей в базе: ${keysTotal} (свободных: ${keysFree})\n` +
    `🛡 Замен по гарантии: <b>${approvedReplacements}</b> (отклонено: ${rejectedReplacements})\n` +
    `📉 Процент замен / брака: <b>${replacementRate}%</b>\n\n` +
    `💱 Курс: 1 USD = ${getRate()} ₽ (обновлён ${getUpdatedAt()})`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📈 Логистика', 'admin:logistics')],
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📈 Логистика', 'admin:logistics')],
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  }
};

// Финансовая аналитика (логистика)
const showLogistics = async (ctx, period = 'month', currency = 'USDT') => {
  const { from, to } = getPeriodRange(period);

  // Все запросы периода параллельно (раньше - 5 последовательных)
  const [revenueAgg, refundAgg, newUsers, topupAgg, topProducts] = await Promise.all([
    // Выручка и закупка за период
    Order.aggregate([
      { $match: { status: 'completed', confirmedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$price' },
          cost: { $sum: '$costPrice' },
          count: { $sum: 1 },
        },
      },
    ]),
    // Возвраты за период
    Transaction.aggregate([
      { $match: { type: 'refund', createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    // Новые пользователи за период
    User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    // Пополнения за период
    TopupRequest.aggregate([
      { $match: { status: 'confirmed', processedAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    // Топ товаров за период
    Order.aggregate([
      { $match: { status: 'completed', confirmedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$productId',
          count: { $sum: 1 },
          revenue: { $sum: '$price' },
          cost: { $sum: '$costPrice' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
    ]),
  ]);

  const revenue = revenueAgg[0]?.revenue || 0;
  const cost = revenueAgg[0]?.cost || 0;
  const profit = revenue - cost;
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : '0.0';
  const count = revenueAgg[0]?.count || 0;

  const refunds = refundAgg[0]?.total || 0;
  const refundCount = refundAgg[0]?.count || 0;
  const topups = topupAgg[0]?.total || 0;

  // Средний чек
  const avgCheck = count > 0 ? (revenue / count).toFixed(2) : '0.00';

  const periodLabel = PERIOD_LABELS[period] || period;
  const currSymbol = currency === 'RUB' ? '₽' : currency === 'USD' ? '$' : 'USDT';

  let text =
    `📈 <b>Финансовая аналитика</b>\n` +
    `📅 Период: <b>${periodLabel}</b> | 💱 Валюта: <b>${currSymbol}</b>\n\n` +
    `┌───────────────────────────\n` +
    `│ 💸 Закуплено:  ${formatAmount(cost, currency)}\n` +
    `│ 💰 Выручка:    ${formatAmount(revenue, currency)}\n` +
    `│ 📊 Прибыль:    ${formatAmount(profit, currency)}\n` +
    `│ 📉 Маржа:      ${margin}%\n` +
    `└───────────────────────────\n\n` +
    `📦 Продано товаров: ${count} шт.\n` +
    `🔁 Возвраты: ${refundCount} шт. (-${formatAmount(Math.abs(refunds), currency)})\n` +
    `👥 Новых пользователей: ${newUsers}\n` +
    `💳 Пополнений получено: ${formatAmount(topups, currency)}\n` +
    `🧾 Средний чек: ${formatAmount(parseFloat(avgCheck), currency)}\n`;

  if (topProducts.length > 0) {
    text += `\n🏆 <b>Топ товаров:</b>\n`;
    topProducts.forEach((p, i) => {
      const pProfit = p.revenue - p.cost;
      const productName = p.product?.name || 'Товар удалён';
      text += `${i + 1}. ${escapeHtml(p.product?.icon || '📦')} ${escapeHtml(productName.substring(0, 22))}\n`;
      text += `   📦 ${p.count} шт | 💰 ${formatAmount(p.revenue, currency)} | 📊 ${formatAmount(pProfit, currency)}\n`;
    });
  }

  text += `\n💱 Курс: 1 USD = ${getRate()} ₽ (${getUpdatedAt()})`;

  // Кнопки переключения периода
  const periodButtons = [
    Markup.button.callback(period === 'day' ? '✅ День' : 'День', `admin:logistics:day:${currency}`),
    Markup.button.callback(period === 'week' ? '✅ Неделя' : 'Неделя', `admin:logistics:week:${currency}`),
    Markup.button.callback(period === 'month' ? '✅ Месяц' : 'Месяц', `admin:logistics:month:${currency}`),
    Markup.button.callback(period === 'year' ? '✅ Год' : 'Год', `admin:logistics:year:${currency}`),
    Markup.button.callback(period === 'all' ? '✅ Всё' : 'Всё', `admin:logistics:all:${currency}`),
  ];

  const currencyButtons = [
    Markup.button.callback(currency === 'USDT' ? '✅ USDT' : 'USDT', `admin:logistics:${period}:USDT`),
    Markup.button.callback(currency === 'USD' ? '✅ $' : '$', `admin:logistics:${period}:USD`),
    Markup.button.callback(currency === 'RUB' ? '✅ ₽' : '₽', `admin:logistics:${period}:RUB`),
  ];

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        periodButtons,
        currencyButtons,
        [Markup.button.callback('⬅️ К статистике', 'admin:stats')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        periodButtons,
        currencyButtons,
        [Markup.button.callback('⬅️ К статистике', 'admin:stats')],
      ]),
    });
  }
};

// График продаж через QuickChart
const showSalesChart = async (ctx) => {
  await ctx.answerCbQuery('📊 Генерирую график...').catch(() => {});

  // 1. Даты за последние 7 дней
  const labels = [];
  const startOfDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    labels.push(`${day}.${month}`);
    startOfDays.push(d);
  }

  // 2. Одна агрегация с группировкой по дню.
  const tzOffsetMin = -new Date().getTimezoneOffset();
  const weekAgg = await Transaction.aggregate([
    { $match: { type: 'purchase', createdAt: { $gte: startOfDays[0] } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: { $add: ['$createdAt', tzOffsetMin * 60 * 1000] },
          },
        },
        total: { $sum: '$amount' },
      },
    },
  ]);
  const volumeByDay = new Map(weekAgg.map((r) => [r._id, Math.abs(r.total || 0)]));

  const data = [];
  let totalWeek = 0;
  for (let i = 0; i < 7; i++) {
    const d = startOfDays[i];
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const volume = volumeByDay.get(dayKey) || 0;
    data.push(volume.toFixed(2));
    totalWeek += volume;
  }

  // 3. Формируем конфиг QuickChart (стильный тёмный дизайн)
  const chartConfig = {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Выручка (USDT)',
        data: data,
        backgroundColor: 'rgba(56, 189, 248, 0.75)',
        borderColor: 'rgb(56, 189, 248)',
        borderWidth: 2,
        borderRadius: 6,
      }]
    },
    options: {
      title: {
        display: true,
        text: 'Выручка за последние 7 дней (USDT)',
        fontSize: 16,
        fontColor: '#ffffff'
      },
      legend: { display: false },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true, fontColor: '#94a3b8' } }],
        xAxes: [{ ticks: { fontColor: '#94a3b8' } }]
      }
    }
  };

  const chartUrl = `https://quickchart.io/chart?w=650&h=330&backgroundColor=%230f172a&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  // Текстовая разбивка по дням
  let chartRowsText = '';
  const maxVal = Math.max(...data.map(Number), 1);
  for (let i = 0; i < 7; i++) {
    const val = parseFloat(data[i]);
    const barLen = Math.round((val / maxVal) * 8);
    const bar = val > 0 ? '█'.repeat(barLen) + '░'.repeat(8 - barLen) : '░'.repeat(8);
    chartRowsText += `📅 <code>${labels[i]}</code>: <b>${val.toFixed(2)} USDT</b>  [<code>${bar}</code>]\n`;
  }

  const text =
    `📈 <b>График выручки (последние 7 дней)</b>\n\n` +
    `${chartRowsText}\n` +
    `💰 Итого за неделю: <b>${totalWeek.toFixed(2)} USDT</b>`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]);

  // Удаляем старое меню панели, чтобы картинка встала красиво
  await ctx.deleteMessage().catch(() => {});

  try {
    const imgRes = await axios.get(chartUrl, { responseType: 'arraybuffer', timeout: 7000 });
    await ctx.replyWithPhoto(
      { source: Buffer.from(imgRes.data), filename: 'sales_chart.png' },
      {
        caption: text,
        parse_mode: 'HTML',
        ...keyboard
      }
    );
  } catch (err) {
    // Если QuickChart недоступен - отправляем красивую текстовую сводку
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...keyboard
    }).catch(() => {});
  }
};

module.exports = { showStats, showLogistics, showSalesChart };

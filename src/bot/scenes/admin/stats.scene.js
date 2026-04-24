const { Markup } = require('telegraf');
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
  const totalUsers = await User.countDocuments();
  const totalOrders = await Order.countDocuments({ status: 'completed' });
  const pendingOrders = await Order.countDocuments({
    status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation'] },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayOrders = await Order.countDocuments({ status: 'completed', confirmedAt: { $gte: today } });

  const revenueAgg = await Order.aggregate([
    { $match: { status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$price' } } },
  ]);
  const totalRevenue = revenueAgg[0]?.total || 0;

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthRevAgg = await Order.aggregate([
    { $match: { status: 'completed', confirmedAt: { $gte: monthStart } } },
    { $group: { _id: null, total: { $sum: '$price' } } },
  ]);
  const monthRevenue = monthRevAgg[0]?.total || 0;

  const keysTotal = await Key.countDocuments();
  const keysFree = await Key.countDocuments({ isUsed: false });

  const text =
    `📊 <b>Статистика магазина</b>\n\n` +
    `👥 Всего пользователей: <b>${totalUsers}</b>\n` +
    `📦 Выполнено заказов: <b>${totalOrders}</b>\n` +
    `⏳ Ожидают обработки: <b>${pendingOrders}</b>\n` +
    `✅ Заказов сегодня: <b>${todayOrders}</b>\n\n` +
    `💰 Выручка всего: <b>${totalRevenue.toFixed(2)} USDT</b> (~${toRub(totalRevenue)} ₽)\n` +
    `💰 Выручка за месяц: <b>${monthRevenue.toFixed(2)} USDT</b> (~${toRub(monthRevenue)} ₽)\n\n` +
    `🔑 Ключей в базе: ${keysTotal} (свободных: ${keysFree})\n\n` +
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

  // Выручка и закупка за период
  const revenueAgg = await Order.aggregate([
    {
      $match: {
        status: 'completed',
        confirmedAt: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: null,
        revenue: { $sum: '$price' },
        cost: { $sum: '$costPrice' },
        count: { $sum: 1 },
      },
    },
  ]);

  const revenue = revenueAgg[0]?.revenue || 0;
  const cost = revenueAgg[0]?.cost || 0;
  const profit = revenue - cost;
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : '0.0';
  const count = revenueAgg[0]?.count || 0;

  // Возвраты за период
  const refundAgg = await Transaction.aggregate([
    {
      $match: {
        type: 'refund',
        createdAt: { $gte: from, $lte: to },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const refunds = refundAgg[0]?.total || 0;
  const refundCount = refundAgg[0]?.count || 0;

  // Новые пользователи за период
  const newUsers = await User.countDocuments({ createdAt: { $gte: from, $lte: to } });

  // Пополнения за период
  const topupAgg = await TopupRequest.aggregate([
    { $match: { status: 'confirmed', processedAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const topups = topupAgg[0]?.total || 0;

  // Средний чек
  const avgCheck = count > 0 ? (revenue / count).toFixed(2) : '0.00';

  // Топ-3 товара за период
  const topProducts = await Order.aggregate([
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
  ]);

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
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        periodButtons,
        currencyButtons,
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  }
};

// График продаж через QuickChart
const showSalesChart = async (ctx) => {
  await ctx.answerCbQuery('📊 Генерирую график...');

  // 1. Даты за последние 7 дней
  const labels = [];
  const startOfDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0,0,0,0);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    labels.push(`${day}.${month}`);
    startOfDays.push(d);
  }

  // 2. Агрегация транзакций
  const data = [];
  let totalWeek = 0;
  for (let i = 0; i < 7; i++) {
    const start = startOfDays[i];
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const result = await Transaction.aggregate([
      { $match: { type: 'purchase', createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Purchases amount is negative, so we take absolute value
    const volume = Math.abs(result[0]?.total || 0);
    data.push(volume.toFixed(2));
    totalWeek += volume;
  }

  // 3. Формируем URL quickchart.io
  const chartConfig = {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Выручка (USDT)',
        data: data,
        backgroundColor: 'rgba(54, 162, 235, 0.5)',
        borderColor: 'rgb(54, 162, 235)',
        borderWidth: 2,
        borderRadius: 5,
      }]
    },
    options: {
      title: {
        display: true,
        text: 'Выручка за последние 7 дней (USDT)',
        fontColor: '#333',
        fontSize: 16
      },
      legend: { display: false }
    }
  };

  const chartUrl = `https://quickchart.io/chart?w=600&h=300&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  const text =
    `📈 <b>Визуальный график продаж</b>\n\n` +
    `Суммарная выручка за 7 дней: <b>${totalWeek.toFixed(2)} USDT</b>`;

  try {
    await ctx.replyWithPhoto(
      { url: chartUrl },
      {
        caption: text,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]])
      }
    );
  } catch (err) {
    // quickchart.io или Telegram не смогли принять картинку —
    // шлём текстовую сводку с прямой ссылкой, чтобы админ мог открыть её.
    const fallbackText =
      `${text}\n\n` +
      `⚠️ Не удалось сгенерировать изображение графика.\n` +
      `Можно открыть его вручную: <a href="${chartUrl}">ссылка на QuickChart</a>`;
    await ctx.reply(fallbackText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]])
    }).catch(() => {});
  }
};

module.exports = { showStats, showLogistics, showSalesChart };

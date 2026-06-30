const { Markup } = require('telegraf');
const Order = require('../../../models/Order');
const Seller = require('../../../models/Seller');
const User = require('../../../models/User');
const notif = require('../../../services/notification.service');
const { escapeHtml } = require('../../utils/ui');

const PAGE_SIZE = 10;

const listDisputes = async (ctx, page = 1) => {
  const skip = (page - 1) * PAGE_SIZE;
  const filter = { status: 'disputed' };

  const total = await Order.countDocuments(filter);
  const disputes = await Order.find(filter)
    .sort({ disputeOpenedAt: 1, createdAt: 1 })
    .skip(skip)
    .limit(PAGE_SIZE)
    .populate('userId')
    .populate('sellerId');

  if (!disputes.length) {
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]),
    };
    const txt = '⚠️ <b>Споры отсутствуют</b>\n\nВсе заказы идут гладко!';
    try {
      await ctx.editMessageText(txt, opts);
    } catch (_) {
      await ctx.reply(txt, opts);
    }
    return;
  }

  let text = `⚠️ <b>Споры (страница ${page})</b>\n\n`;
  const buttons = [];

  for (const o of disputes) {
    const buyerStr = o.userId?.username ? `@${o.userId.username}` : o.userId?.telegramId;
    const sellerStr = o.sellerId?.username ? `@${o.sellerId.username}` : (o.sellerId ? 'Без имени' : '?');
    text += `🔸 Заказ <code>${o._id}</code>\n`;
    text += `Покупатель: ${buyerStr} | Продавец: ${sellerStr}\n\n`;

    buttons.push([Markup.button.callback(`🔍 Заказ ${o._id}`, `admin:disputes:view:${o._id}`)]);
  }

  const pagination = [];
  if (page > 1) pagination.push(Markup.button.callback('⬅️ Назад', `admin:disputes:page:${page - 1}`));
  if (skip + PAGE_SIZE < total) pagination.push(Markup.button.callback('Вперёд ➡️', `admin:disputes:page:${page + 1}`));
  if (pagination.length) buttons.push(pagination);

  buttons.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

const viewDispute = async (ctx, orderId) => {
  const order = await Order.findById(orderId)
    .populate('productId')
    .populate('userId')
    .populate('sellerId');

  if (!order || order.status !== 'disputed') {
    return ctx.answerCbQuery('Спор не найден или уже закрыт', { show_alert: true });
  }

  const b = order.userId;
  const s = order.sellerId;

  const bLink = b ? (b.username ? `@${b.username}` : `<a href="tg://user?id=${b.telegramId}">Покупатель</a>`) : 'Удалён';
  const sLink = s ? (s.username ? `@${s.username}` : `<a href="tg://user?id=${s.telegramId}">Продавец</a>`) : 'Удалён';

  const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || '?')} (x${order.qty})` : escapeHtml(order.productId?.name || '?');
  const text =
    `⚠️ <b>Спор по заказу <code>${order._id}</code></b>\n\n` +
    `📦 Товар: <b>${productName}</b>\n` +
    `💰 Оплата: <b>${order.price} USDT</b> (Продавцу: <b>${order.sellerPayout} USDT</b>)\n\n` +
    `👤 Покупатель: ${bLink}\n` +
    `🏪 Продавец: ${sLink}\n\n` +
    `📄 <b>Что отправил продавец:</b>\n<code>${escapeHtml(order.deliveryData || 'Ничего/Файл')}</code>\n\n` +
    `<b>Выберите решение:</b>`;

  const buttons = [
    [Markup.button.callback('🔙 Вернуть деньги покупателю', `admin:disputes:refund:${order._id}`)],
    [Markup.button.callback('💸 Перевести деньги продавцу', `admin:disputes:pay:${order._id}`)],
    [Markup.button.callback('⬅️ К списку споров', 'admin:disputes:list')],
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

const resolveRefundBuyer = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId').populate('sellerId');
  if (!order || order.status !== 'disputed') return ctx.answerCbQuery('Спор не найден', { show_alert: true });

  order.status = 'cancelled';
  order.disputeStatus = 'resolved';
  order.activationResult = 'Спор: возврат средств покупателю';
  await order.save();

  // Return money to buyer
  if (order.userId) {
    const User = require('../../../models/User');
    await User.updateOne({ _id: order.userId._id }, { $inc: { balance: order.price } });
    await notif.sendToUser(order.userId.telegramId, `✅ <b>Спор решён в вашу пользу!</b>\nДеньги (${order.price} USDT) возвращены на ваш баланс.`).catch(()=>null);
  }

  // Notify seller
  if (order.sellerId) {
    await notif.sendToUser(order.sellerId.telegramId, `❌ <b>Спор закрыт не в вашу пользу.</b>\nЗаказ отменён, средства возвращены покупателю.`).catch(()=>null);
  }

  await ctx.answerCbQuery('✅ Деньги возвращены покупателю');
  await listDisputes(ctx, 1);
};

const resolvePaySeller = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId').populate('sellerId');
  if (!order || order.status !== 'disputed') return ctx.answerCbQuery('Спор не найден', { show_alert: true });

  const seller = order.sellerId;
  if (seller && order.sellerPayout > 0) {
    seller.balance = parseFloat((seller.balance + order.sellerPayout).toFixed(8));
    seller.totalEarned = parseFloat((seller.totalEarned + order.sellerPayout).toFixed(8));
    await seller.save();
    order.sellerPaidAt = new Date();
  }

  order.status = 'completed';
  order.confirmedAt = new Date();
  order.disputeStatus = 'resolved';
  order.activationResult = 'Спор: выплата продавцу';
  await order.save();

  // Notify seller
  if (seller) {
    await notif.sendToUser(seller.telegramId, `✅ <b>Спор решён в вашу пользу!</b>\nВы получили <b>${order.sellerPayout} USDT</b> за заказ.`).catch(()=>null);
  }

  // Notify buyer
  if (order.userId) {
    await notif.sendToUser(order.userId.telegramId, `❌ <b>Спор закрыт не в вашу пользу.</b>\nАдминистратор признал товар валидным. Деньги переведены продавцу.`).catch(()=>null);
  }

  await ctx.answerCbQuery('✅ Деньги переведены продавцу');
  await listDisputes(ctx, 1);
};

module.exports = {
  listDisputes,
  viewDispute,
  resolveRefundBuyer,
  resolvePaySeller
};

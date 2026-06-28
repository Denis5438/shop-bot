const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const Seller = require('../../models/Seller');
const notif = require('../../services/notification.service');
const { escapeHtml } = require('../utils/ui');
const i18n = require('../middlewares/i18n');

const confirmOrder = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('sellerId').populate('productId');
  if (!order || order.status !== 'awaiting_confirmation') {
    return ctx.answerCbQuery(ctx.t('seller_order_not_found') || 'Заказ не найден или уже обработан.', { show_alert: true });
  }
  
  if (order.userId.toString() !== ctx.user._id.toString()) {
    return ctx.answerCbQuery('❌ Это не ваш заказ', { show_alert: true });
  }

  // Pay seller
  const seller = order.sellerId;
  if (seller && order.sellerPayout > 0) {
    seller.balance = parseFloat((seller.balance + order.sellerPayout).toFixed(8));
    seller.totalEarned = parseFloat((seller.totalEarned + order.sellerPayout).toFixed(8));
    await seller.save();
    
    order.sellerPaidAt = new Date();
    
    // Notify seller
    const payout = order.sellerPayout.toFixed(2);
    const sellerMsg = i18n.translate('ru', 'seller_order_confirmed', { name: escapeHtml(order.productId?.name || 'Товар'), payout });
    await notif.sendToUser(seller.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
  }

  order.status = 'completed';
  order.confirmedAt = new Date();
  order.activationResult = 'Подтверждено покупателем';
  await order.save();

  await ctx.answerCbQuery('✅ Заказ успешно подтверждён!');
  
  // Edit the original message to remove buttons
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (err) {}

  await ctx.reply(ctx.t('buyer_order_confirmed'), { parse_mode: 'HTML' });
};

const disputeOrder = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('sellerId').populate('userId').populate('productId');
  if (!order || order.status !== 'awaiting_confirmation') {
    return ctx.answerCbQuery('Заказ не найден или уже обработан.', { show_alert: true });
  }
  
  if (order.userId._id.toString() !== ctx.user._id.toString()) {
    return ctx.answerCbQuery('❌ Это не ваш заказ', { show_alert: true });
  }

  order.status = 'disputed';
  order.disputeOpenedAt = new Date();
  order.disputeStatus = 'open';
  await order.save();

  await ctx.answerCbQuery('❌ Спор открыт');

  // Remove buttons
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (err) {}

  // Notify buyer
  await ctx.reply(ctx.t('buyer_dispute_opened'), { parse_mode: 'HTML' });

  // Notify seller
  if (order.sellerId) {
    const sellerMsg = i18n.translate('ru', 'seller_dispute_opened', { name: escapeHtml(order.productId?.name || 'Товар') });
    await notif.sendToUser(order.sellerId.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
  }

  // Notify Admin
  const adminMsg = 
    `⚠️ <b>Новый спор!</b>\n\n` +
    `Заказ: <code>${order._id}</code>\n` +
    `Товар: <b>${escapeHtml(order.productId?.name || 'Товар')}</b>\n` +
    `Сумма выплаты продавцу: <b>${order.sellerPayout} USDT</b>\n\n` +
    `Покупатель: @${escapeHtml(order.userId.username || order.userId.telegramId)}\n` +
    `Продавец: @${escapeHtml(order.sellerId?.username || order.sellerId?.telegramId)}\n\n` +
    `Данные: <code>${escapeHtml(order.deliveryData || 'отсутствуют')}</code>\n\n` +
    `Перейдите в панель админа "⚠️ Споры" для решения.`;
  
  await notif.notifyAdmin(adminMsg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔍 К спорам', 'admin:disputes:list')]])
  });
};

module.exports = {
  confirmOrder,
  disputeOrder
};

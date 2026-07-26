const { Markup } = require('telegraf');
const Order = require('../../models/Order');
const Seller = require('../../models/Seller');
const User = require('../../models/User');
const notif = require('../../services/notification.service');
const { escapeHtml } = require('../utils/ui');
const i18n = require('../middlewares/i18n');

const confirmOrder = async (ctx, orderId) => {
  // Атомарный захват заказа: статус + sellerPaidAt:null прямо в фильтре.
  // Закрывает гонку с кроном autoConfirm (двойная выплата продавцу) и
  // двойное нажатие кнопки покупателем. Захват и выплата - в одной транзакции,
  // чтобы при сбое между ними заказ не остался completed с невыплаченными деньгами.
  const { withTransaction } = require('../../services/transactionHelper.service');
  let order = null;
  await withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        userId: ctx.user._id,
        status: 'awaiting_confirmation',
        sellerPaidAt: null,
      },
      {
        $set: {
          status: 'completed',
          confirmedAt: new Date(),
          activationResult: 'Подтверждено покупателем',
        },
      },
      { new: true, ...sessionOpt }
    ).populate('sellerId').populate('productId');
    if (!order) return;

    // Pay seller ($inc - параллельные изменения баланса не теряются)
    if (order.sellerId && order.sellerPayout > 0) {
      await Seller.updateOne(
        { _id: order.sellerId._id },
        { $inc: { balance: order.sellerPayout, totalEarned: order.sellerPayout } },
        sessionOpt
      );
      await Order.updateOne({ _id: order._id }, { $set: { sellerPaidAt: new Date() } }, sessionOpt);
    }
  });
  if (!order) {
    return ctx.answerCbQuery(ctx.t('seller_order_not_found') || 'Заказ не найден или уже обработан.', { show_alert: true });
  }

  // Заказ стал completed - проверяем реферальный бонус (для escrow-потока
  // это основная точка; раньше бонус за такие заказы выдавал только крон)
  const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
  grantReferralBonusForFirstCompletedOrder(order.userId).catch(() => {});

  const seller = order.sellerId;
  if (seller && order.sellerPayout > 0) {
    // Notify seller
    const sellerUser = await User.findOne({ telegramId: seller.telegramId }).select('language').lean();
    const sellerLang = sellerUser?.language || 'ru';
    const payout = order.sellerPayout.toFixed(2);
    const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
    const sellerMsg = i18n.translate(sellerLang, 'seller_order_confirmed', { name: productName, payout });
    await notif.sendToUser(seller.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
  }

  await ctx.answerCbQuery('✅ Заказ успешно подтверждён!');
  
  // Edit the original message to remove buttons
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (err) {}

  await ctx.reply(ctx.t('buyer_order_confirmed'), { parse_mode: 'HTML' });
};

const disputeOrder = async (ctx, orderId) => {
  // Атомарный захват: статус меняется только из awaiting_confirmation.
  // Раньше крон autoConfirm мог затереть открытый спор полным save().
  const order = await Order.findOneAndUpdate(
    { _id: orderId, userId: ctx.user._id, status: 'awaiting_confirmation' },
    { $set: { status: 'disputed', disputeOpenedAt: new Date(), disputeStatus: 'open' } },
    { new: true }
  ).populate('sellerId').populate('userId').populate('productId');
  if (!order) {
    return ctx.answerCbQuery('Заказ не найден или уже обработан.', { show_alert: true });
  }

  await ctx.answerCbQuery('❌ Спор открыт');

  // Remove buttons
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (err) {}

  // Notify buyer
  await ctx.reply(ctx.t('buyer_dispute_opened'), { parse_mode: 'HTML' });

  // Notify seller
  if (order.sellerId) {
    const sellerUser = await User.findOne({ telegramId: order.sellerId.telegramId }).select('language').lean();
    const sellerLang = sellerUser?.language || 'ru';
    const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
    const sellerMsg = i18n.translate(sellerLang, 'seller_dispute_opened', { name: productName });
    await notif.sendToUser(order.sellerId.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
  }

  const productNameAdmin = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
  const adminMsg = 
    `⚠️ <b>Новый спор!</b>\n\n` +
    `Заказ: <code>${order._id}</code>\n` +
    `Товар: <b>${productNameAdmin}</b>\n` +
    `Сумма выплаты продавцу: <b>${order.sellerPayout} USDT</b>\n\n` +
    `Покупатель: @${escapeHtml(order.userId.username || order.userId.telegramId)}\n` +
    `Продавец: @${escapeHtml(order.sellerId?.username || order.sellerId?.telegramId)}\n\n` +
    `Данные: <code>${escapeHtml(order.deliveryData || 'отсутствуют')}</code>\n\n` +
    `Перейдите в панель админа "⚠️ Споры" для решения.`;
  
  await notif.sendToAdmins(adminMsg, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔍 К спорам', 'admin:disputes:list')]])
  });
};

module.exports = {
  confirmOrder,
  disputeOrder
};

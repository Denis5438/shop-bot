const cron = require('node-cron');
const Order = require('../models/Order');
const Seller = require('../models/Seller');
const Settings = require('../models/Settings');
const notif = require('../services/notification.service');
const logger = require('../config/logger');
const i18n = require('../bot/middlewares/i18n');

const init = () => {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const settings = await Settings.findOne({ name: 'global' });
      const hours = settings?.autoConfirmHours || 24;
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

      const orders = await Order.find({
        status: 'awaiting_confirmation',
        deliveredAt: { $lt: cutoff }
      }).populate('sellerId').populate('userId').populate('productId');

      if (!orders.length) return;

      logger.info(`[AutoConfirm] Найдено ${orders.length} заказов для авто-подтверждения.`);

      for (const order of orders) {
        // Confirm and pay seller
        const seller = order.sellerId;
        if (seller && order.sellerPayout > 0) {
          seller.balance = parseFloat((seller.balance + order.sellerPayout).toFixed(8));
          seller.totalEarned = parseFloat((seller.totalEarned + order.sellerPayout).toFixed(8));
          await seller.save();
          order.sellerPaidAt = new Date();
          
          const sellerMsg = i18n.translate('ru', 'seller_order_confirmed', { name: order.productId?.name || 'Товар', payout: order.sellerPayout.toFixed(2) });
          await notif.sendToUser(seller.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
        }

        order.status = 'completed';
        order.confirmedAt = new Date();
        order.activationResult = 'Авто-подтверждение (время истекло)';
        await order.save();

        if (order.userId) {
          const buyerLang = order.userId.language || 'ru';
          const buyerMsg = i18n.translate(buyerLang, 'buyer_order_confirmed');
          await notif.sendToUser(order.userId.telegramId, buyerMsg, { parse_mode: 'HTML' }).catch(()=>null);
        }
      }
    } catch (err) {
      logger.error(`[AutoConfirm] Ошибка: ${err.message}`);
    }
  });
  logger.info('✅ Cron [AutoConfirm] запущен (каждые 15 мин)');
};

module.exports = { init };

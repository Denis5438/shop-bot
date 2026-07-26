const cron = require('node-cron');
const Order = require('../models/Order');
const Seller = require('../models/Seller');
const notif = require('../services/notification.service');
const logger = require('../config/logger');
const i18n = require('../bot/middlewares/i18n');
const { withTransaction } = require('../services/transactionHelper.service');

const init = () => {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      // Через общий кэш настроек (единый путь чтения Settings)
      const { getSettings } = require('../services/settingsCache.service');
      const settings = await getSettings();
      const hours = settings?.autoConfirmHours || 24;
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

      const candidates = await Order.find({
        status: 'awaiting_confirmation',
        deliveredAt: { $lt: cutoff }
      }).select('_id').lean();

      if (!candidates.length) return;

      logger.info(`[AutoConfirm] Найдено ${candidates.length} заказов для авто-подтверждения.`);

      for (const candidate of candidates) {
        // Атомарный захват КАЖДОГО заказа непосредственно перед обработкой:
        // если покупатель за это время подтвердил заказ или открыл спор -
        // findOneAndUpdate вернёт null и заказ будет пропущен. Раньше крон
        // работал по устаревшему снимку: мог выплатить продавцу второй раз
        // и молча затереть открытый спор статусом completed.
        let order = null;
        await withTransaction(async (session) => {
          const sessionOpt = session ? { session } : {};
          order = await Order.findOneAndUpdate(
            {
              _id: candidate._id,
              status: 'awaiting_confirmation',
              sellerPaidAt: null,
            },
            {
              $set: {
                status: 'completed',
                confirmedAt: new Date(),
                activationResult: 'Авто-подтверждение (время истекло)',
              },
            },
            { new: true, ...sessionOpt }
          ).populate('sellerId').populate('userId').populate('productId');
          if (!order) return;

          // Pay seller ($inc вместо read-modify-write, в одной транзакции с захватом)
          if (order.sellerId && order.sellerPayout > 0) {
            await Seller.updateOne(
              { _id: order.sellerId._id },
              { $inc: { balance: order.sellerPayout, totalEarned: order.sellerPayout } },
              sessionOpt
            );
            await Order.updateOne({ _id: order._id }, { $set: { sellerPaidAt: new Date() } }, sessionOpt);
          }
        });
        if (!order) continue;

        const seller = order.sellerId;
        if (seller && order.sellerPayout > 0) {
          const sellerMsg = i18n.translate('ru', 'seller_order_confirmed', { name: order.productId?.name || 'Товар', payout: order.sellerPayout.toFixed(2) });
          await notif.sendToUser(seller.telegramId, sellerMsg, { parse_mode: 'HTML' }).catch(()=>null);
        }

        if (order.userId) {
          const buyerLang = order.userId.language || 'ru';
          const buyerMsg = i18n.translate(buyerLang, 'buyer_order_confirmed');
          await notif.sendToUser(order.userId.telegramId, buyerMsg, { parse_mode: 'HTML' }).catch(()=>null);

          // Заказ стал completed - проверяем реферальный бонус
          const { grantReferralBonusForFirstCompletedOrder } = require('../services/referral.service');
          await grantReferralBonusForFirstCompletedOrder(order.userId._id).catch(() => {});
        }
      }
    } catch (err) {
      logger.error(`[AutoConfirm] Ошибка: ${err.message}`);
    }
  });
  logger.info('✅ Cron [AutoConfirm] запущен (каждые 15 мин)');
};

module.exports = { init };

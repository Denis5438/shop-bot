/**
 * Крон авто-отмены «зависших» заказов: заказы в статусе awaiting_token
 * старше 30 минут отменяются с возвратом средств.
 * Вынесено из src/bot/index.js без изменения поведения.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const logger = require('../config/logger');
const { refundAndCloseOrder } = require('../services/refund.service');

const STALE_ORDER_TIMEOUT_MS = 30 * 60 * 1000;
const INTERVAL_MS = 60_000;

/**
 * @param {Telegraf} bot - для отправки уведомлений пользователям
 * @returns {NodeJS.Timeout} handle интервала (для clearInterval при остановке)
 */
const start = (bot) => {
  let busy = false; // guard от наложения итераций при медленной БД
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      // Если нет активного подключения к БД - пропускаем итерацию
      if (mongoose.connection.readyState !== 1) return;

      const cutoff = new Date(Date.now() - STALE_ORDER_TIMEOUT_MS);
      const staleOrders = await Order.find({ status: 'awaiting_token', createdAt: { $lt: cutoff } })
        .select('_id')
        .lean();

      for (const stale of staleOrders) {
        const { order, user } = await refundAndCloseOrder({
          orderId: stale._id,
          statusFilter: 'awaiting_token',
          newStatus: 'cancelled',
          activationResult: 'Авто-отмена (таймаут)',
          txDescription: 'Авто-отмена: истекло время ожидания токена',
        });

        if (!order) continue;

        if (user) {
          bot.telegram.sendMessage(
            user.telegramId,
            `⏳ <b>Время ожидания токена истекло (30 мин)!</b>\n\nВаш заказ <code>${order._id}</code> был автоматически отменён.\n💰 Средства возвращены на баланс.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        logger.warn(`Пропуск авто-отмены: временная проблема с сетью (ошибка DNS).`);
      } else {
        logger.error(`Ошибка авто-отмены заказов: ${err.message}`);
      }
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = { start };

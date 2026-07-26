/**
 * Крон повторных попыток активации: заказы в статусе retry с наступившим
 * nextRetryAt перезапускаются (до 3 попыток), после - failed с возвратом.
 * Вынесено из src/bot/index.js без изменения поведения.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Key = require('../models/Key');
const User = require('../models/User');
const logger = require('../config/logger');
const notif = require('../services/notification.service');
const { retryActivation } = require('../services/activation.service');
const { resolveOrderProvider } = require('../services/provider.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../services/referral.service');
const { failOrderWithRefund } = require('../services/refund.service');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 60_000;

/**
 * @param {Telegraf} bot - для отправки уведомлений пользователям
 * @returns {NodeJS.Timeout} handle интервала
 */
const start = (bot) => {
  // Guard: предотвращаем наложение итераций retry-крона при лагах БД/API.
  // Если предыдущий тик ещё работает - пропускаем текущий.
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (mongoose.connection.readyState !== 1) return;

      const now = new Date();
      // Только id кандидатов - полные документы захватываем по одному ниже
      const retryOrders = await Order.find({
        status: 'retry',
        nextRetryAt: { $lte: now },
      }).select('_id').lean();

      for (const candidate of retryOrders) {
        // Атомарный захват заказа: сдвигаем nextRetryAt вперёд ОДНИМ запросом.
        // Статус остаётся 'retry' - при падении процесса заказ сам вернётся в
        // очередь через 5 минут, а параллельный тик его не подхватит
        // (nextRetryAt уже в будущем).
        const fresh = await Order.findOneAndUpdate(
          { _id: candidate._id, status: 'retry', nextRetryAt: { $lte: now } },
          { $set: { nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS) } },
          { new: true }
        ).populate('productId');
        if (!fresh) continue;
        const provider = resolveOrderProvider(fresh, fresh.productId);

        const key = await Key.findById(fresh.keyId);

        // Нет ключа или токена - фейлим атомарно
        if (!key || !fresh.tokenRaw) {
          const { user } = await failOrderWithRefund(
            fresh._id,
            'Retry: потерян ключ или токен',
            'Автовозврат: потерян ключ при retry'
          );
          if (user) {
            bot.telegram.sendMessage(
              user.telegramId,
              `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать. Средства возвращены.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          continue;
        }

        // Нет apiOrderId - нельзя повторить шаг 2, фейлим
        if (!fresh.apiOrderId) {
          await failOrderWithRefund(
            fresh._id,
            `Retry: нет api_order_id для повторной попытки`,
            'Автовозврат: нет api_order_id при retry'
          );
          continue;
        }

        const apiOrderId = fresh.apiOrderId;

        try {
          const result = await retryActivation(provider, apiOrderId, fresh.tokenRaw);

          if (result.success) {
            fresh.status = 'completed';
            fresh.provider = provider;
            fresh.activationResult = `api_order_id: ${apiOrderId} (retry OK, попытка ${fresh.retryCount})`;
            fresh.nextRetryAt = null;
            await fresh.save();

            const user = await User.findById(fresh.userId);
            if (user) {
              await notif.notifyUserOrderCompleted(user, fresh, fresh.productId, 'Активация завершена после повторной попытки!');
              await grantReferralBonusForFirstCompletedOrder(user._id);
            }
            await notif.sendToAdmins(
              `✅ <b>Retry-активация успешна</b>\n📋 Заказ: <code>${fresh._id}</code> (попытка ${fresh.retryCount})`
            );
          } else {
            // Снова ошибка - увеличиваем retryCount
            const canRetry = result.retryable !== false;
            if (!canRetry || fresh.retryCount >= MAX_RETRIES) {
              const { user } = await failOrderWithRefund(
                fresh._id,
                `После ${MAX_RETRIES} попыток (retry): ${result.message}`,
                `Автовозврат: ${MAX_RETRIES} retry попыток исчерпаны`
              );
              if (user) {
                bot.telegram.sendMessage(
                  user.telegramId,
                  `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать после ${MAX_RETRIES} попыток. Средства возвращены.`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            } else {
              // Планируем следующий retry
              fresh.retryCount += 1;
              fresh.nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS);
              fresh.activationResult = result.message;
              await fresh.save();
              logger.info(`[Retry] Заказ ${fresh._id}: попытка ${fresh.retryCount}/${MAX_RETRIES} отложена`);
            }
          }
        } catch (err) {
          logger.error(`[Retry] Критическая ошибка для заказа ${fresh._id}: ${err.message}`);
          const nextCount = (fresh.retryCount || 0) + 1;
          if (nextCount >= MAX_RETRIES) {
            const { user } = await failOrderWithRefund(
              fresh._id,
              `После ${MAX_RETRIES} попыток (retry exception): ${err.message}`,
              `Автовозврат: ${MAX_RETRIES} retry попыток исчерпаны (exception)`
            );
            if (user) {
              bot.telegram.sendMessage(
                user.telegramId,
                `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать. Средства возвращены.`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } else {
            // Откладываем retry
            fresh.retryCount = nextCount;
            fresh.nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS);
            await fresh.save();
          }
        }
      }
    } catch (err) {
      logger.error(`Ошибка retry-крона: ${err.message}`);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = { start };

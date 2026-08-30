/**
 * rateLimiter.service.js
 *
 * Безопасная очередь отправки сообщений в Telegram API.
 * Предотвращает превышение лимитов Telegram (Flood Limits / 30 msg/sec),
 * автоматически обрабатывает HTTP 429 (Too Many Requests / retry_after)
 * и исключает потерю сообщений при массовых рассылках.
 */

const logger = require('../config/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Отправляет сообщения массиву пользователей / по курсору с контролем скорости и авто-бэкоффом.
 *
 * @param {Object} options
 * @param {Array|AsyncIterable} options.items - список получателей (массив или Mongoose cursor)
 * @param {Function} options.sendFn - async функция (item) => Promise<void>
 * @param {number} [options.delayMs=40] - задержка между успешными отправками (40мс ≈ 25 сообщений/сек)
 * @param {number} [options.maxRetries=3] - максимальное число повторов для одного получателя при 429
 * @param {Function} [options.onProgress] - колбэк ({ sent, failed, blocked, total, current })
 * @param {number} [options.progressInterval=50] - как часто вызывать onProgress (каждые N сообщений)
 * @returns {Promise<{ sent: number, failed: number, blocked: number, total: number }>}
 */
const runBroadcastQueue = async ({
  items,
  sendFn,
  delayMs = 40,
  maxRetries = 3,
  onProgress = null,
  progressInterval = 50,
}) => {
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let totalProcessed = 0;

  for await (const item of items) {
    totalProcessed++;
    let attempts = 0;
    let delivered = false;

    while (attempts <= maxRetries && !delivered) {
      attempts++;
      try {
        await sendFn(item);
        sent++;
        delivered = true;
      } catch (err) {
        const errCode = err?.response?.error_code || err?.code;
        const description = String(err?.response?.description || err?.message || '');
        const retryAfter = err?.response?.parameters?.retry_after || err?.parameters?.retry_after;

        // 1. Ошибка 429: Too Many Requests (Flood Limit)
        if (errCode === 429 || retryAfter || description.includes('Too Many Requests') || description.includes('retry after')) {
          const waitSec = Math.max(1, parseInt(retryAfter, 10) || 3);
          logger.warn(`[RateLimiter] ⚠️ Пойман Telegram 429 (Flood limit). Пауза очереди на ${waitSec}с перед повтором...`);
          await sleep(waitSec * 1000 + 500);
          // Не инкрементируем failed/blocked, пробуем ещё раз
          continue;
        }

        // 2. Пользователь заблокировал бота или чат удалён (403 / 400)
        if (
          errCode === 403 ||
          description.includes('bot was blocked by the user') ||
          description.includes('user is deactivated') ||
          description.includes('chat not found')
        ) {
          blocked++;
          delivered = true; // Не нужно повторять
          break;
        }

        // 3. Другие сетевые или непредвиденные ошибки
        if (attempts > maxRetries) {
          logger.warn(`[RateLimiter] ❌ Не удалось доставить сообщение после ${maxRetries} попыток: ${description}`);
          failed++;
          delivered = true;
          break;
        }

        // Краткая пауза перед повтором при временном сбое
        await sleep(300);
      }
    }

    // Мягкая пауза для соблюдения лимита сообщений в секунду
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    // Уведомление о прогрессе
    if (typeof onProgress === 'function' && totalProcessed % progressInterval === 0) {
      try {
        await onProgress({ sent, failed, blocked, current: totalProcessed });
      } catch (pErr) {
        logger.warn(`[RateLimiter] Ошибка в onProgress: ${pErr.message}`);
      }
    }
  }

  return {
    sent,
    failed,
    blocked,
    total: totalProcessed,
  };
};

module.exports = {
  runBroadcastQueue,
};

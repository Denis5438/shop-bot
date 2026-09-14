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
const { resolveOrderProvider, isSupplierProvider } = require('../services/provider.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../services/referral.service');
const { failOrderWithRefund } = require('../services/refund.service');
const { decryptSecret } = require('../services/secretBox.service');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 60_000;

let isOrder6aaRepaired = false;
const repairKnownOrderIfPending = async (bot) => {
  if (isOrder6aaRepaired) return;
  const targetOrderId = '6aa7a90de39afa10f6b58d45';
  const targetTelegramId = 5816207940;
  const REAL_DELIVERY = 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';

  try {
    const order = await Order.findById(targetOrderId).populate('productId').populate('userId');
    if (!order) {
      isOrder6aaRepaired = true;
      return;
    }

    const hasRealDelivery = order.deliveryData === REAL_DELIVERY;
    const notifSent = typeof order.notes === 'string' && order.notes.includes('[repair_notification_sent]');

    if (hasRealDelivery && notifSent) {
      isOrder6aaRepaired = true;
      return;
    }

    if (!hasRealDelivery) {
      order.deliveryData = REAL_DELIVERY;
      order.status = 'completed';
      if (!order.supplierOrderId) order.supplierOrderId = 'ORD-00000450';
      order.confirmedAt = order.confirmedAt || new Date();
      order.activationResult = 'Исправление данных поставщика Jaha Digital ⚡';
      await order.save();
      logger.info(`[AutoRepair] Заказ #${targetOrderId} успешно обновлен реальными данными`);
    }

    if (!notifSent && bot?.telegram) {
      const { formatDigitalItem, escapeHtml } = require('../bot/utils/ui');
      const userLang = order.userId?.language || 'ru';
      const formattedKeys = formatDigitalItem(REAL_DELIVERY, userLang);
      const productName = escapeHtml(order.productId?.name || 'ChatGPT Plus / Подписка');
      const msg = userLang === 'en'
        ? `Hello! We sincerely apologize for the technical delay in the automatic delivery of your order #<code>${targetOrderId}</code>.\n\n` +
          `📦 <b>Product:</b> ${productName}\n\n` +
          `🔑 <b>Your access data:</b>\n` +
          `${formattedKeys}\n\n` +
          `ℹ️ <i>Tap on the code field to copy it in 1 click.</i>\n\n` +
          `🛡 <i>Warranty is valid in full. Enjoy using the service!</i>`
        : `Здравствуйте! Приносим искренние извинения за техническую задержку при автоматической выдаче вашего заказа #<code>${targetOrderId}</code>.\n\n` +
          `📦 <b>Товар:</b> ${productName}\n\n` +
          `🔑 <b>Ваши данные для доступа:</b>\n` +
          `${formattedKeys}\n\n` +
          `ℹ️ <i>Нажмите на значение в поле, чтобы скопировать его в 1 клик.</i>\n\n` +
          `🛡 <i>Гарантия на заказ действует в полном объеме. Приятного пользования!</i>`;

      await bot.telegram.sendMessage(targetTelegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: userLang === 'en' ? '📋 My orders' : '📋 Мои покупки', callback_data: `profile:order:detail:${targetOrderId}` }]],
        },
      });

      order.notes = (order.notes ? order.notes + ' ' : '') + '[repair_notification_sent]';
      await order.save();
      isOrder6aaRepaired = true;
      logger.info(`[AutoRepair] Уведомление покупателю ${targetTelegramId} успешно отправлено!`);
    }
  } catch (err) {
    logger.warn(`[AutoRepair] Ошибка при исправлении заказа #${targetOrderId}: ${err.message}`);
  }
};

/**
 * @param {Telegraf} bot - для отправки уведомлений пользователям
 * @returns {NodeJS.Timeout} handle интервала
 */
const start = (bot) => {
  // Запуск проверки автоисправления при старте
  setTimeout(() => {
    if (mongoose.connection.readyState === 1) {
      repairKnownOrderIfPending(bot).catch(() => {});
    }
  }, 2000);

  // Guard: предотвращаем наложение итераций retry-крона при лагах БД/API.
  // Если предыдущий тик ещё работает - пропускаем текущий.
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (mongoose.connection.readyState !== 1) return;

      // -1. Автоисправление заказа 6aa7a90de39afa10f6b58d45 если необходимо
      await repairKnownOrderIfPending(bot);

      // 0. Проверка заказов у внешних поставщиков, ожидающих выдачи (supplierOrderId есть)
      await checkPendingSupplierOrders(bot);

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
        ).select('+tokenRaw').populate('productId');
        if (!fresh) continue;
        const provider = resolveOrderProvider(fresh, fresh.productId);

        if (isSupplierProvider(provider)) {
          await handleSupplierRetry(fresh, provider, bot);
          continue;
        }

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
          const result = await retryActivation(provider, apiOrderId, decryptSecret(fresh.tokenRaw));

          if (result.success) {
            // Атомарное завершение ТОЛЬКО если заказ всё ещё retry. Если админ
            // за время сетевого вызова к провайдеру успел отменить заказ
            // (cancelled + возврат средств), безусловный save() «воскресил» бы
            // его в completed - и товар выдан, и деньги возвращены.
            const completed = await Order.findOneAndUpdate(
              { _id: fresh._id, status: 'retry' },
              {
                $set: {
                  status: 'completed',
                  provider,
                  activationResult: `api_order_id: ${apiOrderId} (retry OK, попытка ${fresh.retryCount})`,
                  nextRetryAt: null,
                },
              },
              { new: true }
            ).populate('productId');

            if (!completed) {
              // Заказ уже не в retry (отменён/обработан). Активация у провайдера
              // прошла - сообщаем админам для ручной сверки, но повторно не
              // начисляем и пользователю "выполнено" не шлём.
              logger.warn(`[Retry] Заказ ${fresh._id}: активация успешна, но заказ уже не в статусе retry - пропускаю завершение.`);
              await notif.sendToAdmins(
                `⚠️ <b>Retry-активация прошла у провайдера, но заказ уже был обработан</b>\n📋 Заказ: <code>${fresh._id}</code>\nТребуется ручная сверка (возможно, заказ отменён с возвратом).`
              ).catch(() => {});
            } else {
              const user = await User.findById(completed.userId);
              if (user) {
                await notif.notifyUserOrderCompleted(user, completed, completed.productId, 'Активация завершена после повторной попытки!');
                await grantReferralBonusForFirstCompletedOrder(user._id);
              }
              await notif.sendToAdmins(
                `✅ <b>Retry-активация успешна</b>\n📋 Заказ: <code>${completed._id}</code> (попытка ${completed.retryCount})`
              );
            }
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

/**
 * Проверка статуса заказов у внешних поставщиков, которые ожидают выдачи товара
 */
const checkPendingSupplierOrders = async (bot) => {
  const supplierManager = require('../services/supplierManager.service');
  const { formatDigitalItem, escapeHtml } = require('../bot/utils/ui');

  try {
    const orders = await Order.find({
      status: { $in: ['activating', 'pending', 'retry'] },
      supplierOrderId: { $exists: true, $ne: null, $nin: ['', null] },
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }).limit(50).populate('userId').populate('productId');

    for (const order of orders) {
      const provider = resolveOrderProvider(order, order.productId);
      if (!isSupplierProvider(provider)) continue;

      try {
        const res = await supplierManager.getSupplierOrder(provider, order.supplierOrderId);
        if (res && res.success && res.deliveryData) {
          const completed = await Order.findOneAndUpdate(
            { _id: order._id, status: { $in: ['activating', 'pending', 'retry'] } },
            {
              $set: {
                status: 'completed',
                confirmedAt: new Date(),
                deliveryData: String(res.deliveryData),
                supplierOrderId: String(res.orderNumber || order.supplierOrderId),
                activationResult: 'Автовыдача через API поставщика (проверка статуса) ⚡',
                nextRetryAt: null,
              },
            },
            { new: true }
          ).populate('userId').populate('productId');

          if (!completed) continue;

          const user = completed.userId;
          const product = completed.productId;
          const userLang = user?.language || 'ru';
          const keysText = formatDigitalItem(res.deliveryData, userLang);

          if (user?.telegramId) {
            const msg = userLang === 'en'
              ? `✅ <b>Order completed automatically! ⚡</b>\n\n` +
                `📦 <b>Product:</b> ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.nameEn || product?.name || 'Item')}\n` +
                `🔑 <b>Your access data:</b>\n${keysText}\n\n` +
                `🛡 <i>Warranty: ${product?.warrantyDays ?? 5} days.</i>\n<i>Thank you for your patience!</i>`
              : `✅ <b>Заказ выполнен автоматически! ⚡</b>\n\n` +
                `📦 <b>Товар:</b> ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.name || 'Товар')}\n` +
                `🔑 <b>Ваши данные для доступа:</b>\n${keysText}\n\n` +
                `🛡 <i>Гарантия: ${product?.warrantyDays ?? 5} дн.</i>\n<i>Спасибо за ожидание!</i>`;

            await bot.telegram.sendMessage(user.telegramId, msg, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: userLang === 'en' ? '📋 My orders' : '📋 Мои покупки', callback_data: `profile:order:detail:${order._id}` }]],
              },
            }).catch(() => {});
          }

          if (user?._id) {
            await grantReferralBonusForFirstCompletedOrder(user._id).catch(() => {});
          }

          await notif.notifyAdminNewOrder(completed, user, product).catch(() => {});
        } else if (res && res.success && (res.status === 'failed' || res.status === 'canceled' || res.status === 'cancelled')) {
          const failNote = `Поставщик отменил заказ (${res.orderNumber || order.supplierOrderId})`;
          await Order.updateOne(
            { _id: order._id, status: { $in: ['activating', 'pending', 'retry'] } },
            { $set: { status: 'pending', notes: failNote } }
          );
          logger.warn(`[Supplier checkPending] Заказ #${order._id} отменен поставщиком: ${failNote}`);
          await notif.sendToAdmins(
            `⚠️ <b>Заказ отменен внешним поставщиком!</b>\n` +
            `📋 Заказ: <code>#${order._id}</code>\n` +
            `Поставщик: <b>${provider}</b> (ID заказа поставщика: <code>${order.supplierOrderId}</code>)\n` +
            `Требуется проверка администратором.`
          ).catch(() => {});
        }
      } catch (err) {
        logger.warn(`[Supplier checkPending] Ошибка проверки заказа #${order._id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[Supplier checkPending] Ошибка поиска заказов: ${err.message}`);
  }
};

const handleSupplierRetry = async (order, provider, bot) => {
  const supplierManager = require('../services/supplierManager.service');
  const { isTransientSupplierError } = require('../services/provider.service');
  const { formatDigitalItem, escapeHtml } = require('../bot/utils/ui');
  const notif = require('../services/notification.service');

  const currentAttempt = (order.retryCount || 0) + 1;
  logger.info(`[Supplier Retry] Попытка ${currentAttempt}/${MAX_RETRIES} для заказа #${order._id} (провайдер: ${provider})`);

  let suppRes;
  try {
    if (order.supplierOrderId) {
      suppRes = await supplierManager.getSupplierOrder(provider, order.supplierOrderId);
    } else {
      suppRes = await supplierManager.fulfillSupplierOrder(
        order.productId,
        order.qty || 1,
        order.userId,
        { orderId: order._id, idempotencyKey: order.supplierIdempotencyKey }
      );
    }
  } catch (err) {
    suppRes = { success: false, error: err.message };
  }

  if (suppRes.success && suppRes.deliveryData) {
    const completed = await Order.findOneAndUpdate(
      { _id: order._id, status: 'retry' },
      {
        $set: {
          status: 'completed',
          confirmedAt: new Date(),
          deliveryData: String(suppRes.deliveryData),
          supplierOrderId: String(suppRes.orderNumber || suppRes.orderId || order.supplierOrderId || ''),
          activationResult: `Автовыдача через API (retry попытка ${currentAttempt} OK) ⚡`,
          nextRetryAt: null,
        },
      },
      { new: true }
    ).populate('userId').populate('productId');

    if (!completed) {
      logger.warn(`[Supplier Retry] Заказ #${order._id} уже был обработан параллельно.`);
      return;
    }

    const user = completed.userId;
    const product = completed.productId;
    const userLang = user?.language || 'ru';
    const keysText = formatDigitalItem(suppRes.deliveryData, userLang);

    if (user?.telegramId) {
      const msg = userLang === 'en'
        ? `✅ <b>Order completed automatically! ⚡</b>\n\n` +
          `📦 <b>Product:</b> ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.nameEn || product?.name || 'Item')}\n` +
          `🔑 <b>Your access data:</b>\n${keysText}\n\n` +
          `🛡 <i>Warranty: ${product?.warrantyDays ?? 5} days.</i>\n<i>Thank you for your patience!</i>`
        : `✅ <b>Заказ выполнен автоматически! ⚡</b>\n\n` +
          `📦 <b>Товар:</b> ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.name || 'Товар')}\n` +
          `🔑 <b>Ваши данные для доступа:</b>\n${keysText}\n\n` +
          `🛡 <i>Гарантия: ${product?.warrantyDays ?? 5} дн.</i>\n<i>Спасибо за ожидание!</i>`;

      await bot.telegram.sendMessage(user.telegramId, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: userLang === 'en' ? '📋 My orders' : '📋 Мои покупки', callback_data: `profile:order:detail:${order._id}` }]],
        },
      }).catch(() => {});
    }

    if (user?._id) {
      await grantReferralBonusForFirstCompletedOrder(user._id).catch(() => {});
    }

    await notif.notifyAdminNewOrder(completed, user, product).catch(() => {});
    return;
  }

  if (suppRes.success && !suppRes.deliveryData) {
    const suppOrderId = String(suppRes.orderNumber || suppRes.orderId || order.supplierOrderId || '');
    await Order.updateOne(
      { _id: order._id, status: 'retry' },
      {
        $set: {
          status: 'activating',
          supplierOrderId: suppOrderId,
          notes: 'Заказ принят поставщиком, ожидается выдача товара',
          nextRetryAt: null,
        },
      }
    );
    return;
  }

  const isTransient = isTransientSupplierError(suppRes.error);
  if (isTransient && currentAttempt < MAX_RETRIES) {
    await Order.updateOne(
      { _id: order._id, status: 'retry' },
      {
        $set: {
          retryCount: currentAttempt,
          nextRetryAt: new Date(Date.now() + 2 * 60 * 1000),
          notes: `Retry #${currentAttempt} не удался: ${suppRes.error || 'неизвестно'}`,
        },
      }
    );
  } else {
    const finalNote = `Сбой API поставщика (${currentAttempt} попыток): ${suppRes.error || 'неизвестно'}`;
    const pendingOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: 'retry' },
      {
        $set: {
          status: 'pending',
          nextRetryAt: null,
          retryCount: currentAttempt,
          notes: finalNote,
        },
      },
      { new: true }
    ).populate('userId').populate('productId');

    if (pendingOrder) {
      logger.warn(`[Supplier Retry] Заказ #${order._id} переведён в pending: ${finalNote}`);
      const user = pendingOrder.userId;
      const product = pendingOrder.productId;
      await notif.notifyAdminNewOrder(pendingOrder, user, product).catch(() => {});
    }
  }
};

module.exports = { start };

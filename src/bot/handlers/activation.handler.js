/**
 * Обработчик подтверждения активации (activation:confirm).
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const Key = require('../../models/Key');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');
const logger = require('../../config/logger');
const notif = require('../../services/notification.service');
const { Markup } = require('telegraf');
const { escapeHtml } = require('../utils/ui');
const { finishActivation } = require('../../services/activation.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { resolveOrderProvider } = require('../../services/provider.service');

module.exports = (bot) => {
  // ─────────────────── АКТИВАЦИЯ: Подтверждение email ───────────────────
  bot.action(/^activation:confirm:(yes|no):(.+)$/, async (ctx) => {
    const isYes = ctx.match[1] === 'yes';
    const dbOrderId = ctx.match[2];

    // Читаем и гасим сессию СИНХРОННО, до первого await: двойной клик по кнопке
    // раньше дважды запускал активацию у поставщика (второй обработчик успевал
    // пройти проверку, пока первый ждал ответа Telegram API).
    const pending = ctx.session?.pendingActivation;
    const isValidPending = pending && pending.dbOrderId === dbOrderId;
    if (isValidPending) {
      ctx.session.pendingActivation = null;
    }

    await ctx.answerCbQuery(isYes ? '⏳ Завершаю активацию...' : '⏳ Отменяю...');
    await ctx.editMessageReplyMarkup(null).catch(() => { });

    // Защита: если данные потеряны (перезапуск бота, двойной клик и т.п.)
    if (!isValidPending) {
      return ctx.reply('❌ Сессия активации истекла. Пожалуйста, начните покупку заново.');
    }

    const Order = require('../../models/Order');
    const Key = require('../../models/Key');
    const Transaction = require('../../models/Transaction');

    const order = await Order.findById(dbOrderId).populate('productId');
    // Guard: заказ мог быть удалён/изменён - раньше падало TypeError на order.status
    if (!order) {
      return ctx.reply('❌ Заказ не найден. Обратитесь в поддержку.');
    }

    if (isYes) {
      // ── Шаг 2: Привязываем токен ──
      const progressBar = (pct) => {
        const filled = Math.round(pct / 10);
        const empty = 10 - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
      };
      const step2Msg = await ctx.reply(
        `⚙️ <b>Шаг 2 из 2</b> - Привязка токена...\n${progressBar(10)} 🔄 Запускаю привязку...`,
        { parse_mode: 'HTML' }
      );

      let animDots = 0;
      let animIndex = 0;
      const animStates = [
          `${progressBar(40)} 🔄 Отправка токена в сервис`,
          `${progressBar(70)} ⏳ Ожидание подтверждения`,
          `${progressBar(90)} ⚙️ Финализация настроек аккаунта`
      ];
      const animInterval = setInterval(() => {
        if (animIndex >= animStates.length) return;
        animDots = (animDots + 1) % 4;
        const dotStr = '.'.repeat(animDots);
        ctx.telegram.editMessageText(
          ctx.chat.id, step2Msg.message_id, null,
          `⚙️ <b>Шаг 2 из 2</b> - Привязка токена...\n${animStates[animIndex]}${dotStr}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        if (animDots === 3) animIndex++;
      }, 3000); // 1200 мс выжигали Telegram rate-limit (30 msg/sec на бота)

      const provider = pending.provider || resolveOrderProvider(order, order.productId);
      let result;
      try {
        result = await finishActivation(provider, pending.apiOrderId, pending.token);
      } finally {
        // Иначе при исключении в finishActivation таймер анимации жил бы
        // до перезапуска процесса (утечка setInterval)
        clearInterval(animInterval);
      }

      if (result.success) {
        // Атомарное завершение только если заказ не был закрыт админом
        // (отмена+возврат) за время сетевого вызова к провайдеру - иначе
        // безусловный save() «воскресил» бы отменённый заказ в completed.
        const completed = await Order.findOneAndUpdate(
          { _id: order._id, status: { $nin: ['completed', 'cancelled', 'failed'] } },
          {
            $set: {
              status: 'completed',
              provider,
              apiOrderId: pending.apiOrderId,
              activationResult: `api_order_id: ${pending.apiOrderId}`,
            },
          },
          { new: true }
        );
        if (!completed) {
          // Заказ уже закрыт (например, отменён с возвратом). Активация у
          // провайдера прошла - сообщаем админам, но повторно не начисляем.
          logger.warn(`[Activation] Заказ ${order._id}: активация успешна, но заказ уже закрыт - пропускаю завершение.`);
          await notif.sendToAdmins(
            `⚠️ <b>Активация прошла у провайдера, но заказ уже закрыт</b>\n📋 Заказ: <code>${order._id}</code>\nТребуется ручная сверка.`
          ).catch(() => {});
          return;
        }
        // order (с populated productId) используем для уведомлений;
        // статус в БД уже переведён в completed атомарно выше.

        await ctx.telegram.editMessageText(
          ctx.chat.id, step2Msg.message_id, null,
          `🎉 <b>Активация завершена!</b>\n\n` +
          `<blockquote>✅ Шаг 2 из 2 - Токен привязан!</blockquote>\n\n` +
          `Спасибо за покупку! Ваша подписка активирована.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
          }
        ).catch(() => ctx.reply(
          `🎉 <b>Активация завершена!</b> Спасибо за покупку!`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:main')]]) }
        ));

        await notif.notifyUserOrderCompleted(ctx.user, order, order.productId, 'Активация завершена успешно.');
        await grantReferralBonusForFirstCompletedOrder(order.userId);
        await notif.sendToAdmins(
          `✅ <b>Заказ выполнен (авто-активация)</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📋 ID: <code>${order._id}</code>\n` +
          `👤 ${escapeHtml(ctx.user.firstName)} (@${escapeHtml(ctx.user.username || ctx.user.telegramId)})\n` +
          `📦 ${escapeHtml(order.productId?.icon || '📦')} ${escapeHtml(order.productId?.name || 'Товар')}\n` +
          `💰 ${order.price} USDT`
        );
      } else {
        // Шаг 2 провалился - ставим в retry (до 3 попыток), потом failed
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5 * 60 * 1000; // 5 минут

        const currentRetryCount = order.retryCount || 0;

        if (currentRetryCount < MAX_RETRIES) {
          // Ставим в retry - крон попробует снова
          order.status = 'retry';
          order.provider = provider;
          order.apiOrderId = pending.apiOrderId;
          order.activationResult = result.message;
          order.retryCount = currentRetryCount + 1;
          order.nextRetryAt = new Date(Date.now() + RETRY_DELAY);
          await order.save();

          await ctx.telegram.editMessageText(
            ctx.chat.id, step2Msg.message_id, null,
            `⏳ <b>Временная ошибка активации</b>\n\n` +
            `Попробую ещё раз автоматически (попытка ${order.retryCount}/${MAX_RETRIES}).\n` +
            `Ожидайте, это может занять несколько минут.`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
            }
          ).catch(() => {});

          await notif.sendToAdmins(
            `⚠️ <b>Ошибка шага 2 (retry ${order.retryCount}/${MAX_RETRIES})</b>\n` +
            `📋 Заказ: <code>${order._id}</code>\n` +
            `❌ ${String(result.message).substring(0, 200)}`
          );
        } else {
          // Исчерпаны попытки - откатываем
          if (pending.keyId) {
            await Key.updateOne(
              { _id: pending.keyId },
              { $set: { isUsed: false, usedAt: null, usedByOrder: null } }
            ).catch(() => {});
          }

          // Атомарный захват заказа: возврат только при первом переводе в failed
          // (защита от двойного рефанда при гонке с retry-кроном)
          const failedOrder = await Order.findOneAndUpdate(
            { _id: order._id, status: { $nin: ['failed', 'cancelled', 'completed'] } },
            {
              $set: {
                status: 'failed',
                activationResult: `После ${MAX_RETRIES} попыток: ${result.message}`,
                nextRetryAt: null,
              },
            },
            { new: true }
          );
          if (failedOrder) {
            const User = require('../../models/User');
            await User.updateOne({ _id: ctx.user._id }, { $inc: { balance: order.price } });
            ctx.user.balance = parseFloat((ctx.user.balance + order.price).toFixed(8));

            await new Transaction({
              userId: ctx.user._id, type: 'refund', amount: order.price,
              orderId: order._id, description: `Автовозврат: не удалось активировать за ${MAX_RETRIES} попыток`,
            }).save();
          }

          const tokenLen = pending.token?.length ?? '?';
          const safeErr = String(result.message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          await ctx.telegram.editMessageText(
            ctx.chat.id, step2Msg.message_id, null,
            `❌ <b>Ошибка активации</b>\n\n` +
            `<blockquote><code>${safeErr}</code>\n\n` +
            `📏 Длина токена: <b>${tokenLen} симв.</b>\n` +
            `💡 Убедитесь, что скопировали <b>весь</b> текст /api/auth/session</blockquote>\n\n` +
            `💰 Средства возвращены на баланс.`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.url('🆘 Написать поддержку', require('../constants/ux').TEXTS.SUPPORT_URL)],
                [Markup.button.callback('⬅️ В главное меню', 'menu:main')]
              ]),
            }
          ).catch(() => {});
          await notif.notifyAdminTokenReceived(order, ctx.user, order.productId);
        }
      }

    } else {
      // ── Пользователь нажал «Нет» - откатываем ключ, возвращаем деньги ──
      // Возвращаем ключ в пул
      const key = await Key.findById(pending.keyId);
      if (key) { key.isUsed = false; key.usedByOrder = null; await key.save(); }

      // Сбрасываем заказ обратно в awaiting_token
      // retryCount/apiOrderId/nextRetryAt также сбрасываются - для нового
      // токена это «чистая» попытка активации, а не продолжение предыдущей.
      order.status = 'awaiting_token';
      order.keyId = null;
      order.retryCount = 0;
      order.apiOrderId = null;
      order.nextRetryAt = null;
      order.activationResult = null;
      await order.save();

      ctx.session.pendingActivation = null;

      await ctx.reply(
        `🔄 <b>Понял, не ваш аккаунт.</b>\n\nПожалуйста, отправьте токен ещё раз - возможно, он был неверным или устаревшим.`,
        { parse_mode: 'HTML' }
      );

      // Возвращаемся в сцену сбора токена
      await ctx.scene.enter('token_collection', { orderId: dbOrderId });
    }
  });
};

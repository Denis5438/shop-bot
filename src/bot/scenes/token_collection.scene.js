/**
 * token_collection.scene.js
 *
 * Сцена сбора токена ChatGPT для активационных товаров.
 * Поддерживает:
 *  - поэтапный сбор длинного токена из нескольких сообщений
 *  - загрузку токена через .txt
 *  - разные backend-flow для разных поставщиков
 */

const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const logger = require('../../config/logger');
const Order = require('../../models/Order');
const Key = require('../../models/Key');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const notif = require('../../services/notification.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const { finishActivation, startActivation } = require('../../services/activation.service');
const { withTransaction } = require('../../services/transactionHelper.service');
const {
  providerRequiresUserConfirmation,
  resolveOrderProvider,
} = require('../../services/provider.service');
const { confirmScreen, escapeHtml } = require('../utils/ui');

const SCENE_ID = 'token_collection';
const DONE_ACTION = 'token:done';
const CANCEL_ACTION = 'token:cancel';
const CANCEL_CONFIRM_ACTION = 'token:cancel:confirm';
const CANCEL_ABORT_ACTION = 'token:cancel:abort';
const RETRY_DELAY_MS = 5 * 60 * 1000;

const getRemainingMins = (createdAt) => {
  if (!createdAt) return 30;
  const elapsed = Date.now() - new Date(createdAt).getTime();
  const remaining = 30 * 60 * 1000 - elapsed;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 60000);
};

const sendPrompt = async (ctx) => {
  const timeLeft = getRemainingMins(ctx.scene.state.orderCreatedAt);
  const lang = ctx.user?.language || 'ru';

  const doneLabel = lang === 'en' ? '✅ I sent the full token' : '✅ Я отправил весь токен';
  const cancelLabel = lang === 'en' ? '❌ Cancel' : '❌ Отмена';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(doneLabel, DONE_ACTION)],
    [Markup.button.callback(cancelLabel, CANCEL_ACTION)],
  ]);

  const text = lang === 'en'
    ? `🔑 <b>Send your ChatGPT token</b>\n\n` +
      `<blockquote>⏱ Time left: <b>~${timeLeft} min</b></blockquote>\n\n` +
      `<b>How to get the token:</b>\n` +
      `1️⃣ Log in at <a href="https://chatgpt.com">chatgpt.com</a>\n` +
      `2️⃣ Go to: <a href="https://chatgpt.com/api/auth/session">chatgpt.com/api/auth/session</a>\n` +
      `3️⃣ Copy <b>all text</b> from the page and send it here\n\n` +
      `<blockquote>⚠️ The token is long — Telegram splits it into parts. Send everything, then press the button.\n\n` +
      `📎 Or attach a <code>.txt</code> file — the bot will read it automatically.</blockquote>`
    : `🔑 <b>Отправьте токен ChatGPT</b>\n\n` +
      `<blockquote>⏱ Осталось: <b>~${timeLeft} мин</b></blockquote>\n\n` +
      `<b>Как получить токен:</b>\n` +
      `1️⃣ Войдите на <a href="https://chatgpt.com">chatgpt.com</a>\n` +
      `2️⃣ Перейдите по ссылке:\n    <a href="https://chatgpt.com/api/auth/session">chatgpt.com/api/auth/session</a>\n` +
      `3️⃣ Скопируйте <b>весь текст</b> страницы и отправьте мне\n\n` +
      `<blockquote>⚠️ Токен длинный — Telegram разбивает его на части. Отправляйте всё, затем нажмите кнопку.\n\n` +
      `📎 Или прикрепите <code>.txt</code> файл — прочитаю сам.</blockquote>`;

  const sent = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
  ctx.scene.state.promptMsgId = sent.message_id;
};

const extractEmailFromToken = (token) => {
  try {
    const parsed = JSON.parse(token);
    const email = parsed?.user?.email;
    if (email && typeof email === 'string') return email;
  } catch (_) {
    // ignore
  }

  const match = token.match(/"email"\s*:\s*"([^"]+@[^"]+)"/);
  return match ? match[1] : null;
};

const refundOrder = async (order, key, description) => {
  if (key) {
    key.isUsed = false;
    key.usedByOrder = null;
    key.usedAt = null;
    await key.save();
  }

  const user = await User.findById(order.userId);
  if (user) {
    user.balance = parseFloat((user.balance + order.price).toFixed(8));
    await user.save();
  }

  await new Transaction({
    userId: order.userId,
    type: 'refund',
    amount: order.price,
    orderId: order._id,
    description,
  }).save();

  return user;
};

const finishWithFailure = async (ctx, order, key, provider, message, editMessageId = null, refundDescription = 'Activation error') => {
  order.status = 'failed';
  order.provider = provider;
  order.activationResult = message;
  order.nextRetryAt = null;
  await order.save();

  const user = await refundOrder(order, key, refundDescription);
  const safeError = String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lang = ctx.user?.language || 'ru';

  const productId = order.productId?._id || order.productId;
  const retryLabel = lang === 'en' ? '🔄 Try again' : '🔄 Попробовать снова';
  const supportLabel = lang === 'en' ? '🆘 Contact Support' : '🆘 Написать поддержке';
  const menuLabel = lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню';
  const errorTitle = lang === 'en' ? 'Activation error:' : 'Ошибка активации:';
  const refundMsg = lang === 'en' ? 'Funds have been returned to your balance.' : 'Средства возвращены на баланс.';
  const { TEXTS } = require('../constants/ux');

  const retryButton = productId
    ? [Markup.button.callback(retryLabel, `shop:product:${productId}`)]
    : null;

  const buttons = [];
  if (retryButton) buttons.push(retryButton);
  buttons.push([Markup.button.url(supportLabel, TEXTS.SUPPORT_URL)]);
  buttons.push([Markup.button.callback(menuLabel, 'menu:main')]);
  const replyMarkup = Markup.inlineKeyboard(buttons);
  const errorText = `❌ <b>${errorTitle}</b>\n<blockquote>${safeError}</blockquote>\n\n${refundMsg}`;

  if (editMessageId) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, editMessageId, null, errorText,
      { parse_mode: 'HTML', ...replyMarkup }
    ).catch(() => {});
  } else {
    await ctx.reply(errorText, { parse_mode: 'HTML', ...replyMarkup });
  }

  if (user) {
    await notif.notifyAdminTokenReceived(order, user, order.productId);
  }
};

const completeActivationOrder = async (ctx, order, provider, externalOrderId, successMessage, editMessageId) => {
  order.status = 'completed';
  order.provider = provider;
  order.apiOrderId = externalOrderId;
  order.activationResult = successMessage;
  order.nextRetryAt = null;
  await order.save();

  const user = await User.findById(order.userId);
  if (user) {
    await notif.notifyUserOrderCompleted(user, order, order.productId, 'Activation completed successfully.');
    await grantReferralBonusForFirstCompletedOrder(user._id);
  }

  const lang = ctx.user?.language || user?.language || 'ru';
  const menuLabel = lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню';
  const doneText = lang === 'en'
    ? `🎉 <b>Activation complete!</b>\n\n<blockquote>✅ The provider confirmed the order completion.</blockquote>\n\nThank you for your purchase! Your subscription is activated.`
    : `🎉 <b>Активация завершена!</b>\n\n<blockquote>✅ Поставщик подтвердил выполнение заказа.</blockquote>\n\nСпасибо за покупку! Ваша подписка активирована.`;

  if (editMessageId) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, editMessageId, null, doneText,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(menuLabel, 'menu:main')]]),
      }
    ).catch(() => {});
  }
};

const scheduleRetry = async (ctx, order, provider, externalOrderId, message, editMessageId) => {
  order.status = 'retry';
  order.provider = provider;
  order.apiOrderId = externalOrderId;
  order.activationResult = message;
  order.retryCount = 1;
  order.nextRetryAt = new Date(Date.now() + RETRY_DELAY_MS);
  await order.save();

  const lang = ctx.user?.language || 'ru';
  const menuLabel = lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню';
  const retryText = lang === 'en'
    ? `⏳ <b>Activation not yet complete</b>\n\nThe provider accepted the request, but the final status is not yet received.\nWill retry automatically in a few minutes.`
    : `⏳ <b>Активация ещё не завершена</b>\n\nПоставщик принял запрос, но финальный статус пока не получен.\nПопробую автоматически ещё раз через несколько минут.`;

  if (editMessageId) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, editMessageId, null, retryText,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(menuLabel, 'menu:main')]]),
      }
    ).catch(() => {});
  }

  await notif.sendToAdmins(
    `⚠️ <b>Заказ переведён в retry</b>\n` +
    `📋 Заказ: <code>${order._id}</code>\n` +
    `🧩 Поставщик: ${provider}\n` +
    `❕ ${String(message).substring(0, 200)}`
  );
};

const runActivation = async (ctx, token) => {
  const orderId = ctx.scene.state.orderId;
  let order = await Order.findById(orderId).populate('productId');

  if (!order || order.status !== 'awaiting_token') {
    await ctx.reply('❌ Заказ не найден или уже обработан.');
    return ctx.scene.leave();
  }

  const key = await Key.findOne({ usedByOrder: order._id });
  const provider = resolveOrderProvider(order, order.productId);

  if (!key) {
    const failedOrder = await Order.findOneAndUpdate(
      { _id: order._id, status: 'awaiting_token' },
      {
        $set: {
          tokenRaw: token,
          status: 'failed',
          provider,
          activationResult: 'Системная ошибка: потерян ключ',
        },
      },
      { new: true }
    ).populate('productId');

    if (!failedOrder) {
      await ctx.reply('❌ Заказ уже обработан или отменён.');
      return ctx.scene.leave();
    }

    order = failedOrder;

    const user = await refundOrder(order, null, 'Ошибка: забронированный ключ не найден');
    await ctx.reply(
      `❌ <b>Системная ошибка:</b> Ключ для заказа не найден. Средства возвращены.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
      }
    );

    if (user) {
      await notif.notifyAdminTokenReceived(order, user, order.productId);
    }
    return ctx.scene.leave();
  }

  const activatingOrder = await Order.findOneAndUpdate(
    { _id: order._id, status: 'awaiting_token' },
    {
      $set: {
        tokenRaw: token,
        keyId: key._id,
        provider,
        status: 'activating',
      },
    },
    { new: true }
  ).populate('productId');

  if (!activatingOrder) {
    await ctx.reply('❌ Заказ уже обработан или отменён.');
    return ctx.scene.leave();
  }

  order = activatingOrder;
  await ctx.scene.leave();

  if (providerRequiresUserConfirmation(provider)) {
    const msg = await ctx.reply(
      `⚙️ <b>Шаг 1 из 2</b> — Инициализация ключа...\n▓░░░░░░░░░ 10% 🔄 Подключаюсь к сервису...`,
      { parse_mode: 'HTML' }
    );

    let animDots = 0;
    let animIndex = 0;
    const progressBar = (pct) => {
      const filled = Math.round(pct / 10);
      const empty = 10 - filled;
      return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
    };
    const animStates = [
      `${progressBar(30)} 🔑 Проверка валидности токена`,
      `${progressBar(60)} 🔄 Получение данных аккаунта`,
      `${progressBar(90)} ⏳ Ожидание ответа API`,
    ];
    const animInterval = setInterval(() => {
      if (animIndex >= animStates.length) return;
      animDots = (animDots + 1) % 4;
      const dotStr = '.'.repeat(animDots);
      ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        `⚙️ <b>Шаг 1 из 2</b> — Инициализация ключа...\n${animStates[animIndex]}${dotStr}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      if (animDots === 3) animIndex += 1;
    }, 1200);

    const emailFromToken = extractEmailFromToken(token);
    const result = await startActivation(provider, key.value);
    clearInterval(animInterval);

    if (!result.success) {
      await finishWithFailure(
        ctx,
        order,
        key,
        provider,
        result.message,
        msg.message_id,
        'Ошибка активации (шаг 1)'
      );
      return;
    }

    const email = emailFromToken || result.email || '(не удалось определить)';
    order.apiOrderId = result.order_id;
    await order.save();

    ctx.session.pendingActivation = {
      dbOrderId: order._id.toString(),
      provider,
      apiOrderId: result.order_id,
      keyId: key._id.toString(),
      token,
    };

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      null,
      `✅ <b>Шаг 1 из 2 выполнен!</b>\n\n` +
      `❓ <b>Это ваш аккаунт?</b>\n\n` +
      `<blockquote>📧 <code>${escapeHtml(email)}</code></blockquote>\n\n` +
      `Если почта ваша — нажмите <b>✅ Да</b>.\n` +
      `Если нет — нажмите <b>❌ Нет</b> и деньги вернутся.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('❌ Нет — не мой', `activation:confirm:no:${order._id}`),
            Markup.button.callback('✅ Да — мой аккаунт', `activation:confirm:yes:${order._id}`),
          ],
        ]),
      }
    );
    return;
  }

  const progressMessage = await ctx.reply(
    `⚙️ <b>Активация запущена</b>\n▓▓▓░░░░░░░ 30% 🔄 Передаю токен поставщику...`,
    { parse_mode: 'HTML' }
  );

  const result = await finishActivation(provider, key.value, token);

  if (result.success) {
    const successLabel = result.externalStatus
      ? `provider_status: ${result.externalStatus}`
      : `provider_code: ${key.value}`;
    await completeActivationOrder(ctx, order, provider, key.value, successLabel, progressMessage.message_id);
    return;
  }

  if (result.retryable) {
    await scheduleRetry(ctx, order, provider, key.value, result.message, progressMessage.message_id);
    return;
  }

  await finishWithFailure(
    ctx,
    order,
    key,
    provider,
    result.message,
    progressMessage.message_id,
    'Ошибка активации поставщика'
  );
};

const tokenCollectionScene = new Scenes.BaseScene(SCENE_ID);

tokenCollectionScene.enter(async (ctx) => {
  ctx.scene.state.tokenBuffer = '';
  const orderId = ctx.scene.state.orderId;
  if (orderId && !ctx.scene.state.orderCreatedAt) {
    const order = await Order.findById(orderId).lean();
    if (order) ctx.scene.state.orderCreatedAt = order.createdAt;
  }
  await sendPrompt(ctx);
});

tokenCollectionScene.on('text', async (ctx) => {
  const chunk = ctx.message.text;
  if (!chunk) return;

  ctx.scene.state.tokenBuffer = (ctx.scene.state.tokenBuffer || '') + chunk;
  const totalLen = ctx.scene.state.tokenBuffer.length;
  const timeLeft = getRemainingMins(ctx.scene.state.orderCreatedAt);
  const lang = ctx.user?.language || 'ru';

  logger.info(`[TokenScene] chunk=${chunk.length} buffer=${totalLen}`);

  ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});

  const promptMsgId = ctx.scene.state.promptMsgId;
  const received = lang === 'en' ? 'Received' : 'Получено';
  const continueHint = lang === 'en'
    ? 'Keep sending if the token is not complete yet.'
    : 'Продолжайте, если токен ещё не весь.';
  const whenDone = lang === 'en'
    ? 'When done — press the button below.\n\n📎 Or attach a <code>.txt</code> file — the bot will read it.'
    : 'Когда отправите всё — нажмите кнопку ниже.\n\n📎 Или прикрепите <code>.txt</code> файл — бот прочитает сам.';
  const title = lang === 'en' ? '🔑 <b>Send your ChatGPT token</b>' : '🔑 <b>Отправьте ваш токен ChatGPT</b>';
  const timeLeft2 = lang === 'en' ? `Time left: <b>~${timeLeft} min</b>` : `Осталось: <b>~${timeLeft} мин</b>`;
  const doneLabel = lang === 'en' ? '✅ I sent the full token' : '✅ Я отправил весь токен';
  const cancelLabel = lang === 'en' ? '❌ Cancel' : '❌ Отмена';
  const chars = lang === 'en' ? 'chars' : 'симв.';

  const text =
    `${title}\n\n` +
    `<blockquote>⏱ ${timeLeft2}</blockquote>\n\n` +
    `📥 <b>${received}:</b> ${totalLen} ${chars} — ${continueHint}\n\n` +
    `<blockquote>${whenDone}</blockquote>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(doneLabel, DONE_ACTION)],
    [Markup.button.callback(cancelLabel, CANCEL_ACTION)],
  ]);

  if (promptMsgId) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, promptMsgId, null, text,
      { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard }
    ).catch(() => {});
  } else {
    const sent = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard });
    ctx.scene.state.promptMsgId = sent.message_id;
  }
});

tokenCollectionScene.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const mimeOk = doc.mime_type === 'text/plain';
  const nameOk = doc.file_name && doc.file_name.toLowerCase().endsWith('.txt');
  const lang = ctx.user?.language || 'ru';

  if (!mimeOk && !nameOk) {
    const msg = lang === 'en'
      ? '❌ Please send only a <b>.txt</b> file.'
      : '❌ Пожалуйста, отправьте только <b>.txt</b> файл.';
    return ctx.reply(msg, { parse_mode: 'HTML' });
  }

  const readingMsg = lang === 'en' ? '⏳ Reading file...' : '⏳ Читаю файл...';
  const processingMsg = await ctx.reply(readingMsg);

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, {
      responseType: 'text',
      timeout: 15_000,
    });

    const raw = String(response.data);
    const token = raw.replace(/^\uFEFF/, '').trim();

    logger.info(`[TokenScene] file raw=${raw.length} cleaned=${token.length}`);

    if (!token) {
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
      const emptyMsg = lang === 'en'
        ? '❌ The file is empty. Please send a file with the token.'
        : '❌ Файл пустой. Пожалуйста, отправьте файл с токеном.';
      return ctx.reply(emptyMsg);
    }

    const chars = lang === 'en' ? 'chars' : 'симв.';
    const launchMsg = lang === 'en'
      ? `✅ File read (<b>${token.length}</b> chars). Launching activation...`
      : `✅ Файл прочитан (<b>${token.length}</b> симв.). Запускаю активацию...`;
    void chars;
    await ctx.telegram.editMessageText(
      ctx.chat.id, processingMsg.message_id, null, launchMsg,
      { parse_mode: 'HTML' }
    );

    await runActivation(ctx, token);
  } catch (err) {
    logger.error(`[TokenScene] file read error: ${err.message}`);
    await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
    const errMsg = lang === 'en'
      ? `❌ Could not read the file: <code>${escapeHtml(err.message)}</code>`
      : `❌ Не удалось прочитать файл: <code>${escapeHtml(err.message)}</code>`;
    await ctx.reply(errMsg, { parse_mode: 'HTML' });
  }
});

tokenCollectionScene.action(DONE_ACTION, async (ctx) => {
  const token = (ctx.scene.state.tokenBuffer || '').trim();
  const lang = ctx.user?.language || 'ru';

  if (!token) {
    const alertMsg = lang === 'en'
      ? '⚠️ Buffer is empty! Send the token as text or file first.'
      : '⚠️ Буфер пуст! Сначала отправьте токен текстом или файлом.';
    return ctx.answerCbQuery(alertMsg, { show_alert: true });
  }

  await ctx.answerCbQuery();
  logger.info(`[TokenScene] done token_len=${token.length}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  const acceptedMsg = lang === 'en'
    ? `⚙️ <b>Received!</b> Token: <b>${token.length} chars</b>\nLaunching activation...`
    : `⚙️ <b>Принято!</b> Итоговый токен: <b>${token.length} симв.</b>\nЗапускаю активацию...`;
  await ctx.reply(acceptedMsg, { parse_mode: 'HTML' });

  await runActivation(ctx, token);
});

// Шаг 1: пользователь нажал "❌ Отмена" → показываем экран подтверждения.
// Отмена возврата денег необратима в рамках этой сессии, нужен явный confirm.
tokenCollectionScene.action(CANCEL_ACTION, async (ctx) => {
  const lang = ctx.user?.language || 'ru';
  await confirmScreen(ctx, {
    title: lang === 'en' ? '⚠️ Cancel the purchase?' : '⚠️ Отменить покупку?',
    message: lang === 'en'
      ? `<blockquote>Funds will be returned to your balance, but the order cannot be resumed — a new one will need to be placed.</blockquote>\n\nIf you just want to change the token — press «Continue» and send another token.`
      : `<blockquote>Деньги вернутся на баланс, но заказ нельзя будет возобновить — нужно будет оформить новый.</blockquote>\n\nЕсли хотите просто сменить токен — нажмите «Продолжить ввод» и отправьте другой токен.`,
    yesLabel: lang === 'en' ? '❗ Yes, cancel & refund' : '❗ Да, отменить и вернуть деньги',
    yesAction: CANCEL_CONFIRM_ACTION,
    noLabel: lang === 'en' ? '⬅️ Continue entering' : '⬅️ Продолжить ввод',
    noAction: CANCEL_ABORT_ACTION,
    danger: true,
  });
});

// Шаг 2a: пользователь подтвердил отмену — выполняем откат.
tokenCollectionScene.action(CANCEL_CONFIRM_ACTION, async (ctx) => {
  const lang = ctx.user?.language || 'ru';
  await ctx.answerCbQuery(lang === 'en' ? '❌ Cancelling...' : '❌ Отменяю...').catch(() => {});
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  const orderId = ctx.scene.state.orderId;
  if (orderId) {
    let cancelledOrder = null;
    let user = null;

    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      cancelledOrder = await Order.findOneAndUpdate(
        { _id: orderId, status: 'awaiting_token' },
        {
          $set: {
            status: 'cancelled',
            activationResult: 'Cancelled by user',
            nextRetryAt: null,
          },
        },
        { new: true, ...sessionOptions }
      );

      if (!cancelledOrder) return;

      await Key.updateOne(
        { usedByOrder: cancelledOrder._id },
        { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
        sessionOptions
      );

      user = await User.findById(cancelledOrder.userId, null, sessionOptions);
      if (user) {
        user.balance = parseFloat((user.balance + cancelledOrder.price).toFixed(8));
        await user.save(sessionOptions);
      }

      await new Transaction({
        userId: cancelledOrder.userId,
        type: 'refund',
        amount: cancelledOrder.price,
        orderId: cancelledOrder._id,
        description: 'Cancelled: user refused token input',
      }).save(sessionOptions);
    });

    if (cancelledOrder) {
      const menuLabel = lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню';
      const cancelledText = lang === 'en'
        ? `❌ <b>Purchase cancelled.</b>\n💰 Funds returned to your balance.`
        : `❌ <b>Покупка отменена.</b>\n💰 Средства возвращены на баланс.`;
      await ctx.reply(cancelledText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(menuLabel, 'menu:main')]]),
      });
      await ctx.scene.leave();
      return;
    }
  }

  const alreadyMsg = lang === 'en' ? '⚠️ Order already processed or cancelled.' : '⚠️ Заказ уже обработан или отменён.';
  const menuLabel2 = lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню';
  await ctx.reply(alreadyMsg, {
    ...Markup.inlineKeyboard([[Markup.button.callback(menuLabel2, 'menu:main')]]),
  });
  await ctx.scene.leave();
});

// Шаг 2b: пользователь передумал — возвращаем обратно к prompt'у ввода токена.
tokenCollectionScene.action(CANCEL_ABORT_ACTION, async (ctx) => {
  await ctx.answerCbQuery('⬅️ Продолжайте ввод').catch(() => {});
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  await sendPrompt(ctx);
});

tokenCollectionScene.on('message', async (ctx) => {
  const lang = ctx.user?.language || 'ru';
  const msg = lang === 'en'
    ? '⚠️ Please send only <b>text</b> or a <b>.txt file</b>.'
    : '⚠️ Пожалуйста, отправьте только <b>текст</b> или <b>.txt файл</b>.';
  await ctx.reply(msg, { parse_mode: 'HTML' });
});

module.exports = tokenCollectionScene;

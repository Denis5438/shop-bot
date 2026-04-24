const { Markup } = require('telegraf');
const TopupRequest = require('../../../models/TopupRequest');
const User = require('../../../models/User');
const Transaction = require('../../../models/Transaction');
const notif = require('../../../services/notification.service');
const { toRub } = require('../../../services/currency.service');
const { withTransaction } = require('../../../services/transactionHelper.service');
const { escapeHtml } = require('../../utils/ui');

const METHOD_LABELS = {
  card: '🏦 Карта Idbank',
  bybit: '📊 Bybit (USDT)',
  unknown: '❓ Неизвестно',
};

const NETWORK_LABELS = {
  trc20: '🔴 TRC-20 (Tron)',
  bep20: '🟡 BEP-20 (BSC)',
  uid: '🆔 Bybit UID',
};

const renderApprovedText = (user, amount) =>
  `✅ <b>Баланс пополнен</b>\n\n` +
  `👤 Пользователь: @${escapeHtml(user.username || user.telegramId)}\n` +
  `💰 Зачислено: <b>${amount.toFixed(2)} USDT</b> (~${toRub(amount)} ₽)\n` +
  `💳 Новый баланс: ${user.balance.toFixed(2)} USDT`;

const showPaymentsList = async (ctx) => {
  const requests = await TopupRequest.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(20)
    .populate('userId');

  if (!requests.length) {
    const emptyOpts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:main')]]),
    };
    const emptyText = `💳 <b>Заявки на пополнение</b>\n\n📭 Нет новых заявок.`;
    try {
      await ctx.editMessageText(emptyText, emptyOpts);
    } catch (_) {
      await ctx.reply(emptyText, emptyOpts).catch(() => {});
    }
    return;
  }

  const buttons = [];
  let text = `💳 <b>Заявки на пополнение</b> (${requests.length})\n\n`;

  for (const request of requests) {
    const date = new Date(request.createdAt).toLocaleDateString('ru-RU');
    const method = METHOD_LABELS[request.method] || request.method;
    const username = request.userId?.username || request.userId?.telegramId;
    const amount = request.amount ? `${request.amount.toFixed(2)} USDT` : '? USDT';
    text += `👤 @${escapeHtml(username || '?')} | ${amount} | ${escapeHtml(method)} | ${date}\n`;
    buttons.push([
      Markup.button.callback(`@${username} — ${amount} — ${method}`, `admin:payment:${request._id}`),
    ]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
};

const showPaymentDetail = async (ctx, requestId) => {
  const request = await TopupRequest.findById(requestId).populate('userId');
  if (!request) return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });

  const user = request.userId;
  const method = METHOD_LABELS[request.method] || request.method;
  const network = request.network ? NETWORK_LABELS[request.network] || request.network : null;

  const amountLine = request.amount
    ? `\n💵 <b>Сумма:</b> <b>${request.amount.toFixed(2)} USDT</b>`
    : '';

  const text =
    `💳 <b>Заявка на пополнение</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Пользователь:</b> ${escapeHtml(user?.firstName || 'нет')} (@${escapeHtml(user?.username || 'нет')})\n` +
    `🆔 <b>ID:</b> <code>${escapeHtml(user?.telegramId || '')}</code>\n` +
    `💰 <b>Способ:</b> ${escapeHtml(method)}\n` +
    (network ? `🌐 <b>Сеть:</b> ${escapeHtml(network)}\n` : '') +
    `${amountLine}\n` +
    `📅 <b>Дата:</b> ${new Date(request.createdAt).toLocaleString('ru-RU')}\n` +
    `🔘 <b>Статус:</b> ${request.status === 'pending' ? '⏳ Ожидает' : request.status}\n\n` +
    (request.proofText
      ? `💬 <b>Хэш / комментарий:</b>\n<code>${escapeHtml(request.proofText)}</code>`
      : `📎 <i>Скриншот прикреплён отдельно</i>`);

  const buttons = [
    [
      Markup.button.callback('✅ Подтвердить', `admin:payment:confirm:${requestId}`),
      Markup.button.callback('❌ Отклонить', `admin:payment:reject:${requestId}`),
    ],
    [Markup.button.url(`✉️ Написать @${user?.username || user?.telegramId}`, `tg://user?id=${user?.telegramId}`)],
    [Markup.button.callback('⬅️ К заявкам', 'admin:payments')],
  ];

  if (request.proofFileId) {
    try {
      await ctx.telegram.sendPhoto(ctx.from.id, request.proofFileId, {
        caption: `📎 Чек от @${user?.username || user?.telegramId}`,
      });
    } catch (_) {}
  }

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
  await ctx.answerCbQuery().catch(() => {});
};

const confirmPayment = async (ctx, requestId) => {
  const request = await TopupRequest.findById(requestId).populate('userId');
  if (!request || request.status !== 'pending') {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  await ctx.answerCbQuery();

  const user = request.userId;
  const amount = request.amount || 0;
  const text =
    `💰 <b>Подтверждение пополнения</b>\n\n` +
    `👤 Пользователь: ${escapeHtml(user?.firstName || 'нет')} (@${escapeHtml(user?.username || user?.telegramId || 'нет')})\n` +
    `💵 Сумма из заявки: <b>${amount.toFixed(2)} USDT</b> (~${toRub(amount)} ₽)\n\n` +
    `Выберите действие:`;

  const buttons = [
    [
      Markup.button.callback('❌ Отказ', `admin:payment:reject:${requestId}`),
      Markup.button.callback('✅ Одобрить', `admin:payment:approve:${requestId}`),
    ],
    [Markup.button.callback('✏️ Редактировать сумму', `admin:payment:edit_amount:${requestId}`)],
    [Markup.button.callback('⬅️ Назад', `admin:payment:${requestId}`)],
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

const approvePayment = async (ctx, requestId) => {
  const request = await TopupRequest.findById(requestId);
  if (!request || request.status !== 'pending') {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  await ctx.answerCbQuery('⏳ Зачисляю...');
  await approveTopupRequest(ctx, requestId, request.amount || 0);
};

const editPaymentAmount = async (ctx, requestId) => {
  const request = await TopupRequest.findById(requestId);
  if (!request || request.status !== 'pending') {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  await ctx.answerCbQuery();

  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'confirm_topup';
  ctx.session.topupRequestId = requestId;

  await ctx.reply(
    `✏️ <b>Введите сумму в USDT</b> для зачисления:\n\n<i>Пример: 5.0</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:payments')]]),
    }
  );
};

const approveTopupRequest = async (ctx, requestId, amount) => {
  let approvedRequest = null;
  let approvedUser = null;

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;
      approvedRequest = await TopupRequest.findOneAndUpdate(
        { _id: requestId, status: 'pending' },
        {
          $set: {
            amount,
            status: 'confirmed',
            adminId: ctx.user._id,
            processedAt: new Date(),
          },
        },
        {
          new: true,
          ...sessionOptions,
        }
      );

      if (!approvedRequest) return;

      approvedUser = await User.findById(approvedRequest.userId, null, sessionOptions);
      if (!approvedUser) {
        await TopupRequest.updateOne(
          { _id: approvedRequest._id },
          { $set: { status: 'pending', adminId: null, processedAt: null } },
          sessionOptions
        );
        throw new Error('TOPUP_USER_NOT_FOUND');
      }

      approvedUser.balance = parseFloat((approvedUser.balance + amount).toFixed(8));
      await approvedUser.save(sessionOptions);

      await new Transaction({
        userId: approvedUser._id,
        type: 'topup',
        amount,
        description: `Пополнение подтверждено администратором (${amount} USDT)`,
      }).save(sessionOptions);
    });
  } catch (err) {
    if (err.message === 'TOPUP_USER_NOT_FOUND') {
      await ctx.reply('❌ Пользователь не найден, заявка не подтверждена.');
      return false;
    }
    throw err;
  }

  if (!approvedRequest || !approvedUser) {
    // Race condition: другой админ уже обработал заявку.
    // answerCbQuery мог быть вызван ранее в approvePayment — повторный вызов
    // вернёт "query is too old" от Telegram, поэтому просто сообщаем через
    // текст сообщения (с fallback на reply).
    const text = '⚠️ Заявка уже была обработана другим администратором.';
    const opts = {
      ...Markup.inlineKeyboard([[Markup.button.callback('💳 К заявкам', 'admin:payments')]]),
    };

    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    return false;
  }

  await notif.notifyUserTopupConfirmed(approvedUser, amount);

  const text = renderApprovedText(approvedUser, amount);
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('💳 К заявкам', 'admin:payments')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('💳 К заявкам', 'admin:payments')]]),
    });
  }

  return true;
};

const finalizeTopup = async (ctx, amountText) => {
  const requestId = ctx.session?.topupRequestId;
  if (!requestId) return false;

  const amount = parseFloat(amountText.trim().replace(',', '.'));
  if (Number.isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Неверная сумма. Введите число больше 0:');
    return true;
  }

  ctx.session.adminAction = null;
  ctx.session.topupRequestId = null;

  const request = await TopupRequest.findById(requestId);
  if (!request || request.status !== 'pending') {
    await ctx.reply('⚠️ Заявка уже обработана.');
    return true;
  }

  await ctx.reply(`✅ Зачисляю <b>${amount.toFixed(2)} USDT</b>...`, { parse_mode: 'HTML' });
  await approveTopupRequest(ctx, requestId, amount);
  return true;
};

const rejectPayment = async (ctx, requestId) => {
  const request = await TopupRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        adminId: ctx.user._id,
        processedAt: new Date(),
      },
    },
    { new: true }
  ).populate('userId');

  if (!request) {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  const user = request.userId?.telegramId ? request.userId : await User.findById(request.userId);
  if (user) {
    await notif.notifyUserTopupRejected(user, request.amount || 0, 'Не прошла проверку');
  }

  await ctx.answerCbQuery('❌ Заявка отклонена');
  await showPaymentsList(ctx);
};

module.exports = {
  showPaymentsList,
  showPaymentDetail,
  confirmPayment,
  approvePayment,
  editPaymentAmount,
  finalizeTopup,
  rejectPayment,
};

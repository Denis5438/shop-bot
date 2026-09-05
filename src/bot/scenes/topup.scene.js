const { Markup } = require('telegraf');
const TopupRequest = require('../../models/TopupRequest');
const User = require('../../models/User');
const { getRate, toRub } = require('../../services/currency.service');
const notif = require('../../services/notification.service');
const { parseAmount, copyHint, escapeHtml, fmtUSDT } = require('../utils/ui');
const { SLA } = require('../constants/ux');
const { startProgress } = require('../utils/progress');
const { getSettings } = require('../../services/settingsCache.service');

// ─── Вспомогательная функция ──────────────────────────────────────────────────
const editOrReply = async (ctx, text, extra) => {
  try {
    if (ctx.callbackQuery) {
      return await ctx.editMessageText(text, extra);
    }
  } catch (_) { }
  return await ctx.reply(text, extra);
};

// Форматирование суммы: fmtUSDT теперь общий (из utils/ui)
const fmtRUB = (rub) => {
  const rate = getRate();
  const usdt = rub / rate;
  return `${rub.toFixed(0)} ₽ (~${usdt.toFixed(2)} USDT)`;
};

// ─── Шаг 1: Выбор суммы (пресеты + своя сумма) ──────────────────────────────
const startTopup = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = { step: 'amount', currency: 'usdt', msgId: null };
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const rate = getRate();

  const currencyLine = lang === 'en'
    ? `💱 Rate: <b>1 USDT = ${rate.toFixed(2)} ₽</b>`
    : `💱 Курс: <b>1 USDT = ${rate.toFixed(2)} ₽</b>`;
  const hint = lang === 'en'
    ? `Example: <code>5</code> - is ~${(5 * rate).toFixed(0)} ₽`
    : `Например: <code>5</code> - это ~${(5 * rate).toFixed(0)} ₽`;

  const presets = [5, 10, 20, 50, 100];
  const presetLabel = 'USDT';

  const presetRow1 = presets.slice(0, 3).map((v) =>
    Markup.button.callback(`${v} ${presetLabel}`, `topup:preset:usdt:${v}`)
  );
  const presetRow2 = presets.slice(3).map((v) =>
    Markup.button.callback(`${v} ${presetLabel}`, `topup:preset:usdt:${v}`)
  );

  const customAmountLabel = t('btn_custom_amount') || (lang === 'en' ? '✍️ Custom amount' : '✍️ Своя сумма');
  const cancelLabel = t('btn_cancel') || (lang === 'en' ? '❌ Cancel' : '❌ Отмена');

  const text = lang === 'en'
    ? `💬 <b>Enter amount in USDT:</b>\n\n` +
      `${currencyLine}\n` +
      `${hint}\n\n` +
      `<blockquote>💡 Or choose a common amount using the buttons below.</blockquote>`
    : `💬 <b>Введите сумму в USDT:</b>\n\n` +
      `${currencyLine}\n` +
      `${hint}\n\n` +
      `<blockquote>💡 Или выберите частую сумму одной кнопкой ниже.</blockquote>`;

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      presetRow1,
      presetRow2,
      [Markup.button.callback(customAmountLabel, 'topup:custom_amount')],
      [Markup.button.callback(cancelLabel, 'menu:main')],
    ]),
  };

  const sent = await editOrReply(ctx, text, opts);
  if (sent && ctx.session.topup) {
    ctx.session.topup.msgId = sent.message_id;
  }
};

// ─── Шаг 1.1: Экран ввода своей суммы ─────────────────────────────────────────
const showCustomAmountPrompt = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  ctx.session.topup.step = 'custom_amount';
  ctx.session.topup.currency = 'usdt';
  const lang = ctx.user?.language || 'ru';
  const rate = getRate();
  const settings = await getSettings();
  const minTopup = settings?.minTopup || 1;

  const text = lang === 'en'
    ? `💬 <b>Enter top-up amount in USDT:</b>\n\n` +
      `💱 Rate: <b>1 USDT = ${rate.toFixed(2)} ₽</b>\n` +
      `📌 Minimum amount: <b>${minTopup} USDT</b>\n\n` +
      `Type the number in your message (e.g., <code>15</code> or <code>25.5</code>):`
    : `💬 <b>Введите желаемую сумму пополнения в USDT:</b>\n\n` +
      `💱 Курс: <b>1 USDT = ${rate.toFixed(2)} ₽</b>\n` +
      `📌 Минимальная сумма: <b>${minTopup} USDT</b>\n\n` +
      `Напишите число в сообщении (например: <code>15</code> или <code>25.5</code>):`;

  const buttons = [
    [Markup.button.callback(lang === 'en' ? '⬅️ Back to amounts' : '⬅️ Назад к выбору сумм', 'menu:topup')],
    [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:main')],
  ];

  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
  await ctx.answerCbQuery().catch(() => {});
};

// ─── Шаг 2: Выбор способа оплаты (после выбора суммы) ────────────────────────
const showPaymentMethods = async (ctx) => {
  ctx.session = ctx.session || {};
  const topup = ctx.session.topup;
  const lang = ctx.user?.language || 'ru';
  const t = ctx.t || ((k) => k);

  if (!topup || !topup.amountUSDT) {
    return startTopup(ctx);
  }

  topup.step = 'method';

  const settings = await getSettings();
  const buttons = [];

  const sbpLabel = lang === 'en' ? '⚡ SBP (Instant)' : '⚡ СБП (Автоматически)';
  const idbankLabel = lang === 'en' ? '🏦 IDBank Card (Manual)' : '🏦 Перевод на IDBank (Вручную)';
  const bybitLabel = lang === 'en' ? '📊 Bybit / USDT (TRC-20, BEP-20)' : '📊 Bybit / USDT (TRC-20, BEP-20)';
  const changeAmountLabel = t('btn_change_amount') || (lang === 'en' ? '⬅️ Change amount' : '⬅️ Изменить сумму');
  const cancelLabel = t('btn_cancel') || (lang === 'en' ? '❌ Cancel' : '❌ Отмена');

  if (settings?.plategaEnabled !== false) {
    buttons.push([Markup.button.callback(sbpLabel, 'topup:pay:platega')]);
  }
  if (settings?.cardEnabled !== false) {
    buttons.push([Markup.button.callback(idbankLabel, 'topup:pay:card')]);
  }
  if (settings?.bybitEnabled !== false) {
    buttons.push([Markup.button.callback(bybitLabel, 'topup:pay:bybit')]);
  }

  if (buttons.length === 0) {
    const closedText = lang === 'en'
      ? '💳 <b>Balance top-up is temporarily unavailable.</b>\n\nPlease try again later or contact support.'
      : '💳 <b>Пополнение баланса временно приостановлено.</b>\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.';
    const closedButtons = [
      [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
      [Markup.button.callback(changeAmountLabel, 'menu:topup')],
    ];
    return editOrReply(ctx, closedText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(closedButtons) });
  }

  buttons.push([Markup.button.callback(changeAmountLabel, 'menu:topup')]);
  buttons.push([Markup.button.callback(cancelLabel, 'menu:main')]);

  const title = lang === 'en' ? 'Balance Top Up' : 'Пополнение баланса';
  const choose = lang === 'en' ? 'Select a payment method:' : 'Выберите удобный способ оплаты:';
  const amountLbl = lang === 'en' ? 'Top-up amount' : 'Сумма к пополнению';

  const text =
    `💳 <b>${title}</b>\n\n` +
    `<blockquote>💰 ${amountLbl}: <b>${topup.amountUSDT} USDT</b> (~${topup.amountRUB.toFixed(0)} ₽)</blockquote>\n\n` +
    `${choose}`;

  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
};

// Быстрое пополнение на конкретную сумму (из карточки товара)
const startTopupWithAmount = async (ctx, amount) => {
  ctx.session = ctx.session || {};
  const rate = getRate();
  ctx.session.topup = {
    amountUSDT: amount,
    amountRUB: amount * rate,
    currency: 'usdt',
    quickAmount: amount,
    step: 'method',
  };
  return showPaymentMethods(ctx);
};

const showDirectOptions = async (ctx) => {
  return showPaymentMethods(ctx);
};

// ─── Шаг 3а: СБП Автоматически (Platega) ──────────────────────────────────────
const showPlategaDetails = async (ctx) => {
  const settings = await getSettings();
  if (settings?.plategaEnabled === false) {
    const lang = ctx.user?.language || 'ru';
    await ctx.answerCbQuery(lang === 'en' ? '⚠️ This payment method is temporarily disabled' : '⚠️ Этот способ оплаты временно отключён администратором', { show_alert: true });
    return showPaymentMethods(ctx);
  }
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  if (!ctx.session.topup.amountUSDT) {
    return startTopup(ctx);
  }
  ctx.session.topup.method = 'platega';
  ctx.session.topup.network = null;
  return generateRequisitesAndShow(ctx);
};

// ─── Шаг 3б: Карта IDBank (Вручную) ──────────────────────────────────────────
const showCardDetails = async (ctx) => {
  const settings = await getSettings();
  if (settings?.cardEnabled === false) {
    const lang = ctx.user?.language || 'ru';
    await ctx.answerCbQuery(lang === 'en' ? '⚠️ This payment method is temporarily disabled' : '⚠️ Этот способ оплаты временно отключён администратором', { show_alert: true });
    return showPaymentMethods(ctx);
  }
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  if (!ctx.session.topup.amountUSDT) {
    return startTopup(ctx);
  }
  ctx.session.topup.method = 'card';
  ctx.session.topup.network = null;
  return generateRequisitesAndShow(ctx);
};

// ─── Шаг 3в: Bybit - выбор сети ──────────────────────────────────────────────
const showBybitOptions = async (ctx) => {
  const settings = await getSettings();
  if (settings?.bybitEnabled === false) {
    const lang = ctx.user?.language || 'ru';
    await ctx.answerCbQuery(lang === 'en' ? '⚠️ This payment method is temporarily disabled' : '⚠️ Этот способ оплаты временно отключён администратором', { show_alert: true });
    return showPaymentMethods(ctx);
  }
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  if (!ctx.session.topup.amountUSDT) {
    return startTopup(ctx);
  }
  ctx.session.topup.method = 'bybit';
  const topup = ctx.session.topup;
  const lang = ctx.user?.language || 'ru';
  const title = lang === 'en' ? 'Top Up via Bybit (USDT)' : 'Пополнение через Bybit (USDT)';
  const chooseLbl = lang === 'en' ? 'Choose a network:' : 'Выберите сеть:';
  const amountLbl = lang === 'en' ? 'Top-up amount' : 'Сумма к пополнению';

  await editOrReply(ctx,
    `📊 <b>${title}</b>\n\n` +
    `<blockquote>💰 ${amountLbl}: <b>${topup.amountUSDT} USDT</b> (~${topup.amountRUB.toFixed(0)} ₽)</blockquote>\n\n` +
    `${chooseLbl}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔴 TRC-20 (Tron)', 'topup:network:trc20')],
        [Markup.button.callback('🟡 BEP-20 (BSC)', 'topup:network:bep20')],
        [Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:methods:back')],
      ]),
    }
  );
};

const BYBIT_NETWORKS = {
  trc20: { icon: '🔴', label: 'TRC-20 (Tron)' },
  bep20: { icon: '🟡', label: 'BEP-20 (BSC)' },
  uid: { icon: '🆔', label: 'Bybit UID (Внутренний)' },
};

const getBybitAddresses = async () => {
  const { getSettings } = require('../../services/settingsCache.service');
  const settings = await getSettings();
  return {
    trc20: { ...BYBIT_NETWORKS.trc20, address: settings?.bybitTrc20Address || '' },
    bep20: { ...BYBIT_NETWORKS.bep20, address: settings?.bybitBep20Address || '' },
    uid: { ...BYBIT_NETWORKS.uid, address: settings?.bybitUid || '' },
  };
};

const showBybitNetwork = async (ctx, network) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  if (!ctx.session.topup.amountUSDT) {
    return startTopup(ctx);
  }
  ctx.session.topup.method = 'bybit';
  ctx.session.topup.network = network;
  return generateRequisitesAndShow(ctx);
};

// Обработчик кнопки-пресета
const handlePresetAmount = async (ctx, currency, amountStr) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = ctx.session.topup || {};
  const topup = ctx.session.topup;
  const lang = ctx.user?.language || 'ru';

  const parsed = parseAmount(amountStr);
  if (!parsed.ok) {
    return ctx.answerCbQuery(lang === 'en' ? '⚠️ Invalid amount' : '⚠️ Некорректная сумма', { show_alert: true }).catch(() => null);
  }

  const rate = getRate();
  const val = parsed.value;
  topup.currency = currency;
  topup.amountUSDT = currency === 'usdt' ? val : val / rate;
  topup.amountRUB = currency === 'usdt' ? val * rate : val;

  await ctx.answerCbQuery(lang === 'en' ? `💵 Amount: ${amountStr} USDT` : `💵 Сумма: ${amountStr} USDT`).catch(() => null);

  return showPaymentMethods(ctx);
};

// Ввод суммы текстом
const handleAmountInput = async (ctx, rawAmount = null) => {
  const topup = ctx.session?.topup;
  if (!topup || (topup.step !== 'amount' && topup.step !== 'custom_amount')) return false;
  const lang = ctx.user?.language || 'ru';

  const parsed = parseAmount(rawAmount ?? ctx.message?.text ?? '');

  if (!parsed.ok) {
    const errorMsg = lang === 'en' && parsed.reason.includes('Некорректная') ? 'Invalid amount format' : parsed.reason;
    await ctx.reply(
      `❌ ${errorMsg}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:topup')]]),
      }
    );
    return true;
  }

  const inputAmount = parsed.value;

  if (ctx.message?.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const rate = getRate();
  const { currency = 'usdt' } = topup;

  let amountUSDT, amountRUB;
  if (currency === 'usdt') {
    amountUSDT = inputAmount;
    amountRUB = inputAmount * rate;
  } else {
    amountRUB = inputAmount;
    amountUSDT = inputAmount / rate;
  }

  const { getSettings } = require('../../services/settingsCache.service');
  const settings = await getSettings();
  const minTopup = settings?.minTopup || 1;

  if (amountUSDT < minTopup) {
    const minRub = Math.ceil(minTopup * rate);
    const errMsg = currency === 'usdt'
      ? (lang === 'en' ? `❌ <b>Minimum top-up amount - ${minTopup} USDT</b>\n\nEnter the amount again:` : `❌ <b>Минимальная сумма пополнения - ${minTopup} USDT</b>\n\nВведите сумму ещё раз:`)
      : (lang === 'en' ? `❌ <b>Minimum top-up amount - ${minRub} ₽</b> (~${minTopup} USDT)\n\nEnter the amount again:` : `❌ <b>Минимальная сумма пополнения - ${minRub} ₽</b> (~${minTopup} USDT)\n\nВведите сумму ещё раз:`);
    await ctx.reply(errMsg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:topup')]]),
    });
    return true;
  }

  topup.amountUSDT = amountUSDT;
  topup.amountRUB = amountRUB;
  topup.currency = currency;

  return showPaymentMethods(ctx);
};

// ─── Генерация счёта / реквизитов выбранного способа ─────────────────────────
const generateRequisitesAndShow = async (ctx) => {
  const topup = ctx.session?.topup;
  if (!topup || !topup.amountUSDT) {
    return startTopup(ctx);
  }

  const lang = ctx.user?.language || 'ru';
  const rate = getRate();
  const { method, network, amountUSDT, amountRUB } = topup;
  const { getSettings } = require('../../services/settingsCache.service');
  const settings = await getSettings();
  const minTopup = settings?.minTopup || 1;

  // ─── Обработка пополнения через СБП (Platega) ──────────────────────────────
  if (method === 'platega') {
    const plategaService = require('../../services/platega.service');
    const plategaConfig = await plategaService.getPlategaConfig();
    if (!plategaConfig.isReady) {
      await editOrReply(ctx, lang === 'en' ? '❌ SBP payment is temporarily unavailable. Please choose another payment method.' : '❌ Оплата через СБП временно недоступна. Пожалуйста, выберите другой способ пополнения.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '🏦 IDBank Card (Manual)' : '🏦 Перевод на IDBank (Вручную)', 'topup:pay:card')],
          [Markup.button.callback(lang === 'en' ? '📊 Bybit / USDT' : '📊 Bybit / USDT', 'topup:pay:bybit')],
          [Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:methods:back')],
        ]),
      });
      return true;
    }

    const roundedRub = Math.max(1, Math.round(amountRUB));
    const request = new TopupRequest({
      userId: ctx.user._id,
      amount: amountUSDT,
      amountRub: roundedRub,
      method: 'platega',
      status: 'pending',
    });
    await request.save();

    let pRes;
    try {
      pRes = await plategaService.createPayment({
        amountRub: roundedRub,
        description: `Пополнение баланса @${ctx.user.username || ctx.user.telegramId} (${amountUSDT} USDT)`,
        payload: String(request._id),
        userId: ctx.user.telegramId,
        userName: ctx.user.username,
      });
    } catch (err) {
      await TopupRequest.deleteOne({ _id: request._id }).catch(() => {});
      const logger = require('../../config/logger');
      logger.error(`[Platega Topup Error]: ${err.message}`);
      await editOrReply(ctx, lang === 'en' ? '❌ Failed to create SBP payment invoice. Please try again later or use another method.' : '❌ Не удалось создать счёт для оплаты через СБП. Попробуйте позже или выберите другой способ.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:methods:back')],
          [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
        ]),
      });
      return true;
    }

    request.paymentId = pRes.transactionId;
    request.payUrl = pRes.payUrl;
    await request.save();

    ctx.session.topup = null; // Завершаем FSM ввода

    const text = lang === 'en'
      ? `⚡ <b>SBP Payment (Instant)</b>\n\n` +
        `<blockquote>💰 Amount to pay: <b>${roundedRub} ₽</b> (≈ ${amountUSDT.toFixed(2)} USDT)\n` +
        `💱 Rate: 1 USDT = ${rate.toFixed(2)} ₽\n` +
        `⏱ Link expires in: 15 minutes</blockquote>\n\n` +
        `1️⃣ Click <b>«Pay ${roundedRub} ₽ via SBP»</b> below.\n` +
        `2️⃣ Select your bank and confirm payment in the bank app.\n` +
        `3️⃣ Balance will be credited automatically upon payment, or tap <b>«Check payment»</b>!`
      : `⚡ <b>Пополнение через СБП (Автоматически)</b>\n\n` +
        `<blockquote>💰 Сумма к оплате: <b>${roundedRub} ₽</b> (≈ ${amountUSDT.toFixed(2)} USDT)\n` +
        `💱 Курс: 1 USDT = ${rate.toFixed(2)} ₽\n` +
        `⏱ Ссылка активна: 15 минут</blockquote>\n\n` +
        `1️⃣ Нажмите кнопку <b>«Оплатить ${roundedRub} ₽ через СБП»</b> ниже.\n` +
        `2️⃣ Выберите свой банк и подтвердите перевод в приложении банка.\n` +
        `3️⃣ Баланс зачислится автоматически, либо нажмите <b>«Проверить оплату»</b>!`;

    const buttons = [
      [Markup.button.url(lang === 'en' ? `🔗 Pay ${roundedRub} ₽ via SBP` : `🔗 Оплатить ${roundedRub} ₽ через СБП`, pRes.payUrl)],
      [Markup.button.callback(lang === 'en' ? '🔄 Check payment' : '🔄 Проверить оплату', `topup:platega:check:${request._id}`)],
      [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', `topup:platega:cancel:${request._id}`)],
    ];

    if (topup.msgId && ctx.telegram?.editMessageText) {
      await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons),
      }).catch(() => editOrReply(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
    } else {
      await editOrReply(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
    return true;
  }

  const isAutoCrypto = method === 'bybit';

  // Строим реквизиты
  let reqs = '';
  const transferAmount = method === 'card'
    ? `<b>${amountRUB.toFixed(0)} ₽</b> (≈ ${amountUSDT.toFixed(2)} USDT)`
    : `<b>${amountUSDT.toFixed(2)} USDT</b> (≈ ${amountRUB.toFixed(0)} ₽)`;

  let net = null;
  let topupAddr = '';

  if (method === 'card') {
    const cardNumber = String(settings?.cardNumber || '').trim();
    const cardHolder = String(settings?.cardHolder || '').trim();
    if (!cardNumber || !cardHolder) {
      await editOrReply(ctx, lang === 'en' ? '❌ Card details are not configured. Contact support or choose another payment method.' : '❌ Реквизиты карты не настроены. Обратитесь в поддержку или выберите другой способ пополнения.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:methods:back')],
          [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
        ]),
      });
      return true;
    }

    reqs = lang === 'en'
      ? `<blockquote>🏦 <b>Card details:</b>\n\n` +
        `💳 Card number:\n<code>${escapeHtml(cardNumber)}</code>\n\n` +
        `👤 Recipient:\n<code>${escapeHtml(cardHolder)}</code></blockquote>` + copyHint(lang)
      : `<blockquote>🏦 <b>Реквизиты карты:</b>\n\n` +
        `💳 Номер карты:\n<code>${escapeHtml(cardNumber)}</code>\n\n` +
        `👤 Получатель:\n<code>${escapeHtml(cardHolder)}</code></blockquote>` + copyHint(lang);
  } else {
    const bybitAddresses = await getBybitAddresses();
    net = bybitAddresses[network];
    topupAddr = network === 'trc20' && settings?.topupWallet ? settings.topupWallet : net?.address;
    topupAddr = String(topupAddr || '').trim();
    if (!net || !topupAddr) {
      await editOrReply(ctx, lang === 'en' ? '❌ Details for the selected network are not configured. Contact support or choose another payment method.' : '❌ Реквизиты для выбранной сети не настроены. Обратитесь в поддержку или выберите другой способ пополнения.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '⬅️ Bybit networks' : '⬅️ К сетям Bybit', 'topup:pay:bybit')],
          [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
        ]),
      });
      return true;
    }

    reqs = lang === 'en'
      ? `<blockquote>${net.icon} <b>Bybit · ${net.label}:</b>\n\n` +
        `📬 ${network === 'uid' ? 'UID' : 'Address'}:\n<code>${escapeHtml(topupAddr)}</code></blockquote>` + copyHint(lang)
      : `<blockquote>${net.icon} <b>Bybit · ${net.label}:</b>\n\n` +
        `📬 ${network === 'uid' ? 'UID' : 'Адрес'}:\n<code>${escapeHtml(topupAddr)}</code></blockquote>` + copyHint(lang);
  }

  topup.step = isAutoCrypto ? 'waiting_txid_btn' : 'proof';

  let text = '';
  if (isAutoCrypto) {
    const isBsc = network === 'bep20';
    const label = isBsc ? 'BSC (BEP20)' : 'Tron (TRC20)';
    const coin = 'USDT';

    text = lang === 'en'
      ? `🌐 <b>Top Up USDT (${network.toUpperCase()})</b>\n\n` +
        `🪙 Coin: ${coin}\n` +
        `🔗 Network: ${label}\n` +
        `📉 Minimum: ${minTopup.toFixed(3)} ${coin}\n\n` +
        `① Send <b>${amountUSDT.toFixed(2)} USDT</b> to this address:\n` +
        `<code>${escapeHtml(topupAddr)}</code>` + copyHint(lang) + `\n\n` +
        `② After sending, click the button below and paste the TXID.\n\n` +
        `⚠️ DO NOT use other networks - funds will be lost.\n` +
        `⚠️ Make sure it is ${label} and ${coin}.`
      : `🌐 <b>Пополнение USDT (${network.toUpperCase()})</b>\n\n` +
        `🪙 Монета: ${coin}\n` +
        `🔗 Блокчейн: ${label}\n` +
        `📉 Минимум: ${minTopup.toFixed(3)} ${coin}\n\n` +
        `① Отправьте <b>${amountUSDT.toFixed(2)} USDT</b> на этот адрес:\n` +
        `<code>${escapeHtml(topupAddr)}</code>` + copyHint(lang) + `\n\n` +
        `② После отправки нажмите кнопку ниже и вставьте TXID.\n\n` +
        `⚠️ НЕ используйте другие сети - средства будут потеряны.\n` +
        `⚠️ Убедитесь, что это ${label} и ${coin}.`;
  } else {
    text = lang === 'en'
      ? `${reqs}\n\n` +
        `<blockquote>💵 <b>Transfer amount:</b> ${transferAmount}\n` +
        `💱 Rate: 1 USDT = ${rate.toFixed(2)} ₽</blockquote>\n\n` +
        `📸 Transfer the funds and click "I paid", then send a <b>screenshot of the receipt</b>.`
      : `${reqs}\n\n` +
        `<blockquote>💵 <b>Сумма перевода:</b> ${transferAmount}\n` +
        `💱 Курс: 1 USDT = ${rate.toFixed(2)} ₽</blockquote>\n\n` +
        `📸 Переведите и нажмите «Я оплатил», затем пришлите <b>скриншот чека</b>.`;
  }

  const buttons = [];
  if (isAutoCrypto) {
    buttons.push([Markup.button.callback(network === 'uid' ? (lang === 'en' ? '🔎 I sent it - enter UID' : '🔎 Я перевёл - отправить UID') : (lang === 'en' ? '🔎 I sent it - enter TXID' : '🔎 Я отправил - ввести TXID'), 'topup:enter_txid')]);
    buttons.push([Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад к сетям', 'topup:pay:bybit')]);
  } else {
    buttons.push([Markup.button.callback(lang === 'en' ? '✅ I paid' : '✅ Я оплатил', 'topup:card_paid')]);
    buttons.push([Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:methods:back')]);
    buttons.push([Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:main')]);
  }

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  };

  if (topup.msgId && ctx.telegram?.editMessageText) {
    await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, text, opts).catch(() => editOrReply(ctx, text, opts));
  } else {
    await editOrReply(ctx, text, opts);
  }

  return true;
};

// Обработчик кнопки "Ввести TXID"
const handleEnterTxid = async (ctx) => {
  const topup = ctx.session?.topup;
  const lang = ctx.user?.language || 'ru';
  if (!topup || topup.step !== 'waiting_txid_btn') {
    return ctx.answerCbQuery(lang === 'en' ? '❌ First enter the amount or you have already proceeded to send' : '❌ Сначала введите сумму или вы уже перешли к отправке', { show_alert: true }).catch(() => null);
  }

  topup.step = 'proof'; // Разрешаем ввод текста

  const isUid = topup.network === 'uid';
  const text = isUid 
    ? (lang === 'en' ? 'Отправьте ваш <b>Bybit UID</b>, с которого был совершён перевод:' : 'Отправьте ваш <b>Bybit UID</b>, с которого был совершён перевод:')
    : (lang === 'en' ? 'Отправьте <b>TXID (хэш транзакции)</b> следующим сообщением:' : 'Отправьте <b>TXID (хэш транзакции)</b> следующим сообщением:');
    
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };

  await ctx.answerCbQuery().catch(() => null);

  if (topup.msgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, text, opts).catch(() => {
      ctx.reply(text, opts).then(m => topup.msgId = m.message_id);
    });
  } else {
    const m = await ctx.reply(text, opts);
    topup.msgId = m.message_id;
  }
};

// ─── Пользователь прислал скриншот ───────────────────────────────────────────
const handleTopupProof = async (ctx) => {
  const topup = ctx.session?.topup;
  if (!topup || topup.step !== 'proof') return false;

  const { method, network, amountUSDT, amountRUB } = topup;
  const user = ctx.user;
  const lang = user?.language || 'ru';
  const rate = getRate();

  let proofText = null;
  let proofFileId = null;

  if (ctx.message?.photo) {
    proofFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    proofText = ctx.message.caption || null;
  } else if (ctx.message?.document) {
    proofFileId = ctx.message.document.file_id;
  } else if (ctx.message?.text) {
    proofText = ctx.message.text.trim();
  } else {
    const errText = lang === 'en' ? '❌ Please send a screenshot of the receipt or transaction hash (TXID).' : '❌ Пришлите скриншот чека или хэш транзакции (TXID).';
    const errOpts = { ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню', 'menu:main')]]) };
    if (topup.msgId) {
       await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errText, errOpts).catch(()=>ctx.reply(errText, errOpts));
    } else {
       await ctx.reply(errText, errOpts);
    }
    return true;
  }

  // Удаляем сообщение пользователя с TXID или чеком (чистый чат)
  if (ctx.message?.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const isAutoCrypto = method === 'bybit';
  const blockchain = require('../../services/blockchain.service');

  let requestStatus = 'pending';
  let finalAmountUSDT = amountUSDT;
  let checkingMsgId = null;
  let statusReason = null;
  let finalTxid = proofText; // По умолчанию (для блокчейнов) TXID = присланный текст
  let txVerifiedOnChain = false; // Транзакция реально найдена в блокчейне
  let txFromAddress = null;

  if (isAutoCrypto && proofText && !proofFileId) {
    // В случае с блокчейном присланный текст - это TXID.
    // В случае с UID присланный текст - это UID отправителя.

    if (network !== 'uid') {
      // Нормализация TXID (lowercase, префикс 0x) - без неё один хэш в разных
      // написаниях обходит unique-индекс и зачисляется многократно.
      const norm = blockchain.normalizeTxid(proofText, network);
      if (!norm.ok) {
        const errTxt = lang === 'en' ? '❌ This does not look like a valid transaction hash (TXID). Please check and send again.' : '❌ Это не похоже на корректный хэш транзакции (TXID). Проверьте и отправьте ещё раз.';
        const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };
        if (topup.msgId) { await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(()=>ctx.reply(errTxt, errOpts)); } else { await ctx.reply(errTxt, errOpts); }
        return true;
      }
      proofText = norm.txid;
      finalTxid = norm.txid;

      // Ищем и по нормализованному виду, и по историческим "сырым" записям
      // (другой регистр / с и без 0x), созданным до внедрения нормализации.
      const bareHash = proofText.replace(/^0x/, '');
      const exists = await TopupRequest.findOne({
        $or: [
          { txid: { $in: [proofText, bareHash, '0x' + bareHash] } },
          { txid: { $regex: `^(0x)?${bareHash}$`, $options: 'i' } },
        ],
      });
      if (exists) {
        const errTxt = lang === 'en' ? '❌ This TXID has already been used for top-up!' : '❌ Этот TXID уже был использован для пополнения!';
        const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };
        if (topup.msgId) { await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(()=>ctx.reply(errTxt, errOpts)); } else { await ctx.reply(errTxt, errOpts); }
        return true;
      }
    }

    // Защита от impersonation для Bybit UID: юзер сам указывает UID отправителя,
    // поэтому без привязки к user._id злоумышленник мог бы заявить чужой UID
    // и получить его депозит. Логика:
    //   1) Если у этого юзера уже есть привязанный UID и он не совпадает с введённым -
    //      отказ. Смена UID разрешена только через поддержку.
    //   2) Если этот UID уже привязан к ДРУГОМУ юзеру - отказ.
    // First-claim wins: первый, кто успешно пополнится с UID, закрепляет его за собой
    // (привязка произойдёт ниже, после подтверждённой транзакции).
    if (network === 'uid') {
      const uidInput = proofText.trim();

      if (user.bybitUid && user.bybitUid !== uidInput) {
        const mask = `***${String(user.bybitUid).slice(-4)}`;
        const errTxt = lang === 'en'
          ? `❌ <b>UID does not match yours</b>\n\nUID <code>${mask}</code> is already linked to your account.\nIf you changed your Bybit account - contact support.`
          : `❌ <b>UID не совпадает с вашим</b>\n\nК вашему аккаунту уже привязан UID: <code>${mask}</code>.\nЕсли вы сменили Bybit-аккаунт - обратитесь в поддержку.`;
        const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };
        if (topup.msgId) { await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(() => ctx.reply(errTxt, errOpts)); } else { await ctx.reply(errTxt, errOpts); }
        return true;
      }

      if (!user.bybitUid) {
        const claimedByOther = await User.findOne({ bybitUid: uidInput, _id: { $ne: user._id } }).select('_id').lean();
        if (claimedByOther) {
          const errTxt = lang === 'en' 
            ? '❌ <b>This UID is already linked to another account.</b>\n\nIf this is an error, please contact support.'
            : '❌ <b>Этот UID уже привязан к другому аккаунту.</b>\n\nЕсли это ошибка - напишите в поддержку.';
          const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };
          if (topup.msgId) { await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(() => ctx.reply(errTxt, errOpts)); } else { await ctx.reply(errTxt, errOpts); }
          return true;
        }
      }
    }

    const { getSettings } = require('../../services/settingsCache.service');
    const settings = await getSettings();
    const bybitAddresses = await getBybitAddresses();
    const net = bybitAddresses[network];
    const topupAddr = String((network === 'trc20' && settings?.topupWallet ? settings.topupWallet : net?.address) || '').trim();
    if (!net || !topupAddr) {
      await ctx.reply(lang === 'en' ? '❌ Details for the selected network are not configured right now. Contact support.' : '❌ Реквизиты для выбранной сети сейчас не настроены. Обратитесь в поддержку.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
          [Markup.button.callback(lang === 'en' ? '⬅️ Menu' : '⬅️ В меню', 'menu:main')],
        ]),
      });
      return true;
    }

    // UX-16: анимированный прогресс с реалистичными шагами вместо статичного "⏳ Проверяю...".
    const progress = await startProgress(ctx, {
      title: lang === 'en' ? '🔎 <b>Checking transaction</b>' : '🔎 <b>Проверяю транзакцию</b>',
      steps: [
        { label: lang === 'en' ? '🔗 Connecting to blockchain' : '🔗 Подключаюсь к блокчейну', pct: 25 },
        { label: lang === 'en' ? `🔍 Searching transaction in ${network.toUpperCase()}` : `🔍 Ищу транзакцию в сети ${network.toUpperCase()}`, pct: 55 },
        { label: lang === 'en' ? '💰 Verifying amount and recipient' : '💰 Сверяю сумму и адрес получателя', pct: 80 },
        { label: lang === 'en' ? '⏳ Finalizing' : '⏳ Финализация', pct: 95 },
      ],
      // 1500 мс editMessage на пользователя быстро выжигали общий rate-limit
      intervalMs: 3000,
      editMessageId: topup.msgId || null,
    });
    checkingMsgId = progress?.messageId || topup.msgId || null;

    let bResult = { success: false, reason: 'Неизвестная сеть' };
    if (network === 'trc20') {
      bResult = await blockchain.verifyTrc20Usdt(proofText, topupAddr);
    } else if (network === 'bep20') {
      bResult = await blockchain.verifyBep20Usdt(proofText, topupAddr);
    } else if (network === 'uid') {
      // Для UID proofText - это UID отправителя. 
      // Проверяем API!
      bResult = await blockchain.verifyUidUsdt(proofText);
      if (bResult.success && bResult.matches) {
        let foundUnclaimed = false;
        // Ищем среди успешных переводов от этого пользователя тот, которого еще нет в базе
        for (const match of bResult.matches) {
          const exists = await TopupRequest.findOne({ txid: match.txID });
          if (!exists) {
            finalTxid = match.txID; // Это настоящий скрытый TXID из API
            bResult.amount = match.amount;
            foundUnclaimed = true;
            break;
          }
        }
        if (!foundUnclaimed) {
          bResult.success = false;
          bResult.reason = lang === 'en' ? 'All transfers from this UID have already been credited. No new transfers found.' : 'Все переводы с этого UID уже были зачислены ранее. Новых переводов не найдено.';
        }
      }
    }

    if (bResult.success) {
      txVerifiedOnChain = true;
      txFromAddress = bResult.fromAddress || null;

      // Защита от присвоения чужих переводов: старые транзакции (взятые из
      // истории кошелька магазина) автоматически не зачисляем - только через
      // оператора. Легитимный пользователь вводит TXID в течение минут.
      const MAX_TX_AGE_MS = 6 * 60 * 60 * 1000; // 6 часов
      const txTooOld = network !== 'uid' && bResult.timestamp && (Date.now() - bResult.timestamp > MAX_TX_AGE_MS);

      if (txTooOld) {
        statusReason = lang === 'en'
          ? '⚠️ The transaction is older than 6 hours - sent for manual review by an operator.'
          : '⚠️ Транзакция старше 6 часов - заявка отправлена на ручную проверку оператору.';
      } else if (bResult.amount >= amountUSDT * 0.99 && bResult.amount <= amountUSDT * 1.05) {
        // Сумма может незначительно отличаться из-за комиссий: принимаем коридор
        // от 99% до 105% заявленной. Больше - подозрение на чужую транзакцию,
        // отправляем оператору (раньше зачислялась ЛЮБАЯ сумма из блокчейна без
        // верхней границы - вектор кражи).
        requestStatus = 'confirmed';
        finalAmountUSDT = bResult.amount; // Засчитываем реальную сумму
      } else if (bResult.amount > amountUSDT * 1.05) {
        statusReason = lang === 'en'
          ? `⚠️ Amount in blockchain (${bResult.amount} USDT) is much larger than declared (${amountUSDT} USDT) - sent for manual review.`
          : `⚠️ Сумма в блокчейне (${bResult.amount} USDT) значительно больше заявленной (${amountUSDT} USDT) - заявка отправлена на ручную проверку.`;
      } else {
        statusReason = lang === 'en' ? `⚠️ Amount in blockchain (${bResult.amount} USDT) is less than declared (${amountUSDT} USDT).` : `⚠️ Сумма в блокчейне (${bResult.amount} USDT) меньше заявленной (${amountUSDT} USDT).`;
      }
    } else if (bResult.blocked) {
      // Bybit/RPC заблокировал запрос (CloudFront 403, rate-limit, сеть). API сейчас
      // недоступен - отправляем заявку на ручную проверку оператором.
      statusReason = `⚠️ ${bResult.reason || (lang === 'en' ? 'Auto-check temporarily unavailable.' : 'Авто-проверка временно недоступна.')}`;
      requestStatus = 'pending';
    } else if (network !== 'uid') {
      // Транзакция не найдена / ещё не подтверждена / не на наш адрес.
      // НЕ создаём заявку и НЕ убиваем сессию: пользователь просто отправляет
      // TXID ещё раз (частый случай - индексация/подтверждения сети догоняют
      // за 1-2 минуты). Раньше здесь создавалась pending-заявка, сессия
      // сбрасывалась, а повторную попытку блокировал дедуп по сумме.
      if (progress) await progress.stop(lang === 'en' ? '⏳ Generating response...' : '⏳ Формирую ответ...').catch(() => {});
      topup.step = 'proof'; // остаёмся в режиме ввода TXID
      const retryTxt = lang === 'en'
        ? `❌ <b>Could not verify the transaction</b>\n\n${bResult.reason}\n\nCheck the TXID and send it again. If the issue persists, contact support.`
        : `❌ <b>Не удалось подтвердить транзакцию</b>\n\n${bResult.reason}\n\nПроверьте TXID и отправьте его ещё раз. Если проблема повторяется — напишите в поддержку.`;
      const retryOpts = {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '🆘 Support' : '🆘 Поддержка', 'menu:support')],
          [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:topup')],
        ]),
      };
      const targetMsgId = checkingMsgId || topup.msgId;
      if (targetMsgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, retryTxt, retryOpts).catch(() => ctx.reply(retryTxt, retryOpts));
        topup.msgId = targetMsgId;
      } else {
        const m = await ctx.reply(retryTxt, retryOpts);
        topup.msgId = m.message_id;
      }
      return true;
    } else {
      statusReason = lang === 'en' ? `⚠️ Auto-check error: ${bResult.reason}.` : `⚠️ Ошибка авто-проверки: ${bResult.reason}.`;
    }

    // UX-16: останавливаем прогресс-анимацию - дальше финальный editMessageText сам перепишет msg.
    if (progress) progress.stop(lang === 'en' ? '⏳ Generating response...' : '⏳ Формирую ответ...').catch(() => {});
  }

  // Дедупликация: после автопроверки (или если её не было) сверяем по финальной
  // сумме. Раньше было до API, что давало погрешность при коррекции суммы.
  // Сравниваем pending-заявки (та же сумма ±1%) - защищает от двойной отправки чека.
  {
    const dupAmount = finalAmountUSDT;
    const duplicateRequest = await TopupRequest.findOne({
      userId: user._id,
      status: 'pending',
      method: method,
      amount: { $gte: dupAmount * 0.99, $lte: dupAmount * 1.01 },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    if (duplicateRequest) {
      const errTxt = lang === 'en' ? '❌ You already have a top-up request with the same amount. Wait for operator confirmation.' : '❌ У вас уже есть заявка на пополнение с такой же суммой. Дождитесь подтверждения оператором.';
      const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню', 'menu:main')]]) };
      if (checkingMsgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, checkingMsgId, null, errTxt, errOpts).catch(() => ctx.reply(errTxt, errOpts));
      } else if (topup.msgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(() => ctx.reply(errTxt, errOpts));
      } else {
        await ctx.reply(errTxt, errOpts);
      }
      return true;
    }
  }

  ctx.session.topup = null;

  const requestData = {
    userId: user._id,
    amount: finalAmountUSDT,
    method,
    network,
    proofText,
    proofFileId,
    fromAddress: txFromAddress,
    // Всегда создаём как pending; в confirmed заявка переводится атомарно
    // ВМЕСТЕ с зачислением ниже. Раньше заявка сразу писалась confirmed до
    // зачисления - при сбое оставалась "подтверждённой" без денег на балансе.
    status: 'pending'
  };
  // txid пишем только если транзакция реально найдена в блокчейне (или получена
  // из Bybit API для UID). Раньше сюда попадал сырой ввод пользователя даже при
  // неудачной проверке - txid "сгорал" в unique-индексе, а для UID-топапов в
  // поле txid записывался сам UID, навсегда блокируя пользователя.
  const txidIsReal = isAutoCrypto && !proofFileId && (
    network === 'uid' ? (finalTxid && finalTxid !== proofText) : txVerifiedOnChain
  );
  if (txidIsReal) {
    requestData.txid = finalTxid;
  }
  const request = new TopupRequest(requestData);
  await request.save();

  let replyText = '';
  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Main menu' : '⬅️ В главное меню', 'menu:main')]])
  };

  if (requestStatus === 'confirmed') {
    // Начисляем баланс атомарно
    const { withTransaction } = require('../../services/transactionHelper.service');
    const logger = require('../../config/logger');
    let uidBindingFailed = false;
    let topupUsedSession = null;  // была ли реальная MongoDB-транзакция
    let creditApplied = false;    // прошёл ли $inc баланса (для корректного catch)
    try {
      await withTransaction(async (session) => {
        const sessionOpt = session ? { session } : {};
        topupUsedSession = session;
        creditApplied = false;

        // Идемпотентный "захват" заявки: pending → confirmed. Если параллельный
        // вызов уже обработал её - выходим без второго зачисления.
        const claimed = await TopupRequest.findOneAndUpdate(
          { _id: request._id, status: 'pending' },
          { $set: { status: 'confirmed', processedAt: new Date() } },
          { new: true, ...sessionOpt }
        );
        if (!claimed) throw new Error('TOPUP_ALREADY_PROCESSED');

        // Атомарный $inc вместо "прочитал → изменил → save()": исключает гонку
        // и потерю параллельных изменений баланса.
        const userUpdate = { $inc: { balance: finalAmountUSDT } };
        // First-claim wins: привязываем UID к юзеру при первом успешном топапе.
        // Если параллельно другой аккаунт успел занять этот UID - unique-index
        // выбросит DuplicateKey, мы это ловим и откатываем.
        if (network === 'uid' && !user.bybitUid && proofText) {
          userUpdate.$set = { bybitUid: proofText.trim() };
        }
        const updRes = await User.updateOne({ _id: user._id }, userUpdate, sessionOpt);
        if (!updRes.matchedCount) throw new Error('User not found');
        creditApplied = true;

        const Transaction = require('../../models/Transaction');
        await new Transaction({
          userId: user._id,
          type: 'topup',
          amount: finalAmountUSDT,
          topupRequestId: request._id,
          description: lang === 'en' ? `Auto-topup ${network.toUpperCase()}` : `Авто-пополнение ${network.toUpperCase()}`
        }).save(sessionOpt);
      });
      // Обновляем баланс в контексте для отображения
      if (ctx.user) {
        ctx.user.balance = parseFloat((ctx.user.balance + finalAmountUSDT).toFixed(8));
        if (network === 'uid' && !ctx.user.bybitUid && proofText) ctx.user.bybitUid = proofText.trim();
      }
      // Синхронизируем in-memory статус с БД (нужно для корректного уведомления админа)
      request.status = 'confirmed';
      request.processedAt = new Date();
    } catch (err) {
      // Конфликт на sparse unique index bybitUid_string_unique - кто-то
      // успел привязать UID первым между pre-check и commit. Разворачиваем
      // заявку в pending, чтобы админ разобрался вручную.
      if (err && err.code === 11000 && String(err.message || '').includes('bybitUid')) {
        uidBindingFailed = true;
        await TopupRequest.updateOne(
          { _id: request._id },
          { $set: { status: 'pending' }, $unset: { txid: 1 } }
        ).catch(() => {});
      } else if (err && err.message === 'TOPUP_ALREADY_PROCESSED') {
        // Заявку уже обработал параллельный процесс (или админ успел
        // подтвердить вручную). НИЧЕГО не трогаем в БД - иначе можно было бы
        // сбросить уже оплаченную заявку обратно в pending и зачислить дважды.
        logger.warn(`[Topup] Заявка ${request._id} уже обработана параллельно - пропускаю зачисление.`);
        requestStatus = 'pending';
      } else if (!topupUsedSession && creditApplied) {
        // Режим без транзакций: деньги УЖЕ начислены, упал только последний шаг
        // (запись Transaction-проводки). Заявку оставляем confirmed - возвращать
        // её в pending нельзя (оператор зачислил бы второй раз).
        logger.error(`[Topup] Проводка не записана для заявки ${request._id} (баланс зачислен): ${err.message}`);
        if (ctx.user) {
          ctx.user.balance = parseFloat((ctx.user.balance + finalAmountUSDT).toFixed(8));
        }
        request.status = 'confirmed';
        request.processedAt = new Date();
        // requestStatus остаётся 'confirmed' → пользователь увидит "Успешно"
      } else {
        // Деньги НЕ начислены (либо транзакция всё откатила) - возвращаем заявку
        // в pending, оператор зачислит вручную. Обработчик не роняем.
        logger.error(`[Topup] Ошибка авто-зачисления заявки ${request._id}: ${err.message}`);
        await TopupRequest.updateOne(
          { _id: request._id, status: 'confirmed' },
          { $set: { status: 'pending', processedAt: null } }
        ).catch(() => {});
        requestStatus = 'pending';
        statusReason = lang === 'en'
          ? '⚠️ Auto-crediting failed - the request was sent for manual review.'
          : '⚠️ Авто-зачисление не удалось - заявка отправлена на ручную проверку.';
      }
    }

    if (uidBindingFailed) {
      replyText = lang === 'en'
        ? `⚠️ <b>Switching to manual verification</b>\n\nThere was an issue linking the UID. An operator will contact you shortly.`
        : `⚠️ <b>Переводим заявку на ручную проверку</b>\n\nВозникла проблема с привязкой UID. Оператор свяжется с вами в ближайшее время.`;
      await notif.notifyAdminTopupRequest(request, user, method, network, { amountUSDT, amountRUB, rate });
    } else if (requestStatus === 'confirmed') {
      replyText = lang === 'en'
        ? `✅ <b>Success!</b>\n\nTransaction found. Your balance has been topped up by <b>${finalAmountUSDT.toFixed(2)} USDT</b>.`
        : `✅ <b>Успешно!</b>\n\nТранзакция найдена. Ваш баланс пополнен на <b>${finalAmountUSDT.toFixed(2)} USDT</b>.`;
      // Тихое уведомление админу
      await notif.notifyAdminTopupRequest(request, user, method, network, { amountUSDT: finalAmountUSDT, amountRUB, rate });
    }
    // Если авто-зачисление сорвалось (catch выше перевёл requestStatus в
    // 'pending'), replyText остался пустым - уйдём в общую ветку "Заявка принята".
  }
  if (!replyText) {
    // Честный SLA зависит от способа оплаты (карта медленнее, крипта быстрее).
    const slaText = method === 'card' ? SLA.CARD_MANUAL_REVIEW : SLA.CRYPTO_MANUAL;
    replyText = lang === 'en'
      ? `✅ <b>Request accepted!</b>\n\n` +
        (statusReason ? `${statusReason}\n\n` : '') +
        `💵 Amount: <b>${amountUSDT.toFixed(2)} USDT</b> (~${amountRUB.toFixed(0)} ₽)\n` +
        `⏳ Average processing time: <b>${slaText}</b>.`
      : `✅ <b>Заявка принята!</b>\n\n` +
        (statusReason ? `${statusReason}\n\n` : '') +
        `💵 Сумма: <b>${amountUSDT.toFixed(2)} USDT</b> (~${amountRUB.toFixed(0)} ₽)\n` +
        `⏳ Среднее время обработки: <b>${slaText}</b>.`;

    await notif.notifyAdminTopupRequest(request, user, method, network, { amountUSDT, amountRUB, rate });
  }

  if (checkingMsgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, checkingMsgId, null, replyText, opts).catch(() => ctx.reply(replyText, opts));
  } else {
    await ctx.reply(replyText, opts);
  }

  return true;
};

// ─── Подтверждение и зачисление платежа Platega (СБП) ─────────────────────────
const confirmPlategaPayment = async (requestOrId, plategaData = {}) => {
  const requestId = requestOrId?._id || requestOrId;
  const logger = require('../../config/logger');

  // Атомарно переводим заявку из pending в confirmed
  const request = await TopupRequest.findOneAndUpdate(
    { _id: requestId, status: 'pending' },
    { $set: { status: 'confirmed', processedAt: new Date() } },
    { new: true }
  ).populate('userId');

  if (!request) {
    logger.warn(`[Platega] Заявка ${requestId} уже была подтверждена или не найдена`);
    return false;
  }

  const user = request.userId;
  if (!user) {
    logger.error(`[Platega] Пользователь для заявки ${requestId} не найден`);
    return false;
  }

  // Начисляем баланс пользователю атомарно
  await User.updateOne(
    { _id: user._id },
    { $inc: { balance: request.amount } }
  );

  // Создаём запись в истории транзакций
  const Transaction = require('../../models/Transaction');
  await new Transaction({
    userId: user._id,
    type: 'topup',
    amount: request.amount,
    topupRequestId: request._id,
    description: 'Пополнение через СБП (Platega)',
  }).save().catch((err) => {
    logger.error(`[Platega] Ошибка создания транзакции: ${err.message}`);
  });

  const rubStr = request.amountRub ? ` (~${request.amountRub} ₽)` : '';
  const newBalance = ((user.balance || 0) + request.amount).toFixed(2);

  // Уведомляем пользователя
  const userMsg =
    `✅ <b>Оплата получена! Баланс пополнен</b>\n\n` +
    `💰 Зачислено: <b>${request.amount.toFixed(2)} USDT</b>${rubStr}\n` +
    `⚡ Способ: <b>СБП (Система быстрых платежей)</b>\n` +
    `💳 Текущий баланс: <b>${newBalance} USDT</b>\n\n` +
    `<i>Приятных покупок!</i>`;

  const userKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛍 В магазин', 'menu:shop')],
    [Markup.button.callback('👤 Профиль', 'menu:profile')],
  ]);

  await notif.sendToUser(user.telegramId, userMsg, {
    parse_mode: 'HTML',
    ...userKeyboard,
  }).catch(() => {});

  // Уведомляем админов
  const adminMsg =
    `⚡ <b>Авто-пополнение через СБП (Platega)</b>\n\n` +
    `👤 Пользователь: @${escapeHtml(user.username || user.telegramId)} (ID: <code>${user.telegramId}</code>)\n` +
    `💰 Сумма: <b>${request.amount.toFixed(2)} USDT</b>${rubStr}\n` +
    `🆔 ID платежа: <code>${request.paymentId || plategaData.id || '-'}</code>\n` +
    `📅 ${new Date().toLocaleString('ru-RU')}`;

  await notif.sendToAdmins(adminMsg, { parse_mode: 'HTML' }).catch(() => {});

  return true;
};

// ─── Ручная проверка статуса по кнопке пользователя ──────────────────────────
const handleCheckPlategaPayment = async (ctx, requestId) => {
  const lang = ctx.user?.language || 'ru';
  const request = await TopupRequest.findById(requestId).populate('userId');
  if (!request) {
    return ctx.answerCbQuery(lang === 'en' ? 'Request not found' : 'Заявка не найдена', { show_alert: true });
  }

  if (request.status === 'confirmed') {
    await ctx.answerCbQuery(lang === 'en' ? '✅ Payment already confirmed!' : '✅ Оплата уже подтверждена!');
    const successText = lang === 'en'
      ? `✅ <b>Payment successfully confirmed!</b>\n\nCredited: <b>${request.amount.toFixed(2)} USDT</b> (~${request.amountRub} ₽)\nBalance updated!`
      : `✅ <b>Оплата успешно подтверждена!</b>\n\nЗачислено: <b>${request.amount.toFixed(2)} USDT</b> (~${request.amountRub} ₽)\nБаланс пополнен!`;
    const buttons = [
      [Markup.button.callback(lang === 'en' ? '🛍 Shop' : '🛍 В магазин', 'menu:shop')],
      [Markup.button.callback(lang === 'en' ? '👤 Profile' : '👤 Профиль', 'menu:profile')],
    ];
    return editOrReply(ctx, successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  if (!request.paymentId) {
    return ctx.answerCbQuery(lang === 'en' ? 'Transaction ID missing' : 'ID платежа не найден', { show_alert: true });
  }

  const plategaService = require('../../services/platega.service');
  const statusRes = await plategaService.checkStatus(request.paymentId);

  if (statusRes.isConfirmed) {
    await ctx.answerCbQuery(lang === 'en' ? '✅ Payment confirmed!' : '✅ Оплата подтверждена!');
    const ok = await confirmPlategaPayment(request, statusRes.data);
    if (ok) {
      const successText = lang === 'en'
        ? `✅ <b>Payment successfully confirmed!</b>\n\nCredited: <b>${request.amount.toFixed(2)} USDT</b> (~${request.amountRub} ₽)\nBalance updated!`
        : `✅ <b>Оплата успешно подтверждена!</b>\n\nЗачислено: <b>${request.amount.toFixed(2)} USDT</b> (~${request.amountRub} ₽)\nБаланс пополнен!`;
      const buttons = [
        [Markup.button.callback(lang === 'en' ? '🛍 Shop' : '🛍 В магазин', 'menu:shop')],
        [Markup.button.callback(lang === 'en' ? '👤 Profile' : '👤 Профиль', 'menu:profile')],
      ];
      return editOrReply(ctx, successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
  } else if (statusRes.isPending) {
    return ctx.answerCbQuery(
      lang === 'en'
        ? '⏳ Payment is still being processed by the bank.\n\nIf you already approved the transfer in your bank app, please wait 15–30 seconds and check again (or wait for the automatic credit notification).'
        : '⏳ Платёж ещё обрабатывается банком.\n\nЕсли вы уже подтвердили перевод в приложении банка, подождите 15–30 секунд и нажмите кнопку снова (или дождитесь автоматического зачисления).',
      { show_alert: true }
    );
  } else if (statusRes.isCanceled) {
    await ctx.answerCbQuery();
    await TopupRequest.updateOne({ _id: request._id }, { $set: { status: 'rejected', notes: 'Отменено Platega' } });
    const cancelText = lang === 'en'
      ? '❌ <b>Payment expired or canceled.</b>\n\nYou can create a new top-up request.'
      : '❌ <b>Время ожидания оплаты истекло или платёж был отменён.</b>\n\nВы можете создать новую заявку на пополнение.';
    return editOrReply(ctx, cancelText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Top Up again' : '⬅️ Пополнить снова', 'menu:topup')]]),
    });
  } else {
    return ctx.answerCbQuery(
      lang === 'en' ? '⚠️ Could not get status from payment gateway. Please try again in a moment.' : '⚠️ Не удалось связаться с платёжным шлюзом. Попробуйте ещё раз через минуту.',
      { show_alert: true }
    );
  }
};

// ─── Отмена заявки Platega пользователем ──────────────────────────────────────
const handleCancelPlategaPayment = async (ctx, requestId) => {
  const lang = ctx.user?.language || 'ru';
  await TopupRequest.updateOne(
    { _id: requestId, status: 'pending' },
    { $set: { status: 'rejected', notes: 'Отменено пользователем' } }
  ).catch(() => {});

  await ctx.answerCbQuery(lang === 'en' ? 'Payment canceled' : 'Оплата отменена');
  return startTopup(ctx);
};

// ─── Обработка входящего Webhook от Platega ───────────────────────────────────
const handlePlategaWebhook = async (payload = {}) => {
  const logger = require('../../config/logger');
  const transactionId = payload.id;
  const requestId = payload.payload;
  const status = (payload.status || '').toUpperCase();

  if (status !== 'CONFIRMED') {
    logger.info(`[Platega Webhook] Статус ${status} для транзакции ${transactionId}, пропускаем`);
    return { status: 'ignored' };
  }

  let query = null;
  if (requestId && String(requestId).length === 24) {
    query = { _id: requestId };
  } else if (transactionId) {
    query = { paymentId: transactionId };
  }

  if (!query) {
    logger.warn(`[Platega Webhook] Нет transactionId или requestId в payload: ${JSON.stringify(payload)}`);
    return { status: 'missing_identifiers' };
  }

  const request = await TopupRequest.findOne(query);
  if (!request) {
    logger.warn(`[Platega Webhook] Заявка не найдена: ${JSON.stringify(query)}`);
    return { status: 'not_found' };
  }

  if (request.status === 'confirmed') {
    logger.info(`[Platega Webhook] Заявка ${request._id} уже подтверждена`);
    return { status: 'already_confirmed' };
  }

  const confirmed = await confirmPlategaPayment(request, payload);
  return { status: confirmed ? 'confirmed' : 'failed' };
};

module.exports = {
  startTopup,
  startTopupWithAmount,
  showDirectOptions,
  showPaymentMethods,
  showCustomAmountPrompt,
  showPlategaDetails,
  showBybitOptions,
  showBybitNetwork,
  showCardDetails,
  handleAmountInput,
  handleTopupProof,
  handleEnterTxid,
  handlePresetAmount,
  handleCheckPlategaPayment,
  handleCancelPlategaPayment,
  confirmPlategaPayment,
  handlePlategaWebhook,
};

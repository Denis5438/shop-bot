const { Markup } = require('telegraf');
const TopupRequest = require('../../models/TopupRequest');
const User = require('../../models/User');
const { toRub, getRate } = require('../../services/currency.service');
const notif = require('../../services/notification.service');
const { parseAmount, copyHint, escapeHtml } = require('../utils/ui');
const { SLA } = require('../constants/ux');
const { startProgress } = require('../utils/progress');

// ─── Вспомогательная функция ──────────────────────────────────────────────────
const editOrReply = async (ctx, text, extra) => {
  try {
    if (ctx.callbackQuery) {
      return await ctx.editMessageText(text, extra);
    }
  } catch (_) { }
  return await ctx.reply(text, extra);
};

// Форматируем сумму: USDT + рубли рядом
const fmtUSDT = (usdt) => `${usdt.toFixed(2)} USDT (~${toRub(usdt)} ₽)`;
const fmtRUB = (rub) => {
  const rate = getRate();
  const usdt = rub / rate;
  return `${rub.toFixed(0)} ₽ (~${usdt.toFixed(2)} USDT)`;
};

// ─── Шаг 1: Выбор способа оплаты ─────────────────────────────────────────────
const startTopup = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = null;
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  const title = lang === 'en' ? 'Balance Top Up' : 'Пополнение баланса';
  const choose = lang === 'en' ? 'Choose a convenient method:' : 'Выберите удобный способ:';
  const directLabel = lang === 'en' ? '💳 Direct Transfer' : '💳 Прямой перевод';
  const autoLabel = lang === 'en' ? '🤖 Auto-payment · soon' : '🤖 Авто-оплата · скоро';
  const backLabel = t('btn_back');

  await editOrReply(ctx,
    `💳 <b>${title}</b>\n\n${choose}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(directLabel, 'topup:method:direct')],
        [Markup.button.callback(autoLabel, 'topup:auto_stub')],
        [Markup.button.callback(backLabel, 'menu:main')],
      ]),
    }
  );
};

// Быстрое пополнение на конкретную сумму (из карточки товара)
const startTopupWithAmount = async (ctx, amount) => {
  ctx.session = ctx.session || {};
  ctx.session.topup = { quickAmount: amount };
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  const title = lang === 'en' ? 'Quick Top Up' : 'Быстрое пополнение';
  const amountLbl = lang === 'en' ? 'Amount' : 'Сумма';
  const chooseLbl = lang === 'en' ? 'Choose a method:' : 'Выберите способ:';
  const directLabel = lang === 'en' ? '💳 Direct Transfer' : '💳 Прямой перевод';
  const autoLabel = lang === 'en' ? '🤖 Auto-payment · soon' : '🤖 Авто-оплата · скоро';
  const backLabel = t('btn_back');

  await editOrReply(ctx,
    `💳 <b>${title}</b>\n\n` +
    `${amountLbl}: <b>${amount} USDT</b>\n\n${chooseLbl}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(directLabel, 'topup:method:direct')],
        [Markup.button.callback(autoLabel, 'topup:auto_stub')],
        [Markup.button.callback(backLabel, 'menu:main')],
      ]),
    }
  );
};

// ─── Шаг 2: Выбор платёжной системы ─────────────────────────────────────────
const showDirectOptions = async (ctx) => {
  const lang = ctx.user?.language || 'ru';
  const t = ctx.t || ((k) => k);
  const title = lang === 'en' ? 'Direct Transfer' : 'Прямой перевод';
  const chooseLbl = lang === 'en' ? 'Choose a method:' : 'Выберите способ:';
  const cardLabel = lang === 'en' ? '🏦 Bank card (T-Bank / Sber)' : '🏦 На карту (Т-Банк / Сбербанк)';
  const bybitLabel = lang === 'en' ? '📊 Via Bybit (USDT)' : '📊 Через Bybit (USDT)';
  const backLabel = t('btn_back');

  await ctx.editMessageText(
    `💳 <b>${title}</b>\n\n${chooseLbl}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(cardLabel, 'topup:pay:card')],
        [Markup.button.callback(bybitLabel, 'topup:pay:bybit')],
        [Markup.button.callback(backLabel, 'menu:topup')],
      ]),
    }
  );
};

// ─── Ввод суммы (только USDT) ───────────────────────────────────────────────────────
const askTopupAmount = async (ctx, method, network = null) => {
  const prevQuickAmount = ctx.session?.topup?.quickAmount || null;
  ctx.session.topup = { method, network, step: 'amount', currency: 'usdt', msgId: null, quickAmount: prevQuickAmount };
  const lang = ctx.user?.language || 'ru';

  if (prevQuickAmount) {
    return await handleAmountInput(ctx, String(prevQuickAmount));
  }

  const rate = getRate();
  const currencyLine = lang === 'en' ? `💱 Rate: <b>1 USDT = ${rate.toFixed(2)} ₽</b>` : `💱 Курс: <b>1 USDT = ${rate.toFixed(2)} ₽</b>`;
  const hint = lang === 'en' ? `Example: <code>5</code> — is ~${(5 * rate).toFixed(0)} ₽` : `Например: <code>5</code> — это ~${(5 * rate).toFixed(0)} ₽`;

  const presets = [5, 10, 20, 50, 100];
  const presetLabel = 'USDT';

  const presetRow1 = presets.slice(0, 3).map((v) =>
    Markup.button.callback(`${v} ${presetLabel}`, `topup:preset:usdt:${v}`)
  );
  const presetRow2 = presets.slice(3).map((v) =>
    Markup.button.callback(`${v} ${presetLabel}`, `topup:preset:usdt:${v}`)
  );

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
      [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', method === 'card' ? 'topup:method:direct' : 'topup:pay:bybit')],
    ]),
  };

  const sent = await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  if (sent) {
    ctx.session.topup.msgId = sent.message_id;
  }
};

// ─── Шаг 3а: Карта ───────────────────────────────────────────────────────────
const showCardDetails = async (ctx) => {
  await askTopupAmount(ctx, 'card', null);
};

// ─── Шаг 3б: Bybit — выбор сети ──────────────────────────────────────────────
const showBybitOptions = async (ctx) => {
  ctx.session = ctx.session || {};
  const prevQuickAmount = ctx.session?.topup?.quickAmount || null;
  ctx.session.topup = { method: 'bybit', network: null, step: null, msgId: null, quickAmount: prevQuickAmount };
  const lang = ctx.user?.language || 'ru';
  const t = ctx.t || ((k) => k);
  const title = lang === 'en' ? 'Top Up via Bybit (USDT)' : 'Пополнение через Bybit (USDT)';
  const chooseLbl = lang === 'en' ? 'Choose a network:' : 'Выберите сеть:';
  const backLabel = t('btn_back');

  await ctx.editMessageText(
    `📊 <b>${title}</b>\n\n${chooseLbl}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔴 TRC-20 (Tron)', 'topup:network:trc20')],
        [Markup.button.callback('🟡 BEP-20 (BSC)', 'topup:network:bep20')],
        [Markup.button.callback(backLabel, 'topup:method:direct')],
      ]),
    }
  );
};

const BYBIT_NETWORKS = {
  trc20: { icon: '🔴', label: 'TRC-20 (Tron)' },
  bep20: { icon: '🟡', label: 'BEP-20 (BSC)' },
};

// Получаем адреса из Settings (БД через кеш). Реквизиты должны быть заданы админом.
const getBybitAddresses = async () => {
  const { getSettings } = require('../../services/settingsCache.service');
  const settings = await getSettings();
  return {
    trc20: { ...BYBIT_NETWORKS.trc20, address: settings?.bybitTrc20Address || '' },
    bep20: { ...BYBIT_NETWORKS.bep20, address: settings?.bybitBep20Address || '' },
  };
};

const showBybitNetwork = async (ctx, network) => {
  await askTopupAmount(ctx, 'bybit', network);
};

// UX-1: Обработчик кнопки-пресета. Подставляем сумму как будто её ввели вручную
// и прогоняем через тот же flow — это даёт -1 клик в типичном сценарии.
const handlePresetAmount = async (ctx, currency, amountStr) => {
  const topup = ctx.session?.topup;
  const lang = ctx.user?.language || 'ru';
  if (!topup || topup.step !== 'amount') {
    return ctx.answerCbQuery(lang === 'en' ? '⚠️ Step expired, start again' : '⚠️ Шаг устарел, начните заново', { show_alert: true }).catch(() => null);
  }

  // Синхронизируем валюту (на случай если юзер нажал пресет в «чужой» валюте).
  topup.currency = currency;

  await ctx.answerCbQuery(lang === 'en' ? `💵 Amount: ${amountStr} ${currency === 'usdt' ? 'USDT' : '₽'}` : `💵 Сумма: ${amountStr} ${currency === 'usdt' ? 'USDT' : '₽'}`).catch(() => null);

  return handleAmountInput(ctx, String(amountStr));
};

// ─── Сумма введена → показываем реквизиты ────────────────────────────────────
const handleAmountInput = async (ctx, rawAmount = null) => {
  const topup = ctx.session?.topup;
  if (!topup || topup.step !== 'amount') return false;
  const lang = ctx.user?.language || 'ru';

  // Human-friendly парсинг: понимает "5.5", "5,5", "1 000", "5 USDT", "500 руб"
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

  // Удаляем сообщение пользователя (если это реальное сообщение, а не quickAmount)
  if (ctx.message?.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => { });
  }

  const rate = getRate();
  const { method, network, currency } = topup;

  // Рассчитываем обе стороны
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

  // Минимум minTopup USDT
  if (amountUSDT < minTopup) {
    const minRub = Math.ceil(minTopup * getRate());
    const errMsg = currency === 'usdt'
      ? (lang === 'en' ? `❌ <b>Minimum top-up amount — ${minTopup} USDT</b>\n\nEnter the amount again:` : `❌ <b>Минимальная сумма пополнения — ${minTopup} USDT</b>\n\nВведите сумму ещё раз:`)
      : (lang === 'en' ? `❌ <b>Minimum top-up amount — ${minRub} ₽</b> (~${minTopup} USDT)\n\nEnter the amount again:` : `❌ <b>Минимальная сумма пополнения — ${minRub} ₽</b> (~${minTopup} USDT)\n\nВведите сумму ещё раз:`);
    await ctx.reply(errMsg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:topup')]]),
    });
    return true;
  }

  topup.amountUSDT = amountUSDT;
  topup.amountRUB = amountRUB;
  const isAutoCrypto = method === 'bybit'; // И UID, и блокчейны теперь авто!

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
      await ctx.reply(lang === 'en' ? '❌ Card details are not configured. Contact support or choose another payment method.' : '❌ Реквизиты карты не настроены. Обратитесь в поддержку или выберите другой способ пополнения.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback(lang === 'en' ? '⬅️ Payment methods' : '⬅️ К способам оплаты', 'topup:method:direct')],
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
    topupAddr = network === 'trc20' && settings?.topupWallet ? settings.topupWallet : net.address;
    topupAddr = String(topupAddr || '').trim();
    if (!net || !topupAddr) {
      await ctx.reply(lang === 'en' ? '❌ Details for the selected network are not configured. Contact support or choose another payment method.' : '❌ Реквизиты для выбранной сети не настроены. Обратитесь в поддержку или выберите другой способ пополнения.', {
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

  // Если это авто-крипта, ждем нажатия кнопки 'Я отправил', иначе 'proof' (скриншот)
  topup.step = isAutoCrypto ? 'waiting_txid_btn' : 'proof';

  let text = '';

  if (isAutoCrypto) {
    const isBsc = network === 'bep20';
    const label = isBsc ? 'BSC (BEP20)' : 'Tron (TRC20)';
    const coin = 'USDT';
    const icon = isBsc ? '🟡' : '🔴';

    text = lang === 'en'
      ? `🌐 <b>Top Up USDT (${network.toUpperCase()})</b>\n\n` +
        `🪙 Coin: ${coin}\n` +
        `🔗 Network: ${label}\n` +
        `📉 Minimum: ${minTopup.toFixed(3)} ${coin}\n\n` +
        `① Send <b>${amountUSDT.toFixed(2)} USDT</b> to this address:\n` +
        `<code>${escapeHtml(topupAddr)}</code>` + copyHint(lang) + `\n\n` +
        `② After sending, click the button below and paste the TXID.\n\n` +
        `⚠️ DO NOT use other networks — funds will be lost.\n` +
        `⚠️ Make sure it is ${label} and ${coin}.`
      : `🌐 <b>Пополнение USDT (${network.toUpperCase()})</b>\n\n` +
        `🪙 Монета: ${coin}\n` +
        `🔗 Блокчейн: ${label}\n` +
        `📉 Минимум: ${minTopup.toFixed(3)} ${coin}\n\n` +
        `① Отправьте <b>${amountUSDT.toFixed(2)} USDT</b> на этот адрес:\n` +
        `<code>${escapeHtml(topupAddr)}</code>` + copyHint(lang) + `\n\n` +
        `② После отправки нажмите кнопку ниже и вставьте TXID.\n\n` +
        `⚠️ НЕ используйте другие сети — средства будут потеряны.\n` +
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
    buttons.push([Markup.button.callback(network === 'uid' ? (lang === 'en' ? '🔎 I sent it — enter UID' : '🔎 Я перевёл — отправить UID') : (lang === 'en' ? '🔎 I sent it — enter TXID' : '🔎 Я отправил — ввести TXID'), 'topup:enter_txid')]);
    buttons.push([Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]);
  } else {
    buttons.push([Markup.button.callback(lang === 'en' ? '✅ I paid' : '✅ Я оплатил', 'topup:card_paid')]);
    buttons.push([Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', 'menu:topup')]);
  }

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  };

  if (topup.msgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, text, opts).catch(() => ctx.reply(text, opts));
  } else {
    await ctx.reply(text, opts);
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
    ? (lang === 'en' ? '👇 Please, <b>send your Bybit UID</b> (From which you transferred the funds):' : '👇 Пожалуйста, <b>отправьте ваш Bybit UID</b> (С которого вы перевели средства):')
    : (lang === 'en' ? '👇 Please, <b>send your TXID (Transaction Hash) to this chat</b> in the next message:' : '👇 Пожалуйста, <b>отправьте ваш TXID (Хэш транзакции) в этот чат</b> следующим сообщением:');
    
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

  if (isAutoCrypto && proofText && !proofFileId) {
    // В случае с блокчейном присланный текст — это TXID.
    // В случае с UID присланный текст — это UID отправителя.
    
    if (network !== 'uid') {
      const exists = await TopupRequest.findOne({ txid: proofText });
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
    //   1) Если у этого юзера уже есть привязанный UID и он не совпадает с введённым —
    //      отказ. Смена UID разрешена только через поддержку.
    //   2) Если этот UID уже привязан к ДРУГОМУ юзеру — отказ.
    // First-claim wins: первый, кто успешно пополнится с UID, закрепляет его за собой
    // (привязка произойдёт ниже, после подтверждённой транзакции).
    if (network === 'uid') {
      const uidInput = proofText.trim();

      if (user.bybitUid && user.bybitUid !== uidInput) {
        const mask = `***${String(user.bybitUid).slice(-4)}`;
        const errTxt = lang === 'en'
          ? `❌ <b>UID does not match yours</b>\n\nUID <code>${mask}</code> is already linked to your account.\nIf you changed your Bybit account — contact support.`
          : `❌ <b>UID не совпадает с вашим</b>\n\nК вашему аккаунту уже привязан UID: <code>${mask}</code>.\nЕсли вы сменили Bybit-аккаунт — обратитесь в поддержку.`;
        const errOpts = { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', 'topup:pay:bybit')]]) };
        if (topup.msgId) { await ctx.telegram.editMessageText(ctx.chat.id, topup.msgId, null, errTxt, errOpts).catch(() => ctx.reply(errTxt, errOpts)); } else { await ctx.reply(errTxt, errOpts); }
        return true;
      }

      if (!user.bybitUid) {
        const claimedByOther = await User.findOne({ bybitUid: uidInput, _id: { $ne: user._id } }).select('_id').lean();
        if (claimedByOther) {
          const errTxt = lang === 'en' 
            ? '❌ <b>This UID is already linked to another account.</b>\n\nIf this is an error, please contact support.'
            : '❌ <b>Этот UID уже привязан к другому аккаунту.</b>\n\nЕсли это ошибка — напишите в поддержку.';
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
      intervalMs: 1500,
      editMessageId: topup.msgId || null,
    });
    checkingMsgId = progress?.messageId || topup.msgId || null;

    let bResult = { success: false, reason: 'Неизвестная сеть' };
    if (network === 'trc20') {
      bResult = await blockchain.verifyTrc20Usdt(proofText, topupAddr);
    } else if (network === 'bep20') {
      bResult = await blockchain.verifyBep20Usdt(proofText, topupAddr);
    } else if (network === 'uid') {
      // Для UID proofText — это UID отправителя. 
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
      // Сумма может незначительно отличаться из-за комиссий, если прислали больше - засчитываем больше
      // Если прислали чуть-чуть меньше - на усмотрение. Затребуем хотя бы 99%
      if (bResult.amount >= amountUSDT * 0.99) {
        requestStatus = 'confirmed';
        finalAmountUSDT = bResult.amount; // Засчитываем реальную сумму
      } else {
        statusReason = lang === 'en' ? `⚠️ Amount in blockchain (${bResult.amount} USDT) is less than declared (${amountUSDT} USDT).` : `⚠️ Сумма в блокчейне (${bResult.amount} USDT) меньше заявленной (${amountUSDT} USDT).`;
      }
    } else if (bResult.blocked) {
      // Bybit/RPC заблокировал запрос (CloudFront 403, rate-limit, сеть). API сейчас
      // недоступен — отправляем заявку на ручную проверку оператором.
      statusReason = `⚠️ ${bResult.reason || (lang === 'en' ? 'Auto-check temporarily unavailable.' : 'Авто-проверка временно недоступна.')}`;
      requestStatus = 'pending';
    } else {
      statusReason = lang === 'en' ? `⚠️ Auto-check error: ${bResult.reason}.` : `⚠️ Ошибка авто-проверки: ${bResult.reason}.`;
    }

    // UX-16: останавливаем прогресс-анимацию — дальше финальный editMessageText сам перепишет msg.
    if (progress) progress.stop(lang === 'en' ? '⏳ Generating response...' : '⏳ Формирую ответ...').catch(() => {});
  }

  // Дедупликация: после автопроверки (или если её не было) сверяем по финальной
  // сумме. Раньше было до API, что давало погрешность при коррекции суммы.
  // Сравниваем pending-заявки (та же сумма ±1%) — защищает от двойной отправки чека.
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
    status: requestStatus
  };
  // txid только для авто-крипты — иначе не устанавливаем поле (sparse index)
  if (isAutoCrypto && finalTxid && !proofFileId) {
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
    let uidBindingFailed = false;
    try {
      await withTransaction(async (session) => {
        const freshUser = await User.findById(user._id, null, session ? { session } : undefined);
        if (!freshUser) throw new Error('User not found');
        freshUser.balance = parseFloat((freshUser.balance + finalAmountUSDT).toFixed(8));

        // First-claim wins: привязываем UID к юзеру при первом успешном топапе.
        // Если параллельно другой аккаунт успел занять этот UID — unique-index
        // выбросит DuplicateKey, мы это ловим и откатываем.
        if (network === 'uid' && !freshUser.bybitUid && proofText) {
          freshUser.bybitUid = proofText.trim();
        }

        await freshUser.save(session ? { session } : undefined);
        // Обновляем ctx.user
        ctx.user = freshUser;

        const Transaction = require('../../models/Transaction');
        await new Transaction({
          userId: freshUser._id,
          type: 'topup',
          amount: finalAmountUSDT,
          orderId: request._id,
          description: lang === 'en' ? `Auto-topup ${network.toUpperCase()}` : `Авто-пополнение ${network.toUpperCase()}`
        }).save(session ? { session } : undefined);
      });
    } catch (err) {
      // Конфликт на sparse unique index bybitUid_string_unique — кто-то
      // успел привязать UID первым между pre-check и commit. Разворачиваем
      // транзакцию заявки в pending, чтобы админ разобрался вручную.
      if (err && err.code === 11000 && String(err.message || '').includes('bybitUid')) {
        uidBindingFailed = true;
        await TopupRequest.updateOne(
          { _id: request._id },
          { $set: { status: 'pending', txid: undefined } }
        ).catch(() => {});
      } else {
        throw err;
      }
    }

    if (uidBindingFailed) {
      replyText = lang === 'en'
        ? `⚠️ <b>Switching to manual verification</b>\n\nThere was an issue linking the UID. An operator will contact you shortly.`
        : `⚠️ <b>Переводим заявку на ручную проверку</b>\n\nВозникла проблема с привязкой UID. Оператор свяжется с вами в ближайшее время.`;
      await notif.notifyAdminTopupRequest(request, user, method, network, { amountUSDT, amountRUB, rate });
    } else {
      replyText = lang === 'en'
        ? `✅ <b>Success!</b>\n\nTransaction found. Your balance has been topped up by <b>${finalAmountUSDT.toFixed(2)} USDT</b>.`
        : `✅ <b>Успешно!</b>\n\nТранзакция найдена. Ваш баланс пополнен на <b>${finalAmountUSDT.toFixed(2)} USDT</b>.`;
      // Тихое уведомление админу
      await notif.notifyAdminTopupRequest(request, user, method, network, { amountUSDT: finalAmountUSDT, amountRUB, rate });
    }
  } else {
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

module.exports = {
  startTopup,
  startTopupWithAmount,
  showDirectOptions,
  showBybitOptions,
  showBybitNetwork,
  showCardDetails,
  handleAmountInput,
  handleTopupProof,
  handleEnterTxid,
  handlePresetAmount,
};

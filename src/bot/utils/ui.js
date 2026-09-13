const { Markup } = require('telegraf');
const { EMOJI, TEXTS, SLA } = require('../constants/ux');
const { toRub } = require('../../services/currency.service');

/**
 * Единый формат суммы: «X.XX USDT (~Y ₽)».
 * Используйте вместо ручной конкатенации toFixed + toRub.
 */
const fmtUSDT = (usdt) => {
  const n = typeof usdt === 'number' ? usdt : (parseFloat(usdt) || 0);
  return `${n.toFixed(2)} USDT (~${toRub(n)} ₽)`;
};

/**
 * Переиспользуемые UI-хелперы для сцен бота.
 * Цель: один источник правды для частых паттернов
 * (error screen, empty state, copy hints, balance header, confirm).
 */

/**
 * Форматирует дату и время по Московскому времени (МСК / Europe/Moscow)
 */
const formatDateTimeMSK = (date) => {
  if (!date) return '';
  const d = new Date(date);
  const dateStr = d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const timeStr = d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  return `${dateStr} в ${timeStr} МСК`;
};

const formatDateMSK = (date) => {
  if (!date) return '';
  return new Date(date).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
};

// ─── safeEdit - всегда корректно рисует сообщение ──────────────────────────
/**
 * Пытается отредактировать сообщение (если пришли из callback),
 * при неудаче - шлёт новое. Всегда вызывает answerCbQuery.
 * Используется вместо голых ctx.editMessageText/ctx.reply.
 */
const safeEdit = async (ctx, text, extra = {}) => {
  const opts = { parse_mode: 'HTML', ...extra };
  let sent = null;
  try {
    if (ctx.callbackQuery) {
      sent = await ctx.editMessageText(text, opts);
    } else {
      sent = await ctx.reply(text, opts);
    }
  } catch (err) {
    const errText = String(err?.description || err?.message || '');
    if (errText.includes('message is not modified')) {
      // Контент не изменился — подтверждаем нажатие и НЕ шлём дублирующее сообщение!
      if (ctx.callbackQuery) {
        ctx.answerCbQuery('🔄 Данные актуальны').catch(() => {});
      }
      return null;
    }
    try { sent = await ctx.reply(text, opts); } catch (_) { /* ignore */ }
  }
  if (ctx.callbackQuery) {
    ctx.answerCbQuery().catch(() => {});
  }
  return sent;
};

// ─── Header с балансом ─────────────────────────────────────────────────────
/**
 * Строка «💳 Ваш баланс: X USDT» - используется в карточке товара,
 * на подтверждении покупки, на экране пополнения и т.д.
 */
const balanceHeader = (user) => {
  if (!user || typeof user.balance !== 'number') return '';
  return `${EMOJI.BALANCE} <b>Баланс:</b> ${user.balance.toFixed(2)} USDT\n\n`;
};

// ─── Copy-hint - подсказка про копирование ─────────────────────────────────
/**
 * Добавляет подсказку «💡 Нажмите на значение - скопируется».
 * Добавлять после блока с <code>...</code>.
 */
const copyHint = () => `\n${TEXTS.COPY_HINT}`;

// ─── Error screen с 3 действиями ───────────────────────────────────────────
/**
 * Показывает экран ошибки с кнопками:
 *   [🔄 Попробовать снова]
 *   [🆘 Поддержка] [⬅️ Меню]
 *
 * @param {Object} ctx Telegraf context
 * @param {Object} opts
 *   - title: заголовок (по умолчанию "Ошибка")
 *   - message: текст ошибки
 *   - retryAction: callback_data для "Попробовать снова" (опционально)
 *   - backAction: callback_data для "Назад" (по умолчанию menu:main)
 */
const errorScreen = async (ctx, opts = {}) => {
  const {
    title = `${EMOJI.FAILED} Ошибка`,
    message = 'Что-то пошло не так. Попробуйте позже.',
    retryAction = null,
    backAction = 'menu:main',
  } = opts;

  const text = `<b>${title}</b>\n\n${message}`;

  const buttons = [];
  if (retryAction) {
    buttons.push([Markup.button.callback(TEXTS.RETRY, retryAction)]);
  }
  buttons.push([
    Markup.button.url(TEXTS.CONTACT_SUPPORT, TEXTS.SUPPORT_URL),
  ]);
  buttons.push([Markup.button.callback(TEXTS.BACK_TO_MENU, backAction)]);

  return safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
};

// ─── Confirm screen (для необратимых действий) ─────────────────────────────
/**
 * Показывает экран подтверждения перед деструктивным действием.
 *
 * @param {Object} ctx
 * @param {Object} opts
 *   - title: заголовок ("Вы уверены?")
 *   - message: описание последствий
 *   - yesLabel / yesAction: кнопка подтверждения
 *   - noLabel / noAction: кнопка отмены
 *   - danger: если true - используется красный стиль
 */
const confirmScreen = async (ctx, opts = {}) => {
  const {
    title = `${EMOJI.WARNING} Подтвердите действие`,
    message = 'Это действие нельзя отменить.',
    yesLabel = TEXTS.CONFIRM,
    yesAction,
    noLabel = `${EMOJI.BACK} Передумал`,
    noAction = 'menu:main',
    danger = false,
  } = opts;

  if (!yesAction) {
    throw new Error('confirmScreen: yesAction is required');
  }

  const finalYesLabel = danger && !yesLabel.includes('❗')
    ? `❗ ${yesLabel}`
    : yesLabel;

  const text = `<b>${title}</b>\n\n${message}`;

  return safeEdit(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback(finalYesLabel, yesAction)],
    [Markup.button.callback(noLabel, noAction)],
  ]));
};

// ─── Валидация суммы (human-friendly) ──────────────────────────────────────
/**
 * Разбирает пользовательский ввод суммы.
 * Возвращает { ok: true, value: number } или { ok: false, reason: string }.
 *
 * Примеры корректных входов:
 *   "5", "5.5", "5,5", "1 000", "1_000.50", "5 USDT", "100 руб", "5$"
 */
const parseAmount = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'Введите число больше 0 (например: 5).' };
  }

  // Убираем пробелы, подчёркивания, денежные символы и буквы
  let cleaned = raw
    .trim()
    .replace(/[_\s]/g, '')           // пробелы и _
    .replace(/,/g, '.')              // запятая → точка
    .replace(/[^\d.\-+]/g, '');      // оставляем только цифры и знак

  if (!cleaned) {
    return { ok: false, reason: 'Не понял сумму. Введите цифрами: например <code>5</code> или <code>500</code>.' };
  }

  // Несколько точек - оставляем первую
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }

  const num = parseFloat(cleaned);

  if (isNaN(num)) {
    return { ok: false, reason: 'Не удалось распознать сумму. Введите цифрами, например: <code>5</code>.' };
  }

  if (num < 0) {
    return { ok: false, reason: 'Сумма должна быть положительной.' };
  }

  if (num === 0) {
    return { ok: false, reason: 'Сумма должна быть больше 0.' };
  }

  return { ok: true, value: num };
};

const extractTextWithEmojis = (message) => {
  if (!message || !message.text) return '';
  const text = message.text;
  const entities = message.entities || [];
  
  if (entities.length === 0) return text;

  let result = '';
  let lastIndex = 0;
  
  for (const entity of entities) {
    if (entity.type === 'custom_emoji') {
      result += text.substring(lastIndex, entity.offset);
      const emojiChar = text.substring(entity.offset, entity.offset + entity.length);
      result += `<tg-emoji emoji-id="${entity.custom_emoji_id}">${emojiChar}</tg-emoji>`;
      lastIndex = entity.offset + entity.length;
    }
  }
  result += text.substring(lastIndex);
  
  return result;
};

const escapeHtml = (value) => {
  let escaped = String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  escaped = escaped.replace(/&lt;tg-emoji emoji-id=&quot;(\d+)&quot;&gt;(.*?)&lt;\/tg-emoji&gt;/g, '<tg-emoji emoji-id="$1">$2</tg-emoji>');
  return escaped;
};

/**
 * Красивое форматирование цифрового товара (логин:пароль:2fa, ссылка, ключ)
 * @param {string} rawValue
 * @param {string} lang 'ru' | 'en'
 */
const formatDigitalItem = (rawValue, lang = 'ru') => {
  if (!rawValue) return '';
  const rawStr = String(rawValue).trim();
  if (!rawStr) return '';

  // 1. Попытка распарсить JSON, если пришёл структурированный объект от поставщика
  if ((rawStr.startsWith('{') && rawStr.endsWith('}')) || (rawStr.startsWith('[') && rawStr.endsWith(']'))) {
    try {
      const parsed = JSON.parse(rawStr);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item, idx) => {
            const itemText = typeof item === 'object' ? formatObjectItem(item, lang) : formatSingleItem(String(item), lang);
            return parsed.length > 1 ? `<b>#${idx + 1}</b>\n${itemText}` : itemText;
          })
          .join('\n\n');
      } else if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.content) return formatDigitalItem(parsed.content, lang);
        if (parsed.delivery) return formatDigitalItem(parsed.delivery, lang);
        if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          return parsed.accounts
            .map((acc, idx) => {
              const accText = formatObjectItem(acc, lang);
              return parsed.accounts.length > 1 ? `<b>#${idx + 1}</b>\n${accText}` : accText;
            })
            .join('\n\n');
        }
        if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
          return parsed.keys
            .map((k, idx) => {
              const kVal = typeof k === 'object' ? (k.value || k.key || k.content || JSON.stringify(k)) : String(k);
              const kText = formatSingleItem(kVal, lang);
              return parsed.keys.length > 1 ? `<b>#${idx + 1}</b>\n${kText}` : kText;
            })
            .join('\n\n');
        }
        return formatObjectItem(parsed, lang);
      }
    } catch (_) {
      // Игнорируем ошибку JSON-парсинга и переходим к строковому разбору
    }
  }

  // 2. Обработка многострочного текста (несколько товаров/аккаунтов)
  const lines = rawStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    return lines
      .map((line, idx) => {
        const itemText = formatSingleItem(line, lang);
        return `<b>#${idx + 1}</b>\n${itemText}`;
      })
      .join('\n\n');
  }

  return formatSingleItem(rawStr, lang);
};

const formatObjectItem = (obj, lang = 'ru') => {
  const login = obj.login || obj.user || obj.username || obj.account || obj.email;
  const pass = obj.password || obj.pass || obj.pwd;
  const fa = obj.twoFactor || obj.code || obj['2fa'] || obj.secret || obj.totp;
  const rec = obj.verifyEmail || obj.recovery || obj.recoveryEmail || obj.backup;
  const token = obj.token || obj.key;

  const labels = {
    login: lang === 'en' ? '👤 <b>Login:</b>' : '👤 <b>Логин:</b>',
    pass: lang === 'en' ? '🔑 <b>Password:</b>' : '🔑 <b>Пароль:</b>',
    fa: lang === 'en' ? '🛡 <b>2FA / Code:</b>' : '🛡 <b>2FA / Код:</b>',
    rec: lang === 'en' ? '📧 <b>Recovery:</b>' : '📧 <b>Резервная почта:</b>',
    token: lang === 'en' ? '🎟 <b>Token:</b>' : '🎟 <b>Токен:</b>',
  };

  const lines = [];
  if (login) lines.push(`${labels.login} <code>${escapeHtml(String(login).trim())}</code>`);
  if (pass) lines.push(`${labels.pass} <code>${escapeHtml(String(pass).trim())}</code>`);
  if (fa) lines.push(`${labels.fa} <code>${escapeHtml(String(fa).trim())}</code>`);
  if (rec) lines.push(`${labels.rec} <code>${escapeHtml(String(rec).trim())}</code>`);
  if (token && !login && !pass) lines.push(`${labels.token} <code>${escapeHtml(String(token).trim())}</code>`);

  if (lines.length > 0) return lines.join('\n');
  return `<code>${escapeHtml(JSON.stringify(obj))}</code>`;
};

const formatSingleItem = (rawStr, lang = 'ru') => {
  const val = String(rawStr).trim();
  if (!val) return '';

  if (/^https?:\/\//i.test(val)) {
    const linkLbl = lang === 'en' ? '🔗 <b>Link:</b>' : '🔗 <b>Ссылка:</b>';
    return `${linkLbl}\n<code>${escapeHtml(val)}</code>`;
  }

  let parts = [];
  if (val.includes('|')) {
    parts = val.split('|').map((s) => s.trim()).filter(Boolean);
  } else if (val.includes('\t')) {
    parts = val.split('\t').map((s) => s.trim()).filter(Boolean);
  } else if (val.includes(';')) {
    parts = val.split(';').map((s) => s.trim()).filter(Boolean);
  } else if (val.includes(':')) {
    parts = val.split(':').map((s) => s.trim()).filter(Boolean);
  }

  const cleanPrefix = (s, regex) => s.replace(regex, '').trim();

  const labels = {
    login: lang === 'en' ? '👤 <b>Login:</b>' : '👤 <b>Логин:</b>',
    pass: lang === 'en' ? '🔑 <b>Password:</b>' : '🔑 <b>Пароль:</b>',
    fa: lang === 'en' ? '🛡 <b>2FA / Code:</b>' : '🛡 <b>2FA / Код:</b>',
    rec: lang === 'en' ? '📧 <b>Recovery:</b>' : '📧 <b>Резервная почта:</b>',
  };

  if (parts.length >= 2) {
    let login = '';
    let pass = '';
    let fa = '';
    let rec = '';
    const extra = [];

    parts.forEach((p, idx) => {
      if (/^(?:login|user|username|аккаунт|account|email|логин|почта)\s*[:=]/i.test(p)) {
        login = cleanPrefix(p, /^(?:login|user|username|аккаунт|account|email|логин|почта)\s*[:=]\s*/i);
      } else if (/^(?:password|pass|пароль|pwd)\s*[:=]/i.test(p)) {
        pass = cleanPrefix(p, /^(?:password|pass|пароль|pwd)\s*[:=]\s*/i);
      } else if (/^(?:2fa|code|код|secret|totp|twofactor)\s*[:=]/i.test(p)) {
        fa = cleanPrefix(p, /^(?:2fa|code|код|secret|totp|twofactor)\s*[:=]\s*/i);
      } else if (/^(?:recovery|backup|verifyemail|резерв|доп)\s*[:=]/i.test(p)) {
        rec = cleanPrefix(p, /^(?:recovery|backup|verifyemail|резерв|доп)\s*[:=]\s*/i);
      } else {
        if (idx === 0 && !login) login = cleanPrefix(p, /^(?:login|user|email|логин|почта)\s*[:=]\s*/i);
        else if (idx === 1 && !pass) pass = cleanPrefix(p, /^(?:pass|password|пароль)\s*[:=]\s*/i);
        else if (idx === 2 && !fa) fa = cleanPrefix(p, /^(?:2fa|код|code)\s*[:=]\s*/i);
        else extra.push(p);
      }
    });

    const lines = [];
    if (login) lines.push(`${labels.login} <code>${escapeHtml(login)}</code>`);
    if (pass) lines.push(`${labels.pass} <code>${escapeHtml(pass)}</code>`);
    if (fa) lines.push(`${labels.fa} <code>${escapeHtml(fa)}</code>`);
    if (rec) lines.push(`${labels.rec} <code>${escapeHtml(rec)}</code>`);
    if (extra.length > 0) lines.push(`ℹ️ <code>${escapeHtml(extra.join(' | '))}</code>`);

    if (lines.length > 0) return lines.join('\n');
  }

  return `<code>${escapeHtml(val)}</code>`;
};

module.exports = {
  safeEdit,
  fmtUSDT,
  balanceHeader,
  copyHint,
  errorScreen,
  confirmScreen,
  parseAmount,
  extractTextWithEmojis,
  escapeHtml,
  formatDigitalItem,
  formatDateTimeMSK,
  formatDateMSK,
  EMOJI,
  TEXTS,
  SLA,
};

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

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const LABEL_LOGIN_RE = /^(?:login|user|username|аккаунт|account|email|логин|почта)\s*[:=]\s*/i;
const LABEL_PASS_RE = /^(?:password|pass|пароль|pwd)\s*[:=]\s*/i;
const LABEL_2FA_RE = /^(?:(?:2fa|code|код|secret|totp|twofactor|google\s*auth(?:enticator)?)(?:\s+(?:2fa|code|key|secret|код|ключ))?|ключ\s+2fa)\s*[:=]\s*/i;
const LABEL_REC_RE = /^(?:recovery(?:\s+email)?|backup(?:\s+email)?|verifyemail|резерв(?:ная\s+почта)?|доп(?:\.\s*почта)?)\s*[:=]\s*/i;
const ANY_SINGLE_LABEL_RE = /^(?:login|user|username|аккаунт|account|email|логин|почта|password|pass|пароль|pwd|(?:2fa|code|код|secret|totp|twofactor|google\s*auth(?:enticator)?)(?:\s+(?:2fa|code|key|secret|код|ключ))?|ключ\s+2fa|recovery(?:\s+email)?|backup(?:\s+email)?|verifyemail|резерв(?:ная\s+почта)?|доп(?:\.\s*почта)?)\s*[:=]\s*/i;

/**
 * Проверяет и нормализует Base32 секретный ключ 2FA (Google Authenticator).
 * Поддерживает ключи с пробелами внутри, суффиксы '=', префиксы '2fa:' и ссылки otpauth://totp/.
 * Отсекает обычные пароли (смешанный регистр), обычные английские слова в нижнем регистре,
 * ссылки, email-адреса и лицензионные ключи с дефисами.
 * @param {string} rawSecret
 * @returns {string|null} Очищенный Base32-ключ в верхнем регистре или null
 */
const normalizeBase32Secret = (rawSecret) => {
  if (!rawSecret || typeof rawSecret !== 'string') return null;
  let str = rawSecret.trim();
  if (!str) return null;

  let hasExplicitPrefix = false;

  // 1. Извлечение secret из otpauth:// ссылки или query-параметра
  if (/otpauth:\/\//i.test(str) || /[?&]secret=/i.test(str)) {
    hasExplicitPrefix = true;
    let decodedQuery = str;
    try {
      decodedQuery = decodeURIComponent(str);
    } catch (_) {
      decodedQuery = str;
    }
    const match = decodedQuery.match(/[?&]secret=([A-Za-z2-7=]+(?:\s+[A-Za-z2-7=]+)*)/i);
    if (!match) return null;
    str = match[1].trim();
  } else if (LABEL_2FA_RE.test(str)) {
    // Убираем возможный префикс поля ("2FA:", "secret:", "totp:", "code:", "код:", "Код 2FA:")
    hasExplicitPrefix = true;
    str = str.replace(LABEL_2FA_RE, '').trim();
  }

  if (!str) return null;

  // Отсекаем обычные URL, email и пути
  if (/^https?:\/\//i.test(str) || str.includes('@') || str.includes('/')) {
    return null;
  }

  // Разрешены только символы Base32 (A-Z, a-z, 2-7), пробелы и '=' в конце
  if (!/^[A-Za-z2-7\s]+=*$/.test(str)) {
    return null;
  }

  const withoutPadding = str.replace(/=+$/, '').trim();
  if (!withoutPadding) return null;

  // Настоящий Base32-секрет не бывает в смешанном регистре (как пароль типа dreYWi2CR3A2)
  const hasUpper = /[A-Z]/.test(withoutPadding);
  const hasLower = /[a-z]/.test(withoutPadding);
  if (hasUpper && hasLower) {
    return null;
  }

  const hasBase32Digits = /[2-7]/.test(withoutPadding);

  // Обычное словарное слово в нижнем регистре без цифр 2-7 и без явного префикса 2FA — не Base32 секрет
  if (hasLower && !hasUpper && !hasBase32Digits && !hasExplicitPrefix) {
    return null;
  }

  // Если внутри есть пробелы, проверяем что это группы фиксированной длины (2, 4, 8 или 16 символов),
  // а не обычная фраза из слов разной длины
  if (/\s/.test(withoutPadding)) {
    const groups = withoutPadding.split(/\s+/);
    if (groups.length < 2) return null;
    const firstLen = groups[0].length;
    if (![2, 4, 8, 16].includes(firstLen)) return null;
    for (let i = 0; i < groups.length - 1; i++) {
      if (groups[i].length !== firstLen) return null;
    }
    if (groups[groups.length - 1].length > firstLen) return null;
  }

  const cleaned = withoutPadding.replace(/\s+/g, '').toUpperCase();
  // Стандартный Base32 ключ для TOTP имеет длину от 16 до 128 символов (80+ бит)
  if (cleaned.length < 16 || cleaned.length > 128) {
    return null;
  }

  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    return null;
  }

  return cleaned;
};

/**
 * Проверяет, является ли строка валидным Base32 секретом 2FA
 * @param {string} rawSecret
 * @returns {boolean}
 */
const isValidBase32Secret = (rawSecret) => Boolean(normalizeBase32Secret(rawSecret));

/**
 * Декодирует Base32-строку (RFC 4648) в Buffer
 * @param {string} secretStr
 * @returns {Buffer|null}
 */
const decodeBase32 = (secretStr) => {
  const normalized = normalizeBase32Secret(secretStr);
  if (!normalized) return null;

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < normalized.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(normalized[i]);
    if (idx === -1) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
};

/**
 * Возвращает оставшееся время жизни текущего 30-секундного TOTP окна (1..30 сек)
 * @param {number} [nowMs]
 * @param {number} [step=30]
 * @returns {number}
 */
const getRemainingTOTPSeconds = (nowMs = Date.now(), step = 30) => {
  return step - (Math.floor(nowMs / 1000) % step);
};

/**
 * Вычисляет 6-значный код TOTP по стандарту Google Authenticator (RFC 6238, HMAC-SHA1, шаг 30 сек)
 * @param {string} rawSecret Base32 секретный ключ
 * @param {number|{nowMs?: number, step?: number, digits?: number}} [nowMsOrOptions]
 * @returns {string|null} 6-значный код (например, '482910') или null при невалидном ключе
 */
const generateTOTP = (rawSecret, nowMsOrOptions = Date.now()) => {
  const keyBuffer = decodeBase32(rawSecret);
  if (!keyBuffer || keyBuffer.length === 0) return null;

  const opts = typeof nowMsOrOptions === 'number'
    ? { nowMs: nowMsOrOptions }
    : (nowMsOrOptions || {});
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const step = opts.step || 30;
  const digits = opts.digits || 6;

  const epochSeconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(epochSeconds / step);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', keyBuffer).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, '0');
};

/**
 * Извлекает сырую строку выданных данных из объекта заказа или строки
 * @param {string|Object} input
 * @returns {string}
 */
const resolveOrderDeliveryRaw = (input) => {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    if (input.replacedKeyId?.value || input.deliveryData || input.keyId?.value) {
      return String(input.replacedKeyId?.value || input.deliveryData || input.keyId?.value);
    }
    if (typeof input.value === 'string') return input.value;
  }
  return '';
};

const extract2FAFromObjectItem = (obj) => {
  if (!obj || typeof obj !== 'object') return [];
  const login = String(obj.login || obj.user || obj.username || obj.account || obj.email || '').trim();
  const rawFa = obj.twoFactor || obj.code || obj['2fa'] || obj.secret || obj.totp || '';
  const secret = normalizeBase32Secret(String(rawFa));
  if (secret) return [{ login, secret }];
  return [];
};

const isStandaloneLabeledField = (str) => {
  if (!str || str.includes('|') || str.includes('\t') || str.includes(';')) return false;
  if (!ANY_SINGLE_LABEL_RE.test(str)) return false;
  const rest = str.replace(ANY_SINGLE_LABEL_RE, '').trim();
  if (!rest) return false;
  if (/^otpauth:\/\//i.test(rest) || /^https?:\/\//i.test(rest)) return true;
  return !rest.includes(':');
};

const splitCredentialParts = (val) => {
  if (val.includes('|')) {
    return val.split('|').map((s) => s.trim()).filter(Boolean);
  }
  if (val.includes('\t')) {
    return val.split('\t').map((s) => s.trim()).filter(Boolean);
  }
  if (val.includes(';')) {
    return val.split(';').map((s) => s.trim()).filter(Boolean);
  }
  if (/^otpauth:\/\//i.test(val) || /^https?:\/\//i.test(val)) {
    return [val];
  }
  if (isStandaloneLabeledField(val)) {
    return [val];
  }
  if (val.includes(':')) {
    // Сохраняем целостность otpauth:// или http(s):// если они переданы после двоеточия
    const uriMatch = val.match(/(?:otpauth|https?):\/\//i);
    if (uriMatch && uriMatch.index > 0) {
      const head = val.slice(0, uriMatch.index).replace(/:+\s*$/, '');
      const tail = val.slice(uriMatch.index);
      return [...head.split(':').map((s) => s.trim()).filter(Boolean), tail.trim()];
    }
    return val.split(':').map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

const parseCredentialParts = (parts) => {
  const cleanPrefix = (s, regex) => s.replace(regex, '').trim();
  let login = '';
  let pass = '';
  let fa = '';
  let rec = '';
  const extra = [];
  const unlabeledTail = [];

  parts.forEach((p, idx) => {
    if (LABEL_LOGIN_RE.test(p)) {
      login = cleanPrefix(p, LABEL_LOGIN_RE);
    } else if (LABEL_PASS_RE.test(p)) {
      pass = cleanPrefix(p, LABEL_PASS_RE);
    } else if (LABEL_2FA_RE.test(p)) {
      fa = cleanPrefix(p, LABEL_2FA_RE);
    } else if (LABEL_REC_RE.test(p)) {
      rec = cleanPrefix(p, LABEL_REC_RE);
    } else if (idx === 0 && !login) {
      login = p.trim();
    } else if (idx === 1 && !pass) {
      pass = p.trim();
    } else {
      unlabeledTail.push(p.trim());
    }
  });

  // Умное распределение неразмеченных полей начиная с 3-й позиции (2FA, резервная почта, доп. данные)
  if (unlabeledTail.length > 0) {
    // 1. Сначала ищем валидный Base32-ключ 2FA среди неразмеченных частей
    let faIdx = -1;
    if (!fa) {
      faIdx = unlabeledTail.findIndex((item) => isValidBase32Secret(item));
      if (faIdx !== -1) {
        fa = unlabeledTail[faIdx];
      }
    }

    // 2. Распределяем оставшиеся элементы
    unlabeledTail.forEach((item, i) => {
      if (i === faIdx) return;
      const isEmailLike = item.includes('@') && !/^otpauth:\/\//i.test(item);
      if (isEmailLike && !rec && (unlabeledTail.length > 1 || fa)) {
        rec = item;
      } else if (!fa && i === 0) {
        fa = item;
      } else if (isEmailLike && !rec) {
        rec = item;
      } else {
        extra.push(item);
      }
    });
  }

  return { login, pass, fa, rec, extra };
};

const parseOtpauthUri = (val) => {
  if (!/^otpauth:\/\/totp\//i.test(val)) return null;
  const secret = normalizeBase32Secret(val);
  if (!secret) return null;
  let login = '';
  const labelMatch = val.match(/^otpauth:\/\/totp\/([^?]+)/i);
  if (labelMatch) {
    try {
      const decoded = decodeURIComponent(labelMatch[1]);
      login = decoded.includes(':') ? decoded.split(':').slice(1).join(':').trim() : decoded.trim();
    } catch (_) {
      login = labelMatch[1].trim();
    }
  }
  return { login, secret };
};

const extract2FAFromSingleLine = (rawLine) => {
  let val = String(rawLine || '').trim();
  if (!val) return null;
  val = val.replace(/^(?:#\d+[:.]?\s*|\d+[:.)]\s*)/, '').trim();
  if (!val || /^https?:\/\//i.test(val)) return null;

  // Прямая ссылка otpauth://totp/
  const otpParsed = parseOtpauthUri(val);
  if (otpParsed) return otpParsed;

  // Явный префикс 2FA на отдельной строке (например "2FA: Z7Z5..." или "Код: Z7Z5...")
  if (LABEL_2FA_RE.test(val) && isStandaloneLabeledField(val)) {
    const secret = normalizeBase32Secret(val);
    if (secret) return { login: '', secret, isStandalone2FALine: true };
  }

  const parts = splitCredentialParts(val);
  if (parts.length < 2) return null;

  const { login, fa, extra } = parseCredentialParts(parts);
  let secret = normalizeBase32Secret(fa);
  if (!secret && extra.length > 0) {
    for (const item of extra) {
      const candidate = normalizeBase32Secret(item);
      if (candidate) {
        secret = candidate;
        break;
      }
    }
  }

  if (!secret) return null;
  return { login: login || '', secret };
};

/**
 * Группирует многострочный текст: если строки представляют собой поля одного аккаунта
 * ("Логин: ...", "Пароль: ...", "2FA: ..."), объединяет их через " | " в одну запись.
 * @param {string[]} lines
 * @returns {string[]}
 */
const collapseLabeledLines = (lines) => {
  if (lines.length <= 1) return lines;
  const cleanLines = lines.map((l) => l.replace(/^(?:#\d+[:.]?\s*|\d+[:.)]\s*)/, '').trim());
  if (!cleanLines.every((l) => isStandaloneLabeledField(l))) {
    return lines;
  }

  const grouped = [];
  let currentGroup = [];
  let hasSeenLoginInGroup = false;

  for (const line of cleanLines) {
    const isLoginLine = LABEL_LOGIN_RE.test(line);
    if (isLoginLine && currentGroup.length > 0 && hasSeenLoginInGroup) {
      grouped.push(currentGroup.join(' | '));
      currentGroup = [line];
      hasSeenLoginInGroup = true;
    } else {
      if (isLoginLine) hasSeenLoginInGroup = true;
      currentGroup.push(line);
    }
  }
  if (currentGroup.length > 0) {
    grouped.push(currentGroup.join(' | '));
  }
  return grouped;
};

/**
 * Извлекает список аккаунтов с валидными 2FA ключами из выданных данных товара.
 * @param {string|Object} rawInput Строка (deliveryData / key.value) или объект заказа
 * @returns {Array<{login: string, secret: string}>}
 */
const extract2FAAccounts = (rawInput) => {
  const rawValue = resolveOrderDeliveryRaw(rawInput);
  if (!rawValue) return [];
  const rawStr = String(rawValue).trim();
  if (!rawStr) return [];

  // 1. Попытка распарсить JSON
  if ((rawStr.startsWith('{') && rawStr.endsWith('}')) || (rawStr.startsWith('[') && rawStr.endsWith(']'))) {
    try {
      const parsed = JSON.parse(rawStr);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item) => (
          typeof item === 'object' && item !== null
            ? extract2FAFromObjectItem(item)
            : extract2FAAccounts(String(item))
        ));
      }
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.content) return extract2FAAccounts(parsed.content);
        if (parsed.delivery) return extract2FAAccounts(parsed.delivery);
        if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
          return parsed.accounts.flatMap((acc) => (
            typeof acc === 'object' && acc !== null
              ? extract2FAFromObjectItem(acc)
              : extract2FAAccounts(String(acc))
          ));
        }
        if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
          return parsed.keys.flatMap((k) => {
            const kVal = typeof k === 'object' && k !== null
              ? (k.value || k.key || k.content || JSON.stringify(k))
              : String(k);
            return extract2FAAccounts(kVal);
          });
        }
        return extract2FAFromObjectItem(parsed);
      }
    } catch (_) {
      // Переходим к построчному разбору
    }
  }

  // 2. Построчный разбор (одиночный или мульти-аккаунт)
  const rawLines = rawStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines = collapseLabeledLines(rawLines);
  const results = [];
  let pendingLogin = '';

  for (const line of lines) {
    const cleanLine = line.replace(/^(?:#\d+[:.]?\s*|\d+[:.)]\s*)/, '').trim();
    if (LABEL_LOGIN_RE.test(cleanLine) && isStandaloneLabeledField(cleanLine)) {
      pendingLogin = cleanLine.replace(LABEL_LOGIN_RE, '').trim();
      continue;
    }

    const extracted = extract2FAFromSingleLine(line);
    if (extracted) {
      const login = extracted.login || (extracted.isStandalone2FALine ? pendingLogin : '');
      results.push({ login, secret: extracted.secret });
      pendingLogin = '';
    }
  }

  return results;
};

/**
 * Проверяет, содержат ли выданные данные хотя бы один валидный ключ 2FA
 * @param {string|Object} rawInput
 * @returns {boolean}
 */
const has2FASecret = (rawInput) => extract2FAAccounts(rawInput).length > 0;

/**
 * Возвращает подсказку о получении 6-значного кода 2FA
 * @param {string} [lang='ru']
 * @returns {string}
 */
const get2FAHintText = (lang = 'ru') => (
  lang === 'en'
    ? '💡 <i>Website asking for a 6-digit code? Just tap the button below 👇</i>'
    : '💡 <i>При входе на сайт просит 6-значный код? Просто нажмите на кнопку ниже 👇</i>'
);

/**
 * Возвращает текст инлайн-кнопки получения 6-значного кода 2FA
 * @param {string} [lang='ru']
 * @returns {string}
 */
const get2FAButtonLabel = (lang = 'ru') => (
  lang === 'en'
    ? '🔐 Get 6-digit login code (2FA)'
    : '🔐 Получить 6-значный код для входа (2FA)'
);

/**
 * Формирует сообщение с актуальным 6-значным TOTP кодом (или кодами для мульти-аккаунтов)
 * @param {string|Object|Array<{login: string, secret: string}>} input
 * @param {string} [lang='ru']
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
const format2FACodeMessage = (input, lang = 'ru', nowMs = Date.now()) => {
  const accounts = Array.isArray(input) ? input : extract2FAAccounts(input);
  if (!accounts.length) return '';

  const remainingSec = getRemainingTOTPSeconds(nowMs);

  if (accounts.length === 1) {
    const code = generateTOTP(accounts[0].secret, nowMs);
    if (!code) return '';
    if (lang === 'en') {
      return (
        `🔐 <b>Verification code (2FA) for login:</b>\n\n` +
        `👉 <code>${code}</code> <i>(tap the digits to copy)</i>\n\n` +
        `⏳ <i>Code is valid for: <b>${remainingSec} sec.</b></i>`
      );
    }
    return (
      `🔐 <b>Код подтверждения (2FA) для входа:</b>\n\n` +
      `👉 <code>${code}</code> <i>(нажмите на цифры, чтобы скопировать)</i>\n\n` +
      `⏳ <i>Код действует ещё: <b>${remainingSec} сек.</b></i>`
    );
  }

  const lines = accounts
    .map((acc, idx) => {
      const code = generateTOTP(acc.secret, nowMs);
      if (!code) return null;
      const loginPart = acc.login ? ` (${escapeHtml(acc.login)})` : '';
      return lang === 'en'
        ? `Account #${idx + 1}${loginPart}: <code>${code}</code>`
        : `Аккаунт #${idx + 1}${loginPart}: <code>${code}</code>`;
    })
    .filter(Boolean);

  if (!lines.length) return '';

  if (lang === 'en') {
    return (
      `🔐 <b>Verification code (2FA) for login:</b>\n\n` +
      `${lines.join('\n')}\n\n` +
      `<i>(tap the digits to copy)</i>\n\n` +
      `⏳ <i>Code is valid for: <b>${remainingSec} sec.</b></i>`
    );
  }

  return (
    `🔐 <b>Код подтверждения (2FA) для входа:</b>\n\n` +
    `${lines.join('\n')}\n\n` +
    `<i>(нажмите на цифры, чтобы скопировать)</i>\n\n` +
    `⏳ <i>Код действует ещё: <b>${remainingSec} сек.</b></i>`
  );
};

/**
 * Внутреннее форматирование цифрового товара без финальной подсказки 2FA
 * @param {string} rawValue
 * @param {string} lang 'ru' | 'en'
 */
const formatDigitalItemCore = (rawValue, lang = 'ru') => {
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
        if (parsed.content) return formatDigitalItemCore(parsed.content, lang);
        if (parsed.delivery) return formatDigitalItemCore(parsed.delivery, lang);
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

  // 2. Обработка многострочного текста (несколько товаров/аккаунтов или многострочная разметка одного аккаунта)
  const rawLines = rawStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines = collapseLabeledLines(rawLines);
  if (lines.length > 1) {
    return lines
      .map((line, idx) => {
        const itemText = formatSingleItem(line, lang);
        return `<b>#${idx + 1}</b>\n${itemText}`;
      })
      .join('\n\n');
  }

  return formatSingleItem(lines[0] || rawStr, lang);
};

/**
 * Красивое форматирование цифрового товара (логин:пароль:2fa, ссылка, ключ).
 * Если в данных обнаружен валидный ключ 2FA — автоматически добавляет подсказку.
 * @param {string} rawValue
 * @param {string} lang 'ru' | 'en'
 */
const formatDigitalItem = (rawValue, lang = 'ru') => {
  const core = formatDigitalItemCore(rawValue, lang);
  if (!core) return '';
  if (has2FASecret(rawValue)) {
    const hint = get2FAHintText(lang);
    if (!core.includes(hint)) {
      return `${core}\n\n${hint}`;
    }
  }
  return core;
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
  let val = String(rawStr).trim();
  if (!val) return '';
  val = val.replace(/^(?:#\d+[:.]?\s*|\d+[:.)]\s*)/, '').trim();

  if (/^https?:\/\//i.test(val)) {
    const linkLbl = lang === 'en' ? '🔗 <b>Link:</b>' : '🔗 <b>Ссылка:</b>';
    return `${linkLbl}\n<code>${escapeHtml(val)}</code>`;
  }

  const labels = {
    login: lang === 'en' ? '👤 <b>Login:</b>' : '👤 <b>Логин:</b>',
    pass: lang === 'en' ? '🔑 <b>Password:</b>' : '🔑 <b>Пароль:</b>',
    fa: lang === 'en' ? '🛡 <b>2FA / Code:</b>' : '🛡 <b>2FA / Код:</b>',
    rec: lang === 'en' ? '📧 <b>Recovery:</b>' : '📧 <b>Резервная почта:</b>',
  };

  const otpParsed = parseOtpauthUri(val);
  if (otpParsed) {
    const lines = [];
    if (otpParsed.login) lines.push(`${labels.login} <code>${escapeHtml(otpParsed.login)}</code>`);
    lines.push(`${labels.fa} <code>${escapeHtml(otpParsed.secret)}</code>`);
    return lines.join('\n');
  }

  const parts = splitCredentialParts(val);

  if (parts.length >= 2 || (parts.length === 1 && isStandaloneLabeledField(parts[0]))) {
    const { login, pass, fa, rec, extra } = parseCredentialParts(parts);

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

/**
 * Проверяет, активен ли режим Rich API (кнопки внутри сообщения Telegram 10.3)
 * с учётом настроек админа и индивидуального выбора пользователя.
 *
 * @param {Object} ctx Telegraf context (содержит ctx.user)
 * @param {Object} settings Настройки магазина (из getSettings / Settings)
 * @returns {boolean}
 */
const isRichActive = (ctx, settings) => {
  const mode = settings?.globalButtonsMode || 'by_user';
  if (mode === 'force_classic') return false;
  if (mode === 'force_rich') return true;
  // by_user:
  const userPref = ctx?.user?.buttonLayout;
  if (userPref === 'classic') return false;
  if (userPref === 'rich') return true;
  return (settings?.defaultButtonLayout || 'rich') === 'rich';
};

/**
 * Универсальная отправка/редактирование сообщения с поддержкой Telegram Bot API 10.3 Rich Message
 * (<tg-button-row> / <tg-button>).
 * При isRich === false или ошибке API — моментальный фолбэк на safeEdit с классической клавиатурой.
 */
const safeEditRich = async (ctx, { richHtml, classicText, classicKeyboard, isRich }) => {
  const keyboardExtra = (classicKeyboard && classicKeyboard.reply_markup)
    ? classicKeyboard
    : Markup.inlineKeyboard(classicKeyboard || []);
  const opts = { parse_mode: 'HTML', ...keyboardExtra };

  if (!isRich) {
    return safeEdit(ctx, classicText, opts);
  }

  // Попытка отправить через Rich Message (Telegram Bot API 10.3)
  if (ctx.telegram?.callApi) {
    try {
      const chatId = ctx.chat?.id || ctx.from?.id;
      const messageId = ctx.callbackQuery?.message?.message_id;

      if (ctx.callbackQuery && messageId && chatId) {
        const res = await ctx.telegram.callApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          rich_message: { html: richHtml },
          reply_markup: { inline_keyboard: [] },
        });
        await ctx.answerCbQuery().catch(() => {});
        return res;
      } else if (chatId) {
        const res = await ctx.telegram.callApi('sendRichMessage', {
          chat_id: chatId,
          rich_message: { html: richHtml },
        });
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery().catch(() => {});
        }
        return res;
      }
    } catch (err) {
      const errText = String(err?.description || err?.message || '');
      if (errText.includes('message is not modified')) {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('🔄 Данные актуальны').catch(() => {});
        }
        return null;
      }
      // Авто-фолбэк: при любой ошибке Telegram (устаревший клиент, ошибка парсинга и т.д.)
      // моментально откатываемся на обычный safeEdit с классической клавиатурой
    }
  }

  return safeEdit(ctx, classicText, opts);
};

module.exports = {
  safeEdit,
  safeEditRich,
  isRichActive,
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
  normalizeBase32Secret,
  isValidBase32Secret,
  decodeBase32,
  getRemainingTOTPSeconds,
  generateTOTP,
  extract2FAAccounts,
  has2FASecret,
  get2FAHintText,
  get2FAButtonLabel,
  format2FACodeMessage,
  EMOJI,
  TEXTS,
  SLA,
};

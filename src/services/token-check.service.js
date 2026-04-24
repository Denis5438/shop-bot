const logger = require('../config/logger');

/**
 * Offline-валидация ChatGPT session-токена без обращения к внешнему provider.
 *
 * Токен, который копируется со страницы /api/auth/session на chatgpt.com,
 * это валидный JSON вида:
 * {
 *   "user": { "email": "...", "id": "...", ... },
 *   "expires": "2026-...",
 *   "accessToken": "eyJ..."
 * }
 *
 * Мы проверяем структуру и срок действия токена ДО оплаты.
 * Это отсекает ~90% типичных ошибок:
 *   - «скопировал не весь токен»
 *   - «вставил случайный текст»
 *   - «токен уже истёк»
 *   - «забыл войти — кука пустая»
 *
 * Метод НЕ гарантирует, что provider примет токен (там могут быть
 * региональные блокировки, rate-limits и т.п.), но даёт пользователю
 * высокую уверенность перед списанием денег.
 */

// ─── Конфиг ────────────────────────────────────────────────────────────────
const MIN_TOKEN_LENGTH = 200;   // короче — точно обрезок
const MIN_ACCESS_TOKEN_LENGTH = 50;

// ─── Результат ─────────────────────────────────────────────────────────────
/**
 * @typedef {Object} TokenCheckResult
 * @property {boolean} ok           Полностью валиден
 * @property {string}  [email]      Email из user.email (если распарсили)
 * @property {Date}    [expiresAt]  Дата истечения токена
 * @property {number}  [expiresInH] Сколько часов осталось до истечения
 * @property {string[]} issues      Список проблем человекочитаемо
 * @property {string}  severity     'valid' | 'warning' | 'error'
 */

/**
 * Парсит и валидирует токен.
 * @param {string} raw Сырой ввод пользователя.
 * @returns {TokenCheckResult}
 */
const validateChatgptToken = (raw) => {
  const issues = [];
  const trimmed = String(raw || '').trim();

  if (!trimmed) {
    return {
      ok: false,
      severity: 'error',
      issues: ['Пустой ввод. Пришлите содержимое страницы /api/auth/session.'],
    };
  }

  if (trimmed.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      severity: 'error',
      issues: [
        `Слишком короткий (${trimmed.length} симв.). Вероятно, скопирована только часть токена.`,
        'Откройте /api/auth/session и скопируйте всё содержимое страницы целиком.',
      ],
    };
  }

  // Пробуем распарсить как JSON
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // Попробуем исправить типичную проблему: несколько JSON подряд (склеенные части)
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        // fallthrough
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      severity: 'error',
      issues: [
        'Это не JSON. Похоже, скопировался HTML страницы (например, форма входа).',
        'Проверьте, что вы залогинены в chatgpt.com, и повторите копирование.',
      ],
    };
  }

  // Проверяем user.email
  const email = parsed?.user?.email;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    issues.push('Не найдено поле user.email — возможно, вы не авторизованы на chatgpt.com.');
  }

  // Проверяем accessToken
  const accessToken = parsed?.accessToken;
  if (!accessToken || typeof accessToken !== 'string') {
    issues.push('Не найдено поле accessToken — токен неполный.');
  } else if (accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
    issues.push(`Поле accessToken слишком короткое (${accessToken.length} симв.) — возможно, обрезано.`);
  }

  // Проверяем expires
  let expiresAt = null;
  let expiresInH = null;
  if (parsed?.expires) {
    const parsedDate = new Date(parsed.expires);
    if (isNaN(parsedDate.getTime())) {
      issues.push('Поле expires содержит невалидную дату.');
    } else {
      expiresAt = parsedDate;
      const diffMs = expiresAt.getTime() - Date.now();
      expiresInH = Math.floor(diffMs / (1000 * 60 * 60));

      if (diffMs <= 0) {
        issues.push(`Токен уже истёк (${expiresAt.toLocaleString('ru-RU')}). Обновите страницу /api/auth/session и скопируйте заново.`);
      } else if (expiresInH < 1) {
        issues.push('Токен истекает меньше чем через час — может не успеть пройти активацию.');
      }
    }
  } else {
    // Нет срока — подозрительно, но не фатально.
    issues.push('Не найдено поле expires — тип токена неизвестен.');
  }

  // Определяем итоговый severity
  const hasFatal = issues.some((i) =>
    i.includes('уже истёк') ||
    i.includes('не JSON') ||
    i.includes('accessToken')
  );
  const severity = issues.length === 0
    ? 'valid'
    : hasFatal
      ? 'error'
      : 'warning';

  logger.info(`[TokenCheck] email=${email || 'n/a'} severity=${severity} issues=${issues.length}`);

  return {
    ok: severity === 'valid',
    email,
    expiresAt,
    expiresInH,
    issues,
    severity,
  };
};

/**
 * Форматирует результат проверки в HTML-сообщение для Telegram.
 * @param {TokenCheckResult} result
 * @returns {string}
 */
const formatCheckReport = (result) => {
  const lines = [];

  if (result.ok) {
    lines.push('✅ <b>Токен валиден!</b>');
    lines.push('');
    if (result.email) lines.push(`📧 Аккаунт: <code>${result.email}</code>`);
    if (result.expiresAt) {
      const h = result.expiresInH;
      const timeLeft = h >= 24 ? `${Math.floor(h / 24)} дн.` : `${h} ч.`;
      lines.push(`⏱ Срок действия: <b>${timeLeft}</b>`);
    }
    lines.push('');
    lines.push('<blockquote>🎯 Токен готов к активации. Можете оформлять заказ — мы используем именно этот токен.</blockquote>');
  } else if (result.severity === 'warning') {
    lines.push('⚠️ <b>Токен есть, но с предупреждениями:</b>');
    lines.push('');
    for (const issue of result.issues) {
      lines.push(`• ${issue}`);
    }
    if (result.email) {
      lines.push('');
      lines.push(`📧 Аккаунт: <code>${result.email}</code>`);
    }
    lines.push('');
    lines.push('<blockquote>💡 Скорее всего активация пройдёт, но возможны сбои. Рекомендуем взять свежий токен.</blockquote>');
  } else {
    lines.push('❌ <b>Токен невалиден</b>');
    lines.push('');
    for (const issue of result.issues) {
      lines.push(`• ${issue}`);
    }
    lines.push('');
    lines.push(
      '<blockquote>📖 Как получить правильный токен:\n' +
      '1️⃣ Войдите в <a href="https://chatgpt.com">chatgpt.com</a>\n' +
      '2️⃣ Откройте <a href="https://chatgpt.com/api/auth/session">chatgpt.com/api/auth/session</a>\n' +
      '3️⃣ Скопируйте <b>весь</b> JSON со страницы</blockquote>'
    );
  }

  return lines.join('\n');
};

module.exports = {
  validateChatgptToken,
  formatCheckReport,
};

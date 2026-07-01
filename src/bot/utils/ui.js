const { Markup } = require('telegraf');
const { EMOJI, TEXTS, SLA } = require('../constants/ux');

/**
 * Переиспользуемые UI-хелперы для сцен бота.
 * Цель: один источник правды для частых паттернов
 * (error screen, empty state, copy hints, balance header, confirm).
 */

// ─── safeEdit — всегда корректно рисует сообщение ──────────────────────────
/**
 * Пытается отредактировать сообщение (если пришли из callback),
 * при неудаче — шлёт новое. Всегда вызывает answerCbQuery.
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
  } catch (_) {
    try { sent = await ctx.reply(text, opts); } catch (_) { /* ignore */ }
  }
  if (ctx.callbackQuery) {
    ctx.answerCbQuery().catch(() => {});
  }
  return sent;
};

// ─── Header с балансом ─────────────────────────────────────────────────────
/**
 * Строка «💳 Ваш баланс: X USDT» — используется в карточке товара,
 * на подтверждении покупки, на экране пополнения и т.д.
 */
const balanceHeader = (user) => {
  if (!user || typeof user.balance !== 'number') return '';
  return `${EMOJI.BALANCE} <b>Баланс:</b> ${user.balance.toFixed(2)} USDT\n\n`;
};

// ─── Copy-hint — подсказка про копирование ─────────────────────────────────
/**
 * Добавляет подсказку «💡 Нажмите на значение — скопируется».
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

// ─── Empty state с CTA ─────────────────────────────────────────────────────
/**
 * Показывает пустое состояние (нет данных) с призывом к действию.
 *
 * @param {Object} ctx
 * @param {Object} opts
 *   - icon: эмодзи (по умолчанию 📭)
 *   - title: заголовок
 *   - message: описание (зачем это, что сделать)
 *   - cta: { label, action } — основная кнопка
 *   - backAction: callback_data для "Назад"
 */
const emptyScreen = async (ctx, opts = {}) => {
  const {
    icon = EMOJI.EMPTY,
    title = 'Пока пусто',
    message = '',
    cta = null,
    backAction = 'menu:main',
  } = opts;

  const text = `${icon} <b>${title}</b>${message ? `\n\n${message}` : ''}`;

  const buttons = [];
  if (cta) {
    buttons.push([Markup.button.callback(cta.label, cta.action)]);
  }
  buttons.push([Markup.button.callback(TEXTS.BACK, backAction)]);

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
 *   - danger: если true — используется красный стиль
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

  // Несколько точек — оставляем первую
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

module.exports = {
  safeEdit,
  balanceHeader,
  copyHint,
  errorScreen,
  emptyScreen,
  confirmScreen,
  parseAmount,
  extractTextWithEmojis,
  escapeHtml,
  EMOJI,
  TEXTS,
  SLA,
};

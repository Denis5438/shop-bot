const logger = require('../config/logger');
const { ADMIN_IDS } = require('../config');
const { escapeHtml } = require('../bot/utils/ui');

/**
 * Сервис агрегации (digest) уведомлений для админов.
 *
 * Проблема: при высокой активности админы получают десятки мелких уведомлений
 * (новая заявка, токен получен, retry, low-stock...) — это спам.
 *
 * Решение: событие попадает в буфер, раз в N минут буфер сбрасывается
 * одним агрегированным сообщением. При этом:
 *   - критичные события (errors, failed после retry) уходят мгновенно.
 *   - обычные события (new_order, new_topup, token_received) буферизуются.
 *
 * Управление режимом — через глобальную переменную digestEnabled.
 * Пока что она включается программно (setDigestEnabled), в будущем можно
 * вынести в Settings модель и добавить UI в admin/settings.scene.
 *
 * В существующем коде notification.service.sendToAdmins используется без
 * категоризации. Этот сервис добавляет слой ПОВЕРХ — код может явно писать
 * `digest.queue('new_order', { ... })` вместо `sendToAdmins(text)` когда
 * событие попадает под дайджест.
 */

// Категории событий
const CATEGORIES = {
  NEW_ORDER:       { label: '🛒 Новые заказы',        icon: '🛒' },
  NEW_TOPUP:       { label: '💳 Новые пополнения',    icon: '💳' },
  TOKEN_RECEIVED:  { label: '🔑 Получены токены',     icon: '🔑' },
  LOW_STOCK:       { label: '⚠️ Низкий остаток',       icon: '⚠️' },
  ORDER_COMPLETED: { label: '✅ Выполненные заказы',   icon: '✅' },
  ORDER_RETRY:     { label: '🔄 Retry активаций',      icon: '🔄' },
};

// Буфер событий: { [category]: [ { text, timestamp, meta } ] }
let buffer = {};
let digestEnabled = false;
let flushInterval = null;
let botInstance = null;

const setBot = (bot) => { botInstance = bot; };

const setDigestEnabled = (on) => {
  digestEnabled = !!on;
  logger.info(`[Digest] mode=${digestEnabled ? 'ON' : 'OFF'}`);
};

const isDigestEnabled = () => digestEnabled;

/**
 * Добавить событие в буфер. Если digest выключен — вернуть false,
 * чтобы вызывающий код сразу отправил как обычно.
 *
 * @param {keyof CATEGORIES} category
 * @param {string} text Короткое описание для дайджеста (1 строка)
 * @returns {boolean} true если событие положено в буфер, false если нужно отправить обычным способом
 */
const queue = (category, text) => {
  if (!digestEnabled) return false;
  if (!CATEGORIES[category]) {
    logger.warn(`[Digest] unknown category: ${category}`);
    return false;
  }
  if (!buffer[category]) buffer[category] = [];
  buffer[category].push({ text: String(text || ''), timestamp: new Date() });
  return true;
};

/**
 * Сбросить буфер в одно агрегированное сообщение.
 */
const flush = async () => {
  const cats = Object.keys(buffer).filter((c) => buffer[c]?.length);
  if (!cats.length) return;

  const lines = [`📬 <b>Сводка событий</b>  ·  ${new Date().toLocaleString('ru-RU')}\n`];

  for (const cat of cats) {
    const meta = CATEGORIES[cat];
    const events = buffer[cat];
    lines.push(`<b>${meta.label}</b> — ${events.length} шт.`);

    // Показываем первые 5 событий, остальные сворачиваем в "... ещё N"
    const preview = events.slice(0, 5);
    for (const e of preview) {
      lines.push(`  • ${escapeHtml(e.text)}`);
    }
    if (events.length > 5) {
      lines.push(`  … и ещё ${events.length - 5}`);
    }
    lines.push('');
  }

  lines.push('<i>💡 Отключить сводку: /admin → Настройки → Режим уведомлений</i>');

  const text = lines.join('\n');
  buffer = {};

  if (!botInstance) {
    logger.warn('[Digest] flush called but botInstance is null — digest lost');
    return;
  }

  for (const adminId of ADMIN_IDS) {
    try {
      await botInstance.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.warn(`[Digest] failed to send to ${adminId}: ${err.message}`);
    }
  }
};

/**
 * Запустить периодический flush (вызывать при старте бота).
 * @param {number} intervalMs Периодичность (по умолчанию 60 минут)
 */
const startAutoFlush = (intervalMs = 60 * 60 * 1000) => {
  if (flushInterval) {
    clearInterval(flushInterval);
  }
  flushInterval = setInterval(() => {
    flush().catch((err) => logger.error(`[Digest] flush error: ${err.message}`));
  }, intervalMs);
  logger.info(`[Digest] auto-flush started: every ${Math.round(intervalMs / 60000)} min`);
  return flushInterval;
};

const stopAutoFlush = () => {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
};

/**
 * Текущее состояние буфера (для админского UI «Посмотреть что в буфере»).
 */
const getBufferSummary = () => {
  const result = {};
  for (const cat of Object.keys(buffer)) {
    result[cat] = {
      label: CATEGORIES[cat]?.label || cat,
      count: buffer[cat]?.length || 0,
    };
  }
  return result;
};

module.exports = {
  CATEGORIES,
  setBot,
  setDigestEnabled,
  isDigestEnabled,
  queue,
  flush,
  startAutoFlush,
  stopAutoFlush,
  getBufferSummary,
};

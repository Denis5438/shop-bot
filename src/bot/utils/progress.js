/**
 * Анимированный прогресс-индикатор для долгих операций.
 *
 * Пример:
 *   const progress = await startProgress(ctx, {
 *     title: 'Проверяю транзакцию',
 *     steps: [
 *       { label: 'Подключаюсь к блокчейну', pct: 20 },
 *       { label: 'Ищу транзакцию',         pct: 55 },
 *       { label: 'Проверяю сумму',         pct: 85 },
 *     ],
 *     intervalMs: 1200,
 *   });
 *
 *   // ... делаем реальную работу ...
 *   await stopProgress(progress, '✅ Транзакция найдена!');
 *
 * Helper сам рисует бар, меняет шаги и останавливается при stop/ошибке.
 * Если Telegram не смог отредактировать — молча игнорирует.
 */

const barOf = (pct) => {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
};

/**
 * @typedef {Object} ProgressStep
 * @property {string} label Подпись шага (обычно глагол + существительное)
 * @property {number} pct   Целевой процент после этого шага (0-100)
 */

/**
 * @typedef {Object} ProgressHandle
 * @property {number} messageId ID сообщения с прогрессом
 * @property {number} chatId    ID чата
 * @property {Function} stop    Остановить и отрисовать финальный текст
 * @property {Function} fail    Остановить и отрисовать ошибку
 */

/**
 * Запускает анимированный прогресс. Возвращает handle для остановки.
 */
const startProgress = async (ctx, opts = {}) => {
  const {
    title = '⏳ Выполняется...',
    steps = [
      { label: 'Подготовка', pct: 25 },
      { label: 'Обработка',  pct: 60 },
      { label: 'Завершение', pct: 90 },
    ],
    intervalMs = 1200,
    editMessageId = null,
  } = opts;

  const chatId = ctx.chat?.id || ctx.from?.id;
  if (!chatId) return null;

  let messageId = editMessageId;

  const renderText = (pct, label, dots = '') =>
    `${title}\n<blockquote>${barOf(pct)} ${pct}%  ${label}${dots}</blockquote>`;

  // Первый рендер (0%) — либо edit, либо reply.
  const initial = renderText(0, steps[0]?.label || 'Запускаю');
  try {
    if (messageId) {
      await ctx.telegram.editMessageText(chatId, messageId, null, initial, { parse_mode: 'HTML' });
    } else {
      const sent = await ctx.reply(initial, { parse_mode: 'HTML' });
      messageId = sent?.message_id;
    }
  } catch (_) {
    // В худшем случае просто не покажем прогресс — это не должно ронять основной flow.
    return null;
  }

  let stopped = false;
  let stepIdx = 0;
  let dotCount = 0;

  const interval = setInterval(() => {
    if (stopped) return;
    const step = steps[Math.min(stepIdx, steps.length - 1)];
    dotCount = (dotCount + 1) % 4;
    const dots = '.'.repeat(dotCount);

    ctx.telegram.editMessageText(
      chatId,
      messageId,
      null,
      renderText(step.pct, step.label, dots),
      { parse_mode: 'HTML' }
    ).catch(() => {});

    // Переходим к следующему шагу после 3 "тиков" — создаёт ощущение прогресса.
    if (dotCount === 3 && stepIdx < steps.length - 1) {
      stepIdx += 1;
    }
  }, intervalMs);

  const finalize = async (text) => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (messageId) {
      await ctx.telegram.editMessageText(chatId, messageId, null, text, { parse_mode: 'HTML' })
        .catch(() => {});
    }
  };

  return {
    messageId,
    chatId,
    stop: (finalText) => finalize(finalText),
    fail: (errorText) => finalize(errorText),
  };
};

/**
 * Остановить прогресс с финальным текстом. Безопасно вызывать с null handle.
 */
const stopProgress = async (handle, finalText) => {
  if (!handle) return;
  return handle.stop(finalText);
};

module.exports = {
  startProgress,
  stopProgress,
  barOf,
};

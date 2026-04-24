/**
 * Централизованные константы UX-бота.
 * Единая точка правды по эмодзи статусов, лейблам и текстам.
 * Если нужно поменять «✅» → «✔️» — меняется только здесь.
 */

// ─── Эмодзи для статусов и действий ──────────────────────────────────────────
const EMOJI = {
  // Статусы процессов
  WAITING:    '⏳',
  PROCESSING: '⚙️',
  LOADING:    '🔄',
  DONE:       '✅',
  FAILED:     '❌',
  ERROR:      '💥',
  WARNING:    '⚠️',
  INFO:       'ℹ️',

  // Статусы заказов
  PENDING:       '⏳',
  AWAITING_KEY:  '🔑',
  REVIEWING:     '👁',
  ACTIVATING:    '⚙️',
  COMPLETED:     '✅',
  CANCELLED:     '❌',
  FAILED_ORDER:  '💔',
  RETRY:         '🔄',

  // Сущности
  MONEY:     '💰',
  BALANCE:   '💳',
  USER:      '👤',
  PRODUCT:   '📦',
  KEY:       '🔑',
  ORDER:     '📋',
  REFERRAL:  '🔗',
  STAR:      '⭐',
  FIRE:      '🔥',
  TROPHY:    '🏆',

  // Навигация
  BACK:      '⬅️',
  FORWARD:   '➡️',
  HOME:      '🏠',
  SETTINGS:  '⚙️',
  SUPPORT:   '🆘',

  // Уведомления
  BELL:      '🔔',
  MAIL:      '📨',
  EMPTY:     '📭',
  GIFT:      '🎁',

  // Финансовые
  PLUS:      '➕',
  MINUS:     '➖',
  CHART:     '📈',
};

// ─── Лейблы статусов заказа ──────────────────────────────────────────────────
const ORDER_STATUS_LABELS = {
  pending:               `${EMOJI.PENDING} Ожидает`,
  awaiting_token:        `${EMOJI.AWAITING_KEY} Ожидает токен`,
  awaiting_confirmation: `${EMOJI.REVIEWING} На проверке`,
  activating:            `${EMOJI.ACTIVATING} Активируется`,
  completed:             `${EMOJI.COMPLETED} Выполнен`,
  cancelled:             `${EMOJI.CANCELLED} Отменён`,
  failed:                `${EMOJI.FAILED_ORDER} Ошибка`,
  retry:                 `${EMOJI.RETRY} Повторная попытка`,
};

// ─── Статусы заявок на пополнение ────────────────────────────────────────────
const TOPUP_STATUS_LABELS = {
  pending:   `${EMOJI.PENDING} Ожидает`,
  confirmed: `${EMOJI.COMPLETED} Подтверждена`,
  rejected:  `${EMOJI.CANCELLED} Отклонена`,
};

// ─── Универсальные тексты ────────────────────────────────────────────────────
const TEXTS = {
  COPY_HINT:        '💡 <i>Нажмите на значение — оно скопируется.</i>',
  SUPPORT_URL:      'https://t.me/Tigrano_o',
  BACK_TO_MENU:     `${EMOJI.BACK} В главное меню`,
  BACK:             `${EMOJI.BACK} Назад`,
  RETRY:            `${EMOJI.RETRY} Попробовать снова`,
  CONTACT_SUPPORT:  `${EMOJI.SUPPORT} Поддержка`,
  CANCEL:           `${EMOJI.FAILED} Отмена`,
  CONFIRM:          `${EMOJI.COMPLETED} Подтвердить`,
};

// ─── Тайминги SLA (используются для честных обещаний пользователю) ──────────
// Формат: строка сразу готовая для показа пользователю.
const SLA = {
  CARD_MANUAL_REVIEW: '5–10 минут',
  CRYPTO_AUTO:        'до 15 секунд',
  CRYPTO_MANUAL:      '5–10 минут',
  ACTIVATION:         '10–30 секунд',
  RETRY_DELAY:        '5 минут',
};

module.exports = {
  EMOJI,
  ORDER_STATUS_LABELS,
  TOPUP_STATUS_LABELS,
  TEXTS,
  SLA,
};

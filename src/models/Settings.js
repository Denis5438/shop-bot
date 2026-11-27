const mongoose = require('mongoose');
const { PREFIX, encryptSecret, decryptSecret } = require('../services/secretBox.service');

const secretGetter = (val) => {
  if (typeof val === 'string' && val.startsWith(PREFIX)) {
    return decryptSecret(val);
  }
  return val;
};

const secretSetter = (val) => {
  if (typeof val === 'string' && val.trim() !== '') {
    return encryptSecret(val);
  }
  return val;
};

const settingsSchema = new mongoose.Schema({
  name: { type: String, default: 'global', unique: true },
  maintenanceMode: { type: Boolean, default: false },
  topupWallet: { type: String, default: '' },
  topupNetwork: { type: String, default: 'TRC-20 (TRON)' },
  minTopup: { type: Number, default: 1 },
  referralBonus: { type: Number, default: 0.5 },
  smartPricing: { type: Boolean, default: false },
  geminiApiKey: { type: String, default: '', get: secretGetter, set: secretSetter },
  smartPricingPreset: { type: String, default: 'gemini_ai' },
  // Умная уценка
  autoMarkdownEnabled: { type: Boolean, default: false },
  autoMarkdownDays: { type: Number, default: 3 },
  autoMarkdownPercent: { type: Number, default: 5 },
  // Реквизиты карты
  cardNumber: { type: String, default: '', get: secretGetter, set: secretSetter },
  cardHolder: { type: String, default: '', get: secretGetter, set: secretSetter },
  // Bybit адреса и API ключи
  bybitTrc20Address: { type: String, default: '' },
  bybitBep20Address: { type: String, default: '' },
  bybitUid: { type: String, default: '' },
  bybitApiKey: { type: String, default: '', get: secretGetter, set: secretSetter },
  bybitApiSecret: { type: String, default: '', get: secretGetter, set: secretSetter },
  // #17 Admin digest: если включён - обычные уведомления агрегируются
  // в почасовую сводку, критичные уходят сразу как раньше.
  adminDigestEnabled: { type: Boolean, default: false },
  adminDigestIntervalMinutes: { type: Number, default: 60 },
  // Продавцы
  minSellerWithdraw: { type: Number, default: 5 },
  autoConfirmHours: { type: Number, default: 24 },
  // Обязательная подписка на каналы
  requiredChannelsEnabled: { type: Boolean, default: false },
  // Способы оплаты в Telegram-боте (Вкл / Выкл)
  plategaEnabled: { type: Boolean, default: true },
  plategaMerchantId: { type: String, default: '', get: secretGetter, set: secretSetter },
  plategaSecret: { type: String, default: '', get: secretGetter, set: secretSetter },
  cardEnabled: { type: Boolean, default: true },
  bybitEnabled: { type: Boolean, default: true },
  // Независимые настройки веб-витрины (отдельно от Telegram-бота)
  webMaintenanceMode: { type: Boolean, default: false },
  webPlategaEnabled: { type: Boolean, default: true },
  webBybitUidEnabled: { type: Boolean, default: true },
  webCryptoTrc20Enabled: { type: Boolean, default: true },
  webCryptoBep20Enabled: { type: Boolean, default: true },
  webCryptoTonEnabled: { type: Boolean, default: true },
  tonAddress: { type: String, default: '' },
  // Чистый чат (автоудаление старых сообщений бота)
  cleanChatEnabled: { type: Boolean, default: false },
  // Награды за достижения (купоны на скидку)
  achievementRewardsEnabled: { type: Boolean, default: false },
  // Курс валют (Bybit P2P vs Ручной + наценка)
  currencyMode: { type: String, enum: ['bybit_p2p', 'manual'], default: 'bybit_p2p' },
  manualRate: { type: Number, default: 95 },
  currencyOffset: { type: Number, default: 0 },
  // Стиль кнопок витрины каталога ('rich' - внутри сообщения, 'classic' - стандартные telegraf)
  catalogButtonsStyle: { type: String, enum: ['rich', 'classic'], default: 'rich' },
  // Глобальный режим формата кнопок ('by_user' - выбор юзера, 'force_rich' - принудительно rich, 'force_classic' - принудительно снизу)
  globalButtonsMode: { type: String, enum: ['by_user', 'force_rich', 'force_classic'], default: 'by_user' },
  // Формат кнопок по умолчанию для новых пользователей
  defaultButtonLayout: { type: String, enum: ['rich', 'classic'], default: 'rich' },
  // Настройки системы поддержки (саппорты и тикеты)
  supportChatId: { type: Number, default: null },
  supportChatTitle: { type: String, default: '' },
  supportMaxOpenPerUser: { type: Number, default: 3 },
  supportSlaMinutes: { type: Number, default: 15 },
  supportAutoCloseHours: { type: Number, default: 48 },
  supportQuickReplies: {
    type: [String],
    default: () => [
      'Здравствуйте! Уже проверяем ваш вопрос, скоро вернёмся с ответом.',
      'Пожалуйста, отправьте номер заказа или скриншот оплаты для проверки.',
      'Проблема решена, проверьте, пожалуйста. Если всё в порядке — можете закрыть обращение.',
      'Передаю ваш вопрос старшему специалисту, он свяжется с вами в ближайшее время.',
    ],
  },
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true },
});

module.exports = mongoose.model('Settings', settingsSchema);

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  name: { type: String, default: 'global', unique: true },
  maintenanceMode: { type: Boolean, default: false },
  topupWallet: { type: String, default: '' },
  topupNetwork: { type: String, default: 'TRC-20 (TRON)' },
  minTopup: { type: Number, default: 1 },
  referralBonus: { type: Number, default: 0.5 },
  smartPricing: { type: Boolean, default: false },
  // Умная уценка
  autoMarkdownEnabled: { type: Boolean, default: false },
  autoMarkdownDays: { type: Number, default: 3 },
  autoMarkdownPercent: { type: Number, default: 5 },
  // Реквизиты карты
  cardNumber: { type: String, default: '' },
  cardHolder: { type: String, default: '' },
  // Bybit адреса
  bybitTrc20Address: { type: String, default: '' },
  bybitBep20Address: { type: String, default: '' },
  bybitUid: { type: String, default: '' },
  // #17 Admin digest: если включён — обычные уведомления агрегируются
  // в почасовую сводку, критичные уходят сразу как раньше.
  adminDigestEnabled: { type: Boolean, default: false },
  adminDigestIntervalMinutes: { type: Number, default: 60 },
}, {
  timestamps: true
});

module.exports = mongoose.model('Settings', settingsSchema);

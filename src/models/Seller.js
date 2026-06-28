const mongoose = require('mongoose');

const sellerSchema = new mongoose.Schema({
  // Telegram ID продавца (если зарегистрирован в боте)
  telegramId: { type: Number, default: null },
  // @username без @ (для поиска и уведомлений)
  username: { type: String, required: true, unique: true },
  // Отображаемое имя
  displayName: { type: String, default: '' },

  // Крипто-кошелёк для вывода (любая сеть — строкой)
  walletAddress: { type: String, default: null },
  walletNetwork: { type: String, default: null }, // TRC-20, BEP-20, APTOS, SOL ...

  // Баланс и статистика
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },

  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

sellerSchema.index({ telegramId: 1 }, { sparse: true });

module.exports = mongoose.model('Seller', sellerSchema);

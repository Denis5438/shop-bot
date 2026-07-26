const mongoose = require('mongoose');

const sellerSchema = new mongoose.Schema({
  // Telegram ID продавца (если зарегистрирован в боте)
  telegramId: { type: Number, default: null },
  // @username без @ (для поиска и уведомлений)
  username: { type: String, required: true, unique: true },
  // Отображаемое имя
  displayName: { type: String, default: '' },

  // Крипто-кошелёк для вывода (любая сеть - строкой)
  walletAddress: { type: String, default: null },
  walletNetwork: { type: String, default: null }, // TRC-20, BEP-20, APTOS, SOL ...

  // Баланс и статистика
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },

  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },

  // Заявка на привязку аккаунта (защита от захвата по username):
  // продавец, добавленный админом по нику, привязывается к telegramId только
  // после подтверждения админом. Раньше первый зашедший с таким username
  // получал аккаунт (и баланс) автоматически.
  claimTelegramId: { type: Number, default: null },
  claimUsername: { type: String, default: null },
  claimRequestedAt: { type: Date, default: null },
});

sellerSchema.index({ telegramId: 1 }, { sparse: true });

module.exports = mongoose.model('Seller', sellerSchema);

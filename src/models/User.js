const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: { type: String, default: null },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  language: { type: String, enum: ['ru', 'en'], default: 'ru' },
  balance: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  referralCode: { type: String, unique: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referralBonusGrantedAt: { type: Date, default: null },
  totalSpent: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  takeoverBy: { type: Number, default: null },
  takeoverAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },

  // №20 Достижения: массив ID разблокированных ачивок и дата получения.
  // Ключ ачивки — строковый код из achievements.service.js (например "first_purchase").
  // Денормализуем как массив объектов, чтобы иметь дату получения без отдельной коллекции.
  achievements: [{
    code: { type: String, required: true },
    unlockedAt: { type: Date, default: Date.now },
    _id: false,
  }],

  // Привязка Bybit UID к конкретному аккаунту (защита от impersonation):
  // первый успешный топап по UID закрепляет UID за юзером. Последующие
  // попытки заявить тот же UID от другого аккаунта блокируются на уровне
  // приложения + sparse unique index ниже.
  bybitUid: {
    type: String,
    default: undefined,
    set: (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
  },
});

// Sparse unique: null/undefined допускают много юзеров без UID, но если
// UID задан — он уникален на всю коллекцию.
userSchema.index(
  { bybitUid: 1 },
  {
    unique: true,
    partialFilterExpression: { bybitUid: { $type: 'string' } },
    name: 'bybitUid_string_unique',
  }
);

userSchema.pre('save', function (next) {
  if (!this.referralCode) {
    this.referralCode = Math.random().toString(36).substr(2, 8).toUpperCase();
  }
  next();
});

module.exports = mongoose.model('User', userSchema);

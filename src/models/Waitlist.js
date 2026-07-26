const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  createdAt: { type: Date, default: Date.now },
});

// Уникальный индекс, чтобы пользователь не подписался дважды на один товар
waitlistSchema.index({ userId: 1, productId: 1 }, { unique: true });
// Уведомления о поступлении ищут подписчиков по товару - составной индекс
// выше по префиксу userId здесь не работает
waitlistSchema.index({ productId: 1 });

module.exports = mongoose.model('Waitlist', waitlistSchema);

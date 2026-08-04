const mongoose = require('mongoose');

const promoUsageSchema = new mongoose.Schema({
  promoId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  code: { type: String, required: true },
  type: { type: String, required: true },
  discountAmount: { type: Number, default: 0 },
  usedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PromoUsage', promoUsageSchema);

const mongoose = require('mongoose');

const promoUsageSchema = new mongoose.Schema({
  promoId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  usageNumber: { type: Number, default: null },
  code: { type: String, required: true },
  type: { type: String, required: true },
  discountAmount: { type: Number, default: 0 },
  usedAt: { type: Date, default: Date.now },
});

// A usage is created only after a successful purchase. The slot prevents two
// concurrent checkouts from consuming the same per-user allowance.
promoUsageSchema.index(
  { promoId: 1, userId: 1, usageNumber: 1 },
  { unique: true, partialFilterExpression: { usageNumber: { $type: 'number' } } }
);
promoUsageSchema.index({ promoId: 1, userId: 1, usedAt: -1 });

module.exports = mongoose.model('PromoUsage', promoUsageSchema);

const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ['balance', 'percent', 'fixed'], required: true },
  value: { type: Number, required: true },
  maxActivations: { type: Number, default: -1 },
  currentActivations: { type: Number, default: 0 },
  maxPerUser: { type: Number, default: 1 },
  minOrderAmount: { type: Number, default: 0 },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  minQuantity: { type: Number, default: 1 },
  discountTarget: { type: String, enum: ['all', 'second_item'], default: 'all' },
  audienceCondition: { type: String, enum: ['all', 'first_only', 'repeat_only'], default: 'all' },
  expiresAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PromoCode', promoCodeSchema);

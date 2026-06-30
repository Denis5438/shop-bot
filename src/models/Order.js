const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  provider: { type: String, enum: ['local', 'u1traby'], default: undefined },
  status: {
    type: String,
    enum: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'completed', 'cancelled', 'failed', 'retry', 'disputed'],
    default: 'pending',
  },
  price: { type: Number, required: true },
  qty: { type: Number, default: 1 },
  costPrice: { type: Number, default: 0 },
  keyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Key', default: null },
  tokenRaw: { type: String, default: null },
  apiOrderId: { type: String, default: null },
  activationResult: { type: String, default: null },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  confirmedAt: { type: Date, default: null },
  notes: { type: String, default: null },
  retryCount: { type: Number, default: 0 },
  nextRetryAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },

  // ─── Seller-система (Escrow & Disputes) ──────────────────────────────────
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', default: null },
  sellerPayout: { type: Number, default: 0 },
  sellerPaidAt: { type: Date, default: null },
  
  // Данные для Escrow/Спора
  deliveredAt: { type: Date, default: null },
  deliveryData: { type: String, default: null }, // Текст/ID файла, который выдал продавец
  disputeOpenedAt: { type: Date, default: null },
  disputeStatus: { type: String, enum: ['open', 'resolved'], default: 'open' },
});

orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ status: 1, nextRetryAt: 1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ sellerId: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);

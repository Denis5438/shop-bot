const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  provider: { type: String, enum: ['local', 'u1traby', 'jaha', 'toolsmarket', 'akunding', 'canboso'], default: undefined },
  status: {
    type: String,
    enum: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'completed', 'cancelled', 'failed', 'retry', 'disputed', 'preorder_pending'],
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

  // ─── Замены по гарантии ──────────────────────────────────────────────────
  warrantyDays: { type: Number, default: 5 },
  replacementStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
  replacementReason: { type: String, default: null },
  replacementRejectReason: { type: String, default: null },
  replacementMediaId: { type: String, default: null },
  replacementMediaType: { type: String, default: null },
  replacedKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Key', default: null },
  replacedAt: { type: Date, default: null },
});

orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ status: 1, nextRetryAt: 1 });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, status: 1 });
// Статистика и /admin считают выручку по {status:'completed', confirmedAt>=X}
orderSchema.index({ status: 1, confirmedAt: -1 });
// Счётчик заявок на замену по гарантии (только pending, поэтому partial)
orderSchema.index(
  { replacementStatus: 1 },
  { partialFilterExpression: { replacementStatus: 'pending' } }
);
// Крон авто-подтверждения: {status:'awaiting_confirmation', deliveredAt < cutoff}
orderSchema.index({ status: 1, deliveredAt: 1 });

module.exports = mongoose.model('Order', orderSchema);

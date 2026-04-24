const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  provider: { type: String, enum: ['local', 'u1traby', 'chatgptconnect'], default: undefined },
  status: {
    type: String,
    enum: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'completed', 'cancelled', 'failed', 'retry'],
    default: 'pending',
  },
  price: { type: Number, required: true },
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
});

orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ status: 1, nextRetryAt: 1 });
orderSchema.index({ userId: 1 });

module.exports = mongoose.model('Order', orderSchema);

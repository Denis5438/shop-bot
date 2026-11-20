const mongoose = require('mongoose');

const bybitInvoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, unique: true, required: true }, // e.g. "TOP-00001976" or "ORD-..."
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  qty: { type: Number, default: 1 },
  baseAmount: { type: Number, required: true }, // e.g. 15.00
  exactAmount: { type: Number, required: true }, // e.g. 15.0038
  suffix: {
    type: Number,
    required: true,
    set: (v) => {
      if (typeof v === 'number' && v > 0 && v < 1) {
        return Math.round(v * 10000);
      }
      return v;
    },
  }, // e.g. 38 (0.0038)
  adminUid: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'cancelled', 'expired'],
    default: 'pending',
  },
  lockedAt: {
    type: Date,
    default: null,
  },
  txId: {
    type: String,
    default: null,
  },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
});

// Indexes for fast lookup
bybitInvoiceSchema.index(
  { exactAmount: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'processing'] } } }
);
bybitInvoiceSchema.index({ status: 1, lockedAt: 1 });
bybitInvoiceSchema.index({ status: 1, expiresAt: 1 });
bybitInvoiceSchema.index({ userId: 1, createdAt: -1 });
bybitInvoiceSchema.index(
  { txId: 1 },
  { unique: true, partialFilterExpression: { txId: { $type: 'string' } } }
);

bybitInvoiceSchema.virtual('suffixFractional').get(function () {
  return this.suffix ? Number((this.suffix / 10000).toFixed(4)) : 0;
});

module.exports = mongoose.model('BybitInvoice', bybitInvoiceSchema);

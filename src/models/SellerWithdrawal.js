const mongoose = require('mongoose');

const sellerWithdrawalSchema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
  amount: { type: Number, required: true },
  walletAddress: { type: String, required: true },
  // Сеть хранится строкой — поддерживаем TRC-20, BEP-20, APTOS, SOL и др.
  network: { type: String, default: 'TRC-20' },
  status: {
    type: String,
    enum: ['pending', 'completed', 'rejected'],
    default: 'pending',
  },
  adminNote: { type: String, default: null },
  processedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

sellerWithdrawalSchema.index({ sellerId: 1, status: 1 });
sellerWithdrawalSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('SellerWithdrawal', sellerWithdrawalSchema);

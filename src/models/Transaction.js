const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['topup', 'purchase', 'refund', 'referral_bonus', 'manual_credit', 'manual_debit'],
    required: true,
  },
  amount: { type: Number, required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  topupRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'TopupRequest', default: null },
  description: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

// История операций пользователя (админка) и статистика по типам за период -
// раньше у коллекции не было ни одного индекса
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ topupRequestId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);

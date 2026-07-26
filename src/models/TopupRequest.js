const mongoose = require('mongoose');

const topupRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  method: { type: String, default: 'unknown' },
  network: { type: String, default: null },
  proofText: { type: String, default: null },
  proofFileId: { type: String, default: null },
  txid: {
    type: String,
    default: undefined,
    set: (value) => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed || undefined;
    },
  },
  // Адрес отправителя из блокчейна (для аудита и ручной проверки спорных заявок)
  fromAddress: { type: String, default: null },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  notes: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
});

topupRequestSchema.index(
  { txid: 1 },
  {
    unique: true,
    partialFilterExpression: {
      txid: { $type: 'string' },
    },
    name: 'txid_string_unique',
  }
);

// Список pending-заявок в админке и счётчик в /admin
topupRequestSchema.index({ status: 1, createdAt: 1 });
// Статистика по обработанным заявкам за период
topupRequestSchema.index({ status: 1, processedAt: -1 });

module.exports = mongoose.model('TopupRequest', topupRequestSchema);

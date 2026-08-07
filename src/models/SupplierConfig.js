const mongoose = require('mongoose');

const supplierConfigSchema = new mongoose.Schema({
  supplierId: {
    type: String,
    enum: ['jaha', 'toolsmarket', 'akunding', 'canboso'],
    required: true,
    unique: true,
  },
  title: { type: String, required: true },
  apiKey: { type: String, default: null },
  baseUrl: { type: String, default: null },
  isEnabled: { type: Boolean, default: true },
  marginPercent: { type: Number, default: 30 }, // Наценка в % (по умолчанию 30%)
  marginFixed: { type: Number, default: 0 },    // Фиксированная наценка в USDT
  cachedBalance: { type: Number, default: 0 },
  lastSyncAt: { type: Date, default: null },
  autoSyncEnabled: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SupplierConfig', supplierConfigSchema);

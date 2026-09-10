const mongoose = require('mongoose');

const supplierConfigSchema = new mongoose.Schema({
  supplierId: {
    type: String,
    enum: ['jaha', 'akunding', 'canboso', 'trumpstore'],
    required: true,
    unique: true,
  },
  title: { type: String, required: true },
  apiKey: { type: String, default: null },
  baseUrl: { type: String, default: null },
  isEnabled: { type: Boolean, default: true },
  marginPercent: { type: Number, default: 30 }, // Наценка в % (по умолчанию 30%)
  marginFixed: { type: Number, default: 0 },    // Фиксированная наценка в USDT
  smartPricingEnabled: { type: Boolean, default: false }, // Включена ли умная градуированная наценка
  smartPricingPreset: { type: String, enum: ['standard', 'high_profit', 'minimal', 'gemini_ai', 'custom'], default: 'standard' },
  pricingTiers: [{
    maxPrice: { type: Number, default: null }, // До какой оптовой цены (null = выше)
    marginPercent: { type: Number, default: 15 },
    marginFixed: { type: Number, default: 0 },
  }],
  cachedBalance: { type: Number, default: 0 },
  currentOnly: { type: Boolean, default: true }, // Фильтр товаров поставщика: только актуальные (true) или все (false)
  lastSyncAt: { type: Date, default: null },
  autoSyncEnabled: { type: Boolean, default: true },
  autoImportNewProducts: { type: Boolean, default: true },
  syncIntervalMinutes: { type: Number, default: 30 },
  // Уведомления поставщика
  notifyAdminOnSync: { type: Boolean, default: true },
  notifyUsersOnRestock: { type: Boolean, default: false },
  userNotificationChannel: { type: String, default: '' },
  userNotificationBroadcast: { type: Boolean, default: false },
  notifyMinRestockQty: { type: Number, default: 1 },
  // Гибкие настройки Gemini AI для этого поставщика
  geminiTargetDiscountPercent: { type: Number, default: 10 }, // Целевая скидка от оф. цены (например 10%)
  geminiMaxMarkupUsd: { type: Number, default: 15 },          // Потолок наценки на дорогие товары ($)
  geminiMinProfitUsd: { type: Number, default: 1.0 },         // Мин. чистая прибыль магазина ($)
  geminiStrategy: { type: String, enum: ['discount', 'balanced', 'margin'], default: 'balanced' },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SupplierConfig', supplierConfigSchema);

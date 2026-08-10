const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nameEn: { type: String, default: '' },
  description: { type: String, default: '' },
  descriptionEn: { type: String, default: '' },
  price: { type: Number, required: true },
  costPrice: { type: Number, default: 0 },
  icon: { type: String, default: '📦' },
  type: { type: String, enum: ['key', 'gpt_activation', 'manual'], default: 'key' },
  manualStock: { type: Number, default: -1 },
  provider: {
    type: String,
    enum: ['local', 'u1traby', 'jaha', 'akunding', 'canboso', 'trumpstore'],
    default() {
      return this.type === 'gpt_activation' ? 'u1traby' : 'local';
    },
  },
  supplierProductCode: { type: String, default: null },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  /**
   * Тип выдачи товара:
   *  - activation   -> пользователь активирует на своём аккаунте (нужен токен)
   *  - ready_account -> выдаётся готовый аккаунт/ключ из пула
   */
  deliveryMethod: {
    type: String,
    enum: ['activation', 'ready_account'],
    default: 'activation',
  },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastSoldAt: { type: Date, default: Date.now },
  lowStockNotifiedAt: { type: Date, default: null },
  warrantyDays: { type: Number, default: 5 },

  // ─── Seller-система ───────────────────────────────────────────────────────
  // Привязанный продавец (только для товаров типа manual)
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', default: null },
  // Сколько из цены продажи идёт продавцу (в USDT)
  sellerPrice: { type: Number, default: 0 },
});

// Магазин: товары категории с сортировкой; списки активных товаров в админке
productSchema.index({ categoryId: 1, isActive: 1, sortOrder: 1 });
productSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('Product', productSchema);

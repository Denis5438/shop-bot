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
  provider: {
    type: String,
    enum: ['local', 'u1traby', 'chatgptconnect'],
    default() {
      return this.type === 'gpt_activation' ? 'u1traby' : 'local';
    },
  },
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
});

module.exports = mongoose.model('Product', productSchema);

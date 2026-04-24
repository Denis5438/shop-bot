const mongoose = require('mongoose');

const keySchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  provider: { type: String, enum: ['local', 'u1traby', 'chatgptconnect'], default: 'local' },
  value: { type: String, required: true },
  isUsed: { type: Boolean, default: false },
  usedAt: { type: Date, default: null },
  usedByOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  createdAt: { type: Date, default: Date.now },
});

keySchema.index({ productId: 1, provider: 1, isUsed: 1 });

module.exports = mongoose.model('Key', keySchema);

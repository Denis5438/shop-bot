const mongoose = require('mongoose');

const exchangeRateSchema = new mongoose.Schema({
  base: { type: String, default: 'USD' },
  rub: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);

require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shopbot',
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean),
  REFERRAL_BONUS: parseFloat(process.env.REFERRAL_BONUS) || 0.5,
  MIN_TOPUP: parseFloat(process.env.MIN_TOPUP) || 1,
  ITEMS_PER_PAGE: parseInt(process.env.ITEMS_PER_PAGE) || 5,
  DEFAULT_ANALYTICS_CURRENCY: process.env.DEFAULT_ANALYTICS_CURRENCY || 'USDT',
  TOPUP_WALLET: process.env.TOPUP_WALLET || '',
  TOPUP_NETWORK: process.env.TOPUP_NETWORK || 'TRC-20 (TRON)',
  BYBIT_API_KEY: process.env.BYBIT_API_KEY || '',
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || '',
};

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
  // Dedicated key is recommended. BOT_TOKEN is a compatibility fallback so
  // existing deployments can start before the migration is configured.
  ORDER_TOKEN_ENCRYPTION_KEY: process.env.ORDER_TOKEN_ENCRYPTION_KEY || process.env.BOT_TOKEN || '',
  // Контракты токенов для проверки BEP-20 платежей (переопределяются через env)
  BSC_USDT_CONTRACT: (process.env.BSC_USDT_CONTRACT || '0x55d398326f99059ff775485246999027b3197955').toLowerCase(),
  BSC_BUSD_CONTRACT: (process.env.BSC_BUSD_CONTRACT || '0xe9e7cea3dedca5984780bafc599bd69add087d56').toLowerCase(),
};

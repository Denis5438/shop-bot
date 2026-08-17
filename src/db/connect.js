const mongoose = require('mongoose');
const logger = require('../config/logger');
const { MONGODB_URI } = require('../config');

const sanitizeMongoUri = (uri) => {
  if (!uri) return '[hidden]';

  try {
    const parsed = new URL(uri);
    const dbName = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.protocol}//${parsed.hostname}${dbName}`;
  } catch (_) {
    return '[hidden]';
  }
};

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      // Пул: дефолтные 100 соединений избыточны для одного процесса и могут
      // исчерпать лимит Atlas; 20 достаточно с запасом.
      maxPoolSize: 20,
      minPoolSize: 2,
      // При недоступности БД дефолтные 30 сек serverSelection означали, что
      // КАЖДЫЙ апдейт бота висит 30 сек - падаем быстро и идём в bot.catch.
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxIdleTimeMS: 60000,
    });
    logger.info(`MongoDB connected: ${sanitizeMongoUri(MONGODB_URI)}`);

    const Settings = require('../models/Settings');
    let settings = await Settings.findOne({ name: 'global' });

    if (!settings) {
      const config = require('../config');
      settings = new Settings({
        name: 'global',
        maintenanceMode: false,
        topupWallet: config.TOPUP_WALLET,
        topupNetwork: config.TOPUP_NETWORK,
        minTopup: config.MIN_TOPUP,
        referralBonus: config.REFERRAL_BONUS,
        smartPricing: false,
      });
      await settings.save();
    }

    global.MAINTENANCE_MODE = settings.maintenanceMode;
    logger.info(`Maintenance mode: ${global.MAINTENANCE_MODE ? 'enabled' : 'disabled'}`);

    const { invalidateCache } = require('../services/settingsCache.service');
    invalidateCache();

    // Синхронизируем индексы ВСЕХ моделей (раньше - только четырёх: User,
    // Transaction, Waitlist и Category оставались без индексов в production,
    // где autoIndex обычно выключен).
    const TopupRequest = require('../models/TopupRequest');
    const Product = require('../models/Product');
    const Key = require('../models/Key');
    const Order = require('../models/Order');
    const User = require('../models/User');
    const Transaction = require('../models/Transaction');
    const Waitlist = require('../models/Waitlist');
    const Category = require('../models/Category');
    const Seller = require('../models/Seller');
    const SellerWithdrawal = require('../models/SellerWithdrawal');
    const PromoCode = require('../models/PromoCode');
    const SupplierConfig = require('../models/SupplierConfig');
    const PromoUsage = require('../models/PromoUsage');
    const RequiredChannel = require('../models/RequiredChannel');
    const ExchangeRate = require('../models/ExchangeRate');
    // Ошибка построения индекса (например, дубликаты в данных под unique)
    // НЕ должна валить старт бота - логируем и продолжаем.
    try {
      await Promise.all([
        TopupRequest.syncIndexes(),
        Product.syncIndexes(),
        Key.syncIndexes(),
        Order.syncIndexes(),
        User.syncIndexes(),
        Transaction.syncIndexes(),
        Waitlist.syncIndexes(),
        Category.syncIndexes(),
        Seller.syncIndexes(),
        SellerWithdrawal.syncIndexes(),
        Settings.syncIndexes(),
        PromoCode.syncIndexes(),
        SupplierConfig.syncIndexes(),
        PromoUsage.syncIndexes(),
        RequiredChannel.syncIndexes(),
        ExchangeRate.syncIndexes(),
      ]);
      logger.info('Индексы моделей синхронизированы');
    } catch (idxErr) {
      logger.error(`Ошибка синхронизации индексов (бот продолжит работу): ${idxErr.message}`);
    }
    const staleTakeovers = await User.updateMany(
      { takeoverBy: { $ne: null } },
      { $set: { takeoverBy: null, takeoverAt: null } }
    );

    if (staleTakeovers.modifiedCount > 0) {
      logger.info(`Cleared stale takeover sessions: ${staleTakeovers.modifiedCount}`);
    }
  } catch (err) {
    logger.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;

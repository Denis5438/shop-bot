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
    await mongoose.connect(MONGODB_URI);
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

    const TopupRequest = require('../models/TopupRequest');
    const Product = require('../models/Product');
    const Key = require('../models/Key');
    const Order = require('../models/Order');
    await Promise.all([
      TopupRequest.syncIndexes(),
      Product.createIndexes(),
      Key.createIndexes(),
      Order.createIndexes(),
    ]);

    const User = require('../models/User');
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

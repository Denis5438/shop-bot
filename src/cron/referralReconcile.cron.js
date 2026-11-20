/**
 * Страховочный reconcile реферальных бонусов: раз в 10 минут проходит по
 * пользователям с реферером без выданного бонуса и пытается выдать его
 * (основная выдача происходит сразу при завершении заказа).
 * Вынесено из src/bot/index.js без изменения поведения.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const logger = require('../config/logger');
const { grantReferralBonusForFirstCompletedOrder } = require('../services/referral.service');

const INTERVAL_MS = 10 * 60_000;

/**
 * @returns {Promise<void>}
 */
const reconcileReferralBonuses = async () => {
  const BATCH_SIZE = 100;
  let lastId = null;

  let hasMore = true;
  while (hasMore) {
    const query = {
      referredBy: { $ne: null },
      referralBonusGrantedAt: null,
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    };

    const batch = await User.find(query)
      .sort({ _id: 1 })
      .select('_id')
      .limit(BATCH_SIZE)
      .lean();

    if (!batch.length) {
      hasMore = false;
      break;
    }

    for (const user of batch) {
      await grantReferralBonusForFirstCompletedOrder(user._id);
    }

    lastId = batch[batch.length - 1]._id;
    if (batch.length < BATCH_SIZE) {
      hasMore = false;
    }
  }
};

/**
 * @returns {NodeJS.Timeout} handle интервала
 */
const start = () => {
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (mongoose.connection.readyState !== 1) return;
      await reconcileReferralBonuses();
    } catch (err) {
      logger.error(`Ошибка reconcile реферальных бонусов: ${err.message}`);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = { start, reconcileReferralBonuses };

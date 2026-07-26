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
 * @returns {NodeJS.Timeout} handle интервала
 */
const start = () => {
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (mongoose.connection.readyState !== 1) return;

      // Курсор по ВСЕМ кандидатам (запрос покрыт индексом referredBy+
      // referralBonusGrantedAt). limit здесь недопустим: «вечные» кандидаты
      // без покупок стабильно занимали бы первые позиции и новые пользователи
      // никогда не попадали бы в выборку.
      const cursor = User.find({
        referredBy: { $ne: null },
        referralBonusGrantedAt: null,
      })
        .select('_id')
        .lean()
        .cursor();

      for await (const user of cursor) {
        await grantReferralBonusForFirstCompletedOrder(user._id);
      }
    } catch (err) {
      logger.error(`Ошибка reconcile реферальных бонусов: ${err.message}`);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = { start };

/**
 * refund.service.js
 *
 * Единая точка «закрыть заказ + вернуть деньги покупателю».
 * Атомарный захват заказа (условие статуса прямо в фильтре findOneAndUpdate)
 * гарантирует, что возврат выполнится максимум один раз, даже при гонках
 * крона и ручных действий. Всё - внутри withTransaction (на replica set
 * шаги атомарны; на standalone выполняются по одному, но захват заказа
 * всё равно защищает от двойного возврата).
 *
 * Вынесено из src/bot/index.js (там жило как failOrderWithRefund) без
 * изменения поведения.
 */

const Order = require('../models/Order');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Key = require('../models/Key');
const { withTransaction } = require('./transactionHelper.service');

/**
 * Атомарно закрывает заказ и возвращает деньги покупателю.
 *
 * @param {Object} params
 * @param {string|Object} params.orderId       - id заказа
 * @param {Object}        params.statusFilter  - условие по статусу для захвата,
 *   например { $nin: ['completed','cancelled','failed'] } или 'awaiting_token'
 * @param {string}        params.newStatus     - конечный статус ('failed'/'cancelled')
 * @param {string}        params.activationResult - текст причины в заказ
 * @param {string}        params.txDescription - описание проводки Transaction
 * @returns {{ order: Object|null, user: Object|null }} захваченный заказ и
 *   пользователь с обновлённым балансом (null, если заказ уже был обработан)
 */
const refundAndCloseOrder = async ({ orderId, statusFilter, newStatus, activationResult, txDescription }) => {
  let order = null;
  let user = null;

  await withTransaction(async (session) => {
    const sessionOptions = session ? { session } : undefined;

    order = await Order.findOneAndUpdate(
      { _id: orderId, status: statusFilter },
      {
        $set: {
          status: newStatus,
          activationResult,
          nextRetryAt: null,
        },
      },
      { new: true, ...(sessionOptions || {}) }
    );

    if (!order) return;

    // Атомарный $inc: не теряет параллельные изменения баланса
    user = await User.findOneAndUpdate(
      { _id: order.userId },
      { $inc: { balance: order.price } },
      { new: true, ...(sessionOptions || {}) }
    );

    await new Transaction({
      userId: order.userId,
      type: 'refund',
      amount: order.price,
      orderId: order._id,
      description: txDescription,
    }).save(sessionOptions);

    await Key.updateOne(
      { usedByOrder: order._id },
      { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
      sessionOptions
    );
  });

  // Сброс кэша middleware - возврат должен быть виден пользователю сразу
  if (user) {
    try {
      require('../bot/middlewares/user').invalidateUserCache(user.telegramId);
    } catch (_) { /* middleware может быть не инициализирован в тестах */ }
  }

  return { order, user };
};

/**
 * Провалить заказ с возвратом средств (прежний failOrderWithRefund из bot/index.js).
 * Захватывает заказ в любом нетерминальном статусе.
 */
const failOrderWithRefund = async (orderId, reason, txDescription) => {
  const { order, user } = await refundAndCloseOrder({
    orderId,
    statusFilter: { $nin: ['completed', 'cancelled', 'failed'] },
    newStatus: 'failed',
    activationResult: reason,
    txDescription,
  });
  return { cancelledOrder: order, user };
};

module.exports = { refundAndCloseOrder, failOrderWithRefund };

const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');

/**
 * Сброс всех балансов пользователей до 0.00 USDT
 */
const resetAllBalances = async () => {
  const res = await User.updateMany({ balance: { $gt: 0 } }, { $set: { balance: 0 } });
  return res.modifiedCount || 0;
};

/**
 * Начисление баланса всем пользователям
 */
const grantBalanceToAll = async (amount) => {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Некорректная сумма');
  }

  const users = await User.find({ isBanned: false }).select('_id telegramId').lean();
  if (users.length === 0) return 0;

  // Атомарно начисляем баланс
  await User.updateMany({ isBanned: false }, { $inc: { balance: numAmount } });

  // Создаем записи транзакций для каждого
  const txs = users.map((u) => ({
    userId: u._id,
    type: 'deposit',
    amount: numAmount,
    status: 'completed',
    details: 'Массовое начисление администратором',
    createdAt: new Date(),
  }));

  if (txs.length > 0) {
    await Transaction.insertMany(txs).catch(() => {});
  }

  return users.length;
};

/**
 * Массовое добавление гарантии ко всем заказам
 */
const bulkAddWarranty = async (daysDelta, productId = null) => {
  const query = {};
  if (productId) query.productId = productId;

  const res = await Order.updateMany(query, { $inc: { warrantyDays: daysDelta } });
  return res.modifiedCount || 0;
};

/**
 * Массовое обнуление гарантии у всех заказов
 */
const bulkResetWarranty = async (productId = null) => {
  const query = {};
  if (productId) query.productId = productId;

  const res = await Order.updateMany(query, { $set: { warrantyDays: 0 } });
  return res.modifiedCount || 0;
};

module.exports = {
  resetAllBalances,
  grantBalanceToAll,
  bulkAddWarranty,
  bulkResetWarranty,
};

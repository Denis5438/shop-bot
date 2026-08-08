const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const Product = require('../models/Product');
const Category = require('../models/Category');

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

/**
 * Очистка всей логистики (заказы и транзакции)
 */
const deleteAllLogistics = async () => {
  const oRes = await Order.deleteMany({});
  const tRes = await Transaction.deleteMany({});
  return { orders: oRes.deletedCount, transactions: tRes.deletedCount };
};

/**
 * Удаление всех товаров
 */
const deleteAllProducts = async () => {
  const res = await Product.deleteMany({});
  return res.deletedCount;
};

/**
 * Удаление всех категорий
 */
const deleteAllCategories = async () => {
  const res = await Category.deleteMany({});
  return res.deletedCount;
};

/**
 * Скрыть все товары (isActive: false)
 */
const hideAllProducts = async () => {
  const res = await Product.updateMany({}, { $set: { isActive: false } });
  return res.modifiedCount;
};

/**
 * Скрыть все категории (isActive: false)
 */
const hideAllCategories = async () => {
  const res = await Category.updateMany({}, { $set: { isActive: false } });
  return res.modifiedCount;
};

module.exports = {
  resetAllBalances,
  grantBalanceToAll,
  bulkAddWarranty,
  bulkResetWarranty,
  deleteAllLogistics,
  deleteAllProducts,
  deleteAllCategories,
  hideAllProducts,
  hideAllCategories,
};

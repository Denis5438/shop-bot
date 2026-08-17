/**
 * transactionHelper.service.js
 *
 * Обёртка для MongoDB-транзакций.
 * Денежные операции не имеют безопасного fallback без транзакции: если БД
 * standalone, операция отклоняется до выполнения callback.
 */

const mongoose = require('mongoose');
const logger = require('../config/logger');

let transactionsAvailable = null; // unknown until first attempt

/**
 * Выполняет callback внутри MongoDB-транзакции.
 *
 * @param {Function} fn - async функция, принимающая (session)
 * @returns {Promise<*>} результат fn
 */
const withTransaction = async (fn) => {
  // Не разрешаем незаметно выполнять финансовый callback без транзакции.
  if (transactionsAvailable === false) {
    const error = new Error('TRANSACTIONS_REQUIRED');
    error.code = 'TRANSACTIONS_REQUIRED';
    throw error;
  }

  const session = await mongoose.startSession();
  let sessionEnded = false;

  try {
    const result = await session.withTransaction(fn);
    transactionsAvailable = true;
    return result;
  } catch (err) {
    // Ошибка "Transaction numbers are only allowed on a replica set"
    if (
      err.message?.includes('replica set') ||
      err.message?.includes('Transaction numbers') ||
      err.codeName === 'OperationNotSupportedInTransaction' ||
      err.code === 20
    ) {
      if (transactionsAvailable !== false) {
        logger.error('[TransactionHelper] MongoDB не поддерживает транзакции. Денежные операции заблокированы.');
        transactionsAvailable = false;
        // Это серьёзное снижение гарантий для ВСЕХ денежных операций - молчать
        // об этом нельзя. Шлём алерт админам (лениво, чтобы избежать циклического
        // require notification.service ↔ transactionHelper).
        try {
          const notif = require('./notification.service');
          notif.sendToAdmins(
            '🚨 <b>Денежные операции заблокированы</b>\n\n' +
            'MongoDB работает без replica set, поэтому финансовые транзакции недоступны.\n\n' +
            'Переведите базу в режим replica set или MongoDB Atlas и перезапустите бота.'
          ).catch(() => {});
        } catch (_) { /* notification service ещё не инициализирован */ }
      }
      try { await session.endSession(); } catch (_) {}
      sessionEnded = true;
      const transactionError = new Error('TRANSACTIONS_REQUIRED');
      transactionError.code = 'TRANSACTIONS_REQUIRED';
      throw transactionError;
    }
    throw err;
  } finally {
    if (!sessionEnded) {
      try { await session.endSession(); } catch (_) {}
    }
  }
};

module.exports = { withTransaction };

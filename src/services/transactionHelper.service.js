/**
 * transactionHelper.service.js
 *
 * Обёртка для MongoDB-транзакций с graceful fallback.
 * Если БД — standalone (не replica set), транзакции недоступны —
 * выполняем операции без транзакции, логируя предупреждение.
 */

const mongoose = require('mongoose');
const logger = require('../config/logger');

let transactionsAvailable = null; // unknown until first attempt

/**
 * Выполняет callback внутри MongoDB-транзакции.
 * Если транзакции недоступны (standalone MongoDB) — выполняет без транзакции.
 *
 * @param {Function} fn - async функция, принимающая (session)
 * @returns {Promise<*>} результат fn
 */
const withTransaction = async (fn) => {
  // Если уже знаем, что транзакции не работают — сразу без сессии
  if (transactionsAvailable === false) {
    return await fn(null);
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
        logger.warn('[TransactionHelper] Транзакции недоступны (standalone MongoDB). Операции выполняются без транзакций.');
        transactionsAvailable = false;
      }
      try { await session.endSession(); } catch (_) {}
      sessionEnded = true;
      // Выполняем без сессии
      return await fn(null);
    }
    throw err;
  } finally {
    if (!sessionEnded) {
      try { await session.endSession(); } catch (_) {}
    }
  }
};

module.exports = { withTransaction };

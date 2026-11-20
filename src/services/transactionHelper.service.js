/**
 * transactionHelper.service.js
 *
 * Обёртка для MongoDB-транзакций.
 * При работе с Replica Set операции выполняются атомарно внутри сессии транзакции.
 * Если MongoDB работает в standalone-режиме (без Replica Set), выполняется
 * плавный CAS-fallback с передачей null в качестве session, опираясь на атомарность
 * отдельных документов (findOneAndUpdate / $inc).
 */

const mongoose = require('mongoose');
const logger = require('../config/logger');

let transactionsAvailable = null; // unknown until first attempt

const isReplicaSetError = (err) => {
  if (!err) return false;
  return Boolean(
    err.message?.includes('replica set') ||
    err.message?.includes('Transaction numbers') ||
    err.message?.includes('transactions are not supported') ||
    err.message?.includes('buffering timed out') ||
    err.codeName === 'OperationNotSupportedInTransaction' ||
    err.code === 20
  );
};

/**
 * Выполняет callback внутри MongoDB-транзакции.
 * При отсутствии поддержки транзакций переключается на CAS-fallback (session = null).
 *
 * @param {Function} fn - async функция, принимающая (session)
 * @returns {Promise<*>} результат fn
 */
const withTransaction = async (fn) => {
  if (transactionsAvailable === false) {
    return await fn(null);
  }

  let session;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    if (isReplicaSetError(err)) {
      if (transactionsAvailable !== false) {
        logger.warn('[TransactionHelper] MongoDB работает в standalone-режиме (без Replica Set). Используется последовательный CAS-fallback.');
        transactionsAvailable = false;
      }
      return await fn(null);
    }
    throw err;
  }

  let sessionEnded = false;

  try {
    const result = await session.withTransaction(fn);
    transactionsAvailable = true;
    return result;
  } catch (err) {
    // Ошибка отсутствия Replica Set
    if (isReplicaSetError(err)) {
      if (transactionsAvailable !== false) {
        logger.warn('[TransactionHelper] MongoDB не поддерживает транзакции (standalone). Переключение на последовательный CAS-fallback.');
        transactionsAvailable = false;
      }
      try {
        await session.endSession();
      } catch (_) {}
      sessionEnded = true;
      return await fn(null);
    }
    throw err;
  } finally {
    if (!sessionEnded && session) {
      try {
        await session.endSession();
      } catch (_) {}
    }
  }
};

const _setTransactionsAvailable = (val) => {
  transactionsAvailable = val;
};

module.exports = {
  withTransaction,
  _setTransactionsAvailable,
};

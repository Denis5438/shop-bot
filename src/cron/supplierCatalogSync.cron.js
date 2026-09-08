/**
 * supplierCatalogSync.cron.js
 * Автоматический фоновый опрос каталогов внешних поставщиков (Jaha, Akunding и др.)
 * Запускается каждые 30 минут, обновляет остатки и автоматически импортирует новинки
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const logger = require('../config/logger');
const supplierLiveSync = require('../services/supplierLiveSync.service');

let isBusy = false;

const runSyncJob = async () => {
  if (isBusy) return;
  if (mongoose.connection.readyState !== 1) return;

  isBusy = true;
  try {
    logger.info('[SupplierSyncCron] Запуск автоматической синхронизации каталогов поставщиков...');
    const results = await supplierLiveSync.syncAllSuppliers();
    logger.info(`[SupplierSyncCron] Синхронизация завершена. Обработано поставщиков: ${results.length}`);
  } catch (err) {
    logger.error(`[SupplierSyncCron] Ошибка при авто-синхронизации поставщиков: ${err.message}`);
  } finally {
    isBusy = false;
  }
};

/**
 * Инициализация cron задачи
 * @returns {cron.ScheduledTask}
 */
const init = () => {
  // Запуск каждые 30 минут
  const task = cron.schedule('*/30 * * * *', async () => {
    await runSyncJob();
  });

  // Отложенный старт первой синхронизации через 30 секунд после старта бота
  setTimeout(() => {
    runSyncJob().catch((err) => {
      logger.warn(`[SupplierSyncCron] Ошибка первого запуска: ${err.message}`);
    });
  }, 30 * 1000);

  return task;
};

module.exports = {
  init,
  runSyncJob,
};

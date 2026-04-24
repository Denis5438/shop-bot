/**
 * settingsCache.service.js
 *
 * In-memory кеш настроек с TTL 60 сек.
 * Заменяет частые Settings.findOne() на быстрый возврат из памяти.
 */

const Settings = require('../models/Settings');

const CACHE_TTL = 60_000; // 60 секунд

let cachedSettings = null;
let cachedAt = 0;

/**
 * Возвращает глобальные настройки из кеша (или из БД при истечении TTL).
 * Всегда возвращает plain object (lean).
 */
const getSettings = async () => {
  const now = Date.now();

  if (cachedSettings && (now - cachedAt) < CACHE_TTL) {
    return cachedSettings;
  }

  const settings = await Settings.findOne({ name: 'global' }).lean();
  cachedSettings = settings || {};
  cachedAt = now;

  return cachedSettings;
};

/**
 * Принудительно сбрасывает кеш (вызвать после редактирования настроек админом).
 */
const invalidateCache = () => {
  cachedSettings = null;
  cachedAt = 0;
};

module.exports = { getSettings, invalidateCache };

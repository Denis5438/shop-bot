/**
 * settingsCache.service.js
 *
 * In-memory кеш настроек с TTL 60 сек.
 * Заменяет частые Settings.findOne() на быстрый возврат из памяти.
 */

const Settings = require('../models/Settings');
const mongoose = require('mongoose');

const CACHE_TTL = 60_000; // 60 секунд

let cachedSettings = null;
let cachedAt = 0;

/**
 * Возвращает глобальные настройки из кеша (или из БД при истечении TTL).
 * Всегда возвращает plain object (lean) со значениями по умолчанию.
 */
const getSettings = async () => {
  const now = Date.now();

  if (cachedSettings && (now - cachedAt) < CACHE_TTL) {
    return cachedSettings;
  }

  if (mongoose.connection?.readyState === 1) {
    try {
      const settings = await Settings.findOne({ name: 'global' }).lean({ defaults: true });
      cachedSettings = settings || {};
      cachedAt = now;
      return cachedSettings;
    } catch (_) {}
  }

  if (!cachedSettings) {
    cachedSettings = {};
  }
  return cachedSettings;
};

/**
 * Синхронное получение настроек из памяти.
 */
const getCachedSettingsSync = () => cachedSettings;

/**
 * Принудительно сбрасывает кеш (вызвать после редактирования настроек админом).
 * Если переданы обновлённые настройки (plain object или Mongoose-документ),
 * они немедленно применяются в памяти без задержек.
 */
const invalidateCache = (newSettings = null) => {
  cachedAt = 0;
  if (newSettings) {
    cachedSettings = typeof newSettings.toObject === 'function' ? newSettings.toObject() : { ...newSettings };
    cachedAt = Date.now();
    return;
  }
  if (mongoose.connection?.readyState === 1) {
    Settings.findOne({ name: 'global' }).lean({ defaults: true }).then((settings) => {
      if (settings) {
        cachedSettings = settings;
        cachedAt = Date.now();
      }
    }).catch(() => {});
  }
};

module.exports = { getSettings, getCachedSettingsSync, invalidateCache };

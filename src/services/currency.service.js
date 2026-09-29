const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const ExchangeRate = require('../models/ExchangeRate');
const settingsCache = require('./settingsCache.service');
const logger = require('../config/logger');

let cachedRate = null;

// Загружает курс из БД при старте
const loadFromDB = async () => {
  try {
    if (mongoose.connection?.readyState === 1) {
      const rate = await ExchangeRate.findOne({ base: 'USD' }).lean();
      if (rate) {
        cachedRate = rate;
        logger.info(`💱 Курс загружен из БД: 1 USD = ${rate.rub} ₽`);
      }
    }
  } catch (err) {
    logger.error(`Ошибка загрузки курса из БД: ${err.message}`);
  }
};

// Получение реального авто-курса Bybit P2P (покупка USDT за RUB)
const fetchBybitP2pRate = async () => {
  try {
    const res = await axios.post(
      'https://api2.bybit.com/fiat/otc/item/online',
      {
        tokenId: 'USDT',
        currencyId: 'RUB',
        side: '0', // 0 = покупка USDT за рубли
        size: '5',
        page: '1',
      },
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 6000,
      }
    );

    const items = res.data?.result?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Пустой список объявлений в ответе Bybit P2P');
    }

    const topItems = items.slice(0, 5);
    const prices = topItems
      .map((item) => parseFloat(item.price))
      .filter((p) => !isNaN(p) && p > 0);

    if (prices.length === 0) {
      throw new Error('Не найдены корректные цены в ответе Bybit P2P');
    }

    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const roundedRate = Math.round(avgPrice * 100) / 100;

    // Сразу сохраняем в in-memory кэш, чтобы курс был доступен немедленно
    cachedRate = { rub: roundedRate, updatedAt: new Date() };

    // Обновляем в БД (без блокировки или сбоя при недоступности БД)
    try {
      if (mongoose.connection?.readyState === 1) {
        const updated = await ExchangeRate.findOneAndUpdate(
          { base: 'USD' },
          { rub: roundedRate, updatedAt: new Date() },
          { upsert: true, new: true }
        ).lean();
        if (updated) cachedRate = updated;
      }
    } catch (dbErr) {
      logger.warn(`Не удалось сохранить курс Bybit в БД: ${dbErr.message}`);
    }

    logger.info(`💱 Курс обновлён (Bybit P2P): 1 USDT = ${roundedRate} ₽ (среднее топ-${prices.length} объявлений)`);
    return roundedRate;
  } catch (primaryErr) {
    logger.warn(`⚠️ Не удалось обновить курс из Bybit P2P (${primaryErr.message}). Запрашиваем резервный API ЦБ РФ со спредом +10%...`);
    try {
      const cbrRes = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js', { timeout: 8000 });
      const cbrUsd = cbrRes.data?.Valute?.USD?.Value;
      if (cbrUsd && typeof cbrUsd === 'number') {
        // Рыночный спред крипты (+10% к официальному курсу ЦБ РФ)
        const spreadRate = cbrUsd * 1.10;
        const roundedRate = Math.round(spreadRate * 100) / 100;

        // Сразу обновляем in-memory кэш
        cachedRate = { rub: roundedRate, updatedAt: new Date() };

        try {
          if (mongoose.connection?.readyState === 1) {
            const updated = await ExchangeRate.findOneAndUpdate(
              { base: 'USD' },
              { rub: roundedRate, updatedAt: new Date() },
              { upsert: true, new: true }
            ).lean();
            if (updated) cachedRate = updated;
          }
        } catch (dbErr) {
          logger.warn(`Не удалось сохранить курс ЦБ РФ в БД: ${dbErr.message}`);
        }

        logger.info(`💱 Курс обновлён из резервного источника (ЦБ РФ +10%): 1 USDT = ${roundedRate} ₽ (ЦБ: ${cbrUsd} ₽)`);
        return roundedRate;
      }
    } catch (cbrErr) {
      logger.warn(`⚠️ Резервный источник курса ЦБ РФ также недоступен: ${cbrErr.message}`);
    }

    if (cachedRate?.rub) {
      logger.info(`💱 Используем сохранённый ранее курс: 1 USD = ${cachedRate.rub} ₽`);
      return cachedRate.rub;
    }

    try {
      if (mongoose.connection?.readyState === 1) {
        const dbRate = await ExchangeRate.findOne({ base: 'USD' }).lean();
        if (dbRate?.rub) {
          cachedRate = dbRate;
          logger.info(`💱 Загружен курс из БД: 1 USD = ${dbRate.rub} ₽`);
          return dbRate.rub;
        }
      }
    } catch (_) {}

    cachedRate = { rub: 95, updatedAt: new Date() };
    return 95; // Фолбэк при пустой БД
  }
};

const fetchRate = fetchBybitP2pRate;

// Базовый курс (без наценки и режима)
const getBaseRate = () => {
  if (cachedRate && typeof cachedRate.rub === 'number') {
    return cachedRate.rub;
  }
  if (typeof cachedRate === 'number') {
    return cachedRate;
  }
  return 95;
};

// Получить эффективный текущий курс с учётом режима и наценки из настроек
const getRate = (settings = null) => {
  let s = settings;
  if (!s) {
    s = settingsCache.getCachedSettingsSync?.() || null;
  }

  // 1. Ручной режим: возвращает фикс-курс
  if (s?.currencyMode === 'manual') {
    return (typeof s.manualRate === 'number' && s.manualRate > 0) ? s.manualRate : 95;
  }

  // 2. Авто-режим Bybit P2P (по умолчанию): базовый курс + наценка
  const baseRate = getBaseRate();
  const offset = (s && typeof s.currencyOffset === 'number') ? s.currencyOffset : 0;
  return Math.round((baseRate + offset) * 100) / 100;
};

// Конвертация USD → RUB
const toRub = (usdAmount, settings = null) => {
  const rate = getRate(settings);
  const num = Number(usdAmount) || 0;
  return (num * rate).toFixed(0);
};

// Время последнего обновления
const getUpdatedAt = () => {
  if (!cachedRate?.updatedAt) return 'Нет данных';
  const d = new Date(cachedRate.updatedAt);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
};

// Тестовый хелпер для установки cachedRate
const _setCachedRate = (val) => {
  cachedRate = typeof val === 'number' ? { rub: val, updatedAt: new Date() } : val;
};

// Инициализация: загружаем из БД, прогреваем кэш настроек, обновляем курс
const init = async () => {
  await loadFromDB();
  try {
    await settingsCache.getSettings();
  } catch (_) {}
  await fetchBybitP2pRate();
  // Обновляем раз в час
  return cron.schedule('0 * * * *', fetchBybitP2pRate);
};

module.exports = {
  init,
  toRub,
  getRate,
  getBaseRate,
  getUpdatedAt,
  fetchRate,
  fetchBybitP2pRate,
  _setCachedRate,
};

const axios = require('axios');
const cron = require('node-cron');
const ExchangeRate = require('../models/ExchangeRate');
const logger = require('../config/logger');

let cachedRate = null;

// Загружает курс из БД при старте
const loadFromDB = async () => {
  try {
    const rate = await ExchangeRate.findOne({ base: 'USD' });
    if (rate) {
      cachedRate = rate;
      logger.info(`💱 Курс загружен из БД: 1 USD = ${rate.rub} ₽`);
    }
  } catch (err) {
    logger.error(`Ошибка загрузки курса из БД: ${err.message}`);
  }
};

// Получает актуальный курс из API
const fetchRate = async () => {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', {
      timeout: 8000,
    });
    const rubRate = res.data?.rates?.RUB;
    if (!rubRate) throw new Error('RUB rate not found in response');

    // Обновляем в БД
    const updated = await ExchangeRate.findOneAndUpdate(
      { base: 'USD' },
      { rub: rubRate, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    cachedRate = updated;
    logger.info(`💱 Курс обновлён: 1 USD = ${rubRate} ₽`);
    return rubRate;
  } catch (err) {
    logger.warn(`⚠️ Не удалось обновить курс: ${err.message}. Используем кэш.`);
    return cachedRate?.rub || 90; // Фолбэк
  }
};

// Конвертация USD → RUB
const toRub = (usdAmount) => {
  const rate = cachedRate?.rub || 90;
  return (usdAmount * rate).toFixed(0);
};

// Получить текущий курс
const getRate = () => cachedRate?.rub || 90;

// Время последнего обновления
const getUpdatedAt = () => {
  if (!cachedRate?.updatedAt) return 'Нет данных';
  const d = new Date(cachedRate.updatedAt);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
};

// Инициализация: загружаем из БД, потом сразу обновляем
const init = async () => {
  await loadFromDB();
  await fetchRate();
  // Обновляем раз в час
  cron.schedule('0 * * * *', fetchRate);
};

module.exports = { init, toRub, getRate, getUpdatedAt, fetchRate };

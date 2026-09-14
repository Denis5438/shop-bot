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

// Получает актуальный курс из API (с резервным источником ЦБ РФ)
const fetchRate = async () => {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', {
      timeout: 8000,
    });
    const rubRate = res.data?.rates?.RUB;
    if (!rubRate || typeof rubRate !== 'number') throw new Error('RUB rate not found in response');

    // Обновляем в БД
    const updated = await ExchangeRate.findOneAndUpdate(
      { base: 'USD' },
      { rub: rubRate, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    cachedRate = updated;
    logger.info(`💱 Курс обновлён (OpenER API): 1 USD = ${rubRate} ₽`);
    return rubRate;
  } catch (primaryErr) {
    logger.warn(`⚠️ Не удалось обновить курс из первичного API (${primaryErr.message}). Запрашиваем резервный API ЦБ РФ...`);
    try {
      const cbrRes = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js', { timeout: 8000 });
      const cbrUsd = cbrRes.data?.Valute?.USD?.Value;
      if (cbrUsd && typeof cbrUsd === 'number') {
        const roundedRate = Math.round(cbrUsd * 100) / 100;
        const updated = await ExchangeRate.findOneAndUpdate(
          { base: 'USD' },
          { rub: roundedRate, updatedAt: new Date() },
          { upsert: true, new: true }
        );
        cachedRate = updated;
        logger.info(`💱 Курс обновлён из резервного источника (ЦБ РФ): 1 USD = ${roundedRate} ₽`);
        return roundedRate;
      }
    } catch (cbrErr) {
      logger.warn(`⚠️ Резервный источник курса ЦБ РФ также недоступен: ${cbrErr.message}`);
    }

    if (cachedRate?.rub) {
      logger.info(`💱 Используем сохранённый ранее в БД курс: 1 USD = ${cachedRate.rub} ₽`);
      return cachedRate.rub;
    }

    return 95; // Фолбэк при пустой БД
  }
};

// Конвертация USD → RUB
const toRub = (usdAmount) => {
  const rate = cachedRate?.rub || 95;
  return (usdAmount * rate).toFixed(0);
};

// Получить текущий курс
const getRate = () => cachedRate?.rub || 95;

// Время последнего обновления
const getUpdatedAt = () => {
  if (!cachedRate?.updatedAt) return 'Нет данных';
  const d = new Date(cachedRate.updatedAt);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
};

// Инициализация: загружаем из БД, потом сразу обновляем.
// Возвращает node-cron задачу, чтобы её можно было остановить при shutdown.
const init = async () => {
  await loadFromDB();
  await fetchRate();
  // Обновляем раз в час
  return cron.schedule('0 * * * *', fetchRate);
};

module.exports = { init, toRub, getRate, getUpdatedAt, fetchRate };

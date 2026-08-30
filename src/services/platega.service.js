const axios = require('axios');
const logger = require('../config/logger');
const { getSettings } = require('./settingsCache.service');

const PLATEGA_BASE_URL = 'https://app.platega.io';

/**
 * Получает актуальные настройки Platega (из БД или env)
 */
const getPlategaConfig = async () => {
  const settings = await getSettings();
  const merchantId = String(settings?.plategaMerchantId || process.env.PLATEGA_MERCHANT_ID || '').trim();
  const secret = String(settings?.plategaSecret || process.env.PLATEGA_SECRET || '').trim();
  const enabled = settings?.plategaEnabled !== false;

  return {
    merchantId,
    secret,
    enabled,
    isReady: Boolean(merchantId && secret && enabled),
  };
};

/**
 * Создаёт платёжную ссылку СБП в Platega
 * @param {Object} params
 * @param {number} params.amountRub - сумма в рублях
 * @param {string} params.description - описание платежа
 * @param {string} params.payload - уникальный ID заявки в нашей БД
 * @param {string|number} params.userId - telegramId пользователя
 * @param {string} params.userName - @username пользователя
 * @param {string} [params.returnUrl] - URL возврата при успехе
 * @param {string} [params.failedUrl] - URL возврата при ошибке
 */
const createPayment = async ({
  amountRub,
  description,
  payload,
  userId,
  userName,
  returnUrl,
  failedUrl,
}) => {
  const config = await getPlategaConfig();
  if (!config.merchantId || !config.secret) {
    throw new Error('Platega не настроена: отсутствует Merchant ID или Secret API Key.');
  }

  const roundedRub = Math.max(1, Math.round(amountRub));
  const botUsername = process.env.BOT_USERNAME || 'ShopBot';
  const defaultReturnUrl = `https://t.me/${botUsername}`;

  const requestBody = {
    paymentMethod: 2, // 2 = SBP (Система быстрых платежей)
    paymentDetails: {
      amount: roundedRub,
      currency: 'RUB',
    },
    description: description || `Пополнение баланса ${userName || userId || ''}`,
    return: returnUrl || defaultReturnUrl,
    failedUrl: failedUrl || defaultReturnUrl,
    payload: String(payload || ''),
    metadata: {
      userId: String(userId || ''),
      userName: userName ? (userName.startsWith('@') ? userName : `@${userName}`) : `@id${userId}`,
    },
  };

  const headers = {
    'X-MerchantId': config.merchantId,
    'X-Secret': config.secret,
    'Content-Type': 'application/json',
  };

  try {
    logger.info(`[Platega] Создание платежа на сумму ${roundedRub} RUB (payload=${payload})...`);

    // Сначала пробуем прямой эндпоинт с методом СБП
    let response;
    try {
      response = await axios.post(`${PLATEGA_BASE_URL}/transaction/process`, requestBody, {
        headers,
        timeout: 15000,
      });
    } catch (primaryErr) {
      // Если метод с paymentMethod вернул ошибку, пробуем v2
      logger.warn(`[Platega] /transaction/process вернул ошибку (${primaryErr.message}), пробуем /v2/transaction/process...`);
      const v2Body = { ...requestBody };
      delete v2Body.paymentMethod;
      response = await axios.post(`${PLATEGA_BASE_URL}/v2/transaction/process`, v2Body, {
        headers,
        timeout: 15000,
      });
    }

    const data = response.data;
    const transactionId = data.transactionId || data.id;
    const payUrl = data.redirect || data.url;
    const status = data.status || 'PENDING';
    const expiresIn = data.expiresIn || '00:15:00';
    const rate = data.usdtRate || data.rate || null;

    if (!transactionId || !payUrl) {
      throw new Error(`Platega вернула ответ без transactionId или payUrl: ${JSON.stringify(data)}`);
    }

    logger.info(`[Platega] Платёж успешно создан: id=${transactionId}, url=${payUrl}`);

    return {
      success: true,
      transactionId,
      payUrl,
      status,
      expiresIn,
      rate,
      amountRub: roundedRub,
    };
  } catch (err) {
    const errorDetails = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[Platega] Ошибка создания платежа: ${errorDetails}`);
    throw new Error(`Ошибка платёжного шлюза Platega: ${errorDetails}`);
  }
};

/**
 * Проверяет статус платежа в Platega API
 * @param {string} transactionId
 */
const checkStatus = async (transactionId) => {
  const config = await getPlategaConfig();
  if (!config.merchantId || !config.secret) {
    throw new Error('Platega не настроена.');
  }

  const headers = {
    'X-MerchantId': config.merchantId,
    'X-Secret': config.secret,
  };

  try {
    logger.info(`[Platega] Проверка статуса транзакции ${transactionId}...`);
    const response = await axios.get(`${PLATEGA_BASE_URL}/transaction/${transactionId}`, {
      headers,
      timeout: 5000,
    });

    const data = response.data || {};
    const status = (data.status || '').toUpperCase();

    return {
      success: true,
      status,
      isConfirmed: status === 'CONFIRMED',
      isPending: status === 'PENDING',
      isCanceled: status === 'CANCELED' || status === 'CHARGEBACKED',
      data,
    };
  } catch (err) {
    const errorDetails = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[Platega] Ошибка проверки статуса ${transactionId}: ${errorDetails}`);
    return {
      success: false,
      status: 'ERROR',
      error: errorDetails,
    };
  }
};

/**
 * Валидирует заголовки входящего Webhook запроса
 * @param {Object} incomingHeaders
 */
const verifyWebhookHeaders = async (incomingHeaders = {}) => {
  const config = await getPlategaConfig();
  if (!config.merchantId || !config.secret) return false;

  const merchantId = incomingHeaders['x-merchantid'] || incomingHeaders['x-merchant-id'] || incomingHeaders['X-MerchantId'];
  const secret = incomingHeaders['x-secret'] || incomingHeaders['X-Secret'];

  if (!merchantId || !secret) return false;

  return (
    String(merchantId).trim() === config.merchantId &&
    String(secret).trim() === config.secret
  );
};

module.exports = {
  getPlategaConfig,
  createPayment,
  checkStatus,
  verifyWebhookHeaders,
};

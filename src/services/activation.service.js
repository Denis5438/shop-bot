const axios = require('axios');
const logger = require('../config/logger');

const U1TRABY_BASE_URL = 'https://u1traby.trade';
const CHATGPTCONNECT_BASE_URL = 'https://chatgptconnect.ru';

const u1trabyApi = axios.create({
  baseURL: U1TRABY_BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

const chatgptConnectApi = axios.create({
  baseURL: CHATGPTCONNECT_BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: (status) => status >= 200 && status < 400,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeStartArgs = (providerOrCode, maybeCode) => {
  if (typeof maybeCode === 'undefined') {
    return { provider: 'u1traby', code: providerOrCode };
  }

  return { provider: providerOrCode || 'u1traby', code: maybeCode };
};

const normalizeFinishArgs = (providerOrExternalId, externalIdOrToken, maybeToken) => {
  if (typeof maybeToken === 'undefined') {
    return {
      provider: 'u1traby',
      externalId: providerOrExternalId,
      token: externalIdOrToken,
    };
  }

  return {
    provider: providerOrExternalId || 'u1traby',
    externalId: externalIdOrToken,
    token: maybeToken,
  };
};

const normalizeRetryArgs = (providerOrExternalId, externalIdOrToken, maybeToken) => {
  if (typeof maybeToken === 'undefined') {
    return {
      provider: 'u1traby',
      externalId: providerOrExternalId,
      token: externalIdOrToken,
    };
  }

  return {
    provider: providerOrExternalId || 'u1traby',
    externalId: externalIdOrToken,
    token: maybeToken,
  };
};

const startU1trabyActivation = async (cdkKey) => {
  try {
    logger.info(`[Activation:u1traby] start key=${String(cdkKey).substring(0, 12)}...`);

    const res = await u1trabyApi.post('/api/activate/start', { key: cdkKey, lang: 'ru' });
    const data = res.data;

    if (!data?.ok || !data?.order_id) {
      const message = data?.message || 'Сервер не вернул order_id на шаге 1';
      logger.warn(`[Activation:u1traby] start failed: ${message}`);
      return { success: false, message };
    }

    logger.info(`[Activation:u1traby] start ok order_id=${data.order_id}`);
    return { success: true, order_id: data.order_id, email: data.email || null };
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    logger.error(`[Activation:u1traby] start error: ${message}`);
    return { success: false, message: `Ошибка на шаге 1 (start): ${message}` };
  }
};

const finishU1trabyActivation = async (apiOrderId, userToken) => {
  try {
    const cleanToken = String(userToken || '').trim();

    logger.info(
      `[Activation:u1traby] finish order_id=${apiOrderId} token_len=${cleanToken.length}`
    );

    const res = await u1trabyApi.post('/api/activate/token', {
      order_id: apiOrderId,
      token_raw: cleanToken,
    });

    const data = res.data;
    logger.info(`[Activation:u1traby] finish response: ${JSON.stringify(data)}`);

    if (data?.ok === false) {
      const message = data?.message || 'Сервер отклонил токен на шаге 2';
      logger.warn(`[Activation:u1traby] finish failed: ${message}`);
      return { success: false, message };
    }

    logger.info(`[Activation:u1traby] finish ok order_id=${apiOrderId}`);
    return { success: true };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message = body?.message || err.message;

    logger.error(
      `[Activation:u1traby] finish error http=${status} body=${JSON.stringify(body)} message=${message}`
    );

    return { success: false, message };
  }
};

const getChatgptConnectStatus = async (uniqueCode) => {
  try {
    const res = await chatgptConnectApi.get(`/api/chatgptconnect/orders/${encodeURIComponent(uniqueCode)}/status`);
    const data = res.data || {};
    const status = data.status || data.sessionStatus || data.activationResult || null;

    logger.info(`[Activation:chatgptconnect] status code=${uniqueCode} status=${status || 'unknown'}`);

    return {
      success: true,
      status,
      payload: data,
    };
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    logger.error(`[Activation:chatgptconnect] status error code=${uniqueCode}: ${message}`);
    return { success: false, message };
  }
};

const CHATGPTCONNECT_SUCCESS_STATUSES = new Set([
  'SUCCESS',
  'COMPLETED',
  'ACTIVATED',
  'LINK_OPENED',
]);

const CHATGPTCONNECT_RETRYABLE_STATUSES = new Set([
  'PENDING',
  'PROCESSING',
  'WAITING',
  'SUBMITTED',
  'STARTED',
  'TOKEN_ACCEPTED',
]);

const pollChatgptConnectStatus = async (uniqueCode, { attempts = 6, intervalMs = 3_000 } = {}) => {
  let lastStatus = null;
  let lastMessage = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const statusResult = await getChatgptConnectStatus(uniqueCode);

    if (!statusResult.success) {
      lastMessage = statusResult.message;
    } else {
      lastStatus = statusResult.status;

      if (lastStatus && CHATGPTCONNECT_SUCCESS_STATUSES.has(lastStatus)) {
        return {
          success: true,
          externalStatus: lastStatus,
          payload: statusResult.payload,
        };
      }

      if (lastStatus && !CHATGPTCONNECT_RETRYABLE_STATUSES.has(lastStatus)) {
        return {
          success: false,
          retryable: false,
          message: `Поставщик вернул статус: ${lastStatus}`,
          externalStatus: lastStatus,
        };
      }
    }

    if (attempt < attempts) {
      await wait(intervalMs);
    }
  }

  return {
    success: false,
    retryable: true,
    message: lastStatus
      ? `Поставщик ещё не завершил активацию: ${lastStatus}`
      : lastMessage || 'Не удалось получить финальный статус поставщика',
    externalStatus: lastStatus,
  };
};

const finishChatgptConnectActivation = async (uniqueCode, userToken) => {
  try {
    const cleanToken = String(userToken || '').trim();

    logger.info(
      `[Activation:chatgptconnect] submit uniqueCode=${uniqueCode} token_len=${cleanToken.length}`
    );

    const res = await chatgptConnectApi.post('/api/chatgptconnect/orders/submit-token', {
      token: cleanToken,
      uniqueCode,
    });

    const data = res.data || {};
    logger.info(`[Activation:chatgptconnect] submit response: ${JSON.stringify(data)}`);

    if (data.ok === false) {
      const message = data.message || 'Поставщик отклонил токен';
      return { success: false, retryable: false, message };
    }

    return pollChatgptConnectStatus(uniqueCode);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message = body?.message || err.message;

    logger.error(
      `[Activation:chatgptconnect] submit error http=${status} body=${JSON.stringify(body)} message=${message}`
    );

    const retryable = !status || status >= 500;
    return { success: false, retryable, message };
  }
};

const retryChatgptConnectActivation = async (uniqueCode) => {
  logger.info(`[Activation:chatgptconnect] retry uniqueCode=${uniqueCode}`);
  return pollChatgptConnectStatus(uniqueCode, { attempts: 3, intervalMs: 3_000 });
};

const startActivation = async (providerOrCode, maybeCode) => {
  const { provider, code } = normalizeStartArgs(providerOrCode, maybeCode);

  if (provider === 'chatgptconnect') {
    return { success: true, order_id: code, email: null };
  }

  return startU1trabyActivation(code);
};

const finishActivation = async (providerOrExternalId, externalIdOrToken, maybeToken) => {
  const { provider, externalId, token } = normalizeFinishArgs(
    providerOrExternalId,
    externalIdOrToken,
    maybeToken
  );

  if (provider === 'chatgptconnect') {
    return finishChatgptConnectActivation(externalId, token);
  }

  return finishU1trabyActivation(externalId, token);
};

const retryActivation = async (providerOrExternalId, externalIdOrToken, maybeToken) => {
  const { provider, externalId, token } = normalizeRetryArgs(
    providerOrExternalId,
    externalIdOrToken,
    maybeToken
  );

  if (provider === 'chatgptconnect') {
    return retryChatgptConnectActivation(externalId);
  }

  return finishU1trabyActivation(externalId, token);
};

module.exports = {
  startActivation,
  finishActivation,
  retryActivation,
};

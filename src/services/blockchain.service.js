const axios = require('axios');
const logger = require('../config/logger');
const crypto = require('crypto');

/**
 * Валидация внутреннего перевода по UID пользователя (Bybit API v5)
 *
 * Возвращает:
 *   - { success: true, matches: [...] }                — найдены подтверждённые переводы.
 *   - { success: false, reason }                       — переводов нет.
 *   - { success: false, blocked: true, reason, code }  — Bybit заблокировал запрос
 *     (часто 403 от CloudFront по гео-фильтру или rate-limit). Вызывающий код
 *     должен в этом случае не показывать пользователю «соединение упало», а
 *     перевести заявку на ручную проверку.
 */
const verifyUidUsdt = async (senderUid) => {
  const { BYBIT_API_KEY, BYBIT_API_SECRET } = require('../config');
  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
    return { success: false, reason: 'API ключи не настроены (Обратитесь к администратору)' };
  }

  // Нормализуем ввод: обрезаем пробелы и невидимые символы, UID — это цифры.
  const uidClean = String(senderUid || '').trim();
  if (!uidClean) {
    return { success: false, reason: 'Пустой UID' };
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const qs = 'limit=50';

  const signature = crypto.createHmac('sha256', BYBIT_API_SECRET)
    .update(timestamp + BYBIT_API_KEY + recvWindow + qs)
    .digest('hex');

  try {
    const res = await axios.get(`https://api.bybit.com/v5/asset/deposit/query-internal-record?${qs}`, {
      headers: {
        // Bybit's CloudFront отбивает запросы без User-Agent с 403 — добавляем явный UA.
        'User-Agent': 'shop-bot/1.0 (+https://t.me/Tigrano_o)',
        'Accept': 'application/json',
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      timeout: 10000,
      // Не выкидываем исключение по 4xx/5xx — нам нужно тело для диагностики.
      validateStatus: () => true,
    });

    const status = res.status;

    // 403 от Bybit чаще всего значит блокировку региона на уровне CloudFront
    // (для RU IP это почти всегда так). API при этом не отрабатывает, нужно
    // gracefully сдавать на ручную проверку.
    if (status === 403 || status === 451) {
      logger.warn(`[Bybit] HTTP ${status} (geo/WAF block) UID=${uidClean}`);
      return {
        success: false,
        blocked: true,
        code: status,
        reason: 'Bybit API недоступен с текущего IP (региональная блокировка). Заявка отправлена на ручную проверку.',
      };
    }

    if (status === 429) {
      logger.warn(`[Bybit] HTTP 429 (rate limit) UID=${uidClean}`);
      return {
        success: false,
        blocked: true,
        code: 429,
        reason: 'Bybit API перегружен. Заявка отправлена на ручную проверку.',
      };
    }

    if (status === 401 || res.data?.retCode === 10003 || res.data?.retCode === 10004) {
      logger.error(`[Bybit] auth error UID=${uidClean} retCode=${res.data?.retCode} msg=${res.data?.retMsg}`);
      return {
        success: false,
        blocked: true,
        code: status,
        reason: 'Ошибка авторизации Bybit API. Заявка отправлена на ручную проверку.',
      };
    }

    if (status >= 500) {
      logger.warn(`[Bybit] HTTP ${status} (server error) UID=${uidClean}`);
      return {
        success: false,
        blocked: true,
        code: status,
        reason: 'Bybit API временно недоступен. Заявка отправлена на ручную проверку.',
      };
    }

    if (status !== 200 || !res.data) {
      logger.warn(`[Bybit] unexpected HTTP ${status} UID=${uidClean} body=${JSON.stringify(res.data).slice(0, 200)}`);
      return {
        success: false,
        blocked: true,
        code: status,
        reason: `Неожиданный ответ Bybit API (HTTP ${status}). Заявка отправлена на ручную проверку.`,
      };
    }

    if (res.data.retCode !== 0) {
      logger.warn(`[Bybit] retCode=${res.data.retCode} msg=${res.data.retMsg}`);
      return { success: false, reason: res.data.retMsg || 'Ошибка API Bybit' };
    }

    const rows = res.data.result?.rows || [];

    // Ищем переводы, где отправитель совпадает с UID, монета USDT и статус = 2 (Success)
    const matches = rows.filter(r =>
      r.coin === 'USDT' &&
      r.status === 2 &&
      String(r.address || '').trim() === uidClean
    );

    if (matches.length > 0) {
      return { success: true, matches: matches.map(m => ({ txID: m.txID, amount: parseFloat(m.amount) })) };
    }

    return { success: false, reason: 'Перевод не найден или ещё в обработке' };
  } catch (err) {
    // Сюда попадаем при сетевых ошибках (DNS, timeout, ECONNRESET).
    const code = err.code || 'UNKNOWN';
    const isNetwork = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNABORTED'].includes(code);
    logger.error(`[Bybit] network error UID ${senderUid}: ${code} ${err.message}`);
    return {
      success: false,
      blocked: isNetwork,
      code,
      reason: isNetwork
        ? 'Сеть до Bybit API недоступна. Заявка отправлена на ручную проверку.'
        : 'Ошибка соединения с API Bybit',
    };
  }
};

/**
 * Проверка перевода USDT (TRC-20) через TronScan API.
 * @param {string} txid - Хэш транзакции
 * @param {string} expectedWallet - Кошелек назначения
 * @returns {{ success: boolean, amount?: number, reason?: string }}
 */
const verifyTrc20Usdt = async (txid, expectedWallet) => {
  try {
    const res = await axios.get(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txid}`, { timeout: 10000 });
    const data = res.data;

    // Если транзакция не найдена или не успешна
    if (!data || data.contractRet !== 'SUCCESS') {
      return { success: false, reason: 'Транзакция не найдена или имеет статус FAILED' };
    }

    let amountParsed = 0;
    
    // Проверка 1: Одиночный перевод (tokenTransferInfo)
    if (data.tokenTransferInfo) {
      const t = data.tokenTransferInfo;
      if (t.symbol === 'USDT' && t.to_address === expectedWallet) {
        amountParsed = parseInt(t.amount_str) / (10 ** t.decimals);
      }
    }
    
    // Проверка 2: Множественные переводы (trc20TransferInfo)
    if (amountParsed === 0 && Array.isArray(data.trc20TransferInfo)) {
      for (const t of data.trc20TransferInfo) {
        if (t.symbol === 'USDT' && t.to_address === expectedWallet) {
          amountParsed = parseInt(t.amount_str) / (10 ** t.decimals);
          break;
        }
      }
    }

    if (amountParsed > 0) {
      return { success: true, amount: amountParsed };
    }

    return { success: false, reason: 'Перевод USDT на ваш кошелек в этой транзакции не найден' };
  } catch (err) {
    logger.error(`[TronScan] Ошибка проверки ${txid}: ${err.message}`);
    return { success: false, reason: 'Ошибка соединения с API TronScan' };
  }
};

/**
 * Проверка перевода USDT (BEP-20) через публичный RPC (Binance Dataseed).
 * Надежно, бесплатно, не требует ключей.
 * @param {string} txid - Хэш транзакции
 * @param {string} expectedWallet - Кошелек назначения
 * @returns {{ success: boolean, amount?: number, reason?: string }}
 */
const verifyBep20Usdt = async (txid, expectedWallet) => {
  const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
  const BUSD_ADDRESS = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
  
  if (!txid.startsWith('0x')) txid = '0x' + txid;

  try {
    const payload = {
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txid],
      id: 1
    };

    const res = await axios.post('https://bsc-dataseed.binance.org/', payload, { timeout: 10000 });
    const receipt = res.data?.result;

    if (!receipt) {
       return { success: false, reason: 'Транзакция не найдена в блокчейне BSC' };
    }

    if (receipt.status !== '0x1') {
       return { success: false, reason: 'Транзакция имеет статус FAILED' };
    }

    let minAmount = 0;
    const transferEventSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const targetTopic = '0x' + expectedWallet.toLowerCase().replace('0x', '').padStart(64, '0');

    for (const log of receipt.logs) {
      if (log.topics && log.topics[0] === transferEventSig) {
        const tokenAddr = log.address.toLowerCase();
        if (tokenAddr === USDT_ADDRESS || tokenAddr === BUSD_ADDRESS) {
           // topics[2] - получатель. 
           if (log.topics[2] && log.topics[2].toLowerCase() === targetTopic) {
             // Безопасная конвертация BigInt → число с плавающей точкой
             // Избегаем потери точности для больших сумм через строковое деление
             const bigVal = BigInt(log.data);
             const divisor = BigInt(10 ** 18);
             const intPart = bigVal / divisor;
             const fracPart = bigVal % divisor;
             const amountParsed = Number(intPart) + Number(fracPart) / 1e18;
             minAmount += amountParsed;
           }
        }
      }
    }

    if (minAmount > 0) {
      return { success: true, amount: minAmount };
    }

    return { success: false, reason: 'Перевод USDT на ваш кошелек в этой транзакции не найден' };
  } catch (err) {
    logger.error(`[BSC RPC] Ошибка проверки ${txid}: ${err.message}`);
    return { success: false, reason: 'Ошибка соединения с сетью BSC' };
  }
};

module.exports = {
  verifyTrc20Usdt,
  verifyBep20Usdt,
  verifyUidUsdt
};

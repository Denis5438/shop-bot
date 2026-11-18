const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const logger = require('../config/logger');
const { BYBIT_API_KEY, BYBIT_API_SECRET } = require('../config');
const BybitInvoice = require('../models/BybitInvoice');
const TopupRequest = require('../models/TopupRequest');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Key = require('../models/Key');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { getSettings } = require('./settingsCache.service');
const notif = require('./notification.service');

let botInstance = null;

const setBot = (bot) => {
  botInstance = bot;
};

const getEffectiveBot = (customBot = null) => {
  if (customBot?.telegram?.sendMessage) return customBot;
  if (botInstance?.telegram?.sendMessage) return botInstance;
  const notifBot = notif.getBotInstance?.();
  if (notifBot?.telegram?.sendMessage) return notifBot;
  return null;
};

const escapeHtml = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

/**
 * Retrieves admin Bybit UID from Settings.bybitUid
 * (fallback to process.env.BYBIT_UID || '554135317').
 */
const getAdminUid = async () => {
  try {
    const settings = await getSettings();
    if (settings && typeof settings.bybitUid === 'string' && settings.bybitUid.trim()) {
      return settings.bybitUid.trim();
    }
    const dbSettings = await Settings.findOne({ name: 'global' }).lean();
    if (dbSettings && typeof dbSettings.bybitUid === 'string' && dbSettings.bybitUid.trim()) {
      return dbSettings.bybitUid.trim();
    }
  } catch (err) {
    logger.warn(`[Bybit UID] Failed to read admin UID from settings: ${err.message}`);
  }
  return (process.env.BYBIT_UID || '554135317').trim();
};

/**
 * Generates random 4-decimal suffix between 0.0010 and 0.0099 (e.g. +0.0038).
 * Checks that no pending unexpired invoice has exactAmount === baseAmount + suffix.
 *
 * @param {number|string} baseAmount
 * @returns {Promise<{ suffix: number, exactAmount: number, suffixFractional: number }>}
 */
const allocateUniqueAmount = async (baseAmount) => {
  const base = Number(parseFloat(baseAmount).toFixed(2));
  if (isNaN(base) || base <= 0) {
    throw new Error('Invalid baseAmount: must be a positive number');
  }

  const now = new Date();
  const pendingInvoices = await BybitInvoice.find({
    status: 'pending',
    expiresAt: { $gt: now },
    baseAmount: base,
  }).select('exactAmount suffix').lean();

  const occupiedAmounts = new Set(
    pendingInvoices.map((inv) => Number(Number(inv.exactAmount).toFixed(4)))
  );

  const available = [];
  for (let s = 10; s <= 99; s += 1) {
    const frac = Number((s / 10000).toFixed(4));
    const candidateExact = Number((base + frac).toFixed(4));
    if (!occupiedAmounts.has(candidateExact)) {
      available.push({
        suffix: s,
        exactAmount: candidateExact,
        suffixFractional: frac,
      });
    }
  }

  if (available.length === 0) {
    throw new Error(
      'Все уникальные суммы для данного номинала временно заняты. Пожалуйста, повторите попытку через пару минут.'
    );
  }

  const chosen = available[Math.floor(Math.random() * available.length)];

  // Return composite object that can also coerce to number or string seamlessly
  return {
    suffix: chosen.suffix,
    exactAmount: chosen.exactAmount,
    suffixFractional: chosen.suffixFractional,
    valueOf() {
      return chosen.exactAmount;
    },
    toString() {
      return String(chosen.exactAmount);
    },
  };
};

/**
 * Creates a BybitInvoice with unique exactAmount, admin UID, and 15 min expiration.
 *
 * @param {{
 *   userId: string|mongoose.Types.ObjectId,
 *   orderId?: string|mongoose.Types.ObjectId|null,
 *   productId?: string|mongoose.Types.ObjectId|null,
 *   qty?: number,
 *   baseAmount: number,
 *   adminUid?: string
 * }} params
 * @returns {Promise<BybitInvoice>}
 */
const createInvoice = async ({
  userId,
  orderId = null,
  productId = null,
  qty = 1,
  baseAmount,
  adminUid: customAdminUid = null,
}) => {
  if (!userId) throw new Error('userId is required');
  const base = Number(parseFloat(baseAmount).toFixed(2));
  if (isNaN(base) || base <= 0) throw new Error('Valid baseAmount is required');

  const adminUid = customAdminUid || await getAdminUid();
  const { suffix, exactAmount } = await allocateUniqueAmount(base);

  const isOrderRelated = Boolean(orderId || productId);
  const prefix = isOrderRelated ? 'ORD-' : 'TOP-';

  const count = await BybitInvoice.countDocuments();
  let nextNum = count + 1;
  let invoiceNumber = `${prefix}${String(nextNum).padStart(8, '0')}`;
  while (await BybitInvoice.exists({ invoiceNumber })) {
    nextNum += 1;
    invoiceNumber = `${prefix}${String(nextNum).padStart(8, '0')}`;
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // now + 15 mins

  const invoice = new BybitInvoice({
    invoiceNumber,
    userId,
    orderId: orderId || null,
    productId: productId || null,
    qty: Math.max(1, parseInt(qty, 10) || 1),
    baseAmount: base,
    exactAmount,
    suffix,
    adminUid,
    status: 'pending',
    txId: null,
    expiresAt,
    createdAt: new Date(),
    completedAt: null,
  });

  await invoice.save();
  return invoice;
};

/**
 * Cancels a pending BybitInvoice.
 *
 * @param {string|mongoose.Types.ObjectId} invoiceId
 * @param {string|mongoose.Types.ObjectId|null} userId
 * @returns {Promise<BybitInvoice>}
 */
const cancelInvoice = async (invoiceId, userId = null) => {
  const query = { _id: invoiceId };
  if (userId) query.userId = userId;

  const invoice = await BybitInvoice.findOne(query);
  if (!invoice) {
    throw new Error('Invoice not found');
  }
  if (invoice.status === 'completed') {
    throw new Error('Cannot cancel completed invoice');
  }

  invoice.status = 'cancelled';
  await invoice.save();
  return invoice;
};

/**
 * Queries Bybit API v5 /v5/asset/deposit/query-internal-record with coin=USDT, limit=50,
 * canonical HMAC-SHA256 signature, matches exactAmount, prevents double spend,
 * and fulfills order or credits topup.
 *
 * @param {string|mongoose.Types.ObjectId|BybitInvoice} invoiceId
 * @param {Object} [options]
 * @param {Object} [options.bot]
 * @param {Array} [options.mockRecords]
 * @returns {Promise<{ success: boolean, reason?: string, invoice?: Object, order?: Object, topupRequest?: Object, alreadyCompleted?: boolean }>}
 */
const getBybitCredentials = async () => {
  let apiKey = BYBIT_API_KEY || '';
  let apiSecret = BYBIT_API_SECRET || '';
  try {
    const settings = await getSettings();
    if (settings && typeof settings.bybitApiKey === 'string' && settings.bybitApiKey.trim()) {
      apiKey = settings.bybitApiKey.trim();
    }
    if (settings && typeof settings.bybitApiSecret === 'string' && settings.bybitApiSecret.trim()) {
      apiSecret = settings.bybitApiSecret.trim();
    }
  } catch (_) {}
  return { apiKey, apiSecret };
};

const checkInvoice = async (invoiceId, options = {}) => {
  let invoice = null;
  const isObjectId =
    invoiceId instanceof mongoose.Types.ObjectId ||
    (typeof invoiceId === 'string' && mongoose.Types.ObjectId.isValid(invoiceId) && /^[0-9a-fA-F]{24}$/.test(invoiceId));

  if (
    invoiceId &&
    typeof invoiceId === 'object' &&
    !(invoiceId instanceof mongoose.Types.ObjectId) &&
    (invoiceId.invoiceNumber || invoiceId.exactAmount !== undefined)
  ) {
    invoice = invoiceId;
  } else if (isObjectId) {
    invoice = await BybitInvoice.findById(invoiceId);
  } else if (typeof invoiceId === 'string') {
    invoice = await BybitInvoice.findOne({ invoiceNumber: invoiceId });
  }

  if (!invoice) {
    return { success: false, reason: 'Invoice not found' };
  }

  if (invoice.status === 'completed') {
    return { success: true, alreadyCompleted: true, invoice };
  }

  if (invoice.status === 'cancelled') {
    return { success: false, reason: 'Invoice is cancelled' };
  }

  const now = new Date();
  if (invoice.status === 'expired' || (invoice.expiresAt && invoice.expiresAt <= now)) {
    if (invoice.status !== 'expired') {
      invoice.status = 'expired';
      await invoice.save();
    }
    return { success: false, reason: 'Invoice expired', expired: true };
  }

  // Determine bot instance for Telegram notifications
  const bot = getEffectiveBot(options?.telegram ? options : options?.bot);

  let rows = [];

  // If mockRecords provided (e.g. for unit testing)
  if (Array.isArray(options?.mockRecords)) {
    rows = options.mockRecords;
  } else {
    const { apiKey, apiSecret } = await getBybitCredentials();
    if (!apiKey || !apiSecret) {
      logger.warn('[Bybit UID] Bybit API Key or Secret is missing');
      return { success: false, reason: 'Bybit API credentials not configured' };
    }

    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    const qs = 'coin=USDT&limit=50';

    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(timestamp + apiKey + recvWindow + qs)
      .digest('hex');

    const BYBIT_HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
    let lastError = null;
    let requestSucceeded = false;

    for (const host of BYBIT_HOSTS) {
      try {
        const res = await axios.get(
          `${host}/v5/asset/deposit/query-internal-record?${qs}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              Accept: 'application/json',
              'X-BAPI-API-KEY': apiKey,
              'X-BAPI-TIMESTAMP': timestamp,
              'X-BAPI-SIGN': signature,
              'X-BAPI-SIGN-TYPE': '2',
              'X-BAPI-RECV-WINDOW': recvWindow,
            },
            timeout: 10000,
            validateStatus: () => true,
          }
        );

        if (res.status === 200 && res.data) {
          if (res.data.retCode !== 0) {
            logger.warn(`[Bybit UID] retCode=${res.data.retCode} msg=${res.data.retMsg}`);
            return { success: false, reason: res.data.retMsg || 'Bybit API error' };
          }
          rows = res.data.result?.rows || [];
          requestSucceeded = true;
          break;
        } else {
          lastError = `HTTP ${res.status}`;
          logger.warn(`[Bybit UID] ${host} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
        }
      } catch (err) {
        lastError = err.message;
        logger.error(`[Bybit UID] ${host} error: ${err.message}`);
      }
    }

    if (!requestSucceeded) {
      return { success: false, reason: lastError || 'Bybit API error' };
    }
  }

  // Match records by coin=USDT, status=2 (Success), and matching amount:
  // Math.abs(parseFloat(r.amount) - invoice.exactAmount) < 0.00001
  const matchingRecords = rows.filter((r) => {
    if (r.coin && String(r.coin).toUpperCase() !== 'USDT') return false;
    if (r.status !== undefined && Number(r.status) !== 2) return false;
    const amountVal = parseFloat(r.amount);
    if (isNaN(amountVal)) return false;
    return Math.abs(amountVal - invoice.exactAmount) < 0.00001;
  });

  if (matchingRecords.length === 0) {
    return { success: false, reason: 'Matching transfer record not found' };
  }

  let selectedRecord = null;
  let txId = null;

  for (const record of matchingRecords) {
    const rawTx = String(record.txID || record.txId || record.id || '').trim();
    if (!rawTx) continue;

    // Double spend check against other completed BybitInvoices
    const existingInvoice = await BybitInvoice.findOne({
      txId: rawTx,
      _id: { $ne: invoice._id },
    });
    if (existingInvoice) {
      logger.warn(
        `[Bybit UID] txId ${rawTx} already spent on BybitInvoice ${existingInvoice.invoiceNumber}`
      );
      continue;
    }

    // Double spend check against TopupRequest
    const existingTopup = await TopupRequest.findOne({
      $or: [{ txid: rawTx }, { txid: rawTx.toLowerCase() }],
    });
    if (existingTopup) {
      logger.warn(
        `[Bybit UID] txId ${rawTx} already spent on TopupRequest ${existingTopup._id}`
      );
      continue;
    }

    selectedRecord = record;
    txId = rawTx;
    break;
  }

  if (!selectedRecord || !txId) {
    return {
      success: false,
      reason: 'Matching record found but txId is already spent (double spend protection)',
    };
  }

  // Mark invoice completed
  invoice.status = 'completed';
  invoice.txId = txId;
  invoice.completedAt = new Date();
  await invoice.save();

  const isOrder = Boolean(invoice.orderId || invoice.productId);

  if (!isOrder) {
    // ─── TOPUP FULFILLMENT ───
    const topupRequest = new TopupRequest({
      userId: invoice.userId,
      amount: invoice.baseAmount,
      status: 'confirmed',
      method: 'bybit_uid',
      network: 'UID',
      txid: txId,
      notes: `Bybit UID Auto-Match (Invoice: ${invoice.invoiceNumber}, exact: ${invoice.exactAmount} USDT)`,
      createdAt: invoice.createdAt || new Date(),
      processedAt: new Date(),
    });
    await topupRequest.save();

    await User.updateOne(
      { _id: invoice.userId },
      { $inc: { balance: invoice.baseAmount } }
    );

    await new Transaction({
      userId: invoice.userId,
      type: 'topup',
      amount: invoice.baseAmount,
      topupRequestId: topupRequest._id,
      description: `Пополнение через Bybit UID (${invoice.invoiceNumber})`,
    }).save();

    const user = await User.findById(invoice.userId);
    if (user?.telegramId && bot?.telegram?.sendMessage) {
      const lang = user.language || 'ru';
      const text =
        lang === 'en'
          ? `✅ <b>Payment received!</b>\n\n` +
            `🧾 Invoice: <code>${invoice.invoiceNumber}</code>\n` +
            `💰 Credited: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `Your balance has been updated!`
          : `✅ <b>Оплата получена!</b>\n\n` +
            `🧾 Счёт: <code>${invoice.invoiceNumber}</code>\n` +
            `💰 Зачислено: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `Баланс успешно пополнен!`;
      await bot.telegram
        .sendMessage(user.telegramId, text, { parse_mode: 'HTML' })
        .catch(() => {});
    }

    return { success: true, invoice, topupRequest };
  }

  // ─── ORDER FULFILLMENT ───
  let product = null;
  if (invoice.productId) {
    product = await Product.findById(invoice.productId);
  }
  let order = null;
  if (invoice.orderId) {
    order = await Order.findById(invoice.orderId);
    if (!product && order?.productId) {
      product = await Product.findById(order.productId);
    }
  }

  const qty = invoice.qty || order?.qty || 1;
  const isGptActivation = product?.type === 'gpt_activation';
  const isAutoKey =
    product && product.type !== 'gpt_activation' && product.type !== 'manual';

  const allocatedKeys = [];
  if (product && isAutoKey) {
    for (let i = 0; i < qty; i += 1) {
      const key = await Key.findOneAndUpdate(
        { productId: product._id, isUsed: false },
        { $set: { isUsed: true, usedAt: new Date() } },
        { new: true }
      );
      if (key) allocatedKeys.push(key);
    }
  }

  const deliveryData =
    allocatedKeys.length > 0
      ? allocatedKeys.map((k) => k.value).join('\n')
      : order?.deliveryData || null;

  const orderStatus = isGptActivation
    ? 'awaiting_token'
    : allocatedKeys.length > 0
    ? 'completed'
    : (order?.status || 'pending');

  if (!order) {
    order = new Order({
      userId: invoice.userId,
      productId: product?._id,
      provider: product?.provider || 'local',
      status: orderStatus,
      price: invoice.baseAmount,
      costPrice: (product?.costPrice || 0) * qty,
      qty,
      keyId: allocatedKeys[0]?._id || null,
      deliveryData,
      confirmedAt: orderStatus === 'completed' ? new Date() : null,
      activationResult:
        orderStatus === 'completed' ? 'Ключ выдан автоматически (Bybit UID)' : null,
      warrantyDays: product?.warrantyDays ?? 5,
      subscriptionDays: product?.subscriptionDays ?? 30,
    });
    await order.save();
    invoice.orderId = order._id;
    await invoice.save();
  } else {
    order.status = orderStatus;
    if (allocatedKeys.length > 0) {
      order.keyId = allocatedKeys[0]._id;
      order.deliveryData = deliveryData;
      order.confirmedAt = new Date();
      order.activationResult = 'Ключ выдан автоматически (Bybit UID)';
    }
    await order.save();
  }

  for (const k of allocatedKeys) {
    await Key.updateOne({ _id: k._id }, { $set: { usedByOrder: order._id } });
  }

  if (product) {
    await Product.updateOne(
      { _id: product._id },
      { $set: { lastSoldAt: new Date() } }
    );
  }

  await new Transaction({
    userId: invoice.userId,
    type: 'purchase',
    amount: -invoice.baseAmount,
    orderId: order._id,
    description: `Покупка через Bybit UID: ${product?.name || 'Товар'} (Счёт: ${invoice.invoiceNumber})`,
  }).save();

  if (orderStatus === 'completed' && mongoose.connection.readyState === 1) {
    try {
      const {
        grantReferralBonusForFirstCompletedOrder,
      } = require('./referral.service');
      await grantReferralBonusForFirstCompletedOrder(order.userId);
    } catch (_) {}
  }

  const user = await User.findById(invoice.userId);
  if (user?.telegramId && bot?.telegram?.sendMessage) {
    const lang = user.language || 'ru';
    const prodName = product?.name || 'Товар';
    let text = '';

    if (orderStatus === 'completed' && allocatedKeys.length > 0) {
      const keysFormatted = allocatedKeys
        .map((k) => `<code>${escapeHtml(k.value)}</code>`)
        .join('\n');
      text =
        lang === 'en'
          ? `✅ <b>Order completed automatically!</b>\n\n` +
            `📦 Product: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Order: <code>${order._id}</code>\n` +
            `💰 Amount: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `🔑 <b>Your keys:</b>\n${keysFormatted}`
          : `✅ <b>Заказ выполнен автоматически!</b>\n\n` +
            `📦 Товар: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Заказ: <code>${order._id}</code>\n` +
            `💰 Сумма: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `🔑 <b>Ваши ключи:</b>\n${keysFormatted}`;
    } else if (orderStatus === 'awaiting_token') {
      text =
        lang === 'en'
          ? `✅ <b>Payment received!</b>\n\n` +
            `📦 Product: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Order: <code>${order._id}</code>\n` +
            `💰 Amount: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `⏳ Please send your session token to activate.`
          : `✅ <b>Оплата получена!</b>\n\n` +
            `📦 Товар: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Заказ: <code>${order._id}</code>\n` +
            `💰 Сумма: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `⏳ Пожалуйста, отправьте токен для активации.`;
    } else {
      text =
        lang === 'en'
          ? `✅ <b>Payment received!</b>\n\n` +
            `📦 Product: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Order: <code>${order._id}</code>\n` +
            `💰 Amount: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `⏳ Operator will issue your order shortly.`
          : `✅ <b>Оплата получена!</b>\n\n` +
            `📦 Товар: <b>${escapeHtml(prodName)}</b>\n` +
            `📋 Заказ: <code>${order._id}</code>\n` +
            `💰 Сумма: <b>${invoice.baseAmount} USDT</b>\n` +
            `🔗 TxID: <code>${txId}</code>\n\n` +
            `⏳ Оператор скоро выдаст товар.`;
    }

    await bot.telegram
      .sendMessage(user.telegramId, text, { parse_mode: 'HTML' })
      .catch(() => {});
  }

  notif.notifyAdminNewOrder?.(order, user, product).catch?.(() => {});

  return { success: true, invoice, order };
};

/**
 * Tests connection to Bybit API with the configured credentials.
 * @returns {Promise<{ ok: boolean, retCode?: number, message: string, rowsCount?: number }>}
 */
const testConnection = async () => {
  const { apiKey, apiSecret } = await getBybitCredentials();
  if (!apiKey || !apiSecret) {
    return { ok: false, message: 'Bybit API-ключ или Secret не настроены в боте' };
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const qs = 'coin=USDT&limit=5';
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(timestamp + apiKey + recvWindow + qs)
    .digest('hex');

  const BYBIT_HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
  let lastRes = null;

  for (const host of BYBIT_HOSTS) {
    try {
      const res = await axios.get(
        `${host}/v5/asset/deposit/query-internal-record?${qs}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json',
            'X-BAPI-API-KEY': apiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN': signature,
            'X-BAPI-SIGN-TYPE': '2',
            'X-BAPI-RECV-WINDOW': recvWindow,
          },
          timeout: 10000,
          validateStatus: () => true,
        }
      );

      lastRes = res;
      if (res.status === 200 && res.data?.retCode === 0) {
        return {
          ok: true,
          retCode: 0,
          message: 'Bybit API подключён и работает! Доступ к истории переводов подтверждён.',
          rowsCount: res.data?.result?.rows?.length || 0,
        };
      }

      if (res.data?.retCode === 33004) {
        return {
          ok: false,
          retCode: 33004,
          message: 'Срок действия API-ключа истёк (Your api key has expired). Пересоздайте ключ в ЛК Bybit.',
        };
      }
    } catch (err) {
      lastRes = { status: 500, data: { retMsg: err.message } };
    }
  }

  return {
    ok: false,
    retCode: lastRes?.data?.retCode || lastRes?.status || 500,
    message: lastRes?.data?.retMsg || `Ошибка HTTP ${lastRes?.status || 500}`,
  };
};

module.exports = {
  allocateUniqueAmount,
  createInvoice,
  cancelInvoice,
  checkInvoice,
  getAdminUid,
  setBot,
  testConnection,
};

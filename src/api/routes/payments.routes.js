const express = require('express');
const mongoose = require('mongoose');
const BybitInvoice = require('../../models/BybitInvoice');
const TopupRequest = require('../../models/TopupRequest');
const bybitUidService = require('../../services/bybitUidPayment.service');
const plategaService = require('../../services/platega.service');
const currencyService = require('../../services/currency.service');
const blockchainService = require('../../services/blockchain.service');
const settingsCache = require('../../services/settingsCache.service');
const { authenticateToken } = require('../middlewares/auth.middleware');
const topupScene = require('../../bot/scenes/topup.scene');
const logger = require('../../config/logger');

const router = express.Router();

const checkWebMaintenance = (settings, user) => {
  if (settings?.webMaintenanceMode === true && !['admin', 'superadmin'].includes(user?.role)) {
    return {
      blocked: true,
      status: 503,
      body: {
        success: false,
        error: 'MAINTENANCE_MODE',
        message: 'Сайт находится на техническом обслуживании. Пожалуйста, попробуйте позже.',
      },
    };
  }
  return { blocked: false };
};

// ─── 0. Публичный Webhook для Platega.io (БЕЗ JWT) ────────────────
router.post('/webhook/platega', async (req, res) => {
  try {
    const isValid = await plategaService.verifyWebhookHeaders(req.headers);
    if (!isValid) {
      logger.warn('[Platega Webhook] Неверные заголовки мерчанта');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = req.body || {};
    logger.info(`[Platega Webhook API] Уведомление: id=${payload.id}, status=${payload.status}, amount=${payload.amount}`);

    const result = await topupScene.handlePlategaWebhook(payload);
    return res.status(200).json(result || { status: 'ok' });
  } catch (err) {
    logger.error(`[Platega Webhook API Error] ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
});

// ─── 1. Доступные способы оплаты (Публичный, только web* настройки) ─
router.get('/methods', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const plategaConfig = await plategaService.getPlategaConfig({ channel: 'web' });
    const rubRate = currencyService.getRate(settings);

    const methods = [
      {
        id: 'bybit_uid',
        name: 'Bybit UID (Внутренний перевод)',
        icon: '📊',
        currency: 'USDT',
        minAmount: 1.0,
        fee: 0,
        speed: 'Автоматически за 20 секунд',
        description: 'Без комиссии сети блокчейна. Перевод по UID внутри Bybit с точностью до 4 знаков.',
        enabled: settings?.webBybitUidEnabled !== false,
      },
      {
        id: 'platega_sbp',
        name: 'СБП (Система быстрых платежей Рубли)',
        icon: '💳',
        currency: 'RUB',
        minAmount: 1.0, // в USDT эквиваленте
        fee: 0,
        speed: 'Мгновенно по QR-коду',
        description: 'Оплата рублями через любое банковское приложение РФ по QR-коду СБП.',
        rateRub: rubRate,
        enabled: settings?.webPlategaEnabled !== false && plategaConfig?.enabled !== false,
      },
      {
        id: 'crypto_usdt_trc20',
        name: 'USDT (TRC-20)',
        icon: '💎',
        currency: 'USDT',
        network: 'TRC-20',
        minAmount: 5.0,
        speed: '1-3 минуты',
        description: 'Прямой перевод на адрес кошелька TRC-20 сети Tron.',
        enabled: settings?.webCryptoTrc20Enabled !== false && Boolean(settings?.bybitTrc20Address || settings?.topupWallet),
      },
      {
        id: 'crypto_usdt_bep20',
        name: 'USDT (BEP-20)',
        icon: '🟡',
        currency: 'USDT',
        network: 'BEP-20',
        minAmount: 5.0,
        speed: '1-2 минуты',
        description: 'Прямой перевод на адрес сети BNB Smart Chain.',
        enabled: settings?.webCryptoBep20Enabled !== false && Boolean(settings?.bybitBep20Address),
      },
      {
        id: 'crypto_ton',
        name: 'TON / USDT (TON)',
        icon: '💎',
        currency: 'TON',
        network: 'TON',
        minAmount: 1.0,
        speed: 'Мгновенно',
        description: 'Перевод через сеть The Open Network.',
        enabled: settings?.webCryptoTonEnabled !== false && Boolean(settings?.tonAddress),
      },
    ];

    return res.json({
      success: true,
      methods: methods.filter((m) => m.enabled),
      currentRateRub: rubRate,
      webMaintenanceMode: Boolean(settings?.webMaintenanceMode),
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка получения методов оплаты: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── Все последующие эндпоинты требуют JWT-аутентификации ──────────
router.use(authenticateToken);

// ─── 2. Bybit UID: Создание счёта ─────────────────────────────────
router.post('/bybit-uid/create', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const maint = checkWebMaintenance(settings, req.user);
    if (maint.blocked) {
      return res.status(maint.status).json(maint.body);
    }

    if (settings?.webBybitUidEnabled === false) {
      return res.status(403).json({
        success: false,
        error: 'PAYMENT_METHOD_DISABLED',
        message: 'Оплата через Bybit UID временно отключена на сайте',
      });
    }

    const { amount, orderId } = req.body;
    const baseAmount = Number(amount);

    if (!Number.isFinite(baseAmount) || baseAmount < 1.0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_AMOUNT',
        message: 'Минимальная сумма пополнения — 1.0 USDT',
      });
    }

    if (orderId && !mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const invoice = await bybitUidService.createInvoice({
      userId: req.user._id,
      orderId: orderId || null,
      baseAmount,
    });

    return res.json({
      success: true,
      invoice: {
        id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        baseAmount: invoice.baseAmount,
        exactAmount: invoice.exactAmount,
        adminUid: invoice.adminUid,
        status: invoice.status,
        expiresAt: invoice.expiresAt,
        createdAt: invoice.createdAt,
      },
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка создания счета Bybit UID: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── 3. Bybit UID: Polling статуса (только из MongoDB) ─────────────
router.get('/bybit-uid/status/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!mongoose.isValidObjectId(invoiceId)) {
      return res.status(400).json({ success: false, error: 'INVALID_INVOICE_ID' });
    }

    const invoice = await BybitInvoice.findById(invoiceId).lean();
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND' });
    }

    // IDOR защита
    if (invoice.userId.toString() !== req.user._id.toString() && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    return res.json({
      success: true,
      status: invoice.status,
      baseAmount: invoice.baseAmount,
      exactAmount: invoice.exactAmount,
      txId: invoice.txId || null,
      expiresAt: invoice.expiresAt,
      isExpired: new Date() > new Date(invoice.expiresAt) && invoice.status === 'pending',
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка статуса Bybit счета: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 4. Bybit UID: Принудительная ручная проверка (1 req/min) ──────
router.post('/bybit-uid/check/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!mongoose.isValidObjectId(invoiceId)) {
      return res.status(400).json({ success: false, error: 'INVALID_INVOICE_ID' });
    }

    const invoice = await BybitInvoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND' });
    }

    if (invoice.userId.toString() !== req.user._id.toString() && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    if (invoice.status === 'completed') {
      return res.json({ success: true, status: 'completed', alreadyCompleted: true });
    }

    // Вызов сервиса проверки
    const checkRes = await bybitUidService.checkInvoice(invoice._id, { dryRun: false });
    const freshInvoice = await BybitInvoice.findById(invoiceId).lean();

    return res.json({
      success: true,
      status: freshInvoice.status,
      result: checkRes,
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка ручной проверки Bybit счета: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── 5. Bybit UID: Отмена счёта (только при pending) ───────────────
router.post('/bybit-uid/cancel/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!mongoose.isValidObjectId(invoiceId)) {
      return res.status(400).json({ success: false, error: 'INVALID_INVOICE_ID' });
    }

    const invoice = await BybitInvoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND' });
    }

    if (invoice.userId.toString() !== req.user._id.toString() && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    if (invoice.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_CANCEL',
        message: 'Можно отменить только счёт в статусе ожидания перевода (pending)',
      });
    }

    await bybitUidService.cancelInvoice(invoice._id, req.user._id);

    return res.json({ success: true, message: 'Счёт успешно отменён' });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка отмены Bybit счета: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

// ─── 6. Platega СБП: Создание платежа ─────────────────────────────
router.post('/platega/create', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const maint = checkWebMaintenance(settings, req.user);
    if (maint.blocked) {
      return res.status(maint.status).json(maint.body);
    }

    const plategaConfig = await plategaService.getPlategaConfig({ channel: 'web' });
    if (settings?.webPlategaEnabled === false || plategaConfig?.enabled === false) {
      return res.status(403).json({
        success: false,
        error: 'PAYMENT_METHOD_DISABLED',
        message: 'Оплата через СБП временно отключена на сайте',
      });
    }

    const { amountUsdt, returnUrl } = req.body;
    const amountNum = Number(amountUsdt);

    if (!Number.isFinite(amountNum) || amountNum < 1.0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_AMOUNT',
        message: 'Минимальная сумма пополнения — 1.0 USDT',
      });
    }

    const amountRub = currencyService.toRub(amountNum, settings);
    const tempRequestId = new mongoose.Types.ObjectId();

    // Сначала вызываем API Platega
    let paymentResult;
    try {
      paymentResult = await plategaService.createPayment({
        amountRub,
        description: `Пополнение баланса #${req.user.telegramId}`,
        payload: tempRequestId.toString(),
        userId: req.user.telegramId,
        userName: req.user.username,
        returnUrl: returnUrl || undefined,
        channel: 'web',
      });
    } catch (plategaErr) {
      logger.error(`[PaymentsAPI] Ошибка API Platega: ${plategaErr.message}`);
      return res.status(502).json({
        success: false,
        error: 'GATEWAY_ERROR',
        message: 'Платёжный шлюз СБП временно недоступен. Пожалуйста, выберите другой способ оплаты.',
      });
    }

    // Сохраняем заявку в БД только после успешного ответа платёжного шлюза
    const request = new TopupRequest({
      _id: tempRequestId,
      userId: req.user._id,
      amount: amountNum,
      amountRub,
      method: 'platega',
      paymentId: paymentResult.transactionId,
      payUrl: paymentResult.payUrl,
      status: 'pending',
    });
    await request.save();

    return res.json({
      success: true,
      requestId: request._id,
      amountRub,
      amountUsdt: amountNum,
      payUrl: paymentResult.payUrl,
      transactionId: paymentResult.transactionId,
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка инициализации Platega: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 7. Platega СБП: Статус платежа ───────────────────────────────
router.get('/platega/status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.isValidObjectId(requestId)) {
      return res.status(400).json({ success: false, error: 'INVALID_REQUEST_ID' });
    }

    const request = await TopupRequest.findById(requestId).lean();
    if (!request) {
      return res.status(404).json({ success: false, error: 'REQUEST_NOT_FOUND' });
    }

    if (request.userId && request.userId.toString() !== req.user._id.toString() && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    return res.json({
      success: true,
      status: request.status,
      amountUsdt: request.amount,
      amountRub: request.amountRub,
      payUrl: request.payUrl,
      processedAt: request.processedAt,
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка статуса Platega: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 8. Crypto: Адреса кошельков для пополнения ───────────────────
router.get('/crypto/addresses', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();

    return res.json({
      success: true,
      wallets: {
        trc20: settings?.webCryptoTrc20Enabled !== false
          ? (settings?.bybitTrc20Address || settings?.topupWallet || null)
          : null,
        bep20: settings?.webCryptoBep20Enabled !== false
          ? (settings?.bybitBep20Address || null)
          : null,
        ton: settings?.webCryptoTonEnabled !== false
          ? (settings?.tonAddress || null)
          : null,
      },
      minDepositUsdt: 5.0,
      instructions: 'Отправляйте только точную валюту в выбранной сети. Зачисление после подтверждений сети.',
    });
  } catch (err) {
    logger.error(`[PaymentsAPI] Ошибка получения крипто адресов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 9. Crypto: Отправка TXID на проверку ─────────────────────────
router.post('/crypto/submit', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const maint = checkWebMaintenance(settings, req.user);
    if (maint.blocked) {
      return res.status(maint.status).json(maint.body);
    }

    const { network, amount, txid } = req.body;

    const netLower = String(network || '').toLowerCase().trim();
    if (!['trc20', 'bep20', 'ton'].includes(netLower)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_NETWORK',
        message: 'Поддерживаются сети: TRC20, BEP20, TON',
      });
    }

    const networkEnabled = {
      trc20: settings?.webCryptoTrc20Enabled !== false,
      bep20: settings?.webCryptoBep20Enabled !== false,
      ton: settings?.webCryptoTonEnabled !== false,
    };
    if (!networkEnabled[netLower]) {
      return res.status(403).json({
        success: false,
        error: 'PAYMENT_METHOD_DISABLED',
        message: `Пополнение через сеть ${netLower.toUpperCase()} временно отключено на сайте`,
      });
    }

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 1.0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_AMOUNT',
        message: 'Минимальная сумма — 1.0 USDT',
      });
    }

    const normalized = blockchainService.normalizeTxid(txid, netLower);
    if (!normalized.ok || !normalized.txid) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_TXID_FORMAT',
        message: 'Некорректный формат хеша транзакции (txid)',
      });
    }

    const cleanTxid = normalized.txid;

    // Pre-check на повторную отправку того же txid
    const existingReq = await TopupRequest.findOne({ txid: cleanTxid });
    if (existingReq) {
      return res.status(409).json({
        success: false,
        error: 'TXID_ALREADY_SUBMITTED',
        message: 'Данная транзакция уже была отправлена на проверку ранее',
      });
    }

    const existingBybit = await BybitInvoice.findOne({ txId: cleanTxid });
    if (existingBybit) {
      return res.status(409).json({
        success: false,
        error: 'TXID_ALREADY_SUBMITTED',
        message: 'Данная транзакция уже зачислена через систему Bybit',
      });
    }

    // Создаем заявку в статусе pending для асинхронной верификации
    const request = new TopupRequest({
      userId: req.user._id,
      amount: amountNum,
      method: `bybit_${netLower}`,
      network: netLower.toUpperCase(),
      txid: cleanTxid,
      status: 'pending',
    });
    await request.save();

    return res.json({
      success: true,
      message: 'Транзакция принята на проверку. Зачисление произойдёт после подтверждения блокчейна.',
      requestId: request._id,
      status: 'pending',
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'TXID_ALREADY_SUBMITTED',
        message: 'Данная транзакция уже была отправлена на проверку',
      });
    }
    logger.error(`[PaymentsAPI] Ошибка отправки TXID: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

module.exports = { paymentsRouter: router };

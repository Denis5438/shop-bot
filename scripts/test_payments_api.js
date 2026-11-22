const assert = require('assert');
const mongoose = require('mongoose');

// Mock data stores
const invoices = [];
const topupRequests = [];
const users = [];

// Stubs for Models and Services
const BybitInvoice = require('../src/models/BybitInvoice');
const TopupRequest = require('../src/models/TopupRequest');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const settingsCache = require('../src/services/settingsCache.service');
const topupScene = require('../src/bot/scenes/topup.scene');
const bybitUidService = require('../src/services/bybitUidPayment.service');
const plategaService = require('../src/services/platega.service');
const currencyService = require('../src/services/currency.service');
const { signUserToken } = require('../src/api/middlewares/auth.middleware');

// Setup Settings Cache Stub
settingsCache.getSettings = async () => ({
  bybitUid: '547343159',
  bybitTrc20Address: 'TX11111111111111111111111111111111',
  bybitBep20Address: '0x2222222222222222222222222222222222222222',
  tonAddress: 'EQ3333333333333333333333333333333333333333333333',
  plategaEnabled: true,
  bybitEnabled: true,
});

topupScene.handlePlategaWebhook = async () => ({ status: 'ok', credited: true });

// Setup User Stub
User.findOne = async (filter) => {
  return users.find((u) => u.telegramId === filter.telegramId) || null;
};

// Setup Currency Stub
currencyService.getRate = () => 92.5;
currencyService.toRub = (usdt) => Math.round(usdt * 92.5);

// Setup BybitInvoice stubs
BybitInvoice.findById = (id) => {
  const inv = invoices.find((i) => String(i._id) === String(id));
  return {
    lean: async () => (inv ? { ...inv } : null),
    then: (resolve) => resolve(inv || null),
  };
};

BybitInvoice.findOne = (filter) => {
  const inv = invoices.find((i) => {
    if (filter._id && String(i._id) !== String(filter._id)) return false;
    if (filter.txId && i.txId !== filter.txId) return false;
    return true;
  });
  return {
    lean: async () => (inv ? { ...inv } : null),
    then: (resolve) => resolve(inv || null),
  };
};

BybitInvoice.prototype.save = async function () {
  const existingIdx = invoices.findIndex((i) => String(i._id) === String(this._id));
  if (existingIdx >= 0) invoices[existingIdx] = this;
  else invoices.push(this);
  return this;
};

// Setup TopupRequest stubs
TopupRequest.findById = (id) => {
  const req = topupRequests.find((r) => String(r._id) === String(id));
  return {
    lean: async () => (req ? (req.toObject ? req.toObject() : { ...req }) : null),
    then: (resolve) => resolve(req || null),
  };
};

TopupRequest.findOne = (filter) => {
  const req = topupRequests.find((r) => {
    const obj = r.toObject ? r.toObject() : r;
    if (filter._id && String(obj._id) !== String(filter._id)) return false;
    if (filter.txid && obj.txid !== filter.txid) return false;
    if (filter.paymentId && obj.paymentId !== filter.paymentId) return false;
    return true;
  });
  return {
    lean: async () => (req ? (req.toObject ? req.toObject() : { ...req }) : null),
    then: (resolve) => resolve(req || null),
  };
};

TopupRequest.prototype.save = async function () {
  const existingIdx = topupRequests.findIndex((r) => String(r._id) === String(this._id));
  if (existingIdx >= 0) topupRequests[existingIdx] = this;
  else topupRequests.push(this);
  return this;
};

// Setup Bybit Service Stubs
bybitUidService.createInvoice = async ({ userId, baseAmount, orderId }) => {
  const inv = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: `INV-${Date.now()}`,
    userId,
    orderId: orderId || null,
    baseAmount,
    exactAmount: Number((baseAmount + 0.0037).toFixed(4)),
    adminUid: '547343159',
    status: 'pending',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    save: async function () { return this; },
  };
  invoices.push(inv);
  return inv;
};

bybitUidService.cancelInvoice = async (invoiceId) => {
  const inv = invoices.find((i) => String(i._id) === String(invoiceId));
  if (inv) inv.status = 'cancelled';
  return inv;
};

bybitUidService.checkInvoice = async (invoiceId) => {
  const inv = invoices.find((i) => String(i._id) === String(invoiceId));
  return { matched: false, status: inv?.status || 'pending' };
};

// Setup Platega Service Stubs
plategaService.createPayment = async ({ amountRub, payload }) => {
  return {
    transactionId: `plt_tx_${Date.now()}`,
    payUrl: `https://pay.platega.io/process/${payload}`,
  };
};

plategaService.verifyWebhookHeaders = async (headers) => {
  return headers['x-merchantid'] === 'valid_merchant';
};

// Import Router
const { paymentsRouter } = require('../src/api/routes/payments.routes');

// Helper to invoke Express Router directly
const invokeRoute = (router, method, url, { body = {}, query = {}, headers = {}, user = null } = {}) => {
  return new Promise((resolve) => {
    const [pathOnly, queryString] = url.split('?');
    const parsedQuery = { ...query };
    if (queryString) {
      const qParams = new URLSearchParams(queryString);
      for (const [k, v] of qParams.entries()) {
        parsedQuery[k] = v;
      }
    }

    const req = {
      method: method.toUpperCase(),
      url: pathOnly,
      originalUrl: url,
      headers: { host: 'localhost', ...headers },
      cookies: {},
      query: parsedQuery,
      params: {},
      body: { ...body },
      user: user,
    };

    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; resolve({ status: this.statusCode, body: data }); return this; },
      send(data) { this.body = data; resolve({ status: this.statusCode, body: data }); return this; },
    };

    router.handle(req, res, (err) => {
      if (err) resolve({ status: 500, error: err.message });
      else resolve({ status: 404, body: { error: 'NOT_FOUND' } });
    });
  });
};

async function runTests() {
  console.log('=== Запуск комплексных тестов REST API Фазы 3 (Платежи: Bybit UID, Platega СБП, Крипта) ===\n');

  let passed = 0;
  let failed = 0;

  const check = (cond, msg) => {
    if (cond) {
      console.log(`  [PASS] ${msg}`);
      passed += 1;
    } else {
      console.error(`  [FAIL] ${msg}`);
      failed += 1;
    }
  };

  try {
    const userId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();

    const testUser = {
      _id: userId,
      telegramId: 8880001,
      username: 'payer_user',
      role: 'user',
      balance: 10.0,
      isBanned: false,
    };
    users.push(testUser);

    const strangerUser = {
      _id: strangerId,
      telegramId: 8880002,
      username: 'stranger_user',
      role: 'user',
      balance: 5.0,
      isBanned: false,
    };
    users.push(strangerUser);

    const token = signUserToken(testUser);
    const strangerToken = signUserToken(strangerUser);

    // ─── 1. Методы оплаты ─────────────────────────────────────────
    console.log('1. Тестирование GET /methods:');
    const methodsRes = await invokeRoute(paymentsRouter, 'GET', '/methods');
    check(methodsRes.status === 200 && methodsRes.body.success === true, 'GET /methods возвращает 200 OK');
    const bybitMethod = methodsRes.body.methods.find((m) => m.id === 'bybit_uid');
    const sbpMethod = methodsRes.body.methods.find((m) => m.id === 'platega_sbp');
    const trcMethod = methodsRes.body.methods.find((m) => m.id === 'crypto_usdt_trc20');
    check(bybitMethod && bybitMethod.minAmount === 1.0, 'Bybit UID доступен с мин. суммой 1.0 USDT');
    check(sbpMethod && sbpMethod.rateRub === 92.5, 'Platega СБП возвращает актуальный курс 92.5 RUB');
    check(trcMethod && trcMethod.network === 'TRC-20', 'TRC-20 сеть доступна в списке');

    // ─── 2. Bybit UID ─────────────────────────────────────────────
    console.log('\n2. Тестирование Bybit UID (создание, опрос, отмена):');

    // POST /bybit-uid/create без токена -> 401
    const unauthCreate = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
      body: { amount: 15.0 },
    });
    check(unauthCreate.status === 401, 'POST /bybit-uid/create без токена блокируется (401)');

    // POST /bybit-uid/create с суммой < 1.0 -> 400
    const lowAmountRes = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
      headers: { authorization: `Bearer ${token}` },
      body: { amount: 0.5 },
    });
    check(lowAmountRes.status === 400 && lowAmountRes.body.error === 'INVALID_AMOUNT', 'POST /bybit-uid/create блокирует сумму < 1.0 USDT');

    // POST /bybit-uid/create успешное создание счёта
    const invoiceRes = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
      headers: { authorization: `Bearer ${token}` },
      body: { amount: 25.0 },
    });
    check(invoiceRes.status === 200 && invoiceRes.body.success === true, 'POST /bybit-uid/create создаёт счёт');
    check(invoiceRes.body.invoice.exactAmount === 25.0037, 'Точная сумма с 4-значным центом: 25.0037 USDT');
    check(invoiceRes.body.invoice.adminUid === '547343159', 'Админский UID получателя указан');

    const createdInvoiceId = invoiceRes.body.invoice.id;

    // GET /bybit-uid/status/:id — опрос статуса
    const statusRes = await invokeRoute(paymentsRouter, 'GET', `/bybit-uid/status/${createdInvoiceId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check(statusRes.status === 200 && statusRes.body.status === 'pending', 'GET /bybit-uid/status возвращает pending напрямую из БД');

    // IDOR защита: чужой пользователь опрашивает счёт -> 403
    const idorStatusRes = await invokeRoute(paymentsRouter, 'GET', `/bybit-uid/status/${createdInvoiceId}`, {
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    check(idorStatusRes.status === 403, 'GET /bybit-uid/status блокирует чужого пользователя (403 FORBIDDEN)');

    // POST /bybit-uid/cancel/:id отмена счёта
    const cancelRes = await invokeRoute(paymentsRouter, 'POST', `/bybit-uid/cancel/${createdInvoiceId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check(cancelRes.status === 200 && cancelRes.body.success === true, 'POST /bybit-uid/cancel успешно отменяет счёт');

    // Повторная отмена уже отменённого счёта -> 400
    const cancelAgainRes = await invokeRoute(paymentsRouter, 'POST', `/bybit-uid/cancel/${createdInvoiceId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check(cancelAgainRes.status === 400 && cancelAgainRes.body.error === 'CANNOT_CANCEL', 'Отмена не-pending счёта блокируется');

    // ─── 3. Platega СБП ───────────────────────────────────────────
    console.log('\n3. Тестирование Platega СБП:');

    // POST /platega/create
    const plategaRes = await invokeRoute(paymentsRouter, 'POST', '/platega/create', {
      headers: { authorization: `Bearer ${token}` },
      body: { amountUsdt: 10.0 },
    });
    check(plategaRes.status === 200 && plategaRes.body.success === true, 'POST /platega/create создаёт платёж');
    check(plategaRes.body.amountRub === 925, 'Конвертация 10 USDT * 92.5 = 925 RUB');
    check(plategaRes.body.payUrl.startsWith('https://pay.platega.io'), 'Возвращает URL оплаты СБП');

    const plategaRequestId = plategaRes.body.requestId;

    // GET /platega/status/:id
    const plategaStatusRes = await invokeRoute(paymentsRouter, 'GET', `/platega/status/${plategaRequestId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check(plategaStatusRes.status === 200 && plategaStatusRes.body.status === 'pending', 'GET /platega/status возвращает статус заявки');

    // Webhook Platega без заголовков авторизации -> 401
    const badWebhookRes = await invokeRoute(paymentsRouter, 'POST', '/webhook/platega', {
      headers: { 'x-merchantid': 'wrong_merchant' },
      body: { id: 'tx_999', status: 'CONFIRMED' },
    });
    check(badWebhookRes.status === 401, 'POST /webhook/platega блокирует неавторизованные уведомления (401)');

    // ─── 4. Crypto (TRC20 / BEP20 / TON) ──────────────────────────
    console.log('\n4. Тестирование Крипто-депозитов:');

    // GET /crypto/addresses без токена -> 401
    const unauthAddrs = await invokeRoute(paymentsRouter, 'GET', '/crypto/addresses');
    check(unauthAddrs.status === 401, 'GET /crypto/addresses требует аутентификации (401)');

    // GET /crypto/addresses с токеном -> 200 с адресами
    const addrsRes = await invokeRoute(paymentsRouter, 'GET', '/crypto/addresses', {
      headers: { authorization: `Bearer ${token}` },
    });
    check(addrsRes.status === 200 && addrsRes.body.wallets.trc20.startsWith('TX111'), 'GET /crypto/addresses возвращает TRC20 адрес');
    check(addrsRes.body.wallets.bep20.startsWith('0x222'), 'GET /crypto/addresses возвращает BEP20 адрес');

    // POST /crypto/submit с неверным форматом txid -> 400
    const invalidTxidRes = await invokeRoute(paymentsRouter, 'POST', '/crypto/submit', {
      headers: { authorization: `Bearer ${token}` },
      body: { network: 'trc20', amount: 50.0, txid: 'not_a_valid_hash' },
    });
    check(invalidTxidRes.status === 400 && invalidTxidRes.body.error === 'INVALID_TXID_FORMAT', 'POST /crypto/submit блокирует некорректный txid');

    // POST /crypto/submit с валидным txid -> 200
    const validTxid = 'a'.repeat(64);
    const submitRes = await invokeRoute(paymentsRouter, 'POST', '/crypto/submit', {
      headers: { authorization: `Bearer ${token}` },
      body: { network: 'trc20', amount: 50.0, txid: validTxid },
    });
    check(submitRes.status === 200 && submitRes.body.success === true, 'POST /crypto/submit успешно регистрирует txid');

    // Повторная отправка того же txid -> 409 TXID_ALREADY_SUBMITTED
    const duplicateRes = await invokeRoute(paymentsRouter, 'POST', '/crypto/submit', {
      headers: { authorization: `Bearer ${token}` },
      body: { network: 'trc20', amount: 50.0, txid: validTxid },
    });
    check(duplicateRes.status === 409 && duplicateRes.body.error === 'TXID_ALREADY_SUBMITTED', 'Повторная отправка того же txid блокируется с 409');

    console.log(`\n=== Результат: ${passed} прошло, ${failed} ошибок ===`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Ошибка тестов платежей:', err);
    process.exit(1);
  }
}

runTests();

const assert = require('assert');
const mongoose = require('mongoose');

// Mock data store
const categories = [];
const products = [];
const keys = [];
const orders = [];
const users = [];

// Stubs for Models
const Category = require('../src/models/Category');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');
const Order = require('../src/models/Order');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const Transaction = require('../src/models/Transaction');
const { signUserToken } = require('../src/api/middlewares/auth.middleware');

// Setup Mongoose Stubs
Transaction.prototype.save = async function () { return this; };

const referralService = require('../src/services/referral.service');
referralService.grantReferralBonusForFirstCompletedOrder = async () => true;

Settings.findOne = () => ({
  lean: async () => ({
    smartPricing: false,
    autoMarkdownEnabled: false,
  }),
});

mongoose.startSession = async () => ({
  withTransaction: async (cb) => cb({}),
  endSession: async () => {},
});

// Category stubs
Category.find = () => ({
  sort: () => ({
    lean: async () => categories.filter((c) => c.isActive !== false),
  }),
});

// Product stubs
Product.aggregate = async () => {
  const map = {};
  for (const p of products) {
    if (p.isActive && p.categoryId) {
      map[p.categoryId] = (map[p.categoryId] || 0) + 1;
    }
  }
  return Object.entries(map).map(([k, v]) => ({ _id: k, count: v }));
};

Product.find = (filter) => {
  let list = products.filter((p) => p.isActive);
  if (filter?.categoryId) {
    list = list.filter((p) => String(p.categoryId) === String(filter.categoryId));
  }
  let shouldPopulate = false;
  const q = {
    populate() { shouldPopulate = true; return q; },
    sort() { return q; },
    select() { return q; },
    skip() { return q; },
    limit() { return q; },
    lean: async () => list.map((p) => ({
      ...p,
      categoryId: shouldPopulate
        ? (categories.find((c) => String(c._id) === String(p.categoryId)) || null)
        : p.categoryId,
    })),
  };
  return q;
};

Product.countDocuments = async (filter) => {
  let list = products.filter((p) => p.isActive);
  if (filter?.categoryId) {
    list = list.filter((p) => String(p.categoryId) === String(filter.categoryId));
  }
  return list.length;
};

Product.findOne = (filter) => {
  const prod = products.find((p) => String(p._id) === String(filter._id));
  return {
    populate: () => ({
      lean: async () => {
        if (!prod || !prod.isActive) return null;
        return {
          ...prod,
          categoryId: categories.find((c) => String(c._id) === String(prod.categoryId)) || null,
        };
      },
    }),
    session: () => prod || null,
    then: (resolve) => resolve(prod || null),
  };
};

Product.updateOne = async (filter, update) => {
  const prod = products.find((p) => String(p._id) === String(filter._id));
  if (prod && update.$set) Object.assign(prod, update.$set);
  return { modifiedCount: 1 };
};

// Key stubs
Key.countDocuments = async (filter) => {
  return keys.filter((k) => String(k.productId) === String(filter.productId) && k.isUsed === filter.isUsed).length;
};

Key.aggregate = async () => {
  const groups = new Map();
  for (const k of keys) {
    if (k.isUsed) continue;
    const pid = String(k.productId);
    const prov = k.provider || null;
    const gKey = `${pid}:${prov || '__null__'}`;
    if (!groups.has(gKey)) {
      groups.set(gKey, { _id: { productId: k.productId, provider: prov }, count: 0 });
    }
    groups.get(gKey).count += 1;
  }
  return Array.from(groups.values());
};

Key.findOneAndUpdate = async (filter, update) => {
  const key = keys.find((k) => String(k.productId) === String(filter.productId) && k.isUsed === false);
  if (!key) return null;
  if (update.$set) Object.assign(key, update.$set);
  return key;
};

Key.updateOne = async (filter, update) => {
  const key = keys.find((k) => String(k._id) === String(filter._id));
  if (key && update.$set) Object.assign(key, update.$set);
  return { modifiedCount: 1 };
};

// User stubs
User.findById = (id) => {
  const u = users.find((x) => String(x._id) === String(id));
  return {
    populate: () => ({
      then: (resolve) => {
        if (!u) return resolve(null);
        const cloned = { ...u };
        cloned.cart = u.cart.map((it) => {
          const p = products.find((prod) => String(prod._id) === String(it.productId));
          return {
            ...it,
            productId: p ? { ...p, categoryId: categories.find((c) => String(c._id) === String(p.categoryId)) } : null,
          };
        });
        return resolve(cloned);
      },
    }),
    select: () => ({
      session: () => u || null,
      then: (resolve) => resolve(u || null),
    }),
    then: (resolve) => resolve(u || null),
  };
};

User.findOne = async (filter) => {
  return users.find((u) => u.telegramId === filter.telegramId) || null;
};

User.findOneAndUpdate = async (filter, update) => {
  const u = users.find((x) => String(x._id) === String(filter._id));
  if (!u) {
    console.log('User.findOneAndUpdate: user not found', filter._id);
    return null;
  }
  if (filter.balance && filter.balance.$gte && u.balance < filter.balance.$gte) {
    console.log('User.findOneAndUpdate: balance not enough', u.balance, '<', filter.balance.$gte);
    return null;
  }
  if (filter.cartVersion !== undefined && u.cartVersion !== filter.cartVersion) {
    console.log('User.findOneAndUpdate: cartVersion mismatch', u.cartVersion, '!==', filter.cartVersion);
    return null;
  }
  if (update.$inc) {
    if (update.$inc.balance) u.balance += update.$inc.balance;
    if (update.$inc.totalSpent) u.totalSpent = (u.totalSpent || 0) + update.$inc.totalSpent;
    if (update.$inc.cartVersion) u.cartVersion = (u.cartVersion || 0) + update.$inc.cartVersion;
  }
  if (update.$set) {
    if (update.$set.cart) u.cart = [...update.$set.cart];
    if (update.$set.activePromoCode !== undefined) u.activePromoCode = update.$set.activePromoCode;
  }
  return u;
};

User.updateOne = async (filter, update) => {
  const u = users.find((x) => String(x._id) === String(filter._id));
  if (u) {
    if (update.$pull?.cart) {
      u.cart = u.cart.filter((it) => String(it.productId) !== String(update.$pull.cart.productId));
    }
    if (update.$set) Object.assign(u, update.$set);
    if (update.$inc?.cartVersion) u.cartVersion = (u.cartVersion || 0) + update.$inc.cartVersion;
  }
  return { modifiedCount: 1 };
};

// Order stubs
Order.prototype.save = async function () {
  orders.push(this);
  return this;
};

Order.find = (filter) => {
  let list = orders.filter((o) => String(o.userId) === String(filter.userId));
  return {
    populate: () => ({
      populate: () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              lean: async () => list.map((o) => ({
                ...o.toObject ? o.toObject() : o,
                _id: o._id || o.id,
                productId: products.find((p) => String(p._id) === String(o.productId)) || null,
                keyId: keys.find((k) => String(k._id) === String(o.keyId)) || null,
              })),
            }),
          }),
        }),
      }),
    }),
  };
};

Order.countDocuments = async (filter) => {
  return orders.filter((o) => String(o.userId) === String(filter.userId)).length;
};

Order.findById = (id) => {
  const o = orders.find((x) => String(x._id || x.id) === String(id));
  return {
    lean: async () => (o ? (o.toObject ? o.toObject() : { ...o }) : null),
    populate: () => ({
      populate: () => ({
        lean: async () => {
          if (!o) return null;
          const obj = o.toObject ? o.toObject() : { ...o };
          return {
            ...obj,
            _id: obj._id || o._id,
            productId: products.find((p) => String(p._id) === String(o.productId)) || null,
            keyId: keys.find((k) => String(k._id) === String(o.keyId)) || null,
          };
        },
      }),
    }),
    then: (resolve) => resolve(o || null),
  };
};

// Import Routers
const { catalogRouter } = require('../src/api/routes/catalog.routes');
const { cartRouter } = require('../src/api/routes/cart.routes');
const { ordersRouter } = require('../src/api/routes/orders.routes');

const notif = require('../src/services/notification.service');
notif.notifyAdminNewOrder = async () => true;
notif.notifySellerNewOrder = async () => true;

// Helper to invoke Express Router directly without TCP socket
const invokeRoute = (router, method, url, { body = {}, query = {}, headers = {}, cookies = {}, user = null } = {}) => {
  return new Promise((resolve) => {
    // Parse query params from url if any
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
      cookies: { ...cookies },
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
  console.log('=== Запуск комплексных тестов REST API Фазы 2 (Каталог, Корзина, Заказы) ===\n');

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
    // Подготовка тестовых данных
    const catId = new mongoose.Types.ObjectId();
    const prodId = new mongoose.Types.ObjectId();
    const keyId1 = new mongoose.Types.ObjectId();
    const keyId2 = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();

    categories.push({
      _id: catId,
      name: 'Подписки & ИИ',
      icon: '🤖',
      sortOrder: 0,
      isActive: true,
    });

    products.push({
      _id: prodId,
      name: 'ChatGPT Plus 1 месяц',
      nameEn: 'ChatGPT Plus 1 month',
      description: 'Лицензионный доступ',
      price: 20.0,
      costPrice: 15.0,
      type: 'key',
      deliveryMethod: 'ready_account',
      categoryId: catId,
      isActive: true,
      warrantyDays: 14,
      subscriptionDays: 30,
      save: async function () { return this; },
    });

    keys.push({
      _id: keyId1,
      productId: prodId,
      value: 'TEST-KEY-ALPHA-123',
      isUsed: false,
      createdAt: new Date(),
    });

    keys.push({
      _id: keyId2,
      productId: prodId,
      value: 'TEST-KEY-BETA-456',
      isUsed: false,
      createdAt: new Date(),
    });

    const testUser = {
      _id: userId,
      telegramId: 7770001,
      username: 'test_client',
      role: 'user',
      balance: 50.0,
      cart: [],
      cartVersion: 0,
      isBanned: false,
      save: async function () { return this; },
    };
    users.push(testUser);

    const strangerUser = {
      _id: strangerId,
      telegramId: 7770002,
      username: 'stranger_client',
      role: 'user',
      balance: 10.0,
      cart: [],
      cartVersion: 0,
      isBanned: false,
      save: async function () { return this; },
    };
    users.push(strangerUser);

    const token = signUserToken(testUser);
    const strangerToken = signUserToken(strangerUser);

    // ─── 1. Каталог ──────────────────────────────────────────────
    console.log('1. Тестирование эндпоинтов Каталога:');

    // GET /categories
    const catRes = await invokeRoute(catalogRouter, 'GET', '/categories');
    check(catRes.status === 200 && catRes.body.success === true, 'GET /categories возвращает 200 OK');
    check(catRes.body.categories[0].productCount === 1, 'GET /categories агрегирует productCount = 1');
    check(catRes.body.totalProducts === 1, 'GET /categories возвращает totalProducts');

    // GET /products
    const prodRes = await invokeRoute(catalogRouter, 'GET', `/products?categoryId=${catId}`);
    check(prodRes.status === 200 && prodRes.body.products.length === 1, 'GET /products фильтрует по categoryId');
    check(prodRes.body.products[0].stockCount === 2, 'GET /products возвращает точный stockCount (2 ключа)');
    check(prodRes.body.products[0].effectivePrice === 20.0, 'GET /products вычисляет effectivePrice');
    check(!prodRes.body.products[0].keyId && !prodRes.body.products[0].tokenRaw, 'GET /products скрывает приватные поля ключей/токенов');

    // GET /products/:id
    const singleRes = await invokeRoute(catalogRouter, 'GET', `/products/${prodId}`);
    check(singleRes.status === 200 && singleRes.body.product.id.toString() === prodId.toString(), 'GET /products/:id возвращает карточку товара');

    // ─── 2. Корзина ──────────────────────────────────────────────
    console.log('\n2. Тестирование эндпоинтов Корзины:');

    // GET /cart без авторизации -> 401
    const unauthRes = await invokeRoute(cartRouter, 'GET', '/');
    check(unauthRes.status === 401, 'GET /cart без токена блокируется (401 AUTHENTICATION_REQUIRED)');

    // POST /cart/items с qty > stock -> 400 EXCEEDS_AVAILABLE_STOCK
    const overstockRes = await invokeRoute(cartRouter, 'POST', '/items', {
      headers: { authorization: `Bearer ${token}` },
      body: { productId: prodId.toString(), qty: 10 },
    });
    check(overstockRes.status === 400 && overstockRes.body.error === 'EXCEEDS_AVAILABLE_STOCK', 'POST /cart/items блокирует превышение остатка склада');

    // POST /cart/items с валидным qty = 1
    const addRes = await invokeRoute(cartRouter, 'POST', '/items', {
      headers: { authorization: `Bearer ${token}` },
      body: { productId: prodId.toString(), qty: 1 },
    });
    check(addRes.status === 200 && addRes.body.success === true, 'POST /cart/items успешно добавляет товар в корзину');

    // GET /cart проверяем состав
    const cartRes = await invokeRoute(cartRouter, 'GET', '/', {
      headers: { authorization: `Bearer ${token}` },
    });
    check(cartRes.body.cart.items.length === 1 && cartRes.body.cart.finalTotal === 20.0, 'GET /cart возвращает итоговую сумму 20.0 USDT');
    check(cartRes.body.cart.canCheckout === true, 'GET /cart confirms canCheckout = true (баланс 50 >= 20)');

    const currentCartVersion = cartRes.body.cart.cartVersion;

    // ─── 3. Чекаут и Заказы ───────────────────────────────────────
    console.log('\n3. Тестирование Чекаута и Заказов:');

    // POST /orders/checkout без cartVersion -> 400 CART_VERSION_REQUIRED
    const noVerRes = await invokeRoute(ordersRouter, 'POST', '/checkout', {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    check(noVerRes.status === 400 && noVerRes.body.error === 'CART_VERSION_REQUIRED', 'POST /orders/checkout требует cartVersion');

    // POST /orders/checkout с устаревшей версией -> 409 CART_CHANGED
    const staleRes = await invokeRoute(ordersRouter, 'POST', '/checkout', {
      headers: { authorization: `Bearer ${token}` },
      body: { cartVersion: 999 },
    });
    check(staleRes.status === 409, 'POST /orders/checkout возвращает 409 CART_CHANGED при несовпадении версии');

    // POST /orders/checkout успешный заказ
    const checkoutRes = await invokeRoute(ordersRouter, 'POST', '/checkout', {
      headers: { authorization: `Bearer ${token}` },
      body: { cartVersion: currentCartVersion },
    });
    console.log('checkoutRes output:', JSON.stringify(checkoutRes));
    check(checkoutRes.status === 200 && checkoutRes.body.success === true, 'POST /orders/checkout успешно оформляет заказ');
    check(checkoutRes.body.newBalance === 30.0, 'POST /orders/checkout атомарно списал баланс (50 - 20 = 30)');
    check(checkoutRes.body.deliveryReports[0].data === 'TEST-KEY-ALPHA-123', 'POST /orders/checkout мгновенно выдал цифровой ключ');

    const createdOrderId = checkoutRes.body.deliveryReports[0].orderId;

    // GET /orders список
    const ordersRes = await invokeRoute(ordersRouter, 'GET', '/', {
      headers: { authorization: `Bearer ${token}` },
    });
    check(ordersRes.body.orders.length === 1 && ordersRes.body.orders[0].id.toString() === createdOrderId.toString(), 'GET /orders возвращает заказ');
    check(ordersRes.body.orders[0].key === 'TEST-KEY-ALPHA-123', 'GET /orders показывает ключ для completed заказа');

    // ─── 4. Безопасность и IDOR ──────────────────────────────────
    console.log('\n4. Тестирование Безопасности и IDOR:');

    // Чужой пользователь пытается открыть заказ -> 403
    const idorRes = await invokeRoute(ordersRouter, 'GET', `/${createdOrderId}`, {
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    check(idorRes.status === 403, 'GET /orders/:id блокирует чужого пользователя (403 FORBIDDEN, IDOR защита)');

    // Владелец заказа открывает заказ -> 200
    const ownerRes = await invokeRoute(ordersRouter, 'GET', `/${createdOrderId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check(ownerRes.status === 200 && ownerRes.body.order.key === 'TEST-KEY-ALPHA-123', 'GET /orders/:id возвращает заказ с ключом законному владельцу');

    console.log(`\n=== Результат: ${passed} прошло, ${failed} ошибок ===`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Ошибка выполнения тестов:', err);
    process.exit(1);
  }
}

runTests();

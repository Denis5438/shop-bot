const assert = require('assert');
const mongoose = require('mongoose');

// Models
const Settings = require('../src/models/Settings');
const User = require('../src/models/User');
const Category = require('../src/models/Category');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');
const Order = require('../src/models/Order');
const PromoCode = require('../src/models/PromoCode');
const PromoUsage = require('../src/models/PromoUsage');
const SupplierConfig = require('../src/models/SupplierConfig');
const TopupRequest = require('../src/models/TopupRequest');
const SellerWithdrawal = require('../src/models/SellerWithdrawal');
const Seller = require('../src/models/Seller');
const Transaction = require('../src/models/Transaction');
const BybitInvoice = require('../src/models/BybitInvoice');

// Services & Middlewares
const settingsCache = require('../src/services/settingsCache.service');
const plategaService = require('../src/services/platega.service');
const currencyService = require('../src/services/currency.service');
const bybitUidService = require('../src/services/bybitUidPayment.service');
const supplierManager = require('../src/services/supplierManager.service');
const supplierLiveSync = require('../src/services/supplierLiveSync.service');
const notif = require('../src/services/notification.service');
const referralService = require('../src/services/referral.service');
const { signUserToken, requireAdmin, requireSuperAdmin } = require('../src/api/middlewares/auth.middleware');

// Routers
const { paymentsRouter } = require('../src/api/routes/payments.routes');
const { catalogRouter } = require('../src/api/routes/catalog.routes');
const { ordersRouter } = require('../src/api/routes/orders.routes');
const { adminRouter } = require('../src/api/routes/admin.routes');
const app = require('../src/api/index');

// In-memory DB stores
const stores = {
  users: [],
  categories: [],
  products: [],
  keys: [],
  orders: [],
  promos: [],
  promoUsages: [],
  suppliers: [],
  topups: [],
  withdrawals: [],
  sellers: [],
  transactions: [],
  bybitInvoices: [],
  settingsDoc: null,
};

let insertManyCalls = [];
let waitlistNotifiedProducts = [];
let sentMessages = [];

// Helper to create Express mock call
const invokeRoute = (router, method, url, { body = {}, query = {}, headers = {}, cookies = {} } = {}) => {
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
      cookies: { ...cookies },
      query: parsedQuery,
      params: {},
      body: { ...body },
      socket: { remoteAddress: '127.0.0.1' },
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

// Chainable query helper
const makeQuery = (resultPromise) => {
  const q = {
    select() { return q; },
    populate() { return q; },
    sort() { return q; },
    skip(n) { q._skip = n; return q; },
    limit(n) { q._limit = n; return q; },
    session() { return q; },
    lean() {
      return resultPromise().then((res) => {
        if (Array.isArray(res)) {
          let arr = res;
          if (q._skip) arr = arr.slice(q._skip);
          if (q._limit) arr = arr.slice(0, q._limit);
          return arr.map((item) => (item?.toObject ? item.toObject({ getters: true }) : { ...item }));
        }
        return res?.toObject ? res.toObject({ getters: true }) : (res ? { ...res } : null);
      });
    },
    then(resolve, reject) {
      return resultPromise().then((res) => {
        if (Array.isArray(res)) {
          let arr = res;
          if (q._skip) arr = arr.slice(q._skip);
          if (q._limit) arr = arr.slice(0, q._limit);
          return arr;
        }
        return res;
      }).then(resolve, reject);
    },
  };
  return q;
};

function setupStubs() {
  // Mongoose session mock
  mongoose.startSession = async () => ({
    withTransaction: async (cb) => cb({}),
    endSession: async () => {},
  });

  // Currency
  currencyService.getRate = (s) => (s?.currencyMode === 'manual' ? (s.manualRate || 95) : 92.5);
  currencyService.getBaseRate = () => 92.5;
  currencyService.getUpdatedAt = () => '25.11.2026, 03:00:00';
  currencyService.toRub = (amt, s) => Math.round(Number(amt) * currencyService.getRate(s));
  currencyService.fetchRate = async () => 93.0;

  // Settings
  stores.settingsDoc = new Settings({
    name: 'global',
    maintenanceMode: false,
    plategaEnabled: true,
    cardEnabled: true,
    bybitEnabled: true,
    webMaintenanceMode: false,
    webPlategaEnabled: true,
    webBybitUidEnabled: true,
    webCryptoTrc20Enabled: true,
    webCryptoBep20Enabled: true,
    webCryptoTonEnabled: true,
    bybitUid: '547343159',
    bybitTrc20Address: 'TX11111111111111111111111111111111',
    bybitBep20Address: '0x2222222222222222222222222222222222222222',
    tonAddress: 'EQ3333333333333333333333333333333333333333333333',
    plategaMerchantId: 'merch_real_id_9876',
    plategaSecret: 'platega_real_secret_4321',
    bybitApiKey: 'bybit_real_key_5678',
    bybitApiSecret: 'bybit_real_sec_1111',
    geminiApiKey: 'gemini_real_key_2222',
    cardNumber: '4276123456784242',
    cardHolder: 'IVAN IVANOV',
    minTopup: 1,
    referralBonus: 0.5,
  });

  stores.settingsDoc.save = async function () { return this; };

  Settings.findOne = () => makeQuery(async () => stores.settingsDoc);
  settingsCache.getSettings = async () => stores.settingsDoc.toObject({ getters: true });
  settingsCache.invalidateCache = () => {};

  // Notifications & referral
  notif.sendToUser = async (tgId, text) => { sentMessages.push({ tgId, text }); };
  notif.notifyUserOrderCompleted = async () => {};
  notif.notifyUserOrderCancelled = async () => {};
  notif.notifyUserTopupConfirmed = async () => {};
  notif.notifyUserTopupRejected = async () => {};
  notif.notifySellerWithdrawalResult = async () => {};
  notif.notifyWaitlist = async (prod) => { waitlistNotifiedProducts.push(String(prod._id)); };
  referralService.grantReferralBonusForFirstCompletedOrder = async () => ({ granted: false });

  // Bybit / Platega / Suppliers
  bybitUidService.createInvoice = async ({ userId, baseAmount }) => ({
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: 'TOP-00000001',
    userId,
    baseAmount,
    exactAmount: Number((baseAmount + 0.0025).toFixed(4)),
    adminUid: stores.settingsDoc.bybitUid,
    status: 'pending',
    expiresAt: new Date(Date.now() + 900000),
    createdAt: new Date(),
  });
  plategaService.createPayment = async () => ({
    transactionId: `plt_${Date.now()}`,
    payUrl: 'https://app.platega.io/pay/test',
  });

  // User stubs
  User.findOne = (filter) => makeQuery(async () => {
    return stores.users.find((u) => {
      if (filter.telegramId !== undefined && u.telegramId !== filter.telegramId) return false;
      return true;
    }) || null;
  });

  User.findById = (id) => makeQuery(async () => {
    return stores.users.find((u) => String(u._id) === String(id)) || null;
  });

  User.find = (filter = {}) => makeQuery(async () => {
    return stores.users.filter((u) => {
      if (filter.isBanned !== undefined && u.isBanned !== filter.isBanned) return false;
      if (filter.balance?.$gt !== undefined && !(u.balance > filter.balance.$gt)) return false;
      return true;
    });
  });

  User.countDocuments = async (filter = {}) => {
    return stores.users.filter((u) => {
      if (filter.isBanned !== undefined && u.isBanned !== filter.isBanned) return false;
      if (filter.referredBy && String(u.referredBy) !== String(filter.referredBy)) return false;
      return true;
    }).length;
  };

  User.aggregate = async () => {
    const sum = stores.users.filter((u) => u.balance > 0).reduce((s, u) => s + u.balance, 0);
    return [{ _id: null, total: sum }];
  };

  User.findOneAndUpdate = async (filter, update, opts = {}) => {
    const u = stores.users.find((x) => {
      if (filter._id && String(x._id) !== String(filter._id)) return false;
      if (filter.balance?.$gt !== undefined && !(x.balance > filter.balance.$gt)) return false;
      if (filter.balance?.$gte !== undefined && !(x.balance >= filter.balance.$gte)) return false;
      return true;
    });
    if (!u) return null;
    const before = { ...u, toObject: () => ({ ...u }) };
    if (update.$inc) {
      if (update.$inc.balance) u.balance = Number((u.balance + update.$inc.balance).toFixed(8));
      if (update.$inc.totalSpent) u.totalSpent = Number(((u.totalSpent || 0) + update.$inc.totalSpent).toFixed(8));
    }
    if (update.$set) Object.assign(u, update.$set);
    return opts.new === false ? before : u;
  };

  User.findByIdAndUpdate = async (id, update) => User.findOneAndUpdate({ _id: id }, update, { new: true });

  User.updateOne = async (filter, update) => {
    const u = stores.users.find((x) => String(x._id) === String(filter._id));
    if (!u) return { modifiedCount: 0 };
    if (update.$inc) {
      if (update.$inc.balance) u.balance += update.$inc.balance;
      if (update.$inc.totalSpent) u.totalSpent = (u.totalSpent || 0) + update.$inc.totalSpent;
    }
    if (update.$set) Object.assign(u, update.$set);
    return { modifiedCount: 1 };
  };

  User.updateMany = async (filter, update) => {
    let mod = 0;
    for (const u of stores.users) {
      if (filter.isBanned !== undefined && u.isBanned !== filter.isBanned) continue;
      if (filter.balance?.$gt !== undefined && !(u.balance > filter.balance.$gt)) continue;
      if (update.$inc?.balance) u.balance += update.$inc.balance;
      if (update.$set) Object.assign(u, update.$set);
      mod += 1;
    }
    return { modifiedCount: mod };
  };

  // Category stubs
  Category.find = () => makeQuery(async () => stores.categories);
  Category.findById = (id) => makeQuery(async () => stores.categories.find((c) => String(c._id) === String(id)) || null);
  Category.create = async (data) => {
    const doc = { _id: new mongoose.Types.ObjectId(), ...data, save: async function () { return this; } };
    stores.categories.push(doc);
    return doc;
  };
  Category.findByIdAndDelete = async (id) => {
    const idx = stores.categories.findIndex((c) => String(c._id) === String(id));
    if (idx === -1) return null;
    return stores.categories.splice(idx, 1)[0];
  };
  Category.updateMany = async (f, u) => {
    let mod = 0;
    for (const c of stores.categories) {
      if (u.$set) Object.assign(c, u.$set);
      mod += 1;
    }
    return { modifiedCount: mod };
  };

  // Product stubs
  Product.find = (filter = {}) => makeQuery(async () => {
    return stores.products
      .filter((p) => {
        if (filter.isActive !== undefined && p.isActive !== filter.isActive) return false;
        if (filter.categoryId !== undefined && String(p.categoryId) !== String(filter.categoryId)) return false;
        if (filter.type && p.type !== filter.type) return false;
        return true;
      })
      .map((p) => ({
        ...p,
        categoryId: stores.categories.find((c) => String(c._id) === String(p.categoryId)) || p.categoryId || null,
      }));
  });
  Product.findById = (id) => makeQuery(async () => stores.products.find((p) => String(p._id) === String(id)) || null);
  Product.findOne = (filter) => makeQuery(async () => stores.products.find((p) => String(p._id) === String(filter._id) && (filter.isActive === undefined || p.isActive === filter.isActive)) || null);
  Product.countDocuments = async (filter = {}) => {
    return stores.products.filter((p) => {
      if (filter.isActive !== undefined && p.isActive !== filter.isActive) return false;
      if (filter.categoryId !== undefined && String(p.categoryId) !== String(filter.categoryId)) return false;
      return true;
    }).length;
  };
  Product.exists = async (filter) => stores.products.some((p) => String(p.categoryId) === String(filter.categoryId)) ? { _id: true } : null;
  Product.aggregate = async () => {
    const map = new Map();
    for (const p of stores.products) {
      if (p.categoryId) {
        const k = String(p.categoryId);
        map.set(k, (map.get(k) || 0) + 1);
      }
    }
    return Array.from(map.entries()).map(([k, count]) => ({ _id: k, count }));
  };
  Product.prototype.save = async function () {
    const idx = stores.products.findIndex((p) => String(p._id) === String(this._id));
    if (idx >= 0) stores.products[idx] = this;
    else stores.products.push(this);
    return this;
  };
  Product.deleteOne = async (filter) => {
    const idx = stores.products.findIndex((p) => String(p._id) === String(filter._id));
    if (idx >= 0) { stores.products.splice(idx, 1); return { deletedCount: 1 }; }
    return { deletedCount: 0 };
  };
  Product.updateMany = async (f, u) => {
    let mod = 0;
    for (const p of stores.products) {
      if (f.provider && p.provider !== f.provider) continue;
      if (u.$set) Object.assign(p, u.$set);
      mod += 1;
    }
    return { modifiedCount: mod };
  };

  // Key stubs
  Key.countDocuments = async (filter = {}) => {
    return stores.keys.filter((k) => {
      if (filter.productId && String(k.productId) !== String(filter.productId)) return false;
      if (filter.isUsed !== undefined && k.isUsed !== filter.isUsed) return false;
      return true;
    }).length;
  };
  Key.aggregate = async (pipeline) => {
    const match = pipeline.find((s) => s.$match)?.$match || {};
    const groupStage = pipeline.find((s) => s.$group)?.$group || {};
    const filtered = stores.keys.filter((k) => {
      if (match.productId?.$in) {
        return match.productId.$in.some((id) => String(id) === String(k.productId));
      }
      return true;
    });
    const map = new Map();
    for (const k of filtered) {
      if (groupStage._id === '$isUsed') {
        const key = String(Boolean(k.isUsed));
        map.set(key, { _id: Boolean(k.isUsed), cnt: (map.get(key)?.cnt || 0) + 1 });
      } else if (groupStage._id?.isUsed !== undefined && groupStage._id?.provider !== undefined) {
        const key = `${k.productId}|${k.provider || 'local'}|${Boolean(k.isUsed)}`;
        if (!map.has(key)) {
          map.set(key, {
            _id: { productId: k.productId, provider: k.provider || 'local', isUsed: Boolean(k.isUsed) },
            count: 0,
          });
        }
        map.get(key).count += 1;
      } else {
        const key = `${k.productId}|${Boolean(k.isUsed)}`;
        if (!map.has(key)) {
          map.set(key, { _id: { productId: k.productId, isUsed: Boolean(k.isUsed) }, count: 0 });
        }
        map.get(key).count += 1;
      }
    }
    return Array.from(map.values());
  };
  Key.distinct = async (field, filter = {}) => {
    const vals = stores.keys
      .filter((k) => (!filter.productId || String(k.productId) === String(filter.productId)))
      .map((k) => k[field]);
    return Array.from(new Set(vals));
  };
  Key.insertMany = async (batch) => {
    insertManyCalls.push(batch.length);
    const created = batch.map((doc) => ({ _id: new mongoose.Types.ObjectId(), isUsed: false, createdAt: new Date(), ...doc }));
    stores.keys.push(...created);
    return created;
  };
  Key.find = (filter = {}) => makeQuery(async () => stores.keys.filter((k) => {
    if (filter.productId && String(k.productId) !== String(filter.productId)) return false;
    if (filter.isUsed !== undefined && k.isUsed !== filter.isUsed) return false;
    return true;
  }));
  Key.findById = (id) => makeQuery(async () => stores.keys.find((k) => String(k._id) === String(id)) || null);
  Key.findOneAndUpdate = async (filter, update) => {
    const k = stores.keys.find((x) => String(x.productId) === String(filter.productId) && x.isUsed === false);
    if (!k) return null;
    if (update.$set) Object.assign(k, update.$set);
    return k;
  };
  Key.updateOne = async (filter, update) => {
    const k = stores.keys.find((x) => String(x._id) === String(filter._id));
    if (k && update.$set) Object.assign(k, update.$set);
    return { modifiedCount: k ? 1 : 0 };
  };
  Key.deleteOne = async (filter) => {
    const idx = stores.keys.findIndex((k) => String(k._id) === String(filter._id) && (filter.isUsed === undefined || k.isUsed === filter.isUsed));
    if (idx >= 0) { stores.keys.splice(idx, 1); return { deletedCount: 1 }; }
    return { deletedCount: 0 };
  };
  Key.deleteMany = async (filter = {}) => {
    const before = stores.keys.length;
    stores.keys = stores.keys.filter((k) => {
      if (filter.productId && String(k.productId) !== String(filter.productId)) return true;
      if (filter.isUsed !== undefined && k.isUsed !== filter.isUsed) return true;
      return false;
    });
    return { deletedCount: before - stores.keys.length };
  };

  // Order stubs
  Order.countDocuments = async (filter = {}) => {
    return stores.orders.filter((o) => {
      if (filter.productId && String(o.productId) !== String(filter.productId)) return false;
      if (filter.status?.$in && !filter.status.$in.includes(o.status)) return false;
      if (typeof filter.status === 'string' && o.status !== filter.status) return false;
      if (filter.replacementStatus && o.replacementStatus !== filter.replacementStatus) return false;
      return true;
    }).length;
  };
  Order.find = (filter = {}) => makeQuery(async () => {
    return stores.orders
      .filter((o) => {
        if (filter.status?.$in && !filter.status.$in.includes(o.status)) return false;
        if (typeof filter.status === 'string' && o.status !== filter.status) return false;
        if (filter.replacementStatus && o.replacementStatus !== filter.replacementStatus) return false;
        return true;
      })
      .map((o) => ({
        ...o,
        userId: stores.users.find((u) => String(u._id) === String(o.userId)) || o.userId,
        productId: stores.products.find((p) => String(p._id) === String(o.productId)) || o.productId,
        keyId: stores.keys.find((k) => String(k._id) === String(o.keyId)) || null,
        replacedKeyId: stores.keys.find((k) => String(k._id) === String(o.replacedKeyId)) || null,
      }));
  });
  Order.findById = (id) => makeQuery(async () => {
    const o = stores.orders.find((x) => String(x._id) === String(id));
    if (!o) return null;
    return {
      ...o,
      userId: stores.users.find((u) => String(u._id) === String(o.userId)) || o.userId,
      productId: stores.products.find((p) => String(p._id) === String(o.productId)) || o.productId,
    };
  });
  Order.findOneAndUpdate = (filter, update) => makeQuery(async () => {
    const o = stores.orders.find((x) => {
      if (String(x._id) !== String(filter._id)) return false;
      if (filter.status?.$nin && filter.status.$nin.includes(x.status)) return false;
      if (typeof filter.status === 'string' && x.status !== filter.status) return false;
      if (filter.replacementStatus && x.replacementStatus !== filter.replacementStatus) return false;
      if (filter.sellerPaidAt === null && x.sellerPaidAt !== null && x.sellerPaidAt !== undefined) return false;
      return true;
    });
    if (!o) return null;
    if (update.$set) Object.assign(o, update.$set);
    return { ...o };
  });
  Order.updateOne = async (filter, update) => {
    const o = stores.orders.find((x) => String(x._id) === String(filter._id));
    if (o && update.$set) Object.assign(o, update.$set);
    return { modifiedCount: o ? 1 : 0 };
  };
  Order.updateMany = async (f, u) => {
    let mod = 0;
    for (const o of stores.orders) {
      if (u.$inc?.warrantyDays) o.warrantyDays = (o.warrantyDays || 0) + u.$inc.warrantyDays;
      if (u.$set) Object.assign(o, u.$set);
      mod += 1;
    }
    return { modifiedCount: mod };
  };
  Order.aggregate = async () => [{ total: [], today: [], month: [] }];

  // Transaction stubs
  Transaction.prototype.save = async function () {
    stores.transactions.push(this);
    return this;
  };
  Transaction.find = () => makeQuery(async () => stores.transactions);
  Transaction.aggregate = async () => [];
  Transaction.insertMany = async (docs) => { stores.transactions.push(...docs); return docs; };

  // Promo stubs
  PromoCode.find = () => makeQuery(async () => stores.promos);
  PromoCode.findOne = (filter) => makeQuery(async () => stores.promos.find((p) => p.code === filter.code) || null);
  PromoCode.findById = (id) => makeQuery(async () => stores.promos.find((p) => String(p._id) === String(id)) || null);
  PromoCode.create = async (data) => {
    const p = { _id: new mongoose.Types.ObjectId(), ...data, save: async function () { return this; } };
    stores.promos.push(p);
    return p;
  };
  PromoCode.findByIdAndDelete = async (id) => {
    const idx = stores.promos.findIndex((p) => String(p._id) === String(id));
    if (idx === -1) return null;
    return stores.promos.splice(idx, 1)[0];
  };
  PromoUsage.countDocuments = async () => 0;

  // Supplier stubs
  supplierManager.getAllSuppliers = async () => stores.suppliers;
  supplierManager.saveSupplierKey = async (supplierId, apiKey) => {
    const s = stores.suppliers.find((x) => x.supplierId === supplierId);
    if (s) { s.apiKey = apiKey; s.isEnabled = Boolean(apiKey); }
    return s;
  };
  supplierManager.refreshSupplierBalance = async () => ({ success: true, balance: 42.5 });
  supplierManager.importSupplierCatalog = async () => ({ success: true, totalReceived: 5, importedCount: 2, updatedCount: 3 });
  supplierLiveSync.syncSupplierStock = async () => ({ success: true, updatedCount: 4 });
  SupplierConfig.findOne = ({ supplierId }) => makeQuery(async () => stores.suppliers.find((s) => s.supplierId === supplierId) || null);

  // TopupRequest & SellerWithdrawal & Seller stubs
  TopupRequest.find = (filter = {}) => makeQuery(async () => stores.topups.filter((t) => !filter.status || t.status === filter.status));
  TopupRequest.findById = (id) => makeQuery(async () => stores.topups.find((t) => String(t._id) === String(id)) || null);
  TopupRequest.findOne = (filter = {}) => makeQuery(async () => stores.topups.find((t) => filter.txid && t.txid === filter.txid) || null);
  TopupRequest.countDocuments = async (filter = {}) => stores.topups.filter((t) => !filter.status || t.status === filter.status).length;
  TopupRequest.aggregate = async () => [];
  TopupRequest.prototype.save = async function () {
    const idx = stores.topups.findIndex((t) => String(t._id) === String(this._id));
    if (idx >= 0) stores.topups[idx] = this; else stores.topups.push(this);
    return this;
  };
  TopupRequest.findOneAndUpdate = (filter, update) => makeQuery(async () => {
    const t = stores.topups.find((x) => String(x._id) === String(filter._id) && x.status === filter.status);
    if (!t) return null;
    if (update.$set) Object.assign(t, update.$set);
    return t;
  });

  SellerWithdrawal.find = (filter = {}) => makeQuery(async () => stores.withdrawals.filter((w) => !filter.status || w.status === filter.status));
  SellerWithdrawal.countDocuments = async (filter = {}) => stores.withdrawals.filter((w) => !filter.status || w.status === filter.status).length;
  SellerWithdrawal.findOneAndUpdate = (filter, update) => makeQuery(async () => {
    const w = stores.withdrawals.find((x) => String(x._id) === String(filter._id) && x.status === filter.status);
    if (!w) return null;
    if (update.$set) Object.assign(w, update.$set);
    return { ...w, sellerId: stores.sellers.find((s) => String(s._id) === String(w.sellerId)) || w.sellerId };
  });
  Seller.updateOne = async (filter, update) => {
    const s = stores.sellers.find((x) => String(x._id) === String(filter._id));
    if (s && update.$inc?.balance) s.balance += update.$inc.balance;
    return { modifiedCount: s ? 1 : 0 };
  };
  Seller.findByIdAndUpdate = async (id, update) => Seller.updateOne({ _id: id }, update);
  BybitInvoice.findOne = () => makeQuery(async () => null);
}

async function runTests() {
  console.log('=== Запуск тестов разделения Настроек Бот/Сайт и Admin REST API ===\n');
  setupStubs();

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

  // Seed users
  const regularUser = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 10001,
    username: 'regular_user',
    firstName: 'Regular',
    role: 'user',
    balance: 200,
    totalSpent: 50,
    isBanned: false,
    save: async function () { return this; },
  };
  const adminUser = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 10002,
    username: 'regular_admin',
    firstName: 'Admin',
    role: 'admin',
    balance: 50,
    totalSpent: 0,
    isBanned: false,
    save: async function () { return this; },
  };
  const superAdminUser = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 10003,
    username: 'super_admin',
    firstName: 'Super',
    role: 'superadmin',
    balance: 50,
    totalSpent: 0,
    isBanned: false,
    save: async function () { return this; },
  };
  stores.users.push(regularUser, adminUser, superAdminUser);

  const userToken = signUserToken(regularUser);
  const adminToken = signUserToken(adminUser);
  const superToken = signUserToken(superAdminUser);

  // Seed category & products
  const cat1 = { _id: new mongoose.Types.ObjectId(), name: 'ChatGPT', icon: '🤖', sortOrder: 1, isActive: true, save: async function () { return this; } };
  const catEmpty = { _id: new mongoose.Types.ObjectId(), name: 'EmptyCat', icon: '📁', sortOrder: 2, isActive: true, save: async function () { return this; } };
  stores.categories.push(cat1, catEmpty);

  const prod1 = {
    _id: new mongoose.Types.ObjectId(),
    name: 'ChatGPT Plus',
    nameEn: 'ChatGPT Plus EN',
    price: 15,
    costPrice: 10,
    officialPrice: 20,
    officialDiscountPercent: 25,
    type: 'key',
    provider: 'local',
    deliveryMethod: 'ready_account',
    categoryId: cat1._id,
    isActive: true,
    manualStock: -1,
    warrantyDays: 5,
    subscriptionDays: 30,
    save: async function () { return this; },
  };
  const prodZeroStock = {
    _id: new mongoose.Types.ObjectId(),
    name: 'OutOfStock Key',
    price: 10,
    costPrice: 5,
    type: 'key',
    provider: 'local',
    deliveryMethod: 'ready_account',
    categoryId: cat1._id,
    isActive: true,
    manualStock: 0,
    save: async function () { return this; },
  };
  const prodHidden = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Hidden Product',
    price: 12,
    costPrice: 6,
    type: 'manual',
    provider: 'local',
    deliveryMethod: 'ready_account',
    categoryId: cat1._id,
    isActive: false,
    manualStock: 5,
    save: async function () { return this; },
  };
  stores.products.push(prod1, prodZeroStock, prodHidden);
  stores.keys.push({ _id: new mongoose.Types.ObjectId(), productId: prod1._id, provider: 'local', value: 'KEY-1', isUsed: false, createdAt: new Date() });

  // Seed supplier with encrypted apiKey
  const suppDoc = new SupplierConfig({
    supplierId: 'jaha',
    title: 'Jaha Digital API',
    apiKey: 'jaha_secret_token_9988',
    isEnabled: true,
    marginPercent: 30,
  });
  suppDoc.save = async function () { return this; };
  stores.suppliers.push(suppDoc);

  // ── 1. Settings schema & Platega channel separation ───────────────
  console.log('1. Тестирование разделения Settings и Platega channel:');
  check(stores.settingsDoc.webMaintenanceMode === false, 'webMaintenanceMode по умолчанию false');
  check(stores.settingsDoc.webPlategaEnabled === true, 'webPlategaEnabled по умолчанию true');
  check(stores.settingsDoc.webBybitUidEnabled === true, 'webBybitUidEnabled по умолчанию true');
  check(stores.settingsDoc.webCryptoTrc20Enabled === true, 'webCryptoTrc20Enabled по умолчанию true');
  check(stores.settingsDoc.webCryptoBep20Enabled === true, 'webCryptoBep20Enabled по умолчанию true');
  check(stores.settingsDoc.webCryptoTonEnabled === true, 'webCryptoTonEnabled по умолчанию true');
  check(typeof stores.settingsDoc.tonAddress === 'string', 'tonAddress присутствует в Settings');

  // Bot disabled, Web enabled
  stores.settingsDoc.plategaEnabled = false;
  stores.settingsDoc.bybitEnabled = false;
  stores.settingsDoc.cardEnabled = false;
  stores.settingsDoc.maintenanceMode = true;
  stores.settingsDoc.webPlategaEnabled = true;
  stores.settingsDoc.webBybitUidEnabled = true;
  stores.settingsDoc.webMaintenanceMode = false;

  const botCfg = await plategaService.getPlategaConfig();
  const webCfg = await plategaService.getPlategaConfig({ channel: 'web' });
  check(botCfg.enabled === false && botCfg.isReady === false, 'getPlategaConfig() (bot) видит plategaEnabled=false');
  check(webCfg.enabled === true && webCfg.isReady === true, 'getPlategaConfig({ channel: "web" }) видит webPlategaEnabled=true независимо от бота');

  const webhookOkWhenDisabled = await plategaService.verifyWebhookHeaders({
    'x-merchantid': 'merch_real_id_9876',
    'x-secret': 'platega_real_secret_4321',
  });
  check(webhookOkWhenDisabled === true, 'verifyWebhookHeaders проверяет только merchantId и secret даже при выключенных флагах');

  // ── 2. Payments Web/Bot independence & Maintenance bypass ─────────
  console.log('\n2. Тестирование payments.routes.js (независимость от бота, 403, 503 maintenance):');
  const methodsBotOffRes = await invokeRoute(paymentsRouter, 'GET', '/methods');
  check(methodsBotOffRes.status === 200 && methodsBotOffRes.body.methods.length === 5, 'GET /methods возвращает все 5 методов сайта, даже если методы бота выключены');

  const createBybitWhenBotOff = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { amount: 10 },
  });
  check(createBybitWhenBotOff.status === 200, 'POST /bybit-uid/create работает при выключенном bybitEnabled бота');

  // Now disable web methods while bot is enabled
  stores.settingsDoc.plategaEnabled = true;
  stores.settingsDoc.bybitEnabled = true;
  stores.settingsDoc.maintenanceMode = false;
  stores.settingsDoc.webPlategaEnabled = false;
  stores.settingsDoc.webBybitUidEnabled = false;
  stores.settingsDoc.webCryptoTrc20Enabled = false;
  stores.settingsDoc.webCryptoBep20Enabled = false;
  stores.settingsDoc.webCryptoTonEnabled = false;

  const methodsWebOffRes = await invokeRoute(paymentsRouter, 'GET', '/methods');
  check(methodsWebOffRes.status === 200 && methodsWebOffRes.body.methods.length === 0, 'GET /methods скрывает все отключённые web* методы (даже при включённом боте)');

  const addrWebOffRes = await invokeRoute(paymentsRouter, 'GET', '/crypto/addresses', {
    headers: { authorization: `Bearer ${userToken}` },
  });
  check(
    addrWebOffRes.status === 200 &&
    addrWebOffRes.body.wallets.trc20 === null &&
    addrWebOffRes.body.wallets.bep20 === null &&
    addrWebOffRes.body.wallets.ton === null,
    'GET /crypto/addresses скрывает адреса отключённых сетей'
  );

  const bybitDisabledRes = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { amount: 10 },
  });
  check(bybitDisabledRes.status === 403 && bybitDisabledRes.body.error === 'PAYMENT_METHOD_DISABLED', 'POST /bybit-uid/create возвращает 403 PAYMENT_METHOD_DISABLED при webBybitUidEnabled=false');

  const plategaDisabledRes = await invokeRoute(paymentsRouter, 'POST', '/platega/create', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { amountUsdt: 10 },
  });
  check(plategaDisabledRes.status === 403 && plategaDisabledRes.body.error === 'PAYMENT_METHOD_DISABLED', 'POST /platega/create возвращает 403 PAYMENT_METHOD_DISABLED при webPlategaEnabled=false');

  const cryptoDisabledRes = await invokeRoute(paymentsRouter, 'POST', '/crypto/submit', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { network: 'trc20', amount: 10, txid: 'a'.repeat(64) },
  });
  check(cryptoDisabledRes.status === 403 && cryptoDisabledRes.body.error === 'PAYMENT_METHOD_DISABLED', 'POST /crypto/submit возвращает 403 PAYMENT_METHOD_DISABLED при webCryptoTrc20Enabled=false');

  // Re-enable web methods, enable webMaintenanceMode
  stores.settingsDoc.webPlategaEnabled = true;
  stores.settingsDoc.webBybitUidEnabled = true;
  stores.settingsDoc.webCryptoTrc20Enabled = true;
  stores.settingsDoc.webCryptoBep20Enabled = true;
  stores.settingsDoc.webCryptoTonEnabled = true;
  stores.settingsDoc.webMaintenanceMode = true;

  const maintUserBybit = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { amount: 10 },
  });
  check(maintUserBybit.status === 503 && maintUserBybit.body.error === 'MAINTENANCE_MODE', 'webMaintenanceMode=true блокирует обычного юзера (503) на платежах');

  const maintUserCheckout = await invokeRoute(ordersRouter, 'POST', '/checkout', {
    headers: { authorization: `Bearer ${userToken}` },
    body: { cartVersion: 0 },
  });
  check(maintUserCheckout.status === 503 && maintUserCheckout.body.error === 'MAINTENANCE_MODE', 'webMaintenanceMode=true блокирует обычного юзера (503) на /orders/checkout');

  const maintAdminBybit = await invokeRoute(paymentsRouter, 'POST', '/bybit-uid/create', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { amount: 10 },
  });
  check(maintAdminBybit.status === 200, 'admin пропускается через webMaintenanceMode при создании платежа');

  stores.settingsDoc.webMaintenanceMode = false;

  // ── 3. Catalog /meta & /products limit=500 & inStock=true ─────────
  console.log('\n3. Тестирование catalog.routes.js (/meta, limit=500, inStock=true):');
  const metaRes = await invokeRoute(catalogRouter, 'GET', '/meta');
  check(
    metaRes.status === 200 &&
    metaRes.body.currentRateRub === 92.5 &&
    metaRes.body.webMaintenanceMode === false &&
    Boolean(metaRes.body.updatedAt),
    'GET /catalog/meta возвращает курс, updatedAt и webMaintenanceMode'
  );

  const catInStockRes = await invokeRoute(catalogRouter, 'GET', '/products?inStock=true&limit=500');
  check(
    catInStockRes.status === 200 &&
    catInStockRes.body.pagination.limit === 500 &&
    catInStockRes.body.products.length === 1 &&
    catInStockRes.body.products[0].id.toString() === prod1._id.toString() &&
    catInStockRes.body.currentRateRub === 92.5 &&
    catInStockRes.body.products[0].costPrice === 10 &&
    catInStockRes.body.products[0].deliveryMethod === 'ready_account',
    'GET /catalog/products?inStock=true&limit=500 фильтрует остатки, поддерживает limit=500 и отдает нужные поля'
  );

  // ── 4. Middleware requireSuperAdmin & mounting check ──────────────
  console.log('\n4. Тестирование RBAC middleware и роутинга /api/v1/admin:');
  let superNextCalled = false;
  const mockRes = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  requireSuperAdmin({ user: { role: 'admin' } }, mockRes, () => { superNextCalled = true; });
  check(!superNextCalled && mockRes.statusCode === 403 && mockRes.body.error === 'SUPERADMIN_REQUIRED', 'requireSuperAdmin блокирует обычного admin (403 SUPERADMIN_REQUIRED)');

  let adminAllowedSuper = false;
  requireSuperAdmin({ user: { role: 'superadmin' } }, mockRes, () => { adminAllowedSuper = true; });
  check(adminAllowedSuper === true, 'requireSuperAdmin пропускает superadmin');

  const unauthAdminRes = await invokeRoute(adminRouter, 'GET', '/stats');
  check(unauthAdminRes.status === 401, '/api/v1/admin/stats требует JWT');

  const userAdminRes = await invokeRoute(adminRouter, 'GET', '/stats', {
    headers: { authorization: `Bearer ${userToken}` },
  });
  check(userAdminRes.status === 403 && userAdminRes.body.error === 'FORBIDDEN', '/api/v1/admin/stats блокирует обычного пользователя (403)');

  const mountedStatsRes = await invokeRoute(app, 'GET', '/api/v1/admin/stats', {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(mountedStatsRes.status === 200 && mountedStatsRes.body.success === true, '/api/v1/admin смонтирован в Express приложении src/api/index.js');

  // ── 5. Masking Secrets & Ignoring •••• ────────────────────────────
  console.log('\n5. Тестирование маскирования секретов в /admin/settings и /admin/suppliers:');
  const settingsGetRes = await invokeRoute(adminRouter, 'GET', '/settings', {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const ws = settingsGetRes.body.settings?.walletsAndSecrets;
  check(
    settingsGetRes.status === 200 &&
    ws.plategaSecretMask === '••••••••4321' &&
    ws.plategaMerchantIdMask === '••••••••9876' &&
    ws.bybitApiKeyMask === '••••••••5678' &&
    ws.bybitApiSecretMask === '••••••••1111' &&
    ws.geminiApiKeyMask === '••••••••2222' &&
    ws.cardNumberMask === '••••••••4242' &&
    !JSON.stringify(settingsGetRes.body).includes('platega_real_secret_4321') &&
    !JSON.stringify(settingsGetRes.body).includes('4276123456784242'),
    'GET /admin/settings маскирует ВСЕ секреты (platega, bybit, gemini, cardNumber)'
  );

  const suppGetRes = await invokeRoute(adminRouter, 'GET', '/suppliers', {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(
    suppGetRes.status === 200 &&
    suppGetRes.body.suppliers[0].hasApiKey === true &&
    suppGetRes.body.suppliers[0].apiKeyMask === '••••••••9988' &&
    !JSON.stringify(suppGetRes.body).includes('jaha_secret_token_9988'),
    'GET /admin/suppliers маскирует apiKey (только суффикс + hasApiKey)'
  );

  // Regular admin tries to change webPlategaEnabled -> 403
  const adminEditPaySetting = await invokeRoute(adminRouter, 'PATCH', '/settings', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { webPlategaEnabled: false },
  });
  check(adminEditPaySetting.status === 403 && adminEditPaySetting.body.error === 'SUPERADMIN_REQUIRED', 'Обычный admin не может менять web*Enabled в PATCH /settings');

  // Regular admin edits currencyOffset while masked secrets are present in payload -> allowed & mask ignored!
  const adminEditCurrency = await invokeRoute(adminRouter, 'PATCH', '/settings', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: {
      currencyOffset: 2.5,
      plategaSecret: '••••••••4321',
      bybitApiSecret: '••••••••1111',
    },
  });
  check(
    adminEditCurrency.status === 200 &&
    stores.settingsDoc.currencyOffset === 2.5 &&
    stores.settingsDoc.plategaSecret === 'platega_real_secret_4321' &&
    stores.settingsDoc.bybitApiSecret === 'bybit_real_sec_1111',
    'PATCH /settings игнорирует маски •••• и разрешает admin менять курс'
  );

  // Superadmin changes webPlategaEnabled & tonAddress
  const superEditSettings = await invokeRoute(adminRouter, 'PATCH', '/settings', {
    headers: { authorization: `Bearer ${superToken}` },
    body: { webPlategaEnabled: false, tonAddress: 'EQ_NEW_TON_ADDR' },
  });
  check(
    superEditSettings.status === 200 &&
    stores.settingsDoc.webPlategaEnabled === false &&
    stores.settingsDoc.tonAddress === 'EQ_NEW_TON_ADDR',
    'Superadmin может менять web*Enabled и кошельки'
  );

  // ── 6. RBAC: Balance, Roles, Suppliers, Topups, Withdrawals, Bulk ─
  console.log('\n6. Тестирование RBAC admin vs superadmin + ACID транзакций:');

  // Balance <= 100 by regular admin -> 200 + Transaction
  const txCountBefore = stores.transactions.length;
  const adminBalSmall = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/balance`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { delta: 25, reason: 'Bonus' },
  });
  check(
    adminBalSmall.status === 200 &&
    regularUser.balance === 225 &&
    stores.transactions.length === txCountBefore + 1 &&
    stores.transactions[stores.transactions.length - 1].type === 'manual_credit',
    'Обычный admin может изменить баланс на <= 100 USDT с записью Transaction'
  );

  // Balance > 100 by regular admin -> 403
  const adminBalBig = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/balance`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { delta: 150, reason: 'Too big' },
  });
  check(adminBalBig.status === 403 && adminBalBig.body.error === 'SUPERADMIN_REQUIRED', 'Обычный admin получает 403 при |delta| > 100');

  // Balance zero by regular admin -> 403
  const adminBalZero = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/balance`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'zero' },
  });
  check(adminBalZero.status === 403 && adminBalZero.body.error === 'SUPERADMIN_REQUIRED', 'Обычный admin получает 403 при action=zero');

  // Superadmin balance > 100 & zero
  const superBalBig = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/balance`, {
    headers: { authorization: `Bearer ${superToken}` },
    body: { delta: 150, reason: 'VIP bonus' },
  });
  check(superBalBig.status === 200 && regularUser.balance === 375, 'Superadmin может начислить > 100 USDT');

  const superBalZero = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/balance`, {
    headers: { authorization: `Bearer ${superToken}` },
    body: { action: 'zero', reason: 'Reset' },
  });
  check(superBalZero.status === 200 && regularUser.balance === 0, 'Superadmin может обнулить баланс с записью manual_debit');

  // Role change by admin -> 403; by superadmin -> 200; self/superadmin -> blocked
  const adminRoleRes = await invokeRoute(adminRouter, 'PATCH', `/users/${regularUser._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { role: 'admin' },
  });
  check(adminRoleRes.status === 403 && adminRoleRes.body.error === 'SUPERADMIN_REQUIRED', 'Обычный admin не может менять role');

  const superRoleRes = await invokeRoute(adminRouter, 'PATCH', `/users/${regularUser._id}`, {
    headers: { authorization: `Bearer ${superToken}` },
    body: { role: 'admin' },
  });
  check(superRoleRes.status === 200 && regularUser.role === 'admin', 'Superadmin может повысить пользователя до admin');
  regularUser.role = 'user';

  const banSelfRes = await invokeRoute(adminRouter, 'PATCH', `/users/${adminUser._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { isBanned: true },
  });
  check(banSelfRes.status === 400 && banSelfRes.body.error === 'CANNOT_MODIFY_SELF', 'Запрет бана самого себя');

  const banSuperRes = await invokeRoute(adminRouter, 'PATCH', `/users/${superAdminUser._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { isBanned: true },
  });
  check(banSuperRes.status === 403 && banSuperRes.body.error === 'CANNOT_MODIFY_SUPERADMIN', 'Запрет модификации superadmin');

  // Supplier apiKey RBAC
  const adminSuppKey = await invokeRoute(adminRouter, 'PATCH', '/suppliers/jaha', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { apiKey: 'hacked_key' },
  });
  check(adminSuppKey.status === 403 && adminSuppKey.body.error === 'SUPERADMIN_REQUIRED', 'Смена apiKey поставщика доступна только superadmin');

  // Topup approve/reject RBAC + ACID
  const topup1 = { _id: new mongoose.Types.ObjectId(), userId: regularUser._id, amount: 30, status: 'pending', method: 'bybit_trc20', createdAt: new Date() };
  stores.topups.push(topup1);

  const adminApproveTopup = await invokeRoute(adminRouter, 'POST', `/topups/${topup1._id}/approve`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(adminApproveTopup.status === 403 && adminApproveTopup.body.error === 'SUPERADMIN_REQUIRED', 'Approve topup запрещён обычному admin (403)');

  const superApproveTopup = await invokeRoute(adminRouter, 'POST', `/topups/${topup1._id}/approve`, {
    headers: { authorization: `Bearer ${superToken}` },
  });
  check(superApproveTopup.status === 200 && regularUser.balance === 30 && topup1.status === 'confirmed', 'Superadmin одобряет топап в транзакции с зачислением баланса');

  // Withdrawal reject RBAC + refund to seller
  const seller1 = { _id: new mongoose.Types.ObjectId(), username: 'seller_one', telegramId: 20001, balance: 10 };
  const wd1 = { _id: new mongoose.Types.ObjectId(), sellerId: seller1._id, amount: 25, walletAddress: 'TX_W', network: 'TRC-20', status: 'pending', createdAt: new Date() };
  stores.sellers.push(seller1);
  stores.withdrawals.push(wd1);

  const adminRejectWd = await invokeRoute(adminRouter, 'POST', `/withdrawals/${wd1._id}/reject`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(adminRejectWd.status === 403 && adminRejectWd.body.error === 'SUPERADMIN_REQUIRED', 'Reject withdrawal запрещён обычному admin (403)');

  const superRejectWd = await invokeRoute(adminRouter, 'POST', `/withdrawals/${wd1._id}/reject`, {
    headers: { authorization: `Bearer ${superToken}` },
  });
  check(superRejectWd.status === 200 && wd1.status === 'rejected' && seller1.balance === 35, 'Superadmin отклоняет вывод и возвращает баланс продавцу');

  // Bulk confirm + RBAC
  const bulkNoConfirm = await invokeRoute(adminRouter, 'POST', '/bulk', {
    headers: { authorization: `Bearer ${superToken}` },
    body: { action: 'hide_products' },
  });
  check(bulkNoConfirm.status === 400 && bulkNoConfirm.body.error === 'CONFIRMATION_REQUIRED', 'POST /bulk требует confirm: true');

  const adminBulkGrant = await invokeRoute(adminRouter, 'POST', '/bulk', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'grant_balance', confirm: true, amount: 5 },
  });
  check(adminBulkGrant.status === 403 && adminBulkGrant.body.error === 'SUPERADMIN_REQUIRED', 'POST /bulk grant_balance запрещён обычному admin');

  // ── 7. Batch Keys Import (500 per batch, limits, waitlist) ─────────
  console.log('\n7. Тестирование батчинга импорта ключей (500 шт) и валидации:');
  const tooLongLine = await invokeRoute(adminRouter, 'POST', '/keys/import', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { productId: prod1._id.toString(), rawText: 'x'.repeat(1001) },
  });
  check(tooLongLine.status === 400 && tooLongLine.body.error === 'KEY_LINE_TOO_LONG', 'POST /keys/import отклоняет строку > 1000 символов');

  const overLimitKeys = Array.from({ length: 5001 }, (_, i) => `OVER-${i}`);
  const tooManyRes = await invokeRoute(adminRouter, 'POST', '/keys/import', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { productId: prod1._id.toString(), keys: overLimitKeys },
  });
  check(tooManyRes.status === 400 && tooManyRes.body.error === 'TOO_MANY_KEYS', 'POST /keys/import отклоняет > 5000 строк');

  insertManyCalls = [];
  waitlistNotifiedProducts = [];
  const lines1200 = ['KEY-1', ...Array.from({ length: 1200 }, (_, i) => `BATCH-KEY-${i}`)]; // KEY-1 is duplicate
  const importRes = await invokeRoute(adminRouter, 'POST', '/keys/import', {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { productId: prod1._id.toString(), rawText: lines1200.join('\n') },
  });
  check(
    importRes.status === 200 &&
    importRes.body.addedCount === 1200 &&
    importRes.body.skippedCount === 1 &&
    JSON.stringify(insertManyCalls) === JSON.stringify([500, 500, 200]) &&
    waitlistNotifiedProducts.includes(String(prod1._id)),
    'POST /keys/import дедуплицирует, вставляет батчами по 500 ([500,500,200]) и вызывает notifyWaitlist'
  );

  // ── 8. Products/Categories/Orders CRUD & Guards ───────────────────
  console.log('\n8. Тестирование товаров, категорий и отмены заказа с возвратом:');
  const activeOrdKey = { _id: new mongoose.Types.ObjectId(), productId: prod1._id, provider: 'local', value: 'LOCKED-KEY', isUsed: true, createdAt: new Date() };
  stores.keys.push(activeOrdKey);
  const activeOrder = {
    _id: new mongoose.Types.ObjectId(),
    userId: regularUser._id,
    productId: prod1._id,
    keyId: activeOrdKey._id,
    status: 'pending',
    price: 15,
    costPrice: 10,
    qty: 1,
    createdAt: new Date(),
  };
  stores.orders.push(activeOrder);

  const delActiveProd = await invokeRoute(adminRouter, 'DELETE', `/products/${prod1._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(delActiveProd.status === 409 && delActiveProd.body.error === 'ACTIVE_ORDERS_EXIST', 'DELETE /products/:id возвращает 409 при наличии активных заказов');

  const delNonEmptyCat = await invokeRoute(adminRouter, 'DELETE', `/categories/${cat1._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(delNonEmptyCat.status === 400 && delNonEmptyCat.body.error === 'CATEGORY_HAS_PRODUCTS', 'DELETE /categories/:id возвращает 400 если есть товары');

  const delEmptyCat = await invokeRoute(adminRouter, 'DELETE', `/categories/${catEmpty._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(delEmptyCat.status === 200, 'DELETE /categories/:id удаляет пустую категорию');

  const balBeforeCancel = regularUser.balance;
  const cancelOrderRes = await invokeRoute(adminRouter, 'POST', `/orders/${activeOrder._id}/cancel`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { reason: 'Out of stock' },
  });
  check(
    cancelOrderRes.status === 200 &&
    activeOrder.status === 'cancelled' &&
    regularUser.balance === balBeforeCancel + 15 &&
    activeOrdKey.isUsed === false &&
    stores.transactions[stores.transactions.length - 1].type === 'refund',
    'POST /orders/:id/cancel возвращает баланс, освобождает Key и пишет refund в Transaction'
  );

  // PATCH product auto-recalculates officialDiscountPercent
  const patchProdRes = await invokeRoute(adminRouter, 'PATCH', `/products/${prod1._id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { price: 10, officialPrice: 25 },
  });
  check(
    patchProdRes.status === 200 &&
    patchProdRes.body.product.officialDiscountPercent === 60,
    'PATCH /products/:id автоматически пересчитывает officialDiscountPercent (60%)'
  );

  // Flash sale & clone
  const flashRes = await invokeRoute(adminRouter, 'POST', `/products/${prod1._id}/flash-sale`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'start', discountPercent: 30, durationHours: 6 },
  });
  check(flashRes.status === 200 && flashRes.body.product.flashSale?.enabled === true && flashRes.body.product.flashSale.discountPercent === 30, 'POST /products/:id/flash-sale запускает Flash Sale');

  const cloneRes = await invokeRoute(adminRouter, 'POST', `/products/${prod1._id}/clone`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check(cloneRes.status === 201 && cloneRes.body.product.name.includes('(Копия)') && cloneRes.body.product.isActive === false, 'POST /products/:id/clone клонирует товар как скрытый');

  // Send message to user via bot
  sentMessages = [];
  const msgUserRes = await invokeRoute(adminRouter, 'POST', `/users/${regularUser._id}/message`, {
    headers: { authorization: `Bearer ${adminToken}` },
    body: { message: 'Привет от поддержки' },
  });
  check(msgUserRes.status === 200 && sentMessages.length === 1 && sentMessages[0].tgId === regularUser.telegramId, 'POST /users/:id/message отправляет сообщение пользователю через бота');

  console.log(`\n=== Результат: ${passed} прошло, ${failed} ошибок ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

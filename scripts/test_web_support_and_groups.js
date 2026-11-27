/**
 * scripts/test_web_support_and_groups.js
 *
 * Offline verification suite for Contract #79:
 * - Rebranding ('TIG MARKET Web API v1')
 * - Grouped Storefront Catalog API (batch Category stats without N+1, product filters & category sort)
 * - Unified Web Support API (client tickets, anti-spam, PNG vs SVG/HTML validation,
 *   IDOR protection, media proxy + nosniff, requireSupport/requireModerator/requireAdmin RBAC,
 *   escalations, duty, role assignment restrictions, settings chatId validation)
 * - Admin 5-role filters & superadmin role assignment
 */

/* eslint-disable no-console */
'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = 'secret_test_bot_token_123456:ABCDEF';
process.env.SUPERADMIN_IDS = '900001';
process.env.ADMIN_IDS = '900002';

const assert = require('assert');
const http = require('http');
const { Duplex, PassThrough } = require('stream');
const mongoose = require('mongoose');
const axios = require('axios');

// Models
const Category = require('../src/models/Category');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');
const Order = require('../src/models/Order');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const SupportTicket = require('../src/models/SupportTicket');
const SupportMessage = require('../src/models/SupportMessage');
const StaffAuditLog = require('../src/models/StaffAuditLog');

// Services & Middlewares
const settingsCache = require('../src/services/settingsCache.service');
const currencyService = require('../src/services/currency.service');
const notif = require('../src/services/notification.service');
const supportNotify = require('../src/services/supportNotify.service');
const {
  signUserToken,
  isSupportOrAbove,
  isModeratorOrAbove,
  isAdminOrAbove,
} = require('../src/api/middlewares/auth.middleware');

// App
const app = require('../src/api/index');

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

// ─── In-memory Data Stores ───────────────────────────────────────────────────
const stores = {
  users: [],
  categories: [],
  products: [],
  keys: [],
  orders: [],
  tickets: [],
  messages: [],
  auditLogs: [],
  settingsDoc: null,
};

const toPlain = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;
  return typeof doc.toObject === 'function' ? doc.toObject({ getters: true }) : { ...doc };
};

const matchSingleCond = (val, cond) => {
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
    if ('$in' in cond) {
      return cond.$in.some((x) => String(x) === String(val));
    }
    if ('$ne' in cond) {
      return String(val) !== String(cond.$ne);
    }
    if ('$gt' in cond) {
      if (val == null) return false;
      return cond.$gt instanceof Date ? new Date(val).getTime() > cond.$gt.getTime() : Number(val) > Number(cond.$gt);
    }
    if ('$gte' in cond) {
      if (val == null) return false;
      return cond.$gte instanceof Date ? new Date(val).getTime() >= cond.$gte.getTime() : Number(val) >= Number(cond.$gte);
    }
    if ('$lt' in cond) {
      if (val == null) return false;
      return Number(val) < Number(cond.$lt);
    }
    if ('$lte' in cond) {
      if (val == null) return false;
      return Number(val) <= Number(cond.$lte);
    }
    if ('$regex' in cond) {
      const re = new RegExp(cond.$regex, cond.$options || '');
      return re.test(String(val || ''));
    }
  }
  if (cond instanceof RegExp) {
    return cond.test(String(val || ''));
  }
  if (cond === null) return val === null || val === undefined;
  return String(val) === String(cond);
};

const getByPath = (obj, fieldPath) => {
  const parts = String(fieldPath).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
};

const matchesFilter = (doc, filter = {}) => {
  if (!filter || Object.keys(filter).length === 0) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and') {
      if (!Array.isArray(v) || !v.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (k === '$or') {
      if (!Array.isArray(v) || !v.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    const docVal = getByPath(doc, k);
    if (!matchSingleCond(docVal, v)) return false;
  }
  return true;
};

const applySort = (list, sortSpec) => {
  if (!sortSpec || typeof sortSpec !== 'object') return list;
  const entries = Object.entries(sortSpec);
  if (entries.length === 0) return list;
  return [...list].sort((a, b) => {
    for (const [field, dir] of entries) {
      const va = getByPath(a, field);
      const vb = getByPath(b, field);
      if (va === vb) continue;
      if (va == null) return 1;
      if (vb == null) return -1;
      const na = va instanceof Date ? va.getTime() : va;
      const nb = vb instanceof Date ? vb.getTime() : vb;
      if (na < nb) return dir < 0 ? 1 : -1;
      if (na > nb) return dir < 0 ? -1 : 1;
    }
    return 0;
  });
};

const resolvePopulate = (doc, spec) => {
  const copy = { ...doc };
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const item of specs) {
    const pPath = typeof item === 'string' ? item : item?.path;
    if (!pPath) continue;
    const rawId = copy[pPath];
    if (!rawId) continue;
    const idStr = String(rawId?._id || rawId);
    if (pPath === 'categoryId') {
      const found = stores.categories.find((c) => String(c._id) === idStr);
      if (found) copy[pPath] = { ...found };
    } else if (['userId', 'assignedTo', 'escalatedBy', 'closedBy', 'senderId', 'targetUserId', 'actorUserId'].includes(pPath)) {
      const found = stores.users.find((u) => String(u._id) === idStr);
      if (found) copy[pPath] = { ...found };
    } else if (pPath === 'productId') {
      const found = stores.products.find((p) => String(p._id) === idStr);
      if (found) copy[pPath] = { ...found };
    } else if (pPath === 'orderId') {
      const found = stores.orders.find((o) => String(o._id) === idStr);
      if (found) {
        const orderCopy = { ...found };
        if (item?.populate?.path === 'productId' && orderCopy.productId) {
          const prod = stores.products.find((p) => String(p._id) === String(orderCopy.productId));
          if (prod) orderCopy.productId = { ...prod };
        }
        copy[pPath] = orderCopy;
      }
    }
  }
  return copy;
};

const makeChainQuery = (getListFn, single = false) => {
  const state = {
    sortSpec: null,
    skipN: 0,
    limitN: null,
    populates: [],
  };

  const execute = async () => {
    let rows = getListFn().map((d) => toPlain(d));
    if (state.sortSpec) rows = applySort(rows, state.sortSpec);
    if (state.skipN) rows = rows.slice(state.skipN);
    if (state.limitN != null) rows = rows.slice(0, state.limitN);
    if (state.populates.length > 0) {
      rows = rows.map((r) => {
        let cur = r;
        for (const p of state.populates) cur = resolvePopulate(cur, p);
        return cur;
      });
    }
    return single ? (rows[0] || null) : rows;
  };

  const q = {
    select() { return q; },
    sort(s) { state.sortSpec = s; return q; },
    skip(n) { state.skipN = n || 0; return q; },
    limit(n) { state.limitN = n; return q; },
    populate(p) { state.populates.push(p); return q; },
    session() { return q; },
    lean() { return execute(); },
    then(resolve, reject) { return execute().then(resolve, reject); },
  };
  return q;
};

// Counters for N+1 assertions
const callCounters = {
  categoryFind: 0,
  productFind: 0,
  keyAggregate: 0,
  keyCountDocuments: 0,
  notifyNewTicket: 0,
  notifyStaffBuyerReply: 0,
  notifyBuyerStaffReply: 0,
  notifyEscalation: 0,
  notifyTicketClosedToBuyer: 0,
  notifyOwnerRoleChange: 0,
  syncTicketCardInChats: 0,
  tgSendPhoto: 0,
  tgSendMessage: 0,
};

// ─── Install Model & Service Stubs ───────────────────────────────────────────
Category.find = (filter = {}) => {
  callCounters.categoryFind += 1;
  return makeChainQuery(() => stores.categories.filter((c) => matchesFilter(c, filter)), false);
};

Product.find = (filter = {}) => {
  callCounters.productFind += 1;
  return makeChainQuery(() => stores.products.filter((p) => matchesFilter(p, filter)), false);
};

Product.countDocuments = async (filter = {}) => stores.products.filter((p) => matchesFilter(p, filter)).length;

Product.findOne = (filter = {}) => makeChainQuery(() => stores.products.filter((p) => matchesFilter(p, filter)), true);

Key.countDocuments = async (filter = {}) => {
  callCounters.keyCountDocuments += 1;
  return stores.keys.filter((k) => matchesFilter(k, filter)).length;
};

Key.aggregate = async (pipeline = []) => {
  callCounters.keyAggregate += 1;
  const match = pipeline.find((s) => s.$match)?.$match || {};
  const matchingKeys = stores.keys.filter((k) => matchesFilter(k, match));
  const groups = new Map();
  for (const k of matchingKeys) {
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

Order.find = (filter = {}) => makeChainQuery(() => stores.orders.filter((o) => matchesFilter(o, filter)), false);
Order.findOne = (filter = {}) => makeChainQuery(() => stores.orders.filter((o) => matchesFilter(o, filter)), true);
Order.countDocuments = async (filter = {}) => stores.orders.filter((o) => matchesFilter(o, filter)).length;
Order.exists = async (filter = {}) => {
  const found = stores.orders.find((o) => matchesFilter(o, filter));
  return found ? { _id: found._id } : null;
};

User.find = (filter = {}) => makeChainQuery(() => stores.users.filter((u) => matchesFilter(u, filter)), false);
User.findOne = (filter = {}) => makeChainQuery(() => stores.users.filter((u) => matchesFilter(u, filter)), true);
User.findById = (id) => makeChainQuery(() => stores.users.filter((u) => String(u._id) === String(id)), true);
User.countDocuments = async (filter = {}) => stores.users.filter((u) => matchesFilter(u, filter)).length;
User.aggregate = async () => {
  const total = stores.users.filter((u) => (u.balance || 0) > 0).reduce((s, u) => s + (u.balance || 0), 0);
  return [{ _id: null, total }];
};
User.updateOne = async (filter, update) => {
  const u = stores.users.find((x) => matchesFilter(x, filter));
  if (u && update?.$set) Object.assign(u, update.$set);
  return { modifiedCount: u ? 1 : 0 };
};
User.findByIdAndUpdate = async (id, update) => {
  const u = stores.users.find((x) => String(x._id) === String(id));
  if (!u) return null;
  if (update?.$set) Object.assign(u, update.$set);
  return { ...u };
};

SupportTicket.find = (filter = {}) => makeChainQuery(() => stores.tickets.filter((t) => matchesFilter(t, filter)), false);
SupportTicket.findById = (id) => makeChainQuery(() => stores.tickets.filter((t) => String(t._id) === String(id)), true);
SupportTicket.countDocuments = async (filter = {}) => stores.tickets.filter((t) => matchesFilter(t, filter)).length;
SupportTicket.exists = async (filter = {}) => {
  const found = stores.tickets.find((t) => matchesFilter(t, filter));
  return found ? { _id: found._id } : null;
};
SupportTicket.create = async (data) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    status: 'open',
    priority: 'normal',
    assignedTo: null,
    assignedTelegramId: null,
    firstResponseAt: null,
    firstResponseBy: null,
    escalatedAt: null,
    escalatedBy: null,
    escalationReason: null,
    closedAt: null,
    closedBy: null,
    closeReason: null,
    rating: null,
    ratedAt: null,
    reminderCount: 0,
    staffNotifyMessages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  };
  stores.tickets.push(doc);
  return { ...doc };
};
SupportTicket.findOneAndUpdate = async (filter, update) => {
  const idx = stores.tickets.findIndex((t) => matchesFilter(t, filter));
  if (idx === -1) return null;
  if (update?.$set) {
    Object.assign(stores.tickets[idx], update.$set, { updatedAt: new Date() });
  }
  return { ...stores.tickets[idx] };
};
SupportTicket.updateOne = async (filter, update) => {
  const t = stores.tickets.find((x) => matchesFilter(x, filter));
  if (t && update?.$set) Object.assign(t, update.$set);
  return { modifiedCount: t ? 1 : 0 };
};

SupportMessage.find = (filter = {}) => makeChainQuery(() => stores.messages.filter((m) => matchesFilter(m, filter)), false);
SupportMessage.findOne = (filter = {}) => makeChainQuery(() => stores.messages.filter((m) => matchesFilter(m, filter)), true);
SupportMessage.countDocuments = async (filter = {}) => stores.messages.filter((m) => matchesFilter(m, filter)).length;
SupportMessage.create = async (data) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    mediaType: null,
    mediaFileId: null,
    mediaDataUrl: null,
    createdAt: new Date(),
    ...data,
  };
  stores.messages.push(doc);
  return { ...doc };
};
SupportMessage.updateOne = async (filter, update) => {
  const m = stores.messages.find((x) => matchesFilter(x, filter));
  if (m && update?.$set) Object.assign(m, update.$set);
  return { modifiedCount: m ? 1 : 0 };
};

StaffAuditLog.find = (filter = {}) => makeChainQuery(() => stores.auditLogs.filter((l) => matchesFilter(l, filter)), false);
StaffAuditLog.countDocuments = async (filter = {}) => stores.auditLogs.filter((l) => matchesFilter(l, filter)).length;
StaffAuditLog.create = async (data) => {
  const doc = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...data };
  stores.auditLogs.push(doc);
  return { ...doc };
};

Settings.findOne = async () => {
  if (!stores.settingsDoc) return null;
  return {
    ...stores.settingsDoc,
    async save() {
      const plain = { ...this };
      delete plain.save;
      stores.settingsDoc = plain;
      return stores.settingsDoc;
    },
  };
};

settingsCache.getSettings = async () => stores.settingsDoc;
settingsCache.invalidateCache = (updated) => {
  if (updated) {
    const plain = { ...updated };
    delete plain.save;
    stores.settingsDoc = plain;
  }
};
currencyService.getRate = () => 95;
currencyService.getBaseRate = () => 95;
currencyService.getUpdatedAt = () => new Date('2026-11-27T12:00:00Z');

// Fake bot for supportNotify & media proxy tests
const sentPhotos = [];
const sentTexts = [];
const fakeBot = {
  botInfo: { username: 'tig_market_test_bot' },
  telegram: {
    getMe: async () => ({ username: 'tig_market_test_bot' }),
    sendMessage: async (chatId, text, extra) => {
      callCounters.tgSendMessage += 1;
      sentTexts.push({ chatId, text, extra });
      return { message_id: 100 + sentTexts.length };
    },
    sendPhoto: async (chatId, media, extra) => {
      callCounters.tgSendPhoto += 1;
      sentPhotos.push({ chatId, media, extra });
      return { message_id: 200 + sentPhotos.length };
    },
    editMessageText: async () => true,
    getChat: async (cid) => {
      if (Number(cid) === -100555666777) {
        return { id: -100555666777, type: 'supergroup', title: 'TIG Support Group' };
      }
      if (Number(cid) === -100999888777) {
        return { id: -100999888777, type: 'channel', title: 'Channel Not Group' };
      }
      throw new Error('chat not found');
    },
    getFileLink: async (fileId) => ({
      href: `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileId}.png`,
    }),
  },
};
notif.getBotInstance = () => fakeBot;
supportNotify.setBot(fakeBot);

// Spy wrappers around supportNotify so we verify both calls AND real supportNotify buffer decoding
const origNotifyNewTicket = supportNotify.notifyNewTicket;
supportNotify.notifyNewTicket = async (...args) => {
  callCounters.notifyNewTicket += 1;
  return origNotifyNewTicket(...args);
};
const origNotifyStaffBuyerReply = supportNotify.notifyStaffBuyerReply;
supportNotify.notifyStaffBuyerReply = async (...args) => {
  callCounters.notifyStaffBuyerReply += 1;
  return origNotifyStaffBuyerReply(...args);
};
const origNotifyBuyerStaffReply = supportNotify.notifyBuyerStaffReply;
supportNotify.notifyBuyerStaffReply = async (...args) => {
  callCounters.notifyBuyerStaffReply += 1;
  return origNotifyBuyerStaffReply(...args);
};
const origNotifyEscalation = supportNotify.notifyEscalation;
supportNotify.notifyEscalation = async (...args) => {
  callCounters.notifyEscalation += 1;
  return origNotifyEscalation(...args);
};
const origNotifyClosed = supportNotify.notifyTicketClosedToBuyer;
supportNotify.notifyTicketClosedToBuyer = async (...args) => {
  callCounters.notifyTicketClosedToBuyer += 1;
  return origNotifyClosed(...args);
};
const origNotifyOwnerRole = supportNotify.notifyOwnerRoleChange;
supportNotify.notifyOwnerRoleChange = async (...args) => {
  callCounters.notifyOwnerRoleChange += 1;
  return origNotifyOwnerRole(...args);
};
const origSyncCard = supportNotify.syncTicketCardInChats;
supportNotify.syncTicketCardInChats = async (...args) => {
  callCounters.syncTicketCardInChats += 1;
  return origSyncCard(...args);
};

// Minimal valid 1x1 PNG buffer
const VALID_PNG_BUF = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BUF.toString('base64')}`;

// In-memory Express HTTP request simulator (no TCP socket connect needed in sandbox)
const requestApp = (_baseUrl, method, pathUrl, { token = null, body = null, headers = {} } = {}) => {
  return new Promise((resolve) => {
    const sock = new Duplex({
      autoDestroy: false,
      read() {},
      write(_chunk, _enc, cb) { cb(); },
    });

    const req = new PassThrough({ autoDestroy: false });
    req.method = method.toUpperCase();
    req.url = pathUrl;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.socket = sock;
    req.connection = sock;
    req.headers = { host: '127.0.0.1' };
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }
    if (token) {
      req.headers.authorization = `Bearer ${token}`;
    }

    let payloadBuf = null;
    if (body !== null && body !== undefined) {
      payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(payloadBuf.length);
    }

    const res = new http.ServerResponse(req);
    res.assignSocket(sock);

    const bodyChunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = (chunk, encoding, cb) => {
      if (chunk) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return origWrite(chunk, encoding, cb);
    };

    res.end = (chunk, encoding, cb) => {
      if (chunk && typeof chunk !== 'function') {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      return origEnd(chunk, encoding, cb);
    };

    res.on('finish', () => {
      const buf = Buffer.concat(bodyChunks);
      const resHeaders = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      const ct = resHeaders['content-type'] || '';
      let json = null;
      if (ct.includes('application/json')) {
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch (_) {}
      }
      resolve({
        status: res.statusCode,
        headers: resHeaders,
        body: json,
        raw: buf,
        text: buf.toString('utf8'),
      });
    });

    if (payloadBuf) req.end(payloadBuf);
    else req.end();
    app(req, res);
  });
};

// ─── Seed Initial Fixture Data ───────────────────────────────────────────────
function seedData() {
  stores.settingsDoc = {
    name: 'global',
    smartPricing: false,
    autoMarkdownEnabled: false,
    supportChatId: null,
    supportChatTitle: '',
    supportMaxOpenPerUser: 3,
    supportSlaMinutes: 15,
    supportAutoCloseHours: 48,
    supportQuickReplies: ['Проверяем заказ', 'Выдали замену'],
  };

  const uBuyer1 = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 100001,
    username: 'buyer_one',
    firstName: 'Buyer1',
    role: 'user',
    supportOnDuty: true,
    isBanned: false,
    balance: 10,
    totalSpent: 20,
    createdAt: new Date(),
  };
  const uBuyer2 = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 100002,
    username: 'buyer_two',
    firstName: 'Buyer2',
    role: 'user',
    supportOnDuty: true,
    isBanned: false,
    balance: 5,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uSupport1 = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 200001,
    username: 'support_one',
    firstName: 'Support1',
    role: 'support',
    supportOnDuty: true,
    isBanned: false,
    balance: 0,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uSupport2 = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 200002,
    username: 'support_two',
    firstName: 'Support2',
    role: 'support',
    supportOnDuty: true,
    isBanned: false,
    balance: 0,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uModerator = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 300001,
    username: 'mod_one',
    firstName: 'Mod1',
    role: 'moderator',
    supportOnDuty: true,
    isBanned: false,
    balance: 0,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uAdmin = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 900002,
    username: 'admin_one',
    firstName: 'Admin1',
    role: 'admin',
    supportOnDuty: true,
    isBanned: false,
    balance: 0,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uSuperAdmin = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 900001,
    username: 'owner_one',
    firstName: 'Owner',
    role: 'superadmin',
    supportOnDuty: true,
    isBanned: false,
    balance: 100,
    totalSpent: 0,
    createdAt: new Date(),
  };
  const uCandidate = {
    _id: new mongoose.Types.ObjectId(),
    telegramId: 100099,
    username: 'candidate_user',
    firstName: 'Candidate',
    role: 'user',
    supportOnDuty: true,
    isBanned: false,
    balance: 0,
    totalSpent: 0,
    createdAt: new Date(),
  };

  stores.users = [uBuyer1, uBuyer2, uSupport1, uSupport2, uModerator, uAdmin, uSuperAdmin, uCandidate];

  const catAI = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Нейросети & AI',
    icon: '🤖',
    sortOrder: 1,
    isActive: true,
  };
  const catMusic = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Музыка',
    icon: '🎵',
    sortOrder: 2,
    isActive: true,
  };
  const catEmpty = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Пустая категория',
    icon: '📭',
    sortOrder: 3,
    isActive: true,
  };
  stores.categories = [catAI, catMusic, catEmpty];

  const now = new Date();
  const futureFlash = new Date(now.getTime() + 3600 * 1000);
  const prodA = {
    _id: new mongoose.Types.ObjectId(),
    name: 'ChatGPT Plus (Key)',
    nameEn: 'ChatGPT Plus',
    categoryId: catAI._id,
    price: 20,
    type: 'key',
    deliveryMethod: 'ready_account',
    provider: 'local',
    manualStock: 0,
    sortOrder: 2,
    isActive: true,
    lastSoldAt: new Date(now.getTime() - 2 * 24 * 3600 * 1000),
    createdAt: new Date(now.getTime() - 20 * 24 * 3600 * 1000),
    flashSale: { enabled: true, discountPercent: 25, expiresAt: futureFlash }, // effectivePrice = 15
  };
  const prodB = {
    _id: new mongoose.Types.ObjectId(),
    name: 'API Key $5',
    nameEn: 'API Key 5',
    categoryId: catAI._id,
    price: 6,
    type: 'key',
    deliveryMethod: 'ready_account',
    provider: 'local',
    manualStock: 0,
    sortOrder: 1,
    isActive: true,
    createdAt: now,
    flashSale: { enabled: false },
  };
  const prodC = {
    _id: new mongoose.Types.ObjectId(),
    name: 'GPT Activation (Manual)',
    nameEn: 'GPT Activation',
    categoryId: catAI._id,
    price: 18,
    type: 'gpt_activation',
    deliveryMethod: 'activation',
    provider: 'local',
    manualStock: 0,
    sortOrder: 3,
    isActive: true,
    createdAt: now,
    flashSale: { enabled: false },
  };
  const prodD = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Spotify Premium (Manual)',
    nameEn: 'Spotify',
    categoryId: catMusic._id,
    price: 5,
    type: 'manual',
    deliveryMethod: 'activation',
    provider: 'local',
    manualStock: 10,
    sortOrder: 1,
    isActive: true,
    createdAt: now,
    flashSale: { enabled: false },
  };
  stores.products = [prodA, prodB, prodC, prodD];

  stores.keys = [
    { _id: new mongoose.Types.ObjectId(), productId: prodA._id, provider: 'local', isUsed: false, value: 'KEY-A1' },
    { _id: new mongoose.Types.ObjectId(), productId: prodB._id, provider: 'local', isUsed: false, value: 'KEY-B1' },
    { _id: new mongoose.Types.ObjectId(), productId: prodB._id, provider: 'local', isUsed: false, value: 'KEY-B2' },
    // prodC has 0 keys -> out of stock
  ];

  const ord1 = {
    _id: new mongoose.Types.ObjectId(),
    userId: uBuyer1._id,
    productId: prodA._id,
    status: 'completed',
    price: 15,
    qty: 1,
    createdAt: now,
  };
  stores.orders = [ord1];

  return {
    uBuyer1,
    uBuyer2,
    uSupport1,
    uSupport2,
    uModerator,
    uAdmin,
    uSuperAdmin,
    uCandidate,
    catAI,
    catMusic,
    catEmpty,
    prodA,
    prodB,
    prodC,
    prodD,
    ord1,
  };
}

async function runTests() {
  console.log('=== Contract #79 Offline Verification: TIG MARKET API, Grouped Catalog, Support & RBAC ===\n');
  const fx = seedData();

  const tokens = {
    buyer1: signUserToken(fx.uBuyer1),
    buyer2: signUserToken(fx.uBuyer2),
    support1: signUserToken(fx.uSupport1),
    support2: signUserToken(fx.uSupport2),
    moderator: signUserToken(fx.uModerator),
    admin: signUserToken(fx.uAdmin),
    superadmin: signUserToken(fx.uSuperAdmin),
  };

  const baseUrl = 'http://127.0.0.1';

  try {
    // ── 1. Health & Rebranding ──────────────────────────────────────────────
    console.log('1. Checking /api/v1/health & auth middleware role helpers:');
    const healthRes = await requestApp(baseUrl, 'GET', '/api/v1/health');
    check(healthRes.status === 200, 'GET /api/v1/health returns 200');
    check(healthRes.body?.service === 'TIG MARKET Web API v1', `GET /api/v1/health service === "TIG MARKET Web API v1" (got "${healthRes.body?.service}")`);
    check(!JSON.stringify(healthRes.body).includes('ShopBot'), 'GET /api/v1/health contains no ShopBot');

    check(isSupportOrAbove(fx.uSupport1) && isSupportOrAbove(fx.uModerator) && !isSupportOrAbove(fx.uBuyer1), 'isSupportOrAbove role helper works');
    check(isModeratorOrAbove(fx.uModerator) && !isModeratorOrAbove(fx.uSupport1), 'isModeratorOrAbove role helper works');
    check(isAdminOrAbove(fx.uAdmin) && isAdminOrAbove(fx.uSuperAdmin) && !isAdminOrAbove(fx.uModerator), 'isAdminOrAbove role helper works');

    // ── 2. Grouped Catalog API (no N+1, filters, category sort) ─────────────
    console.log('\n2. Checking catalog.routes.js (/categories batch stats & /products filters):');
    callCounters.categoryFind = 0;
    callCounters.productFind = 0;
    callCounters.keyAggregate = 0;
    callCounters.keyCountDocuments = 0;

    const catsRes = await requestApp(baseUrl, 'GET', '/api/v1/catalog/categories');
    check(catsRes.status === 200 && catsRes.body?.success === true, 'GET /api/v1/catalog/categories returns 200');
    check(callCounters.categoryFind === 1 && callCounters.productFind === 1 && callCounters.keyAggregate === 1, 'GET /categories uses exactly 1 Category.find, 1 Product.find, 1 Key.aggregate');
    check(callCounters.keyCountDocuments === 0, 'GET /categories executes ZERO N+1 Key.countDocuments calls');
    check(catsRes.body.totalProducts === 4, `totalProducts === 4 (got ${catsRes.body.totalProducts})`);

    const aiCat = catsRes.body.categories.find((c) => String(c.id) === String(fx.catAI._id));
    const musicCat = catsRes.body.categories.find((c) => String(c.id) === String(fx.catMusic._id));
    const emptyCat = catsRes.body.categories.find((c) => String(c.id) === String(fx.catEmpty._id));

    check(
      aiCat &&
      aiCat.productCount === 3 &&
      aiCat.inStockCount === 2 &&
      aiCat.minPrice === 6 &&
      aiCat.maxPrice === 18 &&
      aiCat.hasFlashSale === true &&
      aiCat.hasInstant === true &&
      aiCat.popularScore > 0 &&
      Array.isArray(aiCat.previewTitles) &&
      aiCat.previewTitles.length === 3 &&
      aiCat.previewTitles[0] === 'API Key $5',
      'AI category returns accurate inStockCount/minPrice/maxPrice/hasFlashSale/hasInstant/popularScore/previewTitles'
    );
    check(musicCat && musicCat.inStockCount === 1 && musicCat.hasInstant === false && musicCat.hasFlashSale === false, 'Music category returns manual stock & non-instant flags');
    check(emptyCat && emptyCat.productCount === 0 && emptyCat.inStockCount === 0 && emptyCat.minPrice === null, 'Empty category returns 0 counts & null minPrice');

    // Products default sort inside categoryId: { sortOrder: 1, price: 1, _id: 1 } -> prodB (sortOrder 1), prodA (sortOrder 2), prodC (sortOrder 3)
    const catProductsRes = await requestApp(baseUrl, 'GET', `/api/v1/catalog/products?categoryId=${fx.catAI._id}`);
    check(catProductsRes.status === 200 && catProductsRes.body.products.length === 3, 'GET /products?categoryId returns all 3 AI products');
    check(
      String(catProductsRes.body.products[0].id) === String(fx.prodB._id) &&
      String(catProductsRes.body.products[1].id) === String(fx.prodA._id) &&
      String(catProductsRes.body.products[2].id) === String(fx.prodC._id),
      'Default sort inside category follows { sortOrder: 1, price: 1, _id: 1 }'
    );

    // Filter minPrice & maxPrice (using effectivePrice: prodA is 15 because 25% flash sale on 20!)
    const priceFilterRes = await requestApp(baseUrl, 'GET', `/api/v1/catalog/products?categoryId=${fx.catAI._id}&minPrice=10&maxPrice=16&sort=price_asc`);
    check(
      priceFilterRes.status === 200 &&
      priceFilterRes.body.products.length === 1 &&
      String(priceFilterRes.body.products[0].id) === String(fx.prodA._id) &&
      priceFilterRes.body.products[0].effectivePrice === 15,
      'GET /products?minPrice=10&maxPrice=16&sort=price_asc filters by effectivePrice (Flash Sale 15 USDT)'
    );

    // sort=price_asc inside category
    const priceAscRes = await requestApp(baseUrl, 'GET', `/api/v1/catalog/products?categoryId=${fx.catAI._id}&sort=price_asc&inStock=true`);
    check(
      priceAscRes.status === 200 &&
      priceAscRes.body.products.length === 2 &&
      priceAscRes.body.products[0].effectivePrice === 6 &&
      priceAscRes.body.products[1].effectivePrice === 15,
      'GET /products?categoryId=...&sort=price_asc&inStock=true sorts by effectivePrice ascending'
    );

    // sort=price_asc without any filters must still sort by effectivePrice (Flash Sale prodA=15 before prodC=18)
    const purePriceAscRes = await requestApp(baseUrl, 'GET', '/api/v1/catalog/products?sort=price_asc');
    const pureOrder = purePriceAscRes.body.products.map((p) => String(p.id));
    check(
      purePriceAscRes.status === 200 &&
      pureOrder.length === 4 &&
      pureOrder.indexOf(String(fx.prodA._id)) < pureOrder.indexOf(String(fx.prodC._id)) &&
      purePriceAscRes.body.products.map((p) => p.effectivePrice).join(',') === '5,6,15,18',
      'GET /products?sort=price_asc (no other filters) sorts by effectivePrice (Flash Sale 15 before 18)'
    );

    // instantOnly=true & flashOnly=true
    const instantRes = await requestApp(baseUrl, 'GET', '/api/v1/catalog/products?instantOnly=true');
    check(instantRes.status === 200 && instantRes.body.products.every((p) => p.isInstant === true) && instantRes.body.products.length === 2, 'GET /products?instantOnly=true returns only instant products');

    const flashRes = await requestApp(baseUrl, 'GET', '/api/v1/catalog/products?flashOnly=true');
    check(flashRes.status === 200 && flashRes.body.products.length === 1 && String(flashRes.body.products[0].id) === String(fx.prodA._id), 'GET /products?flashOnly=true returns active Flash Sale products');

    // ── 3. Client Support Flow, PNG vs SVG/HTML, Anti-Spam & IDOR ───────────
    console.log('\n3. Checking support.routes.js (client tickets, PNG vs SVG/HTML, anti-spam, IDOR, media nosniff):');

    const unauthSupport = await requestApp(baseUrl, 'GET', '/api/v1/support/meta');
    check(unauthSupport.status === 401, 'GET /api/v1/support/meta without JWT returns 401');

    const metaBuyer = await requestApp(baseUrl, 'GET', '/api/v1/support/meta', { token: tokens.buyer1 });
    check(
      metaBuyer.status === 200 &&
      metaBuyer.body.ownerUrl === 'https://t.me/Tigrano_o' &&
      metaBuyer.body.maxOpen === 3 &&
      metaBuyer.body.isSupport === false &&
      metaBuyer.body.isModerator === false &&
      Array.isArray(metaBuyer.body.recentOrders) &&
      metaBuyer.body.recentOrders.length === 1,
      'GET /support/meta returns ownerUrl, maxOpen, role flags & recentOrders'
    );

    // Reject SVG & HTML disguised as PNG or SVG mime
    const svgRaw = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const badSvgMime = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'xss svg', imageBase64: `data:image/svg+xml;base64,${svgRaw}` },
    });
    check(badSvgMime.status === 400 && badSvgMime.body?.error === 'INVALID_IMAGE', 'POST /support/tickets rejects data:image/svg+xml with 400 INVALID_IMAGE');

    const spoofedSvgAsPng = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'spoofed png', imageBase64: `data:image/png;base64,${svgRaw}` },
    });
    check(spoofedSvgAsPng.status === 400 && spoofedSvgAsPng.body?.error === 'INVALID_IMAGE', 'POST /support/tickets rejects SVG magic-bytes spoofed as image/png with 400 INVALID_IMAGE');

    const htmlRaw = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const badHtml = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'html xss', imageBase64: `data:image/png;base64,${htmlRaw}` },
    });
    check(badHtml.status === 400 && badHtml.body?.error === 'INVALID_IMAGE', 'POST /support/tickets rejects HTML payload spoofed as image/png with 400 INVALID_IMAGE');

    // Valid PNG ticket creation + notifyNewTicket + TG Buffer photo
    callCounters.notifyNewTicket = 0;
    callCounters.tgSendPhoto = 0;
    const createRes = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: {
        topic: 'order',
        orderId: String(fx.ord1._id),
        text: 'Проблема с ключом ChatGPT',
        imageBase64: VALID_PNG_DATA_URL,
      },
    });
    check(createRes.status === 201 && createRes.body?.success === true, 'POST /support/tickets creates ticket with valid PNG (201)');
    check(callCounters.notifyNewTicket === 1 && callCounters.tgSendPhoto >= 1, 'notifyNewTicket & Telegram sendPhoto called for web ticket with PNG');
    check(
      sentPhotos.some((p) => Buffer.isBuffer(p.media?.source) && p.media.source.equals(VALID_PNG_BUF)),
      'supportNotify decoded mediaDataUrl to Buffer { source } when sending photo to Telegram'
    );
    check(
      createRes.body.message?.hasMedia === true &&
      typeof createRes.body.message?.mediaUrl === 'string' &&
      !JSON.stringify(createRes.body).includes('data:image/png;base64'),
      'Ticket response returns mediaUrl without leaking raw base64 mediaDataUrl'
    );

    const ticket1Id = createRes.body.ticket.id;
    const msg1Id = createRes.body.message.id;

    // Anti-spam limit (maxOpen = 3)
    const t2Res = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'Второй тикет' },
    });
    const t3Res = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'Третий тикет' },
    });
    const t4Blocked = await requestApp(baseUrl, 'POST', '/api/v1/support/tickets', {
      token: tokens.buyer1,
      body: { topic: 'general', text: 'Четвёртый тикет (должен быть заблокирован)' },
    });
    check(t2Res.status === 201 && t3Res.status === 201, 'Buyer can create up to 3 open tickets');
    check(t4Blocked.status === 429 && t4Blocked.body?.error === 'TOO_MANY_OPEN_TICKETS', '4th open ticket blocked with 429 TOO_MANY_OPEN_TICKETS');

    // IDOR protection across GET /:id, POST /reply, POST /close, POST /rate, GET /media/:msgId
    const idorGet = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}`, { token: tokens.buyer2 });
    const idorReply = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${ticket1Id}/reply`, {
      token: tokens.buyer2,
      body: { text: 'чужой ответ' },
    });
    const idorClose = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${ticket1Id}/close`, { token: tokens.buyer2 });
    const idorRate = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${ticket1Id}/rate`, {
      token: tokens.buyer2,
      body: { rating: 1 },
    });
    const idorMedia = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}/media/${msg1Id}`, { token: tokens.buyer2 });

    check(
      idorGet.status === 403 &&
      idorReply.status === 403 &&
      idorClose.status === 403 &&
      idorRate.status === 403 &&
      idorMedia.status === 403,
      'IDOR blocked (403) for non-owner buyer2 on GET /:id, /reply, /close, /rate, /media/:msgId'
    );

    // Owner media fetch with X-Content-Type-Options: nosniff
    const ownerMedia = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}/media/${msg1Id}`, { token: tokens.buyer1 });
    check(
      ownerMedia.status === 200 &&
      ownerMedia.headers['x-content-type-options'] === 'nosniff' &&
      ownerMedia.headers['content-type']?.includes('image/png') &&
      ownerMedia.raw.equals(VALID_PNG_BUF),
      'GET /media/:msgId returns PNG bytes with X-Content-Type-Options: nosniff for ticket owner'
    );

    // Telegram mediaFileId server-side proxy test (no BOT_TOKEN leaked!)
    const tgMsg = await SupportMessage.create({
      ticketId: ticket1Id,
      senderId: fx.uSupport1._id,
      senderTelegramId: fx.uSupport1.telegramId,
      senderRole: 'support',
      text: 'Скрин из бота',
      mediaType: 'photo',
      mediaFileId: 'AgACAgIAAxkBAAI_TEST_FILE_ID',
    });
    const origAxiosGet = axios.get;
    axios.get = async (url) => {
      assert(url.includes(process.env.BOT_TOKEN), 'Server-side axios fetches TG file link');
      return { data: VALID_PNG_BUF };
    };
    const tgMediaRes = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}/media/${tgMsg._id}`, { token: tokens.buyer1 });
    axios.get = origAxiosGet;

    const ownerTicketDetail = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}`, { token: tokens.buyer1 });
    check(
      tgMediaRes.status === 200 &&
      tgMediaRes.headers['x-content-type-options'] === 'nosniff' &&
      tgMediaRes.raw.equals(VALID_PNG_BUF),
      'GET /media/:msgId proxies Telegram mediaFileId server-side with nosniff'
    );
    check(
      ownerTicketDetail.status === 200 &&
      !JSON.stringify(ownerTicketDetail.body).includes(process.env.BOT_TOKEN) &&
      !JSON.stringify(ownerTicketDetail.body).includes('AgACAgIAAxkBAAI_TEST_FILE_ID') &&
      !JSON.stringify(ownerTicketDetail.body).includes('data:image/png;base64'),
      'GET /tickets/:id leaks neither BOT_TOKEN nor mediaFileId nor raw base64'
    );

    // Buyer reply & close & rate
    callCounters.notifyStaffBuyerReply = 0;
    const buyerReply = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${t3Res.body.ticket.id}/reply`, {
      token: tokens.buyer1,
      body: { text: 'Дополнение от покупателя' },
    });
    check(buyerReply.status === 200 && callCounters.notifyStaffBuyerReply === 1, 'POST /tickets/:id/reply succeeds for owner and notifies staff');

    const buyerCloseT3 = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${t3Res.body.ticket.id}/close`, { token: tokens.buyer1 });
    check(buyerCloseT3.status === 200 && buyerCloseT3.body.ticket.status === 'closed', 'POST /tickets/:id/close closes ticket');

    const replyClosed = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${t3Res.body.ticket.id}/reply`, {
      token: tokens.buyer1,
      body: { text: 'после закрытия' },
    });
    check(replyClosed.status === 409 && replyClosed.body?.error === 'TICKET_CLOSED', 'POST /tickets/:id/reply on closed ticket returns 409 TICKET_CLOSED');

    const badRate = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${t3Res.body.ticket.id}/rate`, {
      token: tokens.buyer1,
      body: { rating: 6 },
    });
    const goodRate = await requestApp(baseUrl, 'POST', `/api/v1/support/tickets/${t3Res.body.ticket.id}/rate`, {
      token: tokens.buyer1,
      body: { rating: 5 },
    });
    check(badRate.status === 400, 'POST /tickets/:id/rate rejects rating=6 (400)');
    check(goodRate.status === 200 && goodRate.body.ticket.rating === 5, 'POST /tickets/:id/rate saves rating=5');

    // ── 4. Staff Queues, Duty, Claim Race, Escalation, Close ────────────────
    console.log('\n4. Checking requireSupport, duty, take/claim, reply, escalate, close:');

    const userStaffBlocked = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues', { token: tokens.buyer1 });
    check(userStaffBlocked.status === 403, 'Regular user blocked from /staff/queues (403)');

    const dutyRes = await requestApp(baseUrl, 'POST', '/api/v1/support/staff/duty', { token: tokens.support1 });
    check(dutyRes.status === 200 && dutyRes.body.onDuty === false, 'POST /staff/duty toggles support1 onDuty -> false');
    await requestApp(baseUrl, 'POST', '/api/v1/support/staff/duty', { token: tokens.support1 });

    const waitingQueue = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues?tab=waiting', { token: tokens.support1 });
    check(
      waitingQueue.status === 200 &&
      waitingQueue.body.tickets.length === 2 &&
      Array.isArray(waitingQueue.body.quickReplies) &&
      waitingQueue.body.quickReplies.length === 2,
      'GET /staff/queues?tab=waiting returns open tickets and quickReplies'
    );

    const supportEscForbidden = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues?tab=escalated', { token: tokens.support1 });
    check(supportEscForbidden.status === 403, 'Regular support blocked from tab=escalated (403)');

    // Regular support cannot close an unassigned open ticket before claiming it (409 TAKE_TICKET_FIRST)
    const closeUnclaimed = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${t2Res.body.ticket.id}/close`, { token: tokens.support1 });
    check(closeUnclaimed.status === 409 && closeUnclaimed.body?.error === 'TAKE_TICKET_FIRST', 'Regular support must take open ticket before closing (409 TAKE_TICKET_FIRST)');

    // Take ticket1 by support1, second take by support2 returns 409 ALREADY_TAKEN
    const take1 = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/take`, { token: tokens.support1 });
    const take2 = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/take`, { token: tokens.support2 });
    check(take1.status === 200 && take1.body.ticket.status === 'in_progress', 'support1 claims ticket1 -> in_progress');
    check(take2.status === 409 && take2.body?.error === 'ALREADY_TAKEN', 'support2 taking claimed ticket1 returns 409 ALREADY_TAKEN');

    const otherReplyBlocked = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/reply`, {
      token: tokens.support2,
      body: { text: 'чужой саппорт' },
    });
    check(otherReplyBlocked.status === 403 && otherReplyBlocked.body?.error === 'TICKET_ASSIGNED_TO_OTHER', 'Another support blocked from replying to assigned ticket (403)');

    callCounters.notifyBuyerStaffReply = 0;
    const staffReply = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/reply`, {
      token: tokens.support1,
      body: { text: 'Проверяем ваш заказ, секунду.' },
    });
    check(staffReply.status === 200 && Boolean(staffReply.body.ticket.firstResponseAt) && callCounters.notifyBuyerStaffReply === 1, 'support1 reply sets firstResponseAt and calls notifyBuyerStaffReply');

    // Escalate ticket1 -> support cannot take escalated, moderator CAN view, take & close
    callCounters.notifyEscalation = 0;
    const escRes = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/escalate`, {
      token: tokens.support1,
      body: { reason: 'Нужен возврат средств через модератора' },
    });
    check(escRes.status === 200 && escRes.body.ticket.status === 'escalated' && callCounters.notifyEscalation === 1, 'POST /staff/tickets/:id/escalate sets status=escalated & notifies supervisors');

    // Buyer detail hides internal system escalation message ('🔺 ...')
    const buyerAfterEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}`, { token: tokens.buyer1 });
    const staffAfterEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}`, { token: tokens.moderator });
    check(
      buyerAfterEsc.status === 200 &&
      !buyerAfterEsc.body.messages.some((m) => m.senderRole === 'system' && m.text.startsWith('🔺')) &&
      staffAfterEsc.body.messages.some((m) => m.senderRole === 'system' && m.text.startsWith('🔺')),
      'Internal escalation message hidden from buyer but visible to moderator'
    );

    const supTakeEsc = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/take`, { token: tokens.support2 });
    const supCloseEsc = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/close`, { token: tokens.support2 });
    const supReEsc = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/escalate`, { token: tokens.support2, body: { reason: 'dup' } });
    const supGetEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}`, { token: tokens.support2 });
    const supMediaEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/tickets/${ticket1Id}/media/${msg1Id}`, { token: tokens.support2 });
    check(supTakeEsc.status === 403, 'Regular support blocked from taking escalated ticket (403)');
    check(supCloseEsc.status === 403, 'Regular support blocked from closing escalated ticket (403)');
    check(supReEsc.status === 409 && supReEsc.body?.error === 'ALREADY_ESCALATED', 'Re-escalating escalated ticket returns 409 ALREADY_ESCALATED');
    check(supGetEsc.status === 403 && supMediaEsc.status === 403, 'Regular support blocked from GET /tickets/:id and /media/:msgId for escalated ticket (403)');

    const modEscQueue = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues?tab=escalated', { token: tokens.moderator });
    check(modEscQueue.status === 200 && modEscQueue.body.tickets.length === 1, 'Moderator sees escalated queue');

    // ?search= in GET /staff/queues: finds by ticketNumber, @username, telegramId, and NEVER leaks escalated tickets to regular support
    const escTicketNum = createRes.body.ticket.ticketNumber;
    const supSearchEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/staff/queues?tab=all&search=${encodeURIComponent(escTicketNum)}`, { token: tokens.support2 });
    const modSearchEsc = await requestApp(baseUrl, 'GET', `/api/v1/support/staff/queues?tab=all&search=${encodeURIComponent(escTicketNum)}`, { token: tokens.moderator });
    const supSearchUser = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues?tab=waiting&search=%40buyer_one', { token: tokens.support2 });
    const supSearchTgId = await requestApp(baseUrl, 'GET', '/api/v1/support/staff/queues?tab=waiting&search=100001', { token: tokens.support2 });
    check(
      supSearchEsc.status === 200 &&
      supSearchEsc.body.tickets.length === 0 &&
      modSearchEsc.status === 200 &&
      modSearchEsc.body.tickets.some((t) => String(t.id) === String(ticket1Id)),
      'GET /staff/queues?tab=all&search= blocks escalated ticket from regular support while showing it to moderator'
    );
    check(
      supSearchUser.status === 200 &&
      supSearchUser.body.tickets.some((t) => String(t.id) === String(t2Res.body.ticket.id)) &&
      supSearchTgId.status === 200 &&
      supSearchTgId.body.tickets.some((t) => String(t.id) === String(t2Res.body.ticket.id)),
      'GET /staff/queues?search= matches open tickets by @username and numeric telegramId'
    );

    const modTakeEsc = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/take`, { token: tokens.moderator });
    check(modTakeEsc.status === 200 && modTakeEsc.body.ticket.status === 'in_progress', 'Moderator takes escalated ticket');

    callCounters.notifyTicketClosedToBuyer = 0;
    const modCloseEsc = await requestApp(baseUrl, 'POST', `/api/v1/support/staff/tickets/${ticket1Id}/close`, { token: tokens.moderator });
    check(modCloseEsc.status === 200 && modCloseEsc.body.ticket.status === 'closed' && callCounters.notifyTicketClosedToBuyer === 1, 'Moderator closes ticket and notifies buyer');

    // ── 5. Moderator RBAC, Role Escalation Limits, Admin Isolation & Settings ──
    console.log('\n5. Checking requireModerator, moderator restrictions, /api/v1/admin/* block, requireAdmin settings:');

    const supModBlocked = await requestApp(baseUrl, 'GET', '/api/v1/support/mod/team', { token: tokens.support1 });
    check(supModBlocked.status === 403, 'Support blocked from /mod/team (403)');

    // Moderator CANNOT touch ANY /api/v1/admin/* route
    const modAdminStats = await requestApp(baseUrl, 'GET', '/api/v1/admin/stats', { token: tokens.moderator });
    const modAdminUsers = await requestApp(baseUrl, 'GET', '/api/v1/admin/users', { token: tokens.moderator });
    const modAdminSettings = await requestApp(baseUrl, 'GET', '/api/v1/admin/settings', { token: tokens.moderator });
    const supAdminStats = await requestApp(baseUrl, 'GET', '/api/v1/admin/stats', { token: tokens.support1 });
    check(
      modAdminStats.status === 403 &&
      modAdminUsers.status === 403 &&
      modAdminSettings.status === 403 &&
      supAdminStats.status === 403,
      'Moderator and Support strictly blocked (403) from all /api/v1/admin/* routes'
    );

    const modTeamRes = await requestApp(baseUrl, 'GET', '/api/v1/support/mod/team', { token: tokens.moderator });
    check(modTeamRes.status === 200 && modTeamRes.body.team.length >= 5, 'GET /mod/team returns staff team');

    const modStatsRes = await requestApp(baseUrl, 'GET', `/api/v1/support/mod/staff/${fx.uSupport1._id}/stats?period=30d`, { token: tokens.moderator });
    check(
      modStatsRes.status === 200 &&
      modStatsRes.body.stats.repliesCount >= 1 &&
      modStatsRes.body.stats.escalatedFromCount === 1,
      'GET /mod/staff/:id/stats returns accurate support activity metrics'
    );

    // Moderator CAN promote user -> support, CANNOT promote to moderator/admin/superadmin
    const badAtQuery = await requestApp(baseUrl, 'POST', '/api/v1/support/mod/staff/role', {
      token: tokens.moderator,
      body: { queryOrId: '@', role: 'support' },
    });
    check(badAtQuery.status === 400 && badAtQuery.body?.error === 'INVALID_USER_QUERY', 'POST /mod/staff/role rejects "@" with 400 INVALID_USER_QUERY');
    const modEscToMod = await requestApp(baseUrl, 'POST', '/api/v1/support/mod/staff/role', {
      token: tokens.moderator,
      body: { queryOrId: '@candidate_user', role: 'moderator', reason: 'test' },
    });
    const modEscToAdmin = await requestApp(baseUrl, 'POST', '/api/v1/support/mod/staff/role', {
      token: tokens.moderator,
      body: { queryOrId: String(fx.uCandidate.telegramId), role: 'admin', reason: 'test' },
    });
    check(
      modEscToMod.status === 403 &&
      modEscToMod.body?.error === 'CANNOT_ESCALATE_ROLE' &&
      modEscToAdmin.status === 403 &&
      modEscToAdmin.body?.error === 'CANNOT_ESCALATE_ROLE',
      'Moderator CANNOT promote user to moderator or admin (403 CANNOT_ESCALATE_ROLE)'
    );

    callCounters.notifyOwnerRoleChange = 0;
    const modPromoteSup = await requestApp(baseUrl, 'POST', '/api/v1/support/mod/staff/role', {
      token: tokens.moderator,
      body: { queryOrId: '@candidate_user', role: 'support', reason: 'Прошел стажировку' },
    });
    check(
      modPromoteSup.status === 200 &&
      modPromoteSup.body.newRole === 'support' &&
      callCounters.notifyOwnerRoleChange === 1,
      'Moderator CAN promote user -> support with audit log & owner notification'
    );

    const auditLogsRes = await requestApp(baseUrl, 'GET', '/api/v1/support/mod/audit-logs', { token: tokens.moderator });
    check(auditLogsRes.status === 200 && auditLogsRes.body.logs.length >= 1, 'GET /mod/audit-logs returns role change audit history');

    // Mod settings read-only vs PATCH /admin/settings requireAdmin + chatId > 0 rejection
    const modViewSettings = await requestApp(baseUrl, 'GET', '/api/v1/support/mod/settings', { token: tokens.moderator });
    check(modViewSettings.status === 200 && modViewSettings.body.canEditSettings === false, 'Moderator GET /mod/settings has canEditSettings=false');

    const modPatchSettings = await requestApp(baseUrl, 'PATCH', '/api/v1/support/admin/settings', {
      token: tokens.moderator,
      body: { supportSlaMinutes: 5 },
    });
    check(modPatchSettings.status === 403, 'Moderator blocked (403) from PATCH /support/admin/settings');

    const adminBadChatId = await requestApp(baseUrl, 'PATCH', '/api/v1/support/admin/settings', {
      token: tokens.admin,
      body: { supportChatId: 123456789 },
    });
    check(adminBadChatId.status === 400 && adminBadChatId.body?.error === 'INVALID_CHAT_ID', 'PATCH /support/admin/settings rejects positive chatId > 0 (400 INVALID_CHAT_ID)');

    const adminChannelChat = await requestApp(baseUrl, 'PATCH', '/api/v1/support/admin/settings', {
      token: tokens.admin,
      body: { supportChatId: -100999888777 },
    });
    check(adminChannelChat.status === 400 && adminChannelChat.body?.error === 'INVALID_SUPPORT_CHAT', 'PATCH /support/admin/settings rejects Telegram channel chat');

    const adminGoodSettings = await requestApp(baseUrl, 'PATCH', '/api/v1/support/admin/settings', {
      token: tokens.admin,
      body: {
        supportChatId: -100555666777,
        supportSlaMinutes: 20,
        supportMaxOpenPerUser: 4,
        supportQuickReplies: ['Шаблон 1', 'Шаблон 2'],
      },
    });
    check(
      adminGoodSettings.status === 200 &&
      adminGoodSettings.body.supportChatId === -100555666777 &&
      adminGoodSettings.body.supportChatTitle === 'TIG Support Group' &&
      adminGoodSettings.body.supportSlaMinutes === 20 &&
      stores.settingsDoc.supportSlaMinutes === 20,
      'Admin PATCH /support/admin/settings validates supergroup via getChat and updates Settings cache'
    );

    // ── 6. Admin Users 5-Role Filters & Superadmin Role Assignment ──────────
    console.log('\n6. Checking admin.routes.js 5-role filters & PATCH /admin/users/:id:');
    const fSupport = await requestApp(baseUrl, 'GET', '/api/v1/admin/users?filter=support', { token: tokens.admin });
    const fMod = await requestApp(baseUrl, 'GET', '/api/v1/admin/users?filter=moderator', { token: tokens.admin });
    const fStaff = await requestApp(baseUrl, 'GET', '/api/v1/admin/users?filter=staff', { token: tokens.admin });
    const fAdmins = await requestApp(baseUrl, 'GET', '/api/v1/admin/users?filter=admins', { token: tokens.admin });

    check(fSupport.status === 200 && fSupport.body.users.every((u) => u.role === 'support') && fSupport.body.users.length === 3, 'GET /admin/users?filter=support filters support role');
    check(fMod.status === 200 && fMod.body.users.every((u) => u.role === 'moderator') && fMod.body.users.length === 1, 'GET /admin/users?filter=moderator filters moderator role');
    check(fStaff.status === 200 && fStaff.body.users.length === 6, 'GET /admin/users?filter=staff returns all 4 staff roles');
    check(fAdmins.status === 200 && fAdmins.body.users.length === 2, 'GET /admin/users?filter=admins returns admin + superadmin');

    const adminRoleDenied = await requestApp(baseUrl, 'PATCH', `/api/v1/admin/users/${fx.uCandidate._id}`, {
      token: tokens.admin,
      body: { role: 'moderator' },
    });
    check(adminRoleDenied.status === 403 && adminRoleDenied.body?.error === 'SUPERADMIN_REQUIRED', 'Regular admin blocked from PATCH /admin/users/:id role change (403 SUPERADMIN_REQUIRED)');

    const superRoleOk = await requestApp(baseUrl, 'PATCH', `/api/v1/admin/users/${fx.uCandidate._id}`, {
      token: tokens.superadmin,
      body: { role: 'moderator', reason: 'Назначен модератором' },
    });
    check(superRoleOk.status === 200 && superRoleOk.body.user.role === 'moderator', 'Superadmin assigns moderator via PATCH /admin/users/:id');
  } finally {
    // in-memory Express simulation requires no socket teardown
  }

  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

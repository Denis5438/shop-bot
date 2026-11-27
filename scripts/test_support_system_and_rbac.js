/**
 * scripts/test_support_system_and_rbac.js
 *
 * Comprehensive offline test suite for Support System, RBAC (support/moderator/admin/superadmin),
 * Group Chat vs DM routing, SLA Cron, Superadmin Search Fix in input.routes.js,
 * 64-byte callback_data limit, and website/ isolation.
 */

/* eslint-disable no-console */
'use strict';

// Set deterministic test env before loading src/config (dotenv does not overwrite existing env keys)
process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test_bot_token_offline';
process.env.SUPERADMIN_IDS = '900001';
process.env.ADMIN_IDS = '900002';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');

// Models
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const SupportTicket = require('../src/models/SupportTicket');
const SupportMessage = require('../src/models/SupportMessage');
const StaffAuditLog = require('../src/models/StaffAuditLog');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');
const Seller = require('../src/models/Seller');
const Transaction = require('../src/models/Transaction');
const PromoCode = require('../src/models/PromoCode');
const TopupRequest = require('../src/models/TopupRequest');
const SellerWithdrawal = require('../src/models/SellerWithdrawal');

// Middlewares & Config
const config = require('../src/config');
const auth = require('../src/bot/middlewares/auth');
const userMiddleware = require('../src/bot/middlewares/user');
const { tosMiddleware } = require('../src/bot/middlewares/tos');
const sessionClearMiddleware = require('../src/bot/middlewares/sessionClear');
const settingsCache = require('../src/services/settingsCache.service');
const notif = require('../src/services/notification.service');

// Services & Cron
const supportService = require('../src/services/support.service');
const supportNotify = require('../src/services/supportNotify.service');
const supportSlaCron = require('../src/cron/supportSla.cron');

// Keyboards, Scenes & Routes
const { mainKeyboard, buildMainMenuRichHtml } = require('../src/bot/keyboards/main.keyboard');
const { adminMainKeyboard, moderatorMainKeyboard } = require('../src/bot/keyboards/admin.keyboard');
const supportPanelScene = require('../src/bot/scenes/support_panel.scene');
const categoriesScene = require('../src/bot/scenes/admin/categories.scene');
const productsScene = require('../src/bot/scenes/admin/products.scene');
const usersScene = require('../src/bot/scenes/admin/users.scene');

const registerCoreRoutes = require('../src/bot/routes/core.routes');
const registerAdminRoutes = require('../src/bot/routes/admin.routes');
const registerSupportRoutes = require('../src/bot/routes/support.routes');
const registerSupportAdminRoutes = require('../src/bot/routes/support_admin.routes');
const registerInputRoutes = require('../src/bot/routes/input.routes');

// ─── Test counters ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const capturedCallbacks = [];

const check = (cond, msg) => {
  if (cond) {
    console.log(`  [PASS] ${msg}`);
    passed += 1;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failed += 1;
  }
};

const inspectMarkupCallbacks = (extra, sourceLabel) => {
  const markup = extra?.reply_markup || extra;
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (btn && typeof btn.callback_data === 'string') {
        capturedCallbacks.push({
          source: sourceLabel,
          text: btn.text,
          data: btn.callback_data,
          bytes: Buffer.byteLength(btn.callback_data, 'utf8'),
        });
      }
    }
  }
};

// ─── In-memory Mongoose-like Store & Query Engine ────────────────────────────
const stores = {
  users: [],
  settings: null,
  tickets: [],
  messages: [],
  auditLogs: [],
  orders: [],
  products: [],
  keys: [],
  sellers: [],
  transactions: [],
  promos: [],
  topups: [],
  withdrawals: [],
};

const toPlain = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;
  return typeof doc.toObject === 'function' ? doc.toObject({ getters: true }) : { ...doc };
};

const normVal = (v) => {
  if (v && typeof v === 'object' && v._bsontype === 'ObjectId') return String(v);
  if (v instanceof mongoose.Types.ObjectId) return String(v);
  return v;
};

const matchCondition = (actual, cond) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof RegExp) && !(cond instanceof mongoose.Types.ObjectId)) {
    const keys = Object.keys(cond);
    const isOperatorObj = keys.some((k) => k.startsWith('$'));
    if (isOperatorObj) {
      for (const op of keys) {
        const operand = cond[op];
        if (op === '$in') {
          const list = Array.isArray(operand) ? operand.map(normVal) : [];
          if (!list.includes(normVal(actual))) return false;
        } else if (op === '$nin') {
          const list = Array.isArray(operand) ? operand.map(normVal) : [];
          if (list.includes(normVal(actual))) return false;
        } else if (op === '$ne') {
          if (normVal(actual) === normVal(operand)) return false;
        } else if (op === '$gt') {
          if (actual == null || !(actual > operand)) return false;
        } else if (op === '$gte') {
          if (actual == null || !(actual >= operand)) return false;
        } else if (op === '$lt') {
          if (actual == null || !(actual < operand)) return false;
        } else if (op === '$lte') {
          if (actual == null || !(actual <= operand)) return false;
        } else if (op === '$regex') {
          const re = operand instanceof RegExp ? operand : new RegExp(operand, cond.$options || '');
          if (!re.test(String(actual ?? ''))) return false;
        } else if (op === '$options') {
          // handled with $regex
        }
      }
      return true;
    }
  }
  if (cond instanceof RegExp) {
    return cond.test(String(actual ?? ''));
  }
  if (cond === null) {
    return actual === null || actual === undefined;
  }
  return normVal(actual) === normVal(cond);
};

const matchesFilter = (doc, filter = {}) => {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(val) || !val.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(val) || !val.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    const actual = key.includes('.')
      ? key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), doc)
      : doc[key];
    if (!matchCondition(actual, val)) return false;
  }
  return true;
};

const applyUpdate = (doc, update = {}) => {
  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      doc[k] = v;
    }
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      doc[k] = Number(doc[k] || 0) + Number(v);
    }
  }
  doc.updatedAt = new Date();
  return doc;
};

const populateField = (doc, popSpec) => {
  if (!doc || typeof doc !== 'object') return doc;
  const spec = typeof popSpec === 'string' ? { path: popSpec } : popSpec;
  const { path: fieldPath, populate: nested } = spec;
  const rawVal = doc[fieldPath];
  if (!rawVal) return doc;
  const idStr = String(rawVal._id || rawVal);

  let target = null;
  if (['userId', 'assignedTo', 'escalatedBy', 'closedBy', 'firstResponseBy', 'senderId', 'targetUserId', 'actorUserId'].includes(fieldPath)) {
    target = stores.users.find((u) => String(u._id) === idStr);
  } else if (fieldPath === 'orderId') {
    target = stores.orders.find((o) => String(o._id) === idStr);
  } else if (fieldPath === 'productId') {
    target = stores.products.find((p) => String(p._id) === idStr);
  } else if (fieldPath === 'ticketId') {
    target = stores.tickets.find((t) => String(t._id) === idStr);
  }

  if (target) {
    let cloned = { ...target };
    if (nested) {
      cloned = populateField(cloned, nested);
    }
    doc[fieldPath] = cloned;
  }
  return doc;
};

const makeQuery = (resolverFn, isArray = true) => {
  const state = {
    populates: [],
    sortSpec: null,
    skipVal: 0,
    limitVal: null,
  };

  const execQuery = async (leanMode = false) => {
    let res = await resolverFn();
    if (isArray && Array.isArray(res)) {
      let arr = res.map((d) => ({ ...toPlain(d), save: d.save }));
      if (state.sortSpec) {
        const entries = Object.entries(state.sortSpec);
        arr.sort((a, b) => {
          for (const [field, dir] of entries) {
            const av = a[field] instanceof Date ? a[field].getTime() : (a[field] ?? 0);
            const bv = b[field] instanceof Date ? b[field].getTime() : (b[field] ?? 0);
            if (av < bv) return dir >= 0 ? -1 : 1;
            if (av > bv) return dir >= 0 ? 1 : -1;
          }
          return 0;
        });
      }
      if (state.skipVal) arr = arr.slice(state.skipVal);
      if (state.limitVal != null) arr = arr.slice(0, state.limitVal);
      if (state.populates.length) {
        arr = arr.map((item) => {
          let cloned = { ...item };
          for (const p of state.populates) cloned = populateField(cloned, p);
          return cloned;
        });
      }
      return leanMode ? arr.map((x) => { const c = { ...x }; delete c.save; return c; }) : arr;
    }

    if (!res) return null;
    let doc = res;
    if (state.populates.length || leanMode) {
      doc = { ...toPlain(res), ...(leanMode ? {} : { save: res.save }) };
      for (const p of state.populates) doc = populateField(doc, p);
    }
    return doc;
  };

  const q = {
    select() { return q; },
    populate(p) { state.populates.push(p); return q; },
    sort(s) { state.sortSpec = s; return q; },
    skip(n) { state.skipVal = Number(n) || 0; return q; },
    limit(n) { state.limitVal = Number(n); return q; },
    session() { return q; },
    lean() { return execQuery(true); },
    then(resolve, reject) { return execQuery(false).then(resolve, reject); },
    catch(reject) { return execQuery(false).catch(reject); },
  };
  return q;
};

let nextMsgId = 1000;
const sentBotCalls = [];
const deletedMessages = [];
let sendMessageHook = null;
let getChatHook = null;

function createMockBot() {
  const middlewares = [];
  const commands = [];
  const actions = [];
  const eventHandlers = [];

  const mockTelegram = {
    async sendMessage(chatId, text, extra = {}) {
      if (typeof sendMessageHook === 'function') {
        await sendMessageHook(chatId, text, extra);
      }
      inspectMarkupCallbacks(extra, `telegram.sendMessage(${chatId})`);
      const messageId = ++nextMsgId;
      sentBotCalls.push({ method: 'sendMessage', chatId, text, extra, messageId });
      return { message_id: messageId, chat: { id: chatId } };
    },
    async editMessageText(chatId, messageId, inlineMsgId, text, extra = {}) {
      inspectMarkupCallbacks(extra, `telegram.editMessageText(${chatId})`);
      sentBotCalls.push({ method: 'editMessageText', chatId, messageId, text, extra });
      return { message_id: messageId, chat: { id: chatId } };
    },
    async sendPhoto(chatId, fileId, extra = {}) {
      inspectMarkupCallbacks(extra, `telegram.sendPhoto(${chatId})`);
      const messageId = ++nextMsgId;
      sentBotCalls.push({ method: 'sendPhoto', chatId, fileId, extra, messageId });
      return { message_id: messageId, chat: { id: chatId } };
    },
    async sendDocument(chatId, fileId, extra = {}) {
      inspectMarkupCallbacks(extra, `telegram.sendDocument(${chatId})`);
      const messageId = ++nextMsgId;
      sentBotCalls.push({ method: 'sendDocument', chatId, fileId, extra, messageId });
      return { message_id: messageId, chat: { id: chatId } };
    },
    async sendVideo(chatId, fileId, extra = {}) {
      inspectMarkupCallbacks(extra, `telegram.sendVideo(${chatId})`);
      const messageId = ++nextMsgId;
      sentBotCalls.push({ method: 'sendVideo', chatId, fileId, extra, messageId });
      return { message_id: messageId, chat: { id: chatId } };
    },
    async deleteMessage(chatId, messageId) {
      deletedMessages.push({ chatId, messageId });
      return true;
    },
    async getChat(chatId) {
      if (typeof getChatHook === 'function') {
        return getChatHook(chatId);
      }
      return { id: chatId, type: 'supergroup', title: `Mock Chat ${chatId}` };
    },
    async getMe() { return { id: 777000, username: 'test_shop_bot' }; },
    async setMyCommands() { return true; },
  };

  const bot = {
    botInfo: { id: 777000, username: 'test_shop_bot' },
    telegram: mockTelegram,
    context: {},
    use(fn) { middlewares.push(fn); },
    start(fn) { commands.push({ cmds: ['start'], fns: [fn] }); },
    command(cmd, ...fns) {
      const list = Array.isArray(cmd) ? cmd : [cmd];
      commands.push({ cmds: list, fns });
    },
    action(pattern, ...fns) {
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      actions.push({ patterns, fns });
    },
    on(events, ...fns) {
      const list = Array.isArray(events) ? events : [events];
      eventHandlers.push({ events: list, fns });
    },
    catch() {},
  };

  const runPipeline = async (fns, ctx) => {
    let idx = -1;
    let fellThrough = false;
    const dispatch = async (i) => {
      if (i <= idx) throw new Error('next() called multiple times');
      idx = i;
      const fn = fns[i];
      if (!fn) {
        fellThrough = true;
        return;
      }
      await fn(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
    return !fellThrough;
  };

  const createCtx = ({
    user,
    chat = { id: user?.telegramId || 1, type: 'private' },
    session = {},
    message = null,
    callbackData = null,
  }) => {
    const replies = [];
    const edits = [];
    const alerts = [];

    const ctx = {
      user,
      from: user ? { id: user.telegramId, username: user.username, first_name: user.firstName } : undefined,
      chat,
      session,
      botInfo: bot.botInfo,
      telegram: mockTelegram,
      t: (k) => k,
      i18n: { setLocale() {} },
      message,
      callbackQuery: callbackData ? { data: callbackData, message: { message_id: 500 } } : undefined,
      replies,
      edits,
      alerts,
      async reply(text, extra = {}) {
        inspectMarkupCallbacks(extra, `ctx.reply(${callbackData || message?.text || 'msg'})`);
        const msgId = ++nextMsgId;
        replies.push({ text, extra, message_id: msgId });
        return { message_id: msgId };
      },
      async editMessageText(text, extra = {}) {
        inspectMarkupCallbacks(extra, `ctx.editMessageText(${callbackData || 'edit'})`);
        edits.push({ text, extra });
        return { message_id: 500 };
      },
      async editMessageReplyMarkup(markup) {
        inspectMarkupCallbacks({ reply_markup: markup }, `ctx.editMessageReplyMarkup(${callbackData || 'markup'})`);
        return true;
      },
      async answerCbQuery(text = '', opts = {}) {
        alerts.push({ text, opts });
        return true;
      },
    };
    return ctx;
  };

  const dispatchAction = async (cbData, ctxParams) => {
    const ctx = createCtx({ ...ctxParams, callbackData: cbData });
    for (const entry of actions) {
      for (const pat of entry.patterns) {
        if (typeof pat === 'string' && pat === cbData) {
          ctx.match = [cbData];
          await runPipeline([...middlewares, ...entry.fns], ctx);
          return ctx;
        }
        if (pat instanceof RegExp) {
          const m = cbData.match(pat);
          if (m) {
            ctx.match = m;
            await runPipeline([...middlewares, ...entry.fns], ctx);
            return ctx;
          }
        }
      }
    }
    throw new Error(`No registered action matched: ${cbData}`);
  };

  const dispatchCommand = async (cmdName, ctxParams) => {
    const ctx = createCtx({
      ...ctxParams,
      message: ctxParams.message || { text: `/${cmdName}`, message_id: ++nextMsgId },
    });
    for (const entry of commands) {
      if (entry.cmds.includes(cmdName)) {
        await runPipeline([...middlewares, ...entry.fns], ctx);
        return ctx;
      }
    }
    throw new Error(`No registered command matched: /${cmdName}`);
  };

  const dispatchEvent = async (eventType, ctxParams) => {
    const ctx = createCtx(ctxParams);
    let idx = 0;
    const matching = eventHandlers.filter((h) => h.events.includes(eventType));
    const stepHandler = async () => {
      if (idx >= matching.length) return { ctx, fellThrough: true };
      const entry = matching[idx++];
      let calledNext = false;
      await runPipeline(entry.fns, {
        ...ctx,
        // wait: preserve ctx identity so session mutations are observable on ctx
      });
      return calledNext;
    };
    // Chain all matching event handlers in registration order cleanly
    const flattened = [];
    for (const m of matching) flattened.push(...m.fns);
    const handled = await runPipeline(flattened, ctx);
    ctx._handled = handled;
    void stepHandler;
    return ctx;
  };

  return { bot, createCtx, dispatchAction, dispatchCommand, dispatchEvent };
}

function setupStubs() {
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

  // Settings
  stores.settings = new Settings({ name: 'global' });
  stores.settings.save = async function () { return this; };

  Settings.findOne = () => makeQuery(async () => stores.settings, false);
  Settings.findOneAndUpdate = (filter, update, opts = {}) => makeQuery(async () => {
    if (!stores.settings && opts.upsert) {
      stores.settings = new Settings({ name: 'global' });
    }
    if (!stores.settings) return null;
    applyUpdate(stores.settings, update);
    return stores.settings;
  }, false);
  settingsCache.invalidateCache(stores.settings);

  // User stubs
  User.findOne = (filter = {}) => makeQuery(async () => stores.users.find((u) => matchesFilter(u, filter)) || null, false);
  User.findById = (id) => makeQuery(async () => stores.users.find((u) => String(u._id) === String(id)) || null, false);
  User.find = (filter = {}) => makeQuery(async () => stores.users.filter((u) => matchesFilter(u, filter)), true);
  User.countDocuments = async (filter = {}) => stores.users.filter((u) => matchesFilter(u, filter)).length;
  User.updateOne = async (filter, update) => {
    const u = stores.users.find((x) => matchesFilter(x, filter));
    if (!u) return { modifiedCount: 0 };
    applyUpdate(u, update);
    return { modifiedCount: 1 };
  };
  User.findByIdAndUpdate = (id, update) => makeQuery(async () => {
    const u = stores.users.find((x) => String(x._id) === String(id));
    if (!u) return null;
    applyUpdate(u, update);
    return u;
  }, false);
  User.prototype.save = async function () {
    if (!this._id) this._id = new mongoose.Types.ObjectId();
    const idx = stores.users.findIndex((u) => String(u._id) === String(this._id));
    if (idx >= 0) stores.users[idx] = this;
    else stores.users.push(this);
    return this;
  };

  // SupportTicket stubs (atomic synchronous match-and-mutate for findOneAndUpdate)
  SupportTicket.create = async (data) => {
    const doc = new SupportTicket(data);
    await doc.validate();
    if (stores.tickets.some((t) => t.ticketNumber === doc.ticketNumber)) {
      const err = new Error('Duplicate ticketNumber');
      err.code = 11000;
      throw err;
    }
    const plain = toPlain(doc);
    plain.save = async function () { return this; };
    stores.tickets.push(plain);
    return plain;
  };
  SupportTicket.exists = async (filter) => {
    const found = stores.tickets.find((t) => matchesFilter(t, filter));
    return found ? { _id: found._id } : null;
  };
  SupportTicket.countDocuments = async (filter = {}) => stores.tickets.filter((t) => matchesFilter(t, filter)).length;
  SupportTicket.find = (filter = {}) => makeQuery(async () => stores.tickets.filter((t) => matchesFilter(t, filter)), true);
  SupportTicket.findById = (id) => makeQuery(async () => stores.tickets.find((t) => String(t._id) === String(id)) || null, false);
  SupportTicket.findOne = (filter = {}) => makeQuery(async () => stores.tickets.find((t) => matchesFilter(t, filter)) || null, false);
  SupportTicket.updateOne = async (filter, update) => {
    const t = stores.tickets.find((x) => matchesFilter(x, filter));
    if (!t) return { modifiedCount: 0 };
    applyUpdate(t, update);
    return { modifiedCount: 1 };
  };
  SupportTicket.findOneAndUpdate = (filter, update, opts = {}) => {
    // Synchronous atomic check+mutate before resolving promise!
    const t = stores.tickets.find((x) => matchesFilter(x, filter));
    let result = null;
    if (t) {
      const before = { ...t };
      applyUpdate(t, update);
      result = opts.new === false ? before : t;
    }
    return makeQuery(async () => result, false);
  };

  // SupportMessage stubs
  SupportMessage.create = async (data) => {
    const doc = toPlain(new SupportMessage(data));
    stores.messages.push(doc);
    return doc;
  };
  SupportMessage.find = (filter = {}) => makeQuery(async () => stores.messages.filter((m) => matchesFilter(m, filter)), true);
  SupportMessage.findOne = (filter = {}) => makeQuery(async () => {
    const arr = stores.messages.filter((m) => matchesFilter(m, filter));
    return arr[0] || null;
  }, false);
  SupportMessage.countDocuments = async (filter = {}) => stores.messages.filter((m) => matchesFilter(m, filter)).length;

  // StaffAuditLog stubs
  StaffAuditLog.create = async (data) => {
    const doc = toPlain(new StaffAuditLog(data));
    stores.auditLogs.push(doc);
    return doc;
  };
  StaffAuditLog.find = (filter = {}) => makeQuery(async () => stores.auditLogs.filter((l) => matchesFilter(l, filter)), true);
  StaffAuditLog.countDocuments = async (filter = {}) => stores.auditLogs.filter((l) => matchesFilter(l, filter)).length;

  // Order / Product / Key / Seller / Others
  Order.find = (filter = {}) => makeQuery(async () => stores.orders.filter((o) => matchesFilter(o, filter)), true);
  Order.findOne = (filter = {}) => makeQuery(async () => stores.orders.find((o) => matchesFilter(o, filter)) || null, false);
  Order.findById = (id) => makeQuery(async () => stores.orders.find((o) => String(o._id) === String(id)) || null, false);
  Order.countDocuments = async (filter = {}) => stores.orders.filter((o) => matchesFilter(o, filter)).length;
  Order.aggregate = async () => [];

  Product.find = (filter = {}) => makeQuery(async () => stores.products.filter((p) => matchesFilter(p, filter)), true);
  Product.findById = (id) => makeQuery(async () => stores.products.find((p) => String(p._id) === String(id)) || null, false);
  Product.countDocuments = async (filter = {}) => stores.products.filter((p) => matchesFilter(p, filter)).length;

  Key.aggregate = async () => [];
  Key.countDocuments = async () => 0;
  Seller.exists = async () => null;
  Seller.findOne = () => makeQuery(async () => null, false);
  TopupRequest.countDocuments = async () => 0;
  SellerWithdrawal.countDocuments = async () => 0;
  PromoCode.findOne = () => makeQuery(async () => null, false);
  Transaction.prototype.save = async function () { stores.transactions.push(this); return this; };
}

const seedUser = (attrs) => {
  const u = {
    _id: new mongoose.Types.ObjectId(),
    username: null,
    firstName: 'Test',
    lastName: '',
    language: 'ru',
    balance: 0,
    role: 'user',
    promotedBy: null,
    supportOnDuty: true,
    supportLastActiveAt: null,
    roleChangedAt: null,
    roleChangedBy: null,
    acceptedToS: true,
    isBanned: false,
    createdAt: new Date(Date.now() - 120000),
    save: async function () { return this; },
    ...attrs,
  };
  stores.users.push(u);
  return u;
};

async function runTests() {
  console.log('=== Automated Verification Suite: Support System, RBAC & Superadmin Search Fix ===\n');
  setupStubs();

  // ── 1. Models: Schemas, Defaults, Indexes ─────────────────────────────────
  console.log('1. Checking Models (User, Settings, SupportTicket, SupportMessage, StaffAuditLog):');
  {
    const roleEnum = User.schema.path('role').enumValues;
    check(
      ['user', 'support', 'moderator', 'admin', 'superadmin'].every((r) => roleEnum.includes(r)) && roleEnum.length === 5,
      'User.role enum contains exactly user, support, moderator, admin, superadmin'
    );
    const defaultUser = new User({ telegramId: 11111 });
    check(defaultUser.supportOnDuty === true, 'User.supportOnDuty defaults to true');
    check(defaultUser.supportLastActiveAt === null, 'User.supportLastActiveAt defaults to null');
    check(defaultUser.roleChangedAt === null, 'User.roleChangedAt defaults to null');
    check(defaultUser.roleChangedBy === null, 'User.roleChangedBy defaults to null');
    const userIdx = User.schema.indexes().find(([spec]) => spec.role === 1 && spec.supportOnDuty === 1);
    check(Boolean(userIdx), 'User has index { role: 1, supportOnDuty: 1 }');

    const defaultSettings = new Settings({ name: 'global' });
    check(defaultSettings.supportChatId === null, 'Settings.supportChatId defaults to null');
    check(defaultSettings.supportChatTitle === '', 'Settings.supportChatTitle defaults to ""');
    check(defaultSettings.supportMaxOpenPerUser === 3, 'Settings.supportMaxOpenPerUser defaults to 3');
    check(defaultSettings.supportSlaMinutes === 15, 'Settings.supportSlaMinutes defaults to 15');
    check(defaultSettings.supportAutoCloseHours === 48, 'Settings.supportAutoCloseHours defaults to 48');
    check(
      Array.isArray(defaultSettings.supportQuickReplies) && defaultSettings.supportQuickReplies.length === 4,
      'Settings.supportQuickReplies has 4 default templates'
    );

    const sampleTicket = new SupportTicket({
      userId: new mongoose.Types.ObjectId(),
      telegramId: 12345,
      topic: 'order',
    });
    await sampleTicket.validate();
    check(/^SUP-[A-Z0-9]+$/.test(sampleTicket.ticketNumber), 'SupportTicket auto-generates ticketNumber SUP-XXXX');
    check(sampleTicket.status === 'open' && sampleTicket.priority === 'normal' && sampleTicket.reminderCount === 0, 'SupportTicket defaults (status=open, priority=normal, reminderCount=0)');
    const ticketIdxs = SupportTicket.schema.indexes();
    check(
      ticketIdxs.some(([spec, opts]) => spec.ticketNumber === 1 && opts?.unique === true),
      'SupportTicket has unique index { ticketNumber: 1 }'
    );
    check(
      ticketIdxs.some(([spec]) => spec.status === 1 && spec.assignedTo === 1),
      'SupportTicket has index { status: 1, assignedTo: 1 }'
    );

    const msgIdxs = SupportMessage.schema.indexes();
    check(
      msgIdxs.some(([spec]) => spec.ticketId === 1 && spec.createdAt === 1),
      'SupportMessage has index { ticketId: 1, createdAt: 1 }'
    );
    check(
      SupportMessage.schema.path('senderRole').enumValues.includes('system'),
      'SupportMessage.senderRole supports system & staff roles'
    );

    const auditIdxs = StaffAuditLog.schema.indexes();
    check(
      auditIdxs.some(([spec]) => spec.createdAt === -1),
      'StaffAuditLog has index { createdAt: -1 }'
    );
  }

  // ── 2. auth.js helpers & middlewares + user.js + sessionClear.js ──────────
  console.log('\n2. Checking auth.js, user.js role preservation, and sessionClear.js:');
  {
    const roles = ['user', 'support', 'moderator', 'admin', 'superadmin'];
    const matrix = {
      isSupportOrAbove: [false, true, true, true, true],
      isModeratorOrAbove: [false, false, true, true, true],
      isAdminOrAbove: [false, false, false, true, true],
      isSuperAdmin: [false, false, false, false, true],
    };

    for (const [fnName, expected] of Object.entries(matrix)) {
      const ok = roles.every((role, i) => auth[fnName]({ role }) === expected[i]) && auth[fnName](null) === false;
      check(ok, `auth.${fnName} matches role matrix across all 5 roles + null`);
    }

    const testMw = async (mw, role) => {
      let nextCalled = false;
      let replied = false;
      await mw(
        {
          user: { role },
          chat: { id: 100, type: 'private' },
          reply: async () => { replied = true; },
          answerCbQuery: async () => {},
        },
        async () => { nextCalled = true; }
      );
      return { nextCalled, replied };
    };

    check((await testMw(auth.supportMiddleware, 'support')).nextCalled, 'supportMiddleware allows support');
    check(!(await testMw(auth.supportMiddleware, 'user')).nextCalled, 'supportMiddleware blocks user');
    check((await testMw(auth.moderatorMiddleware, 'moderator')).nextCalled, 'moderatorMiddleware allows moderator');
    check(!(await testMw(auth.moderatorMiddleware, 'support')).nextCalled, 'moderatorMiddleware blocks support');
    check(!(await testMw(auth.adminMiddleware, 'moderator')).nextCalled, 'adminMiddleware strictly blocks moderator');
    check((await testMw(auth.adminMiddleware, 'admin')).nextCalled, 'adminMiddleware allows admin');
    check((await testMw(auth.adminMiddleware, 'superadmin')).nextCalled, 'adminMiddleware allows superadmin');
    check(!(await testMw(auth.superadminMiddleware, 'admin')).nextCalled, 'superadminMiddleware blocks admin');
    check((await testMw(auth.superadminMiddleware, 'superadmin')).nextCalled, 'superadminMiddleware allows superadmin');

    // user.js: preserve moderator & support roles when syncing
    userMiddleware.clearUserCache();
    const preservedMod = seedUser({ telegramId: 20001, username: 'mod_keep', role: 'moderator' });
    const preservedSup = seedUser({ telegramId: 20002, username: 'sup_keep', role: 'support' });
    await userMiddleware({ from: { id: 20001, username: 'mod_keep', first_name: 'Mod' } }, async () => {});
    await userMiddleware({ from: { id: 20002, username: 'sup_keep', first_name: 'Sup' } }, async () => {});
    check(preservedMod.role === 'moderator' && preservedSup.role === 'support', 'user.js does NOT reset moderator or support roles back to user');
    userMiddleware.clearUserCache();

    // sessionClear.js
    const sc = sessionClearMiddleware();
    for (const trigger of [
      { message: { text: '/start' } },
      { callbackQuery: { data: 'menu:main' } },
      { callbackQuery: { data: 'admin:main' } },
      { callbackQuery: { data: 'sp:home' } },
      { callbackQuery: { data: 'adm_sup:hub' } },
    ]) {
      const ctxSc = {
        ...trigger,
        session: {
          supportAction: 'buyer_new_text',
          staffAdminAction: 'set_sla_minutes',
          activeTicketId: '123',
          supportTopic: 'order',
          supportOrderId: '456',
        },
      };
      await sc(ctxSc, async () => {});
      const cleared = !ctxSc.session.supportAction && !ctxSc.session.staffAdminAction && !ctxSc.session.activeTicketId && !ctxSc.session.supportTopic && !ctxSc.session.supportOrderId;
      check(cleared, `sessionClear clears support session fields on ${trigger.message?.text || trigger.callbackQuery?.data}`);
    }
  }

  // Seed actors for service & bot tests
  const superadmin = seedUser({ telegramId: 900001, username: 'owner_sa', firstName: 'Owner', role: 'superadmin' });
  const admin = seedUser({ telegramId: 900002, username: 'shop_admin', firstName: 'Admin', role: 'admin' });
  const moderator = seedUser({ telegramId: 900003, username: 'senior_mod', firstName: 'Moderator', role: 'moderator', supportOnDuty: true });
  const support1 = seedUser({ telegramId: 900004, username: 'sup_one', firstName: 'Sup1', role: 'support', supportOnDuty: true });
  const support2 = seedUser({ telegramId: 900005, username: 'sup_two', firstName: 'Sup2', role: 'support', supportOnDuty: false });
  const buyer1 = seedUser({ telegramId: 900006, username: 'buyer_alex', firstName: 'Alex', role: 'user', acceptedToS: true });
  const buyer2 = seedUser({ telegramId: 900007, username: 'buyer_nina', firstName: 'Nina', role: 'user', acceptedToS: false });
  const targetRegular = seedUser({ telegramId: 900008, username: 'candidate_u', firstName: 'Candidate', role: 'user' });
  const otherMod = seedUser({ telegramId: 900009, username: 'other_mod', firstName: 'Mod2', role: 'moderator' });

  // Setup mock bot & register ALL bot routes
  const { bot, createCtx, dispatchAction, dispatchCommand, dispatchEvent } = createMockBot();
  notif.setBot(bot);
  supportNotify.setBot(bot);
  supportNotify.setBotUsername('test_shop_bot');
  registerCoreRoutes(bot);
  registerAdminRoutes(bot);
  registerSupportRoutes(bot);
  registerSupportAdminRoutes(bot);
  registerInputRoutes(bot);

  // ── 3. Strict RBAC Matrix + Audit Log + Owner Notification ────────────────
  console.log('\n3. Checking Strict RBAC Matrix, StaffAuditLog & Owner Notification:');
  {
    sentBotCalls.length = 0;

    // Moderator CAN promote user -> support
    const modPromoteSup = await supportService.assignStaffRole({
      actorUser: moderator,
      targetUser: targetRegular,
      newRole: 'support',
      reason: 'Onboarding',
    });
    check(modPromoteSup.ok === true && targetRegular.role === 'support', 'Moderator CAN assign support role to user');
    check(targetRegular.roleChangedBy === moderator.telegramId && targetRegular.roleChangedAt instanceof Date, 'assignStaffRole sets roleChangedBy & roleChangedAt');
    check(stores.auditLogs.length === 1 && stores.auditLogs[0].oldRole === 'user' && stores.auditLogs[0].newRole === 'support', 'StaffAuditLog record created on role change');

    await supportNotify.notifyOwnerRoleChange({
      actorUser: moderator,
      targetUser: targetRegular,
      oldRole: 'user',
      newRole: 'support',
      reason: 'Onboarding',
    });
    const ownerNotif = sentBotCalls.find((c) => c.method === 'sendMessage' && Number(c.chatId) === config.SUPERADMIN_IDS[0]);
    check(Boolean(ownerNotif && ownerNotif.text.includes('support')), 'notifyOwnerRoleChange sends DM to SUPERADMIN_IDS');

    // Moderator CANNOT escalate or touch moderator/admin/superadmin
    const rModToMod = await supportService.assignStaffRole({ actorUser: moderator, targetUser: targetRegular, newRole: 'moderator' });
    check(rModToMod.ok === false && rModToMod.error === 'CANNOT_ESCALATE_ROLE', 'Moderator CANNOT promote support to moderator (CANNOT_ESCALATE_ROLE)');

    const rModToAdmin = await supportService.assignStaffRole({ actorUser: moderator, targetUser: targetRegular, newRole: 'admin' });
    check(rModToAdmin.ok === false && rModToAdmin.error === 'CANNOT_ESCALATE_ROLE', 'Moderator CANNOT promote support to admin (CANNOT_ESCALATE_ROLE)');

    const rModToSuper = await supportService.assignStaffRole({ actorUser: moderator, targetUser: targetRegular, newRole: 'superadmin' });
    check(rModToSuper.ok === false && rModToSuper.error === 'CANNOT_ESCALATE_ROLE', 'Moderator CANNOT promote to superadmin (CANNOT_ESCALATE_ROLE)');

    const rModDemoteMod = await supportService.assignStaffRole({ actorUser: moderator, targetUser: otherMod, newRole: 'user' });
    check(rModDemoteMod.ok === false && rModDemoteMod.error === 'CANNOT_ESCALATE_ROLE', 'Moderator CANNOT demote another moderator (CANNOT_ESCALATE_ROLE)');

    const rModDemoteAdmin = await supportService.assignStaffRole({ actorUser: moderator, targetUser: admin, newRole: 'support' });
    check(rModDemoteAdmin.ok === false && rModDemoteAdmin.error === 'CANNOT_ESCALATE_ROLE', 'Moderator CANNOT change admin role (CANNOT_ESCALATE_ROLE)');

    // Moderator CAN demote support -> user
    const modDemoteSup = await supportService.assignStaffRole({ actorUser: moderator, targetUser: targetRegular, newRole: 'user', reason: 'Offboard' });
    check(modDemoteSup.ok === true && targetRegular.role === 'user', 'Moderator CAN demote support back to user');

    // Admin CANNOT promote to admin or demote admin
    const rAdminToAdmin = await supportService.assignStaffRole({ actorUser: admin, targetUser: targetRegular, newRole: 'admin' });
    check(rAdminToAdmin.ok === false && rAdminToAdmin.error === 'CANNOT_ESCALATE_ROLE', 'Admin CANNOT assign admin role');

    // Superadmin CAN assign moderator & admin, CANNOT modify self or superadmin
    const rSaMod = await supportService.assignStaffRole({ actorUser: superadmin, targetUser: targetRegular, newRole: 'moderator' });
    check(rSaMod.ok === true && targetRegular.role === 'moderator', 'Superadmin CAN assign moderator');
    const rSaSelf = await supportService.assignStaffRole({ actorUser: superadmin, targetUser: superadmin, newRole: 'user' });
    check(rSaSelf.ok === false && rSaSelf.error === 'CANNOT_MODIFY_SELF', 'Superadmin CANNOT demote self');
    // Reset targetRegular back to user so it doesn't pollute duty/team counts
    await supportService.assignStaffRole({ actorUser: superadmin, targetUser: targetRegular, newRole: 'user' });

    // Route-level RBAC for Moderator vs Admin
    const modAdminMainCtx = await dispatchAction('admin:main', { user: moderator });
    const modMainText = modAdminMainCtx.edits[0]?.text || modAdminMainCtx.replies[0]?.text || '';
    const modMainKb = modAdminMainCtx.edits[0]?.extra?.reply_markup || modAdminMainCtx.replies[0]?.extra?.reply_markup;
    const modMainCbs = (modMainKb?.inline_keyboard || []).flat().map((b) => b.callback_data);
    check(modMainText.includes('Панель модератора'), 'Moderator hitting admin:main sees moderator summary');
    check(
      modMainCbs.includes('adm_sup:hub') && modMainCbs.includes('sp:home') && modMainCbs.includes('adm_sup:find') && !modMainCbs.includes('admin:payments'),
      'moderatorMainKeyboard exposes only safe support/mod actions, NO admin financial buttons'
    );

    // Moderator blocked on balances, settings, products, payments, SLA edits
    for (const blockedCb of [
      'admin:products',
      'admin:payments',
      'admin:settings',
      'admin:users',
      'admin:bulk',
      `admin:user:balance:${buyer1._id}`,
      `admin:user:setrole:${buyer1._id}:admin`,
      'adm_sup:chat_off',
      'adm_sup:chat_id',
      'adm_sup:cfg:sla',
      'adm_sup:cfg:max',
      'adm_sup:cfg:auto',
      'adm_sup:cfg:tpl_add',
      'adm_sup:cfg:tpl_reset',
      'adm_sup:tpl_del:0',
    ]) {
      const deniedCtx = await dispatchAction(blockedCb, { user: moderator });
      const alertText = deniedCtx.alerts[0]?.text || deniedCtx.replies[0]?.text || '';
      check(alertText.includes('Нет доступа'), `Moderator strictly blocked on ${blockedCb}`);
    }

    // Even if moderator somehow has staffAdminAction='set_sla_minutes' in session, input handler blocks it
    const spoofedCtx = await dispatchEvent('text', {
      user: moderator,
      session: { staffAdminAction: 'set_sla_minutes' },
      message: { text: '5', message_id: ++nextMsgId },
    });
    check(
      spoofedCtx.replies.some((r) => r.text.includes('только администратору')) && stores.settings.supportSlaMinutes === 15,
      'handleSupportAdminInput blocks moderator from mutating SLA even with spoofed session'
    );

    // adminMainKeyboard has strictly 1 support button -> adm_sup:hub
    const admKb = adminMainKeyboard({ activeSupportTickets: 4 });
    const admFlat = admKb.reply_markup.inline_keyboard.flat();
    const supBtns = admFlat.filter((b) => String(b.callback_data || '').startsWith('adm_sup:'));
    check(
      supBtns.length === 1 && supBtns[0].callback_data === 'adm_sup:hub' && supBtns[0].text.includes('Настройки саппортов'),
      'adminMainKeyboard contains STRICTLY 1 support hub button (adm_sup:hub)'
    );
    inspectMarkupCallbacks(moderatorMainKeyboard({ activeSupportTickets: 2 }), 'moderatorMainKeyboard');
  }

  // ── 4. Superadmin Search Fix in input.routes.js ───────────────────────────
  console.log('\n4. Checking Superadmin Product Search & Admin Input Fixes (input.routes.js):');
  {
    const prod = {
      _id: new mongoose.Types.ObjectId(),
      name: 'ChatGPT Plus Pro',
      price: 19.99,
      type: 'manual',
      provider: 'local',
      manualStock: 5,
      isActive: true,
      sortOrder: 1,
      createdAt: new Date(),
    };
    stores.products.push(prod);

    // 4a. Superadmin with session.adminAction = 'product_search'
    const saSearchCtx = await dispatchEvent('text', {
      user: superadmin,
      session: { adminAction: 'product_search' },
      message: { text: 'ChatGPT', message_id: ++nextMsgId },
    });
    const searchReply = saSearchCtx.replies[0]?.text || saSearchCtx.edits[0]?.text || '';
    check(
      saSearchCtx._handled === true &&
      saSearchCtx.session.adminAction === null &&
      searchReply.includes('ChatGPT Plus Pro') &&
      searchReply.includes('Поиск:'),
      'Superadmin product_search in input.routes.js reaches productsScene.showProductsList and renders results'
    );

    // 4b. Regular user with spoofed session.adminAction = 'product_search' must NOT execute search
    const userSearchCtx = await dispatchEvent('text', {
      user: buyer1,
      session: { adminAction: 'product_search' },
      message: { text: 'ChatGPT', message_id: ++nextMsgId },
    });
    check(
      userSearchCtx._handled === false && userSearchCtx.replies.length === 0,
      'Non-admin user with spoofed product_search is ignored by input.routes.js'
    );

    // 4c. Superadmin global search ('search_global') also works
    const saGlobalCtx = await dispatchEvent('text', {
      user: superadmin,
      session: { adminAction: 'search_global' },
      message: { text: `@${buyer1.username}`, message_id: ++nextMsgId },
    });
    const globalOut = saGlobalCtx.replies[0]?.text || saGlobalCtx.edits[0]?.text || '';
    check(
      saGlobalCtx._handled === true && globalOut.includes(String(buyer1.telegramId)),
      'Superadmin search_global in input.routes.js reaches usersScene.handleGlobalSearch'
    );

    // 4d. Superadmin promo_create_code also works
    const saPromoCtx = await dispatchEvent('text', {
      user: superadmin,
      session: { userAction: 'promo_create_code', newPromo: {} },
      message: { text: 'SUPER2026', message_id: ++nextMsgId },
    });
    check(
      saPromoCtx._handled === true && saPromoCtx.session.newPromo.code === 'SUPER2026',
      'Superadmin promo_create_code in input.routes.js is permitted via isAdminOrAbove'
    );
  }

  // ── 5. Anti-spam Limit & Atomic Concurrent claimTicket ────────────────────
  console.log('\n5. Checking Anti-spam Limit (supportMaxOpenPerUser) & Atomic claimTicket:');
  let mainTicket = null;
  {
    const ord = {
      _id: new mongoose.Types.ObjectId(),
      userId: buyer1._id,
      telegramId: buyer1.telegramId,
      productId: stores.products[0]._id,
      price: 19.99,
      qty: 1,
      status: 'completed',
      warrantyDays: 7,
      createdAt: new Date(),
    };
    stores.orders.push(ord);

    const t1 = await supportService.createTicket({
      user: buyer1,
      topic: 'order',
      orderId: ord._id,
      text: 'Issue 1 <script>alert(1)</script>',
    });
    mainTicket = t1.ticket;
    await supportService.createTicket({ user: buyer1, topic: 'payment', text: 'Issue 2' });
    await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Issue 3' });

    let limitErr = null;
    try {
      await supportService.createTicket({ user: buyer1, topic: 'product', text: 'Issue 4 blocked' });
    } catch (err) {
      limitErr = err;
    }
    check(limitErr && limitErr.code === 'TOO_MANY_OPEN_TICKETS', '4th open ticket blocked with TOO_MANY_OPEN_TICKETS when supportMaxOpenPerUser=3');

    // UI startNewTicket also reports limit reached
    const uiLimitCtx = await dispatchAction('sup:new', { user: buyer1 });
    const uiLimitTxt = uiLimitCtx.edits[0]?.text || uiLimitCtx.replies[0]?.text || '';
    check(uiLimitTxt.includes('Достигнут лимит'), 'buyerSupportScene.startNewTicket blocks UI flow at limit');

    // Closing 1 ticket (not mainTicket) frees a slot so a new ticket succeeds
    const slotTicket = stores.tickets.find((t) => String(t._id) !== String(mainTicket._id) && t.status === 'open');
    const closedSlot = await supportService.closeTicket({
      ticketId: slotTicket._id,
      actorUser: buyer1,
      reason: 'user_closed',
    });
    check(closedSlot.ok === true, 'Buyer closing 1 open ticket succeeds');
    const freedTicket = await supportService.createTicket({ user: buyer1, topic: 'product', text: 'Issue 4 after close' });
    check(Boolean(freedTicket.ticket?._id), 'Creating ticket succeeds once active count drops below supportMaxOpenPerUser');

    // Close remaining non-main open tickets of buyer1 so section 6 starts clean
    for (const tk of stores.tickets) {
      if (String(tk._id) !== String(mainTicket._id) && tk.status !== 'closed') {
        await supportService.closeTicket({ ticketId: tk._id, actorUser: buyer1, reason: 'user_closed' });
      }
    }

    // Concurrent claimTicket race condition: two different supports claim same ticket simultaneously
    const [race1, race2] = await Promise.all([
      supportService.claimTicket({ ticketId: mainTicket._id, staffUser: support1 }),
      supportService.claimTicket({ ticketId: mainTicket._id, staffUser: support2 }),
    ]);
    const okCount = [race1, race2].filter((r) => r.ok === true).length;
    const failCount = [race1, race2].filter((r) => r.ok === false && r.reason === 'ALREADY_TAKEN').length;
    check(okCount === 1 && failCount === 1, 'Concurrent claimTicket race: strictly 1 wins (ok:true), 1 loses (ok:false, ALREADY_TAKEN)');

    // Make sure support1 holds mainTicket for subsequent stats/escalation checks (deterministic)
    if (!race1.ok) {
      await SupportTicket.updateOne(
        { _id: mainTicket._id },
        { $set: { assignedTo: support1._id, assignedTelegramId: support1.telegramId } }
      );
    }
  }

  // ── 6. Reply, Escalation, Closing, Rating 1..5, Stats & SLA Cron ──────────
  console.log('\n6. Checking Staff Reply, Escalation, Close, Rating 1..5, SLA Stats & Cron:');
  {
    // Buyer reply
    const buyerRep = await supportService.addReply({
      ticketId: mainTicket._id,
      senderUser: buyer1,
      text: 'Доп. скрин по заказу',
      mediaType: 'photo',
      mediaFileId: 'file_photo_1',
    });
    check(buyerRep.ok && buyerRep.message.mediaType === 'photo', 'Buyer reply with photo media saved');

    // Staff reply sets firstResponseAt/By and supportLastActiveAt
    const staffRep = await supportService.addReply({
      ticketId: mainTicket._id,
      senderUser: support1,
      text: 'Проверяю ваш заказ!',
    });
    check(
      staffRep.ok &&
      staffRep.ticket.firstResponseAt instanceof Date &&
      String(staffRep.ticket.firstResponseBy) === String(support1._id) &&
      support1.supportLastActiveAt instanceof Date,
      'Staff addReply sets firstResponseAt, firstResponseBy & User.supportLastActiveAt'
    );

    // Escalation clears assignedTo & sets priority=high
    const escRes = await supportService.escalateTicket({
      ticketId: mainTicket._id,
      staffUser: support1,
      reason: 'Нужен возврат средств',
    });
    check(
      escRes.ok &&
      escRes.ticket.status === 'escalated' &&
      escRes.ticket.priority === 'high' &&
      escRes.ticket.assignedTo === null &&
      escRes.ticket.assignedTelegramId === null,
      'escalateTicket sets status=escalated, priority=high, clears assignedTo and logs system message'
    );

    // Moderator claims escalated ticket
    const modClaim = await supportService.claimTicket({ ticketId: mainTicket._id, staffUser: moderator });
    check(modClaim.ok && modClaim.ticket.status === 'in_progress' && String(modClaim.ticket.assignedTo) === String(moderator._id), 'Moderator claims escalated ticket');

    // Cannot rate before close
    const earlyRate = await supportService.rateTicket({ ticketId: mainTicket._id, userId: buyer1._id, rating: 5 });
    check(earlyRate.ok === false && earlyRate.reason === 'NOT_CLOSED', 'rateTicket rejects rating on non-closed ticket');

    // Close ticket
    const closeRes = await supportService.closeTicket({ ticketId: mainTicket._id, actorUser: moderator, reason: 'resolved' });
    check(closeRes.ok && closeRes.ticket.status === 'closed' && closeRes.ticket.closeReason === 'resolved', 'closeTicket sets status=closed & closeReason=resolved');

    // Rate validation: invalid 0/6, wrong user, valid 1..5
    const invalidRate = await supportService.rateTicket({ ticketId: mainTicket._id, userId: buyer1._id, rating: 6 });
    const otherUserRate = await supportService.rateTicket({ ticketId: mainTicket._id, userId: buyer2._id, rating: 5 });
    const validRate = await supportService.rateTicket({ ticketId: mainTicket._id, userId: buyer1._id, rating: 5 });
    check(invalidRate.ok === false && invalidRate.reason === 'INVALID_RATING', 'rateTicket rejects out-of-range rating 6');
    check(otherUserRate.ok === false && otherUserRate.reason === 'FORBIDDEN', 'rateTicket blocks non-owner rating');
    check(validRate.ok === true && validRate.ticket.rating === 5 && validRate.ticket.ratedAt instanceof Date, 'rateTicket saves valid rating 5 for owner');

    // Staff activity stats
    const sup1Stats = await supportService.getStaffActivityStats(support1._id, '30d');
    const modStats = await supportService.getStaffActivityStats(moderator._id, '30d');
    check(
      sup1Stats.repliesCount >= 1 && sup1Stats.escalatedFromCount === 1 && sup1Stats.avgFirstResponseSec !== null,
      'getStaffActivityStats accurately tracks replies, escalations & avgFirstResponseSec'
    );
    check(
      modStats.takenCount === 1 && modStats.closedCount === 1 && modStats.avgRating === 5 && modStats.ratedCount === 1,
      'getStaffActivityStats accurately tracks takenCount, closedCount, avgRating & ratedCount'
    );

    // SLA Cron check: overdue reminder + auto_timeout close
    const overdueTicket = (await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Overdue check' })).ticket;
    overdueTicket.createdAt = new Date(Date.now() - 25 * 60 * 1000); // 25m > 15m SLA
    overdueTicket.lastMessageAt = new Date(Date.now() - 10 * 60 * 1000);

    const staleTicket = (await supportService.createTicket({ user: buyer1, topic: 'payment', text: 'Stale check' })).ticket;
    staleTicket.createdAt = new Date(Date.now() - 60 * 60 * 60 * 1000);
    staleTicket.lastMessageAt = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50h > 48h

    sentBotCalls.length = 0;
    await supportSlaCron.runSupportSlaCheck();
    const updatedOverdue = await SupportTicket.findById(overdueTicket._id).lean();
    const updatedStale = await SupportTicket.findById(staleTicket._id).lean();
    check(updatedOverdue.reminderCount === 1 && updatedOverdue.lastReminderAt instanceof Date, 'SLA cron sends reminder and increments reminderCount for overdue open ticket');
    check(updatedStale.status === 'closed' && updatedStale.closeReason === 'auto_timeout', 'SLA cron auto-closes stale ticket with closeReason=auto_timeout');

    // Cleanup test open tickets so buyer1 isn't stuck
    for (const tk of stores.tickets) {
      if (tk.status !== 'closed') tk.status = 'closed';
    }
  }

  // ── 7. Group Chat Mode vs DM On-Duty + Group Callback Security + ToS ──────
  console.log('\n7. Checking Group Mode vs DM On-Duty, Group Callback Security & ToS Group Safety:');
  {
    const newTkRes = await supportService.createTicket({ user: buyer1, topic: 'product', text: 'Need help with <b>key</b>' });
    const groupTicket = newTkRes.ticket;

    // 7a. Mode 1: DM to on-duty staff (supportChatId = null)
    stores.settings.supportChatId = null;
    stores.settings.supportChatTitle = '';
    settingsCache.invalidateCache(stores.settings);
    sentBotCalls.length = 0;
    const dmRes = await supportNotify.notifyNewTicket(groupTicket, buyer1, newTkRes.message);
    const dmRecipients = sentBotCalls.filter((c) => c.method === 'sendMessage').map((c) => Number(c.chatId));
    check(
      dmRes.mode === 'dm' &&
      dmRecipients.includes(support1.telegramId) &&
      dmRecipients.includes(moderator.telegramId) &&
      !dmRecipients.includes(support2.telegramId),
      'DM mode sends new ticket ONLY to supportOnDuty=true staff (excludes off-duty support2)'
    );
    check(
      sentBotCalls.some((c) => c.text.includes('&lt;b&gt;key&lt;/b&gt;')),
      'supportNotify escapes HTML in user message text'
    );

    // 7b. Mode 2: Group Chat mode (supportChatId set)
    const GROUP_ID = -100555666777;
    stores.settings.supportChatId = GROUP_ID;
    stores.settings.supportChatTitle = 'Support Team Chat';
    settingsCache.invalidateCache(stores.settings);
    const grpTkRes = await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Group ticket test' });
    const grpTicket = grpTkRes.ticket;

    sentBotCalls.length = 0;
    const grpRes = await supportNotify.notifyNewTicket(grpTicket, buyer1, grpTkRes.message);
    const updatedGrpTk = await SupportTicket.findById(grpTicket._id).lean();
    check(
      grpRes.mode === 'group' &&
      Number(grpRes.chatId) === GROUP_ID &&
      Number(updatedGrpTk.groupChatId) === GROUP_ID &&
      Boolean(updatedGrpTk.groupMessageId),
      'Group mode sends card to supportChatId and persists groupChatId/groupMessageId'
    );

    // 7c. Group callback security: foreign group rejected
    const foreignCtx = await dispatchAction(`sp:take:${grpTicket._id}`, {
      user: support1,
      chat: { id: -100999888777, type: 'supergroup' },
    });
    const afterForeign = await SupportTicket.findById(grpTicket._id).lean();
    check(
      foreignCtx.alerts.some((a) => a.text.includes('Нет прав')) && afterForeign.assignedTo === null,
      'Group callback sp:take from FOREIGN chat.id is strictly rejected'
    );

    // 7d. Group callback security: non-staff user in supportChatId rejected
    const nonStaffGrpCtx = await dispatchAction(`sp:take:${grpTicket._id}`, {
      user: buyer1,
      chat: { id: GROUP_ID, type: 'supergroup' },
    });
    const afterNonStaff = await SupportTicket.findById(grpTicket._id).lean();
    check(
      nonStaffGrpCtx.alerts.some((a) => a.text.includes('Нет доступа')) && afterNonStaff.assignedTo === null,
      'Group callback sp:take by regular user inside supportChatId is strictly rejected'
    );

    // 7e. Group callback security: valid support in supportChatId succeeds
    const validGrpCtx = await dispatchAction(`sp:take:${grpTicket._id}`, {
      user: support1,
      chat: { id: GROUP_ID, type: 'supergroup' },
    });
    const afterValidGrp = await SupportTicket.findById(grpTicket._id).lean();
    check(
      String(afterValidGrp.assignedTo) === String(support1._id) &&
      validGrpCtx.alerts.some((a) => a.text.includes('взяли тикет')),
      'Group callback sp:take by support inside supportChatId claims ticket atomically'
    );

    // 7f. /set_support_chat command in group & disable chat back to DM mode via admin
    stores.settings.supportChatId = null;
    stores.settings.supportChatTitle = '';
    const setChatCmdCtx = await dispatchCommand('set_support_chat', {
      user: admin,
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Support HQ' },
    });
    check(
      Number(stores.settings.supportChatId) === GROUP_ID &&
      stores.settings.supportChatTitle === 'Support HQ' &&
      setChatCmdCtx.replies.some((r) => r.text.includes('Чат саппортов подключён')),
      '/set_support_chat command in group saves supportChatId and supportChatTitle'
    );

    const modSetChatDenied = await dispatchCommand('set_support_chat', {
      user: moderator,
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Support HQ' },
    });
    check(
      modSetChatDenied.replies.length === 0,
      '/set_support_chat command denies moderator without spamming group chat'
    );

    const offCtx = await dispatchAction('adm_sup:chat_off', { user: admin });
    check(
      stores.settings.supportChatId === null && offCtx.alerts.some((a) => a.text.includes('режим ЛС')),
      'Admin can disable supportChatId (adm_sup:chat_off) and switch back to DM mode'
    );

    // 7g. input.routes.js end-to-end text & photo flows for buyer, staff & moderator
    const buyerInputSession = {
      supportAction: 'buyer_new_text',
      supportTopic: 'product',
      supportOrderId: null,
    };
    const buyerPhotoCtx = await dispatchEvent('photo', {
      user: buyer1,
      session: buyerInputSession,
      message: {
        caption: 'Скрин проблемы',
        photo: [{ file_id: 'photo_small' }, { file_id: 'photo_large' }],
        message_id: ++nextMsgId,
      },
    });
    check(
      buyerPhotoCtx._handled === true &&
      buyerInputSession.supportAction === null &&
      buyerPhotoCtx.replies.some((r) => r.text.includes('создано')),
      'input.routes.js routes buyer photo+caption (buyer_new_text) to createTicket'
    );
    const createdByInput = stores.tickets[stores.tickets.length - 1];

    const staffInputSession = {
      supportAction: 'staff_reply_text',
      activeTicketId: String(createdByInput._id),
    };
    const staffReplyCtx = await dispatchEvent('text', {
      user: support1,
      session: staffInputSession,
      message: { text: 'Ответ саппорта через input.routes', message_id: ++nextMsgId },
    });
    check(
      staffReplyCtx._handled === true &&
      staffInputSession.supportAction === null &&
      staffReplyCtx.replies.some((r) => r.text.includes('Ответ отправлен клиенту')),
      'input.routes.js routes staff_reply_text to supportPanelScene.handleStaffTextInput'
    );

    const modFindSession = { staffAdminAction: 'mod_find_user_order' };
    const modFindCtx = await dispatchEvent('text', {
      user: moderator,
      session: modFindSession,
      message: { text: createdByInput.ticketNumber, message_id: ++nextMsgId },
    });
    check(
      modFindCtx._handled === true &&
      modFindSession.staffAdminAction === null &&
      modFindCtx.replies.some((r) => r.text.includes(createdByInput.ticketNumber)),
      'input.routes.js routes mod_find_user_order by ticketNumber to showTicketForStaff'
    );
    await supportService.closeTicket({ ticketId: createdByInput._id, actorUser: support1, reason: 'resolved' });

    // 7g. tosMiddleware MUST NOT send tos_required in group chats
    let tosGroupNext = false;
    let tosGroupReplies = 0;
    await tosMiddleware(
      {
        user: buyer2, // acceptedToS: false
        chat: { id: GROUP_ID, type: 'supergroup' },
        message: { text: 'Hello in group' },
        t: (k) => k,
        reply: async () => { tosGroupReplies += 1; },
        answerCbQuery: async () => { tosGroupReplies += 1; },
      },
      async () => { tosGroupNext = true; }
    );
    check(tosGroupNext === true && tosGroupReplies === 0, 'tosMiddleware passes group chat messages without sending tos_required');

    // In private chat, tosMiddleware STILL blocks unaccepted ToS
    let tosPrivNext = false;
    let tosPrivReplyText = '';
    await tosMiddleware(
      {
        user: buyer2,
        chat: { id: buyer2.telegramId, type: 'private' },
        message: { text: 'Hello in DM' },
        t: (k) => k,
        reply: async (txt) => { tosPrivReplyText = txt; },
      },
      async () => { tosPrivNext = true; }
    );
    check(tosPrivNext === false && tosPrivReplyText === 'tos_required', 'tosMiddleware still blocks unaccepted user in private DM');
  }

  // ── 8. End-to-End UI Screens & 64-byte callback_data Check ────────────────
  console.log('\n8. Checking All New Keyboards & Strictly <= 64-byte callback_data:');
  {
    const sampleId = new mongoose.Types.ObjectId();

    // mainKeyboard & buildMainMenuRichHtml for all roles
    const tStub = (k) => k;
    for (const role of ['user', 'support', 'moderator', 'admin', 'superadmin']) {
      const kb = mainKeyboard(tStub, { isSeller: true, role });
      inspectMarkupCallbacks(kb, `mainKeyboard(${role})`);
      const rich = buildMainMenuRichHtml({ text: 'Welcome', t: tStub, isSeller: true, role });
      check(
        (['support', 'moderator', 'admin', 'superadmin'].includes(role) ? rich.includes('sp:home') : !rich.includes('sp:home')),
        `mainKeyboard & rich HTML correctly renders sp:home visibility for role=${role}`
      );
      check(
        (role === 'moderator' ? rich.includes('adm_sup:hub') : !rich.includes('adm_sup:hub')),
        `mainKeyboard & rich HTML correctly renders adm_sup:hub visibility for role=${role}`
      );
    }

    // Trigger buyer & staff & admin/mod screens to capture all generated callback_data
    const tk = (await supportService.createTicket({ user: buyer1, topic: 'order', text: 'UI inspect ticket' })).ticket;
    for (let i = 0; i < 10; i++) {
      await supportService.addReply({ ticketId: tk._id, senderUser: buyer1, text: `Msg ${i}` });
    }

    await dispatchAction('menu:support', { user: buyer1 });
    await dispatchAction('sup:new', { user: buyer1 });
    await dispatchAction('sup:top:order', { user: buyer1 });
    await dispatchAction('sup:my:1', { user: buyer1 });
    await dispatchAction(`sup:v:${tk._id}`, { user: buyer1 });
    await dispatchAction(`sup:re:${tk._id}`, { user: buyer1 });
    await dispatchAction(`sup:cl:${tk._id}`, { user: buyer1 });
    await dispatchAction(`sup:rt:${tk._id}:5`, { user: buyer1 });

    // Staff & Admin Hub screens
    const tk2 = (await supportService.createTicket({ user: buyer1, topic: 'payment', text: 'Staff inspect' })).ticket;
    await dispatchCommand('support', { user: support1 });
    await dispatchAction('sp:home', { user: support1 });
    await dispatchAction('sp:duty', { user: support1 });
    await dispatchAction('sp:duty', { user: support1 }); // restore onDuty=true
    await dispatchAction('sp:q:waiting:1', { user: support1 });
    await dispatchAction(`sp:v:${tk2._id}`, { user: support1 });
    await dispatchAction(`sp:take:${tk2._id}`, { user: support1 });
    await dispatchAction(`sp:rep:${tk2._id}`, { user: support1 });
    await dispatchAction(`sp:tpl:${tk2._id}:0`, { user: support1 });
    await dispatchAction(`sp:esc:${tk2._id}`, { user: support1 });
    await dispatchAction(`sp:hist:${tk._id}:1`, { user: moderator });

    await dispatchAction('adm_sup:hub', { user: superadmin });
    await dispatchAction('adm_sup:q:esc:1', { user: superadmin });
    await dispatchAction('adm_sup:team:1', { user: superadmin });
    await dispatchAction(`adm_sup:st:${support1._id}:30d`, { user: superadmin });
    await dispatchAction('adm_sup:log:1', { user: superadmin });
    await dispatchAction('adm_sup:chat', { user: superadmin });
    await dispatchAction('adm_sup:cfg', { user: superadmin });
    await dispatchAction('adm_sup:find', { user: moderator });

    // usersScene profile keyboard for superadmin viewing support
    const profCtx = createCtx({ user: superadmin, callbackData: `admin:user:view:${support1._id}` });
    await usersScene.showUserProfile(profCtx, String(support1._id));

    // supportNotify closed card
    await supportNotify.notifyTicketClosedToBuyer({ ...tk, closeReason: 'resolved', ticketNumber: tk.ticketNumber });

    // Also validate synthetic worst-case IDs
    const maxId = String(sampleId);
    const worstCaseCallbacks = [
      `sup:top:payment`,
      `sup:ord:${maxId}`,
      `sup:rt:${maxId}:5`,
      `sp:q:escalated:999`,
      `sp:take:${maxId}`,
      `sp:tpl:${maxId}:99`,
      `sp:hist:${maxId}:999`,
      `adm_sup:q:waiting:999`,
      `adm_sup:st:${maxId}:today`,
      `adm_sup:role:${maxId}:m`,
      `admin:user:setrole:${maxId}:moderator`,
    ];
    for (const cb of worstCaseCallbacks) {
      capturedCallbacks.push({ source: 'worst-case', text: cb, data: cb, bytes: Buffer.byteLength(cb, 'utf8') });
    }

    const oversized = capturedCallbacks.filter((c) => c.bytes > 64);
    if (oversized.length > 0) {
      console.error('  Oversized callback_data detected:', oversized);
    }
    check(
      capturedCallbacks.length >= 40 && oversized.length === 0,
      `All ${capturedCallbacks.length} inspected callback_data payloads are strictly <= 64 bytes (max=${Math.max(...capturedCallbacks.map((c) => c.bytes))} bytes)`
    );
  }

  // ── 9. Critic Audit Regressions (#68 / #69: 10 Integration Fixes) ──────────
  console.log('\n9. Checking Critic Audit Regressions (#68/#69 - all 10 integration fixes):');
  {
    for (const tk of stores.tickets) {
      if (tk.status !== 'closed') tk.status = 'closed';
    }

    const hasBalancedBasicHtml = (html) => {
      const openB = (html.match(/<b>/g) || []).length;
      const closeB = (html.match(/<\/b>/g) || []).length;
      const openI = (html.match(/<i>/g) || []).length;
      const closeI = (html.match(/<\/i>/g) || []).length;
      const openBq = (html.match(/<blockquote>/g) || []).length;
      const closeBq = (html.match(/<\/blockquote>/g) || []).length;
      return openB === closeB && openI === closeI && openBq === closeBq && !/&\w*$/.test(html);
    };

    // 9.1 categoriesScene & productsScene MUST NOT delete messages for unrelated adminAction & must not crash on photo
    deletedMessages.length = 0;
    const unrelatedCtx = createCtx({
      user: superadmin,
      session: { adminAction: 'staff_reply_text' },
      message: { text: 'Ответ админа клиенту', message_id: 9001 },
    });
    const catHandled = await categoriesScene.handleCategoryInput(unrelatedCtx);
    const prodHandled = await productsScene.handleProductInput(unrelatedCtx);
    check(catHandled === false && prodHandled === false && deletedMessages.length === 0, 'categoriesScene & productsScene ignore unrelated adminAction without calling deleteMessage');

    // Sending photo when adminAction='add_category' or 'product_search' or 'bulk_give_balance' must NOT throw TypeError
    const photoCatCtx = createCtx({
      user: superadmin,
      session: { adminAction: 'add_category' },
      message: { photo: [{ file_id: 'ph1' }], message_id: 9002 },
    });
    const photoProdCtx = createCtx({
      user: superadmin,
      session: { adminAction: 'product_search' },
      message: { photo: [{ file_id: 'ph2' }], message_id: 9003 },
    });
    deletedMessages.length = 0;
    const photoCatRes = await categoriesScene.handleCategoryInput(photoCatCtx);
    const photoProdRes = await productsScene.handleProductInput(photoProdCtx);
    const photoBulkCtx = await dispatchEvent('photo', {
      user: superadmin,
      session: { adminAction: 'bulk_give_balance' },
      message: { photo: [{ file_id: 'ph3' }], message_id: 9004 },
    });
    const photoGlobalCtx = await dispatchEvent('photo', {
      user: superadmin,
      session: { adminAction: 'search_global' },
      message: { photo: [{ file_id: 'ph4' }], message_id: 9005 },
    });
    check(
      photoCatRes === true && photoProdRes === true && deletedMessages.length === 0 &&
      photoBulkCtx.replies.some((r) => r.text.includes('сумму')) && photoGlobalCtx._handled === false,
      'Photo message during text-only adminAction never throws TypeError and never triggers unintended deleteMessage'
    );

    // 9.2 !replyRes.ok / !escRes.ok guards when ticket is already closed
    const raceClosedTicket = (await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Race close test' })).ticket;
    await supportService.claimTicket({ ticketId: raceClosedTicket._id, staffUser: support1 });
    await supportService.closeTicket({ ticketId: raceClosedTicket._id, actorUser: moderator, reason: 'resolved' });

    sentBotCalls.length = 0;
    const closedTplCtx = await dispatchAction(`sp:tpl:${raceClosedTicket._id}:0`, { user: support1 });
    const closedStaffReplyCtx = await dispatchEvent('text', {
      user: support1,
      session: { supportAction: 'staff_reply_text', activeTicketId: String(raceClosedTicket._id) },
      message: { text: 'Late staff reply', message_id: ++nextMsgId },
    });
    const closedStaffEscCtx = await dispatchEvent('text', {
      user: support1,
      session: { supportAction: 'staff_escalate_reason', activeTicketId: String(raceClosedTicket._id) },
      message: { text: 'Late escalate', message_id: ++nextMsgId },
    });
    const closedBuyerReplyCtx = await dispatchEvent('text', {
      user: buyer1,
      session: { supportAction: 'buyer_reply_text', activeTicketId: String(raceClosedTicket._id) },
      message: { text: 'Late buyer reply', message_id: ++nextMsgId },
    });
    check(
      sentBotCalls.filter((c) => c.method === 'sendMessage').length === 0 &&
      closedTplCtx.alerts.some((a) => a.text.includes('закрыт')) &&
      closedStaffReplyCtx.replies.some((r) => r.text.includes('закрыт')) &&
      closedStaffEscCtx.replies.some((r) => r.text.includes('Не удалось')) &&
      closedBuyerReplyCtx.replies.some((r) => r.text.includes('закрыто')),
      'Closed-ticket race (!replyRes.ok / !escRes.ok) sends ZERO false notifications in all scenes'
    );

    // 9.3 handleGroupReply owner protection & closed ticket safety
    const GRP_CHAT_ID = -100333444555;
    stores.settings.supportChatId = GRP_CHAT_ID;
    settingsCache.invalidateCache(stores.settings);

    const grpOwnTk = (await supportService.createTicket({ user: buyer1, topic: 'order', text: 'Group owner test' })).ticket;
    await SupportTicket.updateOne({ _id: grpOwnTk._id }, { $set: { groupChatId: GRP_CHAT_ID, groupMessageId: 8801 } });
    await supportService.claimTicket({ ticketId: grpOwnTk._id, staffUser: support1 });

    // support2 tries replying to ticket owned by support1 -> blocked with group warning, buyer NOT notified
    sentBotCalls.length = 0;
    const msgCountBeforeSteal = stores.messages.length;
    const stolenGrpReplyCtx = await dispatchEvent('text', {
      user: support2,
      chat: { id: GRP_CHAT_ID, type: 'supergroup' },
      message: {
        text: 'Unauthorized reply',
        message_id: ++nextMsgId,
        reply_to_message: { message_id: 8801, from: { id: bot.botInfo.id, is_bot: true }, text: `#${grpOwnTk.ticketNumber}` },
      },
    });
    check(
      stolenGrpReplyCtx._handled === true &&
      stores.messages.length === msgCountBeforeSteal &&
      sentBotCalls.filter((c) => Number(c.chatId) === buyer1.telegramId).length === 0 &&
      stolenGrpReplyCtx.replies.some((r) => r.text.includes('другого сотрудника')),
      'handleGroupReply blocks another support from replying to someone else’s claimed ticket'
    );

    // moderator IS allowed to reply via handleGroupReply
    const modGrpReplyCtx = await dispatchEvent('text', {
      user: moderator,
      chat: { id: GRP_CHAT_ID, type: 'supergroup' },
      message: {
        text: 'Moderator group reply',
        message_id: ++nextMsgId,
        reply_to_message: { message_id: 8801, from: { id: bot.botInfo.id, is_bot: true }, text: `#${grpOwnTk.ticketNumber}` },
      },
    });
    check(
      modGrpReplyCtx._handled === true &&
      stores.messages.length === msgCountBeforeSteal + 1 &&
      sentBotCalls.some((c) => Number(c.chatId) === buyer1.telegramId && c.text.includes('Moderator group reply')),
      'handleGroupReply permits moderator to reply and notifies buyer'
    );

    // Closed ticket reply in group does not delete message or forward to buyer
    await supportService.closeTicket({ ticketId: grpOwnTk._id, actorUser: support1, reason: 'resolved' });
    deletedMessages.length = 0;
    sentBotCalls.length = 0;
    const closedGrpReplyCtx = await dispatchEvent('text', {
      user: admin,
      chat: { id: GRP_CHAT_ID, type: 'supergroup' },
      message: {
        text: 'Reply on closed ticket',
        message_id: ++nextMsgId,
        reply_to_message: { message_id: 8801, from: { id: bot.botInfo.id, is_bot: true }, text: `#${grpOwnTk.ticketNumber}` },
      },
    });
    check(
      closedGrpReplyCtx._handled === false &&
      deletedMessages.length === 0 &&
      sentBotCalls.filter((c) => Number(c.chatId) === buyer1.telegramId).length === 0,
      'Group reply on closed ticket returns false without deleting message or notifying buyer'
    );

    // 9.4 Deep link ?start=support (group card URL + bot.start routing + tos:accept redirect)
    const grpCardCalls = [];
    stores.settings.supportChatId = GRP_CHAT_ID;
    settingsCache.invalidateCache(stores.settings);
    const dlTkRes = await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Deep link check' });
    sentBotCalls.length = 0;
    await supportNotify.notifyNewTicket(dlTkRes.ticket, buyer1, dlTkRes.message);
    for (const c of sentBotCalls) grpCardCalls.push(c);
    const hasStartSupportUrl = grpCardCalls.some((c) =>
      (c.extra?.reply_markup?.inline_keyboard || []).flat().some((b) => String(b.url || '').includes('?start=support'))
    );
    check(hasStartSupportUrl, 'supportNotify group card deep link uses ?start=support');

    const staffStartCtx = await dispatchCommand('start', {
      user: support1,
      session: {},
      message: { text: '/start support', message_id: ++nextMsgId },
    });
    const staffStartOut = staffStartCtx.replies[0]?.text || staffStartCtx.edits[0]?.text || '';
    check(staffStartOut.includes('Панель поддержки'), '/start support opens supportPanelScene for staff');

    const buyerStartCtx = await dispatchCommand('start', {
      user: buyer1,
      session: {},
      message: { text: '/start support', message_id: ++nextMsgId },
    });
    const buyerStartKb = buyerStartCtx.replies[0]?.extra?.reply_markup || buyerStartCtx.edits[0]?.extra?.reply_markup;
    const buyerStartCbs = (buyerStartKb?.inline_keyboard || []).flat().map((b) => b.callback_data);
    check(buyerStartCbs.includes('sup:new') && buyerStartCbs.includes('sup:my:1'), '/start support opens buyer support menu for regular user');

    const unacceptedStaff = seedUser({
      telegramId: 900010,
      username: 'new_sup',
      role: 'support',
      acceptedToS: false,
      createdAt: new Date(Date.now() - 60000),
    });
    const pendingSession = {};
    await dispatchCommand('start', {
      user: unacceptedStaff,
      session: pendingSession,
      message: { text: '/start support', message_id: ++nextMsgId },
    });
    check(pendingSession.pendingSupportRedirect === true, '/start support stores pendingSupportRedirect before ToS acceptance');
    const afterTosCtx = await dispatchAction('tos:accept', { user: unacceptedStaff, session: pendingSession });
    const afterTosText = afterTosCtx.edits[0]?.text || afterTosCtx.replies[0]?.text || '';
    check(afterTosText.includes('Панель поддержки') && !pendingSession.pendingSupportRedirect, 'tos:accept honors pendingSupportRedirect for staff');
    await supportService.closeTicket({ ticketId: dlTkRes.ticket._id, actorUser: support1, reason: 'resolved' });

    // 9.5 Safe HTML rendering of huge messages (>4096 chars with < > &) without broken tags/entities
    const longTk = (await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Long <script> & "test"' })).ticket;
    const chunk = '<b>Alert & Check</b> <script>bad</script> "quote" '.repeat(35); // ~1680 chars each
    for (let i = 0; i < 8; i++) {
      await supportService.addReply({ ticketId: longTk._id, senderUser: i % 2 === 0 ? buyer1 : support1, text: `M${i}: ${chunk}` });
    }
    const staffCardPayload = await supportPanelScene.buildTicketCardPayload(longTk._id, support1);
    const staffHistCtx = await dispatchAction(`sp:hist:${longTk._id}:1`, { user: support1 });
    const staffHistHtml = staffHistCtx.edits[0]?.text || staffHistCtx.replies[0]?.text || '';
    const buyerDetCtx = await dispatchAction(`sup:v:${longTk._id}`, { user: buyer1 });
    const buyerDetHtml = buyerDetCtx.edits[0]?.text || buyerDetCtx.replies[0]?.text || '';

    sentBotCalls.length = 0;
    await supportNotify.notifyBuyerStaffReply(longTk, support1, { text: 'X<&>'.repeat(900) });
    const notifyBuyerHtml = sentBotCalls[sentBotCalls.length - 1]?.text || '';

    check(
      staffCardPayload.text.length <= 4096 && hasBalancedBasicHtml(staffCardPayload.text) &&
      staffHistHtml.length <= 4096 && hasBalancedBasicHtml(staffHistHtml) &&
      buyerDetHtml.length <= 4096 && hasBalancedBasicHtml(buyerDetHtml) &&
      notifyBuyerHtml.length <= 4096 && hasBalancedBasicHtml(notifyBuyerHtml),
      'Long tickets & notifications stay <= 4096 chars with balanced HTML tags and intact entities'
    );
    await supportService.closeTicket({ ticketId: longTk._id, actorUser: support1, reason: 'resolved' });

    // 9.6 Session clearing of topup / step / userAction in sessionClear & support scene entries
    const sc2 = sessionClearMiddleware();
    const scCtx = {
      callbackQuery: { data: 'sp:home' },
      session: {
        topup: { method: 'card', step: 'proof' },
        step: 'waiting_channel',
        userAction: 'enter_promo',
        customerSearchMsgId: 77,
        supportAction: 'buyer_new_text',
      },
    };
    await sc2(scCtx, async () => {});
    check(
      scCtx.session.topup === null && scCtx.session.step === null && scCtx.session.userAction === null && scCtx.session.customerSearchMsgId === null,
      'sessionClear resets topup, step, userAction & customerSearchMsgId'
    );
    const staleEntryCtx = await dispatchAction('sup:new', {
      user: buyer1,
      session: { userAction: 'enter_promo', topup: { step: 'proof' }, adminAction: 'product_search' },
    });
    check(
      staleEntryCtx.session.userAction === null && staleEntryCtx.session.topup === null && staleEntryCtx.session.adminAction === null,
      'buyerSupportScene.startNewTicket clears stale topup/userAction/adminAction'
    );

    // 9.7 chatId < 0 + getChat validation + migrate_to_chat_id handling
    stores.settings.supportChatId = null;
    settingsCache.invalidateCache(stores.settings);
    const posChatCtx = await dispatchEvent('text', {
      user: admin,
      session: { staffAdminAction: 'set_support_chat_id' },
      message: { text: '123456', message_id: ++nextMsgId },
    });
    check(
      stores.settings.supportChatId === null && posChatCtx.replies.some((r) => r.text.includes('отрицательный')),
      'set_support_chat_id rejects positive chat IDs'
    );

    getChatHook = async () => { throw new Error('chat not found'); };
    const failGetChatCtx = await dispatchEvent('text', {
      user: admin,
      session: { staffAdminAction: 'set_support_chat_id' },
      message: { text: '-100777888', message_id: ++nextMsgId },
    });
    check(
      stores.settings.supportChatId === null && failGetChatCtx.replies.some((r) => r.text.includes('Не удалось получить доступ')),
      'set_support_chat_id shows explicit error when getChat fails'
    );

    getChatHook = async (id) => ({ id, type: 'private', title: 'DM' });
    const privGetChatCtx = await dispatchEvent('text', {
      user: admin,
      session: { staffAdminAction: 'set_support_chat_id' },
      message: { text: '-100777888', message_id: ++nextMsgId },
    });
    check(
      stores.settings.supportChatId === null && privGetChatCtx.replies.some((r) => r.text.includes('не является группой')),
      'set_support_chat_id rejects non-group chat types'
    );

    getChatHook = async (id) => ({ id, type: 'supergroup', title: 'Valid Support Group' });
    const okGetChatCtx = await dispatchEvent('text', {
      user: admin,
      session: { staffAdminAction: 'set_support_chat_id' },
      message: { text: '-100777888', message_id: ++nextMsgId },
    });
    check(
      Number(stores.settings.supportChatId) === -100777888 &&
      stores.settings.supportChatTitle === 'Valid Support Group' &&
      okGetChatCtx.replies.some((r) => r.text.includes('Valid Support Group')),
      'set_support_chat_id accepts valid supergroup via getChat and saves title'
    );
    getChatHook = null;

    // migrate_to_chat_id retry in supportNotify
    const migTkRes = await supportService.createTicket({ user: buyer1, topic: 'general', text: 'Migration retry test' });
    let failOldGroupOnce = true;
    sendMessageHook = async (chatId) => {
      if (failOldGroupOnce && Number(chatId) === -100777888) {
        failOldGroupOnce = false;
        const err = new Error('Bad Request: group chat was upgraded to a supergroup chat');
        err.response = { parameters: { migrate_to_chat_id: -100999000111 } };
        throw err;
      }
    };
    sentBotCalls.length = 0;
    const migRes = await supportNotify.notifyNewTicket(migTkRes.ticket, buyer1, migTkRes.message);
    sendMessageHook = null;
    check(
      migRes.ok === true &&
      migRes.mode === 'group' &&
      Number(migRes.chatId) === -100999000111 &&
      Number(stores.settings.supportChatId) === -100999000111,
      'supportNotify handles Telegram migrate_to_chat_id, updates Settings.supportChatId and retries'
    );
    await supportService.closeTicket({ ticketId: migTkRes.ticket._id, actorUser: support1, reason: 'resolved' });
    stores.settings.supportChatId = null;
    settingsCache.invalidateCache(stores.settings);

    // 9.8 syncIndexes() in src/db/connect.js + migrate_to_chat_id in src/bot/index.js
    const connectSrc = fs.readFileSync(path.resolve(__dirname, '../src/db/connect.js'), 'utf8');
    check(
      connectSrc.includes('SupportTicket.syncIndexes()') &&
      connectSrc.includes('SupportMessage.syncIndexes()') &&
      connectSrc.includes('StaffAuditLog.syncIndexes()'),
      'src/db/connect.js calls syncIndexes() for SupportTicket, SupportMessage & StaffAuditLog'
    );
    const botIndexSrc = fs.readFileSync(path.resolve(__dirname, '../src/bot/index.js'), 'utf8');
    check(botIndexSrc.includes("bot.on('migrate_to_chat_id'"), 'src/bot/index.js registers migrate_to_chat_id handler');

    // 9.9 MAINTENANCE_MODE allows support/moderator and stays silent in group chats
    userMiddleware.clearUserCache();
    global.MAINTENANCE_MODE = true;
    try {
      let supMaintNext = false;
      let modMaintNext = false;
      let usrPrivNext = false;
      let usrPrivReplied = false;
      let usrGrpNext = false;
      let usrGrpReplied = false;

      await userMiddleware({ from: { id: support1.telegramId }, chat: { id: support1.telegramId, type: 'private' } }, async () => { supMaintNext = true; });
      await userMiddleware({ from: { id: moderator.telegramId }, chat: { id: moderator.telegramId, type: 'private' } }, async () => { modMaintNext = true; });
      await userMiddleware(
        { from: { id: buyer1.telegramId }, chat: { id: buyer1.telegramId, type: 'private' }, reply: async () => { usrPrivReplied = true; } },
        async () => { usrPrivNext = true; }
      );
      await userMiddleware(
        { from: { id: buyer1.telegramId }, chat: { id: GRP_CHAT_ID, type: 'supergroup' }, reply: async () => { usrGrpReplied = true; } },
        async () => { usrGrpNext = true; }
      );

      check(
        supMaintNext === true && modMaintNext === true &&
        usrPrivNext === false && usrPrivReplied === true &&
        usrGrpNext === false && usrGrpReplied === false,
        'MAINTENANCE_MODE permits support & moderator, blocks regular user in DM, and stays silent in group chats'
      );
    } finally {
      global.MAINTENANCE_MODE = false;
      userMiddleware.clearUserCache();
    }

    // 9.10 Regex-special search "C++ [Pro]" & safe adm_sup:find card for regular buyer vs staff
    stores.products.push({
      _id: new mongoose.Types.ObjectId(),
      name: 'C++ [Pro] (v2)',
      price: 9.5,
      type: 'manual',
      provider: 'local',
      manualStock: 3,
      isActive: true,
      sortOrder: 2,
      createdAt: new Date(),
    });
    const cppCtx = await dispatchEvent('text', {
      user: superadmin,
      session: { adminAction: 'product_search' },
      message: { text: 'C++ [Pro]', message_id: ++nextMsgId },
    });
    const cppText = cppCtx.replies[0]?.text || cppCtx.edits[0]?.text || '';
    check(cppText.includes('C++ [Pro] (v2)'), 'Product search safely escapes regex metacharacters like "C++ [Pro]"');

    const buyerOrd = stores.orders[0];
    const modFindOrderCtx = await dispatchEvent('text', {
      user: moderator,
      session: { staffAdminAction: 'mod_find_user_order' },
      message: { text: String(buyerOrd._id), message_id: ++nextMsgId },
    });
    const modOrderCbs = (modFindOrderCtx.replies[0]?.extra?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
    check(
      modOrderCbs.includes(`adm_sup:u:${buyer1._id}`) && !modOrderCbs.some((c) => String(c).startsWith('adm_sup:st:')),
      'adm_sup:find order card for regular buyer links to safe adm_sup:u:<id> (NOT staff stats adm_sup:st)'
    );
    const safeBuyerCardCtx = await dispatchAction(`adm_sup:u:${buyer1._id}`, { user: moderator });
    const safeBuyerText = safeBuyerCardCtx.edits[0]?.text || safeBuyerCardCtx.replies[0]?.text || '';
    const safeBuyerCbs = (safeBuyerCardCtx.edits[0]?.extra?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
    check(
      safeBuyerText.includes(String(buyer1.telegramId)) && !safeBuyerCbs.some((c) => String(c).includes('balance')),
      'adm_sup:u:<id> renders safe buyer card without balance or financial controls'
    );

    // 9.11 onDutyCount excludes banned staff & includes legacy undefined supportOnDuty; safePage clamps out-of-range page
    const legacyStaff = seedUser({ telegramId: 900011, username: 'legacy_sup', role: 'support', supportOnDuty: undefined, isBanned: false });
    const bannedStaff = seedUser({ telegramId: 900012, username: 'banned_sup', role: 'support', supportOnDuty: true, isBanned: true });
    const qCounts = await supportService.getQueuesCounts(support1._id);
    const modHubCtx = await dispatchAction('admin:main', { user: moderator });
    const modHubText = modHubCtx.edits[0]?.text || modHubCtx.replies[0]?.text || '';
    const admHubCtx = await dispatchAction('adm_sup:hub', { user: moderator });
    const admHubText = admHubCtx.edits[0]?.text || admHubCtx.replies[0]?.text || '';
    const expectedActiveModOnDuty = stores.users.filter((u) => ['support', 'moderator'].includes(u.role) && !u.isBanned && u.supportOnDuty !== false).length;
    check(
      modHubText.includes(`Саппортов на смене: <b>${expectedActiveModOnDuty}</b>`) &&
      admHubText.includes(`На смене: <b>${expectedActiveModOnDuty}</b>`) &&
      qCounts.onDutyCount >= expectedActiveModOnDuty,
      'onDutyCount consistently includes undefined supportOnDuty and excludes banned staff across admin.scene, support_admin & supportService'
    );
    // Out-of-range page re-queries last available page instead of showing empty list
    const overflowPageCtx = await dispatchAction('sp:q:closed:99', { user: support1 });
    const overflowPageText = overflowPageCtx.edits[0]?.text || overflowPageCtx.replies[0]?.text || '';
    check(
      !overflowPageText.includes('пока нет') && overflowPageText.includes('#SUP-'),
      'showSupportPanel clamps out-of-range page > totalPages and re-queries valid page'
    );
    // Remove extra test staff so team counts stay clean
    stores.users = stores.users.filter((u) => u !== legacyStaff && u !== bannedStaff);
  }

  // ── 10. Check src/bot/ is completely untouched ────────────────────────────
  console.log('\n10. Checking src/bot/ directory is untouched:');
  {
    const rootDir = path.resolve(__dirname, '..');
    const diffOut = execSync('git status --porcelain -- src/bot/', { cwd: rootDir, encoding: 'utf8' }).trim();
    check(diffOut === '', 'git status --porcelain -- src/bot/ is empty (src/bot/ untouched)');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});

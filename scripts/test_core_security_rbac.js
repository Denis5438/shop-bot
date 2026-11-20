/**
 * scripts/test_core_security_rbac.js
 *
 * Dedicated Automated Test Suite for Milestone 2: Core Platform, Sessions, Security & RBAC
 * Verifies all 7 tasks:
 * 1. Task 3: Step 2.7 [SEC-CORE-02] Persistent Telegraf Sessions (MongoDB)
 * 2. Task 4: Step 2.8 [SEC-CORE-03] User Cache Synchronization
 * 3. Task 5: Step 2.9 [SEC-CORE-04] Superadmin RBAC Hierarchy & Administrative Rights Revocation
 * 4. Task 19: Step 4.8 [SEC-CORE-05] Split RequiredChannel verifiedUserIds into ChannelVerification Model
 * 5. Task 20: Step 4.9 [SEC-CORE-06] Secret Encryption with Safe Mongoose Getters/Setters & Migrations
 * 6. Task 21: Step 4.10 [SEC-CORE-07] Two-Step ToS Reset Confirmation
 * 7. Task 23: Step 4.13 [SEC-CORE-09, SEC-CAT-08] MongoDB Indexes & Index Sync
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Models
const { TelegrafSession, createMongoSessionStore } = require('../src/models/TelegrafSession');
const User = require('../src/models/User');
const RequiredChannel = require('../src/models/RequiredChannel');
const ChannelVerification = require('../src/models/ChannelVerification');
const Settings = require('../src/models/Settings');
const SupplierConfig = require('../src/models/SupplierConfig');
const TopupRequest = require('../src/models/TopupRequest');
const BybitInvoice = require('../src/models/BybitInvoice');

// Middlewares & Scenes
const userMiddlewareModule = require('../src/bot/middlewares/user');
const { adminMiddleware, superadminMiddleware } = require('../src/bot/middlewares/auth');
const usersScene = require('../src/bot/scenes/admin/users.scene');
const settingsScene = require('../src/bot/scenes/admin/settings.scene');
const channelCheckService = require('../src/bot/services/channelCheck.service');
const { PREFIX, encryptSecret, decryptSecret } = require('../src/services/secretBox.service');
const settingsCacheService = require('../src/services/settingsCache.service');

async function runCoreSecurityRBACTests() {
  console.log('🧪 Starting Milestone 2: Core Platform, Sessions, Security & RBAC Test Suite...\n');

  // =========================================================================
  // TEST SUITE 1: Task 3 [SEC-CORE-02] Persistent Telegraf Sessions (MongoDB)
  // =========================================================================
  console.log('--- TEST SUITE 1: Task 3 [SEC-CORE-02] Persistent Telegraf Sessions (MongoDB) ---');
  {
    // 1.1 Schema structure and TTL index
    assert(TelegrafSession, 'TelegrafSession model must be exported');
    const indexes = TelegrafSession.schema.indexes();
    const ttlIndex = indexes.find(([spec, opts]) => spec.updatedAt === 1 && opts?.expireAfterSeconds === 7 * 24 * 60 * 60);
    assert(ttlIndex, 'TelegrafSession must have a 7-day TTL index on updatedAt: { updatedAt: 1 }, { expireAfterSeconds: 604800 }');

    // 1.2 Session store interface
    const store = createMongoSessionStore();
    assert.strictEqual(typeof store.get, 'function', 'store.get must be a function');
    assert.strictEqual(typeof store.set, 'function', 'store.set must be a function');
    assert.strictEqual(typeof store.delete, 'function', 'store.delete must be a function');

    // 1.3 Store operations via mock
    const origFindOne = TelegrafSession.findOne;
    const origUpdateOne = TelegrafSession.updateOne;
    const origDeleteOne = TelegrafSession.deleteOne;

    let mockDbSession = null;
    let savedKey = null;
    let deletedKey = null;

    TelegrafSession.findOne = ({ key }) => ({
      lean: async () => (mockDbSession && key === savedKey ? { key, session: mockDbSession } : null),
    });

    TelegrafSession.updateOne = async ({ key }, { $set }) => {
      savedKey = key;
      mockDbSession = $set.session;
      assert($set.updatedAt instanceof Date, 'set must update updatedAt timestamp with Date');
      return { acknowledged: true };
    };

    TelegrafSession.deleteOne = async ({ key }) => {
      deletedKey = key;
      mockDbSession = null;
      return { acknowledged: true };
    };

    try {
      // Test get on non-existent key
      const initial = await store.get('user:101:chat:101');
      assert.strictEqual(initial, undefined, 'Non-existent session must return undefined');

      // Test set
      await store.set('user:101:chat:101', { step: 'select_network', amount: 50 });
      assert.strictEqual(savedKey, 'user:101:chat:101');
      assert.deepStrictEqual(mockDbSession, { step: 'select_network', amount: 50 });

      // Test get on existing key
      const fetched = await store.get('user:101:chat:101');
      assert.deepStrictEqual(fetched, { step: 'select_network', amount: 50 });

      // Test delete
      await store.delete('user:101:chat:101');
      assert.strictEqual(deletedKey, 'user:101:chat:101');
      const afterDelete = await store.get('user:101:chat:101');
      assert.strictEqual(afterDelete, undefined, 'Deleted session must return undefined');

      // Test error resilience
      TelegrafSession.findOne = () => {
        throw new Error('SIMULATED_DB_DISCONNECTED');
      };
      const resilientGet = await store.get('user:101:chat:101');
      assert.strictEqual(resilientGet, undefined, 'Store.get must catch errors and return undefined gracefully');
    } finally {
      TelegrafSession.findOne = origFindOne;
      TelegrafSession.updateOne = origUpdateOne;
      TelegrafSession.deleteOne = origDeleteOne;
    }

    // 1.4 In src/bot/index.js, verify session store is wired
    const botIndexContent = fs.readFileSync(path.join(__dirname, '../src/bot/index.js'), 'utf8');
    assert(botIndexContent.includes('createMongoSessionStore()'), 'src/bot/index.js must plug createMongoSessionStore() into session middleware');

    console.log('  ✅ Test 1 Passed: TelegrafSession schema, TTL index, store methods, and bot integration verified.\n');
  }

  // =========================================================================
  // TEST SUITE 2: Task 4 [SEC-CORE-03] User Cache Synchronization
  // =========================================================================
  console.log('--- TEST SUITE 2: Task 4 [SEC-CORE-03] User Cache Synchronization ---');
  {
    const { invalidateUserCache, clearUserCache } = userMiddlewareModule;
    assert.strictEqual(typeof invalidateUserCache, 'function', 'invalidateUserCache must be exported');

    // Simulate entries in userCache
    const testUserId1 = new mongoose.Types.ObjectId();
    const testUserId2 = new mongoose.Types.ObjectId();
    const testUserId3 = new mongoose.Types.ObjectId();

    // Trigger userMiddleware with mocks to populate userCache
    clearUserCache();

    const origUserFindOne = User.findOne;
    const origSellerExists = require('../src/models/Seller').exists;

    try {
      require('../src/models/Seller').exists = async () => false;

      // Populate entry 1
      User.findOne = async () => ({ _id: testUserId1, telegramId: 2001, role: 'user', username: 'u2001', save: async () => {} });
      await userMiddlewareModule({ from: { id: 2001, username: 'u2001' }, reply: async () => {} }, async () => {});

      // Populate entry 2
      User.findOne = async () => ({ _id: testUserId2, telegramId: 2002, role: 'user', username: 'u2002', save: async () => {} });
      await userMiddlewareModule({ from: { id: 2002, username: 'u2002' }, reply: async () => {} }, async () => {});

      // Populate entry 3
      User.findOne = async () => ({ _id: testUserId3, telegramId: 2003, role: 'user', username: 'u2003', save: async () => {} });
      await userMiddlewareModule({ from: { id: 2003, username: 'u2003' }, reply: async () => {} }, async () => {});

      let dbCalls = 0;
      User.findOne = async () => {
        dbCalls++;
        return { _id: testUserId1, telegramId: 2001, role: 'user', username: 'u2001', save: async () => {} };
      };

      // 2.1 Fast-path hit: reading 2001 from cache does not call DB
      await userMiddlewareModule({ from: { id: 2001, username: 'u2001' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 0, 'Cached user must be served from cache without DB query');

      // 2.2 Invalidate by numeric telegramId
      invalidateUserCache(2001);
      await userMiddlewareModule({ from: { id: 2001, username: 'u2001' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by numeric telegramId must evict cache');

      // 2.3 Invalidate by string telegramId
      dbCalls = 0;
      invalidateUserCache('2001');
      await userMiddlewareModule({ from: { id: 2001, username: 'u2001' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by string telegramId must evict cache');

      // 2.4 Invalidate by user object containing telegramId
      dbCalls = 0;
      invalidateUserCache({ telegramId: 2002 });
      User.findOne = async () => {
        dbCalls++;
        return { _id: testUserId2, telegramId: 2002, role: 'user', username: 'u2002', save: async () => {} };
      };
      await userMiddlewareModule({ from: { id: 2002, username: 'u2002' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by { telegramId } object must evict cache');

      // 2.5 Invalidate by user object containing _id
      dbCalls = 0;
      invalidateUserCache({ _id: testUserId2 });
      await userMiddlewareModule({ from: { id: 2002, username: 'u2002' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by { _id } object must evict cache');

      // 2.6 Invalidate by direct ObjectId instance
      dbCalls = 0;
      User.findOne = async () => {
        dbCalls++;
        return { _id: testUserId3, telegramId: 2003, role: 'user', username: 'u2003', save: async () => {} };
      };
      // Verify cached first
      await userMiddlewareModule({ from: { id: 2003, username: 'u2003' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 0, 'Entry 3 must be cached');
      invalidateUserCache(testUserId3);
      await userMiddlewareModule({ from: { id: 2003, username: 'u2003' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by direct ObjectId must evict cache');

      // 2.7 Invalidate by string representation of ObjectId
      dbCalls = 0;
      invalidateUserCache(testUserId3.toString());
      await userMiddlewareModule({ from: { id: 2003, username: 'u2003' }, reply: async () => {} }, async () => {});
      assert.strictEqual(dbCalls, 1, 'Invalidation by hex string _id must evict cache');

      // 2.8 Edge case: null or undefined does not throw
      assert.doesNotThrow(() => invalidateUserCache(null));
      assert.doesNotThrow(() => invalidateUserCache(undefined));
      assert.doesNotThrow(() => invalidateUserCache({}));
    } finally {
      User.findOne = origUserFindOne;
      require('../src/models/Seller').exists = origSellerExists;
      clearUserCache();
    }

    console.log('  ✅ Test 2 Passed: Polymorphic invalidateUserCache evicts by numeric id, string id, object, and ObjectId.\n');
  }

  // =========================================================================
  // TEST SUITE 3: Task 5 [SEC-CORE-04] Superadmin RBAC Hierarchy & Administrative Rights Revocation
  // =========================================================================
  console.log('--- TEST SUITE 3: Task 5 [SEC-CORE-04] Superadmin RBAC Hierarchy & Administrative Rights Revocation ---');
  {
    // 3.1 User schema role enum and promotedBy
    const roleEnum = User.schema.path('role').enumValues;
    assert(roleEnum.includes('superadmin'), 'User role enum must include "superadmin"');
    assert(roleEnum.includes('admin'), 'User role enum must include "admin"');
    assert(roleEnum.includes('user'), 'User role enum must include "user"');

    const promotedByPath = User.schema.path('promotedBy');
    assert(promotedByPath, 'User schema must have promotedBy field');
    assert.strictEqual(promotedByPath.instance, 'Number', 'promotedBy must be a Number');

    // 3.2 config index SUPERADMIN_IDS
    const config = require('../src/config');
    assert(Array.isArray(config.SUPERADMIN_IDS), 'config.SUPERADMIN_IDS must be an array');
    assert(Array.isArray(config.ADMIN_IDS), 'config.ADMIN_IDS must be an array');
    if (config.ADMIN_IDS.length > 0 && (!process.env.SUPERADMIN_IDS || process.env.SUPERADMIN_IDS.trim() === '')) {
      assert.strictEqual(
        config.SUPERADMIN_IDS[0],
        config.ADMIN_IDS[0],
        'SUPERADMIN_IDS must fall back to ADMIN_IDS.slice(0, 1) when empty'
      );
    }

    // 3.3 authMiddleware & superadminMiddleware tests
    let nextCalled = false;
    const dummyNext = async () => {
      nextCalled = true;
    };

    // adminMiddleware: permits 'admin' and 'superadmin', blocks 'user'
    nextCalled = false;
    await adminMiddleware({ user: { role: 'admin' } }, dummyNext);
    assert.strictEqual(nextCalled, true, 'adminMiddleware must permit role "admin"');

    nextCalled = false;
    await adminMiddleware({ user: { role: 'superadmin' } }, dummyNext);
    assert.strictEqual(nextCalled, true, 'adminMiddleware must permit role "superadmin"');

    let replyBlocked = false;
    nextCalled = false;
    await adminMiddleware(
      {
        user: { role: 'user' },
        reply: async () => {
          replyBlocked = true;
        },
      },
      dummyNext
    );
    assert.strictEqual(nextCalled, false, 'adminMiddleware must block role "user"');
    assert.strictEqual(replyBlocked, true, 'adminMiddleware must reply when blocking');

    // superadminMiddleware: permits only 'superadmin'
    nextCalled = false;
    await superadminMiddleware({ user: { role: 'superadmin' } }, dummyNext);
    assert.strictEqual(nextCalled, true, 'superadminMiddleware must permit role "superadmin"');

    nextCalled = false;
    replyBlocked = false;
    await superadminMiddleware(
      {
        user: { role: 'admin' },
        reply: async () => {
          replyBlocked = true;
        },
      },
      dummyNext
    );
    assert.strictEqual(nextCalled, false, 'superadminMiddleware must block role "admin"');
    assert.strictEqual(replyBlocked, true);

    // 3.4 userMiddleware RBAC role revocation & maintenance checks
    const origUserFindOne = User.findOne;
    const origSellerExists = require('../src/models/Seller').exists;
    const origConfigSuperadmins = config.SUPERADMIN_IDS;
    const origConfigAdmins = config.ADMIN_IDS;

    try {
      require('../src/models/Seller').exists = async () => false;

      // Simulate config IDs: superadmin: 9001, admin: 9002
      config.SUPERADMIN_IDS = [9001];
      config.ADMIN_IDS = [9002];

      // New superadmin created
      let savedNewUser = null;
      User.findOne = async () => null;
      const origSave = User.prototype.save;
      User.prototype.save = async function () {
        savedNewUser = this;
        return this;
      };

      await userMiddlewareModule({ from: { id: 9001, username: 'super' } }, async () => {});
      assert(savedNewUser, 'New user should be saved');
      assert.strictEqual(savedNewUser.role, 'superadmin', 'User in SUPERADMIN_IDS must be created as superadmin');

      // Existing admin removed from ADMIN_IDS without promotedBy -> auto-revoked to user
      let savedExistingUser = null;
      const mockAdminWithoutPromotedBy = {
        telegramId: 8888,
        username: null,
        firstName: '',
        lastName: '',
        role: 'admin',
        promotedBy: null,
        save: async function () {
          savedExistingUser = this;
          return this;
        },
      };
      User.findOne = async () => mockAdminWithoutPromotedBy;
      userMiddlewareModule.clearUserCache();
      await userMiddlewareModule({ from: { id: 8888 } }, async () => {});
      assert(savedExistingUser, 'Existing user must be saved');
      assert.strictEqual(savedExistingUser.role, 'user', 'Admin removed from ADMIN_IDS without promotedBy must be revoked to "user"');

      // Existing admin removed from ADMIN_IDS but WITH promotedBy -> role preserved
      savedExistingUser = null;
      const mockAdminWithPromotedBy = {
        telegramId: 7777,
        username: null,
        firstName: '',
        lastName: '',
        role: 'admin',
        promotedBy: 9001, // Promoted by superadmin via UI
        save: async function () {
          savedExistingUser = this;
          return this;
        },
      };
      User.findOne = async () => mockAdminWithPromotedBy;
      userMiddlewareModule.clearUserCache();
      await userMiddlewareModule({ from: { id: 7777 } }, async () => {});
      assert.strictEqual(savedExistingUser, null, 'Admin with promotedBy must NOT be saved because role did not change');
      assert.strictEqual(mockAdminWithPromotedBy.role, 'admin', 'Admin with promotedBy must preserve "admin" role');

      // Maintenance mode permits superadmin and admin
      global.MAINTENANCE_MODE = true;
      let maintenanceAllowed = false;
      await userMiddlewareModule(
        { from: { id: 9001 } },
        async () => {
          maintenanceAllowed = true;
        }
      );
      assert.strictEqual(maintenanceAllowed, true, 'Superadmin must bypass maintenance mode');

      maintenanceAllowed = false;
      await userMiddlewareModule(
        { from: { id: 9002 } },
        async () => {
          maintenanceAllowed = true;
        }
      );
      assert.strictEqual(maintenanceAllowed, true, 'Admin must bypass maintenance mode');

      maintenanceAllowed = false;
      let maintenanceBlockedMsg = false;
      User.findOne = async () => ({ telegramId: 5555, role: 'user', save: async () => {} });
      await userMiddlewareModule(
        {
          from: { id: 5555 },
          reply: async () => {
            maintenanceBlockedMsg = true;
          },
        },
        async () => {
          maintenanceAllowed = true;
        }
      );
      assert.strictEqual(maintenanceAllowed, false, 'Normal user must be blocked by maintenance mode');
      assert.strictEqual(maintenanceBlockedMsg, true, 'Maintenance message must be sent');
      global.MAINTENANCE_MODE = false;

      // 3.5 users.scene.js toggleRole permissions
      const origUserFindById = User.findById;
      const Order = require('../src/models/Order');
      const origOrderCount = Order.countDocuments;
      const origUserCount = User.countDocuments;
      Order.countDocuments = async () => 0;
      User.countDocuments = async () => 0;

      const mockTargetUser = {
        _id: new mongoose.Types.ObjectId(),
        telegramId: 4444,
        role: 'user',
        promotedBy: null,
        save: async function () {
          return this;
        },
      };

      const mockSuperAdminDoc = {
        _id: new mongoose.Types.ObjectId(),
        telegramId: 9001,
        role: 'superadmin',
        save: async function () {
          return this;
        },
      };

      User.findById = (id) => {
        const u = String(id) === String(mockSuperAdminDoc._id) ? mockSuperAdminDoc : mockTargetUser;
        const queryObj = {
          ...u,
          lean: async () => u,
          save: u.save,
        };
        queryObj.then = (fn) => Promise.resolve(u).then(fn);
        return queryObj;
      };

      // Non-superadmin calling toggleRole is blocked
      let alertMsg = null;
      const ctxRegularAdmin = {
        user: { telegramId: 9002, role: 'admin' },
        answerCbQuery: async (msg) => {
          alertMsg = msg;
        },
      };
      await usersScene.toggleRole(ctxRegularAdmin, mockTargetUser._id);
      assert(alertMsg && alertMsg.includes('Только главный администратор'), 'Non-superadmin must be blocked from changing roles');

      // Superadmin calling toggleRole on another superadmin is blocked
      alertMsg = null;
      const ctxSuperAdmin = {
        user: { telegramId: 9001, role: 'superadmin' },
        answerCbQuery: async (msg) => {
          alertMsg = msg;
        },
        editMessageText: async () => {},
        reply: async () => {},
      };
      await usersScene.toggleRole(ctxSuperAdmin, mockSuperAdminDoc._id);
      assert(alertMsg && alertMsg.includes('Нельзя изменить роль главного администратора'), 'Cannot alter role of superadmin');

      // Superadmin promotes user -> becomes admin with promotedBy
      await usersScene.toggleRole(ctxSuperAdmin, mockTargetUser._id);
      assert.strictEqual(mockTargetUser.role, 'admin', 'User must be promoted to admin');
      assert.strictEqual(mockTargetUser.promotedBy, 9001, 'promotedBy must record promoting superadmin ID');

      // Superadmin demotes admin -> becomes user with promotedBy null
      await usersScene.toggleRole(ctxSuperAdmin, mockTargetUser._id);
      assert.strictEqual(mockTargetUser.role, 'user', 'Admin must be demoted back to user');
      assert.strictEqual(mockTargetUser.promotedBy, null, 'promotedBy must be cleared to null');

      User.prototype.save = origSave;
      User.findById = origUserFindById;
      Order.countDocuments = origOrderCount;
      User.countDocuments = origUserCount;
    } finally {
      config.SUPERADMIN_IDS = origConfigSuperadmins;
      config.ADMIN_IDS = origConfigAdmins;
      User.findOne = origUserFindOne;
      require('../src/models/Seller').exists = origSellerExists;
      global.MAINTENANCE_MODE = false;
      userMiddlewareModule.clearUserCache();
    }

    console.log('  ✅ Test 3 Passed: Superadmin RBAC hierarchy, auth middlewares, and right revocations verified.\n');
  }

  // =========================================================================
  // TEST SUITE 4: Task 19 [SEC-CORE-05] Split RequiredChannel verifiedUserIds into ChannelVerification Model
  // =========================================================================
  console.log('--- TEST SUITE 4: Task 19 [SEC-CORE-05] Split RequiredChannel verifiedUserIds into ChannelVerification Model ---');
  {
    // 4.1 Schema checks
    assert.strictEqual(
      RequiredChannel.schema.paths.verifiedUserIds,
      undefined,
      'verifiedUserIds array must be removed from RequiredChannel schema'
    );

    assert(ChannelVerification, 'ChannelVerification model must exist');
    assert(ChannelVerification.schema.paths.channelId, 'ChannelVerification must have channelId');
    assert(ChannelVerification.schema.paths.userId, 'ChannelVerification must have userId');
    assert(ChannelVerification.schema.paths.verifiedAt, 'ChannelVerification must have verifiedAt');

    const cvIndexes = ChannelVerification.schema.indexes();
    const hasCompoundUnique = cvIndexes.some(
      ([spec, opts]) => spec.channelId === 1 && spec.userId === 1 && opts?.unique === true
    );
    assert(hasCompoundUnique, 'ChannelVerification must have unique compound index { channelId: 1, userId: 1 }');

    // 4.2 Verification record subscription logic
    const origCvUpdateOne = ChannelVerification.updateOne;
    const origRcUpdateOne = RequiredChannel.updateOne;

    const testChannelId = new mongoose.Types.ObjectId();
    let cvQuery = null;
    let cvSetOnInsert = null;
    let rcInc = 0;

    try {
      // First verification: upsertedCount = 1
      ChannelVerification.updateOne = async (filter, update) => {
        cvQuery = filter;
        cvSetOnInsert = update.$setOnInsert;
        return { upsertedCount: 1 };
      };

      RequiredChannel.updateOne = async (filter, update) => {
        if (update.$inc?.subscribersCount) {
          rcInc += update.$inc.subscribersCount;
        }
        return { acknowledged: true };
      };

      await channelCheckService.recordChannelSubscription(testChannelId, 555666777);

      assert.deepStrictEqual(cvQuery, { channelId: testChannelId, userId: '555666777' });
      assert(cvSetOnInsert?.verifiedAt instanceof Date, 'verifiedAt must be a Date');
      assert.strictEqual(rcInc, 1, 'First verification must increment subscribersCount by 1');

      // Duplicate verification: upsertedCount = 0
      ChannelVerification.updateOne = async () => ({ upsertedCount: 0 });
      rcInc = 0;

      await channelCheckService.recordChannelSubscription(testChannelId, 555666777);
      assert.strictEqual(rcInc, 0, 'Duplicate verification must NOT increment subscribersCount');
    } finally {
      ChannelVerification.updateOne = origCvUpdateOne;
      RequiredChannel.updateOne = origRcUpdateOne;
    }

    console.log('  ✅ Test 4 Passed: ChannelVerification model and idempotent subscription counting verified.\n');
  }

  // =========================================================================
  // TEST SUITE 5: Task 20 [SEC-CORE-06] Secret Encryption with Safe Mongoose Getters/Setters
  // =========================================================================
  console.log('--- TEST SUITE 5: Task 20 [SEC-CORE-06] Secret Encryption with Safe Mongoose Getters/Setters ---');
  {
    // 5.1 Settings secret fields encryption and safe getter
    const mockSettingsDoc = new Settings({
      name: 'global',
      cardNumber: '2200123456789012',
      cardHolder: 'IVAN IVANOV',
      bybitApiKey: 'bybit_key_abc',
      bybitApiSecret: 'bybit_secret_xyz',
      plategaMerchantId: 'merchant_123',
      plategaSecret: 'platega_sec_456',
      geminiApiKey: 'gemini_key_789',
    });

    // Directly examine underlying raw value stored in Mongoose internal state
    const rawCardNumber = mockSettingsDoc.get('cardNumber', null, { getters: false });
    assert(rawCardNumber.startsWith(PREFIX), `Stored raw cardNumber must start with ${PREFIX}, got: ${rawCardNumber}`);

    const rawBybitKey = mockSettingsDoc.get('bybitApiKey', null, { getters: false });
    assert(rawBybitKey.startsWith(PREFIX), `Stored raw bybitApiKey must start with ${PREFIX}`);

    // Read through getter
    assert.strictEqual(mockSettingsDoc.cardNumber, '2200123456789012', 'Getter must return decrypted cardNumber');
    assert.strictEqual(mockSettingsDoc.cardHolder, 'IVAN IVANOV', 'Getter must return decrypted cardHolder');
    assert.strictEqual(mockSettingsDoc.bybitApiKey, 'bybit_key_abc', 'Getter must return decrypted bybitApiKey');
    assert.strictEqual(mockSettingsDoc.bybitApiSecret, 'bybit_secret_xyz', 'Getter must return decrypted bybitApiSecret');
    assert.strictEqual(mockSettingsDoc.plategaMerchantId, 'merchant_123', 'Getter must return decrypted plategaMerchantId');
    assert.strictEqual(mockSettingsDoc.plategaSecret, 'platega_sec_456', 'Getter must return decrypted plategaSecret');
    assert.strictEqual(mockSettingsDoc.geminiApiKey, 'gemini_key_789', 'Getter must return decrypted geminiApiKey');

    // 5.2 Safe getter fallback on plaintext / empty / null
    const docWithPlaintext = new Settings();
    docWithPlaintext.set('cardNumber', 'plain_unencrypted_card', { getters: false });
    assert.strictEqual(
      docWithPlaintext.cardNumber,
      'plain_unencrypted_card',
      'Plaintext value must not crash decryptSecret and return as-is'
    );

    const docWithEmpty = new Settings();
    docWithEmpty.set('cardNumber', '', { getters: false });
    assert.strictEqual(docWithEmpty.cardNumber, '', 'Empty string must return empty string');

    // 5.3 SupplierConfig secret field encryption
    const mockSupplier = new SupplierConfig({
      supplierId: 'jaha',
      title: 'Jaha Digital',
      apiKey: 'jaha_secret_api_key_123',
    });
    const rawSupplierKey = mockSupplier.get('apiKey', null, { getters: false });
    assert(rawSupplierKey.startsWith(PREFIX), `Stored raw apiKey must start with ${PREFIX}`);
    assert.strictEqual(mockSupplier.apiKey, 'jaha_secret_api_key_123', 'Getter must return decrypted apiKey');

    // 5.4 settingsCacheService lean getters
    const origSettingsFindOne = Settings.findOne;
    let leanOptionsPassed = null;
    Settings.findOne = () => ({
      lean: (opts) => {
        leanOptionsPassed = opts;
        return Promise.resolve({
          cardNumber: '2200123456789012',
          bybitApiKey: 'bybit_key_abc',
        });
      },
    });

    const origReadyStateDesc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

    try {
      settingsCacheService.invalidateCache();
      await settingsCacheService.getSettings();
      assert(leanOptionsPassed?.getters === true, 'Settings.findOne().lean() must specify { getters: true }');
    } finally {
      Settings.findOne = origSettingsFindOne;
      if (origReadyStateDesc) {
        Object.defineProperty(mongoose.connection, 'readyState', origReadyStateDesc);
      }
    }

    // 5.5 Migration and Rollback scripts validation
    const migrateScriptPath = path.join(__dirname, 'migrate-encrypt-secrets.js');
    const rollbackScriptPath = path.join(__dirname, 'rollback-decrypt-secrets.js');
    assert(fs.existsSync(migrateScriptPath), 'scripts/migrate-encrypt-secrets.js must exist');
    assert(fs.existsSync(rollbackScriptPath), 'scripts/rollback-decrypt-secrets.js must exist');

    const migrateModule = require('./migrate-encrypt-secrets');
    const rollbackModule = require('./rollback-decrypt-secrets');
    assert.strictEqual(typeof migrateModule.runMigration, 'function', 'migrate module must export runMigration');
    assert.strictEqual(typeof rollbackModule.runRollback, 'function', 'rollback module must export runRollback');

    console.log('  ✅ Test 5 Passed: AES-256-GCM secret encryption, safe getters/setters, lean getters, and migration scripts verified.\n');
  }

  // =========================================================================
  // TEST SUITE 6: Task 21 [SEC-CORE-07] Two-Step ToS Reset Confirmation
  // =========================================================================
  console.log('--- TEST SUITE 6: Task 21 [SEC-CORE-07] Two-Step ToS Reset Confirmation ---');
  {
    assert.strictEqual(typeof settingsScene.confirmResetToS, 'function', 'confirmResetToS must be exported');
    assert.strictEqual(typeof settingsScene.executeResetAllUserToS, 'function', 'executeResetAllUserToS must be exported');

    // 6.1 Step 1: confirmResetToS shows warning and confirmation keyboard without resetting DB
    let editedText = null;
    let keyboardButtons = [];
    const ctxConfirm = {
      answerCbQuery: async () => {},
      editMessageText: async (text, opts) => {
        editedText = text;
        keyboardButtons = opts?.reply_markup?.inline_keyboard || [];
      },
      reply: async (text, opts) => {
        editedText = text;
        keyboardButtons = opts?.reply_markup?.inline_keyboard || [];
      },
    };

    await settingsScene.confirmResetToS(ctxConfirm);
    assert(editedText && editedText.includes('Подтверждение сброса Оферты'), 'Warning text must be displayed');
    const confirmBtn = keyboardButtons.flat().find(b => b.callback_data === 'admin:settings:reset_tos:confirm');
    const cancelBtn = keyboardButtons.flat().find(b => b.callback_data === 'admin:settings');
    assert(confirmBtn, 'Confirmation button "admin:settings:reset_tos:confirm" must be present');
    assert(cancelBtn, 'Cancel button "admin:settings" must be present');

    // 6.2 Step 2: executeResetAllUserToS executes mass reset
    const origUserUpdateMany = User.updateMany;
    const origClearUserCache = userMiddlewareModule.clearUserCache;
    const origSettingsFindOne = Settings.findOne;

    let updateManyFilter = null;
    let updateManySet = null;
    let cacheCleared = false;
    let answerAlertText = null;

    const mockSettingsForScene = {
      _id: new mongoose.Types.ObjectId(),
      name: 'global',
      maintenanceMode: false,
      smartPricing: false,
      autoMarkdownEnabled: false,
      plategaEnabled: true,
      cardEnabled: true,
      bybitEnabled: true,
      currencyMode: 'bybit_p2p',
      globalButtonsMode: 'by_user',
    };
    settingsCacheService.invalidateCache(mockSettingsForScene);

    Settings.findOne = () => {
      const q = Promise.resolve(mockSettingsForScene);
      q.lean = async () => mockSettingsForScene;
      return q;
    };

    try {
      User.updateMany = async (filter, update) => {
        updateManyFilter = filter;
        updateManySet = update.$set;
        return { modifiedCount: 42 };
      };

      userMiddlewareModule.clearUserCache = () => {
        cacheCleared = true;
      };

      const ctxExecute = {
        answerCbQuery: async (msg) => {
          answerAlertText = msg;
        },
        editMessageText: async () => {},
        reply: async () => {},
      };

      await settingsScene.executeResetAllUserToS(ctxExecute);

      assert.deepStrictEqual(updateManyFilter, {}, 'updateMany must target all users');
      assert.strictEqual(updateManySet.acceptedToS, false, 'acceptedToS must be set to false');
      assert.strictEqual(updateManySet.acceptedToSAt, null, 'acceptedToSAt must be set to null');
      assert.strictEqual(cacheCleared, true, 'User cache must be cleared completely');
      assert(answerAlertText && answerAlertText.includes('42'), 'Alert must report modified count');
    } finally {
      User.updateMany = origUserUpdateMany;
      userMiddlewareModule.clearUserCache = origClearUserCache;
      Settings.findOne = origSettingsFindOne;
    }

    // 6.3 Routes in admin.routes.js verify two-step routing
    const routesContent = fs.readFileSync(path.join(__dirname, '../src/bot/routes/admin.routes.js'), 'utf8');
    assert(
      routesContent.includes("admin:settings:reset_tos', adminMiddleware, async (ctx) => {\n    await settingsScene.confirmResetToS(ctx);") ||
      routesContent.includes('confirmResetToS(ctx)'),
      'admin:settings:reset_tos must route to confirmResetToS'
    );
    assert(
      routesContent.includes("admin:settings:reset_tos:confirm', adminMiddleware, async (ctx) => {\n    await settingsScene.executeResetAllUserToS(ctx);") ||
      routesContent.includes('executeResetAllUserToS(ctx)'),
      'admin:settings:reset_tos:confirm must route to executeResetAllUserToS'
    );

    console.log('  ✅ Test 6 Passed: Two-step ToS confirmation flow and routes verified.\n');
  }

  // =========================================================================
  // TEST SUITE 7: Task 23 [SEC-CORE-09, SEC-CAT-08] MongoDB Indexes & Index Sync
  // =========================================================================
  console.log('--- TEST SUITE 7: Task 23 [SEC-CORE-09, SEC-CAT-08] MongoDB Indexes & Index Sync ---');
  {
    // 7.1 TopupRequest partial unique index on paymentId
    const topupIndexes = TopupRequest.schema.indexes();
    const paymentIdIndex = topupIndexes.find(
      ([spec, opts]) =>
        spec.paymentId === 1 &&
        opts?.unique === true &&
        opts?.partialFilterExpression?.paymentId?.$type === 'string' &&
        opts?.name === 'paymentId_string_unique'
    );
    assert(paymentIdIndex, 'TopupRequest must have unique partial index paymentId_string_unique with paymentId: { $type: "string" }');

    // 7.2 BybitInvoice partial unique index on txId
    const bybitIndexes = BybitInvoice.schema.indexes();
    const txIdIndex = bybitIndexes.find(
      ([spec, opts]) =>
        spec.txId === 1 &&
        opts?.unique === true &&
        opts?.partialFilterExpression?.txId?.$type === 'string'
    );
    assert(txIdIndex, 'BybitInvoice must have unique partial index on txId where txId: { $type: "string" }');

    // 7.3 Index synchronization in src/db/connect.js
    const connectContent = fs.readFileSync(path.join(__dirname, '../src/db/connect.js'), 'utf8');
    assert(connectContent.includes('BybitInvoice.syncIndexes()'), 'src/db/connect.js must sync BybitInvoice indexes');
    assert(connectContent.includes('ChannelVerification.syncIndexes()'), 'src/db/connect.js must sync ChannelVerification indexes');
    assert(connectContent.includes('TelegrafSession.syncIndexes()'), 'src/db/connect.js must sync TelegrafSession indexes');
    assert(connectContent.includes('TopupRequest.syncIndexes()'), 'src/db/connect.js must sync TopupRequest indexes');

    console.log('  ✅ Test 7 Passed: Partial unique indexes and db connect synchronization verified.\n');
  }

  console.log('🎉 ALL 7 CORE PLATFORM, SESSIONS, SECURITY & RBAC TASKS VERIFIED SUCCESSFULLY! 🚀\n');
}

if (require.main === module) {
  runCoreSecurityRBACTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Test suite failed:', err);
      process.exit(1);
    });
}

module.exports = { runCoreSecurityRBACTests };

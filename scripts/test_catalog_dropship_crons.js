/**
 * Dedicated Automated Test Suite for Milestone 3:
 * Catalog, Dropshipping, Pre-orders & Crons Hardening
 *
 * Verifies all 9 tasks:
 * 1. Task 6: Step 2.10 [SEC-CAT-01] Manual Stock Leak Prevention on Pre-Order Cancellation
 * 2. Task 7: Step 3.3 [SEC-CAT-04] Anti-Sybil Referral Order Threshold
 * 3. Task 8: Step 3.4 [SEC-DROP-03] Exponential Backoff & DLQ for Activation Retries
 * 4. Task 9: Step 3.5 [SEC-DROP-04] Idempotency & Order Status Check on Supplier Timeout
 * 5. Task 10: Step 3.6 [SEC-CAT-05] Pagination in Referral Reconcile Cron
 * 6. Task 11: Step 3.7 [SEC-CAT-06] Zero-Division & Sanity Protection in Smart Markdown
 * 7. Task 12: Step 3.8 [SEC-DROP-06] Preserve Custom Supplier Margins on Key Update
 * 8. Task 13: Step 3.9 [SEC-DROP-07] Dropshipping Pre-orders Auto-Purchase
 * 9. Task 22: Step 4.12 [SEC-CAT-07] Waitlist Cleanup on Pre-Order Cancellation
 */

const assert = require('assert');
const mongoose = require('mongoose');

// Services & modules under test
const notif = require('../src/services/notification.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../src/services/referral.service');
const {
  handleSupplierRetry,
  MAX_RETRIES,
  RETRY_DELAYS,
  getRetryDelay,
} = require('../src/cron/retryActivation.cron');
const { reconcileReferralBonuses } = require('../src/cron/referralReconcile.cron');
const { getEffectivePrice } = require('../src/services/orderPricing.service');
const supplierManager = require('../src/services/supplierManager.service');
const profileScene = require('../src/bot/scenes/profile.scene');
const achievementsService = require('../src/services/achievements.service');
const { _setTransactionsAvailable } = require('../src/services/transactionHelper.service');

// Models
const Key = require('../src/models/Key');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const User = require('../src/models/User');
const Waitlist = require('../src/models/Waitlist');
const SupplierConfig = require('../src/models/SupplierConfig');
const Settings = require('../src/models/Settings');
const Transaction = require('../src/models/Transaction');

async function runMilestone3Tests() {
  console.log('🧪 Starting Milestone 3: Catalog, Dropshipping, Pre-orders & Crons Test Suite...\n');

  _setTransactionsAvailable(false);
  const origCheckAndGrant = achievementsService.checkAndGrantAchievements;
  achievementsService.checkAndGrantAchievements = async () => {};

  // Stub Order countDocuments & distinct, User findOne, Key updateMany/updateOne to avoid buffering timeout
  const origOrderCountDocuments = Order.countDocuments;
  const origOrderDistinct = Order.distinct;
  const origUserFindOne = User.findOne;
  const origKeyUpdateMany = Key.updateMany;
  const origKeyUpdateOne = Key.updateOne;
  const origUserUpdateOne = User.updateOne;
  Order.countDocuments = async () => 0;
  Order.distinct = async () => [];
  User.findOne = async () => null;
  Key.updateMany = async () => ({ modifiedCount: 0 });
  Key.updateOne = async () => ({ modifiedCount: 0 });
  User.updateOne = async () => ({ modifiedCount: 1 });

  // =========================================================================
  // TEST SUITE 1: Task 6 [SEC-CAT-01] Manual Stock Leak Prevention on Pre-Order Cancellation
  // =========================================================================
  console.log('--- TEST SUITE 1: Task 6 [SEC-CAT-01] Manual Stock Leak Prevention ---');
  {
    const origOrderFind = Order.find;
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    const origOrderUpdateOne = Order.updateOne;
    const origProductUpdateOne = Product.updateOne;
    const origWaitlistFindOneAndDelete = Waitlist.findOneAndDelete;

    try {
      // 1.1 Concurrently cancelled preorder: claimedPreorder evaluates to null -> Product.updateOne NEVER called
      let stockDecremented = false;
      let orderRollbackCalled = false;

      Order.find = () => ({
        sort: () => ({
          populate: async () => [
            {
              _id: new mongoose.Types.ObjectId(),
              productId: new mongoose.Types.ObjectId(),
              qty: 2,
              status: 'preorder_pending',
              userId: { _id: new mongoose.Types.ObjectId(), telegramId: 123456 },
            },
          ],
        }),
      });

      // Simulate concurrent cancellation: findOneAndUpdate fails to claim 'preorder_pending'
      Order.findOneAndUpdate = async (filter) => {
        if (filter.status === 'preorder_pending') {
          return null; // Already cancelled or claimed
        }
        return null;
      };

      Product.updateOne = async () => {
        stockDecremented = true;
        return { modifiedCount: 1 };
      };

      const manualProduct = {
        _id: new mongoose.Types.ObjectId(),
        type: 'manual',
        manualStock: 10,
        name: 'Manual Account',
      };

      await notif.fulfillPreorders(manualProduct);
      assert.strictEqual(
        stockDecremented,
        false,
        'manualStock must NEVER be decremented if preorder was concurrently cancelled'
      );

      // 1.2 Successful claim decrements stock
      let claimedOrder = null;
      let decrementedQty = 0;
      const testOrderId = new mongoose.Types.ObjectId();
      const testUserId = new mongoose.Types.ObjectId();

      Order.find = () => ({
        sort: () => ({
          populate: async () => [
            {
              _id: testOrderId,
              productId: manualProduct._id,
              qty: 3,
              status: 'preorder_pending',
              userId: { _id: testUserId, telegramId: 123456 },
            },
          ],
        }),
      });

      Order.findOneAndUpdate = async (filter, update) => {
        if (String(filter._id) === String(testOrderId) && filter.status === 'preorder_pending') {
          claimedOrder = { _id: testOrderId, status: update.$set.status };
          return claimedOrder;
        }
        return null;
      };

      Product.updateOne = async (filter, update) => {
        if (String(filter._id) === String(manualProduct._id) && filter.manualStock.$gte === 3) {
          decrementedQty = -update.$inc.manualStock;
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };

      Waitlist.findOneAndDelete = async () => ({ ok: 1 });

      await notif.fulfillPreorders(manualProduct);
      assert.strictEqual(claimedOrder.status, 'pending', 'Order must be claimed into pending status');
      assert.strictEqual(decrementedQty, 3, 'Product manualStock must be decremented by orderQty');

      // 1.3 Insufficient stock rollback: if stock update fails, rolls back order status to preorder_pending
      let rolledBackStatus = null;
      Product.updateOne = async () => ({ modifiedCount: 0 }); // out of stock
      Order.updateOne = async (filter, update) => {
        if (String(filter._id) === String(testOrderId) && filter.status === 'pending') {
          rolledBackStatus = update.$set.status;
          orderRollbackCalled = true;
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };

      await notif.fulfillPreorders(manualProduct);
      assert.strictEqual(orderRollbackCalled, true, 'Order status rollback must be called when stock update fails');
      assert.strictEqual(rolledBackStatus, 'preorder_pending', 'Order must roll back to preorder_pending');

      console.log('  ✅ Test 1 Passed: Manual stock leak prevention, atomic claim, and rollback verified.');
    } finally {
      Order.find = origOrderFind;
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
      Order.updateOne = origOrderUpdateOne;
      Product.updateOne = origProductUpdateOne;
      Waitlist.findOneAndDelete = origWaitlistFindOneAndDelete;
    }
  }

  // =========================================================================
  // TEST SUITE 2: Task 7 [SEC-CAT-04] Anti-Sybil Referral Order Threshold
  // =========================================================================
  console.log('--- TEST SUITE 2: Task 7 [SEC-CAT-04] Anti-Sybil Referral Order Threshold ---');
  {
    const origUserFindById = User.findById;
    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    const origOrderFindOne = Order.findOne;
    const origTransactionSave = Transaction.prototype.save;
    const origSettingsFindOne = Settings.findOne;

    Settings.findOne = () => ({
      lean: async () => ({ referralBonus: 0.5 }),
    });

    try {
      const referrerId = new mongoose.Types.ObjectId();
      const referredUserId = new mongoose.Types.ObjectId();

      User.findById = async () => ({
        _id: referredUserId,
        referredBy: referrerId,
        referralBonusGrantedAt: null,
      });

      // 2.1 No qualifying order (all orders < 3.00)
      Order.findOne = async (filter) => {
        if (filter.price && filter.price.$gte === 3.0) {
          return null; // No orders >= 3.00
        }
        return null;
      };

      const resultBelow = await grantReferralBonusForFirstCompletedOrder(referredUserId);
      assert.strictEqual(resultBelow.granted, false);
      assert.strictEqual(resultBelow.reason, 'order_below_threshold', 'Must reject bonus if order < 3.00 USDT');

      // 2.2 Qualifying order (order price = 3.00 USDT)
      Order.findOne = async (filter) => {
        if (filter.price && filter.price.$gte === 3.0) {
          return {
            _id: new mongoose.Types.ObjectId(),
            userId: referredUserId,
            status: 'completed',
            price: 3.0,
          };
        }
        return null;
      };

      let bonusCredited = 0;
      User.findOneAndUpdate = async (filter, update) => {
        if (filter._id === referredUserId) {
          return { _id: referredUserId, referredBy: referrerId, telegramId: 999111 };
        }
        if (filter._id === referrerId) {
          bonusCredited = update.$inc.balance;
          return { _id: referrerId, balance: 10 + bonusCredited };
        }
        return null;
      };

      Transaction.prototype.save = async function () {
        return this;
      };

      const resultValid = await grantReferralBonusForFirstCompletedOrder(referredUserId);
      assert.strictEqual(resultValid.granted, true);
      assert.strictEqual(resultValid.amount, 0.5);
      assert.strictEqual(bonusCredited, 0.5, 'Referrer must receive 0.5 USDT referral bonus');

      console.log('  ✅ Test 2 Passed: Anti-Sybil order threshold ($3.00) enforced properly.');
    } finally {
      User.findById = origUserFindById;
      User.findOneAndUpdate = origUserFindOneAndUpdate;
      Order.findOne = origOrderFindOne;
      Transaction.prototype.save = origTransactionSave;
      Settings.findOne = origSettingsFindOne;
    }
  }

  // =========================================================================
  // TEST SUITE 3: Task 8 [SEC-DROP-03] Exponential Backoff & DLQ for Activation Retries
  // =========================================================================
  console.log('--- TEST SUITE 3: Task 8 [SEC-DROP-03] Exponential Backoff & DLQ ---');
  {
    assert.strictEqual(MAX_RETRIES, 5, 'MAX_RETRIES must be strictly 5');
    assert.deepStrictEqual(
      RETRY_DELAYS,
      [60_000, 300_000, 900_000, 3_600_000, 14_400_000],
      'Backoff delays must be [1m, 5m, 15m, 1h, 4h]'
    );

    assert.strictEqual(getRetryDelay(1), 60_000, 'Attempt 1 backoff must be 1m');
    assert.strictEqual(getRetryDelay(2), 300_000, 'Attempt 2 backoff must be 5m');
    assert.strictEqual(getRetryDelay(3), 900_000, 'Attempt 3 backoff must be 15m');
    assert.strictEqual(getRetryDelay(4), 3_600_000, 'Attempt 4 backoff must be 1h');
    assert.strictEqual(getRetryDelay(5), 14_400_000, 'Attempt 5 backoff must be 4h');

    // 3.1 In handleSupplierRetry, transient error on attempt 2 reschedules with delay 300_000
    const origOrderUpdateOne = Order.updateOne;
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    const origProductFindById = Product.findById;
    const origTransactionSave = Transaction.prototype.save;
    const origGetSupplierOrder = supplierManager.getSupplierOrder;
    const origFulfillSupplierOrder = supplierManager.fulfillSupplierOrder;

    try {
      let scheduledDelayMs = 0;
      let scheduledAttempt = 0;

      supplierManager.getSupplierOrder = async () => ({ success: false, error: 'ETIMEDOUT connection timed out' });
      supplierManager.fulfillSupplierOrder = async () => ({ success: false, error: 'ETIMEDOUT connection timed out' });

      Order.updateOne = async (filter, update) => {
        scheduledAttempt = update.$set.retryCount;
        scheduledDelayMs = update.$set.nextRetryAt.getTime() - Date.now();
        return { modifiedCount: 1 };
      };

      const testOrder = {
        _id: new mongoose.Types.ObjectId(),
        retryCount: 1, // currentAttempt becomes 2
        productId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
      };

      await handleSupplierRetry(testOrder, 'jaha', null);
      assert.strictEqual(scheduledAttempt, 2, 'Scheduled attempt must be 2');
      assert.ok(
        scheduledDelayMs >= 295_000 && scheduledDelayMs <= 305_000,
        `Delay for attempt 2 must be ~300000ms (got ${scheduledDelayMs})`
      );

      // 3.2 Exhausted retries (attempt 5): fails order and calls failOrderWithRefund
      let refundCalledOrderId = null;
      let finalRefundReason = null;

      Order.findOneAndUpdate = async (filter, update) => {
        refundCalledOrderId = filter._id;
        finalRefundReason = update.$set?.activationResult || update.$set?.notes || '';
        return {
          _id: filter._id,
          productId: testOrder.productId,
          userId: testOrder.userId,
          price: 5.0,
          status: 'failed',
        };
      };

      User.findOneAndUpdate = async () => ({
        _id: testOrder.userId,
        telegramId: 123456,
        balance: 15.0,
      });

      Product.findById = async () => ({
        _id: testOrder.productId,
        name: 'Jaha VPN Item',
      });

      Transaction.prototype.save = async function () {
        return this;
      };

      const exhaustedOrder = {
        _id: new mongoose.Types.ObjectId(),
        retryCount: 4, // currentAttempt becomes 5 -> exhausted!
        productId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
      };

      const botMock = {
        telegram: {
          sendMessage: async () => {},
        },
      };

      await handleSupplierRetry(exhaustedOrder, 'jaha', botMock);
      assert.strictEqual(String(refundCalledOrderId), String(exhaustedOrder._id), 'failOrderWithRefund must be called for exhausted order');
      assert.ok(finalRefundReason.includes('5 попыток'), 'Reason must indicate 5 attempts exhausted');

      console.log('  ✅ Test 3 Passed: Exponential backoff schedule and DLQ refund on 5th attempt verified.');
    } finally {
      Order.updateOne = origOrderUpdateOne;
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
      User.findOneAndUpdate = origUserFindOneAndUpdate;
      Product.findById = origProductFindById;
      Transaction.prototype.save = origTransactionSave;
      supplierManager.getSupplierOrder = origGetSupplierOrder;
      supplierManager.fulfillSupplierOrder = origFulfillSupplierOrder;
    }
  }

  // =========================================================================
  // TEST SUITE 4: Task 9 [SEC-DROP-04] Idempotency & Order Status Check on Supplier Timeout
  // =========================================================================
  console.log('--- TEST SUITE 4: Task 9 [SEC-DROP-04] Idempotency & Order Status Check ---');
  {
    const origGetSupplierOrder = supplierManager.getSupplierOrder;
    const origFulfillSupplierOrder = supplierManager.fulfillSupplierOrder;
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;

    try {
      let getSupplierOrderKey = null;
      let fulfillCalled = false;
      let completedDelivery = null;

      const testOrderId = new mongoose.Types.ObjectId();
      const idempotencyKey = `ord-${testOrderId}`;

      // Simulate timeout occurred previously: supplier has the order under the external key
      supplierManager.getSupplierOrder = async (provider, key) => {
        getSupplierOrderKey = key;
        return {
          success: true,
          orderNumber: 'JAHA-889900',
          deliveryData: 'account:password:token',
          status: 'completed',
        };
      };

      supplierManager.fulfillSupplierOrder = async () => {
        fulfillCalled = true;
        return { success: false };
      };

      Order.findOneAndUpdate = () => ({
        populate: () => ({
          populate: async () => ({
            _id: testOrderId,
            userId: { telegramId: 999888, language: 'ru' },
            productId: { name: 'Jaha VPN' },
          }),
        }),
      });

      const orderWithTimeout = {
        _id: testOrderId,
        supplierOrderId: null, // missing because timeout occurred before saving
        supplierIdempotencyKey: idempotencyKey,
        retryCount: 0,
        productId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
      };

      await handleSupplierRetry(orderWithTimeout, 'jaha', { telegram: { sendMessage: async () => {} } });

      assert.strictEqual(
        getSupplierOrderKey,
        idempotencyKey,
        'Must check supplier order using idempotency key before fulfilling'
      );
      assert.strictEqual(
        fulfillCalled,
        false,
        'fulfillSupplierOrder must NOT be called if order already exists on supplier'
      );

      console.log('  ✅ Test 4 Passed: Status checked using external key before re-ordering.');
    } finally {
      supplierManager.getSupplierOrder = origGetSupplierOrder;
      supplierManager.fulfillSupplierOrder = origFulfillSupplierOrder;
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
    }
  }

  // =========================================================================
  // TEST SUITE 5: Task 10 [SEC-CAT-05] Pagination in Referral Reconcile Cron
  // =========================================================================
  console.log('--- TEST SUITE 5: Task 10 [SEC-CAT-05] Keyset Pagination in Referral Reconcile ---');
  {
    const origUserFind = User.find;
    const queriedFilters = [];
    const processedUserIds = [];

    // Mock 250 users across 3 batches (100, 100, 50)
    const allUsers = Array.from({ length: 250 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(i.toString(16).padStart(24, '0')),
    }));

    User.find = (filter) => {
      queriedFilters.push(filter);
      return {
        sort: () => ({
          select: () => ({
            limit: (limitCount) => ({
              lean: async () => {
                let filtered = allUsers;
                if (filter._id && filter._id.$gt) {
                  filtered = filtered.filter((u) => String(u._id) > String(filter._id.$gt));
                }
                return filtered.slice(0, limitCount);
              },
            }),
          }),
        }),
      };
    };

    // Mock grantReferralBonusForFirstCompletedOrder recorder
    const origOrderFindOne = Order.findOne;
    Order.findOne = async () => null;

    try {
      await reconcileReferralBonuses();

      assert.strictEqual(queriedFilters.length, 3, 'Must paginate across exactly 3 batches for 250 users');
      assert.strictEqual(queriedFilters[0]._id, undefined, 'First batch starts without $gt');
      assert.ok(queriedFilters[1]._id && queriedFilters[1]._id.$gt, 'Second batch uses $gt from batch 1 lastId');
      assert.ok(queriedFilters[2]._id && queriedFilters[2]._id.$gt, 'Third batch uses $gt from batch 2 lastId');

      console.log('  ✅ Test 5 Passed: Keyset pagination with limit(100) batches verified.');
    } finally {
      User.find = origUserFind;
      Order.findOne = origOrderFindOne;
    }
  }

  // =========================================================================
  // TEST SUITE 6: Task 11 [SEC-CAT-06] Zero-Division & Sanity Protection in Smart Markdown
  // =========================================================================
  console.log('--- TEST SUITE 6: Task 11 [SEC-CAT-06] Zero-Division & Sanity Protection ---');
  {
    const origSettingsFindOne = Settings.findOne;

    try {
      // 6.1 autoMarkdownDays = 0, autoMarkdownPercent = 150 (division by zero / percent > 99)
      Settings.findOne = () => ({
        lean: async () => ({
          autoMarkdownEnabled: true,
          autoMarkdownDays: 0, // dangerous 0
          autoMarkdownPercent: 150, // dangerous > 100
        }),
      });

      const product = {
        price: 20.0,
        costPrice: 5.0,
        lastSoldAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      };

      const safePrice = await getEffectivePrice(product, 10, null, { qty: 0 });
      assert.ok(Number.isFinite(safePrice), 'Price must be a finite number');
      assert.ok(safePrice >= 5.0, 'Price must not drop below costLimit');
      assert.ok(safePrice <= 20.0, 'Price must not exceed initial retail price');

      // 6.2 Future lastSoldAt (clock skew protection)
      const futureProduct = {
        price: 15.0,
        costPrice: 2.0,
        lastSoldAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000), // in the future
      };

      const futurePrice = await getEffectivePrice(futureProduct, 10, null, { qty: -5 });
      assert.strictEqual(futurePrice, 15.0, 'Future lastSoldAt must not produce negative markdown');

      // 6.3 Corrupted / NaN settings
      Settings.findOne = () => ({
        lean: async () => ({
          autoMarkdownEnabled: true,
          autoMarkdownDays: 'invalid',
          autoMarkdownPercent: NaN,
        }),
      });

      const nanPrice = await getEffectivePrice(product, 10, null, {});
      assert.strictEqual(nanPrice, 20.0, 'Invalid / NaN settings must safely default without modifying price');

      console.log('  ✅ Test 6 Passed: Zero-division, clamped days/percent, and negative qty protected.');
    } finally {
      Settings.findOne = origSettingsFindOne;
    }
  }

  // =========================================================================
  // TEST SUITE 7: Task 12 [SEC-DROP-06] Preserve Custom Supplier Margins on Key Update
  // =========================================================================
  console.log('--- TEST SUITE 7: Task 12 [SEC-DROP-06] Preserve Custom Supplier Margins ---');
  {
    const origSupplierConfigFindOneAndUpdate = SupplierConfig.findOneAndUpdate;
    let capturedUpdateDoc = null;

    SupplierConfig.findOneAndUpdate = async (filter, update, options) => {
      capturedUpdateDoc = update;
      return { supplierId: filter.supplierId, ...update.$set };
    };

    try {
      // 7.1 Key update without margin arguments must NOT touch existing margins in $set
      await supplierManager.saveSupplierKey('jaha', 'new_secret_key_123');

      assert.strictEqual(capturedUpdateDoc.$set.apiKey, 'new_secret_key_123');
      assert.strictEqual(
        capturedUpdateDoc.$set.marginPercent,
        undefined,
        'marginPercent must NOT be present in $set when not explicitly passed'
      );
      assert.strictEqual(
        capturedUpdateDoc.$set.marginFixed,
        undefined,
        'marginFixed must NOT be present in $set when not explicitly passed'
      );
      assert.strictEqual(
        capturedUpdateDoc.$setOnInsert.marginPercent,
        30,
        '$setOnInsert must supply default marginPercent (30) for new documents only'
      );
      assert.strictEqual(
        capturedUpdateDoc.$setOnInsert.marginFixed,
        0,
        '$setOnInsert must supply default marginFixed (0) for new documents only'
      );

      // 7.2 Explicitly passing custom margin sets it in $set and omits it from $setOnInsert (no conflict)
      await supplierManager.saveSupplierKey('jaha', 'new_key', 45, 1.5);
      assert.strictEqual(capturedUpdateDoc.$set.marginPercent, 45, 'Custom marginPercent must be updated');
      assert.strictEqual(capturedUpdateDoc.$set.marginFixed, 1.5, 'Custom marginFixed must be updated');
      assert.strictEqual(
        capturedUpdateDoc.$setOnInsert,
        undefined,
        'When all margins are in $set, $setOnInsert must be omitted to prevent MongoDB path conflict'
      );

      console.log('  ✅ Test 7 Passed: Custom margins preserved on key update and conflict-free upsert.');
    } finally {
      SupplierConfig.findOneAndUpdate = origSupplierConfigFindOneAndUpdate;
    }
  }

  // =========================================================================
  // TEST SUITE 8: Task 13 [SEC-DROP-07] Dropshipping Pre-orders Auto-Purchase
  // =========================================================================
  console.log('--- TEST SUITE 8: Task 13 [SEC-DROP-07] Dropshipping Pre-orders Auto-Purchase ---');
  {
    const origOrderFind = Order.find;
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    const origOrderUpdateOne = Order.updateOne;
    const origWaitlistFindOneAndDelete = Waitlist.findOneAndDelete;
    const origFulfillSupplierOrder = supplierManager.fulfillSupplierOrder;

    try {
      const jahaProduct = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Jaha ChatGPT Plus',
        provider: 'jaha',
        type: 'account',
      };

      const preorderId = new mongoose.Types.ObjectId();
      const buyerId = new mongoose.Types.ObjectId();

      Order.find = () => ({
        sort: () => ({
          populate: async () => [
            {
              _id: preorderId,
              productId: jahaProduct._id,
              qty: 1,
              status: 'preorder_pending',
              supplierIdempotencyKey: `ord-${preorderId}`,
              userId: { _id: buyerId, telegramId: 777666, language: 'ru' },
            },
          ],
        }),
      });

      let preorderClaimedStatus = null;
      let waitlistDeleted = false;
      let supplierFulfillCalled = false;
      let finalOrderUpdate = null;

      Order.findOneAndUpdate = async (filter, update) => {
        if (String(filter._id) === String(preorderId) && filter.status === 'preorder_pending') {
          preorderClaimedStatus = update.$set.status;
          return { _id: preorderId, status: preorderClaimedStatus };
        }
        return null;
      };

      Waitlist.findOneAndDelete = async () => {
        waitlistDeleted = true;
        return { ok: 1 };
      };

      supplierManager.fulfillSupplierOrder = async (prod, qty, user, opts) => {
        supplierFulfillCalled = true;
        assert.strictEqual(String(opts.orderId), String(preorderId));
        return {
          success: true,
          deliveryData: 'user:pass:delivered',
          orderNumber: 'JAHA-PRE-112233',
        };
      };

      Order.updateOne = async (filter, update) => {
        finalOrderUpdate = update.$set;
        return { modifiedCount: 1 };
      };

      await notif.fulfillPreorders(jahaProduct);

      assert.strictEqual(
        preorderClaimedStatus,
        'activating',
        'Preorder must transition preorder_pending -> activating'
      );
      assert.strictEqual(waitlistDeleted, true, 'Waitlist entry must be cleaned up');
      assert.strictEqual(supplierFulfillCalled, true, 'fulfillSupplierOrder must be called for Jaha dropship item');
      assert.strictEqual(finalOrderUpdate.status, 'completed', 'Order must be completed upon instant delivery');
      assert.strictEqual(finalOrderUpdate.deliveryData, 'user:pass:delivered');
      assert.strictEqual(finalOrderUpdate.supplierOrderId, 'JAHA-PRE-112233');

      console.log('  ✅ Test 8 Passed: Dropshipping preorder auto-fulfillment verified.');
    } finally {
      Order.find = origOrderFind;
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
      Order.updateOne = origOrderUpdateOne;
      Waitlist.findOneAndDelete = origWaitlistFindOneAndDelete;
      supplierManager.fulfillSupplierOrder = origFulfillSupplierOrder;
    }
  }

  // =========================================================================
  // TEST SUITE 9: Task 22 [SEC-CAT-07] Waitlist Cleanup on Pre-Order Cancellation
  // =========================================================================
  console.log('--- TEST SUITE 9: Task 22 [SEC-CAT-07] Waitlist Cleanup on Pre-Order Cancellation ---');
  {
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    const origOrderFindById = Order.findById;
    const origWaitlistFindOneAndDelete = Waitlist.findOneAndDelete;
    const origUserUpdateOne = User.updateOne;
    const origTransactionSave = Transaction.prototype.save;

    try {
      const testOrderId = new mongoose.Types.ObjectId();
      const testProductId = new mongoose.Types.ObjectId();
      const testUserId = new mongoose.Types.ObjectId();

      let waitlistCleanupCalled = false;
      let cleanedUserId = null;
      let cleanedProductId = null;

      Order.findOneAndUpdate = () => ({
        populate: async () => ({
          _id: testOrderId,
          price: 10.0,
          productId: { _id: testProductId },
        }),
      });

      Order.findById = () => ({
        populate: () => ({
          populate: () => ({
            populate: async () => null,
          }),
        }),
      });

      User.updateOne = async () => ({ modifiedCount: 1 });
      Transaction.prototype.save = async function () { return this; };

      Waitlist.findOneAndDelete = async (filter) => {
        waitlistCleanupCalled = true;
        cleanedUserId = filter.userId;
        cleanedProductId = filter.productId;
        return { ok: 1 };
      };

      const ctxMock = {
        user: { _id: testUserId, balance: 5.0, totalSpent: 10.0, language: 'ru' },
        answerCbQuery: async () => {},
      };

      await profileScene.cancelPreorder(ctxMock, testOrderId);

      assert.strictEqual(waitlistCleanupCalled, true, 'Waitlist.findOneAndDelete must be called in cancelPreorder');
      assert.strictEqual(String(cleanedUserId), String(testUserId), 'Must clean waitlist for user._id');
      assert.strictEqual(String(cleanedProductId), String(testProductId), 'Must clean waitlist for productId');

      console.log('  ✅ Test 9 Passed: Waitlist entry deleted upon preorder cancellation.');
    } finally {
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
      Order.findById = origOrderFindById;
      Waitlist.findOneAndDelete = origWaitlistFindOneAndDelete;
      User.updateOne = origUserUpdateOne;
      Transaction.prototype.save = origTransactionSave;
    }
  }

  // Restore global mocks
  achievementsService.checkAndGrantAchievements = origCheckAndGrant;
  Order.countDocuments = origOrderCountDocuments;
  Order.distinct = origOrderDistinct;
  User.findOne = origUserFindOne;
  Key.updateMany = origKeyUpdateMany;
  Key.updateOne = origKeyUpdateOne;
  User.updateOne = origUserUpdateOne;

  console.log('\n🎉 ALL 9 CATALOG, DROPSHIPPING, PRE-ORDERS & CRONS TASKS VERIFIED SUCCESSFULLY! 🚀');
}

runMilestone3Tests().catch((err) => {
  console.error('\n❌ Milestone 3 test failed:', err);
  process.exit(1);
});

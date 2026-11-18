/**
 * scripts/test_bybit_uid_engine.js
 *
 * Comprehensive Automated Test Suite for Bybit UID Payment Engine:
 * - Model: BybitInvoice schema, indexes, getters, setters
 * - Service: allocateUniqueAmount, createInvoice, cancelInvoice, checkInvoice
 * - Fulfillment: Topup balance credit, Order key allocation, GPT activation token prompt
 * - Security: Double spend prevention (BybitInvoice & TopupRequest), duplicate exactAmount collision avoidance
 * - Cron: bybitUidPoller auto-expiry and pending poller
 */

const assert = require('assert');
const mongoose = require('mongoose');

const BybitInvoice = require('../src/models/BybitInvoice');
const TopupRequest = require('../src/models/TopupRequest');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');
const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const Settings = require('../src/models/Settings');

const bybitUidPaymentService = require('../src/services/bybitUidPayment.service');
const bybitUidPoller = require('../src/cron/bybitUidPoller.cron');
const cronIndex = require('../src/cron/index');

async function runTestSuite() {
  console.log('🧪 Starting Bybit UID Payment Engine Test Suite...\n');

  // =========================================================================
  // Test 1: BybitInvoice Schema, Fields, and Indexes
  // =========================================================================
  console.log('Test 1: BybitInvoice Schema and Index Verification');
  const paths = BybitInvoice.schema.paths;

  assert(paths.invoiceNumber, 'invoiceNumber field must exist');
  assert.strictEqual(paths.invoiceNumber.instance, 'String');
  assert.strictEqual(paths.invoiceNumber.options.unique, true, 'invoiceNumber must be unique');

  assert(paths.userId, 'userId field must exist');
  assert.strictEqual(paths.userId.instance.toLowerCase(), 'objectid');
  assert.strictEqual(paths.userId.options.ref, 'User');
  assert.strictEqual(paths.userId.isRequired, true);

  assert(paths.orderId, 'orderId field must exist');
  assert.strictEqual(paths.orderId.instance.toLowerCase(), 'objectid');
  assert.strictEqual(paths.orderId.options.ref, 'Order');

  assert(paths.productId, 'productId field must exist');
  assert.strictEqual(paths.productId.instance.toLowerCase(), 'objectid');
  assert.strictEqual(paths.productId.options.ref, 'Product');

  assert(paths.qty, 'qty field must exist');
  assert.strictEqual(paths.qty.instance, 'Number');
  assert.strictEqual(paths.qty.defaultValue, 1);

  assert(paths.baseAmount, 'baseAmount field must exist');
  assert.strictEqual(paths.baseAmount.instance, 'Number');
  assert.strictEqual(paths.baseAmount.isRequired, true);

  assert(paths.exactAmount, 'exactAmount field must exist');
  assert.strictEqual(paths.exactAmount.instance, 'Number');
  assert.strictEqual(paths.exactAmount.isRequired, true);

  assert(paths.suffix, 'suffix field must exist');
  assert.strictEqual(paths.suffix.instance, 'Number');
  assert.strictEqual(paths.suffix.isRequired, true);

  assert(paths.adminUid, 'adminUid field must exist');
  assert.strictEqual(paths.adminUid.instance, 'String');
  assert.strictEqual(paths.adminUid.isRequired, true);

  assert(paths.status, 'status field must exist');
  assert.strictEqual(paths.status.instance, 'String');
  assert.deepStrictEqual(paths.status.enumValues, ['pending', 'completed', 'cancelled', 'expired']);
  assert.strictEqual(paths.status.defaultValue, 'pending');

  assert(paths.txId, 'txId field must exist');
  assert.strictEqual(paths.txId.instance, 'String');

  assert(paths.expiresAt, 'expiresAt field must exist');
  assert.strictEqual(paths.expiresAt.instance, 'Date');
  assert.strictEqual(paths.expiresAt.isRequired, true);

  assert(paths.createdAt, 'createdAt field must exist');
  assert.strictEqual(paths.createdAt.instance, 'Date');

  assert(paths.completedAt, 'completedAt field must exist');
  assert.strictEqual(paths.completedAt.instance, 'Date');

  // Verify indexes
  const indexes = BybitInvoice.schema.indexes();
  const hasExactAmountIndex = indexes.some(([spec]) => spec.exactAmount === 1);
  assert(hasExactAmountIndex, 'Index on exactAmount must exist for fast lookup');

  const hasStatusExpiresAtIndex = indexes.some(([spec]) => spec.status === 1 && spec.expiresAt === 1);
  assert(hasStatusExpiresAtIndex, 'Index on { status: 1, expiresAt: 1 } must exist for poller');

  // Test suffix setter and virtual getter
  const testDoc1 = new BybitInvoice({
    invoiceNumber: 'TEST-1',
    userId: new mongoose.Types.ObjectId(),
    baseAmount: 15.0,
    exactAmount: 15.0038,
    suffix: 38,
    adminUid: '547343159',
    expiresAt: new Date(),
  });
  assert.strictEqual(testDoc1.suffix, 38);
  assert.strictEqual(testDoc1.suffixFractional, 0.0038);

  const testDoc2 = new BybitInvoice({
    invoiceNumber: 'TEST-2',
    userId: new mongoose.Types.ObjectId(),
    baseAmount: 20.0,
    exactAmount: 20.0055,
    suffix: 0.0055, // passed as fraction, setter converts to integer 55
    adminUid: '547343159',
    expiresAt: new Date(),
  });
  assert.strictEqual(testDoc2.suffix, 55, 'Setter must convert fractional suffix (0.0055) to integer (55)');
  assert.strictEqual(testDoc2.suffixFractional, 0.0055);

  console.log('  ✅ Test 1 Passed: Schema, field types, defaults, and indexes validated.\n');

  // =========================================================================
  // Test 2: allocateUniqueAmount
  // =========================================================================
  console.log('Test 2: allocateUniqueAmount logic & collision avoidance');
  const origInvoiceFind = BybitInvoice.find;

  try {
    // 2a. With no occupied amounts
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });

    const alloc1 = await bybitUidPaymentService.allocateUniqueAmount(15.0);
    assert(alloc1.suffix >= 10 && alloc1.suffix <= 99, 'Suffix must be between 10 and 99');
    assert(
      alloc1.suffixFractional >= 0.0010 && alloc1.suffixFractional <= 0.0099,
      'Fractional suffix must be between 0.0010 and 0.0099'
    );
    assert.strictEqual(
      alloc1.exactAmount,
      Number((15.0 + alloc1.suffixFractional).toFixed(4)),
      'exactAmount must equal baseAmount + suffixFractional'
    );
    assert.strictEqual(Number(alloc1), alloc1.exactAmount, 'Object must coerce to exactAmount number');

    // 2b. Collision avoidance: simulate 89 suffixes already occupied, only suffix 38 available
    const occupiedRows = [];
    for (let s = 10; s <= 99; s += 1) {
      if (s !== 38) {
        occupiedRows.push({
          suffix: s,
          exactAmount: Number((15.0 + s / 10000).toFixed(4)),
        });
      }
    }

    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => occupiedRows,
      }),
    });

    const alloc2 = await bybitUidPaymentService.allocateUniqueAmount(15.0);
    assert.strictEqual(alloc2.suffix, 38, 'Must pick the only available unique suffix 38');
    assert.strictEqual(alloc2.exactAmount, 15.0038);

    // 2c. All 90 occupied -> throws error
    occupiedRows.push({ suffix: 38, exactAmount: 15.0038 });
    let errorThrown = false;
    try {
      await bybitUidPaymentService.allocateUniqueAmount(15.0);
    } catch (err) {
      errorThrown = true;
      assert(err.message.includes('Все уникальные суммы'), 'Must throw descriptive error');
    }
    assert(errorThrown, 'Must throw error when all unique suffixes are allocated');
  } finally {
    BybitInvoice.find = origInvoiceFind;
  }
  console.log('  ✅ Test 2 Passed: allocateUniqueAmount correctly avoids collisions.\n');

  // =========================================================================
  // Test 3: createInvoice & Admin UID Fallback
  // =========================================================================
  console.log('Test 3: createInvoice & Admin UID Resolution');
  const origCountDocuments = BybitInvoice.countDocuments;
  const origExists = BybitInvoice.exists;
  const origInvoiceFind2 = BybitInvoice.find;
  const origSettingsFindOne = Settings.findOne;

  try {
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });
    BybitInvoice.countDocuments = async () => 1975;
    BybitInvoice.exists = async () => false;

    // Test 3a: Fallback to process.env.BYBIT_UID || '547343159'
    Settings.findOne = () => ({
      lean: async () => null,
    });

    const userId = new mongoose.Types.ObjectId();
    let savedDoc = null;
    const origSave = BybitInvoice.prototype.save;
    BybitInvoice.prototype.save = async function () {
      savedDoc = this;
      return this;
    };

    const invoiceTopup = await bybitUidPaymentService.createInvoice({
      userId,
      baseAmount: 15.0,
    });

    assert.strictEqual(invoiceTopup.invoiceNumber, 'TOP-00001976', 'Count 1975 should produce TOP-00001976');
    assert.strictEqual(invoiceTopup.adminUid, '547343159', 'Admin UID fallback should be 547343159');
    assert.strictEqual(invoiceTopup.status, 'pending');
    assert.strictEqual(invoiceTopup.baseAmount, 15.0);
    assert(invoiceTopup.expiresAt.getTime() > Date.now() + 14 * 60 * 1000, 'expiresAt must be ~15 mins');

    // Test 3b: Order-related invoice gets ORD- prefix
    const productId = new mongoose.Types.ObjectId();
    BybitInvoice.countDocuments = async () => 42;
    const invoiceOrder = await bybitUidPaymentService.createInvoice({
      userId,
      productId,
      qty: 2,
      baseAmount: 30.0,
      adminUid: '999888777', // custom override
    });

    assert.strictEqual(invoiceOrder.invoiceNumber, 'ORD-00000043');
    assert.strictEqual(invoiceOrder.adminUid, '999888777');
    assert.strictEqual(invoiceOrder.productId.toString(), productId.toString());
    assert.strictEqual(invoiceOrder.qty, 2);

    BybitInvoice.prototype.save = origSave;
  } finally {
    BybitInvoice.countDocuments = origCountDocuments;
    BybitInvoice.exists = origExists;
    BybitInvoice.find = origInvoiceFind2;
    Settings.findOne = origSettingsFindOne;
  }
  console.log('  ✅ Test 3 Passed: createInvoice prefixes, sequencing, and UID fallback verified.\n');

  // =========================================================================
  // Test 4: cancelInvoice
  // =========================================================================
  console.log('Test 4: cancelInvoice functionality');
  const origFindOne = BybitInvoice.findOne;

  try {
    let mockInvoice = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      status: 'pending',
      save: async function () {
        return this;
      },
    };

    BybitInvoice.findOne = async () => mockInvoice;

    const resCancel = await bybitUidPaymentService.cancelInvoice(mockInvoice._id, mockInvoice.userId);
    assert.strictEqual(resCancel.status, 'cancelled');

    // Trying to cancel completed invoice must fail
    mockInvoice.status = 'completed';
    let cancelCompletedFailed = false;
    try {
      await bybitUidPaymentService.cancelInvoice(mockInvoice._id);
    } catch (err) {
      cancelCompletedFailed = true;
      assert(err.message.includes('Cannot cancel completed invoice'));
    }
    assert(cancelCompletedFailed, 'Must prevent cancelling completed invoice');
  } finally {
    BybitInvoice.findOne = origFindOne;
  }
  console.log('  ✅ Test 4 Passed: cancelInvoice status and guards verified.\n');

  // =========================================================================
  // Test 5: checkInvoice - Topup Matching & Double Spend Protection
  // =========================================================================
  console.log('Test 5: checkInvoice - Topup fulfillment & double spend protection');
  const origInvoiceFindById = BybitInvoice.findById;
  const origTopupFindOne = TopupRequest.findOne;
  const origInvoiceFindOne = BybitInvoice.findOne;
  const origUserFindById = User.findById;
  const origUserUpdateOne = User.updateOne;
  const origTopupSave = TopupRequest.prototype.save;
  const origTxSave = Transaction.prototype.save;

  try {
    const testUserId = new mongoose.Types.ObjectId();
    const testInvoice = new BybitInvoice({
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: 'TOP-00000010',
      userId: testUserId,
      baseAmount: 15.0,
      exactAmount: 15.0038,
      suffix: 38,
      adminUid: '547343159',
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    testInvoice.save = async function () {
      return this;
    };

    BybitInvoice.findById = async () => testInvoice;

    // Mock User
    let updatedBalanceInc = 0;
    User.updateOne = async (filter, update) => {
      assert.strictEqual(filter._id.toString(), testUserId.toString());
      updatedBalanceInc = update.$inc.balance;
      return { matchedCount: 1, modifiedCount: 1 };
    };

    const mockTelegramMessages = [];
    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text, opts) => {
          mockTelegramMessages.push({ chatId, text, opts });
          return true;
        },
      },
    };

    User.findById = async () => ({
      _id: testUserId,
      telegramId: 123456789,
      language: 'ru',
    });

    let savedTopup = null;
    TopupRequest.prototype.save = async function () {
      savedTopup = this;
      return this;
    };

    Transaction.prototype.save = async function () {
      return this;
    };

    // Scenario 5a: Double spend detection
    // Suppose txId 'tx-existing-123' already exists in TopupRequest
    TopupRequest.findOne = async (query) => {
      const q = query.$or ? query.$or[0].txid : query.txid;
      if (q === 'tx-existing-123') return { _id: 'topup_already_exists' };
      return null;
    };
    BybitInvoice.findOne = async () => null;

    const mockRecordsDoubleSpend = [
      {
        id: 'rec-1',
        txID: 'tx-existing-123',
        coin: 'USDT',
        amount: '15.0038',
        status: 2,
      },
    ];

    const doubleSpendRes = await bybitUidPaymentService.checkInvoice(testInvoice._id, {
      bot: mockBot,
      mockRecords: mockRecordsDoubleSpend,
    });
    assert.strictEqual(doubleSpendRes.success, false);
    assert(doubleSpendRes.reason.includes('double spend'), 'Must reject double spent txId');
    assert.strictEqual(testInvoice.status, 'pending', 'Invoice status must remain pending');

    // Scenario 5b: Valid unspent matching deposit record
    const mockRecordsValid = [
      {
        id: 'rec-2',
        txID: 'tx-new-999',
        coin: 'USDT',
        amount: '15.0038',
        status: 2,
      },
    ];

    const validRes = await bybitUidPaymentService.checkInvoice(testInvoice._id, {
      bot: mockBot,
      mockRecords: mockRecordsValid,
    });

    assert.strictEqual(validRes.success, true);
    assert.strictEqual(testInvoice.status, 'completed');
    assert.strictEqual(testInvoice.txId, 'tx-new-999');
    assert(testInvoice.completedAt instanceof Date);

    assert.strictEqual(updatedBalanceInc, 15.0, 'User balance must be incremented by baseAmount');
    assert(savedTopup, 'TopupRequest must be saved');
    assert.strictEqual(savedTopup.status, 'confirmed');
    assert.strictEqual(savedTopup.txid, 'tx-new-999');
    assert.strictEqual(savedTopup.amount, 15.0);

    assert.strictEqual(mockTelegramMessages.length, 1);
    assert(mockTelegramMessages[0].text.includes('TOP-00000010'));
    assert(mockTelegramMessages[0].text.includes('15 USDT'));
    assert(mockTelegramMessages[0].text.includes('tx-new-999'));
  } finally {
    BybitInvoice.findById = origInvoiceFindById;
    TopupRequest.findOne = origTopupFindOne;
    BybitInvoice.findOne = origInvoiceFindOne;
    User.findById = origUserFindById;
    User.updateOne = origUserUpdateOne;
    TopupRequest.prototype.save = origTopupSave;
    Transaction.prototype.save = origTxSave;
  }
  console.log('  ✅ Test 5 Passed: Topup matching, double spend protection & Telegram alert verified.\n');

  // =========================================================================
  // Test 6: checkInvoice - Order Fulfillment (Auto-Key Reservation & Delivery)
  // =========================================================================
  console.log('Test 6: checkInvoice - Order fulfillment with auto-key delivery');
  const origInvoiceFindById2 = BybitInvoice.findById;
  const origProductFindById = Product.findById;
  const origKeyFindOneAndUpdate = Key.findOneAndUpdate;
  const origKeyUpdateOne = Key.updateOne;
  const origOrderSave = Order.prototype.save;
  const origUserFindById2 = User.findById;
  const origTxSave2 = Transaction.prototype.save;

  try {
    Transaction.prototype.save = async function () {
      return this;
    };
    const testUserId = new mongoose.Types.ObjectId();
    const testProductId = new mongoose.Types.ObjectId();

    const orderInvoice = new BybitInvoice({
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: 'ORD-00000055',
      userId: testUserId,
      productId: testProductId,
      qty: 1,
      baseAmount: 25.0,
      exactAmount: 25.0042,
      suffix: 42,
      adminUid: '547343159',
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    orderInvoice.save = async function () {
      return this;
    };

    BybitInvoice.findById = async () => orderInvoice;
    TopupRequest.findOne = async () => null;
    BybitInvoice.findOne = async () => null;

    Product.findById = async () => ({
      _id: testProductId,
      name: 'ChatGPT Plus Key 1 Month',
      type: 'key',
      provider: 'local',
      costPrice: 20.0,
    });

    const mockKeyId = new mongoose.Types.ObjectId();
    let keyAllocated = false;
    Key.findOneAndUpdate = async () => {
      keyAllocated = true;
      return {
        _id: mockKeyId,
        productId: testProductId,
        value: 'SECRET-KEY-ABC-123-XYZ',
        isUsed: true,
      };
    };

    Key.updateOne = async () => ({ modifiedCount: 1 });
    Product.updateOne = async () => ({ modifiedCount: 1 });

    let createdOrder = null;
    Order.prototype.save = async function () {
      createdOrder = this;
      return this;
    };

    const mockTelegramMessages = [];
    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text, opts) => {
          mockTelegramMessages.push({ chatId, text, opts });
          return true;
        },
      },
    };

    User.findById = async () => ({
      _id: testUserId,
      telegramId: 987654321,
      language: 'ru',
    });

    const mockRecords = [
      {
        id: 'rec-order-1',
        txID: 'tx-order-key-777',
        coin: 'USDT',
        amount: '25.0042',
        status: 2,
      },
    ];

    const orderRes = await bybitUidPaymentService.checkInvoice(orderInvoice._id, {
      bot: mockBot,
      mockRecords,
    });

    assert.strictEqual(orderRes.success, true);
    assert.strictEqual(orderInvoice.status, 'completed');
    assert.strictEqual(orderInvoice.txId, 'tx-order-key-777');
    assert(keyAllocated, 'Key must be allocated from stock via Key.findOneAndUpdate');

    assert(createdOrder, 'Order must be created');
    assert.strictEqual(createdOrder.status, 'completed');
    assert.strictEqual(createdOrder.keyId.toString(), mockKeyId.toString());
    assert.strictEqual(createdOrder.deliveryData, 'SECRET-KEY-ABC-123-XYZ');

    assert.strictEqual(mockTelegramMessages.length, 1);
    assert(mockTelegramMessages[0].text.includes('ChatGPT Plus Key 1 Month'));
    assert(mockTelegramMessages[0].text.includes('SECRET-KEY-ABC-123-XYZ'));
    assert(mockTelegramMessages[0].text.includes('tx-order-key-777'));
  } finally {
    BybitInvoice.findById = origInvoiceFindById2;
    Product.findById = origProductFindById;
    Key.findOneAndUpdate = origKeyFindOneAndUpdate;
    Key.updateOne = origKeyUpdateOne;
    Order.prototype.save = origOrderSave;
    User.findById = origUserFindById2;
    Transaction.prototype.save = origTxSave2;
  }
  console.log('  ✅ Test 6 Passed: Auto-key reservation and instant digital delivery verified.\n');

  // =========================================================================
  // Test 7: checkInvoice - Order Fulfillment (GPT Activation awaiting_token)
  // =========================================================================
  console.log('Test 7: checkInvoice - Order fulfillment for GPT activation product');
  const origInvoiceFindByIdGpt = BybitInvoice.findById;
  const origProductFindByIdGpt = Product.findById;
  const origOrderSaveGpt = Order.prototype.save;
  const origUserFindByIdGpt = User.findById;
  const origTxSaveGpt = Transaction.prototype.save;

  try {
    const testUserId = new mongoose.Types.ObjectId();
    const testProductId = new mongoose.Types.ObjectId();

    const gptInvoice = new BybitInvoice({
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: 'ORD-00000088',
      userId: testUserId,
      productId: testProductId,
      qty: 1,
      baseAmount: 35.0,
      exactAmount: 35.0088,
      suffix: 88,
      adminUid: '547343159',
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    gptInvoice.save = async function () {
      return this;
    };

    BybitInvoice.findById = async () => gptInvoice;
    TopupRequest.findOne = async () => null;
    BybitInvoice.findOne = async () => null;

    Product.findById = async () => ({
      _id: testProductId,
      name: 'ChatGPT Team Plan Activation',
      type: 'gpt_activation',
      provider: 'u1traby',
      costPrice: 28.0,
    });

    let gptCreatedOrder = null;
    Order.prototype.save = async function () {
      gptCreatedOrder = this;
      return this;
    };
    Transaction.prototype.save = async function () {
      return this;
    };

    const gptTelegramMessages = [];
    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text, opts) => {
          gptTelegramMessages.push({ chatId, text, opts });
          return true;
        },
      },
    };

    User.findById = async () => ({
      _id: testUserId,
      telegramId: 111222333,
      language: 'ru',
    });

    const mockRecords = [
      {
        id: 'rec-gpt-1',
        txID: 'tx-gpt-token-888',
        coin: 'USDT',
        amount: '35.0088',
        status: 2,
      },
    ];

    const gptRes = await bybitUidPaymentService.checkInvoice(gptInvoice._id, {
      bot: mockBot,
      mockRecords,
    });

    assert.strictEqual(gptRes.success, true);
    assert.strictEqual(gptInvoice.status, 'completed');
    assert.strictEqual(gptInvoice.txId, 'tx-gpt-token-888');

    assert(gptCreatedOrder, 'Order must be created for gpt_activation');
    assert.strictEqual(gptCreatedOrder.status, 'awaiting_token', 'Status must be awaiting_token');

    assert.strictEqual(gptTelegramMessages.length, 1);
    assert(gptTelegramMessages[0].text.includes('ChatGPT Team Plan Activation'));
    assert(gptTelegramMessages[0].text.includes('токен для активации'));
  } finally {
    BybitInvoice.findById = origInvoiceFindByIdGpt;
    Product.findById = origProductFindByIdGpt;
    Order.prototype.save = origOrderSaveGpt;
    User.findById = origUserFindByIdGpt;
    Transaction.prototype.save = origTxSaveGpt;
  }
  console.log('  ✅ Test 7 Passed: GPT activation status awaiting_token & token prompt verified.\n');

  // =========================================================================
  // Test 8: bybitUidPoller Cron - Auto-Expiry and Pending Polling
  // =========================================================================
  console.log('Test 8: bybitUidPoller Cron & Registration Verification');

  // Verify interval is 20s
  assert.strictEqual(bybitUidPoller.INTERVAL_MS, 20000, 'Poller interval must be 20,000 ms (20 seconds)');

  // Verify exported in cronIndex
  assert(cronIndex.bybitUidPoller, 'bybitUidPoller must be exported in src/cron/index.js');
  assert.strictEqual(typeof cronIndex.bybitUidPoller.start, 'function');

  // Test poll execution: auto-expiry
  const origUpdateMany = BybitInvoice.updateMany;
  const origInvoiceFind3 = BybitInvoice.find;
  let updateManyCalledWith = null;

  try {
    BybitInvoice.updateMany = async (filter, update) => {
      updateManyCalledWith = { filter, update };
      return { modifiedCount: 3 };
    };

    BybitInvoice.find = () => ({
      sort: () => [],
    });

    // Mock readyState = 1 (connected)
    const origReadyState = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

    await bybitUidPoller.poll();

    assert(updateManyCalledWith, 'updateMany must be called to expire stale invoices');
    assert.strictEqual(updateManyCalledWith.filter.status, 'pending');
    assert(updateManyCalledWith.filter.expiresAt.$lte instanceof Date);
    assert.strictEqual(updateManyCalledWith.update.$set.status, 'expired');

    Object.defineProperty(mongoose.connection, 'readyState', { value: origReadyState, configurable: true });
  } finally {
    BybitInvoice.updateMany = origUpdateMany;
    BybitInvoice.find = origInvoiceFind3;
  }

  console.log('  ✅ Test 8 Passed: Poller interval, auto-expiry, and cron exports verified.\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 100% Bybit UID Payment Engine Verified.\n');
}

runTestSuite().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});

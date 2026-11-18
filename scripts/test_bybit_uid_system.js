/**
 * scripts/test_bybit_uid_system.js
 *
 * Comprehensive end-to-end and unit verification of the Bybit UID Payment System:
 * 1. Checkout keyboard: Telegram Stars removed, Bybit UID button added with correct callback.
 * 2. Suffix allocation: 4-decimal unique amount generation, collision avoidance with active invoices.
 * 3. Card rendering: Exact UI layout matching user screenshot format, texts, code tags, and keyboard.
 * 4. Deposit matching: Correct amount matching, double-spend prevention (rejecting reused txIds).
 * 5. Invoice cancellation: Frees suffix, updates status to cancelled, prevents cancellation of completed bills.
 * 6. UI routes & callbacks: handleBybitUidPay, handleBybitUidCheck, handleBybitUidCancel.
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
const shopScene = require('../src/bot/scenes/shop.scene');
const bybitUidPoller = require('../src/cron/bybitUidPoller.cron');

async function runTestSuite() {
  console.log('🧪 Starting Bybit UID System Verification Suite...\n');

  // =========================================================================
  // Test 1: Checkout payment options - Telegram Stars removed & Bybit UID added
  // =========================================================================
  console.log('Test 1: Checkout Payment Keyboard & Button Replacement');

  assert.strictEqual(
    typeof shopScene.handlePayStep,
    'function',
    'handlePayStep must be exported from shop.scene'
  );
  assert.strictEqual(
    typeof shopScene.showCheckoutPaymentOptions,
    'function',
    'showCheckoutPaymentOptions must be exported from shop.scene'
  );

  let capturedText = '';
  let capturedKeyboard = null;
  let cbAnswered = false;

  const mockCtxCheckout = {
    user: {
      _id: new mongoose.Types.ObjectId(),
      telegramId: 999001,
      balance: 5.0,
      language: 'ru',
    },
    callbackQuery: { id: 'cb_test_123' },
    t: (k) => k,
    answerCbQuery: async () => {
      cbAnswered = true;
    },
    editMessageText: async (text, extra) => {
      capturedText = text;
      capturedKeyboard = extra?.reply_markup?.inline_keyboard;
    },
    reply: async (text, extra) => {
      capturedText = text;
      capturedKeyboard = extra?.reply_markup?.inline_keyboard;
    },
  };

  const sampleProductId = new mongoose.Types.ObjectId();
  const sampleProduct = {
    _id: sampleProductId,
    name: 'ChatGPT Plus Sub',
    price: 20.0,
    isActive: true,
  };

  const origProductFindById = Product.findById;
  const origKeyCountDocuments = Key.countDocuments;
  Product.findById = async () => sampleProduct;
  Key.countDocuments = async () => 10;

  try {
    await shopScene.handlePayStep(mockCtxCheckout, sampleProductId.toString(), 1, 1);

    assert(capturedKeyboard, 'Checkout keyboard must be rendered');
    assert.strictEqual(capturedKeyboard.length, 3, 'Keyboard must have exactly 3 rows');

    // Flatten buttons
    const allButtons = capturedKeyboard.flat();

    // Check Telegram Stars is REMOVED
    const hasStars = allButtons.some(
      (b) => b.text && (b.text.includes('Telegram Stars') || b.text.includes('Stars'))
    );
    assert.strictEqual(hasStars, false, '⭐ Telegram Stars button must be completely removed');

    // Check Bybit UID button
    const bybitBtn = allButtons.find((b) => b.text && b.text.includes('Bybit · UID'));
    assert(bybitBtn, '📊 Bybit · UID button must exist on the payment keyboard');

    // Expected diff: 20 - 5 = 15 USDT
    assert.ok(
      bybitBtn.text.includes('15 USDT'),
      `Bybit button text should include diff amount: ${bybitBtn.text}`
    );
    assert.strictEqual(
      bybitBtn.callback_data,
      `shop:bybit_uid:pay:${sampleProductId}:1:1`,
      `Callback data must follow pattern shop:bybit_uid:pay:${sampleProductId}:1:1`
    );

    // Row 1: Card / SBP, Crypto
    assert.strictEqual(capturedKeyboard[0].length, 2, 'Row 1 must contain Card and Crypto');
    assert.ok(
      capturedKeyboard[0][0].text.includes('Картой'),
      'Row 1 Col 1 must be Card/SBP'
    );
    assert.ok(
      capturedKeyboard[0][1].text.includes('Криптой'),
      'Row 1 Col 2 must be Crypto'
    );

    // Row 2: Bybit UID
    assert.strictEqual(capturedKeyboard[1].length, 1, 'Row 2 must have Bybit UID button');
    assert.strictEqual(capturedKeyboard[1][0], bybitBtn);

    // Row 3: Back button
    assert.strictEqual(capturedKeyboard[2].length, 1, 'Row 3 must have Back button');
    assert.ok(
      capturedKeyboard[2][0].text.includes('Назад к условиям'),
      'Row 3 must be Back to terms'
    );

    console.log('  ✅ Test 1 Passed: Telegram Stars replaced with clean 3-row Bybit UID keyboard.\n');
  } finally {
    Product.findById = origProductFindById;
    Key.countDocuments = origKeyCountDocuments;
  }

  // =========================================================================
  // Test 2: Suffix Allocation & Collision Avoidance
  // =========================================================================
  console.log('Test 2: Suffix Allocation & Collision Avoidance');

  assert.strictEqual(
    typeof bybitUidPaymentService.allocateUniqueAmount,
    'function',
    'allocateUniqueAmount must be exported'
  );

  const origInvoiceFind = BybitInvoice.find;

  try {
    // 2.1 Basic allocation produces 4-decimal suffix
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => [],
      }),
    });

    const res1 = await bybitUidPaymentService.allocateUniqueAmount(15.0);
    assert(res1.suffix >= 10 && res1.suffix <= 99, 'Suffix should be integer between 10 and 99');
    assert(
      res1.suffixFractional >= 0.001 && res1.suffixFractional <= 0.0099,
      'Fractional suffix should be between 0.0010 and 0.0099'
    );
    const expectedDiff = Number((res1.exactAmount - 15.0).toFixed(4));
    assert.strictEqual(
      expectedDiff,
      res1.suffixFractional,
      'exactAmount must equal baseAmount + suffixFractional'
    );

    // 2.2 Collision avoidance: simulate active invoices with existing suffixes
    const occupiedList = [
      { exactAmount: 15.001, suffix: 10 },
      { exactAmount: 15.0011, suffix: 11 },
      { exactAmount: 15.0012, suffix: 12 },
      { exactAmount: 15.0038, suffix: 38 },
    ];
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => occupiedList,
      }),
    });

    for (let i = 0; i < 20; i++) {
      const res = await bybitUidPaymentService.allocateUniqueAmount(15.0);
      assert.notStrictEqual(res.suffix, 10, 'Must not allocate occupied suffix 10');
      assert.notStrictEqual(res.suffix, 11, 'Must not allocate occupied suffix 11');
      assert.notStrictEqual(res.suffix, 12, 'Must not allocate occupied suffix 12');
      assert.notStrictEqual(res.suffix, 38, 'Must not allocate occupied suffix 38 (15.0038)');
    }

    // 2.3 Collision avoidance when all but one suffix are occupied
    const allExcept99 = [];
    for (let s = 10; s <= 98; s++) {
      allExcept99.push({
        exactAmount: Number((15.0 + s / 10000).toFixed(4)),
        suffix: s,
      });
    }
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => allExcept99,
      }),
    });

    const resOnly99 = await bybitUidPaymentService.allocateUniqueAmount(15.0);
    assert.strictEqual(resOnly99.suffix, 99, 'Only available suffix 99 must be chosen');
    assert.strictEqual(resOnly99.exactAmount, 15.0099, 'exactAmount must be 15.0099');

    // 2.4 Error when all 90 suffixes are occupied
    const allOccupied = [...allExcept99, { exactAmount: 15.0099, suffix: 99 }];
    BybitInvoice.find = () => ({
      select: () => ({
        lean: async () => allOccupied,
      }),
    });

    await assert.rejects(
      async () => {
        await bybitUidPaymentService.allocateUniqueAmount(15.0);
      },
      /заняты/i,
      'Must reject when all suffixes are occupied'
    );

    console.log('  ✅ Test 2 Passed: Suffix allocation generates unique 4-decimal amounts and prevents collisions.\n');
  } finally {
    BybitInvoice.find = origInvoiceFind;
  }

  // =========================================================================
  // Test 3: Exact Card Rendering & Formatting Verification
  // =========================================================================
  console.log('Test 3: Exact Card Rendering & User Screenshot Format');

  assert.strictEqual(
    typeof shopScene.showBybitUidInvoiceScreen,
    'function',
    'showBybitUidInvoiceScreen must be exported'
  );
  assert.strictEqual(
    typeof shopScene.formatTime,
    'function',
    'formatTime must be exported'
  );

  // 3.1 formatTime tests
  const testDate = new Date('2026-11-19T14:35:00.000Z');
  const formattedTime = shopScene.formatTime(testDate);
  assert.ok(typeof formattedTime === 'string' && formattedTime.includes(':'), 'formatTime should output HH:MM');

  // 3.2 Invoice Screen rendering
  const mockInvoice = {
    _id: '673c000000000000000000aa',
    invoiceNumber: 'INV-BYBIT-00123',
    baseAmount: 15.0,
    exactAmount: 15.0038,
    adminUid: '547343159',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  };

  let renderedScreenText = '';
  let renderedScreenKeyboard = null;

  const mockCtxScreen = {
    callbackQuery: { id: 'cb_screen_123' },
    answerCbQuery: async () => {},
    editMessageText: async (text, extra) => {
      renderedScreenText = text;
      renderedScreenKeyboard = extra?.reply_markup?.inline_keyboard;
    },
    reply: async (text, extra) => {
      renderedScreenText = text;
      renderedScreenKeyboard = extra?.reply_markup?.inline_keyboard;
    },
  };

  await shopScene.showBybitUidInvoiceScreen(mockCtxScreen, mockInvoice, null, 1);

  assert(renderedScreenText, 'Card text must be generated');

  // Validate exact elements from user screenshot layout:
  // 1. Title
  assert.ok(renderedScreenText.startsWith('Bybit UID\n\n'), 'Text must start with Bybit UID header');

  // 2. Transfer amount
  assert.ok(
    renderedScreenText.includes('К переводу\n<code>15.0038</code> USDT'),
    'Text must contain exact amount in code tag: <code>15.0038</code> USDT'
  );

  // 3. Credit amount
  assert.ok(
    renderedScreenText.includes('Будет зачислено: <b>15.00 USDT</b>'),
    'Text must contain credited base amount in bold: Будет зачислено: <b>15.00 USDT</b>'
  );

  // 4. Receiver UID
  assert.ok(
    renderedScreenText.includes('UID получателя\n<code>547343159</code>'),
    'Text must contain receiver UID in code tag'
  );
  assert.ok(
    renderedScreenText.includes('<i>Нажмите на UID или сумму, чтобы скопировать.</i>'),
    'Text must contain copy hint in italics'
  );

  // 5. Instructions
  assert.ok(
    renderedScreenText.includes('<b>Как перевести</b>\nВ Bybit: Вывод ➔ Внутренний перевод ➔ UID.'),
    'Text must contain transfer instructions with arrow ➔'
  );

  // 6. Warnings
  assert.ok(
    renderedScreenText.includes('⚠️ <b>Только USDT. Переведите точную сумму, не округляйте.</b>'),
    'Text must contain warning about USDT and exact amount'
  );
  assert.ok(
    renderedScreenText.includes('<i>Зачисление автоматическое.</i>'),
    'Text must state automatic credit'
  );

  // 7. Expiry & Bill number
  const expTimeStr = shopScene.formatTime(mockInvoice.expiresAt);
  assert.ok(
    renderedScreenText.includes(`Оплатить до: <b>${expTimeStr}</b>`),
    'Text must contain expiration time'
  );
  assert.ok(
    renderedScreenText.includes('Счёт: <code>INV-BYBIT-00123</code>'),
    'Text must contain invoiceNumber in code tag'
  );

  // 8. Footer
  assert.ok(
    renderedScreenText.includes('⏳ <b>Ожидаем перевод</b>'),
    'Text must contain waiting status with hourglass'
  );

  // 9. Keyboard buttons
  assert(renderedScreenKeyboard, 'Invoice card must have inline keyboard');
  assert.strictEqual(renderedScreenKeyboard.length, 2, 'Keyboard must have 2 rows');

  // Row 1: Check payment
  assert.strictEqual(renderedScreenKeyboard[0].length, 1);
  assert.ok(
    renderedScreenKeyboard[0][0].text.includes('Проверить перевод'),
    'Row 1 must be Check payment button'
  );
  assert.strictEqual(
    renderedScreenKeyboard[0][0].callback_data,
    `bybit_uid:check:${mockInvoice._id}`,
    'Row 1 callback must be bybit_uid:check:invoiceId'
  );

  // Row 2: Cancel invoice
  assert.strictEqual(renderedScreenKeyboard[1].length, 1);
  assert.ok(
    renderedScreenKeyboard[1][0].text.includes('Отменить счёт'),
    'Row 2 must be Cancel invoice button'
  );
  assert.strictEqual(
    renderedScreenKeyboard[1][0].callback_data,
    `bybit_uid:cancel:${mockInvoice._id}`,
    'Row 2 callback must be bybit_uid:cancel:invoiceId'
  );

  console.log('  ✅ Test 3 Passed: Invoice card text, HTML tags, and callbacks match user screenshot 1:1.\n');

  // =========================================================================
  // Test 4: Deposit Matching & Double-Spend Protection
  // =========================================================================
  console.log('Test 4: Deposit Matching & Rejection of Reused txIds');

  assert.strictEqual(
    typeof bybitUidPaymentService.checkInvoice,
    'function',
    'checkInvoice must be exported'
  );

  const testUserId = new mongoose.Types.ObjectId();
  const activeInvoice = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: 'INV-BYBIT-TEST-01',
    userId: testUserId,
    baseAmount: 15.0,
    exactAmount: 15.0038,
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    txId: null,
    save: async function () {
      return this;
    },
  };

  const origInvoiceFindById = BybitInvoice.findById;
  const origInvoiceFindOne = BybitInvoice.findOne;
  const origTopupFindOne = TopupRequest.findOne;
  const origUserUpdateOne = User.updateOne;
  const origUserFindById = User.findById;
  const origTopupSave = TopupRequest.prototype.save;
  const origTransactionSave = Transaction.prototype.save;

  BybitInvoice.findById = async (id) => {
    if (String(id) === String(activeInvoice._id)) return activeInvoice;
    return null;
  };

  TopupRequest.prototype.save = async function () {
    return this;
  };
  Transaction.prototype.save = async function () {
    return this;
  };
  User.updateOne = async () => ({ modifiedCount: 1 });
  User.findById = async () => ({
    _id: testUserId,
    telegramId: 888777,
    balance: 0,
    language: 'ru',
  });

  try {
    // 4.1 Mock transfer record with wrong amount -> No match
    const mockUnmatchedRecords = [
      {
        id: 'tx-001',
        coin: 'USDT',
        amount: '15.0000',
        status: 2,
      },
      {
        id: 'tx-002',
        coin: 'USDT',
        amount: '15.0050',
        status: 2,
      },
    ];

    const matchFailResult = await bybitUidPaymentService.checkInvoice(activeInvoice._id, {
      mockRecords: mockUnmatchedRecords,
    });
    assert.strictEqual(matchFailResult.success, false);
    assert.ok(
      matchFailResult.reason.includes('not found'),
      'Must report transfer record not found'
    );
    assert.strictEqual(activeInvoice.status, 'pending', 'Invoice status must remain pending');

    // 4.2 Mock transfer record with exact matching amount (15.0038)
    const mockMatchingRecords = [
      {
        id: 'tx-unique-999',
        coin: 'USDT',
        amount: '15.0038',
        status: 2,
      },
    ];

    BybitInvoice.findOne = async () => null; // No duplicate BybitInvoice
    TopupRequest.findOne = async () => null; // No duplicate TopupRequest

    let sentMsg = '';
    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text) => {
          sentMsg = text;
        },
      },
    };

    const matchSuccessResult = await bybitUidPaymentService.checkInvoice(activeInvoice._id, {
      mockRecords: mockMatchingRecords,
      bot: mockBot,
    });

    assert.strictEqual(matchSuccessResult.success, true, 'Payment check must succeed');
    assert.strictEqual(activeInvoice.status, 'completed', 'Invoice status must be updated to completed');
    assert.strictEqual(activeInvoice.txId, 'tx-unique-999', 'txId must be saved');
    assert.ok(
      sentMsg.includes('Оплата получена'),
      'Bot notification must be delivered to user'
    );

    // 4.3 Double spend protection: Same txId cannot be reused on another invoice
    const secondInvoice = {
      _id: new mongoose.Types.ObjectId(),
      invoiceNumber: 'INV-BYBIT-TEST-02',
      userId: testUserId,
      baseAmount: 15.0,
      exactAmount: 15.0038,
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      txId: null,
      save: async function () {
        return this;
      },
    };
    BybitInvoice.findById = async (id) => {
      if (String(id) === String(secondInvoice._id)) return secondInvoice;
      return null;
    };

    // Case A: txId already exists on another BybitInvoice
    BybitInvoice.findOne = async (query) => {
      if (query.txId === 'tx-unique-999') {
        return { _id: activeInvoice._id, invoiceNumber: activeInvoice.invoiceNumber };
      }
      return null;
    };
    TopupRequest.findOne = async () => null;

    const dupInvoiceResult = await bybitUidPaymentService.checkInvoice(secondInvoice._id, {
      mockRecords: mockMatchingRecords,
    });
    assert.strictEqual(dupInvoiceResult.success, false, 'Must reject reused txId on BybitInvoice');
    assert.ok(
      dupInvoiceResult.reason.includes('double spend'),
      `Reason must mention double spend: ${dupInvoiceResult.reason}`
    );
    assert.strictEqual(secondInvoice.status, 'pending', 'Second invoice must remain pending');

    // Case B: txId already exists on a TopupRequest
    BybitInvoice.findOne = async () => null;
    TopupRequest.findOne = async (query) => {
      return { _id: 'topup-existing-tx', txid: 'tx-unique-999' };
    };

    const dupTopupResult = await bybitUidPaymentService.checkInvoice(secondInvoice._id, {
      mockRecords: mockMatchingRecords,
    });
    assert.strictEqual(dupTopupResult.success, false, 'Must reject reused txId on TopupRequest');
    assert.ok(
      dupTopupResult.reason.includes('double spend'),
      `Reason must mention double spend: ${dupTopupResult.reason}`
    );
    assert.strictEqual(secondInvoice.status, 'pending', 'Second invoice must remain pending');

    console.log('  ✅ Test 4 Passed: Exact amount matching succeeds and double-spend txId reuse is strictly blocked.\n');
  } finally {
    BybitInvoice.findById = origInvoiceFindById;
    BybitInvoice.findOne = origInvoiceFindOne;
    TopupRequest.findOne = origTopupFindOne;
    User.updateOne = origUserUpdateOne;
    User.findById = origUserFindById;
    TopupRequest.prototype.save = origTopupSave;
    Transaction.prototype.save = origTransactionSave;
  }

  // =========================================================================
  // Test 5: Invoice Cancellation & Suffix Freeing
  // =========================================================================
  console.log('Test 5: Invoice Cancellation & Suffix Freeing');

  assert.strictEqual(
    typeof bybitUidPaymentService.cancelInvoice,
    'function',
    'cancelInvoice must be exported'
  );

  const pendingInvoiceToCancel = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: 'INV-CANCEL-001',
    userId: testUserId,
    baseAmount: 15.0,
    exactAmount: 15.0042,
    suffix: 42,
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    save: async function () {
      return this;
    },
  };

  const completedInvoiceNoCancel = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: 'INV-COMPLETED-001',
    userId: testUserId,
    status: 'completed',
    save: async function () {
      return this;
    },
  };

  BybitInvoice.findOne = async (query) => {
    if (String(query._id) === String(pendingInvoiceToCancel._id)) return pendingInvoiceToCancel;
    if (String(query._id) === String(completedInvoiceNoCancel._id)) return completedInvoiceNoCancel;
    return null;
  };

  try {
    // 5.1 Cancel pending invoice
    const cancelled = await bybitUidPaymentService.cancelInvoice(
      pendingInvoiceToCancel._id,
      testUserId
    );
    assert.strictEqual(cancelled.status, 'cancelled', 'Status must be set to cancelled');
    assert.strictEqual(pendingInvoiceToCancel.status, 'cancelled');

    // 5.2 Attempt to cancel completed invoice must fail
    await assert.rejects(
      async () => {
        await bybitUidPaymentService.cancelInvoice(completedInvoiceNoCancel._id, testUserId);
      },
      /Cannot cancel completed invoice/i,
      'Must reject cancelling completed invoice'
    );

    // 5.3 Verify that suffix is now free in allocateUniqueAmount
    // (Only pending invoices with status: 'pending' are considered occupied)
    BybitInvoice.find = (filter) => {
      assert.strictEqual(filter.status, 'pending', 'Allocator must only query pending invoices');
      return {
        select: () => ({
          lean: async () => [], // Cancelled invoice is not returned
        }),
      };
    };

    const reallocated = await bybitUidPaymentService.allocateUniqueAmount(15.0);
    assert(reallocated.suffix >= 10 && reallocated.suffix <= 99, 'Reallocation succeeds');

    // 5.4 Test handleBybitUidCancel route handler
    assert.strictEqual(
      typeof shopScene.handleBybitUidCancel,
      'function',
      'handleBybitUidCancel must be exported'
    );

    const cancelAlerts = [];
    let navBackCalled = false;

    const mockCtxCancel = {
      user: { _id: testUserId, balance: 0 },
      callbackQuery: { id: 'cb_cancel_123' },
      session: {
        bybitUidInvoice: {
          productId: sampleProductId.toString(),
          safePage: 1,
          qty: 1,
        },
      },
      answerCbQuery: async (msg) => {
        if (msg) cancelAlerts.push(msg);
      },
      editMessageText: async () => {
        navBackCalled = true;
      },
      reply: async () => {
        navBackCalled = true;
      },
    };

    Product.findById = async () => sampleProduct;
    Key.countDocuments = async () => 10;
    await shopScene.handleBybitUidCancel(mockCtxCancel, pendingInvoiceToCancel._id);

    const hasCancelAlert = cancelAlerts.some((a) => typeof a === 'string' && a.includes('Счёт отменён'));
    assert.strictEqual(hasCancelAlert, true, 'User alert must say Счёт отменён');
    assert.strictEqual(navBackCalled, true, 'User must be navigated back to checkout screen');

    console.log('  ✅ Test 5 Passed: Invoice cancellation frees suffix and properly navigates back.\n');
  } finally {
    BybitInvoice.findOne = origInvoiceFindOne;
    BybitInvoice.find = origInvoiceFind;
    Product.findById = origProductFindById;
    Key.countDocuments = origKeyCountDocuments;
  }

  // =========================================================================
  // Test 6: Auto-expiry of stale invoices by Cron Poller
  // =========================================================================
  console.log('Test 6: Background Poller Auto-Expiry Verification');

  assert.strictEqual(
    typeof bybitUidPoller.poll,
    'function',
    'poll function must be exported from bybitUidPoller.cron'
  );

  let updatedFilter = null;
  let updateAction = null;
  const origUpdateMany = BybitInvoice.updateMany;

  // Simulate connected mongoose
  const origReadyState = mongoose.connection.readyState;
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

  BybitInvoice.updateMany = async (filter, action) => {
    updatedFilter = filter;
    updateAction = action;
    return { modifiedCount: 5 };
  };

  BybitInvoice.find = () => ({
    sort: () => Promise.resolve([]),
  });

  try {
    await bybitUidPoller.poll();

    assert(updatedFilter, 'updateMany should be called to mark expired invoices');
    assert.strictEqual(updatedFilter.status, 'pending');
    assert(updatedFilter.expiresAt.$lte instanceof Date, 'Filter must check expiresAt <= now');
    assert.deepStrictEqual(updateAction, { $set: { status: 'expired' } });

    console.log('  ✅ Test 6 Passed: Cron poller automatically identifies and marks stale invoices as expired.\n');
  } finally {
    BybitInvoice.updateMany = origUpdateMany;
    BybitInvoice.find = origInvoiceFind;
    Object.defineProperty(mongoose.connection, 'readyState', { value: origReadyState, configurable: true });
  }

  console.log('🎉 ALL TESTS PASSED! Bybit UID System verified with 100% compliance. 🚀\n');
}

runTestSuite().catch((err) => {
  console.error('❌ Verification Suite Failed:', err);
  process.exit(1);
});

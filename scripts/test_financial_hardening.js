/**
 * scripts/test_financial_hardening.js
 *
 * Dedicated Automated Test Suite for Milestone 1: Financial & Payments Hardening
 * Verifies all 7 tasks:
 * 1. [SEC-FIN-04, SEC-FIN-05] Platega SBP Webhook Validation, CAS & Cache Invalidation
 * 2. [SEC-FIN-08] IEEE 754 Floating Point Rounding (roundMoney in topup scenes)
 * 3. [SEC-FIN-11] CAS Lock on Seller Withdrawal Requests (partial unique index, atomic deduction & refund on duplicate)
 * 4. [SEC-FIN-12, SEC-FIN-16] Financial Transaction Audit Records on Dispute Resolution (refund & seller_payout)
 * 5. [SEC-FIN-13] Explicit topupRequestId in Manual Top-up Transactions
 * 6. [SEC-FIN-14] Graceful CAS Fallback for Transactions on Standalone MongoDB
 * 7. [SEC-FIN-17] Legacy Bybit UID USDT Filter (coin=USDT&limit=50) & Cross-Collection Deduplication
 */

const assert = require('assert');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Models
const TopupRequest = require('../src/models/TopupRequest');
const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const Seller = require('../src/models/Seller');
const SellerWithdrawal = require('../src/models/SellerWithdrawal');
const Order = require('../src/models/Order');
const BybitInvoice = require('../src/models/BybitInvoice');
const Settings = require('../src/models/Settings');

// Services & utils
const { roundMoney } = require('../src/utils/money');
const { withTransaction, _setTransactionsAvailable } = require('../src/services/transactionHelper.service');
const { invalidateCache } = require('../src/services/settingsCache.service');
const topupScene = require('../src/bot/scenes/topup.scene');
const userMiddlewareModule = require('../src/bot/middlewares/user');

async function runFinancialHardeningTests() {
  console.log('🧪 Starting Milestone 1: Financial & Payments Hardening Test Suite...\n');

  // Stub and cache Settings
  const mockSettings = {
    bybitEnabled: true,
    bybitUid: '554135317',
    plategaEnabled: true,
    cardEnabled: true,
    minTopup: 1,
    currencyMode: 'manual',
    manualRate: 93.4,
    rate: 93.4,
  };
  invalidateCache(mockSettings);
  const origSettingsFindOne = Settings.findOne;
  Settings.findOne = () => ({
    lean: async () => mockSettings,
  });

  // Default startSession mock for scenes that execute withTransaction
  const origGlobalStartSession = mongoose.startSession;
  mongoose.startSession = async () => ({
    withTransaction: async (cb) => cb(null),
    endSession: async () => {},
  });

  // =========================================================================
  // TEST SUITE 1: Task 2 [SEC-FIN-08] IEEE 754 Floating Point Rounding
  // =========================================================================
  console.log('--- TEST SUITE 1: Task 2 [SEC-FIN-08] IEEE 754 Floating Point Rounding ---');
  {
    // 1.1 Direct rounding verification
    const divResult = 1000 / 93.4; // 10.706638115631692
    const rounded = roundMoney(divResult, 2);
    assert.strictEqual(rounded, 10.71, '1000 / 93.4 must be strictly rounded to 10.71');

    assert.strictEqual(roundMoney(100 / 3, 2), 33.33, '100 / 3 must be 33.33');
    assert.strictEqual(roundMoney(0.1 + 0.2, 2), 0.3, '0.1 + 0.2 must be 0.30');
    assert.strictEqual(roundMoney(null), 0, 'null must return 0');
    assert.strictEqual(roundMoney(undefined), 0, 'undefined must return 0');
    assert.strictEqual(roundMoney(''), 0, 'empty string must return 0');
    assert.strictEqual(roundMoney(NaN), 0, 'NaN must return 0');
    assert.strictEqual(roundMoney('invalid'), 0, 'non-numeric string must return 0');
    assert.strictEqual(roundMoney(-15.556, 2), -15.56, 'negative numbers must round correctly');
    assert.strictEqual(roundMoney(1.23456, 4), 1.2346, 'custom decimals (4) must round correctly');

    // 1.2 Topup scene handlePresetAmount with RUB currency
    const ctxMockPreset = {
      user: { language: 'ru' },
      session: {},
      answerCbQuery: async () => {},
      reply: async () => {},
      editMessageText: async () => {},
    };
    await topupScene.handlePresetAmount(ctxMockPreset, 'rub', '1000');
    assert.strictEqual(
      ctxMockPreset.session.topup.amountUSDT,
      10.71,
      'Preset 1000 RUB at 93.4 rate must set amountUSDT to 10.71'
    );
    assert.strictEqual(ctxMockPreset.session.topup.amountRUB, 1000);

    // 1.3 Topup scene handleAmountInput with custom RUB input
    const ctxMockInput = {
      user: { language: 'ru' },
      session: { topup: { step: 'amount', currency: 'rub' } },
      message: { text: '2500' },
      telegram: { deleteMessage: async () => {} },
      answerCbQuery: async () => {},
      reply: async () => {},
      editMessageText: async () => {},
    };
    await topupScene.handleAmountInput(ctxMockInput, '2500');
    // 2500 / 93.4 = 26.766595... -> 26.77
    assert.strictEqual(
      ctxMockInput.session.topup.amountUSDT,
      26.77,
      'Custom 2500 RUB at 93.4 rate must set amountUSDT to 26.77'
    );
    assert.strictEqual(ctxMockInput.session.topup.amountRUB, 2500);

    console.log('  ✅ Test 1 Passed: roundMoney handles division tails, edge cases, and applies in topup scene.\n');
  }

  // =========================================================================
  // TEST SUITE 2: Task 1 [SEC-FIN-04, SEC-FIN-05] Platega SBP Webhook Validation & Invalidation
  // =========================================================================
  console.log('--- TEST SUITE 2: Task 1 [SEC-FIN-04, SEC-FIN-05] Platega SBP Webhook Validation & Invalidation ---');
  {
    const origTopupFindOne = TopupRequest.findOne;
    const origTopupFindOneAndUpdate = TopupRequest.findOneAndUpdate;
    const origUserUpdateOne = User.updateOne;
    const origTransactionSave = Transaction.prototype.save;
    const origInvalidateUserCache = userMiddlewareModule.invalidateUserCache;

    const mockUserId = new mongoose.Types.ObjectId();
    const mockRequestId = new mongoose.Types.ObjectId();
    const mockTopupDoc = {
      _id: mockRequestId,
      userId: {
        _id: mockUserId,
        telegramId: 987654321,
        username: 'sbp_buyer',
        balance: 5.0,
      },
      amount: 10.71,
      amountRub: 1000,
      status: 'pending',
      method: 'platega',
    };

    try {
      // 2.1 Non-CONFIRMED status ignored
      const resPending = await topupScene.handlePlategaWebhook({
        id: 'tx_123',
        status: 'PENDING',
        payload: String(mockRequestId),
      });
      assert.strictEqual(resPending.status, 'ignored', 'Non-CONFIRMED status must be ignored');

      // 2.2 Missing identifiers
      const resNoId = await topupScene.handlePlategaWebhook({
        status: 'CONFIRMED',
      });
      assert.strictEqual(resNoId.status, 'missing_identifiers', 'Missing identifiers must return missing_identifiers');

      // 2.3 Request not found
      TopupRequest.findOne = async () => null;
      const resNotFound = await topupScene.handlePlategaWebhook({
        id: 'tx_404',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
      });
      assert.strictEqual(resNotFound.status, 'not_found', 'Unknown request must return not_found');

      // 2.4 Already confirmed request
      TopupRequest.findOne = async () => ({
        ...mockTopupDoc,
        status: 'confirmed',
      });
      const resAlready = await topupScene.handlePlategaWebhook({
        id: 'tx_already',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
      });
      assert.strictEqual(resAlready.status, 'already_confirmed', 'Already confirmed request must return already_confirmed');

      // 2.5 Invalid currency rejected (e.g. USD instead of RUB)
      TopupRequest.findOne = async () => ({ ...mockTopupDoc, status: 'pending' });
      const resInvalidCurr = await topupScene.handlePlategaWebhook({
        id: 'tx_curr',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
        currency: 'USD',
        amount: 1000,
      });
      assert.strictEqual(resInvalidCurr.status, 'invalid_currency', 'Non-RUB currency must be rejected');

      // 2.6 Amount mismatch rejected (> 0.01 tolerance)
      const resMismatch = await topupScene.handlePlategaWebhook({
        id: 'tx_mismatch',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
        currency: 'RUB',
        amount: 990, // Expected 1000
      });
      assert.strictEqual(resMismatch.status, 'amount_mismatch', 'Amount difference > 0.01 must be rejected');

      // 2.7 Valid webhook with CAS transition & cache invalidation
      let casExecuted = false;
      let balanceIncremented = null;
      let savedTransaction = null;
      const invalidatedKeys = [];

      userMiddlewareModule.invalidateUserCache = (target) => {
        invalidatedKeys.push(target);
      };

      TopupRequest.findOne = async () => ({ ...mockTopupDoc, status: 'pending' });
      TopupRequest.findOneAndUpdate = (filter, update) => {
        if (String(filter._id) === String(mockRequestId) && filter.status === 'pending') {
          casExecuted = true;
          return {
            populate: async () => ({
              ...mockTopupDoc,
              status: update.$set.status,
            }),
          };
        }
        return { populate: async () => null };
      };

      User.updateOne = async (filter, update) => {
        if (String(filter._id) === String(mockUserId)) {
          balanceIncremented = update.$inc.balance;
        }
        return { modifiedCount: 1 };
      };

      Transaction.prototype.save = async function () {
        savedTransaction = this;
        return this;
      };

      const resSuccess = await topupScene.handlePlategaWebhook({
        id: 'tx_valid_sbp',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
        currency: 'RUB',
        amount: 1000.005, // within 0.01 of 1000
      });

      assert.strictEqual(resSuccess.status, 'confirmed', 'Valid webhook must return confirmed status');
      assert.strictEqual(casExecuted, true, 'CAS transition from pending to confirmed must be executed');
      assert.strictEqual(balanceIncremented, 10.71, 'User balance must be incremented by 10.71 USDT');
      assert(savedTransaction, 'Transaction ledger record must be created');
      assert.strictEqual(savedTransaction.type, 'topup');
      assert.strictEqual(String(savedTransaction.topupRequestId), String(mockRequestId));

      // Cache invalidation check
      assert(
        invalidatedKeys.includes(mockTopupDoc.userId.telegramId),
        `Cache must be invalidated for telegramId ${mockTopupDoc.userId.telegramId}`
      );
      assert(
        invalidatedKeys.some(k => String(k) === String(mockUserId)),
        `Cache must be invalidated for userId ${mockUserId}`
      );

      // 2.8 Concurrent duplicate execution CAS guard
      TopupRequest.findOneAndUpdate = () => ({ populate: async () => null }); // simulate already captured
      const resDup = await topupScene.handlePlategaWebhook({
        id: 'tx_valid_sbp_dup',
        status: 'CONFIRMED',
        payload: String(mockRequestId),
        currency: 'RUB',
        amount: 1000,
      });
      assert.strictEqual(resDup.status, 'failed', 'Second concurrent attempt must fail CAS and not credit');
    } finally {
      TopupRequest.findOne = origTopupFindOne;
      TopupRequest.findOneAndUpdate = origTopupFindOneAndUpdate;
      User.updateOne = origUserUpdateOne;
      Transaction.prototype.save = origTransactionSave;
      userMiddlewareModule.invalidateUserCache = origInvalidateUserCache;
    }

    console.log('  ✅ Test 2 Passed: Platega webhook validates status, currency, amount tolerance, CAS, and cache invalidation.\n');
  }

  // =========================================================================
  // TEST SUITE 3: Task 14 [SEC-FIN-11] CAS Lock on Seller Withdrawal Requests
  // =========================================================================
  console.log('--- TEST SUITE 3: Task 14 [SEC-FIN-11] CAS Lock on Seller Withdrawal Requests ---');
  {
    // 3.1 Check Schema index for partial unique index on { sellerId: 1 } where status: 'pending'
    const indexes = SellerWithdrawal.schema.indexes();
    const hasPendingUniqueIndex = indexes.some(([spec, opts]) => (
      spec.sellerId === 1 &&
      opts?.unique === true &&
      opts?.partialFilterExpression?.status === 'pending'
    ));
    assert(
      hasPendingUniqueIndex,
      'SellerWithdrawal schema must contain partial unique index on { sellerId: 1 } with status: "pending"'
    );

    // 3.2 Test seller scene confirmWithdraw duplicate code 11000 handling & atomic refund
    const sellerScene = require('../src/bot/scenes/seller.scene');
    const origSellerFindOne = Seller.findOne;
    const origSellerFindOneAndUpdate = Seller.findOneAndUpdate;
    const origSellerUpdateOne = Seller.updateOne;
    const origWithdrawalFindOne = SellerWithdrawal.findOne;
    const origWithdrawalSave = SellerWithdrawal.prototype.save;

    const mockSellerId = new mongoose.Types.ObjectId();
    let sellerRefundIncrement = 0;
    let answerAlertText = null;

    try {
      Seller.findOne = async () => ({
        _id: mockSellerId,
        balance: 100.0,
        isActive: true,
        walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
        walletNetwork: 'TRC-20',
      });

      SellerWithdrawal.findOne = async () => null; // Passed first check

      // Atomic deduction succeeds
      Seller.findOneAndUpdate = async (filter, update) => {
        if (filter.balance?.$gte >= 50) {
          return { _id: mockSellerId, balance: 50.0 };
        }
        return null;
      };

      // Atomic refund on catch
      Seller.updateOne = async (filter, update) => {
        if (update.$inc?.balance) {
          sellerRefundIncrement += update.$inc.balance;
        }
        return { modifiedCount: 1 };
      };

      // Simulate MongoDB duplicate key error E11000 on concurrent insert
      SellerWithdrawal.prototype.save = async function () {
        const dupErr = new Error('E11000 duplicate key error collection: sellerwithdrawals index: unique_pending_seller_withdrawal');
        dupErr.code = 11000;
        throw dupErr;
      };

      const ctxMockWithdraw = {
        from: { id: 777888999 },
        user: { telegramId: 777888999 },
        session: { sellerWithdraw: { amount: 50.0 } },
        t: (key) => key,
        answerCbQuery: async (text, opts) => {
          if (opts?.show_alert) answerAlertText = text;
        },
      };

      // Call confirmWithdraw with amountStr
      await sellerScene.confirmWithdraw(ctxMockWithdraw, '50.00');

      assert.strictEqual(sellerRefundIncrement, 50.0, 'Deducted balance must be refunded upon duplicate error (E11000)');
      assert.strictEqual(
        answerAlertText,
        'seller_withdraw_pending_error',
        'User must receive seller_withdraw_pending_error alert on concurrent duplicate request'
      );
    } finally {
      Seller.findOne = origSellerFindOne;
      Seller.findOneAndUpdate = origSellerFindOneAndUpdate;
      Seller.updateOne = origSellerUpdateOne;
      SellerWithdrawal.findOne = origWithdrawalFindOne;
      SellerWithdrawal.prototype.save = origWithdrawalSave;
    }

    console.log('  ✅ Test 3 Passed: SellerWithdrawal partial unique index and E11000 balance refund verified.\n');
  }

  // =========================================================================
  // TEST SUITE 4: Task 15 [SEC-FIN-12, SEC-FIN-16] Financial Transaction Audit Records on Dispute Resolution
  // =========================================================================
  console.log('--- TEST SUITE 4: Task 15 [SEC-FIN-12, SEC-FIN-16] Dispute Financial Audit Records ---');
  {
    // 4.1 Verify Transaction schema includes 'seller_payout' and 'sellerId'
    const txPaths = Transaction.schema.paths;
    assert(txPaths.type.enumValues.includes('seller_payout'), "Transaction type enum must include 'seller_payout'");
    assert(txPaths.sellerId, 'Transaction schema must define sellerId field');

    const disputesScene = require('../src/bot/scenes/admin/disputes.scene');
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    const origOrderCountDocuments = Order.countDocuments;
    const origOrderFind = Order.find;
    const origUserUpdateOne = User.updateOne;
    const origSellerUpdateOne = Seller.updateOne;
    const origOrderUpdateOne = Order.updateOne;
    const origTxSave = Transaction.prototype.save;

    const mockOrderId = new mongoose.Types.ObjectId();
    const mockBuyerId = new mongoose.Types.ObjectId();
    const mockSellerId = new mongoose.Types.ObjectId();

    const mockDisputedOrder = {
      _id: mockOrderId,
      price: 25.0,
      sellerPayout: 20.0,
      status: 'disputed',
      userId: {
        _id: mockBuyerId,
        telegramId: 111222333,
      },
      sellerId: {
        _id: mockSellerId,
        telegramId: 444555666,
      },
    };

    let savedRefundTx = null;
    let savedSellerPayoutTx = null;
    let buyerBalanceInc = null;
    let buyerTotalSpentInc = null;
    let sellerBalanceInc = null;

    try {
      Order.countDocuments = async () => 0;
      Order.find = () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({
              populate: () => ({
                populate: () => ({
                  lean: async () => [],
                }),
              }),
            }),
          }),
        }),
      });

      Transaction.prototype.save = async function () {
        if (this.type === 'refund') savedRefundTx = this;
        if (this.type === 'seller_payout') savedSellerPayoutTx = this;
        return this;
      };

      // 4.2 Test resolveRefundBuyer
      Order.findOneAndUpdate = (filter) => ({
        populate: () => ({
          populate: async () => {
            if (filter.status === 'disputed') {
              return { ...mockDisputedOrder, status: 'cancelled' };
            }
            return null;
          },
        }),
      });

      User.updateOne = async (filter, update) => {
        if (update.$inc) {
          buyerBalanceInc = update.$inc.balance;
          buyerTotalSpentInc = update.$inc.totalSpent;
        }
        return { modifiedCount: 1 };
      };

      const ctxMockDispute = {
        answerCbQuery: async () => {},
        reply: async () => {},
      };

      await disputesScene.resolveRefundBuyer(ctxMockDispute, mockOrderId);

      assert.strictEqual(buyerBalanceInc, 25.0, 'Buyer balance must be credited with order price');
      assert.strictEqual(buyerTotalSpentInc, -25.0, 'Buyer totalSpent must be safely decremented on refund');
      assert(savedRefundTx, 'Refund Transaction record must be created');
      assert.strictEqual(savedRefundTx.type, 'refund');
      assert.strictEqual(savedRefundTx.amount, 25.0);
      assert.strictEqual(String(savedRefundTx.orderId), String(mockOrderId));
      assert.strictEqual(String(savedRefundTx.userId), String(mockBuyerId));

      // 4.3 Test resolvePaySeller
      Seller.updateOne = async (filter, update) => {
        if (update.$inc) {
          sellerBalanceInc = update.$inc.balance;
        }
        return { modifiedCount: 1 };
      };
      Order.updateOne = async () => ({ modifiedCount: 1 });

      await disputesScene.resolvePaySeller(ctxMockDispute, mockOrderId);

      assert.strictEqual(sellerBalanceInc, 20.0, 'Seller balance must be credited with sellerPayout');
      assert(savedSellerPayoutTx, 'Seller payout Transaction record must be created');
      assert.strictEqual(savedSellerPayoutTx.type, 'seller_payout');
      assert.strictEqual(savedSellerPayoutTx.amount, 20.0);
      assert.strictEqual(String(savedSellerPayoutTx.sellerId), String(mockSellerId));
      assert.strictEqual(String(savedSellerPayoutTx.orderId), String(mockOrderId));
    } finally {
      Order.findOneAndUpdate = origOrderFindOneAndUpdate;
      Order.countDocuments = origOrderCountDocuments;
      Order.find = origOrderFind;
      User.updateOne = origUserUpdateOne;
      Seller.updateOne = origSellerUpdateOne;
      Order.updateOne = origOrderUpdateOne;
      Transaction.prototype.save = origTxSave;
    }

    console.log('  ✅ Test 4 Passed: Dispute resolution writes refund & seller_payout transactions and decrements totalSpent.\n');
  }

  // =========================================================================
  // TEST SUITE 5: Task 16 [SEC-FIN-13] Explicit topupRequestId in Manual Top-up Transactions
  // =========================================================================
  console.log('--- TEST SUITE 5: Task 16 [SEC-FIN-13] Explicit topupRequestId in Manual Top-up Transactions ---');
  {
    const paymentsScene = require('../src/bot/scenes/admin/payments.scene');
    const origTopupFindOneAndUpdate = TopupRequest.findOneAndUpdate;
    const origUserFindByIdAndUpdate = User.findByIdAndUpdate;
    const origTxSave = Transaction.prototype.save;

    const mockAdminId = new mongoose.Types.ObjectId();
    const mockTopupId = new mongoose.Types.ObjectId();
    const mockUserId = new mongoose.Types.ObjectId();
    let savedTopupTx = null;

    try {
      TopupRequest.findOneAndUpdate = async (filter) => {
        if (String(filter._id) === String(mockTopupId) && filter.status === 'pending') {
          return {
            _id: mockTopupId,
            userId: mockUserId,
            amount: 50.0,
            status: 'confirmed',
          };
        }
        return null;
      };

      User.findByIdAndUpdate = async (userId) => {
        if (String(userId) === String(mockUserId)) {
          return {
            _id: mockUserId,
            balance: 150.0,
          };
        }
        return null;
      };

      Transaction.prototype.save = async function () {
        savedTopupTx = this;
        return this;
      };

      const ctxMockPayment = {
        user: { _id: mockAdminId },
        reply: async () => {},
        answerCbQuery: async () => {},
      };

      await paymentsScene.approveTopupRequest(ctxMockPayment, mockTopupId, 50.0);

      assert(savedTopupTx, 'Transaction record must be saved on manual topup approval');
      assert.strictEqual(savedTopupTx.type, 'topup');
      assert.strictEqual(savedTopupTx.amount, 50.0);
      assert.strictEqual(
        String(savedTopupTx.topupRequestId),
        String(mockTopupId),
        'topupRequestId must be explicitly attached to manual top-up Transaction'
      );
    } finally {
      TopupRequest.findOneAndUpdate = origTopupFindOneAndUpdate;
      User.findByIdAndUpdate = origUserFindByIdAndUpdate;
      Transaction.prototype.save = origTxSave;
    }

    console.log('  ✅ Test 5 Passed: Manual top-up approval binds topupRequestId to Transaction ledger.\n');
  }

  // =========================================================================
  // TEST SUITE 6: Task 17 [SEC-FIN-14] Graceful CAS Fallback for Transactions
  // =========================================================================
  console.log('--- TEST SUITE 6: Task 17 [SEC-FIN-14] Graceful CAS Fallback for Transactions ---');
  {
    const origStartSession = mongoose.startSession;

    try {
      // 6.1 Normal replica set flow
      _setTransactionsAvailable(null);
      let sessionPassed = null;
      mongoose.startSession = async () => ({
        withTransaction: async (fn) => {
          const fakeSession = { id: 'replica_session_1' };
          return await fn(fakeSession);
        },
        endSession: async () => {},
      });

      const resReplica = await withTransaction(async (session) => {
        sessionPassed = session;
        return 'replica_success';
      });
      assert.strictEqual(resReplica, 'replica_success');
      assert(sessionPassed && sessionPassed.id === 'replica_session_1');

      // 6.2 Standalone MongoDB: withTransaction catches replica set error and falls back to fn(null)
      _setTransactionsAvailable(null);
      let fallbackSession = 'initial';
      mongoose.startSession = async () => ({
        withTransaction: async () => {
          const replicaErr = new Error('Transaction numbers are only allowed on a replica set member or mongos');
          replicaErr.code = 20;
          throw replicaErr;
        },
        endSession: async () => {},
      });

      const resFallback = await withTransaction(async (session) => {
        fallbackSession = session;
        return 'cas_fallback_success';
      });

      assert.strictEqual(resFallback, 'cas_fallback_success', 'Must return fn(null) result instead of throwing');
      assert.strictEqual(fallbackSession, null, 'Session passed during CAS fallback must be null');

      // 6.3 Subsequent calls immediately use CAS fallback without re-attempting transaction
      let subsequentSession = 'initial_subsequent';
      const resSubsequent = await withTransaction(async (session) => {
        subsequentSession = session;
        return 'subsequent_success';
      });
      assert.strictEqual(resSubsequent, 'subsequent_success');
      assert.strictEqual(subsequentSession, null, 'Subsequent call must pass session null');

      // 6.4 Non-replica-set business errors inside fn are re-thrown normally
      let caughtBusinessErr = null;
      try {
        await withTransaction(async () => {
          throw new Error('BUSINESS_INSUFFICIENT_FUNDS');
        });
      } catch (err) {
        caughtBusinessErr = err;
      }
      assert(caughtBusinessErr, 'Business errors must still be thrown');
      assert.strictEqual(caughtBusinessErr.message, 'BUSINESS_INSUFFICIENT_FUNDS');
    } finally {
      mongoose.startSession = origStartSession;
      _setTransactionsAvailable(null);
    }

    console.log('  ✅ Test 6 Passed: withTransaction falls back gracefully to fn(null) on Standalone MongoDB without TRANSACTIONS_REQUIRED.\n');
  }

  // =========================================================================
  // TEST SUITE 7: Task 18 [SEC-FIN-17] Legacy Bybit UID USDT Filter & Deduplication
  // =========================================================================
  console.log('--- TEST SUITE 7: Task 18 [SEC-FIN-17] Legacy Bybit UID USDT Filter & Deduplication ---');
  {
    // 7.1 Verify qs in blockchain.service.js
    const blockchainFile = fs.readFileSync(path.join(__dirname, '../src/services/blockchain.service.js'), 'utf8');
    assert(
      blockchainFile.includes("const qs = 'coin=USDT&limit=50';"),
      "blockchain.service.js line 44 must define qs as 'coin=USDT&limit=50'"
    );

    // 7.2 Verify deduplication across both TopupRequest and BybitInvoice in topup.scene.js
    const origBlockchainVerify = require('../src/services/blockchain.service').verifyUidUsdt;
    const origTopupFindOne = TopupRequest.findOne;
    const origTopupFindOneAndUpdate = TopupRequest.findOneAndUpdate;
    const origTopupUpdateOne = TopupRequest.updateOne;
    const origInvoiceFindOne = BybitInvoice.findOne;
    const origUserFindOne = User.findOne;
    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    const origUserUpdateOne = User.updateOne;
    const origTxSave = Transaction.prototype.save;

    try {
      User.findOne = async () => null;
      User.findOneAndUpdate = async () => ({ _id: new mongoose.Types.ObjectId(), balance: 25.0 });
      User.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });
      TopupRequest.findOneAndUpdate = async () => ({ _id: new mongoose.Types.ObjectId(), status: 'confirmed' });
      TopupRequest.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });
      Transaction.prototype.save = async function () { return this; };

      require('../src/services/blockchain.service').verifyUidUsdt = async () => ({
        success: true,
        matches: [
          { txID: 'tx_already_in_invoice', amount: 15.0 },
          { txID: 'tx_already_in_topup', amount: 20.0 },
          { txID: 'tx_brand_new_valid', amount: 25.0 },
        ],
      });

      // tx_already_in_invoice exists in BybitInvoice
      BybitInvoice.findOne = async (filter) => {
        if (filter.txId === 'tx_already_in_invoice') {
          return { _id: new mongoose.Types.ObjectId(), txId: 'tx_already_in_invoice' };
        }
        return null;
      };

      // tx_already_in_topup exists in TopupRequest
      TopupRequest.findOne = async (filter) => {
        if (filter.txid === 'tx_already_in_topup') {
          return { _id: new mongoose.Types.ObjectId(), txid: 'tx_already_in_topup' };
        }
        return null;
      };

      // Call handleProofInput with UID network
      const ctxMockUid = {
        user: { _id: new mongoose.Types.ObjectId(), language: 'ru', bybitUid: '554135317' },
        session: {
          topup: {
            step: 'proof',
            method: 'bybit',
            network: 'uid',
            amountUSDT: 25.0,
            amountRUB: 2335,
          },
        },
        message: { text: '554135317' }, // UID input
        telegram: { deleteMessage: async () => {} },
        answerCbQuery: async () => {},
        reply: async () => {},
        editMessageText: async () => {},
      };

      // Capture request creation
      let createdRequestData = null;
      const origTopupSave = TopupRequest.prototype.save;
      TopupRequest.prototype.save = async function () {
        createdRequestData = this;
        return this;
      };

      await topupScene.handleTopupProof(ctxMockUid);

      assert(createdRequestData, 'TopupRequest must be created for unclaimed match');
      assert.strictEqual(
        createdRequestData.txid,
        'tx_brand_new_valid',
        'Topup must skip transfers existing in BybitInvoice or TopupRequest and pick unclaimed tx_brand_new_valid'
      );
      assert.strictEqual(createdRequestData.amount, 25.0);

      TopupRequest.prototype.save = origTopupSave;
    } finally {
      require('../src/services/blockchain.service').verifyUidUsdt = origBlockchainVerify;
      TopupRequest.findOne = origTopupFindOne;
      TopupRequest.findOneAndUpdate = origTopupFindOneAndUpdate;
      TopupRequest.updateOne = origTopupUpdateOne;
      BybitInvoice.findOne = origInvoiceFindOne;
      User.findOne = origUserFindOne;
      User.findOneAndUpdate = origUserFindOneAndUpdate;
      User.updateOne = origUserUpdateOne;
      Transaction.prototype.save = origTxSave;
    }

    console.log('  ✅ Test 7 Passed: Bybit query includes coin=USDT&limit=50 and deduplicates across both TopupRequest and BybitInvoice.\n');
  }

  mongoose.startSession = origGlobalStartSession;
  console.log('🎉 ALL 7 FINANCIAL HARDENING TASKS VERIFIED SUCCESSFULLY! 🚀');
}

runFinancialHardeningTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
  });

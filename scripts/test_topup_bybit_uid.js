/**
 * scripts/test_topup_bybit_uid.js
 * Comprehensive tests for Bybit UID in top-up balance flow.
 */

const assert = require('assert');
const mongoose = require('mongoose');

const BybitInvoice = require('../src/models/BybitInvoice');
const TopupRequest = require('../src/models/TopupRequest');
const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const Settings = require('../src/models/Settings');

const mockUser = {
  _id: new mongoose.Types.ObjectId(),
  telegramId: 123456789,
  username: 'test_topup_user',
  balance: 10.0,
  language: 'ru',
  save: async function () { return this; },
};

async function runTests() {
  console.log('🧪 Starting Topup Bybit UID Verification Suite...\n');

  // Stub Settings
  const origSettingsFindOne = Settings.findOne;
  Settings.findOne = () => ({
    lean: async () => ({
      bybitEnabled: true,
      bybitUid: '554135317',
      plategaEnabled: true,
      cardEnabled: true,
      minTopup: 1,
      rate: 90.0,
    }),
  });

  // Test 1: Button label in showPaymentMethods
  console.log('Test 1: Topup Methods Menu displays Bybit UID');
  const topupScene = require('../src/bot/scenes/topup.scene');
  
  let capturedKeyboard = null;
  const ctxMock1 = {
    user: mockUser,
    session: { topup: { amountUSDT: 5 } },
    telegram: { editMessageText: async () => {} },
    answerCbQuery: async () => {},
    reply: async (text, opts) => {
      capturedKeyboard = opts?.reply_markup?.inline_keyboard;
    },
    editMessageText: async (text, opts) => {
      capturedKeyboard = opts?.reply_markup?.inline_keyboard;
    },
  };

  await topupScene.showPaymentMethods(ctxMock1);
  const bybitBtn = capturedKeyboard.flat().find(b => b.callback_data === 'topup:pay:bybit');
  assert(bybitBtn, 'Bybit button must exist in payment methods');
  assert(bybitBtn.text.includes('UID'), `Bybit button text "${bybitBtn.text}" must mention UID`);
  console.log(`  ✅ Test 1 Passed: Payment methods button label is: "${bybitBtn.text}"\n`);

  // Test 2: Network selection options in showBybitOptions
  console.log('Test 2: Bybit Network Options include Bybit UID');
  let bybitOptionsKeyboard = null;
  const ctxMock2 = {
    user: mockUser,
    session: { topup: { amountUSDT: 5, amountRUB: 450 } },
    answerCbQuery: async () => {},
    reply: async (text, opts) => {
      bybitOptionsKeyboard = opts?.reply_markup?.inline_keyboard;
    },
    editMessageText: async (text, opts) => {
      bybitOptionsKeyboard = opts?.reply_markup?.inline_keyboard;
    },
  };

  await topupScene.showBybitOptions(ctxMock2);
  const uidOption = bybitOptionsKeyboard.flat().find(b => b.callback_data === 'topup:network:uid');
  assert(uidOption, 'Bybit UID option button must exist');
  assert(uidOption.text.includes('UID'), `Bybit UID option text "${uidOption.text}" must include UID`);
  console.log(`  ✅ Test 2 Passed: Option found: "${uidOption.text}" -> ${uidOption.callback_data}\n`);

  // Test 3: Creating Topup Bybit Invoice
  console.log('Test 3: Bybit UID invoice creation for top-up');
  const bybitUidPaymentService = require('../src/services/bybitUidPayment.service');
  
  // Stub BybitInvoice
  const origFind = BybitInvoice.find;
  const origCount = BybitInvoice.countDocuments;
  const origExists = BybitInvoice.exists;
  const origSave = BybitInvoice.prototype.save;
  const origTopupSave = TopupRequest.prototype.save;
  const origTxSave = Transaction.prototype.save;
  
  BybitInvoice.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });
  BybitInvoice.countDocuments = async () => 0;
  BybitInvoice.exists = async () => false;
  BybitInvoice.prototype.save = async function() { return this; };
  TopupRequest.prototype.save = async function() { return this; };
  Transaction.prototype.save = async function() { return this; };

  const invoice = await bybitUidPaymentService.createInvoice({
    userId: mockUser._id,
    baseAmount: 5.0,
  });

  assert(invoice.invoiceNumber.startsWith('TOP-'), `Top-up invoice must start with TOP-, got ${invoice.invoiceNumber}`);
  assert.strictEqual(invoice.baseAmount, 5.0, `Base amount should be 5.0, got ${invoice.baseAmount}`);
  assert(invoice.exactAmount > 5.0, `Exact amount must have suffix, got ${invoice.exactAmount}`);
  assert.strictEqual(invoice.adminUid, '554135317', `Admin UID should be default 554135317, got ${invoice.adminUid}`);
  console.log(`  ✅ Test 3 Passed: Invoice created: ${invoice.invoiceNumber}, exactAmount: ${invoice.exactAmount}, adminUid: ${invoice.adminUid}\n`);

  // Test 4: Check Invoice Fulfillment for Top-up
  console.log('Test 4: Topup invoice completion updates balance & displays success screen');
  const shopScene = require('../src/bot/scenes/shop.scene');

  // Stub model queries for fulfillment
  BybitInvoice.findById = async () => invoice;
  BybitInvoice.findOne = async (query) => {
    if (query?.txId) return null;
    return invoice;
  };
  TopupRequest.findOne = async () => null;
  User.updateOne = async (query, update) => {
    if (update.$inc?.balance) {
      mockUser.balance += update.$inc.balance;
    }
    return { modifiedCount: 1 };
  };
  User.findById = async () => mockUser;

  const mockDepositRecords = [
    {
      id: 'tx-topup-verify-001',
      coin: 'USDT',
      amount: String(invoice.exactAmount),
      status: 2, // Success
      fromAddress: 'user-bybit-app',
      toAddress: invoice.adminUid,
      createdTime: String(Date.now()),
    },
  ];

  let checkSuccessText = '';
  let checkSuccessButtons = null;

  const ctxMockCheck = {
    user: mockUser,
    session: { bybitUidInvoice: { invoiceId: invoice._id, isTopup: true } },
    answerCbQuery: async () => {},
    reply: async (text, opts) => {
      checkSuccessText = text;
      checkSuccessButtons = opts?.reply_markup?.inline_keyboard;
    },
    editMessageText: async (text, opts) => {
      checkSuccessText = text;
      checkSuccessButtons = opts?.reply_markup?.inline_keyboard;
    },
    telegram: {
      sendMessage: async () => {},
    },
  };

  const checkResult = await bybitUidPaymentService.checkInvoice(invoice._id, {
    mockRecords: mockDepositRecords,
    bot: ctxMockCheck,
  });

  assert(checkResult.success === true, `Invoice check should succeed: ${checkResult.reason}`);
  assert(checkResult.topupRequest, 'TopupRequest must be created');

  await shopScene.handleBybitUidCheck(ctxMockCheck, invoice._id);
  assert(checkSuccessText.includes('Пополнение через Bybit UID подтверждено'), `Text must confirm topup: ${checkSuccessText}`);
  assert(checkSuccessButtons.flat().some(b => b.callback_data === 'menu:profile'), 'Must have profile button');
  console.log(`  ✅ Test 4 Passed: Topup confirmed screen displayed correctly:\n${checkSuccessText}\n`);

  // Test 5: Invoice cancellation returns to Bybit options
  console.log('Test 5: Topup invoice cancellation returns to Bybit options');
  const cancelInvoiceObj = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: 'TOP-00000002',
    baseAmount: 10.0,
    exactAmount: 10.0035,
    status: 'pending',
    save: async function() { this.status = 'cancelled'; return this; },
  };
  BybitInvoice.findOne = async () => cancelInvoiceObj;
  BybitInvoice.findById = async () => cancelInvoiceObj;

  let returnToBybitOptionsCalled = false;
  const ctxMockCancel = {
    user: mockUser,
    session: {
      bybitUidInvoice: { invoiceId: cancelInvoiceObj._id, isTopup: true },
      topup: { amountUSDT: 10.0, step: 'method' },
    },
    answerCbQuery: async () => {},
    reply: async (text, opts) => {
      returnToBybitOptionsCalled = true;
    },
    editMessageText: async (text, opts) => {
      returnToBybitOptionsCalled = true;
    },
  };

  await shopScene.handleBybitUidCancel(ctxMockCancel, cancelInvoiceObj._id);
  assert(returnToBybitOptionsCalled, 'Should navigate back to Bybit options upon cancelling top-up invoice');
  console.log('  ✅ Test 5 Passed: Cancellation cleanly returns to Bybit options menu.\n');

  // Restore stubs
  BybitInvoice.find = origFind;
  BybitInvoice.countDocuments = origCount;
  BybitInvoice.exists = origExists;
  Settings.findOne = origSettingsFindOne;

  console.log('🎉 ALL TOPUP BYBIT UID TESTS PASSED! 🚀');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

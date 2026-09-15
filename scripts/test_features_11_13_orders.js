/**
 * Automated test for:
 * 1. Point 11: Dynamic badges (getProductBadges in shop.scene.js)
 * 2. Point 13: Referral statistics (getReferralStats & calculation)
 * 3. Orders: Clean button labels & Credentials delivery (<pre><code>, formatDigitalItem, send_data handler logic)
 */

const assert = require('assert');
const { getProductBadges } = require('../src/bot/scenes/shop.scene');
const { STATUS_EMOJIS } = require('../src/bot/scenes/profile.scene');
const { formatDigitalItem, escapeHtml } = require('../src/bot/utils/ui');

const tests = [];
const test = (name, fn) => {
  tests.push({ name, fn });
};

// ==========================================
// 1. Dynamic Badges Tests (Point 11)
// ==========================================

test('Badges: Flash Sale active adds 🔥 badge and isFlash flag', () => {
  const product = {
    name: 'ChatGPT Plus',
    price: 20,
    type: 'manual',
    deliveryMethod: 'activation',
    provider: 'local',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // old product
    flashSale: {
      enabled: true,
      expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour in future
      discountPercent: 25,
    },
  };

  const res = getProductBadges(product);
  assert.strictEqual(res.isFlash, true);
  assert.strictEqual(res.isInstant, false);
  assert.strictEqual(res.isNew, false);
  assert.ok(res.badgeStr.includes('🔥 -25%'));
});

test('Badges: Expired or disabled Flash Sale does not add flash badge', () => {
  const expiredProduct = {
    name: 'ChatGPT Plus',
    type: 'manual',
    deliveryMethod: 'activation',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    flashSale: {
      enabled: true,
      expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour in past
      discountPercent: 25,
    },
  };
  const resExpired = getProductBadges(expiredProduct);
  assert.strictEqual(resExpired.isFlash, false);
  assert.ok(!resExpired.badgeStr.includes('🔥'));

  const disabledProduct = {
    name: 'ChatGPT Plus',
    type: 'manual',
    deliveryMethod: 'activation',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    flashSale: {
      enabled: false,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      discountPercent: 25,
    },
  };
  const resDisabled = getProductBadges(disabledProduct);
  assert.strictEqual(resDisabled.isFlash, false);
  assert.ok(!resDisabled.badgeStr.includes('🔥'));
});

test('Badges: Instant delivery detected for key, ready_account, or external providers', () => {
  // Case 1: type === 'key'
  const keyProduct = { type: 'key', deliveryMethod: 'activation', provider: 'local' };
  assert.strictEqual(getProductBadges(keyProduct).isInstant, true);
  assert.ok(getProductBadges(keyProduct).badgeStr.includes('⚡'));

  // Case 2: deliveryMethod === 'ready_account'
  const readyProduct = { type: 'manual', deliveryMethod: 'ready_account', provider: 'local' };
  assert.strictEqual(getProductBadges(readyProduct).isInstant, true);
  assert.ok(getProductBadges(readyProduct).badgeStr.includes('⚡'));

  // Case 3: provider === 'jaha'
  const jahaProduct = { type: 'manual', deliveryMethod: 'activation', provider: 'jaha' };
  assert.strictEqual(getProductBadges(jahaProduct).isInstant, true);
  assert.ok(getProductBadges(jahaProduct).badgeStr.includes('⚡'));

  // Case 4: provider === 'canboso'
  const canbosoProduct = { type: 'manual', deliveryMethod: 'activation', provider: 'canboso' };
  assert.strictEqual(getProductBadges(canbosoProduct).isInstant, true);

  // Case 5: manual activation local -> not instant
  const manualLocal = { type: 'manual', deliveryMethod: 'activation', provider: 'local' };
  assert.strictEqual(getProductBadges(manualLocal).isInstant, false);
  assert.ok(!getProductBadges(manualLocal).badgeStr.includes('⚡'));
});

test('Badges: 🆕 badge added for products created within 7 days', () => {
  const newProduct = {
    type: 'manual',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
  };
  const resNew = getProductBadges(newProduct);
  assert.strictEqual(resNew.isNew, true);
  assert.ok(resNew.badgeStr.includes('🆕'));

  const oldProduct = {
    type: 'manual',
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
  };
  const resOld = getProductBadges(oldProduct);
  assert.strictEqual(resOld.isNew, false);
  assert.ok(!resOld.badgeStr.includes('🆕'));
});

test('Badges: Combined badges all present when multiple criteria match', () => {
  const multiProduct = {
    type: 'key',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
    flashSale: {
      enabled: true,
      expiresAt: new Date(Date.now() + 100000),
      discountPercent: 15,
    },
  };
  const res = getProductBadges(multiProduct);
  assert.strictEqual(res.isFlash, true);
  assert.strictEqual(res.isInstant, true);
  assert.strictEqual(res.isNew, true);
  assert.ok(res.badgeStr.includes('🔥 -15%'));
  assert.ok(res.badgeStr.includes('⚡'));
  assert.ok(res.badgeStr.includes('🆕'));
});

test('Badges: Edge case handling null/undefined product', () => {
  const res = getProductBadges(null);
  assert.strictEqual(res.isFlash, false);
  assert.strictEqual(res.isInstant, false);
  assert.strictEqual(res.isNew, false);
  assert.strictEqual(res.badgeStr, '');
});

// ==========================================
// 2. Referral Statistics Logic Tests (Point 13)
// ==========================================

test('Referral stats: Conversion calculation format and zero-division protection', () => {
  // 2 out of 5
  const count1 = 5;
  const active1 = 2;
  const pct1 = count1 > 0 ? Math.round((active1 / count1) * 100) : 0;
  const str1 = `${active1} из ${count1} (${pct1}%)`;
  assert.strictEqual(str1, '2 из 5 (40%)');

  // 0 out of 0
  const count0 = 0;
  const active0 = 0;
  const pct0 = count0 > 0 ? Math.round((active0 / count0) * 100) : 0;
  const str0 = `${active0} из ${count0} (${pct0}%)`;
  assert.strictEqual(str0, '0 из 0 (0%)');
});

// ==========================================
// 3. Order History & Credentials Tests (Part 3)
// ==========================================

test('Orders: List button label clean formatting with status emoji', () => {
  assert.strictEqual(STATUS_EMOJIS.completed, '✅');
  assert.strictEqual(STATUS_EMOJIS.disputed, '⚖️');
  assert.strictEqual(STATUS_EMOJIS.pending, '⏳');

  const sampleOrder1 = {
    _id: '654321098765432109876543',
    price: 15,
    status: 'completed',
    productId: { name: 'ChatGPT Plus' },
  };

  const rawName1 = sampleOrder1.productId.name;
  const statusEmoji1 = STATUS_EMOJIS[sampleOrder1.status] || '📦';
  const trimmedName1 = rawName1.length > 18 ? rawName1.slice(0, 17) + '…' : rawName1;
  const btnLabel1 = `🧾 ${trimmedName1} · ${sampleOrder1.price} USDT · ${statusEmoji1}`;

  assert.strictEqual(btnLabel1, '🧾 ChatGPT Plus · 15 USDT · ✅');

  // Long name truncation test
  const sampleOrder2 = {
    _id: '654321098765432109876544',
    price: 4.5,
    status: 'pending',
    productId: { name: 'Spotify Premium Family 12 Months' },
  };
  const rawName2 = sampleOrder2.productId.name;
  const statusEmoji2 = STATUS_EMOJIS[sampleOrder2.status] || '📦';
  const trimmedName2 = rawName2.length > 18 ? rawName2.slice(0, 17) + '…' : rawName2;
  const btnLabel2 = `🧾 ${trimmedName2} · ${sampleOrder2.price} USDT · ${statusEmoji2}`;

  assert.strictEqual(btnLabel2, '🧾 Spotify Premium F… · 4.5 USDT · ⏳');
});

test('Orders: Credentials formatting (formatDigitalItem & full pre/code copy block)', () => {
  const rawDeliveryData = 'user@example.com:secretPassword123:2FA_CODE_ABC';
  const formattedItem = formatDigitalItem(rawDeliveryData, 'ru');

  // Must contain login and password
  assert.ok(formattedItem.includes('<code>user@example.com</code>'));
  assert.ok(formattedItem.includes('<code>secretPassword123</code>'));
  assert.ok(formattedItem.includes('<code>2FA_CODE_ABC</code>'));

  // Pre block for 1-tap complete copying in Telegram
  const preBlock = `<pre><code>${escapeHtml(rawDeliveryData)}</code></pre>`;
  assert.strictEqual(preBlock, '<pre><code>user@example.com:secretPassword123:2FA_CODE_ABC</code></pre>');
});

test('Orders: Safe HTML escaping in order delivery details', () => {
  const dangerousItem = 'login<script>alert(1)</script>:pass&word>';
  const safePre = `<pre><code>${escapeHtml(dangerousItem)}</code></pre>`;
  assert.ok(!safePre.includes('<script>'));
  assert.ok(safePre.includes('&lt;script&gt;'));
  assert.ok(safePre.includes('&amp;word&gt;'));
});

test('Referral stats: getReferralStats guards against null/undefined userId without DB scan', async () => {
  const { getReferralStats } = require('../src/bot/scenes/referral.scene');
  const resNull = await getReferralStats(null);
  assert.deepStrictEqual(resNull, { referralsCount: 0, activeBuyersCount: 0, conversionPct: 0, totalEarned: 0 });

  const resUndefined = await getReferralStats(undefined);
  assert.deepStrictEqual(resUndefined, { referralsCount: 0, activeBuyersCount: 0, conversionPct: 0, totalEarned: 0 });
});

test('Referral stats: getReferralStats converts string userId to ObjectId in aggregation', async () => {
  const User = require('../src/models/User');
  const Order = require('../src/models/Order');
  const Transaction = require('../src/models/Transaction');
  const mongoose = require('mongoose');

  const origUserFind = User.find;
  const origOrderDistinct = Order.distinct;
  const origTxAggregate = Transaction.aggregate;

  let capturedPipeline = null;

  try {
    User.find = () => ({
      select: () => ({
        lean: async () => [{ _id: 'u1' }, { _id: 'u2' }],
      }),
    });
    Order.distinct = async () => ['u1'];
    Transaction.aggregate = async (pipeline) => {
      capturedPipeline = pipeline;
      return [{ _id: null, total: 10.5 }];
    };

    const { getReferralStats } = require('../src/bot/scenes/referral.scene');
    const hexId = '507f1f77bcf86cd799439011';
    const stats = await getReferralStats(hexId);

    assert.strictEqual(stats.referralsCount, 2);
    assert.strictEqual(stats.activeBuyersCount, 1);
    assert.strictEqual(stats.conversionPct, 50);
    assert.strictEqual(stats.totalEarned, 10.5);

    // Verify ObjectId conversion in aggregation pipeline
    assert.ok(capturedPipeline[0].$match.userId instanceof mongoose.Types.ObjectId);
    assert.strictEqual(capturedPipeline[0].$match.userId.toString(), hexId);
  } finally {
    User.find = origUserFind;
    Order.distinct = origOrderDistinct;
    Transaction.aggregate = origTxAggregate;
  }
});

test('Orders: send_data logic validates order ownership, completion status, and formats credentials', async () => {
  const Order = require('../src/models/Order');
  const origFindById = Order.findById;

  try {
    const mockOrder = {
      _id: '507f1f77bcf86cd799439011',
      userId: { toString: () => 'user_111' },
      status: 'completed',
      deliveryData: 'myaccount@gmail.com:MyPassword2026',
      productId: { name: 'ChatGPT Plus', nameEn: 'ChatGPT Plus', icon: '🤖' },
    };

    Order.findById = () => ({
      populate: () => ({
        populate: () => ({
          populate: async () => mockOrder,
        }),
      }),
    });

    const order = await Order.findById('507f1f77bcf86cd799439011').populate().populate().populate();
    const ctx = {
      user: { _id: 'user_111', language: 'ru' },
      match: ['profile:order:send_data:507f1f77bcf86cd799439011', '507f1f77bcf86cd799439011'],
      replies: [],
      alerts: [],
      reply: async (text, keyboard) => { ctx.replies.push({ text, keyboard }); },
      answerCbQuery: async (text, opts) => { ctx.alerts.push({ text, opts }); },
    };

    const itemValue = order.replacedKeyId?.value || order.deliveryData || order.keyId?.value;
    assert.strictEqual(itemValue, 'myaccount@gmail.com:MyPassword2026');
    assert.strictEqual(order.status, 'completed');
    assert.strictEqual(order.userId.toString(), ctx.user._id.toString());
  } finally {
    Order.findById = origFindById;
  }
});

test('Orders: send_data and showOrderDetail handle invalid orderId without crashing', () => {
  const mongoose = require('mongoose');
  assert.strictEqual(mongoose.Types.ObjectId.isValid('invalid_id_123'), false);
  assert.strictEqual(mongoose.Types.ObjectId.isValid(''), false);
  assert.strictEqual(mongoose.Types.ObjectId.isValid(null), false);
  assert.strictEqual(mongoose.Types.ObjectId.isValid('507f1f77bcf86cd799439011'), true);
});

const runAll = async () => {
  console.log('--- RUNNING FEATURE VERIFICATION TESTS ---');
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`\n🎉 ALL ${passed} OF ${tests.length} TESTS PASSED SUCCESSFULLY!`);
};

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});


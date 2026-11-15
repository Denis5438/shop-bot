const assert = require('assert');
const Settings = require('../src/models/Settings');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const PromoCode = require('../src/models/PromoCode');
const settingsScene = require('../src/bot/scenes/admin/settings.scene');
const { invalidateCache, getCachedSettingsSync } = require('../src/services/settingsCache.service');
const {
  ACHIEVEMENTS,
  computeUserStats,
  checkAndGrantAchievements,
  getAllWithProgress,
  renderAchievementsText,
} = require('../src/services/achievements.service');

async function runVerificationSuite() {
  console.log('🧪 Starting Full Achievement Rewards & Admin Toggle Verification Suite...\n');

  // =========================================================================
  // Test 1: Settings Schema & Default Values
  // =========================================================================
  console.log('Test 1: Settings schema & default values');
  const path = Settings.schema.paths.achievementRewardsEnabled;
  assert(path, 'achievementRewardsEnabled field must exist in Settings schema');
  assert.strictEqual(path.instance, 'Boolean', 'achievementRewardsEnabled must be Boolean');
  assert.strictEqual(path.defaultValue, false, 'achievementRewardsEnabled must default to false in schema');

  const defaultSettingsInstance = new Settings({});
  assert.strictEqual(
    defaultSettingsInstance.achievementRewardsEnabled,
    false,
    'New Settings instance without params must have achievementRewardsEnabled === false'
  );

  console.log('  ✅ Test 1 Passed: Settings schema and default value verified.\n');

  // =========================================================================
  // Test 2: Admin Scene Toggle Logic & Status Rendering
  // =========================================================================
  console.log('Test 2: Admin Scene toggleAchievementRewards & showSettings');
  assert.strictEqual(
    typeof settingsScene.toggleAchievementRewards,
    'function',
    'toggleAchievementRewards must be exported from settings.scene.js'
  );

  let currentSettingsDoc = {
    _id: 'settings_global',
    name: 'global',
    achievementRewardsEnabled: false,
    maintenanceMode: false,
    currencyMode: 'bybit_p2p',
    save: async function () {
      return this;
    },
  };

  // Mock Settings.findOne to return our doc for getLiveSettings
  const origFindOne = Settings.findOne;
  Settings.findOne = async () => currentSettingsDoc;

  try {
    let cbAnswered = false;
    let answerText = '';
    const mockCtx = {
      answerCbQuery: async (msg) => {
        cbAnswered = true;
        answerText = msg;
      },
      editMessageText: async (text, keyboard) => {
        mockCtx.lastRenderedText = text;
        mockCtx.lastRenderedKeyboard = keyboard;
      },
      reply: async (text, keyboard) => {
        mockCtx.lastRenderedText = text;
        mockCtx.lastRenderedKeyboard = keyboard;
      },
    };

    // Toggle 1: false -> true
    await settingsScene.toggleAchievementRewards(mockCtx);
    assert.strictEqual(currentSettingsDoc.achievementRewardsEnabled, true, 'Should toggle from false to true');
    assert.ok(answerText.includes('включены'), `Feedback text should mention enabled: ${answerText}`);
    assert.ok(
      mockCtx.lastRenderedText.includes('🏆 Награды ачивок: <b>🟢 Вкл</b>'),
      'showSettings text must display 🟢 Вкл'
    );

    // Toggle 2: true -> false
    cbAnswered = false;
    answerText = '';
    await settingsScene.toggleAchievementRewards(mockCtx);
    assert.strictEqual(currentSettingsDoc.achievementRewardsEnabled, false, 'Should toggle from true to false');
    assert.ok(answerText.includes('выключены'), `Feedback text should mention disabled: ${answerText}`);
    assert.ok(
      mockCtx.lastRenderedText.includes('🏆 Награды ачивок: <b>🔴 Выкл</b>'),
      'showSettings text must display 🔴 Выкл'
    );

    // Verify inline button exists and has correct callback data
    let foundBtn = false;
    const inlineButtons = mockCtx.lastRenderedKeyboard?.reply_markup?.inline_keyboard || [];
    for (const row of inlineButtons) {
      for (const btn of row) {
        if (btn.callback_data === 'settings:toggle:achievementRewards') {
          foundBtn = true;
          assert.ok(btn.text.includes('🏆 Награды ачивок:'), 'Button text should describe achievement rewards');
        }
      }
    }
    assert.ok(foundBtn, 'Inline keyboard must contain button with callback settings:toggle:achievementRewards');
  } finally {
    Settings.findOne = origFindOne;
  }
  console.log('  ✅ Test 2 Passed: Admin toggle and UI rendering verified.\n');

  // =========================================================================
  // Test 3: Referral Count Logic & Abuse Prevention (computeUserStats)
  // =========================================================================
  console.log('Test 3: computeUserStats referral abuse protection');
  const origUserDistinct = User.distinct;
  const origUserFind = User.find;
  const origOrderCount = Order.countDocuments;
  const origOrderDistinct = Order.distinct;

  try {
    // Scenario 3.1: 5 users registered via referral link (/start only), 0 completed orders
    User.distinct = async (field, filter) => {
      assert.strictEqual(filter.referredBy, 'inviter_id_1');
      return ['ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
    };
    Order.countDocuments = async () => 3; // completed orders of inviter itself
    Order.distinct = async (field, filter) => {
      // Return empty because none of them completed an order
      return [];
    };

    let stats = await computeUserStats('inviter_id_1');
    assert.strictEqual(stats.completedOrdersCount, 3);
    assert.strictEqual(stats.referredCount, 0, 'Referred users without completed orders must NOT be counted');

    // Scenario 3.2: 4 registered referrals: 1 has cancelled order, 1 pending, 2 completed
    Order.distinct = async (field, filter) => {
      assert.strictEqual(filter.status, 'completed', 'Must query exclusively status completed');
      assert.deepStrictEqual(filter.userId, { $in: ['ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'] });
      return ['ref_1', 'ref_3']; // only ref_1 and ref_3 have completed orders
    };

    stats = await computeUserStats('inviter_id_1');
    assert.strictEqual(stats.referredCount, 2, 'Must count only referred users who completed orders');

    // Scenario 3.3: Referred user with multiple completed orders must be counted only once
    Order.distinct = async () => ['ref_1']; // distinct returns set of user IDs
    stats = await computeUserStats('inviter_id_1');
    assert.strictEqual(stats.referredCount, 1, 'Distinct referred users with completed orders must count as 1');

    // Scenario 3.4: Inviter with no referred users at all
    User.distinct = async () => [];
    stats = await computeUserStats('inviter_id_none');
    assert.strictEqual(stats.referredCount, 0, 'No referrals must yield referredCount: 0');
  } finally {
    User.distinct = origUserDistinct;
    User.find = origUserFind;
    Order.countDocuments = origOrderCount;
    Order.distinct = origOrderDistinct;
  }
  console.log('  ✅ Test 3 Passed: Referral count logic correctly prevents farming abuse.\n');

  // =========================================================================
  // Test 4: Achievement Rewards Disabled (achievementRewardsEnabled === false)
  // =========================================================================
  console.log('Test 4: checkAndGrantAchievements when achievementRewardsEnabled === false');
  const origFindById = User.findById;
  const origFindOneAndUpdate = User.findOneAndUpdate;
  const origPromoCreate = PromoCode.create;
  const origPromoFindOne = PromoCode.findOne;

  try {
    const mockUser = {
      _id: 'user_test_disabled',
      telegramId: 10001,
      balance: 50.00,
      totalSpent: 0,
      achievements: [],
    };

    User.findById = async () => mockUser;
    User.findOneAndUpdate = async (filter, update) => {
      assert.ok(update.$push?.achievements, 'Achievement must be recorded in achievements array');
      assert.strictEqual(update.$inc, undefined, 'Must NEVER $inc balance when rewards are disabled');
      mockUser.achievements.push(update.$push.achievements);
      return mockUser;
    };

    let promoCodeCreated = false;
    PromoCode.create = async () => {
      promoCodeCreated = true;
      throw new Error('PromoCode.create must NOT be called when achievementRewardsEnabled is false');
    };

    User.distinct = async () => [];
    Order.countDocuments = async () => 1; // Unlocks first_purchase

    const unlocked = await checkAndGrantAchievements('user_test_disabled', {
      silent: true,
      settings: { achievementRewardsEnabled: false },
    });

    assert.strictEqual(unlocked.length, 1, 'first_purchase achievement should be unlocked');
    assert.strictEqual(mockUser.balance, 50.00, 'User balance must remain unchanged at 50.00');
    assert.strictEqual(promoCodeCreated, false, 'No PromoCode must be created');
    assert.strictEqual(unlocked[0].rewardGranted, false, 'rewardGranted must be false');
    assert.strictEqual(unlocked[0].bonusGranted, false, 'bonusGranted must be false');
    assert.strictEqual(unlocked[0].promoCode, null, 'promoCode must be null');
  } finally {
    User.findById = origFindById;
    User.findOneAndUpdate = origFindOneAndUpdate;
    PromoCode.create = origPromoCreate;
  }
  console.log('  ✅ Test 4 Passed: When disabled, achievements unlock cosmetically with 0 balance credit and 0 coupons.\n');

  // =========================================================================
  // Test 5: Achievement Rewards Enabled (achievementRewardsEnabled === true)
  // =========================================================================
  console.log('Test 5: checkAndGrantAchievements when achievementRewardsEnabled === true');
  try {
    const mockUser = {
      _id: 'user_test_enabled',
      telegramId: 20002,
      balance: 25.50,
      totalSpent: 120, // qualifies for spent_20, spent_50, spent_100
      achievements: [],
    };

    User.findById = async () => mockUser;
    User.findOneAndUpdate = async (filter, update) => {
      assert.strictEqual(update.$inc, undefined, 'Must NEVER credit balance directly even when rewards are enabled!');
      mockUser.achievements.push(update.$push.achievements);
      return mockUser;
    };

    const createdPromoDocs = [];
    PromoCode.findOne = async () => null; // all generated codes are unique
    PromoCode.create = async (doc) => {
      createdPromoDocs.push(doc);
      return doc;
    };

    // User has 10 completed orders, and 5 active referrals
    Order.countDocuments = async () => 10;
    User.distinct = async () => ['ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];
    Order.distinct = async () => ['ref_1', 'ref_2', 'ref_3', 'ref_4', 'ref_5'];

    const unlocked = await checkAndGrantAchievements('user_test_enabled', {
      silent: true,
      settings: { achievementRewardsEnabled: true },
    });

    // All 8 achievements should unlock:
    // first_purchase, five_orders, ten_orders, spent_20, spent_50, spent_100, first_referral, five_referrals
    assert.strictEqual(unlocked.length, 8, 'All 8 achievements should be unlocked');
    assert.strictEqual(mockUser.balance, 25.50, 'User balance must NEVER be credited directly (remains 25.50)');

    assert.strictEqual(createdPromoDocs.length, 8, 'Exactly 8 PromoCodes must be created');

    const expectedSpecs = {
      first_purchase: { discount: 0.50, minOrderAmount: 10 },
      five_orders:    { discount: 1.50, minOrderAmount: 20 },
      ten_orders:     { discount: 3.00, minOrderAmount: 40 },
      spent_20:       { discount: 1.00, minOrderAmount: 15 },
      spent_50:       { discount: 2.50, minOrderAmount: 35 },
      spent_100:      { discount: 5.00, minOrderAmount: 60 },
      first_referral: { discount: 0.50, minOrderAmount: 10 },
      five_referrals: { discount: 2.50, minOrderAmount: 30 },
    };

    for (const [code, spec] of Object.entries(expectedSpecs)) {
      const achKey = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const promo = createdPromoDocs.find((p) => p.code.includes(achKey));
      assert(promo, `Promo code for achievement ${code} must be created`);
      assert.strictEqual(promo.type, 'fixed', `${code} promo type must be fixed`);
      assert.strictEqual(promo.value, spec.discount, `${code} discount value mismatch`);
      assert.strictEqual(promo.minOrderAmount, spec.minOrderAmount, `${code} minOrderAmount mismatch`);
      assert.strictEqual(promo.maxActivations, 1, `${code} maxActivations must be 1 (single-use)`);
      assert.strictEqual(promo.maxPerUser, 1, `${code} maxPerUser must be 1`);
      assert.strictEqual(promo.isActive, true, `${code} isActive must be true`);
    }

    // Test Idempotence: running checkAndGrantAchievements again should create NO new promos
    const secondRun = await checkAndGrantAchievements('user_test_enabled', {
      silent: true,
      settings: { achievementRewardsEnabled: true },
    });
    assert.strictEqual(secondRun.length, 0, 'Subsequent checks must not re-grant achievements or coupons');
    assert.strictEqual(createdPromoDocs.length, 8, 'No additional promo codes must be created on second run');
  } finally {
    User.findById = origFindById;
    User.findOneAndUpdate = origFindOneAndUpdate;
    PromoCode.create = origPromoCreate;
    PromoCode.findOne = origPromoFindOne;
    User.distinct = origUserDistinct;
    Order.countDocuments = origOrderCount;
    Order.distinct = origOrderDistinct;
  }
  console.log('  ✅ Test 5 Passed: All 8 coupons generated with exact MOV/discount specs without crediting balance.\n');

  // =========================================================================
  // Test 6: Profile Scene & renderAchievementsText
  // =========================================================================
  console.log('Test 6: renderAchievementsText and profile display');
  const sampleItems = [
    {
      code: 'first_purchase',
      title: { ru: 'Первая покупка', en: 'First Purchase' },
      description: { ru: 'Совершите первую успешную покупку', en: 'Make your first successful purchase' },
      icon: '🎉',
      unlocked: false,
      rewardDiscount: 0.50,
      minOrderAmount: 10,
      progress: { current: 0, target: 1 },
    },
    {
      code: 'spent_100',
      title: { ru: 'Элита', en: 'Elite' },
      description: { ru: 'Потратьте 100 USDT', en: 'Spend 100 USDT' },
      icon: '👑',
      unlocked: false,
      rewardDiscount: 5.00,
      minOrderAmount: 60,
      progress: { current: 20, target: 100 },
    },
  ];

  // 6.1 Disabled mode: NO rewards shown, NO raw USDT
  const textDisabled = renderAchievementsText(sampleItems, 'ru', { achievementRewardsEnabled: false });
  assert.ok(!textDisabled.includes('💰'), 'Disabled mode must not show 💰 reward emoji');
  assert.ok(!textDisabled.includes('Награда:'), 'Disabled mode must not show Награда:');
  assert.ok(!textDisabled.includes('купон'), 'Disabled mode must not show купон');
  assert.ok(!/\+\d+(\.\d+)?\s*USDT/i.test(textDisabled), 'Disabled mode must not show +X USDT balance reward');

  // 6.2 Enabled mode (RU): shows купон $X от $Y
  const textEnabledRu = renderAchievementsText(sampleItems, 'ru', { achievementRewardsEnabled: true });
  assert.ok(!textEnabledRu.includes('💰'), 'Enabled mode must not show 💰 balance emoji');
  assert.ok(!/\+\d+(\.\d+)?\s*USDT/i.test(textEnabledRu), 'Enabled mode must not show +X USDT balance reward');
  assert.ok(
    textEnabledRu.includes('🎁 Награда: купон $0.50 от $10'),
    `RU Enabled mode must show coupon info: ${textEnabledRu}`
  );
  assert.ok(
    textEnabledRu.includes('🎁 Награда: купон $5.00 от $60'),
    `RU Enabled mode must show coupon info for spent_100: ${textEnabledRu}`
  );

  // 6.3 Enabled mode (EN): shows coupon $X off orders >= $Y
  const textEnabledEn = renderAchievementsText(sampleItems, 'en', { achievementRewardsEnabled: true });
  assert.ok(!textEnabledEn.includes('💰'), 'EN Enabled mode must not show 💰 balance emoji');
  assert.ok(!/\+\d+(\.\d+)?\s*USDT/i.test(textEnabledEn), 'EN Enabled mode must not show +X USDT balance reward');
  assert.ok(
    textEnabledEn.includes('🎁 Reward: coupon $0.50 off orders >= $10'),
    `EN Enabled mode must show coupon info: ${textEnabledEn}`
  );

  console.log('  ✅ Test 6 Passed: renderAchievementsText displays coupons with MOV and avoids USDT text.\n');

  console.log('🎉 ALL ACHIEVEMENT REWARDS & ADMIN TOGGLE TESTS PASSED SUCCESSFULLY! 🚀');
}

runVerificationSuite().catch((err) => {
  console.error('❌ Verification suite failed with error:', err);
  process.exit(1);
});

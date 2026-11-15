const assert = require('assert');
const {
  ACHIEVEMENTS,
  computeUserStats,
  checkAndGrantAchievements,
  renderAchievementsText,
} = require('../src/services/achievements.service');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const PromoCode = require('../src/models/PromoCode');

console.log('🧪 Starting Rewards & Achievements Unit Tests...\n');

// 1. Verify ACHIEVEMENTS definitions
console.log('Test 1: Verify reward configurations for all 8 achievements');
const expectedRewards = {
  first_purchase: { discount: 0.50, minOrderAmount: 10 },
  five_orders:    { discount: 1.50, minOrderAmount: 20 },
  ten_orders:     { discount: 3.00, minOrderAmount: 40 },
  spent_20:       { discount: 1.00, minOrderAmount: 15 },
  spent_50:       { discount: 2.50, minOrderAmount: 35 },
  spent_100:      { discount: 5.00, minOrderAmount: 60 },
  first_referral: { discount: 0.50, minOrderAmount: 10 },
  five_referrals: { discount: 2.50, minOrderAmount: 30 },
};

assert.strictEqual(ACHIEVEMENTS.length, 8, 'Must have exactly 8 achievements');
for (const ach of ACHIEVEMENTS) {
  const exp = expectedRewards[ach.code];
  assert.ok(exp, `Unexpected achievement code ${ach.code}`);
  assert.strictEqual(ach.rewardDiscount, exp.discount, `Discount mismatch for ${ach.code}`);
  assert.strictEqual(ach.minOrderAmount, exp.minOrderAmount, `minOrderAmount mismatch for ${ach.code}`);
  assert.strictEqual(ach.bonus, 0, `Bonus must be 0 for ${ach.code}`);
}
console.log('✅ Test 1 Passed: All 8 achievements have exact required coupon rewards and 0 bonus.\n');

// 2. Test computeUserStats referral abuse protection
console.log('Test 2: computeUserStats ignores inactive referrals (/start only)');
async function testComputeUserStats() {
  const origUserDistinct = User.distinct;
  const origOrderCount = Order.countDocuments;
  const origOrderDistinct = Order.distinct;

  try {
    // 3 referred users
    User.distinct = async () => ['u1', 'u2', 'u3'];
    Order.countDocuments = async () => 2; // completed orders for user

    // Scenario A: None of the referred users completed an order
    Order.distinct = async (field, filter) => {
      assert.strictEqual(field, 'userId');
      assert.deepStrictEqual(filter.userId, { $in: ['u1', 'u2', 'u3'] });
      assert.strictEqual(filter.status, 'completed');
      return [];
    };

    let stats = await computeUserStats('inviter1');
    assert.strictEqual(stats.completedOrdersCount, 2);
    assert.strictEqual(stats.referredCount, 0, 'Inactive referrals must count as 0');

    // Scenario B: 2 out of 3 referred users completed orders
    Order.distinct = async () => ['u1', 'u3'];
    stats = await computeUserStats('inviter1');
    assert.strictEqual(stats.referredCount, 2, 'Active referrals must count 2');

    // Scenario C: No referred users at all
    User.distinct = async () => [];
    Order.distinct = async () => { throw new Error('Should not be called when no referred users'); };
    stats = await computeUserStats('inviter1');
    assert.strictEqual(stats.referredCount, 0);
  } finally {
    User.distinct = origUserDistinct;
    Order.countDocuments = origOrderCount;
    Order.distinct = origOrderDistinct;
  }
}

// 3. Test checkAndGrantAchievements with rewards disabled
console.log('Test 3: checkAndGrantAchievements with achievementRewardsEnabled = false');
async function testRewardsDisabled() {
  const origFindById = User.findById;
  const origFindOneAndUpdate = User.findOneAndUpdate;
  const origPromoCreate = PromoCode.create;
  let promoCreated = false;

  try {
    const mockUser = {
      _id: 'user_1',
      telegramId: 12345,
      balance: 10.0,
      totalSpent: 0,
      achievements: [],
    };

    User.findById = async () => mockUser;
    User.findOneAndUpdate = async (filter, update) => {
      assert.ok(update.$push, 'Must push achievement');
      assert.strictEqual(update.$inc, undefined, 'Must NEVER $inc balance!');
      mockUser.achievements.push(update.$push.achievements);
      return mockUser;
    };
    PromoCode.create = async () => {
      promoCreated = true;
      throw new Error('PromoCode must NOT be created when rewards are disabled');
    };

    // Override User & Order for computeUserStats inside checkAndGrantAchievements
    const origUserDistinct = User.distinct;
    const origOrderCount = Order.countDocuments;
    User.distinct = async () => [];
    Order.countDocuments = async () => 1; // Unlocks first_purchase

    const unlocked = await checkAndGrantAchievements('user_1', {
      silent: true,
      settings: { achievementRewardsEnabled: false },
    });

    assert.strictEqual(unlocked.length, 1);
    assert.strictEqual(unlocked[0].achievement.code, 'first_purchase');
    assert.strictEqual(unlocked[0].rewardGranted, false);
    assert.strictEqual(unlocked[0].promoCode, null);
    assert.strictEqual(promoCreated, false, 'No promo code should be created');
    assert.strictEqual(mockUser.balance, 10.0, 'Balance must remain unchanged');

    User.distinct = origUserDistinct;
    Order.countDocuments = origOrderCount;
  } finally {
    User.findById = origFindById;
    User.findOneAndUpdate = origFindOneAndUpdate;
    PromoCode.create = origPromoCreate;
  }
}

// 4. Test checkAndGrantAchievements with rewards enabled
console.log('Test 4: checkAndGrantAchievements with achievementRewardsEnabled = true');
async function testRewardsEnabled() {
  const origFindById = User.findById;
  const origFindOneAndUpdate = User.findOneAndUpdate;
  const origPromoCreate = PromoCode.create;
  const origPromoFindOne = PromoCode.findOne;

  const createdPromos = [];

  try {
    const mockUser = {
      _id: 'user_2',
      telegramId: 99999,
      balance: 15.0,
      totalSpent: 100, // spent_20, spent_50, spent_100
      achievements: [],
    };

    User.findById = async () => mockUser;
    User.findOneAndUpdate = async (filter, update) => {
      assert.strictEqual(update.$inc, undefined, 'Must NEVER $inc balance with raw USDT!');
      mockUser.achievements.push(update.$push.achievements);
      return mockUser;
    };
    PromoCode.findOne = async () => null; // unique code
    PromoCode.create = async (doc) => {
      createdPromos.push(doc);
      return doc;
    };

    const origUserDistinct = User.distinct;
    const origOrderCount = Order.countDocuments;
    User.distinct = async () => [];
    Order.countDocuments = async () => 0;

    const unlocked = await checkAndGrantAchievements('user_2', {
      silent: true,
      settings: { achievementRewardsEnabled: true },
    });

    // Should unlock spent_20, spent_50, spent_100
    assert.strictEqual(unlocked.length, 3);
    assert.strictEqual(mockUser.balance, 15.0, 'Balance must NEVER be credited!');

    assert.strictEqual(createdPromos.length, 3, 'Must create 3 promo codes');
    for (const p of createdPromos) {
      assert.strictEqual(p.type, 'fixed');
      assert.strictEqual(p.maxActivations, 1);
      assert.strictEqual(p.currentActivations, 0);
      assert.strictEqual(p.maxPerUser, 1);
      assert.strictEqual(p.isActive, true);
      assert.ok(p.code.startsWith('ACH-'), `Promo code must start with ACH-: ${p.code}`);
    }

    const promo20 = createdPromos.find((p) => p.code.includes('SPENT20'));
    assert.strictEqual(promo20.value, 1.00);
    assert.strictEqual(promo20.minOrderAmount, 15);

    const promo50 = createdPromos.find((p) => p.code.includes('SPENT50'));
    assert.strictEqual(promo50.value, 2.50);
    assert.strictEqual(promo50.minOrderAmount, 35);

    const promo100 = createdPromos.find((p) => p.code.includes('SPENT100'));
    assert.strictEqual(promo100.value, 5.00);
    assert.strictEqual(promo100.minOrderAmount, 60);

    User.distinct = origUserDistinct;
    Order.countDocuments = origOrderCount;
  } finally {
    User.findById = origFindById;
    User.findOneAndUpdate = origFindOneAndUpdate;
    PromoCode.create = origPromoCreate;
    PromoCode.findOne = origPromoFindOne;
  }
}

// 5. Test renderAchievementsText
console.log('Test 5: renderAchievementsText display logic');
function testRenderAchievements() {
  const items = [
    {
      code: 'first_purchase',
      title: { ru: 'Первая покупка', en: 'First Purchase' },
      description: { ru: 'Совершите первую покупку', en: 'Make first purchase' },
      icon: '🎉',
      unlocked: false,
      rewardDiscount: 0.50,
      minOrderAmount: 10,
      progress: { current: 0, target: 1 },
    },
  ];

  // Case A: rewards disabled
  const textDisabledRu = renderAchievementsText(items, 'ru', { achievementRewardsEnabled: false });
  assert.ok(!textDisabledRu.includes('USDT'), 'Must NOT display USDT');
  assert.ok(!textDisabledRu.includes('Награда'), 'Must NOT display reward when disabled');

  const textDisabledEn = renderAchievementsText(items, 'en', { achievementRewardsEnabled: false });
  assert.ok(!textDisabledEn.includes('USDT'), 'Must NOT display USDT');
  assert.ok(!textDisabledEn.includes('Reward'), 'Must NOT display reward when disabled');

  // Case B: rewards enabled
  const textEnabledRu = renderAchievementsText(items, 'ru', { achievementRewardsEnabled: true });
  assert.ok(!textEnabledRu.includes('USDT'), 'Must NOT display raw USDT');
  assert.ok(textEnabledRu.includes('🎁 Награда: купон $0.50 от $10'), `Must display coupon MOV format: ${textEnabledRu}`);

  const textEnabledEn = renderAchievementsText(items, 'en', { achievementRewardsEnabled: true });
  assert.ok(!textEnabledEn.includes('USDT'), 'Must NOT display raw USDT');
  assert.ok(textEnabledEn.includes('🎁 Reward: coupon $0.50 off orders >= $10'), `Must display coupon MOV format in EN: ${textEnabledEn}`);
}

(async () => {
  await testComputeUserStats();
  console.log('✅ Test 2 Passed: computeUserStats ignores inactive referrals.\n');

  await testRewardsDisabled();
  console.log('✅ Test 3 Passed: checkAndGrantAchievements with rewards disabled works.\n');

  await testRewardsEnabled();
  console.log('✅ Test 4 Passed: checkAndGrantAchievements with rewards enabled creates valid promo codes without crediting balance.\n');

  testRenderAchievements();
  console.log('✅ Test 5 Passed: renderAchievementsText properly handles enabled/disabled coupon display.\n');

  console.log('🎉 ALL REWARDS & ACHIEVEMENTS TESTS PASSED!');
})();

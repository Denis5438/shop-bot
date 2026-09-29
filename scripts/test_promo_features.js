const assert = require('assert');
const { calculateDiscount } = require('../src/services/promo.service');

async function runTests() {
  console.log('🧪 Starting Promo Features Test Suite...\n');

  // ─── 1. Привязка к конкретному товару ───
  console.log('Test 1: Product-specific promo');
  const promoProduct = {
    code: 'PROD_ONLY',
    type: 'percent',
    value: 20,
    isActive: true,
    productId: '60d5ec49f1b2c8b1f8e4e1a1',
    minQuantity: 1,
    discountTarget: 'all',
    audienceCondition: 'all',
  };

  const resMatchingProduct = await calculateDiscount(
    promoProduct,
    100,
    '60d5ec49f1b2c8b1f8e4e1a1',
    { qty: 1 }
  );
  assert.strictEqual(resMatchingProduct.valid, true, 'Matching product should be valid');
  assert.strictEqual(resMatchingProduct.discountAmount, 20, 'Discount should be 20');
  assert.strictEqual(resMatchingProduct.finalPrice, 80, 'Final price should be 80');

  const resWrongProduct = await calculateDiscount(
    promoProduct,
    100,
    '60d5ec49f1b2c8b1f8e4e999',
    { qty: 1 }
  );
  assert.strictEqual(resWrongProduct.valid, false, 'Wrong product should be rejected');
  assert.match(resWrongProduct.reason, /не распространяется на данный товар/);

  const resNullProduct = await calculateDiscount(
    promoProduct,
    100,
    null,
    { qty: 1 }
  );
  assert.strictEqual(resNullProduct.valid, false, 'Null product should be rejected when promo has productId');

  // Промокод на все товары (productId: null)
  const promoAll = {
    code: 'ALL_PROD',
    type: 'percent',
    value: 10,
    isActive: true,
    productId: null,
    minQuantity: 1,
    discountTarget: 'all',
    audienceCondition: 'all',
  };
  const resAll1 = await calculateDiscount(promoAll, 50, 'any_id_1', { qty: 1 });
  assert.strictEqual(resAll1.valid, true, 'Global promo should apply to any product');
  const resAll2 = await calculateDiscount(promoAll, 50, 'any_id_2', { qty: 1 });
  assert.strictEqual(resAll2.valid, true, 'Global promo should apply to another product');
  console.log('  ✅ Product binding tests passed');

  // ─── 2. Минимальное количество (minQuantity) ───
  console.log('\nTest 2: minQuantity condition');
  const promoMin3 = {
    code: 'MIN_3_ITEMS',
    type: 'fixed',
    value: 15,
    isActive: true,
    productId: null,
    minQuantity: 3,
    discountTarget: 'all',
    audienceCondition: 'all',
  };

  const resQty1 = await calculateDiscount(promoMin3, 30, null, { qty: 1 });
  assert.strictEqual(resQty1.valid, false, 'qty < minQuantity should be rejected');
  assert.match(resQty1.reason, /от 3 шт/);

  const resQty2 = await calculateDiscount(promoMin3, 60, null, { qty: 2 });
  assert.strictEqual(resQty2.valid, false, 'qty = 2 with minQuantity 3 should be rejected');

  const resQty3 = await calculateDiscount(promoMin3, 90, null, { qty: 3 });
  assert.strictEqual(resQty3.valid, true, 'qty = 3 with minQuantity 3 should be accepted');
  assert.strictEqual(resQty3.discountAmount, 15);
  assert.strictEqual(resQty3.finalPrice, 75);

  const resQty5 = await calculateDiscount(promoMin3, 150, null, { qty: 5 });
  assert.strictEqual(resQty5.valid, true, 'qty = 5 with minQuantity 3 should be accepted');
  console.log('  ✅ minQuantity tests passed');

  // ─── 3. Скидка на 2-ю штуку (discountTarget: second_item) ───
  console.log('\nTest 3: second_item discount mechanics');
  const promoSecondItemPercent = {
    code: 'BUY1_GET_2ND_50',
    type: 'percent',
    value: 50, // 50% скидка на 2-ю штуку
    isActive: true,
    productId: null,
    minQuantity: 2,
    discountTarget: 'second_item',
    audienceCondition: 'all',
  };

  const resSecondQty1 = await calculateDiscount(promoSecondItemPercent, 20, null, { qty: 1 });
  assert.strictEqual(resSecondQty1.valid, false, 'second_item with qty = 1 should be rejected');
  assert.match(resSecondQty1.reason, /2-ю единицу товара/, 'Should display specific 1+1 reason');

  // 2 штуки по 10 USDT (orderAmount = 20). Скидка 50% на 1 единицу = 5 USDT. Итого: 15 USDT.
  const resSecondQty2 = await calculateDiscount(promoSecondItemPercent, 20, null, { qty: 2 });
  assert.strictEqual(resSecondQty2.valid, true);
  assert.strictEqual(resSecondQty2.discountAmount, 5, 'Discount should be 50% of 1 unit price');
  assert.strictEqual(resSecondQty2.finalPrice, 15, 'Final price should be 20 - 5 = 15');

  // 4 штуки по 10 USDT (orderAmount = 40). Скидка 50% на 1 единицу = 5 USDT. Итого: 35 USDT.
  const resSecondQty4 = await calculateDiscount(promoSecondItemPercent, 40, null, { qty: 4 });
  assert.strictEqual(resSecondQty4.valid, true);
  assert.strictEqual(resSecondQty4.discountAmount, 5, 'Discount on 2nd item only applies to 1 unit');
  assert.strictEqual(resSecondQty4.finalPrice, 35);

  // Фиксированная скидка на 2-ю штуку
  const promoSecondItemFixed = {
    code: 'SECOND_ITEM_MINUS_8',
    type: 'fixed',
    value: 8,
    isActive: true,
    productId: null,
    minQuantity: 2,
    discountTarget: 'second_item',
    audienceCondition: 'all',
  };
  // 2 шт по 20 USDT (orderAmount = 40). Скидка 8 USDT. Итого: 32 USDT.
  const resSecondFixed = await calculateDiscount(promoSecondItemFixed, 40, null, { qty: 2 });
  assert.strictEqual(resSecondFixed.valid, true);
  assert.strictEqual(resSecondFixed.discountAmount, 8);
  assert.strictEqual(resSecondFixed.finalPrice, 32);

  // Если скидка больше цены за штуку: 2 шт по 5 USDT (orderAmount = 10, unitPrice = 5), скидка Math.min(5, 8) = 5 USDT.
  const resSecondCapped = await calculateDiscount(promoSecondItemFixed, 10, null, { qty: 2 });
  assert.strictEqual(resSecondCapped.valid, true);
  assert.strictEqual(resSecondCapped.discountAmount, 5, 'Fixed discount on single item capped at unitPrice');
  assert.strictEqual(resSecondCapped.finalPrice, 5);
  console.log('  ✅ second_item discount mechanics tests passed');

  // ─── 4. Условие аудитории (audienceCondition) ───
  console.log('\nTest 4: audienceCondition (repeat_only / first_only)');
  const promoRepeatOnly = {
    code: 'REPEAT_ORDER_ONLY',
    type: 'percent',
    value: 15,
    isActive: true,
    productId: null,
    minQuantity: 1,
    discountTarget: 'all',
    audienceCondition: 'repeat_only',
  };

  const resRepeatNewUser = await calculateDiscount(promoRepeatOnly, 100, null, {
    qty: 1,
    userCompletedOrders: 0,
  });
  assert.strictEqual(resRepeatNewUser.valid, false, 'New user should be rejected for repeat_only');
  assert.match(resRepeatNewUser.reason, /со второй покупки/);

  // Важный баг-тест: если пользователь не передан вообще (null/undefined userId & userCompletedOrders),
  // промокод repeat_only НЕ должен срабатывать!
  const resRepeatNoUser = await calculateDiscount(promoRepeatOnly, 100, null, { qty: 1 });
  assert.strictEqual(resRepeatNoUser.valid, false, 'Anonymous user without completed orders should be rejected for repeat_only');
  assert.match(resRepeatNoUser.reason, /со второй покупки/);

  const resRepeatReturningUser = await calculateDiscount(promoRepeatOnly, 100, null, {
    qty: 1,
    userCompletedOrders: 1,
  });
  assert.strictEqual(resRepeatReturningUser.valid, true, 'User with 1 completed order should be accepted');
  assert.strictEqual(resRepeatReturningUser.discountAmount, 15);

  const resRepeatManyOrders = await calculateDiscount(promoRepeatOnly, 100, null, {
    qty: 1,
    userCompletedOrders: 5,
  });
  assert.strictEqual(resRepeatManyOrders.valid, true, 'User with 5 completed orders should be accepted');

  const promoFirstOnly = {
    code: 'FIRST_ORDER_ONLY',
    type: 'percent',
    value: 20,
    isActive: true,
    productId: null,
    minQuantity: 1,
    discountTarget: 'all',
    audienceCondition: 'first_only',
  };

  const resFirstNewUser = await calculateDiscount(promoFirstOnly, 100, null, {
    qty: 1,
    userCompletedOrders: 0,
  });
  assert.strictEqual(resFirstNewUser.valid, true, 'New user should be accepted for first_only');
  assert.strictEqual(resFirstNewUser.discountAmount, 20);

  const resFirstNoUser = await calculateDiscount(promoFirstOnly, 100, null, { qty: 1 });
  assert.strictEqual(resFirstNoUser.valid, true, 'New anonymous user should be treated as first order');

  const resFirstExistingUser = await calculateDiscount(promoFirstOnly, 100, null, {
    qty: 1,
    userCompletedOrders: 1,
  });
  assert.strictEqual(resFirstExistingUser.valid, false, 'Existing user should be rejected for first_only');
  assert.match(resFirstExistingUser.reason, /только на первый заказ/);
  console.log('  ✅ audienceCondition tests passed');

  // ─── 5. Локализация (en / ru) ───
  console.log('\nTest 5: Localization (Russian & English)');
  const resEnSecond = await calculateDiscount(promoSecondItemPercent, 20, null, { qty: 1, lang: 'en' });
  assert.strictEqual(resEnSecond.valid, false);
  assert.match(resEnSecond.reason, /applies to 2nd item/);

  const resEnRepeat = await calculateDiscount(promoRepeatOnly, 100, null, { qty: 1, userCompletedOrders: 0, lang: 'en' });
  assert.strictEqual(resEnRepeat.valid, false);
  assert.match(resEnRepeat.reason, /second purchase/);

  const resEnFirst = await calculateDiscount(promoFirstOnly, 100, null, { qty: 1, userCompletedOrders: 2, lang: 'en' });
  assert.strictEqual(resEnFirst.valid, false);
  assert.match(resEnFirst.reason, /first order/);

  const resEnProduct = await calculateDiscount(promoProduct, 100, 'wrong_prod', { qty: 1, lang: 'en' });
  assert.strictEqual(resEnProduct.valid, false);
  assert.match(resEnProduct.reason, /not valid for this product/);
  console.log('  ✅ Localization tests passed');

  // ─── 6. Комбинированный сценарий ───
  console.log('\nTest 6: Complex combined scenario (Product + 1+1 + Repeat Only)');
  const complexPromo = {
    code: 'VIP_REPEAT_1PLUS1',
    type: 'percent',
    value: 50,
    isActive: true,
    productId: 'prod_123',
    minQuantity: 2,
    discountTarget: 'second_item',
    audienceCondition: 'repeat_only',
  };

  // Не тот товар
  const r1 = await calculateDiscount(complexPromo, 60, 'prod_other', { qty: 2, userCompletedOrders: 2 });
  assert.strictEqual(r1.valid, false);
  assert.match(r1.reason, /не распространяется/);

  // Тот товар, но 1 шт
  const r2 = await calculateDiscount(complexPromo, 30, 'prod_123', { qty: 1, userCompletedOrders: 2 });
  assert.strictEqual(r2.valid, false);
  assert.match(r2.reason, /2-ю единицу/);

  // Тот товар, 2 шт, но первый заказ
  const r3 = await calculateDiscount(complexPromo, 60, 'prod_123', { qty: 2, userCompletedOrders: 0 });
  assert.strictEqual(r3.valid, false);
  assert.match(r3.reason, /со второй покупки/);

  // Все условия выполнены: prod_123, 2 шт, repeat user
  // orderAmount = 60 (30 за шт), 50% от 30 = 15 USDT скидка, итого 45 USDT
  const r4 = await calculateDiscount(complexPromo, 60, 'prod_123', { qty: 2, userCompletedOrders: 3 });
  assert.strictEqual(r4.valid, true);
  assert.strictEqual(r4.discountAmount, 15);
  assert.strictEqual(r4.finalPrice, 45);
  console.log('  ✅ Complex combined scenario passed');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});

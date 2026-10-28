const assert = require('assert');
const { extractDeliveryData } = require('../src/services/suppliers/jaha.adapter');
const { has2FASecret, extract2FAAccounts } = require('../src/bot/utils/ui');

console.log('🧪 Starting Jaha Digital Parser & Delivery Extractor Test Suite...\n');

// Test 1: Real Jaha format with delivery string
console.log('Test 1: Real Jaha API delivery string format');
const sample1 = {
  order: {
    order_number: 'ORD-00001127',
    status: 'completed',
    delivery: 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ',
  },
};
const res1 = extractDeliveryData(sample1);
assert.strictEqual(res1, 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ');
console.log('✅ Test 1 Passed');

// Test 2: Top-level delivery_data field
console.log('Test 2: Top-level delivery_data field');
const sample2 = {
  order_number: 'ORD-00001128',
  status: 'completed',
  delivery_data: 'user@example.com | secretpass',
};
const res2 = extractDeliveryData(sample2);
assert.strictEqual(res2, 'user@example.com | secretpass');
console.log('✅ Test 2 Passed');

// Test 3: Items array with content / data
console.log('Test 3: Items array with content/data objects');
const sample3 = {
  order_number: 'ORD-00001129',
  items: [
    { key: 'KEY-AAA-BBB' },
    { content: 'KEY-CCC-DDD' },
  ],
};
const res3 = extractDeliveryData(sample3);
assert.strictEqual(res3, 'KEY-AAA-BBB\nKEY-CCC-DDD');
console.log('✅ Test 3 Passed');

// Test 4: Items array with credentials object (login, password, 2fa)
console.log('Test 4: Account object with login, password, 2fa');
const sample4 = {
  order: {
    account_details: {
      login: 'john.doe@gmail.com',
      password: 'SuperSecretPassword123',
      secret: 'JBSWY3DPEHPK3PXP',
    },
  },
};
const res4 = extractDeliveryData(sample4);
assert.strictEqual(res4, 'john.doe@gmail.com | SuperSecretPassword123 | JBSWY3DPEHPK3PXP');
console.log('✅ Test 4 Passed');

// Test 5: Empty and null inputs
console.log('Test 5: Empty, null, and edge case inputs');
assert.strictEqual(extractDeliveryData(null), null);
assert.strictEqual(extractDeliveryData(undefined), null);
assert.strictEqual(extractDeliveryData({}), null);
assert.strictEqual(extractDeliveryData({ order: {} }), null);
assert.strictEqual(extractDeliveryData({ delivery: null }), null);
assert.strictEqual(extractDeliveryData({ delivery: '   ' }), null);
assert.strictEqual(extractDeliveryData({ items: [] }), null);
console.log('✅ Test 5 Passed');

// Test 6: 2FA recognition on Jaha delivery credentials
console.log('Test 6: 2FA recognition on Jaha delivery credentials');
const deliveryStr = 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ';
assert.strictEqual(has2FASecret(deliveryStr), true);
const accounts = extract2FAAccounts(deliveryStr);
assert.strictEqual(accounts.length, 1);
assert.strictEqual(accounts[0].secret, 'M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ');
console.log('✅ Test 6 Passed: 2FA secret recognized correctly');

// Test 7: Additions array inside order object
console.log('Test 7: Additions array inside order object');
const sample7 = {
  order: {
    order_number: 'ORD-00001127',
    status: 'completed',
    delivery: null,
    additions: [
      { text: 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ' },
    ],
  },
};
const res7 = extractDeliveryData(sample7);
assert.strictEqual(res7, 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ');
console.log('✅ Test 7 Passed');

// Test 8: Root-level additions with nested order having delivery: null (real OpenAPI response with ?include_additions=true)
console.log('Test 8: Root-level additions with nested order (include_additions=true)');
const sample8 = {
  order: {
    order_number: 'ORD-00001127',
    status: 'completed',
    delivery: null,
  },
  additions: [
    { text: 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ' },
  ],
};
const res8 = extractDeliveryData(sample8);
assert.strictEqual(res8, 'herbertbutterfield77852+97292@gmail.com | Fantassyyy68 | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ');
console.log('✅ Test 8 Passed');

// Test 9: Account credentials with totp / otp fields
console.log('Test 9: Account credentials with totp field');
const sample9 = {
  account_details: {
    email: 'testuser@gmail.com',
    password: 'SafePassword123!',
    totp: 'M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ',
  },
};
const res9 = extractDeliveryData(sample9);
assert.strictEqual(res9, 'testuser@gmail.com | SafePassword123! | M5WIOIDILBI4AOPCKUD2D2LOQZ5FPZQJ');
console.log('✅ Test 9 Passed');

// Test 10: Account credentials with 'account' key as username and 'pass'
console.log('Test 10: Account credentials with account & pass keys');
const sample10 = {
  account_details: {
    account: 'agent007@gmail.com',
    pass: 'LicenseToCode',
  },
};
const res10 = extractDeliveryData(sample10);
assert.strictEqual(res10, 'agent007@gmail.com | LicenseToCode');
console.log('✅ Test 10 Passed');

// Test 11: Multi-quantity items array (quantity = 2)
console.log('Test 11: Multi-quantity items array');
const sample11 = {
  order: {
    order_number: 'ORD-00001130',
    items: [
      { login: 'buyer1@gmail.com', password: 'pwd1', secret: 'SEC1' },
      { login: 'buyer2@gmail.com', password: 'pwd2', secret: 'SEC2' },
    ],
  },
};
const res11 = extractDeliveryData(sample11);
assert.strictEqual(res11, 'buyer1@gmail.com | pwd1 | SEC1\nbuyer2@gmail.com | pwd2 | SEC2');
console.log('✅ Test 11 Passed');

// Test 12: Order nested under data.order
console.log('Test 12: Order nested under data.order');
const sample12 = {
  data: {
    order: {
      order_number: 'ORD-00001131',
      delivery_data: 'token-abc-123-xyz',
    },
  },
};
const res12 = extractDeliveryData(sample12);
assert.strictEqual(res12, 'token-abc-123-xyz');
console.log('✅ Test 12 Passed');

console.log('\n🎉 All Jaha Parser tests (12/12) passed successfully!');


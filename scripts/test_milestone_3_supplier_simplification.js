/**
 * Test Suite for Milestone 3: Supplier Simplification (Jaha Digital API only)
 */

const assert = require('assert');
const path = require('path');

console.log('🧪 Starting Milestone 3 Supplier Simplification Verification Suite...\n');

// 1. Provider Service Verification
const providerService = require('../src/services/provider.service');

console.log('Test 1: PROVIDERS dictionary only contains local, jaha, u1traby');
assert.strictEqual(providerService.PROVIDERS.jaha !== undefined, true, 'jaha must be present in PROVIDERS');
assert.strictEqual(providerService.PROVIDERS.local !== undefined, true, 'local must be present in PROVIDERS');
assert.strictEqual(providerService.PROVIDERS.u1traby !== undefined, true, 'u1traby must be present in PROVIDERS');
assert.strictEqual(providerService.PROVIDERS.akunding, undefined, 'akunding must be removed from PROVIDERS');
assert.strictEqual(providerService.PROVIDERS.canboso, undefined, 'canboso must be removed from PROVIDERS');
assert.strictEqual(providerService.PROVIDERS.trumpstore, undefined, 'trumpstore must be removed from PROVIDERS');
console.log('  ✅ Test 1 Passed: PROVIDERS successfully pruned of non-jaha providers.\n');

console.log('Test 2: isSupplierProvider returns true ONLY for "jaha"');
assert.strictEqual(providerService.isSupplierProvider('jaha'), true, 'jaha must be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider('akunding'), false, 'akunding must NOT be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider('canboso'), false, 'canboso must NOT be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider('trumpstore'), false, 'trumpstore must NOT be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider('local'), false, 'local must NOT be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider('u1traby'), false, 'u1traby must NOT be recognized as supplier provider');
assert.strictEqual(providerService.isSupplierProvider(null), false, 'null must NOT be recognized as supplier provider');
console.log('  ✅ Test 2 Passed: isSupplierProvider strictly validates only "jaha".\n');

console.log('Test 3: Backward-compatibility fallback for legacy providers');
const legacyProductAkunding = { type: 'manual', provider: 'akunding' };
assert.strictEqual(providerService.resolveProductProvider(legacyProductAkunding), 'local', 'Legacy akunding product should fallback to local');

const legacyOrderCanboso = { type: 'manual', provider: 'canboso' };
assert.strictEqual(providerService.resolveOrderProvider(legacyOrderCanboso), 'local', 'Legacy canboso order should fallback to local');

const jahaProduct = { type: 'manual', provider: 'jaha' };
assert.strictEqual(providerService.resolveProductProvider(jahaProduct), 'jaha', 'Active jaha product resolves to jaha');
console.log('  ✅ Test 3 Passed: Legacy non-jaha orders/products safely fall back to local provider.\n');

// 2. Supplier Manager Service Verification
console.log('Test 4: SupplierManager ADAPTERS and SUPPLIER_META');
const fs = require('fs');
const supplierManagerCode = fs.readFileSync(path.join(__dirname, '../src/services/supplierManager.service.js'), 'utf8');

assert.ok(!supplierManagerCode.includes('akundingAdapter'), 'akundingAdapter must not be in supplierManager');
assert.ok(!supplierManagerCode.includes('canbosoAdapter'), 'canbosoAdapter must not be in supplierManager');
assert.ok(!supplierManagerCode.includes('trumpstoreAdapter'), 'trumpstoreAdapter must not be in supplierManager');
assert.ok(supplierManagerCode.includes('jahaAdapter'), 'jahaAdapter must be in supplierManager');
console.log('  ✅ Test 4 Passed: supplierManager imports and registers only jahaAdapter.\n');

// 3. Supplier Live Sync Service Verification
console.log('Test 5: SupplierLiveSync ADAPTERS');
const supplierLiveSyncCode = fs.readFileSync(path.join(__dirname, '../src/services/supplierLiveSync.service.js'), 'utf8');

assert.ok(!supplierLiveSyncCode.includes('akundingAdapter'), 'akundingAdapter must not be in supplierLiveSync');
assert.ok(!supplierLiveSyncCode.includes('canbosoAdapter'), 'canbosoAdapter must not be in supplierLiveSync');
assert.ok(!supplierLiveSyncCode.includes('trumpstoreAdapter'), 'trumpstoreAdapter must not be in supplierLiveSync');
assert.ok(supplierLiveSyncCode.includes('jahaAdapter'), 'jahaAdapter must be in supplierLiveSync');
console.log('  ✅ Test 5 Passed: supplierLiveSync registers only jahaAdapter.\n');

// 4. Cart Service SUPPLIER_PROVIDERS Verification
console.log('Test 6: Cart Service SUPPLIER_PROVIDERS set');
const cartServiceCode = fs.readFileSync(path.join(__dirname, '../src/services/cart.service.js'), 'utf8');
const supplierProvidersMatch = cartServiceCode.match(/const SUPPLIER_PROVIDERS = new Set\(\[(.*?)\]\);/);
assert.ok(supplierProvidersMatch, 'SUPPLIER_PROVIDERS declaration must exist in cart.service.js');
assert.strictEqual(
  supplierProvidersMatch[1].replace(/['"\s]/g, ''),
  'jaha',
  'SUPPLIER_PROVIDERS must only contain "jaha"'
);
console.log('  ✅ Test 6 Passed: cart.service.js SUPPLIER_PROVIDERS contains only "jaha".\n');

// 5. SupplierConfig Model Enum Verification
console.log('Test 7: SupplierConfig Schema Enum');
const SupplierConfig = require('../src/models/SupplierConfig');
const supplierIdPath = SupplierConfig.schema.path('supplierId');
assert.deepStrictEqual(supplierIdPath.enumValues, ['jaha'], 'SupplierConfig supplierId enum must only be ["jaha"]');
console.log('  ✅ Test 7 Passed: SupplierConfig model enum strictly restricted to ["jaha"].\n');

// 6. UI Scene Badges and Delivery Logic Verification
console.log('Test 8: UI Scenes delivery method and instant badges');
const { getProductBadges } = require('../src/bot/scenes/shop.scene');

const jahaProductItem = { type: 'manual', deliveryMethod: 'activation', provider: 'jaha' };
assert.strictEqual(getProductBadges(jahaProductItem).isInstant, true, 'jaha product should have instant badge');

const akundingProductItem = { type: 'manual', deliveryMethod: 'activation', provider: 'akunding' };
assert.strictEqual(getProductBadges(akundingProductItem).isInstant, false, 'akunding product should NOT have instant badge');

const canbosoProductItem = { type: 'manual', deliveryMethod: 'activation', provider: 'canboso' };
assert.strictEqual(getProductBadges(canbosoProductItem).isInstant, false, 'canboso product should NOT have instant badge');

const trumpstoreProductItem = { type: 'manual', deliveryMethod: 'activation', provider: 'trumpstore' };
assert.strictEqual(getProductBadges(trumpstoreProductItem).isInstant, false, 'trumpstore product should NOT have instant badge');
console.log('  ✅ Test 8 Passed: UI badges correctly treat only "jaha" as external instant supplier.\n');

console.log('🎉 ALL MILESTONE 3 VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');

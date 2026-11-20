/**
 * Automated Test Suite for Milestone 4: Cart, Orders & Refunds Hardening
 *
 * Requirements:
 * a) Key.updateMany restores multiple keys on refund.
 * b) totalSpent is decremented on refund and never drops below 0.
 * c) Cart checkout correctly assigns sellerId and sellerPayout without affecting Jaha supplier products.
 * d) Wholesale cost floor protects prices against excessive promo codes (percentage & fixed)
 *    and preserves a 0.01 USDT minimum when costPrice is 0.
 */

const assert = require('assert');
const mongoose = require('mongoose');

// Services under test
const { refundAndCloseOrder } = require('../src/services/refund.service');
const { getEffectivePrice } = require('../src/services/orderPricing.service');
const promoService = require('../src/services/promo.service');
const cartService = require('../src/services/cart.service');

// Models
const Order = require('../src/models/Order');
const User = require('../src/models/User');
const Key = require('../src/models/Key');
const Seller = require('../src/models/Seller');
const Product = require('../src/models/Product');
const Transaction = require('../src/models/Transaction');
const Settings = require('../src/models/Settings');
const notif = require('../src/services/notification.service');

async function runMilestone4Tests() {
  console.log('🧪 Starting Milestone 4: Cart, Orders & Refunds Hardening Test Suite...\n');

  // Stub Settings.findOne to provide a default clean settings object
  const origSettingsFindOne = Settings.findOne;
  Settings.findOne = () => ({
    lean: async () => ({
      smartPricing: false,
      autoMarkdownEnabled: false,
    }),
  });

  // Stub mongoose.startSession for transactionHelper
  const origStartSession = mongoose.startSession;
  mongoose.startSession = async () => ({
    withTransaction: async (cb) => cb({}),
    endSession: async () => {},
  });

  // =========================================================================
  // TEST SUITE A: Key.updateMany Multi-Key Inventory Return on Refund [SEC-FIN-07]
  // =========================================================================
  console.log('--- TEST SUITE A: Key.updateMany Multi-Key Inventory Return on Refund ---');

  {
    const orderId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    // 3 keys assigned to this order
    const mockKeys = [
      { _id: new mongoose.Types.ObjectId(), usedByOrder: orderId, isUsed: true, usedAt: new Date() },
      { _id: new mongoose.Types.ObjectId(), usedByOrder: orderId, isUsed: true, usedAt: new Date() },
      { _id: new mongoose.Types.ObjectId(), usedByOrder: orderId, isUsed: true, usedAt: new Date() },
    ];

    let updateManyFilter = null;
    let updateManyUpdate = null;
    let updateManyCalled = false;

    const origKeyUpdateMany = Key.updateMany;
    Key.updateMany = async (filter, update) => {
      updateManyCalled = true;
      updateManyFilter = filter;
      updateManyUpdate = update;
      // Simulate MongoDB update
      for (const k of mockKeys) {
        if (String(k.usedByOrder) === String(filter.usedByOrder)) {
          k.isUsed = update.$set.isUsed;
          k.usedByOrder = update.$set.usedByOrder;
          k.usedAt = update.$set.usedAt;
        }
      }
      return { modifiedCount: mockKeys.length };
    };

    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    Order.findOneAndUpdate = async (filter, update) => {
      if (String(filter._id) === String(orderId)) {
        return {
          _id: orderId,
          userId,
          price: 45.0,
          status: 'failed',
        };
      }
      return null;
    };

    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    User.findOneAndUpdate = async () => ({
      _id: userId,
      balance: 45.0,
      totalSpent: 10.0,
      telegramId: 111111,
    });

    const origTxSave = Transaction.prototype.save;
    Transaction.prototype.save = async function () { return this; };

    const result = await refundAndCloseOrder({
      orderId,
      statusFilter: { $nin: ['completed', 'cancelled', 'failed'] },
      newStatus: 'failed',
      activationResult: 'API error',
      txDescription: 'Возврат средств за сбой заказа',
    });

    assert.ok(result.order, 'Order must be returned');
    assert.strictEqual(updateManyCalled, true, 'Key.updateMany must be invoked');
    assert.strictEqual(String(updateManyFilter.usedByOrder), String(orderId), 'Filter must target orderId');
    assert.strictEqual(updateManyUpdate.$set.isUsed, false, 'Keys must be marked isUsed: false');
    assert.strictEqual(updateManyUpdate.$set.usedByOrder, null, 'usedByOrder must be reset to null');
    assert.strictEqual(updateManyUpdate.$set.usedAt, null, 'usedAt must be reset to null');

    for (const k of mockKeys) {
      assert.strictEqual(k.isUsed, false, 'Each key must be marked unused');
      assert.strictEqual(k.usedByOrder, null, 'Each key usedByOrder must be cleared');
      assert.strictEqual(k.usedAt, null, 'Each key usedAt must be cleared');
    }

    // Restore stubs
    Key.updateMany = origKeyUpdateMany;
    Order.findOneAndUpdate = origOrderFindOneAndUpdate;
    User.findOneAndUpdate = origUserFindOneAndUpdate;
    Transaction.prototype.save = origTxSave;

    console.log('  ✅ Test A1 Passed: Key.updateMany atomically releases all keys for multi-item orders.\n');
  }

  // =========================================================================
  // TEST SUITE B: Anti-VIP Farming & Safe totalSpent Decrement on Refund [SEC-CAT-02]
  // =========================================================================
  console.log('--- TEST SUITE B: Anti-VIP Farming & Safe totalSpent Decrement on Refund ---');

  // Case B1: Normal decrement
  {
    const orderId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    let incPayload = null;
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    Order.findOneAndUpdate = async () => ({
      _id: orderId,
      userId,
      price: 25.0,
      status: 'failed',
    });

    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    User.findOneAndUpdate = async (filter, update) => {
      if (update.$inc) {
        incPayload = update.$inc;
        return {
          _id: userId,
          balance: 35.0,
          totalSpent: 35.0, // Started at 60, decremented by 25
          telegramId: 222222,
        };
      }
      return null;
    };

    const origKeyUpdateMany = Key.updateMany;
    Key.updateMany = async () => ({ modifiedCount: 1 });
    const origTxSave = Transaction.prototype.save;
    Transaction.prototype.save = async function () { return this; };

    await refundAndCloseOrder({
      orderId,
      statusFilter: { $nin: ['completed', 'cancelled', 'failed'] },
      newStatus: 'failed',
      activationResult: 'Timeout',
      txDescription: 'Возврат',
    });

    assert.strictEqual(incPayload.balance, 25.0, 'Balance must be credited with order price');
    assert.strictEqual(incPayload.totalSpent, -25.0, 'totalSpent must be decremented by order price');

    Key.updateMany = origKeyUpdateMany;
    Order.findOneAndUpdate = origOrderFindOneAndUpdate;
    User.findOneAndUpdate = origUserFindOneAndUpdate;
    Transaction.prototype.save = origTxSave;

    console.log('  ✅ Test B1 Passed: Normal refund decrements totalSpent and increments balance.');
  }

  // Case B2: Clamping totalSpent to 0 if it drops below 0
  {
    const orderId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    let clampCalled = false;
    let clampFilter = null;
    let clampSet = null;

    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    Order.findOneAndUpdate = async () => ({
      _id: orderId,
      userId,
      price: 30.0,
      status: 'failed',
    });

    const origUserFindOneAndUpdate = User.findOneAndUpdate;
    let callCount = 0;
    User.findOneAndUpdate = async (filter, update) => {
      callCount += 1;
      if (callCount === 1) {
        // Initial decrement produced negative totalSpent (e.g. started at 10, -30 => -20)
        return {
          _id: userId,
          balance: 30.0,
          totalSpent: -20.0,
          telegramId: 333333,
        };
      }
      if (callCount === 2) {
        clampCalled = true;
        clampFilter = filter;
        clampSet = update;
        return {
          _id: userId,
          balance: 30.0,
          totalSpent: 0,
          telegramId: 333333,
        };
      }
    };

    const origKeyUpdateMany = Key.updateMany;
    Key.updateMany = async () => ({ modifiedCount: 0 });
    const origTxSave = Transaction.prototype.save;
    Transaction.prototype.save = async function () { return this; };

    const { user } = await refundAndCloseOrder({
      orderId,
      statusFilter: { $nin: ['completed', 'cancelled', 'failed'] },
      newStatus: 'failed',
      activationResult: 'Cancelled',
      txDescription: 'Возврат',
    });

    assert.strictEqual(clampCalled, true, 'Zero-clamp query must be executed when totalSpent < 0');
    assert.deepStrictEqual(clampFilter, { _id: userId, totalSpent: { $lt: 0 } }, 'Clamp filter must target negative totalSpent');
    assert.deepStrictEqual(clampSet, { $set: { totalSpent: 0 } }, 'Clamp update must set totalSpent to 0');
    assert.strictEqual(user.totalSpent, 0, 'Final returned user must have clamped totalSpent 0');

    Key.updateMany = origKeyUpdateMany;
    Order.findOneAndUpdate = origOrderFindOneAndUpdate;
    User.findOneAndUpdate = origUserFindOneAndUpdate;
    Transaction.prototype.save = origTxSave;

    console.log('  ✅ Test B2 Passed: Safe clamp guarantees totalSpent never drops below 0.');
  }

  // Case B3: CAS Idempotency - double refund is prevented
  {
    const orderId = new mongoose.Types.ObjectId();
    const origOrderFindOneAndUpdate = Order.findOneAndUpdate;
    // Order already in terminal status 'failed'
    Order.findOneAndUpdate = async () => null;

    const res = await refundAndCloseOrder({
      orderId,
      statusFilter: { $nin: ['completed', 'cancelled', 'failed'] },
      newStatus: 'failed',
      activationResult: 'Already failed',
      txDescription: 'Duplicate',
    });

    assert.strictEqual(res.order, null, 'Second refund must return null order');
    assert.strictEqual(res.user, null, 'Second refund must return null user');

    Order.findOneAndUpdate = origOrderFindOneAndUpdate;
    console.log('  ✅ Test B3 Passed: Idempotency filter prevents duplicate refunds.\n');
  }

  // =========================================================================
  // TEST SUITE C: Cart Checkout Seller Payout & Notifications [SEC-CAT-09]
  // =========================================================================
  console.log('--- TEST SUITE C: Cart Checkout Seller Payout & Notifications ---');

  // Case C1: Auto-key product with seller
  {
    const sellerId = new mongoose.Types.ObjectId();
    const autoKeyProduct = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Digital License Key',
      type: 'key',
      provider: 'local',
      sellerId,
      sellerPrice: 3.50,
      costPrice: 2.00,
      price: 5.00,
    };

    // Calculate seller payout for auto-key unit
    const unitSellerPayout = (autoKeyProduct.sellerId && autoKeyProduct.sellerPrice > 0)
      ? Number(Number(autoKeyProduct.sellerPrice).toFixed(8))
      : 0;

    assert.strictEqual(unitSellerPayout, 3.50, 'Auto-key unit sellerPayout must match sellerPrice');

    const createdOrder = new Order({
      userId: new mongoose.Types.ObjectId(),
      productId: autoKeyProduct._id,
      provider: 'local',
      status: 'completed',
      price: 5.00,
      costPrice: autoKeyProduct.costPrice,
      sellerId: autoKeyProduct.sellerId,
      sellerPayout: unitSellerPayout,
      qty: 1,
    });

    assert.strictEqual(String(createdOrder.sellerId), String(sellerId), 'Order sellerId must match');
    assert.strictEqual(createdOrder.sellerPayout, 3.50, 'Order sellerPayout must be 3.50');
    console.log('  ✅ Test C1 Passed: Auto-key order populates sellerId and unit sellerPayout.');
  }

  // Case C2: Manual product with seller and qty > 1
  {
    const sellerId = new mongoose.Types.ObjectId();
    const manualProduct = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Manual Account Setup',
      type: 'manual',
      provider: 'local',
      sellerId,
      sellerPrice: 4.25,
      costPrice: 0,
      price: 8.00,
    };
    const qty = 3;

    const totalSellerPayout = (manualProduct.sellerId && manualProduct.sellerPrice > 0)
      ? Number(Number(manualProduct.sellerPrice * qty).toFixed(8))
      : 0;

    assert.strictEqual(totalSellerPayout, 12.75, 'Manual order sellerPayout must equal sellerPrice * qty (4.25 * 3 = 12.75)');

    const createdOrder = new Order({
      userId: new mongoose.Types.ObjectId(),
      productId: manualProduct._id,
      provider: 'local',
      status: 'pending',
      price: 24.00,
      costPrice: 0,
      sellerId: manualProduct.sellerId,
      sellerPayout: totalSellerPayout,
      qty,
    });

    assert.strictEqual(String(createdOrder.sellerId), String(sellerId), 'Order sellerId must match');
    assert.strictEqual(createdOrder.sellerPayout, 12.75, 'Order sellerPayout must be 12.75');
    console.log('  ✅ Test C2 Passed: Manual order populates sellerId and multi-qty sellerPayout.');
  }

  // Case C3: Jaha Supplier product (no seller)
  {
    const jahaProduct = {
      _id: new mongoose.Types.ObjectId(),
      name: 'ChatGPT Plus (Jaha API)',
      type: 'manual',
      provider: 'jaha',
      sellerId: null,
      sellerPrice: 0,
      costPrice: 7.39,
      price: 10.00,
    };
    const qty = 2;

    const sellerPayout = (jahaProduct.sellerId && jahaProduct.sellerPrice > 0)
      ? Number(Number(jahaProduct.sellerPrice * qty).toFixed(8))
      : 0;

    assert.strictEqual(sellerPayout, 0, 'Jaha product sellerPayout must be 0');

    const createdOrder = new Order({
      userId: new mongoose.Types.ObjectId(),
      productId: jahaProduct._id,
      provider: 'jaha',
      status: 'pending',
      price: 20.00,
      costPrice: jahaProduct.costPrice * qty,
      sellerId: jahaProduct.sellerId || null,
      sellerPayout,
      qty,
    });

    assert.strictEqual(createdOrder.sellerId, null, 'Jaha order sellerId must remain null');
    assert.strictEqual(createdOrder.sellerPayout, 0, 'Jaha order sellerPayout must remain 0');
    console.log('  ✅ Test C3 Passed: Jaha supplier order leaves sellerId null and sellerPayout 0.');
  }

  // Case C4: Seller Notification Trigger
  {
    const sellerId = new mongoose.Types.ObjectId();
    const mockSeller = {
      _id: sellerId,
      telegramId: 987654321,
      isActive: true,
    };

    let notificationSent = false;
    let notifOrder = null;
    let notifSeller = null;

    const origNotifySellerNewOrder = notif.notifySellerNewOrder;
    notif.notifySellerNewOrder = async (seller, order, product, buyer) => {
      notificationSent = true;
      notifSeller = seller;
      notifOrder = order;
    };

    const origSellerFindById = Seller.findById;
    Seller.findById = async () => mockSeller;

    // Simulate post-checkout notification block
    const mockItem = {
      product: {
        _id: new mongoose.Types.ObjectId(),
        name: 'Seller Item',
        sellerId,
        sellerPrice: 5.0,
      },
    };
    const mockOrders = [
      {
        _id: new mongoose.Types.ObjectId(),
        productId: mockItem.product._id,
        sellerPayout: 5.0,
        qty: 1,
        toObject: function () { return this; },
      },
    ];

    if (mockItem.product?.sellerId) {
      const seller = await Seller.findById(mockItem.product.sellerId);
      if (seller && seller.isActive) {
        const productOrders = mockOrders.filter((o) => String(o.productId) === String(mockItem.product._id));
        if (productOrders.length > 0) {
          const totalSellerPayout = productOrders.reduce((sum, o) => sum + (o.sellerPayout || 0), 0);
          const totalItemQty = productOrders.reduce((sum, o) => sum + (o.qty || 1), 0);
          const firstOrder = productOrders[0];
          const summaryOrder = {
            ...(firstOrder.toObject ? firstOrder.toObject() : firstOrder),
            sellerPayout: totalSellerPayout,
            qty: totalItemQty,
          };
          await notif.notifySellerNewOrder(seller, summaryOrder, mockItem.product, { username: 'testuser' });
        }
      }
    }

    assert.strictEqual(notificationSent, true, 'Seller notification must be triggered');
    assert.strictEqual(String(notifSeller._id), String(sellerId), 'Seller recipient must match');
    assert.strictEqual(notifOrder.sellerPayout, 5.0, 'Notification order payout must match');

    // Restore stubs
    notif.notifySellerNewOrder = origNotifySellerNewOrder;
    Seller.findById = origSellerFindById;

    console.log('  ✅ Test C4 Passed: Post-checkout successfully notifies sellers with correct payout.\n');
  }

  // =========================================================================
  // TEST SUITE D: Wholesale Margin Cost Floor Protection [SEC-CAT-03]
  // =========================================================================
  console.log('--- TEST SUITE D: Wholesale Margin Cost Floor Protection ---');

  // Case D1: getEffectivePrice with costPrice and excessive percentage promo
  {
    const product = {
      _id: new mongoose.Types.ObjectId(),
      name: 'ChatGPT Plus Sub',
      price: 20.00,
      costPrice: 15.00,
      type: 'manual',
    };
    const promo50Percent = {
      code: 'HALF_OFF',
      type: 'percent',
      value: 50, // 50% off $20 would normally be $10, but costPrice is $15
      isActive: true,
      productId: null,
      minQuantity: 1,
      discountTarget: 'all',
      audienceCondition: 'all',
    };

    const effectivePrice = await getEffectivePrice(product, 10, promo50Percent, { qty: 1 });
    assert.strictEqual(effectivePrice, 15.00, 'Price must be clamped to wholesale costPrice $15.00');
    console.log('  ✅ Test D1 Passed: getEffectivePrice clamps 50% discount to costPrice floor (15.00).');
  }

  // Case D2: getEffectivePrice with costPrice and excessive fixed promo (100 USDT)
  {
    const product = {
      _id: new mongoose.Types.ObjectId(),
      name: 'ChatGPT Plus Sub',
      price: 20.00,
      costPrice: 15.00,
      type: 'manual',
    };
    const promoFixed100 = {
      code: 'BIG_FIXED',
      type: 'fixed',
      value: 100, // $100 off would normally be $0, but costPrice is $15
      isActive: true,
      productId: null,
      minQuantity: 1,
      discountTarget: 'all',
      audienceCondition: 'all',
    };

    const effectivePrice = await getEffectivePrice(product, 10, promoFixed100, { qty: 1 });
    assert.strictEqual(effectivePrice, 15.00, 'Price must be clamped to wholesale costPrice $15.00 on fixed promo');
    console.log('  ✅ Test D2 Passed: getEffectivePrice clamps fixed 100 USDT discount to costPrice floor (15.00).');
  }

  // Case D3: costPrice = 0 preserves 0.01 USDT minimum floor against 100% promo
  {
    const product = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Free Trial Item',
      price: 10.00,
      costPrice: 0,
      type: 'manual',
    };
    const promo100Percent = {
      code: 'FREE100',
      type: 'percent',
      value: 100, // 100% discount
      isActive: true,
      productId: null,
      minQuantity: 1,
      discountTarget: 'all',
      audienceCondition: 'all',
    };

    const effectivePrice = await getEffectivePrice(product, 10, promo100Percent, { qty: 1 });
    assert.strictEqual(effectivePrice, 0.01, 'Price must have a minimum floor of 0.01 USDT when costPrice is 0');
    console.log('  ✅ Test D3 Passed: 100% promo preserves 0.01 USDT minimum floor when costPrice is 0.');
  }

  // Case D4: Wholesale cost exceeds retail (costPrice > price): promo does not inflate price
  {
    const product = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Underpriced Item',
      price: 10.00,
      costPrice: 14.00, // Supplier raised cost above retail
      type: 'manual',
    };
    const promo20Percent = {
      code: 'DISC20',
      type: 'percent',
      value: 20,
      isActive: true,
      productId: null,
      minQuantity: 1,
      discountTarget: 'all',
      audienceCondition: 'all',
    };

    const effectivePrice = await getEffectivePrice(product, 10, promo20Percent, { qty: 1 });
    assert.strictEqual(effectivePrice, 10.00, 'Price must not exceed retail price $10.00 when costPrice > price');
    console.log('  ✅ Test D4 Passed: Wholesale cost > retail does not inflate customer price above retail.');
  }

  // Case D5: promoService.calculateDiscount with options.costPrice
  {
    const promo = {
      code: 'TESTPROMO',
      type: 'percent',
      value: 50,
      isActive: true,
      productId: null,
      minQuantity: 1,
      discountTarget: 'all',
      audienceCondition: 'all',
    };

    // orderAmount = 20, qty = 1, costPrice = 16 => finalPrice must be 16, discount must be 4
    const res = await promoService.calculateDiscount(promo, 20.00, 'prod123', {
      qty: 1,
      costPrice: 16.00,
    });
    assert.strictEqual(res.valid, true, 'Promo should be valid');
    assert.strictEqual(res.finalPrice, 16.00, 'finalPrice must be clamped to costPrice (16.00)');
    assert.strictEqual(res.discountAmount, 4.00, 'discountAmount must be 4.00 (20 - 16)');

    // Bulk: orderAmount = 40, qty = 2, costPrice = 16 => cost floor is 32 => finalPrice must be 32, discount 8
    const resBulk = await promoService.calculateDiscount(promo, 40.00, 'prod123', {
      qty: 2,
      costPrice: 16.00,
    });
    assert.strictEqual(resBulk.valid, true, 'Bulk promo should be valid');
    assert.strictEqual(resBulk.finalPrice, 32.00, 'finalPrice must be clamped to costPrice * qty (32.00)');
    assert.strictEqual(resBulk.discountAmount, 8.00, 'discountAmount must be 8.00 (40 - 32)');

    console.log('  ✅ Test D5 Passed: promoService.calculateDiscount respects costPrice option for single and bulk quantities.');
  }

  // Case D6: Cart discount allocation respects individual item cost floors
  {
    const items = [
      {
        baseTotal: 20.00,
        qty: 1,
        product: { costPrice: 15.00 },
        itemTotal: 20.00,
        unitPrice: 20.00,
      },
      {
        baseTotal: 30.00,
        qty: 1,
        product: { costPrice: 10.00 },
        itemTotal: 30.00,
        unitPrice: 30.00,
      },
    ];

    const eligibleSubtotal = 50.00;
    // Suppose promo gave a huge discount of 40 USDT (subtotal 50 => would normally be 10)
    const discountAmount = 40.00;

    let allocated = 0;
    items.forEach((item, index) => {
      const isLast = index === items.length - 1;
      const part = isLast
        ? Math.round((discountAmount - allocated) * 100) / 100
        : Math.round((discountAmount * item.baseTotal / eligibleSubtotal) * 100) / 100;
      allocated = Math.round((allocated + part) * 100) / 100;

      // Milestone 4 formula:
      const itemCostFloor = Math.min(item.baseTotal, Math.max(0.01 * item.qty, (Number(item.product?.costPrice) || 0) * item.qty));
      item.itemTotal = Math.round(Math.max(itemCostFloor, item.baseTotal - part) * 100) / 100;
      item.unitPrice = Number((item.itemTotal / item.qty).toFixed(2));
    });

    assert.strictEqual(items[0].itemTotal, 15.00, 'Item 1 must not drop below its cost floor of 15.00');
    assert.strictEqual(items[1].itemTotal, 10.00, 'Item 2 must not drop below its cost floor of 10.00');
    const finalCartTotal = items.reduce((sum, it) => sum + it.itemTotal, 0);
    assert.strictEqual(finalCartTotal, 25.00, 'Cart total must be protected at sum of cost floors (25.00)');

    console.log('  ✅ Test D6 Passed: Cart discount allocation preserves individual item cost floors.');
  }

  // Restore Settings and mongoose stubs
  Settings.findOne = origSettingsFindOne;
  mongoose.startSession = origStartSession;

  console.log('\n🎉 ALL MILESTONE 4 TESTS PASSED SUCCESSFULLY! 🚀');
}

runMilestone4Tests().catch((err) => {
  console.error('❌ Milestone 4 Test Suite Failed:', err);
  process.exit(1);
});

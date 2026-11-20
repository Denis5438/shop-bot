/**
 * Automated Test Suite for Milestone 5: Telegraf Broadcast Async Non-blocking
 *
 * Verifies:
 * 1. Singleton Broadcast Concurrency Lock & Abort Support in notification.service.js.
 * 2. Clean cancellation / abort support via AbortSignal in rateLimiter.service.js.
 * 3. Non-blocking Custom Broadcast in users.scene.js (<50ms execution, immediate UI ack, detached background queue, admin completion report, finally lock release).
 * 4. Non-blocking Product Broadcast in admin.routes.js (<50ms execution, immediate UI ack, detached background queue, admin completion report, finally lock release).
 * 5. Concurrent broadcast rejection (rejects simultaneous runs with user alert).
 * 6. Background error handling (catches exceptions, alerts admin, releases lock).
 * 7. Latent bug fix in products.scene.js (notifyWaitlist instead of undefined broadcastRestock).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Services & modules under test
const notif = require('../src/services/notification.service');
const { runBroadcastQueue } = require('../src/services/rateLimiter.service');
const usersScene = require('../src/bot/scenes/admin/users.scene');
const User = require('../src/models/User');
const Product = require('../src/models/Product');
const Key = require('../src/models/Key');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runMilestone5Tests() {
  console.log('🧪 Starting Milestone 5: Telegraf Broadcast Async Non-blocking Test Suite...\n');

  // Ensure clean initial state
  notif.releaseBroadcastLock();

  // =========================================================================
  // TEST SUITE 1: Singleton Broadcast Concurrency Lock & State Management
  // =========================================================================
  console.log('--- TEST SUITE 1: Singleton Broadcast Concurrency Lock & State Management ---');

  {
    assert.strictEqual(notif.isBroadcastActive(), false, 'Broadcast should initially be inactive');
    assert.strictEqual(notif.getActiveBroadcastInfo(), null, 'Active broadcast info should initially be null');

    // 1. Acquire lock
    const lock1 = notif.acquireBroadcastLock({ type: 'custom', adminId: 10001, total: 50 });
    assert.ok(lock1, 'First acquireBroadcastLock must succeed');
    assert.strictEqual(notif.isBroadcastActive(), true, 'Broadcast must be active after lock acquisition');
    assert.strictEqual(lock1.type, 'custom');
    assert.strictEqual(lock1.adminId, 10001);
    assert.strictEqual(lock1.total, 50);
    assert.ok(lock1.abortController instanceof AbortController, 'Must contain AbortController');

    // 2. Reject concurrent lock acquisition
    const lock2 = notif.acquireBroadcastLock({ type: 'product', adminId: 10002 });
    assert.strictEqual(lock2, false, 'Concurrent acquireBroadcastLock must return false');
    assert.strictEqual(notif.isBroadcastActive(), true, 'Broadcast must still be active');

    // 3. Inspect active info
    const info = notif.getActiveBroadcastInfo();
    assert.strictEqual(info.adminId, 10001);
    assert.strictEqual(info.type, 'custom');

    // 4. Release lock
    notif.releaseBroadcastLock();
    assert.strictEqual(notif.isBroadcastActive(), false, 'Broadcast must be inactive after release');
    assert.strictEqual(notif.getActiveBroadcastInfo(), null, 'Active broadcast info must be null after release');

    // 5. Can acquire again after release
    const lock3 = notif.acquireBroadcastLock({ type: 'product', adminId: 10003, total: 100 });
    assert.ok(lock3, 'Must be able to acquire lock again after previous release');
    assert.strictEqual(notif.isBroadcastActive(), true);
    notif.releaseBroadcastLock();

    console.log('✅ TEST SUITE 1 PASSED: Concurrency lock, singleton state, and release work cleanly.\n');
  }

  // =========================================================================
  // TEST SUITE 2: Abort / Cancellation Support in rateLimiter.service.js
  // =========================================================================
  console.log('--- TEST SUITE 2: Abort / Cancellation Support in rateLimiter.service.js ---');

  {
    const abortController = new AbortController();

    async function* generateItems() {
      for (let i = 1; i <= 20; i++) {
        yield { id: i, name: `User_${i}` };
      }
    }

    const processed = [];
    const queuePromise = runBroadcastQueue({
      items: generateItems(),
      signal: abortController.signal,
      delayMs: 20,
      sendFn: async (item) => {
        processed.push(item.id);
        if (item.id === 3) {
          // Trigger abort after processing item 3
          abortController.abort();
        }
      },
    });

    const result = await queuePromise;
    assert.strictEqual(result.aborted, true, 'Result aborted flag must be true');
    assert.strictEqual(result.sent, 3, 'Must have processed exactly 3 items before abort');
    assert.ok(processed.length <= 4, 'Must stop queue processing promptly after signal');

    console.log('✅ TEST SUITE 2 PASSED: Broadcast queue cleanly honors AbortSignal.\n');
  }

  // =========================================================================
  // TEST SUITE 3: Non-blocking Custom Broadcast in users.scene.js
  // =========================================================================
  console.log('--- TEST SUITE 3: Non-blocking Custom Broadcast in users.scene.js ---');

  {
    notif.releaseBroadcastLock();

    // Stub User.find().select().lean().cursor()
    const mockUsers = [
      { telegramId: 101, language: 'ru' },
      { telegramId: 102, language: 'en' },
      { telegramId: 103, language: 'ru' },
      { telegramId: 104, language: 'ru' },
    ];

    async function* userCursor() {
      for (const u of mockUsers) {
        await sleep(30); // artificial delay per user (total ~120ms)
        yield u;
      }
    }

    const origUserFind = User.find;
    User.find = () => ({
      select: () => ({
        lean: () => ({
          cursor: () => userCursor(),
        }),
      }),
    });

    const adminId = 99001;
    let cbAnswered = null;
    let editReplyMarkupCalled = false;
    let initialReplySent = null;
    let finalStatsSent = null;

    const mockCtx = {
      session: {
        broadcastPayload: {
          text: '📢 Важное объявление магазина!',
          mediaType: 'text',
          includeToS: false,
        },
      },
      from: { id: adminId },
      chat: { id: adminId },
      answerCbQuery: async (msg, opts) => {
        cbAnswered = { msg, opts };
      },
      editMessageReplyMarkup: async (markup) => {
        editReplyMarkupCalled = true;
      },
      reply: async (text, opts) => {
        initialReplySent = { text, opts };
      },
      telegram: {
        sendMessage: async (targetId, text, extra) => {
          if (targetId === adminId && text.includes('Массовая рассылка завершена')) {
            finalStatsSent = { targetId, text, extra };
          }
        },
      },
    };

    // Execute handler and measure time taken
    const startMs = Date.now();
    await usersScene.executeCustomBroadcast(mockCtx);
    const durationMs = Date.now() - startMs;

    // 1. Verify non-blocking return in < 50ms
    assert.ok(
      durationMs < 50,
      `Handler must resolve in <50ms (actual: ${durationMs}ms)`
    );

    // 2. Verify immediate UI response
    assert.strictEqual(mockCtx.session.broadcastPayload, null, 'Payload in session must be cleared immediately');
    assert.ok(cbAnswered, 'Callback query must be answered immediately');
    assert.ok(cbAnswered.msg.includes('Рассылка запущена в фоновом режиме'), 'Ack text must indicate background run');
    assert.strictEqual(editReplyMarkupCalled, true, 'Reply markup buttons must be removed to prevent double clicks');
    assert.ok(initialReplySent.text.includes('Рассылка запущена в фоновом режиме'), 'Initial reply message must be sent to admin');

    // 3. Verify broadcast lock is active while background queue runs
    assert.strictEqual(notif.isBroadcastActive(), true, 'Broadcast lock must be active during background run');

    // 4. Verify concurrency rejection
    let rejectedAlert = null;
    const concurrentCtx = {
      session: { broadcastPayload: { text: 'Other' } },
      from: { id: 99002 },
      answerCbQuery: async (msg, opts) => {
        rejectedAlert = { msg, opts };
      },
    };
    await usersScene.executeCustomBroadcast(concurrentCtx);
    assert.ok(rejectedAlert, 'Concurrent broadcast attempt must be answered immediately');
    assert.ok(rejectedAlert.msg.includes('Уже выполняется другая рассылка'), 'Must alert about concurrent broadcast');

    // 5. Wait for background queue to complete
    let waitCount = 0;
    while (!finalStatsSent && waitCount < 50) {
      await sleep(20);
      waitCount++;
    }

    assert.ok(finalStatsSent, 'Final statistics message must be delivered to admin');
    assert.strictEqual(finalStatsSent.targetId, adminId);
    assert.ok(finalStatsSent.text.includes('Успешно доставлено: <b>4</b>'), `Stats must report 4 sent. Got: ${finalStatsSent.text}`);
    assert.strictEqual(notif.isBroadcastActive(), false, 'Broadcast lock must be released after completion');

    // Restore User.find
    User.find = origUserFind;
    console.log('✅ TEST SUITE 3 PASSED: executeCustomBroadcast is non-blocking, concurrency-safe, and sends completion report.\n');
  }

  // =========================================================================
  // TEST SUITE 4: Non-blocking Product Broadcast in admin.routes.js
  // =========================================================================
  console.log('--- TEST SUITE 4: Non-blocking Product Broadcast in admin.routes.js ---');

  {
    notif.releaseBroadcastLock();

    // Register admin routes on a mock bot
    let registeredActionRegex = null;
    let registeredHandler = null;

    const mockBot = {
      action: (regex, ...handlers) => {
        if (regex instanceof RegExp && regex.source.includes('admin:p_broadcast:')) {
          registeredActionRegex = regex;
          registeredHandler = handlers[handlers.length - 1];
        }
      },
    };

    require('../src/bot/routes/admin.routes')(mockBot);
    assert.ok(registeredHandler, 'admin:p_broadcast handler must be registered');

    // Stub Product.findById & Key.countDocuments
    const testProductId = new mongoose.Types.ObjectId().toString();
    const origProductFindById = Product.findById;
    Product.findById = async (id) => {
      if (id === testProductId) {
        return {
          _id: testProductId,
          name: 'Telegram Premium 12 мес',
          icon: '⭐',
          type: 'key',
        };
      }
      return null;
    };

    const origKeyCount = Key.countDocuments;
    Key.countDocuments = async () => 25; // 25 stock

    const origBuildSeg = notif.buildSegmentQuery;
    const origCountSeg = notif.countSegment;
    const origBroadcastNewProduct = notif.broadcastNewProduct;

    notif.buildSegmentQuery = async (seg) => ({ query: {}, label: 'Все покупатели' });
    notif.countSegment = async (seg) => 30;

    let broadcastExecuted = false;
    notif.broadcastNewProduct = async (product, stock, segment) => {
      await sleep(100); // artificial delay
      broadcastExecuted = true;
      return { sent: 28, failed: 2, blocked: 0, total: 30 };
    };

    const adminId = 88001;
    let cbAnswered = null;
    let editReplyMarkupCalled = false;
    let editMessageTextCalled = null;
    let finalAdminReport = null;

    const mockCtx = {
      match: [`admin:p_broadcast:${testProductId}:active`, testProductId, 'active'],
      from: { id: adminId },
      chat: { id: adminId },
      answerCbQuery: async (msg, opts) => {
        cbAnswered = { msg, opts };
      },
      editMessageReplyMarkup: async (markup) => {
        editReplyMarkupCalled = true;
      },
      editMessageText: async (text, extra) => {
        editMessageTextCalled = { text, extra };
      },
      telegram: {
        sendMessage: async (targetId, text, extra) => {
          if (targetId === adminId && text.includes('Рассылка о товаре завершена')) {
            finalAdminReport = { targetId, text, extra };
          }
        },
      },
    };

    const startMs = Date.now();
    await registeredHandler(mockCtx);
    const durationMs = Date.now() - startMs;

    // 1. Verify non-blocking return in < 50ms
    assert.ok(durationMs < 50, `Product broadcast handler must resolve in <50ms (actual: ${durationMs}ms)`);

    // 2. Verify immediate UI feedback
    assert.ok(cbAnswered, 'Callback query must be answered immediately');
    assert.ok(cbAnswered.msg.includes('Рассылка о товаре запущена в фоновом режиме'));
    assert.strictEqual(editReplyMarkupCalled, true, 'Reply markup must be cleared');
    assert.ok(editMessageTextCalled.text.includes('Рассылка о товаре запущена в фоновом режиме'));

    // 3. Verify broadcast lock is active
    assert.strictEqual(notif.isBroadcastActive(), true, 'Lock must be active while product broadcast runs');

    // 4. Verify concurrent attempt is rejected
    let rejectedAlert = null;
    const concurrentCtx = {
      match: [`admin:p_broadcast:${testProductId}:all`, testProductId, 'all'],
      from: { id: 88002 },
      answerCbQuery: async (msg, opts) => {
        rejectedAlert = { msg, opts };
      },
    };
    await registeredHandler(concurrentCtx);
    assert.ok(rejectedAlert, 'Concurrent product broadcast must be rejected');
    assert.ok(rejectedAlert.msg.includes('Уже выполняется другая рассылка'));

    // 5. Wait for background product broadcast to finish
    let waitCount = 0;
    while (!finalAdminReport && waitCount < 50) {
      await sleep(20);
      waitCount++;
    }

    assert.ok(broadcastExecuted, 'broadcastNewProduct must have executed in background');
    assert.ok(finalAdminReport, 'Final completion message must be sent to adminId');
    assert.strictEqual(finalAdminReport.targetId, adminId);
    assert.ok(finalAdminReport.text.includes('Telegram Premium 12 мес'));
    assert.ok(finalAdminReport.text.includes('Отправлено: <b>28</b>'));
    assert.strictEqual(notif.isBroadcastActive(), false, 'Broadcast lock must be released after completion');

    // Restore stubs
    Product.findById = origProductFindById;
    Key.countDocuments = origKeyCount;
    notif.buildSegmentQuery = origBuildSeg;
    notif.countSegment = origCountSeg;
    notif.broadcastNewProduct = origBroadcastNewProduct;

    console.log('✅ TEST SUITE 4 PASSED: admin:p_broadcast handler is non-blocking and reports completion.\n');
  }

  // =========================================================================
  // TEST SUITE 5: Background Error Handling & Lock Release on Failure
  // =========================================================================
  console.log('--- TEST SUITE 5: Background Error Handling & Lock Release on Failure ---');

  {
    notif.releaseBroadcastLock();

    const origUserFind = User.find;
    User.find = () => ({
      select: () => ({
        lean: () => ({
          cursor: () => {
            throw new Error('Database connection reset during broadcast cursor stream');
          },
        }),
      }),
    });

    const adminId = 77001;
    let errorAlertSent = null;

    const mockCtx = {
      session: { broadcastPayload: { text: 'Will fail' } },
      from: { id: adminId },
      chat: { id: adminId },
      answerCbQuery: async () => {},
      editMessageReplyMarkup: async () => {},
      reply: async () => {},
      telegram: {
        sendMessage: async (targetId, text, extra) => {
          if (targetId === adminId && text.includes('Ошибка при выполнении массовой рассылки')) {
            errorAlertSent = { targetId, text };
          }
        },
      },
    };

    await usersScene.executeCustomBroadcast(mockCtx);

    // Wait for background error handling
    let waitCount = 0;
    while (!errorAlertSent && waitCount < 50) {
      await sleep(20);
      waitCount++;
    }

    assert.ok(errorAlertSent, 'Admin must be notified of background broadcast error');
    assert.ok(errorAlertSent.text.includes('Database connection reset'));
    assert.strictEqual(notif.isBroadcastActive(), false, 'Broadcast lock MUST be released in finally even on error');

    User.find = origUserFind;
    console.log('✅ TEST SUITE 5 PASSED: Exceptions in background queue are safely caught, reported, and unlock the lock.\n');
  }

  // =========================================================================
  // TEST SUITE 6: Latent Bug Fix in products.scene.js
  // =========================================================================
  console.log('--- TEST SUITE 6: Latent Bug Fix in products.scene.js ---');

  {
    // 1. Verify notif.notifyWaitlist exists on notification.service
    assert.strictEqual(typeof notif.notifyWaitlist, 'function', 'notif.notifyWaitlist must exist and be a function');
    assert.strictEqual(notif.broadcastRestock, undefined, 'notif.broadcastRestock must NOT exist (undefined)');

    // 2. Read products.scene.js file directly to verify source code fix
    const productsSceneSource = fs.readFileSync(path.join(__dirname, '../src/bot/scenes/admin/products.scene.js'), 'utf8');
    assert.ok(
      !productsSceneSource.includes('notif.broadcastRestock'),
      'products.scene.js must not contain any reference to nonexistent broadcastRestock'
    );
    assert.ok(
      productsSceneSource.includes('notif.notifyWaitlist(updatedProduct)'),
      'products.scene.js line 687 must call notif.notifyWaitlist(updatedProduct)'
    );

    console.log('✅ TEST SUITE 6 PASSED: Latent bug fixed: products.scene.js calls notifyWaitlist with logger warning fallback.\n');
  }

  console.log('=================================================================');
  console.log('🎉 ALL MILESTONE 5 TESTS PASSED SUCCESSFULLY! (6/6 Suites)');
  console.log('=================================================================\n');
}

runMilestone5Tests().catch((err) => {
  console.error('❌ MILESTONE 5 TEST FAILED:', err);
  process.exit(1);
});

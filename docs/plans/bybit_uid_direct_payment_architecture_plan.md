# Direct Bybit UID Order Payment & Automated Fulfillment Architecture
**Document Version:** 2.0.0 (Fortified Architecture Plan)  
**Status:** Approved Fortified Architecture Plan  
**Target Project:** Telegram Shop Bot (`c:\Users\user\Desktop\Shop bot`)  
**Scope:** Direct Bybit UID Checkout, Hybrid Automated/Manual Verification, Anti-Abuse, Financial Integrity, Concurrency Control, and Atomic Order Fulfillment  

---

## 1. Executive Summary & Problem Analysis

### 1.1 Context & Current System Limitations
The Telegram Shop Bot currently offers multi-channel catalog browsing, cart management, automated digital key issuance, external token activations, and crypto/fiat payment processing.

In the current checkout flow (`src/bot/scenes/shop.scene.js:1073-1087`), when a buyer confirms terms of service (`shop:tos_toggle`) and advances to payment (`handlePayStep`), the bot checks whether `user.balance >= totalCost`. If the user has insufficient balance, it computes the deficit:
$$\text{diff} = \text{parseFloat}((\text{totalCost} - \text{user.balance}).\text{toFixed}(2))$$
and presents the `"Чем платим?"` payment selection keyboard.

On this keyboard, line 1079 renders:
```javascript
Markup.button.callback(`📊 Bybit · UID · ${diff} USDT`, `topup:quick:${diff}`)
```
When clicked, this button triggers the callback handler in `src/bot/routes/core.routes.js:463-469`:
```javascript
bot.action(/^topup:quick:([\d.]+)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  if (!amount || amount <= 0) return ctx.answerCbQuery('⚠️ Некорректная сумма', { show_alert: true });
  await topupScene.startTopupWithAmount(ctx, amount);
});
```

### 1.2 Deep-Dive into Current Flow Failure Modes
1. **Context Annihilation**: 
   `topupScene.startTopupWithAmount(ctx, diff)` wipes out or ignores product purchase context (`productId`, `fromPage`, `qty`, `promoCode`). It initializes `ctx.session.topup = { amountUSDT: diff, ... }` and launches the generic top-up wizard (`topup.scene.js`).
2. **Disjointed User Experience**:
   Once the user completes the Bybit UID transfer and submits their UID/receipt, the top-up flow finishes by crediting `user.balance` and displaying a generic confirmation screen (`topup.scene.js:1092-1144`). The user is dumped back into the main menu without completing the purchase.
3. **Inventory Race & Loss of Purchase**:
   Between the moment the user leaves the checkout screen to top up and the moment their balance is credited, digital product stock (`Key` or `Product.manualStock`) remains completely unreserved. If another buyer purchases the last remaining stock in the interim, the original buyer is left with credited bot balance but unable to purchase the item they transferred cryptocurrency for.
4. **Vulnerability to Unintended Balance Accumulation**:
   Buyers frequently abandon checkout or become confused after top-up, requiring manual support intervention to locate their desired item again.

### 1.3 Architectural Objectives
The goal of this fortified architectural blueprint is to transform the `[📊 Bybit · UID · X USDT]` checkout button into a **first-class direct order payment pipeline**:
- **Direct Order Binding**: Checkout maintains the order context, product parameters, applied promo codes, and quantity.
- **Atomic Stock & Balance Reservation (Hold)**: Atomically locks digital keys (`Key.updateMany` with `reservationExpiresAt` and `usedByOrder: order._id`) or decrements manual stock, and atomically decrements `user.balance` by `balanceUsed` at order creation with a 15-minute Time-To-Live (TTL).
- **Hybrid Verification Engine**:
  - **Tier 1 (Automated API)**: Fast-path verification via Bybit V5 Asset API (`/v5/asset/deposit/query-internal-record`) detecting matching transfer within seconds using strictly canonical alphabetical parameter sorting.
  - **Tier 1B (Propagation Delay Grace Window)**: Graceful retry loop preserving `pending_payment` without prematurely escalating to admin review when Bybit internal records lag by 10–30 seconds.
  - **Tier 2 (Graceful Admin Fallback)**: Resilient fallback to Telegram admin moderation queue upon CloudFront 403 WAF blocks, network drops, or receipt screenshot uploads.
- **Instant Product Fulfillment**: Immediately upon payment confirmation (automated or manual), the bot commits the order, delivers keys/access credentials directly in the chat, and triggers post-purchase workflows (referral bonuses, seller accounting, warranty tracking) without double-deducting balance.
- **Zero Financial Leaks & Anti-Double-Spend**: Cross-system transfer ID deduplication via a dedicated shadow `TopupRequest` record preventing any Bybit transfer from being claimed both for an order and a balance topup, while isolating shadow records from revenue analytics and user profile history.

### 1.4 Non-Functional Requirements
| Attribute | Specification |
|---|---|
| **Atomicity** | MongoDB multi-document transactions (`withTransaction`) for inventory reservation, balance hold, payment commitment, and status transitions. |
| **Idempotency** | Strict partial unique indexes on Bybit `txID` (`partialFilterExpression: { bybitTxId: { $type: 'string' } }`) across orders and topups; deterministic retry semantics for API and admin operations. |
| **Availability** | Seamless failover: 100% of network failures or CloudFront 403 geo-blocks automatically route to admin moderation without dropping buyer context or reserving stock indefinitely. |
| **Security & Privacy** | Sender UID anti-impersonation (first-claim binding to `User.bybitUid`); strict numeric validation (`/^\d{6,12}$/`); HMAC-SHA256 signature generation with canonical parameter sorting and 5000ms recvWindow. |
| **Performance** | Automated verification completes within $\le 3$ seconds under normal network conditions; polling rate limits bounded to 300 req/s. |

---

## 2. End-to-End User Experience & Interaction State Machine

### 2.1 State Transition Model
The state machine encapsulates the lifecycle of an order paid via direct Bybit UID transfer:

```
                  [ Product Card / Cart ]
                             │
                             ▼ (User clicks "💰 Принять и перейти к оплате")
                  [ handlePayStep Screen ]
                             │
                             ▼ (User clicks "[📊 Bybit · UID · X USDT]")
              ┌──────────────────────────────────────────────────┐
              │    Init bybit_uid_checkout Scene:                │
              │  - Atomically hold balance: balanceUsed > 0      │
              │  - Atomically lock keys/stock (15m TTL)          │
              │  - Create Order (status: 'pending_payment')      │
              │  - Render payment instructions & recipient       │
              └─────────────────────────┬────────────────────────┘
                                        │
            ┌───────────────────────────┴────────────────────────────┐
            ▼ (User sends UID)                                       ▼ (User uploads photo)
    [ verifyUidUsdt(senderUid) ]                             [ Order -> 'admin_review' ]
            │                                                        │
     ┌──────┴─────────────────────────────────┐                      │
     ▼ (Match found & amount valid)           ▼ (Zero matches found) │
 [ Order -> 'completed' ]             [ Keep 'pending_payment' ]     │
 [ Delivery to User Chat ]            [ Prompt: Wait & Retry   ]     │
                                              │                      │
                       ┌──────────────────────┴───────┐              │
                       ▼ (User clicks [🔄 Проверить]) ▼ (WAF 403/DNS)│
                [ Re-check verifyUidUsdt ]   [ Order -> 'admin_review' ]
                                                      │
                                                      ▼
                                          [ Admin Telegram Alert ] ◄─┘
                                          [ Photo + Inline Approve/Reject ]
                                                      │
                                     ┌────────────────┴────────────────┐
                                     ▼ (Admin approves)                ▼ (Admin rejects)
                            [ Order -> 'completed' ]           [ Order -> 'cancelled' ]
                            [ Delivery to User Chat ]          [ Release Reserved Stock ]
                                                               [ Refund balanceUsed ]
                                                               [ Notify User ]
```

### 2.2 Order State Lifecycle Definitions
The `Order.status` field supports asynchronous external crypto settlement:

| Order Status | Phase | Description |
|---|---|---|
| `pending_payment` | Initiation | Order created; inventory (keys or manual stock) locked; `balanceUsed` atomically debited from `User.balance`. Awaiting user transfer and submission. Stock hold TTL = 15 minutes. |
| `verifying` | Processing | User submitted sender UID; automated Bybit V5 API verification in flight. |
| `admin_review` | Moderation | Automated check failed, CloudFront blocked, receipt photo uploaded, or manual escalation requested; awaiting operator approval. |
| `completed` | Fulfilled | Payment confirmed; digital keys delivered; warranty and referral triggers activated. `balanceUsed` is NOT deducted again. |
| `cancelled` | Terminated | Expired by TTL cron, rejected by admin, or cancelled by buyer; inventory unlocked; `balanceUsed` refunded back to `user.balance`. Zero refund for unpaid Bybit portion. |

---

### 2.3 User Interaction Journey & Screen Layouts

#### Screen 1: Payment Selection Screen (`shop.scene.js:1073-1087`)
When `user.balance < totalCost`, the checkout screen displays payment options. The Bybit UID button is updated to a dedicated callback:
```
Callback: shop:pay_bybit_uid:${productId}:${safePage}:${qty}
```

#### Screen 2: Direct Bybit UID Checkout Instructions (`bybit_uid_checkout`)
Upon entering `bybit_uid_checkout`, the bot reserves the product keys, holds partial balance, creates a `pending_payment` order, and displays:

```
┌─────────────────────────────────────────────────────────────┐
│ 📊 Оплата заказа #{orderIdShort} через Bybit UID            │
│                                                             │
│ Товар: <b>{productName}</b>                                 │
│ Количество: <b>{qty} шт.</b>                                │
│ Сумма к переводу: <b>{diff} USDT</b>                        │
│ <i>(С баланса бота зарезервировано: {balanceUsed} USDT)</i> │
│                                                             │
│ 📌 <b>Реквизиты для перевода (Bybit Internal Transfer):</b> │
│ • UID получателя: <code>{merchantBybitUid}</code>           │
│ • Тип перевода: <b>Внутренний перевод (без комиссии)</b>    │
│ • Монета: <b>USDT</b>                                       │
│                                                             │
│ ⏳ <b>Товар зарезервирован на 15 минут!</b>                  │
│ Переведите точную сумму ({diff} USDT) и отправьте ваш       │
│ <b>Bybit UID</b> текстовым сообщением или <b>скриншот</b>.  │
└─────────────────────────────────────────────────────────────┘
[ 🔎 Я перевёл — отправить UID ]
[ 📎 Прикрепить чек / скриншот ]
[ 🔄 Проверить статус ]
[ ❌ Отменить заказ ]
[ ⬅️ Назад к выбору оплаты ]
```

*Key UI/UX considerations*:
- Recipient UID `<code>{merchantBybitUid}</code>` uses HTML code formatting for instant 1-tap copying on iOS, Android, and Desktop Telegram clients.
- The payable amount is strict: Bybit internal transfers carry **0% fee**, so the transferred amount must be at least `{diff} USDT`.
- Visual 15-minute countdown indicator reinforces stock reservation safety.

#### Screen 3A: Verification in Progress
When the user submits their UID:
```
┌─────────────────────────────────────────────────────────────┐
│ ⏳ <b>Проверка платежа...</b>                                │
│                                                             │
│ Запрос перевода с UID: <code>{senderUid}</code>             │
│ Ожидаемая сумма: <b>{diff} USDT</b>                         │
│                                                             │
│ Подключаемся к Bybit API для подтверждения транзакции.      │
│ Это обычно занимает от 5 до 15 секунд...                    │
└─────────────────────────────────────────────────────────────┘
```

#### Screen 3B: Propagation Delay / Not Found Yet Screen (No Immediate Admin Escalation)
If Bybit API returns zero matches on the first check:
```
┌─────────────────────────────────────────────────────────────┐
│ ⏳ <b>Перевод пока не обнаружен в системе Bybit</b>         │
│                                                             │
│ Мы проверили входящие переводы от UID: <code>{senderUid}</code>, │
│ но Bybit ещё не отобразил запись в API.                     │
│                                                             │
│ ℹ️ <i>Внутренние переводы Bybit могут обрабатываться от     │
│ 15 до 60 секунд.</i>                                        │
│                                                             │
│ Подождите немного и нажмите <b>«Проверить статус»</b>.      │
│ Товар остаётся зарезервированным за вами.                   │
└─────────────────────────────────────────────────────────────┘
[ 🔄 Проверить статус ]
[ 📎 Отправить скриншот чека ]
[ 📨 Передать оператору на проверку ]
[ ❌ Отменить заказ ]
```

#### Screen 4A: Instant Automated Confirmation & Product Delivery
```
┌─────────────────────────────────────────────────────────────┐
│ ✅ <b>Платёж подтверждён! Заказ #{orderIdShort} оплачен</b>  │
│                                                             │
│ 💵 Получено: <b>{matchedAmount} USDT</b>                    │
│ 🔗 Bybit TxID: <code>{txID}</code>                          │
│                                                             │
│ 📦 <b>Ваш товар:</b>                                        │
│ <code>{deliveryKeyData}</code>                              │
│                                                             │
│ 🛡️ Гарантия: <b>{warrantyDays} дн.</b>                      │
│ Спасибо за покупку в нашем магазине!                        │
└─────────────────────────────────────────────────────────────┘
[ 📋 Мои заказы ]  [ 🛍️ В каталог ]
```

#### Screen 4B: Fallback to Admin Review (Photo Receipt or WAF Block)
```
┌─────────────────────────────────────────────────────────────┐
│ 📨 <b>Чек передан администратору на проверку</b>            │
│                                                             │
│ Заказ: <b>#{orderIdShort}</b> ({productName})               │
│ Сумма: <b>{diff} USDT</b>                                   │
│ Статус: <b>На проверке администратором</b>                  │
│                                                             │
│ Товар надёжно зарезервирован за вами. Как только            │
│ оператор подтвердит получение средств, бот пришлёт товар    │
│ прямо в этот диалог. Обычно это занимает 2–10 минут.        │
└─────────────────────────────────────────────────────────────┘
[ 🔄 Проверить статус заказа ]  [ 💬 Поддержка ]
```

---

### 2.4 Telegraf BaseScene Architecture: `bybit_uid_checkout.scene.js`
In the existing codebase (`src/bot/index.js`), `token_collection.scene.js` uses `Scenes.BaseScene`. We adhere strictly to this native pattern:

```javascript
// src/bot/scenes/bybit_uid_checkout.scene.js
const { Scenes, Markup } = require('telegraf');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Key = require('../../models/Key');
const User = require('../../models/User');
const { getSettings } = require('../../services/settingsCache.service');
const blockchainService = require('../../services/blockchain.service');
const notificationService = require('../../services/notification.service');
const promoService = require('../../services/promo.service');
const { withTransaction } = require('../../services/transactionHelper.service');
const { deliverCompletedOrder } = require('../../services/orderFulfillment.service');

const bybitUidCheckoutScene = new Scenes.BaseScene('bybit_uid_checkout');

// 1. Scene Enter
bybitUidCheckoutScene.enter(async (ctx) => {
  const { orderId } = ctx.scene.state;
  const order = await Order.findById(orderId).populate('productId');
  if (!order || order.status !== 'pending_payment') {
    await ctx.reply('⚠️ Заказ не найден или уже обработан.');
    return ctx.scene.leave();
  }
  // Render Screen 2 instructions
});

// 2. Action Handlers
bybitUidCheckoutScene.action('bybit:check_status', async (ctx) => {
  // Re-run verifyUidUsdt if senderUid exists, or check order status
});

bybitUidCheckoutScene.action('bybit:escalate_admin', async (ctx) => {
  // Explicit escalation to admin_review requested by buyer
});

bybitUidCheckoutScene.action('bybit:cancel', async (ctx) => {
  // Atomic cancel order: release keys, refund balanceUsed, mark cancelled
});

// 3. Message Listeners: Strict UID Validation
bybitUidCheckoutScene.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  
  // Strict numeric UID validation: 6 to 12 digits
  if (!/^\d{6,12}$/.test(text)) {
    return ctx.reply('⚠️ Bybit UID должен состоять из 6–12 цифр без пробелов и букв. Пожалуйста, введите корректный UID:');
  }

  const senderUid = text;
  // Anti-impersonation check: ensure UID is not claimed by another user
  const user = await User.findById(ctx.user._id);
  if (user.bybitUid && user.bybitUid !== senderUid) {
    return ctx.reply(`⚠️ Ваш профиль привязан к UID ${user.bybitUid}. Оплата с другого UID запрещена.`);
  }

  const existingOther = await User.findOne({ bybitUid: senderUid, _id: { $ne: user._id } });
  if (existingOther) {
    return ctx.reply('⚠️ Этот Bybit UID уже привязан к другому пользователю.');
  }

  // Update order with sender UID and run automated verification
  const order = await Order.findById(ctx.scene.state.orderId);
  order.bybitSenderUid = senderUid;
  await order.save();

  await ctx.reply('⏳ Проверяем поступление средств в Bybit API...');
  const res = await blockchainService.verifyUidUsdt(senderUid, order.createdAt, order.price - order.balanceUsed);

  if (res.success && res.match) {
    // Payment verified! Fulfill order atomically
    await deliverCompletedOrder(order._id, res.match.txID);
    return ctx.scene.leave();
  }

  if (res.blocked) {
    // WAF 403 or network failure -> escalate to admin_review
    order.status = 'admin_review';
    order.notes = `API заблокирован: ${res.reason}`;
    await order.save();
    await notificationService.notifyAdminOrderReview(order, 'Bybit API WAF/сетевая блокировка');
    return renderAdminReviewScreen(ctx, order);
  }

  // Zero matches found: internal Bybit propagation delay
  // DO NOT escalate to admin yet! Keep in pending_payment and show retry prompt
  return renderPropagationRetryScreen(ctx, order, senderUid);
});

bybitUidCheckoutScene.on('photo', async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileId = photo.file_id;
  const order = await Order.findById(ctx.scene.state.orderId);
  order.status = 'admin_review';
  order.paymentReceiptFileId = fileId;
  await order.save();
  await notificationService.notifyAdminOrderReview(order, 'Загружен чек/скриншот перевода', fileId);
  return renderAdminReviewScreen(ctx, order);
});

module.exports = bybitUidCheckoutScene;
```

### 2.5 Stage Mounting & Balance Hold Timing
In `src/bot/index.js:57-58`:
```javascript
// Existing:
// const stage = new Scenes.Stage([tokenCollectionScene]);

// Updated:
const bybitUidCheckoutScene = require('./scenes/bybit_uid_checkout.scene');
const stage = new Scenes.Stage([tokenCollectionScene, bybitUidCheckoutScene]);
bot.use(stage.middleware());
```

In `src/bot/routes/shop.routes.js`:
**Balance Reservation Timing Rule**:
If `balanceUsed > 0`, `user.balance` is decremented **atomically at the moment of `pending_payment` order creation** using `User.findOneAndUpdate({ _id: userId, balance: { $gte: balanceUsed } }, { $inc: { balance: -balanceUsed } }, { session, new: true })`. This guarantees funds cannot be spent concurrently while waiting for the crypto transfer.

```javascript
bot.action(/^shop:pay_bybit_uid:([a-fA-F0-9]{24}):(\d+):(\d+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const page = parseInt(ctx.match[2], 10) || 1;
  const qty = parseInt(ctx.match[3], 10) || 1;
  
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('⚠️ Товар недоступен', { show_alert: true });
  }

  const user = await User.findById(ctx.user._id);
  const promo = ctx.session?.promoCode;
  const totalCost = await promoService.calculateEffectiveTotal(product, qty, promo);
  
  const balanceUsed = Math.min(user.balance, totalCost);
  const diff = parseFloat((totalCost - balanceUsed).toFixed(2));

  let orderId = null;

  await withTransaction(async (session) => {
    // 1. Atomic Balance Reservation
    if (balanceUsed > 0) {
      const debitedUser = await User.findOneAndUpdate(
        { _id: user._id, balance: { $gte: balanceUsed } },
        { $inc: { balance: -balanceUsed } },
        { session, new: true }
      );
      if (!debitedUser) throw new Error('INSUFFICIENT_BALANCE_HOLD');
    }

    // 2. Atomic Multi-Key Reservation
    let allocatedKeyIds = [];
    const isAutoKeyProduct = product.type === 'key' || product.isAutoKey;
    if (isAutoKeyProduct) {
      const keys = await Key.find({
        productId: product._id,
        isUsed: false,
        reservationExpiresAt: null
      }).limit(qty).session(session);

      if (keys.length < qty) throw new Error('OUT_OF_STOCK');
      allocatedKeyIds = keys.map(k => k._id);
    } else if (product.type === 'manual' && product.manualStock !== -1) {
      const stockRes = await Product.updateOne(
        { _id: product._id, manualStock: { $gte: qty } },
        { $inc: { manualStock: -qty } },
        { session }
      );
      if (stockRes.modifiedCount === 0) throw new Error('OUT_OF_STOCK');
    }

    // 3. Create Pending Payment Order
    const order = new Order({
      userId: user._id,
      productId: product._id,
      qty,
      price: totalCost,
      status: 'pending_payment',
      paymentMethod: 'bybit_uid',
      paymentStatus: 'unpaid',
      isPaid: false,
      balanceUsed,
      keyId: allocatedKeyIds[0] || null,
      keyIds: allocatedKeyIds,
      paymentExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      createdAt: new Date(),
    });
    await order.save({ session });
    orderId = order._id;

    // 4. Mark reserved keys with order ID and TTL
    if (allocatedKeyIds.length > 0) {
      await Key.updateMany(
        { _id: { $in: allocatedKeyIds } },
        {
          $set: {
            isUsed: true,
            usedByOrder: order._id,
            usedAt: new Date(),
            reservationExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
          }
        },
        { session }
      );
    }
  });

  await ctx.scene.enter('bybit_uid_checkout', { orderId: orderId.toString() });
});
```

---

## 3. Hybrid Verification Engine Architecture

### 3.1 Automated Bybit V5 Asset API Verification (`blockchain.service.js`)

#### 3.1.1 API Specification & Return Structure Compatibility
Bybit V5 Asset API provides deposit tracking across on-chain deposits and off-chain internal transfers.
- **Protocol**: HTTPS GET
- **Base URL**: `https://api.bybit.com` (or configurable proxy gateway)
- **Path**: `/v5/asset/deposit/query-internal-record`
- **Rate Limit**: 300 requests/sec per API key.

**Return Structure Contract (`verifyUidUsdt`)**:
To ensure 100% backward compatibility with `src/bot/scenes/topup.scene.js:920` while satisfying the new direct order requirements, `verifyUidUsdt` must return:
```javascript
return {
  success: true,
  match: mappedMatches[0],   // Backward-compatible single match
  matches: mappedMatches,    // Array of all matching records for topup.scene.js
};
```
Where each item in `matches` has the structure `{ txID: m.txID, amount: parseFloat(m.amount), createdTime: parseInt(m.createdTime) }`.

#### 3.1.2 Identification & Correction of the Parser Bug & Strict Input Validation
In existing `src/services/blockchain.service.js:116-120`:
```javascript
// CURRENT BROKEN PARSER:
const matches = rows.filter(r =>
  r.coin === 'USDT' &&
  r.status === 2 &&
  String(r.address || '').trim() === uidClean
);
```

**Root Cause Failure & Vulnerability Analysis**:
1. In Bybit V5 Asset API internal deposit records:
   - `r.fromMemberId`: String containing the **Bybit UID of the sender** (e.g. `"104829102"`).
   - `r.address`: Sender's masked email or phone number if transferred via email/phone; empty string for direct UID transfers.
   - Matching only `r.address === uidClean` causes 100% of standard Bybit UID-to-UID transfers to evaluate to false!
2. **Empty String Security Vulnerability**:
   If `uidClean` or API fields are empty string, `"" === ""` evaluates to true, matching arbitrary empty address records!
3. **Non-Numeric UID Injection**:
   UIDs must be validated with `/^\d{6,12}$/` before querying or parsing.

**Fortified Robust Parser**:
```javascript
// Strict UID validation:
const uidClean = String(senderUid || '').trim();
if (!/^\d{6,12}$/.test(uidClean)) {
  return { success: false, reason: 'Bybit UID должен содержать от 6 до 12 цифр' };
}

// Fortified matching logic:
const matches = rows.filter(r => {
  if (r.coin !== 'USDT') return false;
  if (Number(r.status) !== 2) return false; // 2 = Success in Bybit V5 API
  
  const fromMemberClean = String(r.fromMemberId || '').trim();
  const addressClean = String(r.address || '').trim();
  
  // Guard against empty string equality: fields MUST be non-empty strings before comparison
  const matchesUid = (fromMemberClean !== '' && fromMemberClean === uidClean) ||
                     (addressClean !== '' && addressClean === uidClean);
  return matchesUid;
});
```

#### 3.1.3 Canonical Alphabetical Query Parameter Sorting for Bybit V5 HMAC-SHA256
Bybit V5 API authentication enforces strict signature verification:
$$\text{Signature} = \text{HMAC-SHA256}\Big(\text{secret},\; \text{timestamp} + \text{apiKey} + \text{recvWindow} + \text{queryString}\Big)$$
**Critical Flaw**: If query parameters are concatenated in arbitrary or non-alphabetical order, Bybit's gateway rejects the request with:
`retCode: 10004 ("error sign!")`.

**Canonical Query Formatter Implementation**:
```javascript
/**
 * Bybit V5 API Canonical Alphabetical Query String Builder
 * Sorts all query parameters alphabetically by key before generating HMAC-SHA256 signature.
 */
function buildSortedQueryString(params) {
  return Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

// Example usage:
const queryParams = {
  coin: 'USDT',
  limit: 50,
  startTime: orderCreatedAtMs - (10 * 60 * 1000),
};
const sortedQs = buildSortedQueryString(queryParams);
const signature = crypto.createHmac('sha256', BYBIT_API_SECRET)
  .update(timestamp + BYBIT_API_KEY + recvWindow + sortedQs)
  .digest('hex');

const url = `https://api.bybit.com/v5/asset/deposit/query-internal-record?${sortedQs}`;
```

Required request headers:
- `X-BAPI-API-KEY`: Merchant Bybit API Key
- `X-BAPI-TIMESTAMP`: Milliseconds epoch string
- `X-BAPI-RECV-WINDOW`: `'5000'`
- `X-BAPI-SIGN-TYPE`: `'2'`
- `X-BAPI-SIGN`: Lowercase hexadecimal HMAC hash
- `User-Agent`: Custom descriptive UA (`shop-bot/1.0 (+https://t.me/...)`) to avoid CloudFront default Axios blocks.

#### 3.1.4 Amount Corridor Tolerances & Zero-Fee Deficit Elimination
Automated verification enforces two mathematical validation gates:

1. **Zero-Deficit Amount Gate**:
   Bybit internal transfers between UIDs have **0% transaction fees**. Allowing a 1% deficit (e.g. 99% floor) introduces a permanent financial leak where users systematically pay 1% less. Therefore, underpayments are strictly disallowed:
   $$\text{payableAmount} \le \text{match.amount} \le \text{payableAmount} \times 1.05$$
   - **Underpayment** (`match.amount < payableAmount`): Rejects auto-verification. If user insists they paid, allows submitting screenshot for `admin_review`.
   - **Acceptable Window** ($\text{payableAmount} \le \text{match.amount} \le \text{payableAmount} \times 1.05$): Automatically accepts and fulfills the order immediately.
   - **Excess Overpayment** (`match.amount > payableAmount * 1.05`): Transitions order to `admin_review` so an administrator can confirm the overpayment, issue the goods, and credit the surplus change to `user.balance`.

2. **Temporal Window Gate**:
   $$\text{match.createdTime} \ge (\text{order.createdAt} - 10 \times 60 \times 1000)$$
   Matches with `createdTime` older than 10 minutes prior to order creation are rejected to prevent replay of historic transfers.

#### 3.1.5 Network Resilience, CloudFront 403/451 WAF Mitigation & Proxy Support
Because Bybit uses Amazon CloudFront, servers hosted on common Russian, Belarusian, or certain cloud provider IP ranges encounter HTTP 403 Forbidden or HTTP 451:

```
[ Axios GET api.bybit.com ]
            │
            ├─► HTTP 200 OK ──► Parse payload rows
            │
            ├─► HTTP 403 / 451 (CloudFront WAF) ──► Flag `blocked: true`, route to Admin Review
            │
            ├─► HTTP 429 (Rate Limit) ──► Flag `blocked: true`, route to Admin Review
            │
            └─► DNS / Network Failure (ENOTFOUND, ETIMEDOUT) ──► Flag `blocked: true`, route to Admin Review
```

**Proxy Gateway Architecture with Dual-Layer Resilience**:
1. Primary: Use `https-proxy-agent` via `process.env.BYBIT_PROXY_URL`.
2. Fallback: If `https-proxy-agent` is not installed or encounters an error, fall back gracefully to Axios native proxy configuration.

```javascript
let httpsAgent = undefined;
let axiosProxy = undefined;

if (process.env.BYBIT_PROXY_URL) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    httpsAgent = new HttpsProxyAgent(process.env.BYBIT_PROXY_URL);
  } catch (err) {
    logger.warn('[Bybit] https-proxy-agent package not loaded, falling back to Axios native proxy parser');
    const proxyUrl = new URL(process.env.BYBIT_PROXY_URL);
    axiosProxy = {
      protocol: proxyUrl.protocol.replace(':', ''),
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port, 10),
      auth: proxyUrl.username ? { username: proxyUrl.username, password: proxyUrl.password } : undefined,
    };
  }
}

const axiosConfig = {
  timeout: 10000,
  validateStatus: () => true,
  headers: { ...bapiHeaders },
  ...(httpsAgent ? { httpsAgent } : {}),
  ...(axiosProxy ? { proxy: axiosProxy } : {}),
};
```

---

### 3.2 Automated Fallback & Secondary Admin Review Pipeline

#### 3.2.1 Fallback Trigger Conditions Matrix
| Event | Detection | Action |
|---|---|---|
| **CloudFront 403/451** | `res.status === 403 \|\| res.status === 451` | Set `order.status = 'admin_review'`, dispatch photo/text to Telegram admin group. |
| **API Rate Limit / Server Error** | `res.status === 429 \|\| res.status >= 500` | Set `order.status = 'admin_review'`, alert admins. |
| **Network Timeout / DNS** | `err.code === 'ETIMEDOUT' \|\| 'ENOTFOUND'` | Set `order.status = 'admin_review'`, alert admins. |
| **Zero Matches (First Check)** | Empty filter results from API | **Remain in `pending_payment`**. Display propagation delay guidance with `[🔄 Проверить статус]` and `[📎 Отправить скриншот чека]`. |
| **Zero Matches (After Retries / Manual Request)** | User clicks `[📨 Передать оператору]` | Transition to `admin_review` with alert "Перевод не найден автоматически". |
| **Deficit Underpayment** | `match.amount < payableAmount` | Reject auto-verification; prompt user to top up deficit or submit receipt for review. |
| **Excess Overpayment** | `match.amount > payableAmount * 1.05` | Transition to `admin_review` with alert "Переплата: зачислить сдачу на баланс". |
| **Direct Receipt Upload** | User uploads screenshot image | Save `order.paymentReceiptFileId = file_id`, transition to `admin_review`. |

#### 3.2.2 Admin Alert Dispatch (`notification.service.js`)
When an order transitions to `admin_review`, an interactive moderation card is dispatched to Telegram administrators:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔔 <b>ТРЕБУЕТСЯ ПРОВЕРКА ОПЛАТЫ BYBIT UID</b>                    │
│                                                             │
│ Заказ: <b>#{orderIdShort}</b>                               │
│ Покупатель: @{username} (ID: <code>{telegramId}</code>)     │
│ Товар: <b>{productName}</b> ({qty} шт.)                     │
│ Ожидаемая сумма: <b>{diff} USDT</b>                         │
│ С баланса зарезервировано: <b>{balanceUsed} USDT</b>        │
│ Предоставленный UID: <code>{senderUid}</code>               │
│                                                             │
│ ⚠️ <b>Причина ручной проверки:</b>                          │
│ {reasonText}                                                │
│ <i>(Время создания: {createdAtFormatted})</i>               │
└─────────────────────────────────────────────────────────────┘
[ ✅ Одобрить и выдать товар ]
[ ❌ Отклонить платёж ]
[ 🔍 Детали заказа в админке ]
```

#### 3.2.3 Admin Interactive Action Handlers
Callback routing in `src/bot/routes/admin.routes.js`:

1. `admin:order:bybit_approve:${orderId}`:
   - Atomic verification that `order.status === 'admin_review'`.
   - Calls `deliverCompletedOrder(order._id, 'MANUAL_ADMIN_BYBIT')`.
   - Edits admin message to reflect: `✅ Одобрено администратором @adminUsername`.
2. `admin:order:bybit_reject:${orderId}`:
   - Sets `order.status = 'cancelled'`, `order.notes = 'Отклонено администратором: платёж не подтверждён'`.
   - Multi-key release:
     ```javascript
     await Key.updateMany(
       { usedByOrder: order._id },
       { $set: { isUsed: false, usedByOrder: null, usedAt: null, reservationExpiresAt: null } },
       { session }
     );
     ```
   - If manual stock product, restores manual stock:
     ```javascript
     if (product && product.manualStock !== -1) {
       await Product.updateOne({ _id: product._id }, { $inc: { manualStock: order.qty } }, { session });
     }
     ```
   - If `order.balanceUsed > 0`, refunds `balanceUsed` to `user.balance`:
     ```javascript
     await User.findOneAndUpdate(
       { _id: order.userId },
       { $inc: { balance: order.balanceUsed } },
       { session, new: true }
     );
     await new Transaction({
       userId: order.userId,
       type: 'refund',
       amount: order.balanceUsed,
       orderId: order._id,
       description: `Возврат списанного баланса (отклонено админом): заказ #${order._id}`,
     }).save({ session });
     ```
   - Edits admin message to reflect: `❌ Отклонено администратором @adminUsername`.
   - Notifies buyer: `"❌ Администратор отклонил платёж по заказу #{orderIdShort}. Если вы считаете это ошибкой, обратитесь в поддержку."`

---

## 4. Data Models, Schema Updates & Anti-Abuse Integrity

### 4.1 Order Schema Extension (`src/models/Order.js`)
The `Order` schema must be enriched with explicit payment tracking attributes:

```javascript
// Additions to src/models/Order.js:

// 1. Extend status enum:
status: {
  type: String,
  enum: [
    'pending',               // Paid, awaiting manual/supplier fulfillment
    'pending_payment',       // NEW: Created, inventory locked, partial balance debited
    'verifying',             // NEW: Automated Bybit API check in flight
    'admin_review',          // NEW: Awaiting operator manual payment confirmation
    'awaiting_token',        // Paid, awaiting GPT token input
    'awaiting_confirmation', // Paid, awaiting confirmation
    'activating',            // Paid, supplier activation in progress
    'completed',             // Paid & fulfilled
    'cancelled',             // Terminated (refunded if paid, released if unpaid)
    'failed',                // Execution failure
    'retry',                 // Transient failure retry
    'disputed',              // Dispute opened
    'preorder_pending'       // Preorder hold
  ],
  default: 'pending',
},

// 2. Direct Payment Metadata Fields:
paymentMethod: {
  type: String,
  enum: ['balance', 'bybit_uid', 'platega', 'card', 'crypto_bot'],
  default: 'balance',
},
paymentStatus: {
  type: String,
  enum: ['unpaid', 'verifying', 'admin_review', 'paid', 'refunded', 'expired'],
  default: 'paid', // Default 'paid' preserves backward compatibility for existing balance orders
},
isPaid: {
  type: Boolean,
  default: false,
  index: true,
},
balanceUsed: {
  type: Number,
  default: 0,
  min: 0,
},
keyIds: [{
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Key'
}],
bybitSenderUid: {
  type: String,
  default: null,
  trim: true,
},
bybitTxId: {
  type: String,
  default: undefined,
  trim: true,
},
paymentReceiptFileId: {
  type: String,
  default: null,
},
paymentExpiresAt: {
  type: Date,
  default: null,
  index: true,
},
paidAt: {
  type: Date,
  default: null,
},
linkedTopupRequestId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'TopupRequest',
  default: null,
},
```

#### Partial Filter Expression on `Order.bybitTxId` (Anti-Null Index Bug Elimination)
**The Problem with MongoDB Sparse Indexes**:
In MongoDB, a `{ unique: true, sparse: true }` index indexes documents where the field is explicitly set to `null` (because `null` is a materialized BSON value). Multiple orders created with `bybitTxId: null` will trigger an `E11000 duplicate key error` on `null`.

**The Partial Filter Solution**:
```javascript
// Correct Partial Filter Expression for bybitTxId on Order:
orderSchema.index(
  { bybitTxId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      bybitTxId: { $type: 'string' }
    },
    name: 'bybitTxId_string_unique'
  }
);

// Optimize TTL cleanup queries:
orderSchema.index(
  { status: 1, paymentExpiresAt: 1 },
  { name: 'status_paymentExpiresAt_idx' }
);
```

---

### 4.1.2 Key Schema Extension (`src/models/Key.js`)
To support atomic multi-key reservation and time-to-live sweeps:
```javascript
// src/models/Key.js additions:
const keySchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  provider: { type: String, enum: ['local', 'u1traby'], default: 'local' },
  value: { type: String, required: true },
  isUsed: { type: Boolean, default: false },
  usedAt: { type: Date, default: null },
  usedByOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  reservationExpiresAt: { type: Date, default: null, index: true }, // NEW
  createdAt: { type: Date, default: Date.now },
});

// Compound index for fast stock allocation:
keySchema.index(
  { productId: 1, isUsed: 1, reservationExpiresAt: 1 },
  { name: 'prod_isUsed_reservationExpiresAt_idx' }
);
```

---

### 4.2 Cross-Collection Double-Spending Prevention & Shadow Topup Accounting Separation

#### The Replay Attack Vector
- `TopupRequest` maintains `txid_string_unique` on `topuprequests.txid`.
- If an order stores `bybitTxId` only in `orders.bybitTxId`, an attacker could:
  1. Transfer 10 USDT via Bybit UID.
  2. Use the transfer to pay for Order #1.
  3. Immediately open `/profile → Пополнить баланс → Bybit UID` and submit the same UID/transfer to credit their wallet balance with 10 USDT.

#### Unified Architectural Defense (The Shadow Topup Bridge)
When payment is confirmed for an `Order`, the system atomically creates a shadow `TopupRequest` document within the same MongoDB transaction:

```javascript
// Schema additions to src/models/TopupRequest.js:
isDirectOrderShadow: { type: Boolean, default: false, index: true },
purpose: { type: String, enum: ['balance_topup', 'order_payment'], default: 'balance_topup' },
linkedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
```

```javascript
// Shadow Topup Creation inside deliverCompletedOrder transaction:
const shadowTopup = new TopupRequest({
  userId: order.userId,
  amount: order.price - order.balanceUsed,
  status: 'confirmed',
  method: 'bybit',
  network: 'uid',
  proofText: senderUid,
  txid: matchedTxId,
  isDirectOrderShadow: true,
  purpose: 'order_payment',
  linkedOrderId: order._id,
  adminId: order.adminId || null,
  processedAt: new Date(),
});
await shadowTopup.save({ session });

order.bybitTxId = matchedTxId;
order.linkedTopupRequestId = shadowTopup._id;
await order.save({ session });
```

#### Accounting & Analytics Separation
To prevent double-counting revenue (since order revenue is already tracked in `Order.aggregate`), all analytics queries and user transaction histories must filter out shadow topups:
1. In `src/bot/scenes/admin/stats.scene.js:168`:
   ```javascript
   TopupRequest.aggregate([
     { 
       $match: { 
         status: 'confirmed', 
         isDirectOrderShadow: { $ne: true },
         processedAt: { $gte: from, $lte: to } 
       } 
     },
     { $group: { _id: null, total: { $sum: '$amount' } } },
   ])
   ```
2. In user profile top-up history (`src/bot/scenes/profile.scene.js`):
   Exclude documents where `isDirectOrderShadow: true` or `purpose: 'order_payment'`.

---

### 4.3 Sender UID Anti-Impersonation & Account Binding Enforcement
In accordance with `src/models/User.js:49-65` and `topup.scene.js:857-880`:
- `User.bybitUid` has a sparse unique index `bybitUid_string_unique`.
- **First-Claim Wins Principle**:
  1. When a user submits `senderUid` in `bybit_uid_checkout`:
     - If `user.bybitUid` is already set and `user.bybitUid !== senderUid`, input is rejected:  
       `"⚠️ Ваш аккаунт привязан к Bybit UID {user.bybitUid}. Оплата с другого UID запрещена. Обратитесь в поддержку."`
     - If `user.bybitUid` is unset: Check `User.findOne({ bybitUid: senderUid, _id: { $ne: user._id } })`. If another user already claimed this UID, the input is rejected:  
       `"⚠️ Этот Bybit UID уже привязан к другому пользователю."`
  2. Upon the first successful payment confirmation, `user.bybitUid` is permanently saved to the user's document.

---

### 4.4 Financial Integrity Fix & Legacy Order Cancellation Backward Compatibility

#### Remediation of the Blind Cancellation Vulnerability
In `src/bot/scenes/admin/orders.scene.js:716-733 (`cancelOrder`)` and `src/services/refund.service.js:50-70 (`refundAndCloseOrder`)`:
Previously, cancelling an order executed blind balance crediting (`$inc: { balance: cancelledOrder.price }`). For unpaid `pending_payment` orders, this created counterfeit money out of thin air.

#### Backward-Compatible Refund Logic
Pre-existing orders in the database do not have `isPaid: true` set because that field is newly introduced. If the cancellation check strictly checked `if (cancelledOrder.isPaid === true)`, legacy orders paid with balance would fail to refund!

**The Backward-Compatible Resolution**:
```javascript
// Fortified and Backward-Compatible cancelOrder:
const isPaidOrder = (
  cancelledOrder.isPaid === true ||
  (cancelledOrder.isPaid === undefined && cancelledOrder.paymentMethod !== 'bybit_uid')
);

if (isPaidOrder) {
  // Pre-existing balance order or confirmed paid order: refund full price
  await User.findOneAndUpdate(
    { _id: cancelledOrder.userId },
    { $inc: { balance: cancelledOrder.price } },
    { new: true, ...(sessionOptions || {}) }
  );
  await new Transaction({
    userId: cancelledOrder.userId,
    type: 'refund',
    amount: cancelledOrder.price,
    orderId: cancelledOrder._id,
    description: `Возврат: заказ #${cancelledOrder._id} отменён`,
  }).save(sessionOptions);
} else if (cancelledOrder.balanceUsed > 0) {
  // Unfulfilled Bybit UID order where partial balance was held: refund ONLY balanceUsed
  await User.findOneAndUpdate(
    { _id: cancelledOrder.userId },
    { $inc: { balance: cancelledOrder.balanceUsed } },
    { new: true, ...(sessionOptions || {}) }
  );
  await new Transaction({
    userId: cancelledOrder.userId,
    type: 'refund',
    amount: cancelledOrder.balanceUsed,
    orderId: cancelledOrder._id,
    description: `Возврат зарезервированного баланса: заказ #${cancelledOrder._id} отменён`,
  }).save(sessionOptions);
} else {
  // Pure crypto unpaid order (0 balance used):
  // DO NOT CREDIT USER BALANCE!
  // Only release held stock and mark order cancelled.
}

// Multi-key inventory release for all cancelled orders:
await Key.updateMany(
  { usedByOrder: cancelledOrder._id },
  { $set: { isUsed: false, usedByOrder: null, usedAt: null, reservationExpiresAt: null } },
  sessionOptions
);

// Manual stock release:
if (cancelledOrder.productId) {
  const prod = await Product.findById(cancelledOrder.productId).session(session);
  if (prod && prod.manualStock !== -1) {
    await Product.updateOne(
      { _id: prod._id },
      { $inc: { manualStock: cancelledOrder.qty || 1 } },
      sessionOptions
    );
  }
}
```

---

## 5. Concurrency, Multi-Key Reservation & Stale Sweeps

### 5.1 Atomic Stock & Balance Allocation Mechanics

#### A. Digital Key Products (`qty >= 1`)
When an order is created, `qty` keys are atomically reserved:
```javascript
const availableKeys = await Key.find({
  productId: product._id,
  isUsed: false,
  reservationExpiresAt: null
}).limit(qty).session(session);

if (availableKeys.length < qty) throw new Error('OUT_OF_STOCK');

const keyIds = availableKeys.map(k => k._id);
await Key.updateMany(
  { _id: { $in: keyIds } },
  {
    $set: {
      isUsed: true,
      usedAt: new Date(),
      usedByOrder: order._id,
      reservationExpiresAt: new Date(Date.now() + 15 * 60 * 1000)
    }
  },
  { session }
);

order.keyId = keyIds[0];
order.keyIds = keyIds;
```

#### B. Manual Stock Products (`product.type === 'manual'`)
```javascript
if (product.manualStock !== -1) {
  const res = await Product.updateOne(
    { _id: product._id, manualStock: { $gte: qty } },
    { $inc: { manualStock: -qty } },
    { session }
  );
  if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');
}
```

#### C. Atomic Balance Hold Timing
If `balanceUsed > 0`:
```javascript
const holdRes = await User.findOneAndUpdate(
  { _id: userId, balance: { $gte: balanceUsed } },
  { $inc: { balance: -balanceUsed } },
  { session, new: true }
);
if (!holdRes) throw new Error('INSUFFICIENT_BALANCE_HOLD');
```

---

### 5.2 Stock Reservation TTL (15-Minute Expiration Window)
Every `pending_payment` order sets:
```javascript
order.paymentExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
```

---

### 5.3 Stale Orders Sweep Scope & Atomic Cancellation Guard (`staleOrders.cron.js`)
The cron job running every 60 seconds sweeps expired orders across both `'pending_payment'` and `'verifying'` statuses.

#### Race Condition Elimination via Atomic Guard
If a buyer confirms payment or an admin approves an order concurrently while the cron loop runs, releasing keys could leave a paid order without inventory.
To eliminate this race condition, the cron executes an **atomic `findOneAndUpdate` guard** before releasing keys:

```javascript
// src/cron/staleOrders.cron.js extension:
const sweepExpiredPendingPaymentOrders = async () => {
  const cutoff = new Date();
  
  // Find candidates that have expired
  const expiredOrders = await Order.find({
    status: { $in: ['pending_payment', 'verifying'] },
    paymentExpiresAt: { $lt: cutoff }
  });

  for (const order of expiredOrders) {
    await withTransaction(async (session) => {
      // 1. ATOMIC CANCELLATION GUARD:
      // Lock status transition first; if already completed/cancelled concurrently, update returns null
      const lockedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          status: { $in: ['pending_payment', 'verifying'] },
          paymentExpiresAt: { $lt: cutoff }
        },
        {
          $set: {
            status: 'cancelled',
            paymentStatus: 'expired',
            notes: 'Истёк 15-минутный срок ожидания оплаты Bybit UID'
          }
        },
        { session, new: true }
      );

      if (!lockedOrder) {
        // Order was already confirmed, approved, or cancelled concurrently! Abort sweep.
        return;
      }

      // 2. Release reserved keys (Multi-key support)
      await Key.updateMany(
        { usedByOrder: lockedOrder._id },
        {
          $set: {
            isUsed: false,
            usedByOrder: null,
            usedAt: null,
            reservationExpiresAt: null
          }
        },
        { session }
      );

      // 3. Release manual stock
      const product = await Product.findById(lockedOrder.productId).session(session);
      if (product && product.manualStock !== -1) {
        await Product.updateOne(
          { _id: product._id },
          { $inc: { manualStock: lockedOrder.qty || 1 } },
          { session }
        );
      }

      // 4. Refund held balanceUsed back to User.balance
      if (lockedOrder.balanceUsed > 0) {
        await User.updateOne(
          { _id: lockedOrder.userId },
          { $inc: { balance: lockedOrder.balanceUsed } },
          { session }
        );
        await new Transaction({
          userId: lockedOrder.userId,
          type: 'refund',
          amount: lockedOrder.balanceUsed,
          orderId: lockedOrder._id,
          description: 'Возврат зарезервированного баланса (истёк срок оплаты Bybit UID)',
        }).save({ session });
      }
    });

    // 5. Notify user in Telegram
    try {
      await bot.telegram.sendMessage(
        order.userId.telegramId,
        `⏳ <b>Время на оплату заказа #${order._id.toString().slice(-6)} истекло</b>\nРезерв товара снят. Если вы уже перевели средства, свяжитесь с поддержкой.`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  }
};
```

---

## 6. Order Fulfillment Pipeline Integration

### 6.1 Order Execution Engine (`deliverCompletedOrder`)
Fulfillment logic is consolidated into `src/services/orderFulfillment.service.js`.

Upon payment confirmation (automated Bybit verification or admin manual approval):
1. **Status Transition**:
   - Auto-key product $\to$ `'completed'`
   - GPT activation $\to$ `'awaiting_token'`
   - API supplier $\to$ `'pending'` / `'activating'`
   - Manual product $\to$ `'pending'`
2. `order.isPaid = true`
3. `order.paymentStatus = 'paid'`
4. `order.paidAt = new Date()`
5. **Balance Deduplication Rule**:
   `balanceUsed` was **already debited** from `user.balance` at order creation. Therefore, fulfillment **MUST NOT** deduct `balanceUsed` again!
   Instead, fulfillment records the purchase transaction audit log:
   ```javascript
   if (order.balanceUsed > 0) {
     await new Transaction({
       userId: order.userId,
       type: 'purchase',
       amount: order.balanceUsed,
       orderId: order._id,
       description: `Оплата заказа #${order._id} (частично с баланса)`,
     }).save({ session });
   }
   ```
6. **Shadow Topup Creation**:
   Creates the shadow `TopupRequest` record to establish `txid_string_unique` deduplication across the system.

### 6.2 Key-Based Products Fulfillment (`qty >= 1`)
For instant key products:
- Reads all allocated keys: `const keys = await Key.find({ usedByOrder: order._id });`
- Formats keys:
  ```javascript
  const keyTexts = keys.map(k => `<code>${escapeHtml(k.value)}</code>`).join('\n');
  ```
- Delivers keys via direct Telegram message.
- Initializes warranty tracking (`warrantyDays`).

### 6.3 Post-Fulfillment Side Effects & Referral Bonuses
Upon payment confirmation, the system triggers:
```javascript
await grantReferralBonusForFirstCompletedOrder(order.userId);
```
ensuring referrers receive commission for direct Bybit-funded orders identical to balance purchases.

---

## 7. Objective Verification Rubric, Test Matrices & Rollout Plan

### 7.1 Comprehensive Test Matrices

#### Tier 1: Happy Path Scenarios
| Test ID | Scenario | Input Data | Expected Output | Verification Method |
|---|---|---|---|---|
| **T1.1** | Direct Bybit UID purchase (Zero balance) | Cost: 10 USDT, Balance: 0 | `diff = 10 USDT`, Bybit checkout scene entered, recipient UID displayed, exact amount 10 USDT. | Inspect Telegram message and `ctx.scene.state`. |
| **T1.2** | Automated API verification match | User transfers 10 USDT from UID `12345678` | Bybit API returns `fromMemberId: '12345678'`, `amount: '10.00'`. Order marks `completed`, digital key delivered instantly. | Verify `Order.status === 'completed'`, `Key.isUsed === true`. |
| **T1.3** | Partial balance + Bybit UID | Cost: 25 USDT, Balance: 10 USDT | `balanceUsed = 10`, `diff = 15 USDT`. Balance debited 10 at creation. Upon payment, balance is NOT debited again. | Check `User.balance == 0`, `Order.balanceUsed == 10`. |
| **T1.4** | Multi-key order (`qty = 3`) | Product: key, `qty: 3`, Cost: 30 USDT | 3 keys reserved with `usedByOrder: order._id`. All 3 delivered on confirmation. | Assert `keys.length == 3`, all delivered in chat. |
| **T1.5** | First-claim UID binding | User has no `bybitUid` | Successful payment sets `User.bybitUid = '12345678'`. | Query MongoDB `User.findOne({ telegramId })`. |

#### Tier 2: Boundary, Deficit Elimination & Edge Cases
| Test ID | Scenario | Input Data | Expected Output | Verification Method |
|---|---|---|---|---|
| **T2.1** | Exact amount match | Expected: 10.00 USDT, Received: 10.00 USDT | $10.00 \ge 10.00$. Verification passes, instant delivery. | Verify automated completion without admin review. |
| **T2.2** | Underpayment deficit (< 100%) | Expected: 10.00 USDT, Received: 9.92 USDT | $9.92 < 10.00$. Auto-verification rejects (0% fee policy). Transitions to `admin_review` if user persists. | Check `Order.status !== 'completed'`. |
| **T2.3** | Overpayment (> 105%) | Expected: 10.00 USDT, Received: 20.00 USDT | Auto-verification halts; transitions to `admin_review` for operator to credit change. | Check `Order.status === 'admin_review'`. |
| **T2.4** | Propagation delay retry | Bybit internal record delayed 20s | Scene remains in `pending_payment`, user clicks `[🔄 Проверить статус]` and succeeds on retry. | Verify order does not jump to `admin_review` on 1st check. |
| **T2.5** | Historic transfer replay | Transfer created 2 hours ago | `createdTime < orderCreatedAt - 10m`. Match rejected. | Ensure old deposit not claimed. |
| **T2.6** | Reservation expiration (15 min) | User never sends payment | `staleOrders.cron` sweeps at $T+15\text{m}$. Keys released, held `balanceUsed` refunded, zero balance created. | Assert `Key.isUsed === false`, `User.balance` restored. |

#### Tier 3: Cross-System Abuse, Financial Integrity & Security
| Test ID | Scenario | Input Data | Expected Output | Verification Method |
|---|---|---|---|---|
| **T3.1** | Cross-collection replay attack | Bybit TxID `bybit-tx-001` confirmed on Order #1 | User submits `bybit-tx-001` in `/profile → Пополнить`. Top-up rejects duplicate `txid`. | Assert MongoDB E11000 or duplicate error. |
| **T3.2** | Cross-user UID impersonation | User B submits UID bound to User A | Checkout halts immediately: `"UID привязан к другому пользователю"`. | Inspect Telegram alert dialog. |
| **T3.3** | Unpaid order cancellation refund exploit | Admin cancels unpaid order in `admin_review` | Keys released, order cancelled. `User.balance` is **NOT** credited for unpaid crypto portion. | Assert `User.balance` unchanged. |
| **T3.4** | Legacy order cancellation compatibility | Admin cancels pre-existing legacy balance order | `isPaidOrder` evaluates to true; legacy order refunded full amount. | Assert legacy user balance refunded. |
| **T3.5** | Stale sweep race condition | Cron sweeps while user confirms payment | Atomic `findOneAndUpdate` guards transaction; keys not released for completed order. | Test concurrent execution harness. |
| **T3.6** | Non-numeric / Empty UID input | User inputs `"abc"`, `""`, or spaces | Rejected with validation message: `"Bybit UID должен состоять из 6–12 цифр"`. | Test regex validator. |

#### Tier 4: Operational & Network Failures
| Test ID | Scenario | Input Data | Expected Output | Verification Method |
|---|---|---|---|---|
| **T4.1** | CloudFront 403 WAF Geo-block | Bybit API returns HTTP 403 | Clean transition to `admin_review`, prompts user for screenshot, alerts admins. | Mock HTTP 403 response; check admin message. |
| **T4.2** | Network drop / DNS timeout | Axios throws `ETIMEDOUT` | Scene catches error, switches to manual review without crashing bot process. | Mock timeout; verify process liveness. |
| **T4.3** | Photo receipt submission | User sends screenshot image | Telegram `photo` handler extracts `file_id`, forwards to admins with inline approval buttons. | Verify admin receives photo caption with buttons. |

---

### 7.2 Mock Bybit API Test Harness Specification
To verify the implementation independently of live Bybit network access, an automated test harness simulates both successful responses and edge cases:

```javascript
// test/mocks/bybitApi.mock.js
const http = require('http');

class MockBybitServer {
  constructor(port = 9099) {
    this.port = port;
    this.records = [];
    this.statusToReturn = 200;
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (this.statusToReturn !== 200) {
        res.writeHead(this.statusToReturn, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ retCode: 10002, retMsg: 'CloudFront WAF Block' }));
      }

      const url = new URL(req.url, `http://localhost:${this.port}`);
      if (url.pathname === '/v5/asset/deposit/query-internal-record') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          retCode: 0,
          retMsg: 'success',
          result: { rows: this.records }
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    return new Promise(resolve => this.server.listen(this.port, resolve));
  }

  stop() {
    return new Promise(resolve => this.server.close(resolve));
  }

  setDepositRecords(rows) {
    this.records = rows;
  }

  simulateWafBlock() {
    this.statusToReturn = 403;
  }

  reset() {
    this.records = [];
    this.statusToReturn = 200;
  }
}

module.exports = MockBybitServer;
```

---

### 7.3 Phased Implementation & Rollout Roadmap

```
Phase 1: Foundation, Schemas & Data Integrity
  ├── 1.1 Update src/models/Order.js:
  │         - Add status enum values: 'pending_payment', 'verifying', 'admin_review'
  │         - Add fields: paymentMethod, paymentStatus, isPaid, balanceUsed, keyIds, bybitTxId
  │         - Establish partial unique index: { bybitTxId: 1 }, partialFilterExpression: { bybitTxId: { $type: 'string' } }
  ├── 1.2 Update src/models/Key.js:
  │         - Add reservationExpiresAt: { type: Date, default: null, index: true }
  │         - Add compound index: { productId: 1, isUsed: 1, reservationExpiresAt: 1 }
  ├── 1.3 Update src/models/TopupRequest.js:
  │         - Add isDirectOrderShadow: { type: Boolean, default: false, index: true }
  │         - Add purpose: { type: String, enum: ['balance_topup', 'order_payment'], default: 'balance_topup' }
  ├── 1.4 Database migration script:
  │         - Backfill { isPaid: true, paymentMethod: 'balance' } for all existing completed/pending orders
  └── 1.5 Fortify cancelOrder & refundAndCloseOrder (check isPaidOrder, refund only balanceUsed, updateMany keys)

Phase 2: Dependencies, Core Services & Verification Engine
  ├── 2.1 Dependency installation: npm install https-proxy-agent@^7.0.4
  ├── 2.2 Patch src/services/blockchain.service.js:
  │         - Implement buildSortedQueryString for canonical alphabetical parameter sorting
  │         - Fix parser bug: check fromMemberId and address with non-empty string guards
  │         - Strict numeric UID validation (/^\d{6,12}$/)
  │         - Return structure: { success: true, match: matches[0], matches: matches } (topup.scene.js compatibility)
  │         - Add HttpsProxyAgent support and Axios native proxy fallback
  │         - Enforce zero-fee deficit elimination (amount >= payableAmount)
  └── 2.3 Create src/services/orderFulfillment.service.js:
            - deliverCompletedOrder with multi-key delivery and shadow TopupRequest bridge

Phase 3: Checkout Scene & User Experience
  ├── 3.1 Implement src/bot/scenes/bybit_uid_checkout.scene.js:
  │         - Screen 2: Recipient UID instructions & 15-min countdown
  │         - Screen 3A: Verification in progress
  │         - Screen 3B: Propagation delay retry screen (do not jump to admin_review)
  │         - Text listener with UID validation & anti-impersonation
  │         - Photo listener capturing receipt file_id
  ├── 3.2 Mount scene in Scenes.Stage (src/bot/index.js)
  └── 3.3 Update src/bot/routes/shop.routes.js:
            - Callback: shop:pay_bybit_uid:${productId}:${safePage}:${qty}
            - Atomic balance hold at order creation

Phase 4: Admin Moderation, Accounting Separation & Stale Sweeps
  ├── 4.1 Admin interactive approval/rejection handlers in src/bot/routes/admin.routes.js:
  │         - admin:order:bybit_approve:${orderId}
  │         - admin:order:bybit_reject:${orderId} (multi-key release & balanceUsed refund)
  ├── 4.2 Isolate shadow topups in src/bot/scenes/admin/stats.scene.js:
  │         - Add { isDirectOrderShadow: { $ne: true } } to TopupRequest aggregations
  └── 4.3 Extend src/cron/staleOrders.cron.js:
            - Sweep { status: { $in: ['pending_payment', 'verifying'] }, paymentExpiresAt: { $lt: cutoff } }
            - Atomic findOneAndUpdate guard before inventory release
            - Multi-key release and balanceUsed refund

Phase 5: Automated Verification & Production Deployment
  ├── 5.1 Run test matrices T1.1–T4.3 against MockBybitServer
  ├── 5.2 Dry-run in staging environment with live testnet Bybit UID
  └── 5.3 Verify index creation in MongoDB via syncIndexes()
```

---

### 7.4 Legacy Database Migration Script & Operational Runbook

#### 7.4.1 Legacy Order Backfill Migration Script
Prior to rolling out the new cancellation rules, run this migration script to backfill `isPaid: true` and `paymentMethod: 'balance'` on pre-existing completed or in-progress orders:

```javascript
// scripts/migrations/backfill_legacy_orders_isPaid.js
const mongoose = require('mongoose');
const Order = require('../../src/models/Order');
const { MONGODB_URI } = require('../../src/config');

async function migrate() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB. Running legacy orders backfill...');

  const result = await Order.updateMany(
    {
      isPaid: { $exists: false },
      status: { $in: ['pending', 'completed', 'awaiting_token', 'activating'] }
    },
    {
      $set: {
        isPaid: true,
        paymentMethod: 'balance',
        paymentStatus: 'paid',
        balanceUsed: 0
      }
    }
  );

  console.log(`Migration complete. Updated ${result.modifiedCount} legacy orders.`);
  await mongoose.disconnect();
}

migrate().catch(console.error);
```

#### 7.4.2 Database Index Verification Command
Run the following one-line command to establish all new indexes across `Order`, `Key`, and `TopupRequest`:
```bash
node -e "Promise.all([
  require('./src/models/Order').syncIndexes(),
  require('./src/models/Key').syncIndexes(),
  require('./src/models/TopupRequest').syncIndexes()
]).then(() => { console.log('All partial and compound indexes established successfully.'); process.exit(0); });"
```

#### 7.4.3 Disaster Recovery Runbook
1. **CloudFront 403 / 451 WAF Outages**:
   - The bot automatically falls back to manual admin review without downtime or crashed requests.
   - To restore automated API verification, configure `BYBIT_PROXY_URL` in `.env` and restart:
     ```bash
     pm2 reload shop-bot
     ```
2. **Unclaimed Admin Moderation Alerts**:
   - If an order remains in `admin_review` for $> 1$ hour: A recurring cron alerts admins: `"⚠️ Внимание: заказ #X ожидает подтверждения уже 1 час!"`.

---
**End of Fortified Architecture Plan**

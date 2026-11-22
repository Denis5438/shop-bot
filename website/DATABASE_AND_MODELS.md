# MongoDB Schema Architecture, Model Reuse & Concurrency Synchronization

## 1. Overview & Single-Cluster Multi-Interface Topology

The web platform connects directly to the existing MongoDB Atlas replica set, sharing the database cluster with the Telegram Shop Bot. This architecture eliminates data fragmentation, guarantees instant state synchronization across both channels, and reuses all existing Mongoose models located in `src/models/`.

```
                    ┌────────────────────────────────────────────────────────┐
                    │               MongoDB Atlas Replica Set                │
                    │               (Primary & Secondary Nodes)              │
                    └───────────────────────────▲────────────────────────────┘
                                                │
                     Mongoose Connection Pool   │   Mongoose Connection Pool
                    (maxPoolSize: 20, SSL/TLS)  │  (maxPoolSize: 20, SSL/TLS)
                    ┌───────────────────────────┴────────────────────────────┐
                    │                                                        │
                    ▼                                                        ▼
    ┌───────────────────────────────┐                        ┌───────────────────────────────┐
    │    Express.js REST API        │                        │    Telegram Shop Bot Engine   │
    │  - Web Storefront Requests    │                        │  - Telegraf Commands & Scenes │
    │  - Web Admin Operations       │                        │  - User Bot Checkouts         │
    │  - External Payment Webhooks  │                        │  - Background Cron Workers    │
    │  - JWT Stateless Auth         │                        │  - Telegraf Session State     │
    └───────────────────────────────┘                        └───────────────────────────────┘
```

---

## 2. Complete Model Catalog & Schema Reuse (All 19 Models + AuthSession)

Every model in `src/models/` is documented below with its exact fields, BSON data types, default values, validation rules, and indexes (including unique, sparse, compound, partial, and TTL indexes).

### 2.1 `User` (`src/models/User.js`)
Represents customer and administrative user profiles, balances, roles, and shopping carts.
- **Collection Name**: `users`
- **Schema Fields**:
  | Field | Type | Required | Default | Validation / Description |
  |---|---|---|---|---|
  | `telegramId` | `Number` | Yes | N/A | Unique 64-bit Telegram user identifier. Primary user handle. |
  | `username` | `String` | No | `null` | Telegram `@username` without the `@` prefix. |
  | `firstName` | `String` | No | `''` | User's first name. |
  | `lastName` | `String` | No | `''` | User's last name. |
  | `language` | `String` | No | `'ru'` | Enum: `['ru', 'en']`. Interface language preference. |
  | `balance` | `Number` | No | `0` | Available account balance in USDT. Supports 4 decimals. |
  | `role` | `String` | No | `'user'` | Enum: `['user', 'admin', 'superadmin']`. Authorization role. |
  | `promotedBy` | `Number` | No | `null` | Telegram ID of the superadmin who elevated this user. |
  | `referralCode` | `String` | No | Auto (8 hex) | Unique referral code generated in `pre('save')` via `crypto.randomBytes(4).toString('hex').toUpperCase()`. |
  | `referredBy` | `ObjectId` | No | `null` | Ref: `User`. The user who referred this account. |
  | `referralBonusGrantedAt` | `Date` | No | `null` | Timestamp when referral bonus was credited to referrer. |
  | `totalSpent` | `Number` | No | `0` | Cumulative total spent in USDT across all completed purchases. |
  | `isBanned` | `Boolean` | No | `false` | Access revocation flag. When `true`, web and bot access is blocked. |
  | `takeoverBy` | `Number` | No | `null` | Admin Telegram ID actively handling live chat. |
  | `takeoverAt` | `Date` | No | `null` | Timestamp when live takeover began. |
  | `acceptedToS` | `Boolean` | No | `false` | Terms of Service consent agreement flag. |
  | `acceptedToSAt` | `Date` | No | `null` | Timestamp of ToS agreement. |
  | `btnStyle` | `String` | No | `'colored'` | Enum: `['colored', 'classic']`. Bot button styling. |
  | `buttonLayout` | `String` | No | `'rich'` | Enum: `['rich', 'classic']`. Bot layout preference. |
  | `activePromoCode` | `ObjectId` | No | `null` | Ref: `PromoCode`. Currently active discount coupon. |
  | `cartVersion` | `Number` | No | `0` | Optimistic concurrency token incremented on every cart modification. |
  | `cart` | `Array` | No | `[]` | Array of subdocuments: `{ productId: ObjectId (ref Product), qty: Number (min 1), addedAt: Date }`. |
  | `achievements` | `Array` | No | `[]` | Array of subdocuments: `{ code: String, unlockedAt: Date }`. |
  | `bybitUid` | `String` | No | `undefined` | User's Bybit Account UID bound upon first verified Bybit deposit. |
  | `createdAt` | `Date` | No | `Date.now` | User registration timestamp. |
- **Indexes**:
  - `{ telegramId: 1 }` (Unique)
  - `{ referralCode: 1 }` (Unique)
  - `{ bybitUid: 1 }` (Unique, Partial: `{ bybitUid: { $type: 'string' } }`)
  - `{ referredBy: 1, referralBonusGrantedAt: 1 }` (Compound)
  - `{ createdAt: -1 }` (Compound / Query sorting)
  - `{ isBanned: 1, totalSpent: -1 }` (Compound admin filter)

---

### 2.2 `Product` (`src/models/Product.js`)
Catalog products available for purchase.
- **Collection Name**: `products`
- **Schema Fields**:
  | Field | Type | Required | Default | Validation / Description |
  |---|---|---|---|---|
  | `name` | `String` | Yes | N/A | Russian product display name. |
  | `nameEn` | `String` | No | `''` | English product display name. |
  | `description` | `String` | No | `''` | Full markdown description in Russian. |
  | `descriptionEn` | `String` | No | `''` | Full markdown description in English. |
  | `price` | `Number` | Yes | N/A | Base retail price in USDT. |
  | `costPrice` | `Number` | No | `0` | Wholesale / supplier cost in USDT (absolute price floor). |
  | `officialPrice` | `Number` | No | `0` | Baseline MSRP price used for discount strikethrough display. |
  | `officialDiscountPercent` | `Number` | No | `0` | Display discount percentage badge. |
  | `icon` | `String` | No | `'📦'` | Unicode emoji or icon identifier. |
  | `type` | `String` | Yes | `'key'` | Enum: `['key', 'gpt_activation', 'manual']`. Fulfillment type. |
  | `manualStock` | `Number` | No | `-1` | Stock count: `-1` = infinite/untracked, `>= 0` = manual inventory count. |
  | `provider` | `String` | Yes | Dynamic | Enum: `['local', 'u1traby', 'jaha', 'akunding', 'canboso', 'trumpstore']`. |
  | `supplierProductCode` | `String` | No | `null` | External product SKU / identifier in supplier API. |
  | `categoryId` | `ObjectId` | No | `null` | Ref: `Category`. Parent category identifier. |
  | `deliveryMethod` | `String` | No | `'activation'` | Enum: `['activation', 'ready_account']`. Delivery mechanic. |
  | `isActive` | `Boolean` | No | `true` | Public catalog visibility flag. |
  | `sortOrder` | `Number` | No | `0` | Display sort order (ascending). |
  | `warrantyDays` | `Number` | No | `5` | Warranty coverage window in days. |
  | `subscriptionDays` | `Number` | No | `30` | Subscription validity duration in days. |
  | `itemOrigin` | `String` | No | `'verified'` | Enum: `['verified', 'supplier']`. Trust badge marker. |
  | `sellerId` | `ObjectId` | No | `null` | Ref: `Seller`. External third-party seller identifier. |
  | `sellerPrice` | `Number` | No | `0` | Payout amount in USDT credited to seller upon fulfillment. |
  | `flashSale` | `Object` | No | Default | `{ enabled: Boolean, discountPercent: Number, expiresAt: Date, startedAt: Date }`. |
  | `createdAt` | `Date` | No | `Date.now` | Creation timestamp. |
  | `lastSoldAt` | `Date` | No | `Date.now` | Timestamp of last sale (used by auto-markdown engine). |
  | `lowStockNotifiedAt` | `Date` | No | `null` | Timestamp when admin was alerted of inventory depletion. |
- **Indexes**:
  - `{ categoryId: 1, isActive: 1, sortOrder: 1 }` (Compound catalog navigation)
  - `{ isActive: 1, sortOrder: 1 }` (Compound default catalog listing)

---

### 2.3 `Category` (`src/models/Category.js`)
Catalog taxonomy and categorization.
- **Collection Name**: `categories`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `name` | `String` | Yes | N/A | Category title (e.g., "AI Подписки", "Софт"). |
  | `icon` | `String` | No | `'📁'` | Emoji / icon character. |
  | `sortOrder` | `Number` | No | `0` | Display ordering. |
  | `isActive` | `Boolean` | No | `true` | Visibility flag. |
  | `createdAt` | `Date` | No | `Date.now` | Mongoose timestamp. |
  | `updatedAt` | `Date` | No | `Date.now` | Mongoose timestamp. |
- **Indexes**:
  - `{ isActive: 1, sortOrder: 1 }`

---

### 2.4 `Order` (`src/models/Order.js`)
Customer purchase orders, digital deliveries, and warranty records.
- **Collection Name**: `orders`
- **Schema Fields**:
  | Field | Type | Required | Default | Validation / Description |
  |---|---|---|---|---|
  | `userId` | `ObjectId` | Yes | N/A | Ref: `User`. Buyer identifier. |
  | `productId` | `ObjectId` | Yes | N/A | Ref: `Product`. Purchased item identifier. |
  | `provider` | `String` | No | N/A | Provider enum matching product provider. |
  | `status` | `String` | No | `'pending'` | Enum: `['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'completed', 'cancelled', 'failed', 'retry', 'disputed', 'preorder_pending']`. |
  | `price` | `Number` | Yes | N/A | Charged price in USDT. |
  | `qty` | `Number` | No | `1` | Quantity ordered. |
  | `costPrice` | `Number` | No | `0` | Item cost in USDT at moment of order. |
  | `keyId` | `ObjectId` | No | `null` | Ref: `Key`. Delivered digital key document. |
  | `tokenRaw` | `String` | No | `null` | Encrypted user access token (`select: false`). |
  | `apiOrderId` | `String` | No | `null` | External supplier API order identifier. |
  | `supplierOrderId` | `String` | No | `null` | Secondary supplier tracking reference. |
  | `supplierIdempotencyKey` | `String` | No | `null` | Format: `ord-<orderId>`. Prevents supplier double-billing. |
  | `activationResult` | `String` | No | `null` | Response text/error from external activation service. |
  | `adminId` | `ObjectId` | No | `null` | Ref: `User`. Admin who manually fulfilled or cancelled. |
  | `confirmedAt` | `Date` | No | `null` | Order completion timestamp. |
  | `deliveryData` | `String` | No | `null` | Plaintext credentials/keys delivered to buyer. |
  | `warrantyDays` | `Number` | No | `5` | Active warranty duration. |
  | `disputeStatus` | `String` | No | `'open'` | Enum: `['open', 'resolved']`. |
  | `replacementStatus` | `String` | No | `'none'` | Enum: `['none', 'pending', 'approved', 'rejected']`. |
  | `replacedKeyId` | `ObjectId` | No | `null` | Ref: `Key`. Newly issued replacement key. |
  | `createdAt` | `Date` | No | `Date.now` | Order creation date. |
- **Indexes**:
  - `{ status: 1, createdAt: -1 }` (Admin order queues)
  - `{ status: 1, nextRetryAt: 1 }` (Automated retry cron)
  - `{ userId: 1, createdAt: -1 }` (User purchase history)
  - `{ sellerId: 1, status: 1 }` (Seller dashboard)
  - `{ status: 1, confirmedAt: -1 }` (Analytics)
  - `{ replacementStatus: 1 }` (Partial: `{ replacementStatus: 'pending' }`)
  - `{ supplierIdempotencyKey: 1 }` (Unique, Partial: `{ supplierIdempotencyKey: { $type: 'string' } }`)

---

### 2.5 `Key` (`src/models/Key.js`)
Digital key and credential inventory pool.
- **Collection Name**: `keys`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `productId` | `ObjectId` | Yes | N/A | Ref: `Product`. Parent product SKU. |
  | `provider` | `String` | No | `'local'` | Enum: `['local', 'u1traby']`. |
  | `value` | `String` | Yes | N/A | Credential payload (`KEY-XXXX`, `login:pass:2fa`, or invite URL). |
  | `isUsed` | `Boolean` | No | `false` | Availability state. `false` = available in pool; `true` = assigned to order. |
  | `usedAt` | `Date` | No | `null` | Timestamp of allocation. |
  | `usedByOrder` | `ObjectId` | No | `null` | Ref: `Order`. Assigned order reference. |
  | `createdAt` | `Date` | No | `Date.now` | Date added to inventory. |
- **Indexes**:
  - `{ productId: 1, provider: 1, isUsed: 1 }` (Fast pool lookup for available keys)
  - `{ usedByOrder: 1 }` (Partial: `{ usedByOrder: { $type: 'objectId' } }`)

---

### 2.6 `BybitInvoice` (`src/models/BybitInvoice.js`)
Bybit UID internal transfer fractional invoices.
- **Collection Name**: `bybitinvoices`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `invoiceNumber` | `String` | Yes | N/A | Unique human-readable code (`ORD-XXXXXXXX` or `TOP-XXXXXXXX`). |
  | `userId` | `ObjectId` | Yes | N/A | Ref: `User`. Creating buyer. |
  | `orderId` | `ObjectId` | No | `null` | Ref: `Order` (for direct checkout). |
  | `productId` | `ObjectId` | No | `null` | Ref: `Product`. |
  | `qty` | `Number` | No | `1` | Order quantity. |
  | `baseAmount` | `Number` | Yes | N/A | Nominal amount in USDT (e.g. `20.00`). |
  | `exactAmount` | `Number` | Yes | N/A | Unique exact amount with suffix (e.g. `20.0047`). |
  | `suffix` | `Number` | Yes | N/A | Integer suffix (`1..99`) representing 4th decimal place. |
  | `adminUid` | `String` | Yes | N/A | Target merchant Bybit UID. |
  | `status` | `String` | No | `'pending'` | Enum: `['pending', 'processing', 'completed', 'cancelled', 'expired']`. |
  | `lockedAt` | `Date` | No | `null` | CAS lock timestamp for poller concurrency. |
  | `txId` | `String` | No | `null` | Bybit internal transaction ID matched from API. |
  | `expiresAt` | `Date` | Yes | N/A | Expiration timestamp (15 minutes from creation). |
  | `createdAt` | `Date` | No | `Date.now` | Creation date. |
  | `completedAt` | `Date` | No | `null` | Completion date. |
- **Indexes**:
  - `{ exactAmount: 1 }` (Unique, Partial: `{ status: { $in: ['pending', 'processing'] } }`)
  - `{ txId: 1 }` (Unique, Partial: `{ txId: { $type: 'string' } }`)
  - `{ status: 1, lockedAt: 1 }` (Stuck CAS-lock recovery)
  - `{ status: 1, expiresAt: 1 }` (Auto-expiration cron)
  - `{ userId: 1, createdAt: -1 }` (User payment history)

---

### 2.7 `TopupRequest` (`src/models/TopupRequest.js`)
Balance top-up requests across Platega, direct Crypto, and manual Bank Cards.
- **Collection Name**: `topuprequests`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `userId` | `ObjectId` | Yes | N/A | Ref: `User`. Top-up initiator. |
  | `amount` | `Number` | No | `0` | USDT balance to credit. |
  | `amountRub` | `Number` | No | `null` | Equivalent RUB amount (for Platega and Bank Cards). |
  | `status` | `String` | No | `'pending'` | Enum: `['pending', 'confirmed', 'rejected']`. |
  | `method` | `String` | No | `'unknown'` | Enum: `['platega', 'card', 'bybit_uid', 'bybit_trc20', 'bybit_bep20', 'ton']`. |
  | `network` | `String` | No | `null` | Network identifier: `'TRC-20'`, `'BEP-20'`, `'TON'`, `'UID'`. |
  | `proofText` | `String` | No | `null` | User-submitted TXID or commentary. |
  | `proofFileId` | `String` | No | `null` | S3 URL or Telegram fileId for receipt screenshot. |
  | `txid` | `String` | No | `undefined` | Normalized blockchain hash or internal transfer reference. |
  | `fromAddress` | `String` | No | `null` | Sender wallet address. |
  | `paymentId` | `String` | No | `null` | Platega transaction ID. |
  | `payUrl` | `String` | No | `null` | External payment gateway redirect URL. |
  | `adminId` | `ObjectId` | No | `null` | Ref: `User`. Admin who reviewed manual top-up. |
  | `notes` | `String` | No | `null` | Administrative or reconciliation notes. |
  | `createdAt` | `Date` | No | `Date.now` | Creation timestamp. |
  | `processedAt` | `Date` | No | `null` | Confirmation/rejection timestamp. |
- **Indexes**:
  - `{ paymentId: 1 }` (Unique, Partial: `{ paymentId: { $type: 'string' } }`)
  - `{ txid: 1 }` (Unique, Partial: `{ txid: { $type: 'string' } }`)
  - `{ status: 1, createdAt: 1 }` (Pending admin queue)
  - `{ status: 1, processedAt: -1 }` (Audit history)

---

### 2.8 `Settings` (`src/models/Settings.js`)
Singleton system configuration and encrypted payment secrets.
- **Collection Name**: `settings`
- **Singleton Rule**: Singleton document with `{ name: 'global' }`.
- **Encrypted Fields** (AES-256-GCM via `secretBox.service.js`):
  `geminiApiKey`, `cardNumber`, `cardHolder`, `bybitApiKey`, `bybitApiSecret`, `plategaMerchantId`, `plategaSecret`.
- **Selected Fields**:
  | Field | Type | Default | Description |
  |---|---|---|---|
  | `name` | `String` | `'global'` | Unique document identifier. |
  | `maintenanceMode` | `Boolean` | `false` | System-wide maintenance lock. |
  | `topupWallet` | `String` | `''` | Default merchant TRC-20 wallet address. |
  | `topupNetwork` | `String` | `'TRC-20 (TRON)'` | Default network label. |
  | `minTopup` | `Number` | `1` | Minimum top-up threshold in USDT. |
  | `referralBonus` | `Number` | `0.5` | Bonus in USDT paid to referrer upon qualifying purchase. |
  | `smartPricing` | `Boolean` | `false` | Dynamic low-stock pricing multiplier toggle. |
  | `autoMarkdownEnabled` | `Boolean` | `false` | Stale inventory automated discount engine toggle. |
  | `bybitEnabled` | `Boolean` | `true` | Bybit UID payment channel toggle. |
  | `plategaEnabled` | `Boolean` | `true` | Platega SBP payment channel toggle. |
  | `cardEnabled` | `Boolean` | `true` | Direct Bank Card payment channel toggle. |
  | `currencyMode` | `String` | `'bybit_p2p'` | Enum: `['bybit_p2p', 'manual']`. Exchange rate calculation mode. |
  | `manualRate` | `Number` | `95` | Fixed exchange rate fallback in RUB/USDT. |
  | `currencyOffset` | `Number` | `0` | Additive markup/spread applied to exchange rate in RUB. |
  | `autoConfirmHours` | `Number` | `24` | Hours before auto-confirming pending delivered orders. |

---

### 2.9 `Transaction` (`src/models/Transaction.js`)
Double-entry immutable financial ledger tracking all balance movements.
- **Collection Name**: `transactions`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `userId` | `ObjectId` | Conditional | N/A | Ref: `User`. Target user (required unless seller transaction). |
  | `sellerId` | `ObjectId` | No | `null` | Ref: `Seller`. External seller reference. |
  | `type` | `String` | Yes | N/A | Enum: `['topup', 'purchase', 'refund', 'referral_bonus', 'manual_credit', 'manual_debit', 'seller_payout']`. |
  | `amount` | `Number` | Yes | N/A | Delta amount in USDT (positive = credit; negative = debit). |
  | `orderId` | `ObjectId` | No | `null` | Ref: `Order`. Associated purchase or refund order. |
  | `topupRequestId` | `ObjectId` | No | `null` | Ref: `TopupRequest`. Associated top-up invoice. |
  | `description` | `String` | No | `''` | Human-readable audit narrative. |
  | `createdAt` | `Date` | No | `Date.now` | Ledger timestamp. |
- **Indexes**:
  - `{ userId: 1, createdAt: -1 }`
  - `{ sellerId: 1, createdAt: -1 }`
  - `{ type: 1, createdAt: -1 }`
  - `{ topupRequestId: 1, createdAt: -1 }`

---

### 2.10 `SupplierConfig` (`src/models/SupplierConfig.js`)
External digital goods supplier integration parameters (Jaha Digital API).
- **Collection Name**: `supplierconfigs`
- **Schema Fields**:
  | Field | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `supplierId` | `String` | Yes | N/A | Enum: `['jaha']`. Unique supplier identifier. |
  | `title` | `String` | Yes | N/A | Display name ("Jaha Digital API"). |
  | `apiKey` | `String` | Yes | N/A | Supplier API Token (encrypted with `secretBox`). |
  | `baseUrl` | `String` | No | `null` | Supplier API endpoint (`https://api.jahadigital.shop/v1`). |
  | `isEnabled` | `Boolean` | No | `true` | Automated integration active flag. |
  | `marginPercent` | `Number` | No | `30` | Default retail markup percentage. |
  | `marginFixed` | `Number` | No | `0` | Fixed additive markup in USDT. |
  | `cachedBalance` | `Number` | No | `0` | Last synchronized supplier account balance in USDT. |
  | `lastSyncAt` | `Date` | No | `null` | Timestamp of last catalog import. |
  | `autoSyncEnabled` | `Boolean` | No | `true` | Automated cron synchronization toggle. |
  | `syncIntervalMinutes` | `Number` | No | `30` | Interval between catalog imports. |
  | `updatedAt` | `Date` | No | `Date.now` | Last update date. |

---

### 2.11 Additional Domain Models (11 through 19)

11. **`PromoCode` (`src/models/PromoCode.js`)**:
    - Fields: `code` (String, unique, uppercase), `type` (`balance | percent | fixed`), `value` (Number), `maxActivations` (Number), `currentActivations` (Number), `maxPerUser` (Number), `minOrderAmount` (Number), `expiresAt` (Date), `isActive` (Boolean).
    - Indexes: `{ code: 1 }` (unique).
12. **`PromoUsage` (`src/models/PromoUsage.js`)**:
    - Fields: `promoId` (ObjectId), `userId` (ObjectId), `orderId` (ObjectId), `usageNumber` (Number), `discountAmount` (Number), `usedAt` (Date).
    - Indexes: `{ promoId: 1, userId: 1, usageNumber: 1 }` (unique partial filter preventing over-redemption).
13. **`ExchangeRate` (`src/models/ExchangeRate.js`)**:
    - Fields: `base` (`'USD'`), `rub` (Number), `updatedAt` (Date).
    - Singleton model holding current Bybit P2P fiat conversion rate.
14. **`RequiredChannel` (`src/models/RequiredChannel.js`)**:
    - Fields: `title` (String), `chatId` (String), `inviteLink` (String), `isActive` (Boolean), `sortOrder` (Number), `subscribersCount` (Number).
    - Indexes: `{ isActive: 1, sortOrder: 1 }`.
15. **`Seller` (`src/models/Seller.js`)**:
    - Fields: `telegramId` (Number, sparse), `username` (String, unique), `displayName` (String), `walletAddress` (String), `walletNetwork` (String), `balance` (Number), `totalEarned` (Number), `isActive` (Boolean).
16. **`SellerWithdrawal` (`src/models/SellerWithdrawal.js`)**:
    - Fields: `sellerId` (ObjectId), `amount` (Number), `walletAddress` (String), `network` (String), `status` (`pending | completed | rejected`), `processedAt` (Date).
    - Indexes: `{ sellerId: 1 }` (unique partial: `{ status: 'pending' }` preventing concurrent pending withdrawals).
17. **`Waitlist` (`src/models/Waitlist.js`)**:
    - Fields: `userId` (ObjectId), `productId` (ObjectId), `createdAt` (Date).
    - Indexes: `{ userId: 1, productId: 1 }` (unique).
18. **`ChannelVerification` (`src/models/ChannelVerification.js`)**:
    - Fields: `channelId` (ObjectId), `userId` (ObjectId), `verifiedAt` (Date).
    - Indexes: `{ channelId: 1, userId: 1 }` (unique).
19. **`TelegrafSession` (`src/models/TelegrafSession.js`)**:
    - Collection: `telegraf_sessions`. Fields: `key` (String, unique), `session` (Mixed), `updatedAt` (Date).
    - Indexes: `{ updatedAt: 1 }` (TTL: 7 days / `604800` seconds).

---

### 2.12 Dedicated Web Auth Model: `AuthSession` (`src/models/AuthSession.js`)
To support the 6-digit Telegram authentication flow (benchmarked against `https://lachuga.shop/auth/signin`), a dedicated Mongoose schema is introduced:

```javascript
const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  sessionToken: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  telegramId: {
    type: Number,
    default: null,
    index: true
  },
  telegramUsername: {
    type: String,
    default: null
  },
  ip: {
    type: String,
    required: true
  },
  userAgent: {
    type: String,
    default: ''
  },
  verificationCodeHash: {
    type: String,
    default: null // SHA-256 hash of the 6-digit numeric code
  },
  status: {
    type: String,
    enum: ['pending', 'code_issued', 'authenticated', 'locked', 'expired'],
    default: 'pending',
    index: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 5
  },
  codeExpiresAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600 // Auto-deleted after 10 minutes via MongoDB TTL index
  }
});

module.exports = mongoose.model('AuthSession', authSessionSchema);
```

---

## 3. Concurrency & Synchronization Model

Under high concurrent checkout traffic (e.g. flash sales or simultaneous web/bot checkouts), race conditions could cause balance double-spending, duplicate key allocations, or overselling. The web platform enforces a strict multi-layered concurrency architecture.

### 3.1 Multi-Document ACID Transactions (`withTransaction`)

All purchasing and balance debit operations must execute inside MongoDB multi-document ACID transactions using the shared wrapper `src/services/transactionHelper.service.js`:

```javascript
const mongoose = require('mongoose');
const logger = require('./logger');

/**
 * Executes a callback within a MongoDB ACID transaction.
 * Automatically handles commit, abort, and graceful fallback for standalone MongoDB instances.
 */
async function withTransaction(fn) {
  let session = null;
  let hasReplicaSet = true;

  try {
    session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
  } catch (err) {
    // If running in standalone mode (no replica set), fall back to non-transactional execution
    hasReplicaSet = false;
    if (session) {
      session.endSession();
      session = null;
    }
  }

  if (!hasReplicaSet) {
    return await fn(null);
  }

  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = { withTransaction };
```

---

### 3.2 Atomic Digital Key Allocation Pattern

To guarantee that an individual digital key (`Key`) is never delivered to more than one customer, keys are claimed exclusively using **atomic `Key.findOneAndUpdate`** with an unassigned filter:

```javascript
// ATOMIC KEY CLAIM PATTERN
const key = await Key.findOneAndUpdate(
  {
    productId: targetProductId,
    isUsed: false // Crucial atomic condition
  },
  {
    $set: {
      isUsed: true,
      usedAt: new Date()
    }
  },
  {
    new: true,
    session: session || undefined
  }
);

if (!key) {
  // If zero documents match, inventory is completely exhausted
  throw new Error('OUT_OF_STOCK');
}
```
**Concurrency Mechanics**:
MongoDB acquires an exclusive document-level write lock on the matched `Key` document. If 50 concurrent requests target the same product, MongoDB serializes the document modifications. Exactly 1 request succeeds per available key document; remaining requests receive `null` and abort, rolling back the transaction.

---

### 3.3 Atomic User Balance Deduction & Cart CAS Locking

Balance deductions must never read the user object into memory, decrement the property, and call `.save()`. Instead, deductions use **Compare-And-Swap (CAS)** via `User.findOneAndUpdate`:

```javascript
// ATOMIC BALANCE DEDUCTION WITH OPTIMISTIC CART LOCKING
const user = await User.findOneAndUpdate(
  {
    _id: userId,
    balance: { $gte: totalCost },     // CAS Condition 1: Balance must cover total cost
    cartVersion: expectedCartVersion  // CAS Condition 2: Cart must not have been modified elsewhere
  },
  {
    $inc: {
      balance: -totalCost,            // Atomic balance decrement
      totalSpent: totalCost,          // Atomic total spent increment
      cartVersion: 1                  // Invalidate previous cart version token
    },
    $set: {
      cart: []                        // Clear shopping cart upon checkout
    }
  },
  {
    new: true,
    session: session || undefined
  }
);

if (!user) {
  // Determine exact failure mode for descriptive client response
  const freshUser = await User.findById(userId).session(session || null);
  if (!freshUser || freshUser.balance < totalCost) {
    throw new Error('INSUFFICIENT_BALANCE');
  }
  throw new Error('CART_CHANGED');
}
```

---

### 3.4 Complete End-to-End Atomic Purchase Implementation

The complete checkout execution linking balance deduction, key claim, order creation, and transaction ledger entry:

```javascript
const { withTransaction } = require('../services/transactionHelper.service');
const User = require('../models/User');
const Product = require('../models/Product');
const Key = require('../models/Key');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');

async function processOrderCheckout({ userId, productId, qty, cartVersion }) {
  return await withTransaction(async (session) => {
    const opts = session ? { session } : {};

    // 1. Fetch product & verify active state
    const product = await Product.findOne({ _id: productId, isActive: true }, null, opts);
    if (!product) throw new Error('PRODUCT_NOT_FOUND');

    const totalCost = product.price * qty;

    // 2. Perform Atomic Balance CAS Deduction
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        balance: { $gte: totalCost },
        ...(cartVersion !== undefined ? { cartVersion } : {})
      },
      {
        $inc: {
          balance: -totalCost,
          totalSpent: totalCost,
          cartVersion: 1
        }
      },
      { new: true, ...opts }
    );

    if (!updatedUser) {
      const u = await User.findById(userId, null, opts);
      if (!u || u.balance < totalCost) throw new Error('INSUFFICIENT_BALANCE');
      throw new Error('CONCURRENCY_CONFLICT');
    }

    // 3. Perform Atomic Inventory Key Claims
    const claimedKeys = [];
    if (product.type === 'key') {
      for (let i = 0; i < qty; i++) {
        const key = await Key.findOneAndUpdate(
          { productId: product._id, isUsed: false },
          { $set: { isUsed: true, usedAt: new Date() } },
          { new: true, ...opts }
        );
        if (!key) throw new Error('OUT_OF_STOCK');
        claimedKeys.push(key);
      }
    } else if (product.type === 'manual' && product.manualStock >= 0) {
      // Manual inventory decrement
      const res = await Product.updateOne(
        { _id: product._id, manualStock: { $gte: qty } },
        { $inc: { manualStock: -qty } },
        opts
      );
      if (res.modifiedCount === 0) throw new Error('OUT_OF_STOCK');
    }

    // 4. Create Order Documents
    const createdOrders = [];
    for (let i = 0; i < qty; i++) {
      const assignedKey = claimedKeys[i] || null;
      const order = new Order({
        userId,
        productId: product._id,
        price: product.price,
        qty: 1,
        costPrice: product.costPrice || 0,
        status: assignedKey ? 'completed' : (product.type === 'gpt_activation' ? 'awaiting_token' : 'pending'),
        keyId: assignedKey ? assignedKey._id : null,
        deliveryData: assignedKey ? assignedKey.value : null,
        confirmedAt: assignedKey ? new Date() : null,
        warrantyDays: product.warrantyDays || 5
      });
      await order.save(opts);

      if (assignedKey) {
        await Key.updateOne({ _id: assignedKey._id }, { $set: { usedByOrder: order._id } }, opts);
      }
      createdOrders.push(order);
    }

    // 5. Append Immutable Ledger Entry
    const tx = new Transaction({
      userId,
      type: 'purchase',
      amount: -totalCost,
      orderId: createdOrders[0]._id,
      description: `Покупка ${product.name} (x${qty})`
    });
    await tx.save(opts);

    return {
      success: true,
      orders: createdOrders,
      remainingBalance: updatedUser.balance
    };
  });
}
```

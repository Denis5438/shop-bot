# Independent Multi-Channel Payment Processing Architecture

## 1. Executive Summary & Telegram Independence

The Telegram Shop Bot Web Platform implements a multi-channel, autonomous payment processing architecture that operates completely outside Telegram's ecosystem and fee structures, strictly avoiding Telegram Stars.

```
                           ┌────────────────────────────────────────────────────────┐
                           │          Web Storefront / User Cabinet                 │
                           │  - Select Payment Channel & Enter Amount / Order       │
                           └───────────────────────────┬────────────────────────────┘
                                                       │ POST /api/v1/payments/create
                                                       ▼
                           ┌────────────────────────────────────────────────────────┐
                           │            Express Payment Router Service              │
                           └─────────────┬─────────────┬─────────────┬──────────────┘
                                         │             │             │
                    ┌────────────────────┘             │             └────────────────────┐
                    ▼                                  ▼                                  ▼
    ┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌───────────────────────────────┐
    │       Bybit UID Gateway       │  │      Platega SBP Gateway      │  │     Crypto RPC & Explorer     │
    │  - Fractional Suffix Math     │  │  - Ruble QR-code Generation   │  │  - TronScan API (TRC-20)      │
    │  - CAS Lock (pending->proc)   │  │  - Timing-Safe Webhook Auth   │  │  - Binance Dataseed (BEP-20)  │
    │  - Bybit API v5 Polling Cron  │  │  - Dual-Channel Fallback Check│  │  - TonAPI / TON Center (TON)  │
    └───────────────┬───────────────┘  └───────────────┬───────────────┘  └───────────────┬───────────────┘
                    │                                  │                                  │
                    └──────────────────────────────────┼──────────────────────────────────┘
                                                       │
                                                       ▼
                           ┌────────────────────────────────────────────────────────┐
                           │       Double-Spending & Atomicity Engine               │
                           │  - MongoDB ACID Transactions (withTransaction)         │
                           │  - Partial Unique Indexes (txid, paymentId, exactAmount)│
                           │  - Anti-Replay & Anti-Whale Corridor Checks            │
                           │  - Immutable Double-Entry Ledger (Transaction)         │
                           └────────────────────────────────────────────────────────┘
```

---

## 2. Bybit UID Internal Transfer Architecture

Bybit UID internal transfers provide zero-fee, instant merchant settlement directly between Bybit user accounts. Because Bybit does not provide merchant webhooks for internal user-to-user transfers, the system uses a mathematical **fractional suffix allocation algorithm** combined with **Bybit API v5 internal deposit polling**.

### 2.1 Fractional Suffix Allocation Mechanics

To uniquely map an incoming transfer to an active invoice without requiring a memo, the system appends a 4-decimal fractional suffix between `0.0001` and `0.0099` USDT to the nominal invoice amount.

#### Mathematical Model:
$$\text{exactAmount} = \text{baseAmount} + \frac{\text{suffix}}{10000}, \quad \text{where } \text{suffix} \in [1, 99]$$

- For a nominal amount of `15.00 USDT`, possible invoices range from `15.0001` to `15.0099 USDT`.
- This supports up to **99 concurrent active invoices per nominal base amount**.
- MongoDB enforces uniqueness using a partial compound index:
  ```javascript
  bybitInvoiceSchema.index(
    { exactAmount: 1 },
    {
      unique: true,
      partialFilterExpression: { status: { $in: ['pending', 'processing'] } }
    }
  );
  ```

#### Suffix Allocation & Creation Implementation with Collision Retry (`src/services/bybitUidPayment.service.js`):
```javascript
const BybitInvoice = require('../models/BybitInvoice');

async function allocateUniqueAmount(baseAmount) {
  const base = Number(Number(baseAmount).toFixed(2));
  const now = new Date();

  // Find all active suffixes currently in use for this base amount
  const activeInvoices = await BybitInvoice.find({
    status: { $in: ['pending', 'processing'] },
    expiresAt: { $gt: now },
    baseAmount: base
  }).select('suffix exactAmount').lean();

  const usedSuffixes = new Set(activeInvoices.map((inv) => inv.suffix));

  // Determine available suffix slots from 1 to 99
  const availableSuffixes = [];
  for (let s = 1; s <= 99; s++) {
    if (!usedSuffixes.has(s)) {
      availableSuffixes.push(s);
    }
  }

  if (availableSuffixes.length === 0) {
    throw new Error('BYBIT_SUFFIXES_EXHAUSTED');
  }

  // Pick random available suffix for entropy
  const randomIndex = Math.floor(Math.random() * availableSuffixes.length);
  const selectedSuffix = availableSuffixes[randomIndex];
  const fractionalPart = selectedSuffix / 10000;
  const exactAmount = Number((base + fractionalPart).toFixed(4));

  return {
    suffix: selectedSuffix,
    exactAmount,
    suffixFractional: fractionalPart
  };
}

/**
 * Creates BybitInvoice wrapped in an exponential backoff retry loop
 * to handle concurrent suffix allocation collisions (MongoDB E11000 duplicate key error).
 */
async function createBybitInvoiceWithRetry({ userId, baseAmount, maxRetries = 5 }) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const { suffix, exactAmount } = await allocateUniqueAmount(baseAmount);
      const invoice = new BybitInvoice({
        userId,
        baseAmount: Number(Number(baseAmount).toFixed(2)),
        suffix,
        exactAmount,
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      });
      await invoice.save();
      return invoice;
    } catch (err) {
      const isDuplicateKey = err.code === 11000 || (err.message && err.message.includes('E11000'));
      if (isDuplicateKey && attempt < maxRetries) {
        // Exponential backoff with random jitter: (2^attempt * 50ms) + jitter
        const backoffMs = Math.floor(Math.pow(2, attempt) * 50 + Math.random() * 50);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('BYBIT_SUFFIXES_EXHAUSTED');
}
```

### 2.2 Bybit API v5 Internal Record Query & Authentication

The poller worker queries Bybit API v5 using HMAC-SHA256 authenticated requests:
- **Endpoint**: `GET https://api.bybit.com/v5/asset/deposit/query-internal-record?coin=USDT&limit=50`
- **Fallback Host**: `https://api.bytick.com` (if `api.bybit.com` is unreachable)
- **Signature Headers**:
  ```
  X-BAPI-API-KEY: <bybitApiKey>
  X-BAPI-TIMESTAMP: <timestamp_ms>
  X-BAPI-SIGN: <hmac_sha256_hex>
  X-BAPI-SIGN-TYPE: 2
  X-BAPI-RECV-WINDOW: 5000
  ```

#### Signature Generation:
```javascript
const timestamp = Date.now().toString();
const recvWindow = '5000';
const queryString = 'coin=USDT&limit=50';
const preSign = timestamp + apiKey + recvWindow + queryString;
const signature = crypto
  .createHmac('sha256', apiSecret)
  .update(preSign)
  .digest('hex');
```

### 2.3 CAS Lock Verification & Cron Poller Worker

```
[ Bybit Poller Cron (Every 20s) ]
               │
               ▼
   1. Unlocks stuck invoices (status: 'processing', lockedAt <= now - 3min)
   2. Expires old invoices (status: 'pending', expiresAt <= now)
   3. Fetches active pending invoices from MongoDB
               │
               ▼
   4. Queries Bybit API v5 /v5/asset/deposit/query-internal-record
               │
               ▼
   5. In-Memory Exact Amount Matching with String-to-Float Parsing:
      parseFloat(record.amount) === invoice.exactAmount
      (or epsilon tolerance: Math.abs(parseFloat(record.amount) - invoice.exactAmount) < 0.00001)
               │
               ▼
   6. CAS Lock Acquisition:
      findOneAndUpdate({ _id: inv._id, status: 'pending' },
                       { $set: { status: 'processing', lockedAt: now } })
               │
               ▼
   7. Double-Spend Verification:
      Checks txId uniqueness across BybitInvoice and TopupRequest
               │
               ▼
   8. Executes MongoDB ACID Transaction:
      - Credits User.balance ($inc)
      - Appends Transaction ledger record
      - Sets BybitInvoice status: 'completed', txId: record.txID
```

#### Complete CAS Polling Routine (`src/cron/bybitUidPoller.cron.js`):
```javascript
const cron = require('node-cron');
const BybitInvoice = require('../models/BybitInvoice');
const bybitPaymentService = require('../services/bybitUidPayment.service');
const logger = require('../services/logger');

let isRunning = false;

cron.schedule('*/20 * * * * *', async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();

    // 1. Recover stuck processing locks (> 3 minutes)
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
    await BybitInvoice.updateMany(
      { status: 'processing', lockedAt: { $lte: threeMinAgo } },
      { $set: { status: 'pending', lockedAt: null } }
    );

    // 2. Mark expired invoices
    await BybitInvoice.updateMany(
      { status: 'pending', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } }
    );

    // 3. Process active pending invoices
    const pendingInvoices = await BybitInvoice.find({
      status: 'pending',
      expiresAt: { $gt: now }
    });

    if (pendingInvoices.length > 0) {
      await bybitPaymentService.pollAndReconcileInvoices(pendingInvoices);
    }
  } catch (err) {
    logger.error('Error in Bybit UID Poller cycle', err);
  } finally {
    isRunning = false;
  }
});
```

#### Reconcile & Amount Verification Service (`src/services/bybitUidPayment.service.js`):
```javascript
/**
 * Polls Bybit API v5 and reconciles active pending invoices.
 * Ensures robust string-to-number parsing and floating-point epsilon comparison.
 */
async function pollAndReconcileInvoices(pendingInvoices) {
  const records = await queryBybitInternalTransfers(); // queries /v5/asset/deposit/query-internal-record

  for (const record of records) {
    // Bybit API v5 returns amounts as strings (e.g. "15.0042")
    const transferAmount = parseFloat(record.amount);
    if (isNaN(transferAmount)) continue;

    // Match against active pending invoices using 4-decimal tolerance
    const matchedInvoice = pendingInvoices.find((inv) =>
      Math.abs(transferAmount - inv.exactAmount) < 0.00001
    );

    if (!matchedInvoice) continue;

    // CAS Lock: Acquire exclusive processing lock
    const locked = await BybitInvoice.findOneAndUpdate(
      { _id: matchedInvoice._id, status: 'pending' },
      { $set: { status: 'processing', lockedAt: new Date() } },
      { new: true }
    );
    if (!locked) continue; // Concurrently locked by another cycle

    // Verify txId uniqueness across BybitInvoice and TopupRequest
    const existing = await BybitInvoice.findOne({ txId: record.txID, status: 'completed' });
    if (existing) {
      await BybitInvoice.updateOne({ _id: matchedInvoice._id }, { $set: { status: 'pending', lockedAt: null } });
      continue;
    }

    // Execute atomic balance credit
    await withTransaction(async (session) => {
      await User.updateOne(
        { _id: matchedInvoice.userId },
        { $inc: { balance: matchedInvoice.baseAmount } },
        { session }
      );

      await new Transaction({
        userId: matchedInvoice.userId,
        type: 'topup',
        amount: matchedInvoice.baseAmount,
        description: `Пополнение через Bybit UID (TX: ${record.txID})`,
        metadata: { txId: record.txID, exactAmount: matchedInvoice.exactAmount }
      }).save({ session });

      await BybitInvoice.updateOne(
        { _id: matchedInvoice._id },
        { $set: { status: 'completed', txId: record.txID, completedAt: new Date() } },
        { session }
      );
    });
  }
}
```

---

## 3. Platega.io / SBP Russian Ruble Card Architecture

Platega.io provides direct Russian Ruble payment processing via SBP (Fast Payments System QR-codes) and MIR / Russian bank cards.

### 3.1 Payment Initiation API Contract

- **Endpoint**: `POST https://app.platega.io/transaction/process` (Fallback: `/v2/transaction/process`)
- **Headers**:
  ```
  X-MerchantId: <plategaMerchantId>
  X-Secret: <plategaSecret>
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "paymentMethod": 2,
    "paymentDetails": {
      "amount": 1450,
      "currency": "RUB"
    },
    "description": "Пополнение баланса #TOP-00041289",
    "return": "https://shop.domain.com/profile/payments/return",
    "failedUrl": "https://shop.domain.com/profile/payments/failed",
    "payload": "674123abc456def789012345",
    "metadata": {
      "userId": "104928172",
      "userName": "@customer"
    }
  }
  ```
- **Response**:
  ```json
  {
    "id": "trans_platega_987123654",
    "redirect": "https://app.platega.io/pay/trans_platega_987123654",
    "status": "PENDING",
    "expiresIn": "00:15:00"
  }
  ```

### 3.2 Timing-Safe Webhook Verification & Processing

- **Webhook Route**: `POST /api/v1/payments/webhook/platega`
- **Security Check**: Compares `X-MerchantId` and `X-Secret` using `crypto.timingSafeEqual`:

```javascript
function verifyPlategaWebhookHeaders(headers, merchantId, secret) {
  // Precondition Guard: Reject immediately if merchant credentials are missing, undefined, not strings, or empty
  if (
    !merchantId ||
    !secret ||
    typeof merchantId !== 'string' ||
    typeof secret !== 'string' ||
    merchantId.trim() === '' ||
    secret.trim() === ''
  ) {
    return false;
  }

  const incomingId = headers['x-merchantid'] || headers['x-merchant-id'];
  const incomingSecret = headers['x-secret'];

  if (!incomingId || !incomingSecret || typeof incomingId !== 'string' || typeof incomingSecret !== 'string') {
    return false;
  }

  const bufA = Buffer.from(incomingId.trim());
  const bufExpectedId = Buffer.from(merchantId.trim());
  const bufB = Buffer.from(incomingSecret.trim());
  const bufExpectedSecret = Buffer.from(secret.trim());

  if (bufA.length !== bufExpectedId.length || bufB.length !== bufExpectedSecret.length) {
    return false;
  }

  const idValid = crypto.timingSafeEqual(bufA, bufExpectedId);
  const secretValid = crypto.timingSafeEqual(bufB, bufExpectedSecret);

  return idValid && secretValid;
}
```

#### Webhook Settlement Controller (`src/api/controllers/webhooks.controller.js`):
```javascript
async function handlePlategaWebhook(req, res) {
  const settings = await Settings.findOne({ name: 'global' });

  // Guard: If settings uninitialized or credentials missing, immediately reject
  if (!settings || !settings.plategaMerchantId || !settings.plategaSecret) {
    return res.status(503).json({
      error: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      message: 'Шлюз Platega не сконфигурирован в настройках системы'
    });
  }

  const isValid = verifyPlategaWebhookHeaders(req.headers, settings.plategaMerchantId, settings.plategaSecret);

  if (!isValid) {
    return res.status(401).json({
      error: 'INVALID_SIGNATURE',
      message: 'Недействительные заголовки аутентификации вебхука'
    });
  }

  const { id: paymentId, status, payload: topupRequestId, amount } = req.body;

  if (status !== 'CONFIRMED' && status !== 'SUCCESS') {
    return res.status(200).json({ status: 'ignored_unconfirmed' });
  }

  // Execute Idempotent ACID Topup Confirmation
  await withTransaction(async (session) => {
    const topup = await TopupRequest.findOneAndUpdate(
      { _id: topupRequestId, status: 'pending' },
      { $set: { status: 'confirmed', paymentId, processedAt: new Date() } },
      { new: true, session }
    );

    if (!topup) {
      // Already confirmed by polling or previous webhook delivery
      return;
    }

    // Credit User Balance
    await User.updateOne(
      { _id: topup.userId },
      { $inc: { balance: topup.amount } },
      { session }
    );

    // Ledger Entry
    await new Transaction({
      userId: topup.userId,
      type: 'topup',
      amount: topup.amount,
      topupRequestId: topup._id,
      description: `Пополнение через СБП (Platega: ${paymentId})`
    }).save({ session });
  });

  return res.status(200).json({ status: 'ok' });
}
```

---

## 4. Direct Cryptocurrency Settlement (USDT TRC-20, USDT BEP-20, TON)

Direct crypto payments require no intermediary payment processor. Customers transfer tokens to the merchant wallet, and the platform verifies the transaction on-chain.

### 4.1 USDT TRC-20 Verification Engine
- **Explorer API**: TronScan API (`https://apilist.tronscanapi.com/api/transaction-info?hash=...`)
- **Official Contract**: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (Strict verification rejects fake tokens).
- **Confirmation Depth**: Minimum **19 confirmations** (`data.confirmed === true`).
- **Precision**: 6 decimals ($10^6$).
- **Anti-Whale Tolerance**: Deposits accepted between `99%` and `105%` of expected invoice amount; amounts `> 105%` escalated to manual review.
- **Max Age**: Transactions older than 6 hours rejected to prevent claiming historical blockchain transactions.

### 4.2 USDT BEP-20 (BNB Smart Chain) Verification Engine
- **Node Provider**: Binance Dataseed JSON-RPC (`https://bsc-dataseed.binance.org/`)
- **Official Contract**: `0x55d398326f99059ff775485246999027b3197955`
- **RPC Methods**: `eth_getTransactionReceipt`, `eth_blockNumber`
- **Event Log Topic**: ERC-20 `Transfer(address,address,uint256)` topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.
- **Confirmation Depth**: Minimum **12 blocks**.
- **Precision**: 18 decimals on-chain; safely calculated using native `BigInt`:
  ```javascript
  const rawBigInt = BigInt(log.data);
  const divisor = BigInt(10 ** 18);
  const integerPart = rawBigInt / divisor;
  const fractionPart = rawBigInt % divisor;
  const verifiedAmount = Number(integerPart) + Number(fractionPart) / 1e18;
  ```

### 4.3 TON Blockchain Integration Architecture

To fulfill Requirement R4 for direct TON payments:
1. **Memo-Based Verification**:
   - Each invoice generates a unique payment memo: `INV-TON-<8_digits>` (e.g. `INV-TON-00049281`).
   - Customer sends TON or Jetton USDT to the merchant TON wallet with this comment string.
2. **TonAPI v2 Verification**:
   - API Endpoint: `GET https://tonapi.io/v2/blockchain/accounts/{merchantAddress}/transactions?limit=25`
   - Fallback: TON Center HTTP API v2 (`https://toncenter.com/api/v2/getTransactions`)
   - Verifies:
     - `in_msg.destination === merchantAddress`
     - Decoded body comment equals invoice memo.
     - Native TON amount (nanoTON / $10^9$) or Jetton USDT transfer event (6 decimals).
     - Unique index on `TopupRequest.txid` stores the transaction logical time (`lt`) and hash.

---

## 5. Bank Card Direct Transfers & Admin Reconciliation Queue

For customers without crypto or SBP:
1. **Requisites Display**:
   - Customer views encrypted card details (`cardNumber`, `cardHolder`) configured in `Settings`.
2. **Receipt Proof Upload**:
   - Customer uploads receipt screenshot (PNG/JPEG) or PDF via `POST /api/v1/payments/:id/submit-proof`.
   - File is saved to secure storage and linked to `TopupRequest.proofFileId`.
3. **Admin Reconciliation Queue**:
   - Admins inspect receipts at `/admin/payments`.
   - Actions:
     - **Approve**: Atomically transitions `TopupRequest` to `confirmed`, increments `User.balance`, creates `Transaction` ledger entry, and notifies user via bot.
     - **Adjust & Approve**: Allows admin to adjust actual received ruble amount if the customer sent a different sum.
     - **Reject**: Transitions `TopupRequest` to `rejected` with an administrative explanation.

---

## 6. Atomicity, Idempotency & Double-Spending Prevention

### 6.1 Multi-Layer Double-Spending Defense Matrix

| Attack Vector | Defense Mechanism | Layer | Implementation |
|---|---|---|---|
| **Replay of Blockchain TXID** | Unique partial index on `TopupRequest.txid` | Database | `db.topuprequests.createIndex({ txid: 1 }, { unique: true, partialFilterExpression: { txid: { $type: "string" } } })` |
| **Replay of Bybit Transfer ID** | Unique partial index on `BybitInvoice.txId` and cross-collection check | Database & Application | Checked against both `BybitInvoice` and `TopupRequest` before lock commitment |
| **Duplicate Webhook Delivery** | Atomic CAS state transition | Application / DB | `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'confirmed' } })` |
| **Simultaneous Checkout / Topup** | MongoDB ACID Session Transaction | Transaction Engine | All balance updates and ledger entries wrapped in `withTransaction` |
| **Appropriation of Public Whale TXID** | Anti-Whale Corridor (99%-105%) & Max Age (< 6h) | Application | Blockchain verification rejects mismatched amounts or stale historical hashes |
| **Stuck Concurrency Locks** | Poller CAS Timeout Auto-Unlock (3 min) | Cron Worker | Invoices stuck in `'processing'` automatically revert to `'pending'` after 3 minutes |

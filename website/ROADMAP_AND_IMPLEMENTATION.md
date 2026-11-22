# Execution Roadmap, Testing Strategy & Operational Runbook

## 1. Phased Execution Roadmap

The implementation plan is structured into six sequential phases designed to minimize risk, ensure backwards compatibility with the Telegram bot, and deliver a production-ready web platform.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Foundation & Telegram Auth (Days 1–5)                         │
│ - Express.js REST API bootstrap co-located with shared backend         │
│ - Redis Sentinel integration for rate limiting & event bus             │
│ - AuthSession schema & Telegram 6-digit verification code lifecycle   │
│ - Telegram WebApp cryptographic initData HMAC-SHA256 auto-login        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Core Domain & Catalog REST API (Days 6–10)                    │
│ - Reused 19 Mongoose models connection & index synchronization        │
│ - Public Catalog & Categories REST API with live stock calculations    │
│ - orderPricing.service.js & currency.service.js web integration        │
│ - Shopping cart & instant order checkout controllers with CAS locks    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Multi-Channel Independent Payment Gateways (Days 11–16)       │
│ - Bybit UID fractional allocation math & background CAS poller worker  │
│ - Platega SBP API integration & timing-safe webhook verifier           │
│ - Blockchain verification engine: TronScan (TRC-20) & BSC (BEP-20)     │
│ - TonAPI v2 / TON Center memo-based payment verification layer         │
│ - Bank card receipt upload pipeline & admin review queue               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 4: Customer Storefront & User Cabinet (Days 17–22)               │
│ - Next.js 14 (App Router) project setup with Tailwind CSS & shadcn/ui  │
│ - Dark glassmorphic design system modeled on https://lachuga.shop/shop │
│ - Interactive product purchase modal with promo codes & stock badges   │
│ - Instant key delivery view with 1-click clipboard copy & .txt download│
│ - User Cabinet: Purchase history, finance ledger, referral dashboard   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 5: Web Admin Panel (100% Bot Parity) (Days 23–28)                │
│ - Admin layout with role-based access control (admin / superadmin)     │
│ - Product & Category CRUD with image/emoji picker and sort ordering   │
│ - Digital key pool bulk import with duplicate filtering & search       │
│ - Manual order fulfillment & cancellation with bot user notifications  │
│ - User balance adjustment with audit logging & ban/unban toggles       │
│ - Supplier Jaha settings, live balance check & one-click catalog sync  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 6: Hardening, Stress Testing & Production Launch (Days 29–33)    │
│ - Cloudflare Edge WAF rulesets, Bot Fight Mode & Authenticated Pulls   │
│ - Tiered application sliding-window rate limiters across all endpoints │
│ - High-concurrency stress testing (500 req/sec double-spend prevention)│
│ - Production Docker Compose & Nginx deployment orchestration           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Quality Assurance & Testing Strategy

The testing matrix ensures correctness, concurrency safety, and zero regression across both web and Telegram interfaces.

### 2.1 Testing Pyramid Overview

| Test Layer | Framework / Tools | Scope | Success Criteria |
|---|---|---|---|
| **Unit Testing** | Jest / Vitest | Cryptographic hash verifiers (`initData`, Platega signatures), Bybit suffix math, pricing engine discounts. | 100% branch coverage on cryptographic and financial services. |
| **Integration Testing**| Supertest + In-Memory MongoDB (`mongodb-memory-server`) | REST API route controllers, middleware error handling, Zod validation, JWT cookie issuance. | All endpoint status codes (200, 201, 400, 401, 403, 409, 422, 429) verified. |
| **Concurrency & Load** | Autocannon / k6 | 50 concurrent buyers attempting to purchase 1 remaining digital key; simultaneous balance checkouts. | 0 duplicate keys allocated; exactly 1 order succeeds; 49 receive `OUT_OF_STOCK`; 0 balance leakage. |
| **End-to-End (E2E)** | Playwright | Full browser sign-in flow via 6-digit code, product purchase, key reveal, admin product CRUD. | Complete user journey passes headless across desktop and mobile viewports. |

---

### 2.2 Concurrency Stress Test Suite Specification

This test reproduces high-concurrency race conditions to ensure that the atomic mechanisms (`withTransaction`, `Key.findOneAndUpdate`, `User.findOneAndUpdate` CAS) eliminate double-spending.

#### Test Script (`tests/concurrency/double_spend_test.js`):
```javascript
const autocannon = require('autocannon');
const mongoose = require('mongoose');
const Key = require('../../src/models/Key');
const Product = require('../../src/models/Product');
const User = require('../../src/models/User');

async function runConcurrencyStressTest() {
  console.log('⚡ Starting Concurrency Stress Test: 1 Key vs 50 Concurrent Buyers...');

  // 1. Seed database with test product and exactly ONE digital key
  const testProduct = await Product.create({
    name: 'Stress Test Item',
    price: 10.0,
    type: 'key',
    isActive: true
  });

  const testKey = await Key.create({
    productId: testProduct._id,
    value: 'KEY-SECRET-UNIQUE-12345',
    isUsed: false
  });

  // 2. Launch 50 concurrent purchase requests in parallel
  const result = await autocannon({
    url: 'http://localhost:3000/api/v1/orders/checkout',
    connections: 50,
    amount: 50,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'auth_token=<valid_test_jwt>'
    },
    body: JSON.stringify({
      productId: testProduct._id.toString(),
      qty: 1,
      paymentMethod: 'balance'
    })
  });

  console.log('📊 Stress Test Completed. Results:');
  console.log(`- Total Requests Sent: ${result.requests.total}`);
  console.log(`- HTTP 200 (Success): ${result['2xx']}`);
  console.log(`- HTTP 422 (Out of stock / Rejected): ${result['4xx']}`);

  // 3. Invariant Verification
  const usedKeys = await Key.countDocuments({ productId: testProduct._id, isUsed: true });
  console.log(`- Keys Marked Used in DB: ${usedKeys}`);

  if (result['2xx'] === 1 && usedKeys === 1) {
    console.log('✅ PASSED: Zero race conditions detected. Exactly 1 order completed.');
  } else {
    console.error('❌ FAILED: Invariant violated! Overselling or double allocation occurred.');
    process.exit(1);
  }
}
```

---

## 3. CI/CD Deployment Pipeline

A standard GitHub Actions or GitLab CI workflow automates testing, container image compilation, and production rolling deployment.

```
[ Push to main ]
       │
       ▼
┌────────────────────────────────────────────────────────┐
│ 1. Continuous Integration (CI Job)                     │
│    - Node.js Linting (ESLint) & Markdown Validation    │
│    - Unit & Integration Test Matrix (Jest)             │
│    - Next.js Production Build Verification             │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 2. Container Build & Push                              │
│    - Build Dockerfile.api -> registry/shopbot-api:sha  │
│    - Build Dockerfile.web -> registry/shopbot-web:sha  │
│    - Push multi-stage images to private Docker Registry│
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 3. Continuous Deployment (CD Production Rolling)       │
│    - SSH into production host                          │
│    - Pull latest container images                      │
│    - Staggered container restart:                      │
│      1. docker-compose up -d --no-deps api             │
│      2. Validate API health probe (curl /api/health)   │
│      3. docker-compose up -d --no-deps frontend        │
│      4. Reload Nginx reverse proxy configuration       │
└────────────────────────────────────────────────────────┘
```

---

## 4. Operational Runbook & Production Maintenance

### 4.1 System Health Probes
- **API Health**: `GET /api/v1/health`
  - Returns `200 OK`:
    ```json
    {
      "status": "ok",
      "uptimeSeconds": 184920,
      "mongo": { "status": "connected", "pingMs": 3 },
      "redis": { "status": "connected", "pingMs": 1 },
      "bot": { "status": "active" }
    }
    ```
  - Returns `503 Service Unavailable` if MongoDB or Redis connection drops.
- **Liveness Ping**: `GET /api/v1/ping` -> Plain text `pong`.

### 4.2 Database Backup & Disaster Recovery
- **MongoDB Atlas Automated Snapshots**: Continuous backup with point-in-time recovery enabled (35-day retention).
- **Daily Automated Logical Dumps**:
  A cron job executes nightly logical dumps to S3:
  ```bash
  mongodump --uri="${MONGODB_URI}" --archive="s3://backups/shopbot-$(date +%F).archive.gz" --gzip
  ```

### 4.3 Incident Response Runbook

| Alert / Symptom | Root Cause | Immediate Action |
|---|---|---|
| **Bybit Poller Stalled** | Bybit API rate limit or CloudFront IP block. | Inspect `logs/error.log`. Verify Bybit API credentials in `Settings`. Route requests through outbound proxy if IP blocked. Stuck CAS locks automatically recover after 3 minutes. |
| **Platega Webhooks Failing (401)** | Secret mismatch or invalid header signature. | Verify `Settings.plategaMerchantId` and `Settings.plategaSecret`. Check Nginx header forwarding (`X-MerchantId`, `X-Secret`). |
| **Bot Returns 409 Conflict** | Two Telegraf polling instances running simultaneously. | Ensure bot runs as a singleton container: `docker ps | grep bot`. Stop legacy duplicate processes. |
| **High Memory on Express API** | File upload memory leak or event listener buildup. | Inspect PM2/Docker memory metrics. Increase container memory limit or scale out API worker replicas behind Nginx upstream. |

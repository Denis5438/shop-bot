# Telegram Shop Bot Web Platform — Master Architecture & Technical Specification Suite

## Executive Summary & Architectural Vision

The **Telegram Shop Bot Web Platform** expands the proven, production-grade Telegram e-commerce ecosystem into a standalone, high-performance web platform. The platform operates alongside the Telegram bot, sharing the existing MongoDB database cluster, domain models, cryptographic secrets, and core business logic without creating fractured data silos or introducing race conditions.

```
                           ┌────────────────────────────────────────────────────────┐
                           │               Cloudflare Edge Network                  │
                           │  - DDoS Protection (L3/L4/L7) & Bot Fight Mode         │
                           │  - WAF Rulesets (OWASP Paranoia L2)                    │
                           │  - Authenticated Origin Pulls (AOP Client SSL)         │
                           └───────────────────────────┬────────────────────────────┘
                                                       │ HTTPS (Port 443)
                                                       ▼
                           ┌────────────────────────────────────────────────────────┐
                           │          Reverse Proxy & Ingress (Nginx)               │
                           │  - SSL Termination & Strict Origin Filtering           │
                           │  - Path Routing: / -> Next.js | /api/* -> Express API  │
                           └─────────────┬────────────────────────────┬─────────────┘
                                         │                            │
                     ┌───────────────────┴──────────┐   ┌─────────────┴──────────────────┐
                     │   Next.js 14 Frontend        │   │   Node.js / Express.js REST API│
                     │  - React Server Components   │   │  - Shared src/models/ & services│
                     │  - Glassmorphic Dark UI      │   │  - 6-Digit Telegram Auth Flow   │
                     │  - Tailwind CSS + shadcn/ui  │   │  - Tiered Sliding Rate Limiters │
                     │  - SSE Status Listeners      │   │  - Multi-Channel Payment Engine │
                     └──────────────────────────────┘   └─────────────┬──────────────────┘
                                                                      │
                                                ┌─────────────────────┴──────────────────┐
                                                │                                        │
                                                ▼                                        ▼
    ┌───────────────────────────────────────────────┐        ┌───────────────────────────────────┐
    │          MongoDB Atlas Replica Set            │        │           Redis Sentinel          │
    │  - 19 Reused Domain Schemas                   │        │  - Sliding Window Rate Limits     │
    │  - ACID Multi-Document Transactions           │        │  - Pub/Sub Cross-Process Events   │
    │  - CAS Optimistic Concurrency Locks           │        │  - Short-Lived Idempotency Keys   │
    └───────────────────────▲───────────────────────┘        └───────────────────────────────────┘
                            │
    ┌───────────────────────┴───────────────────────┐
    │       Telegram Shop Bot (Telegraf)            │
    │  - Polling / Webhook Updates                  │
    │  - /start auth_<session> & /code Handlers     │
    │  - Bybit UID Poller Cron Worker               │
    │  - Supplier Catalog Sync Cron Worker          │
    └───────────────────────────────────────────────┘
```

### Architectural Pillars

1. **Shared Single Source of Truth**:
   The web platform directly imports the existing 19 Mongoose schemas (`User`, `Product`, `Category`, `Order`, `Key`, `BybitInvoice`, `TopupRequest`, `Settings`, `Transaction`, `SupplierConfig`, `PromoCode`, `PromoUsage`, `ExchangeRate`, `RequiredChannel`, `Seller`, `SellerWithdrawal`, `Waitlist`, `ChannelVerification`, `TelegrafSession`). Balance changes, order checkouts, and inventory updates are immediately visible to both the web platform and the Telegram bot.

2. **Zero Telegram Stars Dependency**:
   The payment architecture operates completely outside Telegram's fee structures, app-store commissions, and Telegram Stars. It provides direct multi-channel settlement:
   - **Bybit UID Internal Transfers**: Zero-fee merchant settlement using exact fractional amounts (`baseAmount + suffix`) matched via Bybit API v5 and background polling.
   - **Platega SBP & Russian Ruble Cards**: Instant QR-code and bank card payments with timing-safe webhook verification.
   - **Direct Cryptocurrency Settlement**: USDT on TRC-20 (TronScan API with 19 confirmations), USDT on BEP-20 (Binance Dataseed JSON-RPC with 12 confirmations), and native TON / Jetton USDT (TonAPI/TON Center RPC with memo comments).
   - **Bank Card Direct Transfers**: Requisites display with client receipt upload and atomic administrative reconciliation.

3. **Two-Factor & Dual-Mode Telegram Web Authentication**:
   Benchmarked against `https://lachuga.shop/auth/signin`, the web platform introduces a frictionless 6-digit code authentication flow and dual-mode token delivery:
   - Web visitors initiate an auth session and open the Telegram bot via a 1-click deep link (`https://t.me/ShopBot?start=auth_<token>`) or QR code.
   - The bot generates a cryptographically secure 6-digit verification code with a 5-minute TTL.
   - The user enters the code on the website, which performs timing-safe hash comparison and issues an `httpOnly`, `secure`, `SameSite=Lax` signed JWT cookie for browser sessions.
   - For Telegram WebApp iframes (`https://web.telegram.org`), modern browser cross-origin cookie restrictions are solved via **Dual Authentication**: endpoints return the signed JWT bearer token in the JSON response body (`Authorization: Bearer <token>`) and support `SameSite=None; Secure; Partitioned` cookies (CHIPS).
   - When opened inside the Telegram client (Mini App), the platform performs automatic instant login using cryptographic HMAC-SHA256 validation of Telegram WebApp `initData`, hardened with strict 32-byte buffer length guards to eliminate unhandled `RangeError` exceptions.

4. **Modern Dark-Themed Glassmorphic Storefront**:
   Benchmarked against `https://lachuga.shop/shop`, the frontend features deep obsidian tones (`#0A0D14`), translucent glassmorphic cards (`backdrop-filter: blur(16px)`), responsive category filters, real-time stock pill indicators, interactive product modals, instant key delivery with 1-click clipboard copy, and a comprehensive user cabinet.

5. **100% Administrative Feature Parity (All 15 Bot Scenes)**:
   The web admin panel replicates every single administrative scene present in the Telegram bot:
   1. Products CRUD & Smart Pricing (`products.scene.js`)
   2. Categories CRUD & Taxonomy Ordering (`categories.scene.js`)
   3. Key Inventory Pool & Multi-Line Bulk Import (`keys.scene.js`)
   4. Orders Fulfillment & Manual Token Activation (`orders.scene.js`)
   5. User Management & Balance Adjustments with Audit Logging (`users.scene.js`)
   6. Bybit UID & Payment Gateway Transaction Inspector (`payments.scene.js`)
   7. Supplier Jaha Integration & Sync Controls (`suppliers.scene.js`)
   8. Promo Codes CRUD & Limits (`promos.scene.js`)
   9. Warranties & Disputes Resolution Queue (`disputes.scene.js`)
   10. Seller Management & Seller Withdrawals Queue (`seller_withdrawals.scene.js`)
   11. Mandatory Required Channels Subscription Management (`req_channels.scene.js`)
   12. Sales & Financial Timeseries Analytics with Charts (`stats.scene.js`)
   13. Telegram Mass Broadcasting & Catalog Bulk Pricing (`bulk.scene.js`)
   14. Global System Settings & Maintenance Mode Toggle (`settings.scene.js`)
   15. Live Chat Customer Support & Ticket Desk (`admin.scene.js`)

6. **Defense-in-Depth Cyber Security & Payment Webhook Ingress**:
   The architecture implements Cloudflare Edge WAF (OWASP Paranoia L2, Bot Fight Mode, Authenticated Origin Pulls) with explicit bypass rules for payment gateway webhooks (`/api/v1/payments/webhook/*`) to guarantee delivery from external datacenter IPs without triggering Turnstile challenges. Strict application-level HMAC verification, sliding-window rate limiters across 4 tiers, Helmet security headers, strict Content Security Policy allowing Telegram WebApp iframe embedding (`frame-ancestors`), NoSQL sanitization (`express-mongo-sanitize`), and MongoDB ACID session transactions prevent double-spending and inventory race conditions.

---

## Master Document Map & Specification Suite

The complete architectural plan and technical specification is structured across eight comprehensive documents in `website/`:

| Document | Primary File | Purpose & Scope |
|---|---|---|
| **1. Master Index** | `website/INDEX.md` | Executive summary, architectural vision, master document map, traceability matrix (R1-R6), and architectural conventions. |
| **2. System Architecture** | `website/ARCHITECTURE.md` | Master system blueprint, Express.js REST API + Next.js frontend, high-level topology, monorepo directory layout, and deployment runbook. |
| **3. Database & Models** | `website/DATABASE_AND_MODELS.md` | Schema reuse of all 19 Mongoose models, field definitions, validation, compound indexes, ACID transaction patterns, and Redis/Change Stream synchronization. |
| **4. Auth & Cyber Security** | `website/AUTH_AND_SECURITY.md` | 6-digit code lifecycle, WebApp auto-login with 32-byte timing-safe buffer guards, Cloudflare WAF payment webhook bypass rules, 4-tier sliding window rate limits, Dual Auth (Bearer header + partitioned cookies), and Helmet/CSP. |
| **5. Payment Systems** | `website/PAYMENT_SYSTEM.md` | Independent payment architecture (Bybit UID fractions with string-to-float parsing & exponential backoff on E11000, Platega SBP with uninitialized settings auth guard, Crypto TRC-20/BEP-20/TON, Bank Cards), webhooks, polling workers, and double-spending prevention. |
| **6. REST API Contracts** | `website/API_CONTRACTS.md` | OpenAPI/Swagger-grade specifications for Auth (including QR endpoint & Dual Auth tokens), Catalog, Checkout, Payments (including Platega webhook & full error schemas), User Cabinet, and all 15 Admin Modules. |
| **7. Storefront & Admin UX** | `website/STOREFRONT_AND_ADMIN_UX.md` | Dark glassmorphic customer storefront (lachuga.shop), category tabs, interactive modal, key delivery, user cabinet, and complete 15-scene feature parity admin panel wireframes and workflows. |
| **8. Roadmap & Implementation** | `website/ROADMAP_AND_IMPLEMENTATION.md` | 6-phase development roadmap, testing strategy (unit, integration, concurrency stress tests), CI/CD pipeline, and operational maintenance runbook. |

---

## Traceability Matrix: Requirements to Technical Specifications

This matrix maps every requirement (R1 through R6) and acceptance criterion from `ORIGINAL_REQUEST.md` to exact sections within this specification suite.

| Requirement ID | Requirement Description | Primary Document & Section | Supporting Sections | Verification / Test Reference |
|---|---|---|---|---|
| **R1** | **Deliverable Scope & Organization** | `website/INDEX.md` § Master Document Map | `website/ROADMAP_AND_IMPLEMENTATION.md` § 1-6 | File layout verification, markdown schema linting |
| **R2.1** | **Node.js / Express Backend Architecture** | `website/ARCHITECTURE.md` § 2. Backend API Architecture | `website/API_CONTRACTS.md` § All Endpoints | REST API endpoint unit & integration tests |
| **R2.2** | **React / Next.js Frontend Architecture** | `website/ARCHITECTURE.md` § 3. Frontend Architecture | `website/STOREFRONT_AND_ADMIN_UX.md` § 1 | Next.js build verification, SSR & client hydration |
| **R2.3** | **MongoDB Atlas Schema Reuse (19 Models)** | `website/DATABASE_AND_MODELS.md` § 1. Model Catalog | `website/DATABASE_AND_MODELS.md` § 2 | Mongoose schema validation & index synchronization |
| **R2.4** | **Bot & Web Concurrency / Synchronization** | `website/DATABASE_AND_MODELS.md` § 3. Concurrency Model | `website/ARCHITECTURE.md` § 4. Data Flow | Concurrency stress tests (`withTransaction`, CAS locks) |
| **R3.1** | **Telegram 6-Digit Code Authentication** | `website/AUTH_AND_SECURITY.md` § 1. 6-Digit Code Flow | `website/API_CONTRACTS.md` § 2.1-2.3 Auth Endpoints | Auth lifecycle integration tests, attempt locking tests |
| **R3.2** | **Telegram WebApp `initData` Auto-Login & Dual Auth** | `website/AUTH_AND_SECURITY.md` § 2, § 3.2 Dual Auth | `website/API_CONTRACTS.md` § 2.4 WebApp Route | Cryptographic HMAC-SHA256 validation unit tests, 32-byte buffer length guard |
| **R3.3** | **Authentication Sequence Diagrams** | `website/AUTH_AND_SECURITY.md` § 3. Sequence Diagrams | `website/AUTH_AND_SECURITY.md` § 1.2, § 2.2 | Mermaid syntax validation and flow tracing |
| **R4.1** | **Multi-Channel Payment (No Telegram Stars)**| `website/PAYMENT_SYSTEM.md` § 1. Architecture Overview | `website/API_CONTRACTS.md` § 5. Payments API | End-to-end payment creation and verification tests |
| **R4.2** | **Bybit UID Fractional Transfers & Suffix Retries** | `website/PAYMENT_SYSTEM.md` § 2. Bybit UID Architecture | `website/DATABASE_AND_MODELS.md` § 1.6 BybitInvoice | Bybit suffix collision retry tests (E11000), float parsing epsilon tests |
| **R4.3** | **Platega SBP & Russian Ruble Cards (Auth Guard)** | `website/PAYMENT_SYSTEM.md` § 3. Platega SBP Gateway | `website/API_CONTRACTS.md` § 5.4 Platega Webhook | Timing-safe webhook signature verification tests, unconfigured credentials guard |
| **R4.4** | **Direct Crypto (USDT TRC-20, BEP-20, TON)**| `website/PAYMENT_SYSTEM.md` § 4. Cryptocurrency Settlement| `website/PAYMENT_SYSTEM.md` § 4.3 TON Integration | On-chain RPC mock tests, confirmation depth tests |
| **R4.5** | **Bank Card Transfers & Manual Review Queue**| `website/PAYMENT_SYSTEM.md` § 5. Bank Card Direct Transfers | `website/STOREFRONT_AND_ADMIN_UX.md` § 2.7 | Receipt upload and atomic admin approval tests |
| **R4.6** | **Atomicity & Double-Spending Prevention** | `website/PAYMENT_SYSTEM.md` § 6. Atomicity Engine | `website/DATABASE_AND_MODELS.md` § 3.1 | Transaction ledger idempotency & rollback tests |
| **R5.1** | **Cloudflare WAF & Webhook Bypass Rule** | `website/AUTH_AND_SECURITY.md` § 4. Cloudflare Edge WAF | `website/ARCHITECTURE.md` § 5. Deployment Topology | Edge rule syntax inspection, AOP verification, webhook bypass rule test |
| **R5.2** | **Sliding Window Application Rate Limiting**| `website/AUTH_AND_SECURITY.md` § 5. Tiered Rate Limiting | `website/API_CONTRACTS.md` § Headers | 4-tier rate limit threshold load tests |
| **R5.3** | **Helmet Security Headers, CSP & CORS** | `website/AUTH_AND_SECURITY.md` § 6. Security Headers | `website/ARCHITECTURE.md` § 2.3 Express Middlewares | Security header scanner, iframe ancestor tests |
| **R5.4** | **NoSQL & Input Sanitization** | `website/AUTH_AND_SECURITY.md` § 7. NoSQL Sanitization | `website/API_CONTRACTS.md` § Zod Validation | NoSQL operator injection tests, XSS payload tests |
| **R5.5** | **Secure JWT Session Cookies & Dual Auth** | `website/AUTH_AND_SECURITY.md` § 3.2 Dual Auth | `website/AUTH_AND_SECURITY.md` § 1.4 | Cookie flag inspection (`httpOnly`, `secure`, `SameSite`, `Partitioned`) |
| **R5.6** | **Atomic Key Allocation & Balance Deduction**| `website/DATABASE_AND_MODELS.md` § 3.2 Key Allocation | `website/DATABASE_AND_MODELS.md` § 3.3 Balance CAS | High-concurrency race condition benchmark tests |
| **R6.1** | **Customer Storefront UX (lachuga.shop)** | `website/STOREFRONT_AND_ADMIN_UX.md` § 1. Storefront UX | `website/STOREFRONT_AND_ADMIN_UX.md` § 1.2 | UI component rendering, theme token inspection |
| **R6.2** | **Instant Key Delivery & Order Tracking** | `website/STOREFRONT_AND_ADMIN_UX.md` § 1.4 Key Delivery | `website/API_CONTRACTS.md` § 4. Checkout API | Key reveal, copy-to-clipboard, text download tests |
| **R6.3** | **User Cabinet & Referral Dashboard** | `website/STOREFRONT_AND_ADMIN_UX.md` § 1.5 User Cabinet | `website/API_CONTRACTS.md` § 6. Cabinet API | Profile stats, top-up modal, referral link tests |
| **R6.4** | **Web Admin Panel (100% 15-Scene Bot Parity)** | `website/STOREFRONT_AND_ADMIN_UX.md` § 2.1-2.16 Admin Panel | `website/API_CONTRACTS.md` § 7.1-7.15 Admin Endpoints | All 15 scenes parity: Products, Categories, Keys, Orders, Users, Payments, Jaha, Promos, Disputes, Sellers, Channels, Stats, Bulk, Settings, Support |
| **R6.5** | **Supplier Jaha Configuration & Sync** | `website/STOREFRONT_AND_ADMIN_UX.md` § 2.8 Suppliers | `website/API_CONTRACTS.md` § 7.14 Suppliers API | Jaha adapter mock sync and markup computation tests |

---

## Architectural Conventions & Standards

To ensure uniformity across all engineering artifacts, the following conventions are enforced throughout the specification suite:

### 1. Currency & Precision Rules
- **Base Ledger Currency**: All retail product prices, seller payouts, user balances, and ledger transactions are stored in **USDT** (Tether USD) as 64-bit IEEE floating-point numbers in MongoDB, with financial calculations rounded to 4 decimal places (`0.0001 USDT`).
- **Fiat Currency**: Russian Rubles (**RUB**) are utilized exclusively for Platega SBP payments and direct Bank Card transfers. Conversion from USDT to RUB uses dynamic rates determined by `currency.service.js` (Bybit P2P average with fallback to CBR + spread or manual rate from `Settings`).
- **Decimals by Asset**:
  - `USDT (TRC-20)`: 6 decimal places ($10^6$).
  - `USDT (BEP-20)`: 18 decimal places ($10^{18}$) on-chain; parsed via `BigInt` into 6-decimal precision.
  - `TON (Native)`: 9 decimal places ($10^9$ nanoTON).
  - `USDT (TON Jetton)`: 6 decimal places ($10^6$).
  - `Bybit UID Fractional Suffix`: Exact 4 decimal places (`0.0001` to `0.0099`), stored as integer `1..99`.

### 2. Identifier Formats
- **MongoDB ObjectIds**: 24-character hexadecimal strings (`^[0-9a-fA-F]{24}$`).
- **Telegram User ID**: 64-bit signed integer (`Number` in JavaScript).
- **Session Tokens**: 64-character cryptographically secure hex strings (`crypto.randomBytes(32).toString('hex')`).
- **Verification Codes**: 6-digit numeric strings (`/^\d{6}$/`, range `100000` to `999999`).
- **Invoice Identifiers**:
  - Direct Order Invoices: `ORD-` followed by an 8-digit zero-padded number (e.g. `ORD-00014820`).
  - Top-up Invoices: `TOP-` followed by an 8-digit zero-padded number (e.g. `TOP-00003912`).
  - TON Memo Invoices: `INV-TON-` followed by an 8-digit number (e.g. `INV-TON-00084729`).
- **Supplier Idempotency Keys**: `ord-<orderId>` formatted as a unique string.

### 3. Cryptographic Storage & Transport
- **Sensitive Secrets in MongoDB**: Encrypted using AES-256-GCM via `secretBox.service.js` with the master key `ORDER_TOKEN_ENCRYPTION_KEY`. Ciphertext format: `enc:v1:<iv_hex>:<auth_tag_hex>:<encrypted_data_hex>`.
- **Password & Code Hashes**: SHA-256 hashes generated via `crypto.createHash('sha256')`. Comparisons always executed via `crypto.timingSafeEqual` with byte buffers.
- **Web Session JWTs**: Signed using HMAC-SHA256 (`HS256`) with `JWT_SECRET`, transmitted strictly via `httpOnly`, `secure`, `SameSite=Lax` cookies.

### 4. HTTP Status Code Conventions
- `200 OK`: Request succeeded; response payload returned.
- `201 Created`: Resource successfully created (order created, invoice issued).
- `400 Bad Request`: Input validation failure (malformed JSON, invalid ObjectId, out-of-bounds quantity).
- `401 Unauthorized`: Authentication missing, expired session token, or invalid verification code.
- `403 Forbidden`: Account banned, insufficient administrative permissions, or expired Telegram WebApp timestamp.
- `404 Not Found`: Target resource does not exist.
- `409 Conflict`: Concurrency conflict (CAS lock failed, cart changed during checkout, unique index collision).
- `422 Unprocessable Entity`: Business logic invariant violation (insufficient user balance, item out of stock).
- `429 Too Many Requests`: Rate limit threshold exceeded or brute-force lock engaged.
- `500 Internal Server Error`: Unhandled server exception.
- `502 Bad Gateway`: External provider failure (Bybit API unreachable, Platega gateway down, Jaha supplier timeout).

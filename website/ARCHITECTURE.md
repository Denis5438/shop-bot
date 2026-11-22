# Telegram Shop Bot Web Platform — System Architecture & Infrastructure Blueprint

## 1. Architectural Blueprint & System Topology

The Telegram Shop Bot Web Platform extends the existing Telegram e-commerce bot into an enterprise-grade web application. It integrates a **Node.js / Express REST API** backend and a **Next.js 14 React** frontend, co-located within a unified repository layout and directly connecting to the existing **MongoDB Atlas Replica Set** and a shared **Redis Sentinel** instance.

### 1.1 High-Level Topology Diagram

```
                                  [ INTERNET TRAFFIC ]
                                            │
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │            Cloudflare Global Edge             │
                    │  - DDoS Protection (L3/L4/L7 Volumetric)      │
                    │  - WAF Managed Ruleset (OWASP Paranoia L2)    │
                    │  - Bot Fight Mode & Managed Challenges        │
                    │  - Edge Rate Limiting (10 req/min for auth)   │
                    │  - Authenticated Origin Pulls (AOP SSL)       │
                    └───────────────────────┬───────────────────────┘
                                            │ Cloudflare Encrypted Mesh
                                            │ (Port 443 with Client Cert)
                                            ▼
                    ┌───────────────────────────────────────────────┐
                    │           Host Ingress (Nginx)                │
                    │  - Client Cert Verification (Cloudflare CA)   │
                    │  - SSL Termination (TLS 1.3 Strict)           │
                    │  - Reverse Proxy & Upstream Load Balancing    │
                    │  - Gzip / Brotli Compression                  │
                    │  - WebSocket / SSE Connection Upgrades        │
                    └───────────────┬───────────────────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ Path: /                                       │ Path: /api/*, /webhook/*
            ▼                                               ▼
┌───────────────────────────────┐               ┌───────────────────────────────┐
│     Next.js 14 Frontend       │               │      Express.js REST API      │
│  - App Router (SSR & Client)  │  Internal API │  - Stateless Controller Layer │
│  - Port 3001 (Node Cluster)   │◄─────────────►│  - Port 3000 (PM2 / Docker)   │
│  - Dark Glassmorphic Storefront               │  - Tiered Rate Limiters       │
│  - Responsive Admin Dashboard │               │  - Zod Request Validation     │
└───────────────┬───────────────┘               └───────────────┬───────────────┘
                │                                               │
                └───────────────────────┬───────────────────────┘
                                        │
                                        ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                       Data & State Storage Layer                          │
    ├─────────────────────────────────────────┬─────────────────────────────────┤
    │       MongoDB Atlas Replica Set         │          Redis Cluster          │
    │  - 19 Reused Domain Models              │  - Sliding Window Rate Limits   │
    │  - Multi-Document ACID Transactions     │  - Redis Pub/Sub Event Bus      │
    │  - Partial Unique Compound Indexes      │  - Short-Lived Idempotency Keys │
    │  - CAS Optimistic Concurrency           │  - Cross-Process Cache Inval.   │
    └───────────────────▲─────────────────────┴─────────────────▲───────────────┘
                        │                                       │
                        └───────────────────┬───────────────────┘
                                            │
                                            ▼
                        ┌───────────────────────────────────────┐
                        │       Telegram Bot Engine (Telegraf)  │
                        │  - Bot Event Polling / Webhook Engine │
                        │  - /start auth_<token> Auth Dispatch  │
                        │  - Bybit UID Cron Poller Worker       │
                        │  - Supplier Catalog Sync Cron Worker  │
                        │  - Stale Order Reaper Cron Worker     │
                        └───────────────────┬───────────────────┘
                                            │
                                            ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                      External Gateway Integrations                        │
    ├───────────────────┬───────────────────┬───────────────────┬───────────────┤
    │  Platega.io SBP   │   Bybit API v5    │ Blockchain Nodes  │ Jaha Digital  │
    │  - Ruble QR / SBP │  - Query Deposit  │  - TronScan API   │  - Product    │
    │  - Signed Webhook │  - HMAC-SHA256    │  - BSC JSON-RPC   │    Catalog    │
    │  - Polling Check  │  - Internal Trans │  - TonAPI v2      │  - Auto-Order │
    └───────────────────┴───────────────────┴───────────────────┴───────────────┘
```

---

## 2. Technology Stack & Component Specifications

| Tier | Component | Technology / Library | Version | Architectural Responsibility |
|---|---|---|---|---|
| **Edge & Security** | CDN / WAF | Cloudflare Pro/Enterprise | N/A | Edge DDoS mitigation, WAF Managed Rulesets, Bot Fight Mode, Rate limiting, SSL Termination, Origin IP masking. |
| **Ingress** | Reverse Proxy | Nginx HTTP Server | `1.24+` | Enforces Authenticated Origin Pulls (AOP), TLS 1.3 termination, path routing (`/` to Next.js, `/api/` to Express), HTTP/2 multiplexing. |
| **Backend API** | Application Server | Node.js + Express.js | `18.x LTS` / `^4.19.2` | High-throughput REST API, Zod payload schema validation, tiered sliding-window rate limiting, JWT session cookie handling. |
| **Database ODM** | Object Data Modeling | Mongoose | `^8.3.4` | Direct connection to MongoDB Atlas, schema reuse, schema-level validations, partial unique indexes, multi-document ACID transactions. |
| **Distributed Cache** | Cache & Event Bus | Redis / `ioredis` | `7.2+` / `^5.4.1` | Sliding window rate limiter store, Pub/Sub cache invalidation between Express and Telegraf bot processes, idempotency locks. |
| **Frontend Framework** | Web App Framework | Next.js (App Router) | `^14.2.3` | React Server Components (RSC) for SSR catalog rendering, client hydration for interactive modals, SEO metadata, dark theme layout. |
| **Styling & UI** | Design System | Tailwind CSS + shadcn/ui | `^3.4.3` / `Radix UI` | Dark glassmorphic styling (`#0A0D14`, backdrop blur, translucent borders), responsive grid layouts, mobile drawer navigation. |
| **State & Fetching** | Client State | SWR / TanStack Query | `^2.2.5` | SWR caching for catalog and balance, optimistic UI updates, polling payment status listeners. |
| **Cryptography** | Core Crypto | Native Node.js `crypto` | Built-in | AES-256-GCM secret encryption (`secretBox.service.js`), HMAC-SHA256 Telegram `initData` verification, timing-safe buffer comparison. |
| **Process Manager** | Container / Process | Docker / Docker Compose & PM2 | `Docker 26+` / `PM2 5.3+` | Process clustering, automatic restart on uncaught exceptions, zero-downtime rolling deploys, log rotation. |

---

## 3. Component Boundaries & Codebase Organization

The architecture adopts a **Monorepo Co-location Strategy**. The existing Telegram bot repository root (`c:\Users\user\Desktop\Shop bot`) serves as the base workspace, housing shared domain models, core cryptographic services, and database connectors. The Express.js REST API is organized under `src/api/` or `server/`, while the Next.js storefront and admin panel are housed in `website/`.

### 3.1 Architectural Decoupling Principles

1. **Shared Domain Layer (`src/models/` and `src/services/`)**:
   - Both the Telegraf bot (`src/bot/`) and the Express REST API (`src/api/`) directly require common Mongoose models (`src/models/User.js`, `src/models/Product.js`, etc.).
   - Core utility services—`src/services/secretBox.service.js` (encryption), `src/services/transactionHelper.service.js` (ACID transactions), `src/services/orderPricing.service.js` (dynamic pricing), and `src/services/currency.service.js` (exchange rates)—are completely stateless and shared without modification.
2. **Decoupled Session Layer**:
   - **Telegram Bot**: Operates with Telegraf session middleware stored in `telegraf_sessions` collection (`src/models/TelegrafSession.js`).
   - **Web API**: Completely stateless session architecture using signed JWTs stored in `httpOnly`, `secure`, `SameSite=Lax` browser cookies.
3. **Decoupled Background Workers**:
   - Heavy background pollers (`bybitUidPoller.cron.js`, `supplierCatalogSync.cron.js`, `staleOrders.cron.js`) run **exclusively** within the bot service container or a dedicated worker process, preventing redundant external API calls and rate-limit exhaustion.

### 3.2 Unified Directory Structure

```
c:\Users\user\Desktop\Shop bot\
├── docs/                                  # Architectural specifications & audits
├── logs/                                  # Winston rotating system logs
├── nginx/                                 # Reverse proxy configuration
│   ├── nginx.conf                         # Main Nginx configuration
│   └── conf.d/
│       └── shopbot.conf                   # Upstream routing, SSL, and AOP rules
├── src/                                   # Shared Backend Core & Telegram Bot
│   ├── api/                               # Express.js REST API Layer (Web Platform)
│   │   ├── controllers/                   # Route controllers
│   │   │   ├── admin/                     # Admin controllers (products, users, orders)
│   │   │   ├── auth.controller.js         # 6-digit code & WebApp auto-login
│   │   │   ├── catalog.controller.js      # Products & categories
│   │   │   ├── checkout.controller.js     # Cart checkout & instant purchase
│   │   │   ├── payments.controller.js     # Invoices & proof submissions
│   │   │   ├── user.controller.js         # Profile, history & referrals
│   │   │   └── webhooks.controller.js     # Platega & payment callbacks
│   │   ├── middlewares/                   # Express middlewares
│   │   │   ├── auth.middleware.js         # JWT cookie validation & role checks
│   │   │   ├── error.middleware.js        # Centralized error handler
│   │   │   ├── rateLimiter.middleware.js  # Tiered sliding window rate limiters
│   │   │   ├── sanitize.middleware.js     # NoSQL & XSS sanitization
│   │   │   └── validate.middleware.js     # Zod payload schema validation
│   │   ├── routes/                        # Express router definitions
│   │   │   ├── v1/                        # API v1 route aggregator
│   │   │   │   ├── admin.routes.js
│   │   │   │   ├── auth.routes.js
│   │   │   │   ├── catalog.routes.js
│   │   │   │   ├── checkout.routes.js
│   │   │   │   ├── payments.routes.js
│   │   │   │   ├── user.routes.js
│   │   │   │   └── webhook.routes.js
│   │   │   └── index.js                   # Mounts /api/v1
│   │   ├── schemas/                       # Zod validation schemas
│   │   │   ├── auth.schema.js
│   │   │   ├── checkout.schema.js
│   │   │   └── payment.schema.js
│   │   └── server.js                      # Express application bootstrap & middleware
│   ├── bot/                               # Existing Telegraf Bot Engine
│   │   ├── keyboards/                     # Inline & reply keyboards
│   │   ├── middlewares/                   # User context & throttle middlewares
│   │   ├── routes/                        # Bot command routes (augmented with /code)
│   │   └── scenes/                        # Interactive wizard scenes
│   ├── cron/                              # Background scheduled jobs
│   │   ├── bybitUidPoller.cron.js         # Centralized Bybit UID poller
│   │   ├── supplierCatalogSync.cron.js    # Jaha catalog synchronization
│   │   └── staleOrders.cron.js            # Reaper for expired orders/invoices
│   ├── db/
│   │   ├── connect.js                     # Shared Mongoose connection pool
│   │   └── redis.js                       # Shared Redis client connection
│   ├── models/                            # 19 Shared Mongoose Schemas
│   │   ├── AuthSession.js                 # NEW: 6-digit web authentication model
│   │   ├── BybitInvoice.js
│   │   ├── Category.js
│   │   ├── ChannelVerification.js
│   │   ├── ExchangeRate.js
│   │   ├── Key.js
│   │   ├── Order.js
│   │   ├── Product.js
│   │   ├── PromoCode.js
│   │   ├── PromoUsage.js
│   │   ├── RequiredChannel.js
│   │   ├── Seller.js
│   │   ├── SellerWithdrawal.js
│   │   ├── Settings.js
│   │   ├── SupplierConfig.js
│   │   ├── TelegrafSession.js
│   │   ├── TopupRequest.js
│   │   ├── Transaction.js
│   │   ├── User.js
│   │   └── Waitlist.js
│   └── services/                          # Shared Business Logic & Services
│       ├── blockchain.service.js          # TRC-20, BEP-20 & TON RPC verification
│       ├── bybitUidPayment.service.js     # Bybit fractional amount & CAS locks
│       ├── currency.service.js            # Dynamic exchange rate engine
│       ├── eventBus.service.js            # NEW: Redis Pub/Sub for cross-process sync
│       ├── notification.service.js        # Telegram user notifications
│       ├── orderPricing.service.js        # Dynamic pricing & markdown rules
│       ├── platega.service.js             # Platega SBP API & signature verifier
│       ├── promo.service.js               # Promo codes validation & discount
│       ├── secretBox.service.js           # AES-256-GCM secret encryption
│       ├── suppliers/                     # Jaha and external supplier adapters
│       └── transactionHelper.service.js   # MongoDB ACID session wrapper
├── website/                               # Specifications & Next.js Frontend
│   ├── client/                            # Next.js 14 Source Code
│   │   ├── app/                           # App Router directory
│   │   │   ├── (auth)/                    # Sign-in routes (/auth/signin)
│   │   │   ├── (shop)/                    # Public storefront routes (/shop, /)
│   │   │   ├── admin/                     # Admin dashboard (/admin/*)
│   │   │   ├── profile/                   # User cabinet (/profile)
│   │   │   ├── layout.tsx                 # Root layout with dark theme provider
│   │   │   └── page.tsx                   # Storefront landing
│   │   ├── components/                    # UI Components
│   │   │   ├── admin/                     # Admin tables, forms & drawers
│   │   │   ├── auth/                      # 6-digit code modal & QR viewer
│   │   │   ├── payment/                   # Dynamic payment modal (crypto, SBP, Bybit)
│   │   │   ├── shop/                      # Product card, catalog grid, filter tabs
│   │   │   └── ui/                        # shadcn/ui primitives (dialog, button, badge)
│   │   ├── hooks/                         # React custom hooks (useAuth, useCart, useRates)
│   │   ├── lib/                           # Frontend utilities (apiClient, formatters)
│   │   ├── styles/                        # Tailwind CSS global stylesheet
│   │   ├── next.config.js                 # Next.js build configuration & proxy rewrites
│   │   ├── package.json                   # Frontend dependencies
│   │   └── tailwind.config.js             # Theme tokens & glassmorphic classes
│   ├── INDEX.md                           # Master specification index & traceability
│   ├── ARCHITECTURE.md                    # System architecture blueprint (this document)
│   ├── DATABASE_AND_MODELS.md             # Schema reuse & concurrency specifications
│   ├── AUTH_AND_SECURITY.md               # 6-digit code auth & cyber security specs
│   ├── PAYMENT_SYSTEM.md                  # Independent payment engine specs
│   ├── API_CONTRACTS.md                   # OpenAPI-grade REST API endpoint contracts
│   ├── STOREFRONT_AND_ADMIN_UX.md         # Storefront & Admin UX specifications
│   └── ROADMAP_AND_IMPLEMENTATION.md      # Phased roadmap, testing & runbook
├── docker-compose.yml                     # Local orchestration configuration
├── docker-compose.prod.yml                # Production multi-service orchestration
├── Dockerfile.api                         # Express backend container image
├── Dockerfile.bot                         # Telegram bot container image
├── Dockerfile.web                         # Next.js frontend container image
├── index.js                               # Telegram bot entry point
├── package.json                           # Root backend dependencies
└── .env.example                           # Consolidated environment configuration
```

---

## 4. Concurrency & Inter-Process Synchronization Model

Because both the **Express REST API** and the **Telegram Bot** operate concurrently against the same MongoDB database, state synchronization and cache consistency must be guaranteed without race conditions.

### 4.1 In-Memory Cache Invalidation via Redis Pub/Sub

The existing Telegram bot codebase caches user profiles for 30 seconds (`userMiddleware.js: USER_CACHE_TTL_MS = 30000`) and settings for 60 seconds (`settingsCache.service.js: CACHE_TTL = 60000`). If a user's balance is updated or payment toggles are changed from the web platform, the bot could operate on stale in-memory state.

To solve this, the architecture introduces **`eventBus.service.js`** using Redis Pub/Sub:

```
[Web Express API] ──(Publishes 'user:invalidated')──► [ Redis Channel 'shop:events' ]
                                                                   │
                                                                   ▼
[Telegram Bot Node 1] ◄────(Subscribes to 'shop:events')───────────┤
[Telegram Bot Node 2] ◄────────────────────────────────────────────┘
         │
         ▼
[ Clears Local In-Memory Cache for Telegram ID ]
```

#### Event Bus Implementation (`src/services/eventBus.service.js`):
```javascript
const Redis = require('ioredis');
const logger = require('./logger');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;

const pubClient = new Redis({ host: redisHost, port: redisPort, password: redisPassword });
const subClient = new Redis({ host: redisHost, port: redisPort, password: redisPassword });

const CHANNEL_EVENTS = 'shop:events';

subClient.subscribe(CHANNEL_EVENTS, (err) => {
  if (err) logger.error('Failed to subscribe to Redis events channel', err);
  else logger.info('Subscribed to Redis event bus channel: ' + CHANNEL_EVENTS);
});

const listeners = new Map();

subClient.on('message', (channel, message) => {
  if (channel !== CHANNEL_EVENTS) return;
  try {
    const { event, payload } = JSON.parse(message);
    const handlers = listeners.get(event) || [];
    for (const handler of handlers) {
      handler(payload);
    }
  } catch (err) {
    logger.error('Error handling Redis event message', err);
  }
});

module.exports = {
  publishEvent: (event, payload) => {
    pubClient.publish(CHANNEL_EVENTS, JSON.stringify({ event, payload, timestamp: Date.now() }));
  },
  subscribeEvent: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
  }
};
```

When the Web API updates a user's balance or role, it calls:
```javascript
eventBus.publishEvent('user:invalidated', { telegramId: user.telegramId });
```
The Telegram bot receives this event and invalidates its internal cache immediately:
```javascript
eventBus.subscribeEvent('user:invalidated', ({ telegramId }) => {
  userCache.delete(telegramId);
});
```

---

## 5. Deployment Topology & Operational Orchestration

The platform is deployed via Docker Compose or Kubernetes, isolated behind Nginx and Cloudflare.

### 5.1 Docker Container Topology

The architecture divides responsibilities across three dedicated Node.js service containers:

1. **`shopbot-web` (Next.js 14 Frontend)**:
   - Built via multi-stage standalone Next.js Dockerfile.
   - Listens on `127.0.0.1:3001`.
   - Optimized for SSR and static asset delivery.
2. **`shopbot-api` (Express.js REST API)**:
   - Runs Express backend serving `/api/*` and payment webhooks.
   - Listens on `127.0.0.1:3000`.
   - Scalable to multiple cluster worker processes behind Nginx.
3. **`shopbot-bot` (Telegram Bot Engine & Cron Workers)**:
   - Runs `index.js` launching Telegraf bot.
   - Executes singleton background polling workers (`bybitUidPoller.cron.js`, `supplierCatalogSync.cron.js`).

### 5.2 Production Docker Compose Specification (`docker-compose.prod.yml`)

```yaml
version: '3.8'

services:
  redis:
    image: redis:7.2-alpine
    container_name: shopbot_redis
    restart: always
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    networks:
      - internal_net
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    container_name: shopbot_api
    restart: always
    env_file: .env
    environment:
      - NODE_ENV=production
      - PORT=3000
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD}
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - internal_net
    ports:
      - "127.0.0.1:3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3

  frontend:
    build:
      context: ./website/client
      dockerfile: Dockerfile.web
    container_name: shopbot_web
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=3001
      - NEXT_PUBLIC_API_URL=https://shop.domain.com/api/v1
    networks:
      - internal_net
    ports:
      - "127.0.0.1:3001:3001"
    depends_on:
      - api

  bot:
    build:
      context: .
      dockerfile: Dockerfile.bot
    container_name: shopbot_bot
    restart: always
    env_file: .env
    environment:
      - NODE_ENV=production
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD}
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - internal_net

volumes:
  redis_data:
    driver: local

networks:
  internal_net:
    driver: bridge
```

### 5.3 Nginx Reverse Proxy Configuration (`nginx/conf.d/shopbot.conf`)

Enforces strict origin pull validation, TLS 1.3, rate limits, and path routing:

```nginx
# Upstream Definitions
upstream nextjs_frontend {
    server 127.0.0.1:3001;
    keepalive 32;
}

upstream express_backend {
    server 127.0.0.1:3000;
    keepalive 32;
}

# HTTP to HTTPS Redirect
server {
    listen 80;
    listen [::]:80;
    server_name shop.domain.com;
    return 301 https://$host$request_uri;
}

# Primary HTTPS Server Block
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name shop.domain.com;

    # SSL Certificates (Origin Certificate)
    ssl_certificate /etc/ssl/certs/origin.crt;
    ssl_certificate_key /etc/ssl/private/origin.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Cloudflare Authenticated Origin Pulls (AOP)
    # Ensures only Cloudflare edge proxies can connect
    ssl_client_certificate /etc/ssl/certs/cloudflare_origin_pull.crt;
    ssl_verify_client on;

    # Security & Protection Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Logging
    access_log /var/log/nginx/shop_access.log;
    error_log /var/log/nginx/shop_error.log warn;

    # Static Assets Caching (Next.js public assets)
    location /_next/static/ {
        proxy_pass http://nextjs_frontend;
        proxy_cache_valid 200 365d;
        proxy_buffering on;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # REST API & Webhook Routes
    location /api/ {
        proxy_pass http://express_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_cf_connecting_ip; # Cloudflare True Client IP
        proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts for Long Polling and SSE
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # Payment Webhooks Direct Route
    location /webhook/ {
        proxy_pass http://express_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
    }

    # Storefront & Admin Web App (Next.js SSR)
    location / {
        proxy_pass http://nextjs_frontend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 5.4 Zero-Downtime Rolling Update Strategy

When deploying updates to production:
1. **Telegram Bot Conflict Prevention**:
   Telegraf enforces a single active polling connection per bot token. A concurrent bot process results in `409 Conflict: terminated by other getUpdates request`.
   - The deployment script utilizes a staggered restart:
     ```bash
     docker-compose -f docker-compose.prod.yml stop bot
     docker-compose -f docker-compose.prod.yml up -d --no-deps bot
     ```
2. **API & Frontend Rolling Restart**:
   The `api` and `frontend` containers are updated sequentially with health check validation (`curl -f http://localhost:3000/api/health`), ensuring Nginx never routes traffic to an unready container.

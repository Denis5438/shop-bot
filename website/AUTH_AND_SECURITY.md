# Authentication Lifecycle, Cyber Security & DDoS Hardening Specification

## 1. Telegram Authentication Architecture

The web platform implements a dual-mode Telegram authentication system modeled on `https://lachuga.shop/auth/signin` and official Telegram Bot API standards:
1. **Telegram 6-Digit One-Time Code Verification Flow**: For standard desktop/mobile browsers.
2. **Telegram WebApp Cryptographic Auto-Login Flow**: For seamless instant authentication when the web application is launched directly inside Telegram (Mini Apps).

---

## 2. Telegram 6-Digit Verification Code Lifecycle

```
[ Browser User ]           [ Next.js / Express API ]           [ Telegram Bot ]            [ Telegram Cloud ]
       │                               │                              │                            │
       │ 1. Clicks "Войти"             │                              │                            │
       │    POST /api/v1/auth/session  │                              │                            │
       ├──────────────────────────────►│                              │                            │
       │                               │ 2. Creates AuthSession       │                            │
       │                               │    sessionToken = hex(32)    │                            │
       │                               │    expires in 10 minutes     │                            │
       │ 3. Returns sessionToken,      │                              │                            │
       │    deepLink & QR code URL     │                              │                            │
       │◄──────────────────────────────┤                              │                            │
       │                               │                              │                            │
       │ 4. Opens deep link / scans QR │                              │                            │
       │    https://t.me/Bot?start=... │                              │                            │
       ├─────────────────────────────────────────────────────────────►│                            │
       │                               │                              │ 5. /start auth_<token>     │
       │                               │                              │    Validates session token │
       │                               │                              │    Generates 6-digit code  │
       │                               │                              │    Hashes code (SHA-256)   │
       │                               │                              │    Sets TTL = now + 5 min  │
       │                               │                              │                            │
       │                               │                              │ 6. Bot replies in chat:    │
       │                               │                              │    "🔑 Ваш код: 849201"    │
       │◄─────────────────────────────────────────────────────────────┤    (Monospace formatting)  │
       │                               │                              │                            │
       │ 7. Enters 6-digit code on web │                              │                            │
       │    POST /api/v1/auth/verify   │                              │                            │
       ├──────────────────────────────►│                              │                            │
       │                               │ 8. Rate check & CAS lock     │                            │
       │                               │    attempts incremented      │                            │
       │                               │    timingSafeEqual(hash)     │                            │
       │                               │    Upserts User profile      │                            │
       │                               │    Issues signed JWT cookie  │                            │
       │ 9. Set-Cookie: auth_token     │                              │                            │
       │    (httpOnly, secure, Lax)    │                              │                            │
       │◄──────────────────────────────┤                              │                            │
       │                               │                              │                            │
       │ 10. Authenticated redirect    │                              │                            │
       │     to /shop or /cabinet      │                              │                            │
```

### 2.1 Step-by-Step Lifecycle Description

#### Step 1: Session Initiation (`POST /api/v1/auth/session`)
- When a customer clicks "Войти через Telegram", the web frontend calls `POST /api/v1/auth/session`.
- The Express backend generates a 32-byte cryptographically secure session token:
  ```javascript
  const sessionToken = crypto.randomBytes(32).toString('hex');
  ```
- An `AuthSession` document is inserted into MongoDB with:
  - `sessionToken`: The 64-character hex string.
  - `status`: `'pending'`.
  - `ip`: Client IP address (`req.ip` resolved via Cloudflare `CF-Connecting-IP`).
  - `userAgent`: Client User-Agent header.
  - `createdAt`: `new Date()`. The document has a MongoDB TTL index expiring after 600 seconds (10 minutes).
- Backend returns JSON payload:
  ```json
  {
    "success": true,
    "sessionToken": "d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "deepLink": "https://t.me/MyTelegramShopBot?start=auth_d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "qrCodeUrl": "/api/v1/auth/qr?token=d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "expiresInSeconds": 600
  }
  ```

#### Step 2: Code Issuance in Telegram Bot (`/start auth_<token>` or `/code`)
- When the user opens the deep link in Telegram, the bot's `bot.start()` handler matches the payload prefix `auth_`:
  ```javascript
  bot.start(async (ctx) => {
    const startPayload = ctx.startPayload;
    if (!startPayload || !startPayload.startsWith('auth_')) {
      return handleStandardStart(ctx);
    }

    const sessionToken = startPayload.replace('auth_', '').trim();
    const session = await AuthSession.findOne({
      sessionToken,
      status: { $in: ['pending', 'code_issued'] }
    });

    if (!session) {
      return ctx.replyWithHTML(
        '❌ <b>Сессия авторизации не найдена или истекла.</b>\n\n' +
        'Пожалуйста, вернитесь на сайт и нажмите кнопку «Войти» заново.'
      );
    }

    // Generate cryptographically secure 6-digit numeric string
    const rawCode = crypto.randomInt(100000, 1000000).toString();
    const hashCode = crypto.createHash('sha256').update(rawCode).digest('hex');

    // Update session state
    session.telegramId = ctx.from.id;
    session.telegramUsername = ctx.from.username || null;
    session.verificationCodeHash = hashCode;
    session.status = 'code_issued';
    session.attempts = 0;
    session.codeExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // Strict 5-minute TTL
    await session.save();

    // Reply with formatted monospace code for 1-tap copy
    await ctx.replyWithHTML(
      `🔐 <b>Код авторизации на сайте</b>\n\n` +
      `Ваш одноразовый код для входа:\n` +
      `👉 <code>${rawCode}</code> 👈 <i>(нажмите для копирования)</i>\n\n` +
      `⏱ Код действует <b>5 минут</b>.\n` +
      `⚠️ <i>Никогда не передавайте этот код третьим лицам. Сотрудники поддержки никогда не запрашивают код!</i>`
    );
  });
  ```

#### Step 3: Timing-Safe Verification & JWT Issuance (`POST /api/v1/auth/verify-code`)
- The customer enters the 6-digit code in the browser form.
- The backend performs atomic rate-check, attempt incrementation, timing-safe hash comparison, user provisioning, and cookie issuance:
  ```javascript
  async function handleVerifyCode(req, res) {
    const { sessionToken, code } = req.body;

    if (!sessionToken || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_INPUT',
        message: 'Требуется токен сессии и 6-значный цифровой код'
      });
    }

    // 1. Atomic attempt increment and session retrieval
    const session = await AuthSession.findOneAndUpdate(
      {
        sessionToken,
        status: 'code_issued',
        codeExpiresAt: { $gt: new Date() }
      },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'Сессия истекла или код не запрашивался. Попробуйте снова.'
      });
    }

    // 2. Brute-force protection: Lock after max attempts
    if (session.attempts > session.maxAttempts) {
      session.status = 'locked';
      await session.save();
      return res.status(429).json({
        success: false,
        error: 'SESSION_LOCKED',
        message: 'Превышено максимальное число попыток ввода. Начните авторизацию заново.'
      });
    }

    // 3. Cryptographic Timing-Safe Hash Verification
    const inputHash = crypto.createHash('sha256').update(code).digest('hex');
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(session.verificationCodeHash, 'hex'),
      Buffer.from(inputHash, 'hex')
    );

    if (!isMatch) {
      const remaining = session.maxAttempts - session.attempts;
      return res.status(401).json({
        success: false,
        error: 'INVALID_CODE',
        message: `Неверный код подтверждения. Осталось попыток: ${Math.max(0, remaining)}`,
        remainingAttempts: Math.max(0, remaining)
      });
    }

    // 4. Mark session authenticated
    session.status = 'authenticated';
    await session.save();

    // 5. User lookup or provisioning in MongoDB
    let user = await User.findOne({ telegramId: session.telegramId });
    if (!user) {
      user = new User({
        telegramId: session.telegramId,
        username: session.telegramUsername,
        role: 'user',
        balance: 0,
        acceptedToS: true,
        acceptedToSAt: new Date()
      });
      await user.save();
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        error: 'USER_BANNED',
        message: 'Ваш аккаунт заблокирован администратором.'
      });
    }

    // 6. Generate signed JWT token (7-day validity)
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        telegramId: user.telegramId,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d', algorithm: 'HS256' }
    );

    // 7. Dual Authentication Support:
    // (a) Set httpOnly, secure, SameSite=Lax signed cookie for standalone web browsers
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    // (b) Also set partitioned cookie for environments supporting CHIPS
    if (req.headers['sec-fetch-dest'] === 'iframe' || req.query.embedded === '1') {
      res.cookie('auth_token_partitioned', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        partitioned: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });
    }

    // (c) Return token in JSON body for Telegram WebApp iframe Bearer header auth
    return res.status(200).json({
      success: true,
      token, // Client transmits via Authorization: Bearer <token> in iframe requests
      user: {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        role: user.role,
        balance: user.balance
      }
    });
  }
  ```

---

## 3. Telegram WebApp Direct Cryptographic Auto-Login Flow

When the store is launched inside the Telegram client as a Telegram Mini App:
- Telegram provides `window.Telegram.WebApp.initData`—an encoded query string containing user identity and a cryptographic signature.
- The web client immediately posts this string to `POST /api/v1/auth/telegram-webapp`.
- The backend cryptographically validates the signature using the bot's secret token.

### 3.1 Verification Algorithm & Mathematical Specification

```
[ Telegram WebApp Container ]                     [ Express Backend API ]
             │                                               │
             │ 1. Reads window.Telegram.WebApp.initData      │
             │    POST /api/v1/auth/telegram-webapp          │
             ├──────────────────────────────────────────────►│
             │                                               │ 2. Extracts `hash` parameter
             │                                               │    Sorts remaining params alphabetically
             │                                               │    Generates `dataCheckString`
             │                                               │                                  
             │                                               │ 3. secretKey = HMAC-SHA256(      
             │                                               │       key: "WebAppData",         
             │                                               │       msg: BOT_TOKEN             
             │                                               │    )                             
             │                                               │                                  
             │                                               │ 4. expectedHash = HMAC-SHA256(   
             │                                               │       key: secretKey,            
             │                                               │       msg: dataCheckString       
             │                                               │    )                             
             │                                               │                                  
             │                                               │ 5. timingSafeEqual(expected, hash)
             │                                               │    Checks auth_date < 24 hours   
             │                                               │                                  
             │                                               │ 6. Upserts User & sets JWT Cookie
             │ 7. Authenticated JSON response + Cookie       │
             │◄──────────────────────────────────────────────┤
```

### 3.2 Production WebApp Verifier Implementation

```javascript
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function verifyTelegramWebAppData(initDataString, botToken) {
  if (!initDataString || typeof initDataString !== 'string') {
    return { valid: false, reason: 'EMPTY_PAYLOAD' };
  }

  const urlParams = new URLSearchParams(initDataString);
  const hash = urlParams.get('hash');
  if (!hash) {
    return { valid: false, reason: 'MISSING_HASH' };
  }

  urlParams.delete('hash');

  // Sort keys alphabetically and format as key=value\n
  const sortedKeys = Array.from(urlParams.keys()).sort();
  const dataCheckString = sortedKeys
    .map((key) => `${key}=${urlParams.get(key)}`)
    .join('\n');

  // Step 1: secretKey = HMAC-SHA256("WebAppData", botToken)
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  // Step 2: calculatedHash = HMAC-SHA256(secretKey, dataCheckString)
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Step 3: Timing-safe equality check with Buffer byte length guard
  const calculatedBuf = Buffer.from(calculatedHash, 'hex');
  const incomingBuf = Buffer.from(hash, 'hex');

  // Guard against non-hex characters causing Buffer byte length mismatch or 0-length buffer
  // SHA-256 output is strictly 32 bytes (64 hex characters). Non-hex strings produce truncated buffers in Node.js
  if (calculatedBuf.length !== 32 || incomingBuf.length !== 32) {
    return { valid: false, reason: 'INVALID_HASH_LENGTH' };
  }

  const isHashValid = crypto.timingSafeEqual(calculatedBuf, incomingBuf);

  if (!isHashValid) {
    return { valid: false, reason: 'INVALID_HASH' };
  }

  // Step 4: Replay protection via auth_date (Max 24 hours / 86400 seconds)
  const authDate = parseInt(urlParams.get('auth_date'), 10);
  const now = Math.floor(Date.now() / 1000);

  if (isNaN(authDate) || now - authDate > 86400 || authDate > now + 60) {
    return { valid: false, reason: 'AUTH_DATE_EXPIRED' };
  }

  let userData = {};
  try {
    userData = JSON.parse(urlParams.get('user') || '{}');
  } catch (err) {
    return { valid: false, reason: 'MALFORMED_USER_JSON' };
  }

  return { valid: true, user: userData };
}
```

### 3.2 Dual Authentication Architecture & JWT Middleware (`src/api/middlewares/auth.middleware.js`)

To solve cross-origin iframe cookie blocking in modern browsers (Chrome CHIPS, Safari ITP, Firefox Total Cookie Protection) when the web store is embedded inside Telegram Web (`https://web.telegram.org`), the platform implements a **Dual Authentication Architecture**:

1. **Standalone Web Browsers**: Authentication token is persisted in an HttpOnly, Secure, `SameSite=Lax` cookie.
2. **Telegram WebApp Iframe Clients**: The login endpoints (`/api/v1/auth/verify-code` and `/api/v1/auth/telegram-webapp`) return the signed JWT token in the JSON response payload. The frontend client stores the token in memory / WebApp session storage and transmits it via standard `Authorization: Bearer <token>` headers on all API requests. Additionally, when cookies are issued to iframe contexts (`sec-fetch-dest: iframe`), the server sets `SameSite=None; Secure; Partitioned` (CHIPS).
3. **Unified Express Auth Middleware**: Checks the `Authorization: Bearer <token>` header first, falling back to cookies.

```javascript
const jwt = require('jsonwebtoken');
const User = require('../../models/User');

/**
 * Express middleware implementing Dual Auth (Bearer Header > HttpOnly Cookie)
 */
async function authenticate(req, res, next) {
  let token = null;

  // 1. Check Authorization Bearer header (Primary for Telegram WebApp iframe embedding)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies) {
    // 2. Fallback to HttpOnly cookies (for standalone browser sessions)
    token = req.cookies.auth_token || req.cookies.auth_token_partitioned;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Требуется авторизация для доступа к ресурсу'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.userId).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'Пользователь не найден'
      });
    }

    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        error: 'USER_BANNED',
        message: 'Ваш аккаунт заблокирован администратором'
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'TOKEN_EXPIRED',
        message: 'Срок действия сессии истёк. Пожалуйста, выполните вход заново'
      });
    }
    return res.status(401).json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Недействительный токен авторизации'
    });
  }
}

/**
 * Role-based access control guard middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN_ROLE',
        message: 'Недостаточно прав для выполнения действия'
      });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
```

---

## 4. Cyber Security & Cloudflare DDoS Mitigation

The platform utilizes a defense-in-depth model combining **Cloudflare Edge WAF** at Layer 7 with **Host-Level Firewalling (AOP)** and **Application Rate Limiting**.

### 4.1 Cloudflare Edge WAF Configuration

```
[ Edge Visitors ]
       │
       ▼
┌────────────────────────────────────────────────────────┐
│               Cloudflare Layer 7 Rules                 │
├────────────────────────────────────────────────────────┤
│ 1. OWASP Core Ruleset (Paranoia Level 2)               │
│    - Blocks SQL/NoSQL injection, RCE, directory travers│
│ 2. Bot Fight Mode & Managed Challenges                 │
│    - Enforces Turnstile / JS challenge on suspect bots │
│ 3. Edge Rate Limiting Rules                            │
│    - Auth endpoint (/api/v1/auth/verify-code):         │
│      Max 10 requests / 1 min per IP -> Action: Block   │
│    - Checkout endpoint (/api/v1/orders/checkout):      │
│      Max 15 requests / 1 min per IP -> Action: Block   │
│    - Global API (/api/v1/*):                           │
│      Max 200 requests / 10 sec per IP -> Challenge     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼ (Authenticated Origin Pulls)
┌────────────────────────────────────────────────────────┐
│           Origin Server Ingress (Nginx)                │
│ - Accepts connections ONLY from Cloudflare IPs         │
│ - Validates Cloudflare Client SSL Certificate          │
└────────────────────────────────────────────────────────┘
```

#### Exact Cloudflare WAF Expression Rules:
1. **Auth Brute Force Shield**:
   - Filter: `(http.request.uri.path eq "/api/v1/auth/verify-code" and http.request.method eq "POST")`
   - Rate: `10 requests per 1 minute`
   - Action: `Block (HTTP 429)`
2. **Payment Creation Flooding**:
   - Filter: `(http.request.uri.path eq "/api/v1/payments/create" and http.request.method eq "POST")`
   - Rate: `12 requests per 1 minute`
   - Action: `Managed Challenge`
3. **Telegram Webhook Bypass Rule**:
   - Filter: `(http.request.uri.path contains "/webhook/" and ip.src in $telegram_ip_subnets)`
   - Action: `Skip all WAF and Rate Limiting Rules`
4. **Payment Gateway Webhook Bypass Rule**:
   - Filter: `(http.request.uri.path matches "^/api/v1/payments/webhook/.*" and http.request.method eq "POST")`
   - Action: `Skip all WAF and Rate Limiting Rules / Bypass Bot Fight Mode & Managed Challenges`
   - Security Rationale: Third-party payment gateways (Platega datacenter servers `app.platega.io`, blockchain notification workers) send automated server-to-server HTTP POST requests lacking browser fingerprints and cannot solve interactive Turnstile challenges. Applying Managed Challenges or Bot Fight Mode drops legitimate transaction confirmations. Authenticity, replay prevention, and data integrity are strictly enforced at the application layer via timing-safe cryptographic HMAC signature and header verification (`verifyPlategaWebhookHeaders`).

### 4.2 Authenticated Origin Pulls (AOP) & Direct IP Cloaking

To prevent attackers from bypassing Cloudflare by targeting the origin server's raw IP:
- Host firewall (`iptables` / `ufw`) drops all TCP connections on ports 80/443 not originating from Cloudflare IP ranges (`https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`).
- Nginx validates Cloudflare Origin CA client certificate:
  ```nginx
  ssl_client_certificate /etc/ssl/certs/cloudflare_origin_pull.crt;
  ssl_verify_client on;
  ```

---

## 5. Application-Level Rate Limiting (Sliding Window Algorithm)

Rate limiting is enforced at the Express layer using `express-rate-limit` with Redis clustering via `rate-limit-redis`:

```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redisClient = require('../db/redis');

// Helper to construct sliding window rate limiters
function createRateLimiter({ windowMs, max, prefix, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: `rl:${prefix}:`
    }),
    keyGenerator: (req) => {
      // Prefer authenticated User ID if available, otherwise Cloudflare True Client IP
      return req.user?.userId || req.headers['cf-connecting-ip'] || req.ip;
    },
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: message || 'Превышен лимит запросов. Пожалуйста, подождите.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
  });
}

// 4-TIER SLIDING WINDOW LIMITERS:
const authLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  prefix: 'auth',
  message: 'Слишком много попыток входа. Попробуйте через 1 минуту.'
});

const checkoutLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  prefix: 'checkout',
  message: 'Превышен лимит создания заказов. Подождите минуту.'
});

const browsingLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  prefix: 'catalog',
  message: 'Каталог перегружен. Подождите пару секунд.'
});

const adminLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 40,
  prefix: 'admin',
  message: 'Превышен лимит запросов к панели управления.'
});

module.exports = {
  authLimiter,
  checkoutLimiter,
  browsingLimiter,
  adminLimiter
};
```

---

## 6. HTTP Security Headers, Strict CSP & CORS

The Express application employs `helmet` with custom Content Security Policy rules specifically configured to allow embedding within Telegram WebApp containers while blocking malicious cross-origin frames.

```javascript
const helmet = require('helmet');
const cors = require('cors');

// CORS Configuration
const allowedOrigins = [
  process.env.WEBSITE_URL,
  'https://web.telegram.org',
  'https://t.me'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Helmet Configuration
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        "https://api.platega.io",
        "https://api.bybit.com",
        "https://tonapi.io",
        "https://apilist.tronscanapi.com"
      ],
      // Allow embedding ONLY in self and Telegram WebApp clients
      frameAncestors: [
        "'self'",
        "https://web.telegram.org",
        "https://*.telegram.org"
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false, // Must be false for Telegram WebApp iframe
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xContentTypeOptions: true,
  xDnsPrefetchControl: { allow: false }
});

module.exports = { corsOptions, helmetMiddleware };
```

---

## 7. NoSQL Injection Prevention & Input Sanitization

To protect MongoDB from operator injection attacks (e.g. `{"$gt": ""}`):
1. **`express-mongo-sanitize` Middleware**:
   Strips or replaces all keys starting with `$` or containing `.`:
   ```javascript
   const mongoSanitize = require('express-mongo-sanitize');
   app.use(mongoSanitize({ replaceWith: '_' }));
   ```
2. **Zod Strict Schema Validation**:
   Every endpoint validates incoming request data using strict Zod schemas with regex constraints:
   ```javascript
   const { z } = require('zod');

   const verifyCodeSchema = z.object({
     sessionToken: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/, 'Invalid session token'),
     code: z.string().length(6).regex(/^\d{6}$/, 'Code must be exactly 6 digits')
   });
   ```
3. **HTML / XSS Sanitization**:
   Admin inputs (e.g. product descriptions, category names) are sanitized via `sanitize-html` allowing only safe markdown tags.

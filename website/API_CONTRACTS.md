# REST API Endpoint Specifications & OpenAPI Contracts

## 1. Global API Conventions & Standards

All REST API endpoints for the Telegram Shop Bot Web Platform are mounted under the prefix `/api/v1`.

### 1.1 Standard Request Headers
| Header | Description | Required |
|---|---|---|
| `Content-Type` | Must be `application/json` (except multipart file uploads). | Yes (on POST/PUT/PATCH) |
| `Cookie` | Carries `auth_token=<jwt>` session cookie. | Yes (on authenticated routes) |
| `X-Requested-With` | `XMLHttpRequest` (CSRF defense). | Optional |

### 1.2 Standard Response Structure
Every response follows a uniform JSON wrapper:
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional human-readable feedback"
}
```

### 1.3 Standard Error Response Structure
```json
{
  "success": false,
  "error": "ERROR_CODE_STRING",
  "message": "Human-readable localized Russian error message",
  "details": [ ... ]
}
```

---

## 2. Authentication API (`/api/v1/auth`)

### 2.1 Initiate Authentication Session
- **Method & URL**: `POST /api/v1/auth/session`
- **Auth**: None (Public)
- **Rate Limit**: Tier 2 (5 requests / min per IP)
- **Request Body**: Empty `{}`
- **Response `201 Created`**:
  ```json
  {
    "success": true,
    "sessionToken": "d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "deepLink": "https://t.me/ShopBot?start=auth_d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "qrCodeUrl": "/api/v1/auth/qr?token=d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "expiresInSeconds": 600
  }
  ```
- **Error Codes**: `500 INTERNAL_ERROR`

---

### 2.2 Retrieve Authentication QR Code & Deep Link
- **Method & URL**: `GET /api/v1/auth/qr`
- **Auth**: None (Public)
- **Rate Limit**: Tier 2 (10 requests / min per IP)
- **Query Parameters**:
  - `token` (string, required): 64-character session token returned by `POST /api/v1/auth/session`.
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "data": {
      "sessionToken": "d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
      "qrCodeDataUri": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICA...",
      "deepLink": "https://t.me/ShopBot?start=auth_d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
      "expiresAt": "2026-11-23T00:25:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `400 BAD_REQUEST`: `{ "error": "MISSING_TOKEN", "message": "Параметр sessionToken обязателен" }`
  - `404 NOT_FOUND`: `{ "error": "SESSION_NOT_FOUND", "message": "Сессия авторизации не найдена или истекла" }`

---

### 2.3 Verify 6-Digit Code
- **Method & URL**: `POST /api/v1/auth/verify-code`
- **Auth**: None (Public)
- **Rate Limit**: Tier 2 (5 attempts / min per IP)
- **Request Body**:
  ```json
  {
    "sessionToken": "d4e28a9b6c1f0345e782910ab3cd567e890123456789abcdef0123456789abcd",
    "code": "849201"
  }
  ```
- **Response `200 OK`**:
  - **Headers**:
    - `Set-Cookie: auth_token=<jwt>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/`
    - `Set-Cookie: auth_token_partitioned=<jwt>; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=604800; Path=/` (when iframe detected)
  ```json
  {
    "success": true,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "65b9e28f7c1d4a0012345678",
      "telegramId": 104928172,
      "username": "customer_alex",
      "role": "user",
      "balance": 15.50
    }
  }
  ```
- **Error Responses**:
  - `400 BAD_REQUEST`: `{ "error": "INVALID_INPUT", "message": "Требуется 6-значный цифровой код" }`
  - `401 UNAUTHORIZED`: `{ "error": "INVALID_CODE", "message": "Неверный код", "remainingAttempts": 3 }`
  - `403 FORBIDDEN`: `{ "error": "USER_BANNED", "message": "Аккаунт заблокирован" }`
  - `429 TOO_MANY_REQUESTS`: `{ "error": "SESSION_LOCKED", "message": "Превышено максимальное число попыток (5). Сессия заблокирована", "details": { "code": "MAX_ATTEMPTS_EXCEEDED" } }`

---

### 2.4 Telegram WebApp `initData` Direct Auto-Login
- **Method & URL**: `POST /api/v1/auth/telegram-webapp`
- **Auth**: None (Public)
- **Request Body**:
  ```json
  {
    "initData": "query_id=AAHd...&user=%7B%22id%22%3A104928172%2C...%7D&auth_date=1716382900&hash=5a9b..."
  }
  ```
- **Response `200 OK`**:
  - **Headers**:
    - `Set-Cookie: auth_token=<jwt>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/`
    - `Set-Cookie: auth_token_partitioned=<jwt>; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=604800; Path=/`
  ```json
  {
    "success": true,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "65b9e28f7c1d4a0012345678",
      "telegramId": 104928172,
      "username": "customer_alex",
      "role": "user",
      "balance": 15.50
    }
  }
  ```
- **Error Responses**:
  - `401 UNAUTHORIZED`: `{ "error": "INVALID_HASH", "message": "Подпись данных Telegram недействительна" }`
  - `401 UNAUTHORIZED`: `{ "error": "INVALID_HASH_LENGTH", "message": "Некорректная длина или формат хэша" }`
  - `403 FORBIDDEN`: `{ "error": "AUTH_DATE_EXPIRED", "message": "Срок действия данных WebApp истёк (> 24ч)" }`

---

### 2.5 Get Current Authenticated User Session
- **Method & URL**: `GET /api/v1/auth/me`
- **Auth**: Required (`auth_token` cookie)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "user": {
      "id": "65b9e28f7c1d4a0012345678",
      "telegramId": 104928172,
      "username": "customer_alex",
      "role": "user",
      "balance": 15.50,
      "totalSpent": 120.00,
      "cartCount": 2
    }
  }
  ```
- **Error Codes**: `401 UNAUTHORIZED`

---

### 2.5 Logout
- **Method & URL**: `POST /api/v1/auth/logout`
- **Auth**: Required
- **Response `200 OK`**:
  - **Headers**: `Set-Cookie: auth_token=; HttpOnly; Secure; Max-Age=0; Path=/`
  ```json
  { "success": true, "message": "Успешный выход" }
  ```

---

## 3. Catalog & Products API (`/api/v1/catalog`)

### 3.1 Get Categories
- **Method & URL**: `GET /api/v1/catalog/categories`
- **Auth**: None (Public)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "categories": [
      {
        "_id": "65b9e28f7c1d4a0012345001",
        "name": "AI Подписки",
        "icon": "🤖",
        "sortOrder": 1,
        "productCount": 8
      },
      {
        "_id": "65b9e28f7c1d4a0012345002",
        "name": "Готовые аккаунты",
        "icon": "📁",
        "sortOrder": 2,
        "productCount": 14
      }
    ]
  }
  ```

---

### 3.2 Get Products Catalog
- **Method & URL**: `GET /api/v1/catalog/products`
- **Auth**: None (Public)
- **Query Parameters**:
  - `categoryId` (optional ObjectId)
  - `search` (optional string)
  - `limit` (default 50)
  - `page` (default 1)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "products": [
      {
        "_id": "65b9e28f7c1d4a0012345100",
        "name": "ChatGPT Plus (1 Месяц)",
        "nameEn": "ChatGPT Plus (1 Month)",
        "description": "Подписка на аккаунт OpenAI с доступом к GPT-4o.",
        "price": 18.50,
        "priceRub": 1794.50,
        "officialPrice": 22.00,
        "icon": "⚡",
        "type": "key",
        "categoryId": "65b9e28f7c1d4a0012345001",
        "deliveryMethod": "ready_account",
        "inStock": true,
        "stockCount": 24,
        "warrantyDays": 5,
        "subscriptionDays": 30
      }
    ],
    "pagination": {
      "total": 45,
      "page": 1,
      "pages": 1
    }
  }
  ```

---

### 3.3 Get Product Detail
- **Method & URL**: `GET /api/v1/catalog/products/:id`
- **Auth**: None (Public)
- **Response `200 OK`**: Detailed product object including full markdown description.
- **Error Codes**: `404 NOT_FOUND`

---

## 4. Cart & Orders Checkout API (`/api/v1/orders`)

### 4.1 Execute Instant Checkout (Balance or Invoice)
- **Method & URL**: `POST /api/v1/orders/checkout`
- **Auth**: Required (`auth_token`)
- **Rate Limit**: Tier 3 (10 requests / min)
- **Request Body**:
  ```json
  {
    "productId": "65b9e28f7c1d4a0012345100",
    "qty": 1,
    "paymentMethod": "balance", // "balance" | "bybit_uid" | "platega" | "crypto_trc20"
    "promoCode": "DISCOUNT10",
    "cartVersion": 2
  }
  ```
- **Response `200 OK` (Paid via Balance)**:
  ```json
  {
    "success": true,
    "type": "instant_fulfillment",
    "order": {
      "id": "65b9e28f7c1d4a0012345999",
      "status": "completed",
      "price": 16.65,
      "qty": 1,
      "deliveredKey": "sk-proj-984712038471928471203847120",
      "confirmedAt": "2026-11-23T00:10:00.000Z",
      "warrantyDays": 5
    },
    "remainingBalance": 8.85
  }
  ```
- **Response `201 Created` (Direct Payment Required)**:
  ```json
  {
    "success": true,
    "type": "payment_invoice_created",
    "payment": {
      "paymentId": "674123abc456def789012345",
      "method": "bybit_uid",
      "exactAmount": 16.6542,
      "recipientUid": "554135317",
      "expiresAt": "2026-11-23T00:25:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `409 CONFLICT`: `{ "error": "CART_CHANGED", "message": "Корзина была изменена в другой вкладке" }`
  - `422 UNPROCESSABLE_ENTITY`: `{ "error": "INSUFFICIENT_BALANCE", "message": "Недостаточно средств на балансе" }`
  - `422 UNPROCESSABLE_ENTITY`: `{ "error": "OUT_OF_STOCK", "message": "Товар закончился" }`

---

### 4.2 Get Order Details & Key Delivery
- **Method & URL**: `GET /api/v1/orders/:id`
- **Auth**: Required
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "order": {
      "id": "65b9e28f7c1d4a0012345999",
      "product": {
        "name": "ChatGPT Plus (1 Месяц)",
        "icon": "⚡"
      },
      "status": "completed",
      "price": 16.65,
      "deliveryData": "login@example.com:Password123:2FA_KEY_ABC",
      "warrantyExpiresAt": "2026-11-28T00:10:00.000Z",
      "canClaimWarranty": true
    }
  }
  ```

---

## 5. Payments & Top-ups API (`/api/v1/payments`)

### 5.1 Create Top-up Payment Request
- **Method & URL**: `POST /api/v1/payments/create`
- **Auth**: Required (`auth_token` or `Authorization: Bearer <token>`)
- **Rate Limit**: Tier 3 (10 requests / min per user/IP)
- **Request Body**:
  ```json
  {
    "method": "platega", // "bybit_uid" | "platega" | "usdt_trc20" | "usdt_bep20" | "ton" | "card"
    "amount": 25.00,
    "currency": "USDT"
  }
  ```
- **Response `201 Created` (Platega SBP / Card)**:
  ```json
  {
    "success": true,
    "paymentId": "674123abc456def789012346",
    "method": "platega",
    "amountRub": 2425,
    "amountUsdt": 25.00,
    "payUrl": "https://app.platega.io/pay/trans_platega_987123654",
    "expiresAt": "2026-11-23T00:25:00.000Z"
  }
  ```
- **Response `201 Created` (Bybit UID Fractional Transfer)**:
  ```json
  {
    "success": true,
    "paymentId": "674123abc456def789012347",
    "method": "bybit_uid",
    "exactAmount": 25.0042,
    "baseAmount": 25.00,
    "suffix": 42,
    "recipientUid": "554135317",
    "expiresAt": "2026-11-23T00:25:00.000Z",
    "instructions": "Переведите ТОЧНО указанную сумму через внутренний перевод Bybit без комиссии"
  }
  ```
- **Response `201 Created` (Direct Crypto USDT TRC-20 / BEP-20 / TON)**:
  ```json
  {
    "success": true,
    "paymentId": "674123abc456def789012348",
    "method": "usdt_trc20",
    "amount": 25.00,
    "walletAddress": "TXj982137912830918239018239018239",
    "memo": "INV-TON-00041289", // Included for TON transfers
    "expiresAt": "2026-11-23T01:10:00.000Z"
  }
  ```
- **Error Responses**:
  - `400 BAD_REQUEST`: `{ "error": "INVALID_AMOUNT", "message": "Сумма пополнения должна быть больше нуля" }`
  - `401 UNAUTHORIZED`: `{ "error": "UNAUTHORIZED", "message": "Требуется авторизация" }`
  - `409 CONFLICT`: `{ "error": "BYBIT_SUFFIXES_EXHAUSTED", "message": "Все слоты уникальных сумм Bybit сейчас заняты. Пожалуйста, подождите 1 минуту или выберите другой способ оплаты" }`
  - `422 UNPROCESSABLE_ENTITY`: `{ "error": "MIN_TOPUP_NOT_MET", "message": "Минимальная сумма пополнения составляет 5.00 USDT" }`
  - `422 UNPROCESSABLE_ENTITY`: `{ "error": "METHOD_DISABLED", "message": "Выбранный способ оплаты временно отключен администратором" }`
  - `422 UNPROCESSABLE_ENTITY`: `{ "error": "CURRENCY_NOT_SUPPORTED", "message": "Указанная валюта не поддерживается данным платежным методом" }`
  - `503 SERVICE_UNAVAILABLE`: `{ "error": "PAYMENT_GATEWAY_NOT_CONFIGURED", "message": "Платежный шлюз не сконфигурирован в системе" }`

---

### 5.2 Poll Payment Status
- **Method & URL**: `GET /api/v1/payments/:id/status`
- **Auth**: Required
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "paymentId": "674123abc456def789012346",
    "status": "confirmed", // "pending" | "processing" | "confirmed" | "expired"
    "amount": 25.00,
    "completedAt": "2026-11-23T00:12:30.000Z"
  }
  ```

---

### 5.3 Submit Proof (Receipt Screenshot or TXID)
- **Method & URL**: `POST /api/v1/payments/:id/submit-proof`
- **Auth**: Required
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `txid`: Blockchain hash (optional)
  - `receipt`: Image file (optional)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "status": "pending",
    "message": "Квитанция успешно загружена и ожидает проверки администратора"
  }
  ```

---

### 5.4 Platega Payment Webhook Callback
- **Method & URL**: `POST /api/v1/payments/webhook/platega`
- **Auth**: Inbound HMAC Header Verification (`X-MerchantId`, `X-Secret`)
- **Headers**:
  ```
  X-MerchantId: <merchant_id_string>
  X-Secret: <secret_key_string>
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "id": "trans_platega_987123654",
    "status": "CONFIRMED", // "CONFIRMED" | "SUCCESS" | "FAILED" | "EXPIRED"
    "payload": "674123abc456def789012345", // TopupRequest _id
    "amount": 1450,
    "currency": "RUB",
    "paymentMethod": 2,
    "processedAt": "2026-11-23T00:15:30.000Z"
  }
  ```
- **Response `200 OK` (Processed)**:
  ```json
  {
    "status": "ok",
    "message": "Payment confirmed and balance credited successfully"
  }
  ```
- **Response `200 OK` (Ignored Non-Final Status)**:
  ```json
  {
    "status": "ignored_unconfirmed",
    "message": "Status is not CONFIRMED/SUCCESS; ignored without state change"
  }
  ```
- **Error Responses**:
  - `400 BAD_REQUEST`: `{ "error": "INVALID_PAYLOAD", "message": "Некорректная структура вебхука" }`
  - `401 UNAUTHORIZED`: `{ "error": "INVALID_SIGNATURE", "message": "Недействительные заголовки X-MerchantId или X-Secret" }`
  - `503 SERVICE_UNAVAILABLE`: `{ "error": "PAYMENT_GATEWAY_NOT_CONFIGURED", "message": "Шлюз Platega не сконфигурирован в настройках системы" }`

---

## 6. User Cabinet & Profile API (`/api/v1/user`)

### 6.1 Get Profile Summary
- **Method & URL**: `GET /api/v1/user/profile`
- **Auth**: Required
- **Response `200 OK`**: User profile with total spent, balance, registration date, and referral link.

---

### 6.2 Get Orders History
- **Method & URL**: `GET /api/v1/user/orders`
- **Auth**: Required
- **Query Parameters**: `page=1&limit=20&status=completed`
- **Response `200 OK`**: Paginated list of user's orders with delivered keys.

---

### 6.3 Get Financial Transactions
- **Method & URL**: `GET /api/v1/user/transactions`
- **Auth**: Required
- **Response `200 OK`**: Double-entry ledger history (credits, debits, referral rewards).

---

## 7. Web Admin Panel API (`/api/v1/admin`)

All administrative routes require authentication with `role === 'admin'` or `'superadmin'`, verified via session cookie (`auth_token`) or `Authorization: Bearer <token>` header. Rate limit: Tier 4 (40 requests / min).

### 7.1 Admin Overview Stats & High-Level KPIs
- **Method & URL**: `GET /api/v1/admin/stats`
- **Auth**: Required (`admin` / `superadmin`)
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "revenue": {
      "todayUsdt": 480.50,
      "todayRub": 46608.50,
      "weekUsdt": 3210.00,
      "monthUsdt": 14200.00
    },
    "counts": {
      "pendingOrders": 3,
      "pendingTopups": 2,
      "pendingWarranties": 1,
      "pendingWithdrawals": 1
    },
    "systemHealth": {
      "mongoLatencyMs": 4,
      "redisStatus": "connected",
      "jahaBalanceUsdt": 142.80,
      "bybitPollerActive": true
    }
  }
  ```

---

### 7.2 Timeseries Financial & Sales Analytics
- **Method & URL**: `GET /api/v1/admin/analytics/sales`
- **Auth**: Required (`admin` / `superadmin`)
- **Query Parameters**:
  - `period` (string, optional, default: `7d`): `today` | `7d` | `30d` | `90d` | `custom`
  - `startDate` (ISO string, optional): Required if `period === 'custom'`
  - `endDate` (ISO string, optional): Required if `period === 'custom'`
  - `currency` (string, optional, default: `USDT`): `USDT` | `RUB`
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "period": "7d",
    "summary": {
      "totalGrossRevenue": 3210.00,
      "totalCostPrice": 2140.00,
      "totalNetProfit": 1070.00,
      "totalOrders": 174,
      "averageOrderValue": 18.45
    },
    "timeline": [
      {
        "date": "2026-11-17",
        "ordersCount": 24,
        "grossRevenue": 442.80,
        "costPrice": 295.20,
        "netMargin": 147.60
      },
      {
        "date": "2026-11-18",
        "ordersCount": 31,
        "grossRevenue": 571.95,
        "costPrice": 381.30,
        "netMargin": 190.65
      }
    ]
  }
  ```

- **Method & URL**: `GET /api/v1/admin/analytics/revenue`
- **Auth**: Required (`admin` / `superadmin`)
- **Query Parameters**: `period=30d`
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "period": "30d",
    "categoryBreakdown": [
      { "categoryName": "AI Подписки", "revenue": 7854.00, "sharePercent": 55.0 },
      { "categoryName": "VPN Сервисы", "revenue": 3570.00, "sharePercent": 25.0 },
      { "categoryName": "Готовые аккаунты", "revenue": 2142.00, "sharePercent": 15.0 },
      { "categoryName": "Прочее", "revenue": 714.00, "sharePercent": 5.0 }
    ],
    "gatewayBreakdown": [
      { "gateway": "bybit_uid", "volumeUsdt": 6426.00, "sharePercent": 45.0 },
      { "gateway": "platega_sbp", "volumeUsdt": 4998.00, "sharePercent": 35.0 },
      { "gateway": "crypto_trc20", "volumeUsdt": 2142.00, "sharePercent": 15.0 },
      { "gateway": "bank_card_direct", "volumeUsdt": 714.00, "sharePercent": 5.0 }
    ],
    "customerGrowth": {
      "newUsers": 342,
      "repeatBuyers": 189,
      "conversionRate": 14.8
    }
  }
  ```

---

### 7.3 Products Management (CRUD)
- **Method & URL**: `GET /api/v1/admin/products`
  - Query: `page=1&limit=50&category=<id>&search=chatgpt&status=all`
  - Response `200 OK`: List of all products including cost price, stock count, and provider info.
- **Method & URL**: `POST /api/v1/admin/products`
  - Request Body:
    ```json
    {
      "nameRu": "ChatGPT Plus (1 Месяц)",
      "nameEn": "ChatGPT Plus (1 Month)",
      "descriptionRu": "Официальная подписка на 30 дней",
      "descriptionEn": "Official 30-day subscription",
      "categoryId": "65b9e28f7c1d4a0012345001",
      "price": 18.50,
      "costPrice": 12.00,
      "provider": "local", // "local" | "jaha"
      "deliveryMethod": "instant_key", // "instant_key" | "activation"
      "warrantyDays": 5,
      "isActive": true,
      "sortOrder": 1
    }
    ```
  - Response `201 Created`: Created product object.
- **Method & URL**: `PUT /api/v1/admin/products/:id`
  - Updates existing product fields.
  - Response `200 OK`: Updated product.
- **Method & URL**: `DELETE /api/v1/admin/products/:id`
  - Soft-deletes or archives product (`isActive: false`).
  - Response `200 OK`: `{ "success": true, "message": "Товар архивирован" }`

---

### 7.4 Category Taxonomy Management (CRUD)
- **Method & URL**: `GET /api/v1/admin/categories`
  - Response `200 OK`: List of all categories with product counts and active flags.
- **Method & URL**: `POST /api/v1/admin/categories`
  - Request Body:
    ```json
    {
      "nameRu": "AI Подписки",
      "nameEn": "AI Subscriptions",
      "icon": "🤖",
      "sortOrder": 1,
      "isActive": true
    }
    ```
  - Response `201 Created`: Created category object.
- **Method & URL**: `PUT /api/v1/admin/categories/:id`
  - Request Body: Updates category attributes or `sortOrder` index.
  - Response `200 OK`: Updated category.
- **Method & URL**: `DELETE /api/v1/admin/categories/:id`
  - Guard: Prevents deletion if category contains active products.
  - Response `200 OK`: `{ "success": true, "message": "Категория удалена" }`
  - Error `409 CONFLICT`: `{ "error": "CATEGORY_HAS_PRODUCTS", "message": "Невозможно удалить категорию с активными товарами" }`

---

### 7.5 Digital Keys Pool Management
- **Method & URL**: `GET /api/v1/admin/keys`
  - Query: `productId=<id>&status=available|used&page=1&limit=50`
  - Response `200 OK`: Paginated table of keys with partially masked key values.
- **Method & URL**: `POST /api/v1/admin/keys/bulk-import`
  - Request Body:
    ```json
    {
      "productId": "65b9e28f7c1d4a0012345100",
      "provider": "local",
      "keys": "sk-proj-KEY1\nsk-proj-KEY2\nsk-proj-KEY3",
      "delimiter": "\n"
    }
    ```
  - Response `200 OK`:
    ```json
    {
      "success": true,
      "totalParsed": 3,
      "inserted": 3,
      "duplicatesSkipped": 0
    }
    ```
- **Method & URL**: `DELETE /api/v1/admin/keys/:id`
  - Guard: Deletes key only if `isUsed: false`.
  - Response `200 OK`: `{ "success": true, "message": "Ключ удален из пула" }`

---

### 7.6 Orders Management & Fulfillment
- **Method & URL**: `GET /api/v1/admin/orders`
  - Query: `status=pending|processing|completed|cancelled&page=1&limit=25`
  - Response `200 OK`: Orders list with customer details, profit margin, and delivery payloads.
- **Method & URL**: `GET /api/v1/admin/orders/:id`
  - Response `200 OK`: Detailed order payload with timeline and customer profile.
- **Method & URL**: `POST /api/v1/admin/orders/:id/fulfill`
  - Request Body:
    ```json
    {
      "deliveryData": "account@mail.com:Password!123:2FA_TOKEN",
      "notifyUser": true
    }
    ```
  - Transitions order to `completed`, encrypts `deliveryData`, and pushes notification to user via bot.
  - Response `200 OK`: `{ "success": true, "orderStatus": "completed" }`
- **Method & URL**: `POST /api/v1/admin/orders/:id/cancel`
  - Request Body:
    ```json
    {
      "reason": "Товар временно недоступен у поставщика",
      "refundUser": true
    }
    ```
  - Executes MongoDB ACID transaction: transitions status to `cancelled`, releases reserved keys, and refunds full order cost to `User.balance`.
  - Response `200 OK`: `{ "success": true, "refundedAmount": 18.50 }`

---

### 7.7 User Administration & Role/Balance Management
- **Method & URL**: `GET /api/v1/admin/users`
  - Query: `search=@alex&role=user|admin&isBanned=false&page=1&limit=25`
  - Response `200 OK`: Paginated customer profiles with balance and spend metrics.
- **Method & URL**: `GET /api/v1/admin/users/:id`
  - Response `200 OK`: Complete customer 360 profile, order history, and ledger entries.
- **Method & URL**: `POST /api/v1/admin/users/:id/adjust-balance`
  - Request Body:
    ```json
    {
      "action": "credit", // "credit" | "debit"
      "amount": 10.00,
      "reason": "Компенсация по тикету #482 за задержку активации"
    }
    ```
  - Atomically updates `User.balance` and creates an audit `Transaction` record.
  - Response `200 OK`: `{ "success": true, "newBalance": 25.50 }`
- **Method & URL**: `PUT /api/v1/admin/users/:id/role`
  - Request Body:
    ```json
    {
      "role": "admin" // "user" | "admin" | "superadmin"
    }
    ```
  - Guard: Only `superadmin` can promote to `admin` or `superadmin`.
  - Response `200 OK`: `{ "success": true, "role": "admin" }`
- **Method & URL**: `POST /api/v1/admin/users/:id/ban`
  - Request Body:
    ```json
    {
      "isBanned": true,
      "reason": "Множественные попытки мошенничества с чеками"
    }
    ```
  - Toggles `isBanned` flag and invalidates user sessions.
  - Response `200 OK`: `{ "success": true, "isBanned": true }`

---

### 7.8 Payment Approvals & Top-up Rejections
- **Method & URL**: `GET /api/v1/admin/payments/pending`
  - Query: `method=card|crypto&page=1&limit=20`
  - Response `200 OK`: List of pending deposits with receipt image URLs and user details.
- **Method & URL**: `POST /api/v1/admin/payments/:id/approve`
  - Request Body:
    ```json
    {
      "adjustedAmount": 25.00, // Optional override if user transferred different sum
      "note": "Чек сверен с выпиской банка"
    }
    ```
  - Credits `User.balance`, creates `Transaction`, transitions `TopupRequest` to `confirmed`, notifies user in Telegram.
  - Response `200 OK`: `{ "success": true, "creditedAmount": 25.00 }`
- **Method & URL**: `POST /api/v1/admin/payments/:id/reject`
  - Request Body:
    ```json
    {
      "reason": "Квитанция не читаема или сумма не поступила на счет"
    }
    ```
  - Transitions `TopupRequest` to `rejected` and sends explanation to user via bot.
  - Response `200 OK`: `{ "success": true, "status": "rejected" }`

---

### 7.9 Promo Codes Management (CRUD)
- **Method & URL**: `GET /api/v1/admin/promos`
  - Response `200 OK`: List of all promo codes with activation stats and expiry dates.
- **Method & URL**: `POST /api/v1/admin/promos`
  - Request Body:
    ```json
    {
      "code": "CYBER2026",
      "type": "percent", // "percent" | "fixed_amount" | "balance_bonus"
      "value": 15, // 15% discount or 15.00 USDT
      "maxUses": 100,
      "maxPerUser": 1,
      "minOrderAmount": 10.00,
      "expiresAt": "2026-12-31T23:59:59.000Z",
      "productScope": "all", // "all" | array of category ObjectIds
      "isActive": true
    }
    ```
  - Response `201 Created`: Created promo code object.
- **Method & URL**: `PUT /api/v1/admin/promos/:id`
  - Updates promo code limits or expiration.
  - Response `200 OK`: Updated promo code.
- **Method & URL**: `DELETE /api/v1/admin/promos/:id`
  - Deactivates or removes promo code.
  - Response `200 OK`: `{ "success": true, "message": "Промокод деактивирован" }`

---

### 7.10 Warranties & Disputes Resolution
- **Method & URL**: `GET /api/v1/admin/disputes`
  - Query: `status=pending|investigating|resolved&page=1&limit=20`
  - Response `200 OK`: Warranty claims queue with order ID, proof screenshots, and claim reason.
- **Method & URL**: `POST /api/v1/admin/disputes/:id/resolve`
  - Request Body:
    ```json
    {
      "resolution": "replace_key", // "replace_key" | "refund_balance" | "reject"
      "reason": "Гарантийный случай подтвержден. Выдан новый ключ из резерва",
      "replacementKey": "sk-proj-REPLACEMENT98412" // Optional; auto-drawn from pool if omitted
    }
    ```
  - Atomic execution: Assigns key or refunds balance, updates dispute to resolved, delivers payload to customer via bot.
  - Response `200 OK`: `{ "success": true, "resolution": "replace_key", "disputeStatus": "closed" }`

---

### 7.11 Seller Withdrawals Queue
- **Method & URL**: `GET /api/v1/admin/sellers/withdrawals`
  - Query: `status=pending|approved|rejected&page=1&limit=25`
  - Response `200 OK`: Payout requests with seller metrics, payout channel, and destination requisites.
- **Method & URL**: `POST /api/v1/admin/sellers/withdrawals/:id/approve`
  - Request Body:
    ```json
    {
      "txid": "0x4b789123abc45678901234567890abcdef",
      "note": "Выплата переведена в сети TON"
    }
    ```
  - Transitions withdrawal to `paid`, decrements seller frozen balance, sends payout confirmation to seller.
  - Response `200 OK`: `{ "success": true, "status": "paid" }`
- **Method & URL**: `POST /api/v1/admin/sellers/withdrawals/:id/reject`
  - Request Body:
    ```json
    {
      "reason": "Неверный формат кошелька TON. Проверьте реквизиты"
    }
    ```
  - Unfreezes seller balance, marks withdrawal `rejected`, notifies seller.
  - Response `200 OK`: `{ "success": true, "status": "rejected" }`

---

### 7.12 Required Channels Subscription Management
- **Method & URL**: `GET /api/v1/admin/channels`
  - Response `200 OK`: List of configured mandatory subscription channels.
- **Method & URL**: `POST /api/v1/admin/channels`
  - Request Body:
    ```json
    {
      "title": "Официальный канал новостей",
      "chatId": -1001928301928,
      "inviteLink": "https://t.me/+AbCdEfGhIjK",
      "enforceScope": "all", // "all" | "promo_only"
      "isActive": true
    }
    ```
  - Performs Bot API `getChatMember` verification during creation.
  - Response `201 Created`: Created channel record.
- **Method & URL**: `DELETE /api/v1/admin/channels/:id`
  - Removes channel from mandatory check list.
  - Response `200 OK`: `{ "success": true, "message": "Обязательный канал удален" }`

---

### 7.13 Bulk Operations & Telegram Broadcasting
- **Method & URL**: `POST /api/v1/admin/broadcast`
  - Request Body:
    ```json
    {
      "messageHtml": "🔥 <b>Черная Пятница началась!</b>\nСкидки 25% на все AI подписки!",
      "buttons": [
        { "text": "Открыть каталог", "url": "https://shop.domain.com/shop" },
        { "text": "Открыть WebApp", "webAppUrl": "https://shop.domain.com" }
      ],
      "audience": "active_buyers", // "all" | "active_buyers" | "inactive_30d" | "positive_balance"
      "rateLimitPerSecond": 25
    }
    ```
  - Queues bulk broadcast job with progress tracking.
  - Response `202 Accepted`:
    ```json
    {
      "success": true,
      "jobId": "broadcast_job_849201",
      "targetCount": 1840,
      "estimatedDurationMinutes": 1.2
    }
    ```
- **Method & URL**: `POST /api/v1/admin/products/bulk-pricing`
  - Request Body:
    ```json
    {
      "categoryId": "65b9e28f7c1d4a0012345001",
      "provider": "all",
      "operation": "increase_percent", // "increase_percent" | "decrease_percent" | "fixed_offset"
      "value": 10, // 10%
      "enforceCostFloor": true
    }
    ```
  - Updates retail prices in bulk while strictly checking `price >= costPrice`.
  - Response `200 OK`:
    ```json
    {
      "success": true,
      "productsUpdated": 14,
      "skippedDueToFloor": 0
    }
    ```

---

### 7.14 Supplier Configuration & Catalog Sync Triggers
- **Method & URL**: `GET /api/v1/admin/suppliers`
  - Response `200 OK`: List of supplier integrations with cached balance and connection status.
- **Method & URL**: `PUT /api/v1/admin/suppliers/:id`
  - Request Body:
    ```json
    {
      "name": "Jaha Digital",
      "baseUrl": "https://api.jaha.digital/v1",
      "apiKey": "enc_secret_key_string",
      "markupTiers": [
        { "maxCost": 5.0, "markupPercent": 30 },
        { "maxCost": 20.0, "markupPercent": 20 },
        { "maxCost": 1000.0, "markupPercent": 15 }
      ],
      "minMarginFloor": 0.50,
      "isActive": true
    }
    ```
  - Encrypts credentials with AES-256-GCM.
  - Response `200 OK`: Updated supplier config.
- **Method & URL**: `POST /api/v1/admin/suppliers/:id/sync`
  - Triggers asynchronous catalog sync.
  - Response `202 Accepted`: `{ "success": true, "syncTaskId": "sync_jaha_84921", "status": "started" }`

---

### 7.15 Global System Settings & Maintenance Mode
- **Method & URL**: `GET /api/v1/admin/settings`
  - Response `200 OK`: System global configuration, gateway toggles, and exchange rate parameters.
- **Method & URL**: `PUT /api/v1/admin/settings`
  - Request Body:
    ```json
    {
      "maintenanceMode": false,
      "maintenanceMessage": "Плановые технические работы до 02:00 МСК",
      "enabledGateways": ["bybit_uid", "platega", "usdt_trc20", "usdt_bep20", "ton", "card"],
      "exchangeRateMode": "bybit_p2p", // "bybit_p2p" | "cbr_spread" | "manual"
      "manualRubRate": 97.50,
      "exchangeRateMarkup": 2.5
    }
    ```
  - Response `200 OK`: Updated global settings.

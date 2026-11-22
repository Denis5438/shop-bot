# Customer Storefront & Web Admin Panel UX Specifications

## 1. Customer Storefront UX (Benchmarking `https://lachuga.shop/shop`)

The customer storefront is designed with a modern, glassmorphic dark aesthetic optimized for digital goods, subscriptions, and instant deliveries.

```
┌────────────────────────────────────────────────────────────────────────┐
│ [Logo] ShopBot Web    [Поиск по товарам...]    [USDT: 97.00 ₽]  [👤 @alex]│
├────────────────────────────────────────────────────────────────────────┤
│ [Все товары]  [🤖 AI Подписки]  [📁 Аккаунты]  [🔑 API Ключи]  [⚡ VPN] │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│ ┌──────────────────────────┐  ┌──────────────────────────┐             │
│ │ ⚡ ChatGPT Plus (1 Мес)  │  │ 🤖 Claude 3.5 Sonnet Pro │             │
│ │ Официальная подписка     │  │ Безлимитный доступ к API │             │
│ │                          │  │                          │             │
│ │ 🟢 В наличии: 18 шт.     │  │ 🟡 Осталось мало: 2 шт.  │             │
│ │ 18.50 USDT (~1,794 ₽)    │  │ 22.00 USDT (~2,134 ₽)    │             │
│ │ [Купить в 1 клик]        │  │ [Купить в 1 клик]        │             │
│ └──────────────────────────┘  └──────────────────────────┘             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Visual Design Tokens & Glassmorphic Styling

| Token | CSS Value | Usage |
|---|---|---|
| **Background Base** | `#0A0D14` | Deep obsidian background of the entire viewport. |
| **Surface Glass** | `rgba(18, 22, 32, 0.75)` | Translucent surface for cards, dialogs, and navigation headers. |
| **Backdrop Filter** | `backdrop-filter: blur(16px)` | Glassmorphic blur applied to surface cards and sticky headers. |
| **Border Glass** | `1px solid rgba(255, 255, 255, 0.08)` | Subtle border accent delineating cards and input fields. |
| **Primary Accent** | `#6366F1` (Electric Indigo) | Primary call-to-action buttons, active tab indicators, focus rings. |
| **Secondary Accent**| `#10B981` (Emerald Green) | In-stock badges, completed transaction indicators, balance pills. |
| **Warning Accent** | `#F59E0B` (Amber) | Low stock pills (`<= 5` items), pending confirmation states. |
| **Destructive** | `#EF4444` (Ruby) | Out-of-stock badges, error banners, dispute alerts. |
| **Typography** | `Inter, -apple-system, sans-serif`| Clean, high-legibility geometric sans-serif typeface. |

---

### 1.2 Layout & Key Components

#### 1. Header & Global Navigation
- **Branding**: Store logo with animated gradient hover.
- **Live Exchange Rate Indicator**: Pill showing current Bybit P2P conversion rate (`USDT: 97.00 ₽`).
- **Interactive Search Input**: Debounced search input (`300ms`) with dynamic dropdown highlighting matching products.
- **User Authentication Pill**:
  - *Unauthenticated*: "Войти через Telegram" button opening the 6-digit signin modal.
  - *Authenticated*: User avatar / initials badge, Telegram username, account balance badge (`18.50 USDT`), Top-up shortcut button (`+`), and profile dropdown.

#### 2. Category Navigation Tabs
- Horizontal scrollable pill buttons: "Все товары", "AI Подписки", "Готовые аккаунты", "API Ключи", "VPN & Прокси".
- Active category displays glowing indigo border and subtle background lighting.

#### 3. Product Catalog Grid
- Responsive 1-to-4 column grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`).
- **Card Anatomy**:
  - Icon / Emoji Badge: `product.icon` (e.g. `🤖`, `⚡`).
  - Origin Tag: "Официальный" or "Проверенный поставщик".
  - Title: Bold high-contrast product name (`product.name`).
  - Stock Pill Badge:
    - `🟢 В наличии: X шт.` (when `stock > 5`)
    - `🟡 Осталось мало: X шт.` (when `1 <= stock <= 5`)
    - `🔴 Нет в наличии` (when `stock === 0`, with "Уведомить о поступлении" Waitlist button).
  - Price Tag: Formatted in USDT and converted RUB (`18.50 USDT` / `~1,794 ₽`). If discount active, displays strikethrough original price and discount badge (`-20%`).
  - Primary Action Button: "Купить" (opens modal).

---

### 1.3 Interactive Product Purchase Modal

```
┌────────────────────────────────────────────────────────┐
│ ⚡ ChatGPT Plus (1 Месяц)                      [ ✕ ]   │
├────────────────────────────────────────────────────────┤
│ Подписка на персональный аккаунт OpenAI.               │
│ Гарантия: 🛡 5 дней | Срок подписки: 30 дней           │
│                                                        │
│ Способ получения:                                      │
│ (●) Готовый аккаунт (мгновенно)                        │
│ ( ) Активация на ваш e-mail                            │
│                                                        │
│ Количество:   [-]  [ 1 ]  [+]   (В наличии: 18 шт.)    │
│                                                        │
│ Промокод:     [ Введите промокод... ]  [ Применить ]   │
│                                                        │
│ Способ оплаты:                                         │
│ [ (●) Баланс аккаунта: 24.50 USDT ]                    │
│ [ ( ) СБП / Карта РФ (Platega)    ]                    │
│ [ ( ) Bybit UID перевод           ]                    │
│ [ ( ) Криптовалюта (USDT TRC-20)  ]                    │
├────────────────────────────────────────────────────────┤
│ Итого к оплате: 18.50 USDT (~1,794 ₽)                  │
│ [              Оплатить и получить ключ              ] │
└────────────────────────────────────────────────────────┘
```

- **Features**:
  - Instant discount calculation upon applying a valid `PromoCode`.
  - Delivery method selection: `ready_account` (instant key) vs `activation` (requires account token).
  - Quantity counter clamped to currently available unused keys (`Key.countDocuments`).
  - Seamless balance deduction or automatic redirect to direct payment gateway invoice.

---

### 1.4 Instant Key Delivery & Order Tracking Screen

Upon successful checkout, the customer is presented with the dedicated fulfillment view:

```
┌────────────────────────────────────────────────────────┐
│ ✅ Оплата успешно выполнена!                 #ORD-84912│
├────────────────────────────────────────────────────────┤
│ Товар: ChatGPT Plus (1 Месяц)                          │
│ Дата: 23 ноября 2026, 00:15                            │
│                                                        │
│ ┌────────────────────────────────────────────────────┐ │
│ │ sk-proj-849203819203910283901928301928301928       │ │
│ └────────────────────────────────────────────────────┘ │
│ [ 📋 Скопировать ключ ]      [ 💾 Скачать .txt ]       │
│                                                        │
│ ℹ️ Инструкция по активации:                            │
│ 1. Перейдите на сайт chatgpt.com                       │
│ 2. Введите полученные учетные данные                   │
│ 3. Проверьте статус подписки в настройках              │
│                                                        │
│ Гарантия: 🛡 До 28 ноября 2026 (осталось 5 дней)       │
│ [ Запросить замену по гарантии ]   [ Связаться с ботом]│
└────────────────────────────────────────────────────────┘
```

- **Capabilities**:
  - One-click copy to clipboard with toast notification.
  - Download as `.txt` file.
  - Collapsible instructions and direct warranty replacement request form.

---

### 1.5 User Cabinet (`/profile`)

The personal cabinet comprises four tabbed views:
1. **Обзор (Overview)**: Account balance, total purchases count, lifetime spent, and quick top-up shortcut.
2. **Мои покупки (Purchases)**: Paginated table of all historical orders with revealable keys and warranty countdown timers.
3. **Финансы (Finance)**: Transparent double-entry ledger showing all top-ups, order debits, refunds, and referral bonuses.
4. **Реферальная программа (Referrals)**:
   - Personal referral link and QR code.
   - Live metrics: Total invited, qualifying buyers, total USDT earned.
   - Rule explainer: "Получайте 0.50 USDT за каждого друга, совершившего покупку от 3.00 USDT".

---

## 2. Web Admin Panel UX (100% Feature Parity with Bot Scenes)

The Web Admin Panel is accessible at `/admin` and provides a comprehensive desktop control room mirroring all Telegram bot administrative scenes.

```
┌────────────────────────────────────────────────────────────────────────┐
│ 🛡 ShopBot Admin    [Общий статус: ОК]    [База: 4мс]    [Выйти] 👤    │
├──────────────┬─────────────────────────────────────────────────────────┤
│ 📊 Дашборд   │ 📊 Аналитика продаж                                     │
│ 📦 Товары    │ ┌───────────────┐ ┌───────────────┐ ┌─────────────────┐ │
│ 📁 Категории │ │ Выручка (24ч) │ │ Заказов (24ч) │ │ Баланс Jaha API │ │
│ 🔑 Пул ключей│ │  $480.50 USDT │ │   32 шт.      │ │   $142.80 USDT  │ │
│ 📑 Заказы (3)│ └───────────────┘ └───────────────┘ └─────────────────┘ │
│ 👥 Клиенты   │                                                         │
│ 💳 Пополнения│ ⚠️ Требуют внимания оператора:                          │
│ 🛡 Гарантии  │ • 3 ручных заказа ожидают активации    [Перейти]        │
│ 🔌 Поставщики│ • 2 заявки на пополнение по карте РФ   [Проверить]      │
│ ⚙️ Настройки │ • 1 запрос на замену по гарантии       [Рассмотреть]    │
└──────────────┴─────────────────────────────────────────────────────────┘
```

### 2.1 Administrative Functional Modules (Complete 15-Scene Parity Matrix)

The Web Admin Panel replicates 100% of the capabilities across all 15 Telegram bot administrative scenes, providing desktop-optimized workflows, bulk operations, and real-time oversight:

| # | Administrative Module | Telegram Bot Scene | Web Admin Screen & Core Capabilities |
|---|---|---|---|
| **1** | **Products & Pricing** | `products.scene.js` | Product table with filtering, search, and stock counts. Slide-over drawer for Product CRUD: Name (RU/EN), Markdown description (RU/EN), Price, Cost Price, Provider (`local`, `jaha`), Delivery Method (`instant_key`, `activation`), Category, Warranty days, and Flash Sale toggles. Drag-and-drop sort reordering. |
| **2** | **Categories & Taxonomy** | `categories.scene.js` | Category creation/editing modal, icon picker (Lucide + Emoji), sort ordering index, and active visibility toggles. Synchronizes tree hierarchy across web and bot. |
| **3** | **Digital Key Pool** | `keys.scene.js` | **Bulk Key Import Modal**: Textarea accepting thousands of keys (one per line) with automatic duplicate filtering and validation. **Inventory Inspection Table**: Filter keys by product, status (`available`, `used`, `reserved`), search key content, delete unassigned keys. |
| **4** | **Orders Fulfillment** | `orders.scene.js` | Status filter tabs (`pending`, `awaiting_token`, `processing`, `completed`, `cancelled`). Order detail drawer showing customer details, cost, profit. **Fulfillment Actions**: "Выдать ключ вручную", "Отменить и вернуть средства", "Повторить попытку активации". Automated bot push notification to customer upon status change. |
| **5** | **User Management** | `users.scene.js` | Search users by Telegram ID, username, or ObjectId. Customer 360 inspector: balance, total spent, order history, referrals. **Actions**: "Корректировка баланса" (`manual_credit` / `manual_debit` with required reason string and audit logging), "Заблокировать / Разблокировать", "Изменить роль" (`user`, `admin`, `superadmin`). |
| **6** | **Payment Gateways & Proofs** | `payments.scene.js` | Pending top-up queue. Displays customer proof image/receipt with zoom viewer, gateway method, amount. Actions: "Подтвердить начисление", "Изменить сумму и подтвердить", "Отклонить с уведомлением". Real-time Bybit UID fractional invoice inspector with active lock recovery. |
| **7** | **Supplier Jaha Integration** | `suppliers.scene.js` | Jaha Digital API settings (AES-256 encrypted API token, base URL, smart pricing tiers, markup percentage, margin fixed floor). Live supplier balance check button. "Синхронизировать каталог прямо сейчас" trigger with live progress spinner and error audit logs. |
| **8** | **Promo Codes Management** | `promos.scene.js` | Promo codes table with usage counters, discount type (`percent`, `fixed_amount`, `balance_bonus`), expiration timers, min order requirements, user activation limits, and active status toggle. |
| **9** | **Warranties & Disputes** | `disputes.scene.js` | Customer warranty claims queue with customer screenshot, description, and warranty countdown timer. Actions: "Выдать замену из пула", "Оформить полный возврат на баланс", "Отклонить претензию" with automated customer bot push. |
| **10** | **Seller Withdrawals Queue** | `seller_withdrawals.scene.js` | Third-party seller withdrawal queue with seller sales stats, commission breakdown, destination wallet / Russian card, and actions to approve (with TXID proof) or reject (with funds returned to seller balance). |
| **11** | **Required Channels** | `req_channels.scene.js` | Mandatory subscription channels management (`RequiredChannel`). Add/edit channel Chat ID, title, invite link, verify bot membership permissions via Telegram API, and toggle mandatory subscription enforcement. |
| **12** | **Sales & Financial Analytics** | `stats.scene.js` | Comprehensive timeseries financial charts: Daily revenue and profit trendlines (7d, 30d, 90d, custom), category sales distribution pie charts, payment gateway breakdown, customer acquisition metrics, and CSV/Excel export. |
| **13** | **Broadcasting & Bulk Pricing** | `bulk.scene.js` | **Telegram Mass Broadcast**: Rich HTML message composer with inline button builder, audience segmentation (all, active, inactive > 30d), and rate-throttled queue (25 msg/s). **Bulk Pricing Tool**: Catalog-wide percentage or fixed price markups/markdowns with cost-floor protection. |
| **14** | **System Settings & Maintenance** | `settings.scene.js` | Global maintenance mode toggle with customizable customer downtime notice. Payment gateway activation toggles (Platega, Bybit, TRC20, BEP20, TON, Cards). Currency exchange rate engine (Bybit P2P vs Central Bank + spread vs Manual rate). |
| **15** | **Live Chat Customer Support** | `admin.scene.js` | Integrated customer support inbox mirroring bot dialogue. Two-way live messaging relay between web admin and Telegram user, canned quick responses, image attachment support, and dispute escalation shortcuts. |

---

### 2.2 Module 1: Products Management & Smart Pricing (`products.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ [📦 Товары]  [+ Добавить товар]  [Поиск по названию...]  [Категория: ▼]│
├────────────────────────────────────────────────────────────────────────┤
│ Название         │ Категория │ Цена (USDT) │ Себестоимость │ Остаток   │
├──────────────────┼───────────┼─────────────┼───────────────┼───────────┤
│ ⚡ ChatGPT Plus   │ AI        │ 18.50 USDT  │ 12.00 USDT    │ 🟢 18 шт. │
│ 🤖 Claude Sonnet │ AI        │ 22.00 USDT  │ 15.00 USDT    │ 🟡 2 шт.  │
│ 🔑 Midjourney    │ Дизайн    │ 14.00 USDT  │ 9.50 USDT     │ 🔴 0 шт.  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Core Capabilities**:
  - Full product lifecycle: Draft, Active, Archived.
  - Multi-language metadata: Name (`ru`/`en`), detailed rich Markdown descriptions, activation guidelines.
  - Pricing rules: Retail price, cost price floor, margin calculator, flash sale discount scheduling.
  - Provider routing: `local` (keys drawn from internal pool) vs `jaha` (real-time automated supplier token order).
  - Drag-and-drop sort reordering with instant optimistic UI update.

---

### 2.3 Module 2: Categories & Taxonomy (`categories.scene.js`)

- **Screen Layout**: Hierarchical category tree table with product count badges, sort handle, icon preview, and action pills.
- **Category Creation / Edit Drawer**:
  - Name in Russian and English.
  - Icon selector supporting Lucide SVG icons and Telegram emoji symbols.
  - Display sort index (`sortOrder: Number`).
  - Active toggle switch (`isActive: Boolean`).
- **Synchronized Behavior**: Updates to category ordering or visibility propagate immediately to both the web storefront navigation bar and the Telegram bot inline keyboards.

---

### 2.4 Module 3: Digital Key Inventory Pool & Bulk Import (`keys.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ [🔑 Пул ключей]  [+ Массовый импорт]  [Товар: ChatGPT Plus (18) ▼]     │
├────────────────────────────────────────────────────────────────────────┤
│ ID       │ Ключ (первые/последние 4) │ Статус     │ Дата добавления    │
├──────────┼───────────────────────────┼────────────┼────────────────────┤
│ #KEY-901 │ sk-p...291a               │ 🟢 Доступен│ 22.11.2026, 18:30  │
│ #KEY-900 │ sk-p...84bc               │ 🟢 Доступен│ 22.11.2026, 18:30  │
│ #KEY-899 │ sk-p...110f               │ ⚪ Выдан   │ 21.11.2026, 14:10  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Bulk Import Slide-over Drawer**:
  - Multi-line textarea accepting up to 10,000 keys simultaneously.
  - Delimiter selection: Newline, semicolon, or comma.
  - Real-time pre-validation parser displaying: Total lines parsed, unique keys found, duplicates within input, and duplicates already existing in MongoDB (`Key.key`).
  - Atomic bulk insertion into MongoDB using chunked `bulkWrite(unordered: false)` operations.
- **Inventory Inspection Table**:
  - Obfuscated key preview with copy button (revealed only upon explicit admin action with audit log).
  - Search keys by partial content or assigned Order ID.
  - One-click deletion of unassigned/available keys.

---

### 2.5 Module 4: Orders Fulfillment & Manual Processing (`orders.scene.js`)

- **Order Queue Status Tabs**:
  - `Все заказы`, `Требуют внимания (Manual)` (3), `В обработке`, `Выполненные`, `Отмененные`.
- **Order Details Drawer**:
  - Customer info: Telegram ID, username, registration age, total spend history.
  - Financials: Retail price, discount promo applied, cost price, net merchant margin.
  - Fulfillment Actions:
    - **"Выдать ключ вручную"**: Select an available key from the pool or paste a custom activation link/token. Transitions order to `completed` and delivers payload to user via bot.
    - **"Отменить и вернуть средства"**: Rolls back order, releases reserved keys, and credits full payment back to `User.balance` inside a MongoDB ACID transaction.
    - **"Повторить попытку поставщика"**: Retries failed Jaha API fulfillment with fresh idempotency key.

---

### 2.6 Module 5: Customer Management & Balance Adjustments (`users.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ [👥 Клиенты]  [Поиск: @alex / ID / ObjectId]  [Роль: Все ▼]            │
├────────────────────────────────────────────────────────────────────────┤
│ Telegram ID │ Username      │ Баланс (USDT) │ Покупок │ Роль   │ Статус│
├─────────────┼───────────────┼───────────────┼─────────┼────────┼───────┤
│ 104928172   │ @customer_alex│ 24.50 USDT    │ 12 шт.  │ user   │ 🟢    │
│ 849201923   │ @tech_guru    │ 0.00 USDT     │ 1 шт.   │ user   │ 🟢    │
│ 339102948   │ @spammer_bot  │ 0.00 USDT     │ 0 шт.   │ user   │ 🔴 Бан│
└────────────────────────────────────────────────────────────────────────┘
```

- **Customer 360 View**:
  - Account overview: Lifetime spend, total top-ups, dispute frequency, referral stats.
  - Complete order history and double-entry transaction ledger history.
- **Balance Adjustment Modal**:
  - Action selector: `credit` (Add funds) vs `debit` (Deduct funds).
  - Amount input with 4-decimal precision.
  - Mandatory audit reason textarea (minimum 10 characters).
  - Atomic execution updating `User.balance` and saving an immutable `Transaction` record with `type: 'manual_adjustment'`, recording admin operator ID and reason.
- **Role Assignment & Ban Management**:
  - Toggle `isBanned` state (instantly invalidates active JWT sessions via Redis token blacklist).
  - Promote/demote roles (`user`, `admin`, `superadmin`).

---

### 2.7 Module 6: Bybit UID & Payment Gateway Inspector (`payments.scene.js`, `settings.scene.js`)

- **Gateway Tabs**: `Все`, `Bybit UID`, `Platega СБП`, `Карты РФ (Чеки)`, `Криптовалюта`.
- **Pending Receipt Review Queue**:
  - Displays customer-uploaded bank transfer receipt screenshots with pan/zoom lightbox.
  - Side-by-side transaction metadata: Customer username, nominal amount, payment method, requested time.
  - **Approval Actions**:
    - "Подтвердить начисление": Credits balance and sends confirmation push to user.
    - "Скорректировать сумму и подтвердить": Adjusts credited amount if client underpaid/overpaid.
    - "Отклонить заявку": Rejects top-up with mandatory reason string sent to the user in Telegram.
- **Bybit UID Invoices Monitor**:
  - Live inspection table of active fractional suffixes ($0.0001 - $0.0099$).
  - Lock status monitor displaying active worker locks and "Принудительно разблокировать зависшие счета" utility.

---

### 2.8 Module 7: Supplier Jaha Integration & Sync Controls (`suppliers.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 🔌 Интеграция: Jaha Digital API    [🟢 Подключено (85мс)]              │
├────────────────────────────────────────────────────────────────────────┤
│ Баланс у поставщика: 142.80 USDT           Последняя синхронизация: 4м │
│ [ 🔄 Синхронизировать прямо сейчас ]      [ ⚙️ Настройки шлюза ]       │
├────────────────────────────────────────────────────────────────────────┤
│ Правила умной наценки:                                                 │
│ • Товары до $5.00:      +30% наценка                                   │
│ • Товары от $5 до $20:  +20% наценка                                   │
│ • Товары свыше $20:     +15% наценка                                   │
│ • Минимальная чистая маржа (floor): +0.50 USDT                         │
└────────────────────────────────────────────────────────────────────────┘
```

- **Capabilities**:
  - Real-time supplier balance inquiry with cached indicator.
  - One-click catalog synchronization trigger running asynchronously in background with real-time SSE progress updates.
  - Configuration of encrypted API access tokens (AES-256-GCM), base URLs, and smart pricing tier rules.
  - Detailed sync execution audit log showing products updated, new SKUs imported, and depleted SKUs deactivated.

---

### 2.9 Module 8: Promo Codes & Campaigns (`promos.scene.js`)

- **Promo Codes Directory**:
  - Table of active and archived promotional vouchers.
  - Columns: Code, Discount Type (`percent`, `fixed_amount`, `balance_bonus`), Value, Usage Count / Maximum Uses, Min Order USDT, Expiration Date, Status.
- **Promo Code Creation & Edit Modal**:
  - Unique alphanumeric promo code string.
  - Reward type selector:
    - Percentage discount (e.g. `15%`).
    - Fixed order discount in USDT (e.g. `$2.50 USDT`).
    - Direct balance credit upon code activation.
  - Scope constraint: Valid for all products or restricted to selected categories.
  - Usage limits: Global maximum activations and per-user activation limit.
  - Start and expiration timestamps.
- **Real-Time Performance Metrics**:
  - Total gross revenue generated through campaign, total discounts granted, and conversion uplift.

---

### 2.10 Module 9: Warranties, Replacements & Disputes (`disputes.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 🛡 Заявки по гарантии (1 ожидает)                                      │
├────────────────────────────────────────────────────────────────────────┤
│ #DISP-104 │ Клиент: @tech_guru │ Заказ: #ORD-84192 (ChatGPT Plus)      │
│ Заявлено: «Ключ перестал работать на 3-й день подписки»                │
│ Срок гарантии: 🟢 Активна (осталось 2 дня)                             │
│ Приложенные скриншоты: [Скриншот_ошибки.png (клик для увеличения)]     │
├────────────────────────────────────────────────────────────────────────┤
│ [ 🔄 Выдать замену из пула ]  [ 💳 Полный возврат ]  [ ❌ Отклонить ]  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Dispute Queue**:
  - Filter by status: `pending`, `under_review`, `resolved_replacement`, `resolved_refund`, `rejected`.
  - Countdown timer indicating remaining days/hours of warranty coverage for each claim.
- **Resolution Workflows**:
  1. **"Выдать замену из пула"**: Atomically draws an unused replacement key from `Key` collection, assigns it to the order, sets dispute to `resolved_replacement`, and delivers replacement key to user via bot.
  2. **"Полный возврат"**: Executes atomic MongoDB transaction refunding full order amount to buyer's `User.balance`, creates ledger entry, and closes dispute.
  3. **"Отклонить претензию"**: Marks claim rejected with mandatory justification message transmitted to customer via Telegram bot.

---

### 2.11 Module 10: Third-Party Seller Management & Withdrawals (`seller_withdrawals.scene.js`)

- **Seller Payouts Queue**:
  - Table of pending payout requests from verified digital goods merchants.
  - Columns: Withdrawal ID, Seller Username, Requested USDT, Payout Channel (USDT TRC-20, TON, Russian Bank Card), Destination Wallet / Card, Request Date, Status.
- **Seller Approval Drawer**:
  - Verified seller metrics: Gross sales volume, platform commission withheld (e.g. 5%), current available balance.
  - Payout validation: Destination address format validator.
  - **Fulfillment**:
    - "Подтвердить выплату": Admin enters transaction hash (TXID) or uploads payment receipt; transitions status to `paid`.
    - "Отклонить заявку": Returns requested funds to seller balance, requires admin rejection reason.

---

### 2.12 Module 11: Mandatory Required Channels (`req_channels.scene.js`)

- **Mandatory Subscriptions Directory**:
  - List of partner or official Telegram channels required for customer bot access or bonus rewards.
  - Table: Channel Title, Chat ID (`-100...`), Invite Link, Bot Admin Status, Enforced Scope, Active Switch.
- **Channel Registration Modal**:
  - Input Channel Username or Invite Link and Chat ID.
  - Automated "Проверить статус бота" button querying Telegram Bot API `getChatMember` to confirm bot has administrative permissions in target channel.
  - Enforcement rule selector: Mandatory for all users, or mandatory only to claim free balance / promo bonuses.
  - Immediate real-time sync with bot's `checkSubscription` middleware.

---

### 2.13 Module 12: Sales & Financial Timeseries Analytics (`stats.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 📊 Финансовая аналитика    [Период: 30 дней ▼]    [Экспорт в Excel 💾] │
├────────────────────────────────────────────────────────────────────────┤
│ Выручка (30д):    Чистая прибыль:     Средний чек:     Новых клиентов: │
│ $14,280.50 USDT   $4,120.00 USDT      $18.40 USDT      +342 чел.       │
├────────────────────────────────────────────────────────────────────────┤
│ Динамика выручки и прибыли (USDT):                                     │
│  $800│         ╭──╮                                                    │
│  $600│   ╭─────╯  ╰──╮                                                 │
│  $400│───╯           ╰─────╮                                           │
│  $200│                     ╰──────                                     │
│    $0└───────────────────────────────────────────────────────────────  │
│       01 Ноя   07 Ноя   14 Ноя   21 Ноя   28 Ноя                       │
├────────────────────────────────────────────────────────────────────────┤
│ Доли платежных систем:                 Топ категорий:                  │
│ • Bybit UID:    45%                    • AI Подписки:  55%             │
│ • Platega СБП:  35%                    • VPN Сервисы:  25%             │
│ • Crypto USDT:  15%                    • Аккаунты:     15%             │
│ • Карты прямые:  5%                    • Прочее:        5%             │
└────────────────────────────────────────────────────────────────────────┘
```

- **Timeseries Visualizations**:
  - High-performance interactive charts (implemented via Recharts / Chart.js).
  - Timeframe selector: `Сегодня`, `7 дней`, `30 дней`, `90 дней`, `Произвольный диапазон`.
  - Chart 1: Revenue vs Cost Price vs Net Profit stacked area chart.
  - Chart 2: Category sales volume donut breakdown.
  - Chart 3: Payment gateway utilization distribution.
  - Chart 4: Hourly purchase frequency heatmap.
- **Export Capabilities**:
  - One-click CSV and Excel export of complete financial transactions, order line items, and VAT/accounting ledgers.

---

### 2.14 Module 13: Mass Broadcasting & Catalog Bulk Pricing (`bulk.scene.js`)

- **Tab 1: Telegram Mass Broadcast Composer**:
  - Rich HTML message composer supporting bold, italic, code blocks, and spoiler tags.
  - Interactive inline keyboard constructor: Add URLs or WebApp launch buttons.
  - Target audience selector:
    - Все пользователи магазина.
    - Пользователи с покупками > 1.
    - Неактивные пользователи (нет активности > 30 дней).
    - Пользователи с положительным балансом.
  - Throttled queue dispatcher adhering to Telegram API rate limits (25 messages/second) with live progress bar showing: `Отправлено`, `Доставлено`, `Заблокировали бота`.
- **Tab 2: Catalog Bulk Pricing Tool**:
  - Filter target items by category or supplier.
  - Bulk adjustment operation:
    - Увеличить цену на X % или X USDT.
    - Уменьшить цену на X % или X USDT.
  - Cost-floor safety check: Automatically prevents setting prices below cost price (`price < costPrice`).
  - Preview comparison table before committing changes to MongoDB.

---

### 2.15 Module 14: Global System Settings & Maintenance Mode (`settings.scene.js`)

- **Maintenance Mode Switch**:
  - Master toggle switch activating maintenance mode.
  - Customizable customer-facing downtime announcement banner text.
  - When enabled, customer storefront and bot display maintenance screens while `/admin` remains accessible to superadmins.
- **Payment Gateway Credential Configuration**:
  - Dedicated configuration cards for Platega, Bybit UID, USDT TRC-20, USDT BEP-20, TON, and Direct Cards.
  - AES-256-GCM encrypted credential fields with "Показать / Скрыть" toggle.
  - Minimum and maximum top-up amount limits per method.
- **Dynamic Exchange Rate Engine**:
  - Rate source selector: `Bybit P2P (Автоматически)`, `ЦБ РФ + Спред`, `Фиксированный курс вручную`.
  - Merchant markup percentage offset (e.g. `+3.0%`).
  - Fallback rate safety floor (prevents under-pricing during exchange API outages).

---

### 2.16 Module 15: Live Chat Customer Support & Ticket Desk (`admin.scene.js`)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 💬 Поддержка клиентов    [3 активных тикета]                           │
├───────────────────────┬────────────────────────────────────────────────┤
│ 👤 @alex_buyer (2м)   │ Переписка с @alex_buyer (ID: 104928172)        │
│ "Не пришел ключ"      │ ────────────────────────────────────────────── │
│ 👤 @dmitry_v (15м)    │ [14:20] Клиент: Здравствуйте, оплатил подписку │
│ "Вопрос по оплате"    │ [14:21] Бот: Ваш заказ #ORD-84192 сформирован  │
│ 👤 @elena_k (1ч)      │ [14:22] Клиент: Но ключ в ЛК не отображается   │
│ "Спасибо, помогло"    │ ────────────────────────────────────────────── │
│                       │ Введите ответ клиенту в Telegram...            │
│                       │ [ Отправить в Telegram ] [ 📎 Прикрепить файл ]│
└───────────────────────┴────────────────────────────────────────────────┘
```

- **Two-Way Real-Time Messaging Relay**:
  - Incoming customer support requests from Telegram bot appear instantly in the web admin panel via SSE / WebSocket.
  - Operator responses typed in web admin are dispatched to the customer's Telegram chat via `bot.telegram.sendMessage`.
- **Operator Productivity Tools**:
  - Pre-defined response templates (Canned answers for activation guides, refund policies, FAQs).
  - Quick action shortcuts: "Перейти к заказу", "Проверить баланс", "Выдать компенсацию".
  - Ticket resolution lifecycle: `Новый`, `В работе`, `Решен`, `Закрыт`.

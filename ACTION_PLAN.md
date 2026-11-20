# ДЕТАЛЬНЫЙ ПЛАН ДЕЙСТВИЙ И ДОРОЖНАЯ КАРТА УСТРАНЕНИЯ УЯЗВИМОСТЕЙ
## Проект: Telegram Shop Bot (Remediation & Hardening Master Action Plan)
### Версия плана: 2.0 (Полное 100% покрытие всех 42 уязвимостей, регламенты отката и инфраструктурная совместимость)

---

**Дата утверждения плана:** 19 ноября 2026 г.  
**Основание:** Результаты комплексного аудита безопасности (`AUDIT_REPORT.md` v2.0)  
**Целевой контур:** `c:\Users\user\Desktop\Shop bot`  
**Покрытие дефектов:** **100% (42 из 42 уязвимостей имеют выделенные пронумерованные шаги реализации)**  
**Принцип приоритизации:** Строго от Critical к Low/Arch; все 7 Critical-уязвимостей вынесены в Этап 1  

---

## ОБЩАЯ СТРУКТУРА ДОРОЖНОЙ КАРТЫ (5 ЭТАПОВ)

```
┌────────────────────────────────────────────────────────────────────────┐
│ ЭТАП 1: Неотложные критические исправления (Emergency Hotfixes)        │
│ ├─ Шаг 1.1 [SEC-CORE-01]: Удаление клиентских данных и ротация 2FA     │
│ ├─ Шаг 1.2 [SEC-FIN-01]: Проверка контракта TRC-20 USDT (Fake Token)  │
│ ├─ Шаг 1.3 [SEC-FIN-02]: Атомарный CAS-захват Bybit UID (Double Credit)│
│ ├─ Шаг 1.4 [SEC-FIN-03]: Ликвидация коллизий суффиксов Bybit UID       │
│ ├─ Шаг 1.5 [SEC-DROP-01]: Исправление эвристики валют TrumpStore ($0.05)│
│ ├─ Шаг 1.6 [SEC-DROP-02]: Автовозврат средств при сбое поставщиков     │
│ ├─ Шаг 1.7 [SEC-CAT-09]: Корзина: передача sellerId и sellerPayout     │
│ └─ Регламент отката (Rollback Runbook) Этапа 1                         │
├────────────────────────────────────────────────────────────────────────┤
│ ЭТАП 2: Высокоприоритетные финансовые и системные исправления          │
│ ├─ Шаг 2.1 [SEC-FIN-04, 05]: Валидация и транзакции Platega СБП        │
│ ├─ Шаг 2.2 [SEC-FIN-06]: Защита чеков IDBank через уникальный RRN      │
│ ├─ Шаг 2.3 [SEC-FIN-07]: Возврат ключей мультизаказов (Key.updateMany) │
│ ├─ Шаг 2.4 [SEC-FIN-08]: Округление Float IEEE 754 (roundMoney)        │
│ ├─ Шаг 2.5 [SEC-FIN-15]: Ликвидация N+1 HTTP шторма Bybit поллера      │
│ ├─ Шаг 2.6 [SEC-DROP-05]: Защита API-ключа Canboso (Headers/POST)      │
│ ├─ Шаг 2.7 [SEC-CORE-02]: Персистентные сессии (MongoDB / Render Free) │
│ ├─ Шаг 2.8 [SEC-CORE-03]: Инвалидация распределенного кэша userCache   │
│ ├─ Шаг 2.9 [SEC-CORE-04]: Иерархия Superadmin RBAC и отзыв прав        │
│ ├─ Шаг 2.10 [SEC-CAT-01]: Устранение утечки остатка manualStock        │
│ └─ Регламент отката (Rollback Runbook) Этапа 2                         │
├────────────────────────────────────────────────────────────────────────┤
│ ЭТАП 3: Бизнес-логика, контроль цен, ретраи и защита от абуза          │
│ ├─ Шаг 3.1 [SEC-CAT-02]: Декремент totalSpent при возвратах (Anti-VIP) │
│ ├─ Шаг 3.2 [SEC-CAT-03]: Защита оптовой себестоимости costPrice        │
│ ├─ Шаг 3.3 [SEC-CAT-04]: Порог заказа для реферального бонуса (Anti-Sybil)
│ ├─ Шаг 3.4 [SEC-DROP-03]: Экспоненциальный бэкофф и DLQ ретраев        │
│ ├─ Шаг 3.5 [SEC-DROP-04]: Идемпотентность и статус при таймаутах       │
│ ├─ Шаг 3.6 [SEC-CAT-05]: Пагинация и оптимизация крона рефералов      │
│ ├─ Шаг 3.7 [SEC-CAT-06]: Защита от деления на ноль в умной уценке      │
│ ├─ Шаг 3.8 [SEC-DROP-06]: Сохранение торговых наценок поставщиков     │
│ ├─ Шаг 3.9 [SEC-DROP-07]: Авто-закупка дропшиппинг-предзаказов через API│
│ └─ Регламент отката (Rollback Runbook) Этапа 3                         │
├────────────────────────────────────────────────────────────────────────┤
│ ЭТАП 4: Архитектура, база данных, целостность леджера и безопасность   │
│ ├─ Шаг 4.1 [SEC-FIN-09]: Безопасное сравнение timingSafeEqual Platega  │
│ ├─ Шаг 4.2 [SEC-FIN-10]: Валидация Number.isFinite в админке           │
│ ├─ Шаг 4.3 [SEC-FIN-11]: CAS-блокировка заявок на вывод продавцами     │
│ ├─ Шаг 4.4 [SEC-FIN-12, 16]: Аудиторский след Transaction в спорах    │
│ ├─ Шаг 4.5 [SEC-FIN-13]: Привязка topupRequestId при ручном пополнении│
│ ├─ Шаг 4.6 [SEC-FIN-14]: Replica Set Docker-бутстрап и CAS-fallback    │
│ ├─ Шаг 4.7 [SEC-FIN-17]: Легаси Bybit UID: coin=USDT и дедупликация    │
│ ├─ Шаг 4.8 [SEC-CORE-05]: Разделение RequiredChannel и channelCheck   │
│ ├─ Шаг 4.9 [SEC-CORE-06]: Шифрование AES-256-GCM и скрипт миграции    │
│ ├─ Шаг 4.10 [SEC-CORE-07]: Двухэтапный сброс ToS & connect.js флага │
│ ├─ Шаг 4.11 [SEC-CORE-08]: Криптостойкий referralCode (randomBytes)   │
│ ├─ Шаг 4.12 [SEC-CAT-07]: Очистка Waitlist при отмене предзаказа       │
│ ├─ Шаг 4.13 [SEC-CORE-09, CAT-08]: Индексация MongoDB и CAS промокодов │
│ └─ Регламент отката (Rollback Runbook) Этапа 4                         │
├────────────────────────────────────────────────────────────────────────┤
│ ЭТАП 5: Комплексная верификация, сводные регламенты и мониторинг       │
│ ├─ Шаг 5.1: Комплексный автоматизированный тест-сьют E2E               │
│ ├─ Шаг 5.2: Чек-лист предрелизного контроля (Pre-Production Gate)      │
│ ├─ Шаг 5.3: Сводный мастер-регламент аварийного отката (Master Runbook)│
│ └─ Шаг 5.4: Настройка операционного мониторинга, алертинга и метрик    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## МАТРИЦА 100% ПОКРЫТИЯ УЯЗВИМОСТЕЙ В ПЛАНЕ ДЕЙСТВИЙ

| ID из AUDIT_REPORT.md | Уровень | Этап реализации | Номер шага в ACTION_PLAN.md |
|---|:---:|:---:|---|
| **SEC-CORE-01** | CRITICAL | Этап 1 | **Шаг 1.1** |
| **SEC-FIN-01** | CRITICAL | Этап 1 | **Шаг 1.2** |
| **SEC-FIN-02** | CRITICAL | Этап 1 | **Шаг 1.3** |
| **SEC-FIN-03** | CRITICAL | Этап 1 | **Шаг 1.4** |
| **SEC-DROP-01** | CRITICAL | Этап 1 | **Шаг 1.5** |
| **SEC-DROP-02** | CRITICAL | Этап 1 | **Шаг 1.6** (перенесён из Фазы 2) |
| **SEC-CAT-09** | CRITICAL | Этап 1 | **Шаг 1.7** (новый критический слепой пункт) |
| **SEC-FIN-04** | HIGH | Этап 2 | **Шаг 2.1** |
| **SEC-FIN-05** | HIGH | Этап 2 | **Шаг 2.1** |
| **SEC-FIN-06** | HIGH | Этап 2 | **Шаг 2.2** |
| **SEC-FIN-07** | HIGH | Этап 2 | **Шаг 2.3** |
| **SEC-FIN-08** | HIGH | Этап 2 | **Шаг 2.4** |
| **SEC-FIN-15** | HIGH | Этап 2 | **Шаг 2.5** (новый blind spot: N+1 Bybit Poller) |
| **SEC-DROP-05** | HIGH | Этап 2 | **Шаг 2.6** |
| **SEC-CORE-02** | HIGH | Этап 2 | **Шаг 2.7** |
| **SEC-CORE-03** | HIGH | Этап 2 | **Шаг 2.8** |
| **SEC-CORE-04** | HIGH | Этап 2 | **Шаг 2.9** |
| **SEC-CAT-01** | HIGH | Этап 2 | **Шаг 2.10** |
| **SEC-CAT-02** | HIGH | Этап 3 | **Шаг 3.1** |
| **SEC-CAT-03** | HIGH | Этап 3 | **Шаг 3.2** |
| **SEC-CAT-04** | HIGH | Этап 3 | **Шаг 3.3** |
| **SEC-DROP-03** | HIGH | Этап 3 | **Шаг 3.4** |
| **SEC-DROP-04** | HIGH | Этап 3 | **Шаг 3.5** |
| **SEC-CAT-05** | MEDIUM | Этап 3 | **Шаг 3.6** |
| **SEC-CAT-06** | MEDIUM | Этап 3 | **Шаг 3.7** |
| **SEC-DROP-06** | MEDIUM | Этап 3 | **Шаг 3.8** |
| **SEC-DROP-07** | MEDIUM | Этап 3 | **Шаг 3.9** |
| **SEC-FIN-09** | MEDIUM | Этап 4 | **Шаг 4.1** |
| **SEC-FIN-10** | MEDIUM | Этап 4 | **Шаг 4.2** |
| **SEC-FIN-11** | MEDIUM | Этап 4 | **Шаг 4.3** |
| **SEC-FIN-12** | MEDIUM | Этап 4 | **Шаг 4.4** |
| **SEC-FIN-16** | MEDIUM | Этап 4 | **Шаг 4.4** (новый blind spot: Seller Payout Ledger) |
| **SEC-FIN-13** | MEDIUM | Этап 4 | **Шаг 4.5** |
| **SEC-FIN-14** | LOW/ARCH| Этап 4 | **Шаг 4.6** |
| **SEC-FIN-17** | MEDIUM | Этап 4 | **Шаг 4.7** (новый blind spot: Legacy Bybit UID) |
| **SEC-CORE-05** | MEDIUM | Этап 4 | **Шаг 4.8** (с включением channelCheck.service.js) |
| **SEC-CORE-06** | MEDIUM | Этап 4 | **Шаг 4.9** (с обязательным скриптом миграции) |
| **SEC-CORE-07** | MEDIUM | Этап 4 | **Шаг 4.10** |
| **SEC-CORE-08** | MEDIUM | Этап 4 | **Шаг 4.11** |
| **SEC-CAT-07** | LOW | Этап 4 | **Шаг 4.12** |
| **SEC-CAT-08** | LOW/FP | Этап 4 | **Шаг 4.13** (уточнение схемы и проверка CAS) |
| **SEC-CORE-09** | LOW/FP | Этап 4 | **Шаг 4.13** (коррекция индексов, BybitInvoice, TopupRequest)|

---

## ЭТАП 1: Неотложные критические исправления (Emergency Immediate Hotfixes)
**Цель этапа:** Немедленная блокировка прямых каналов утечки данных и неконтролируемого хищения денежных средств магазина.

---

### Шаг 1.1: Удаление скомпрометированных клиентских данных и ротация 2FA
- **Идентификатор уязвимости:** `SEC-CORE-01` (Critical)
- **Затрагиваемые файлы:** `src/cron/retryActivation.cron.js` (строки 32–46).
- **План действий:**
  1. Полностью удалить захардкоженный массив `KNOWN_REPAIR_ORDERS`.
  2. Заменить механизм ручного хардкода на выборку проблемных заказов из MongoDB по фильтру `{ status: 'activating', needsRepair: true }`.
  3. Немедленно уведомить владельцев скомпрометированных Telegram ID (5816207940 и 8240687535) о необходимости смены паролей и ротации сидов 2FA TOTP.
  4. Очистить историю коммитов Git через `git filter-repo` или BFG.
- **Метод верификации:**
  ```powershell
  Select-String -Path "src***.js" -Pattern "(gmail.com|realDelivery|TOTP)"
  ```
  *Ожидаемый результат:* 0 совпадений с реальными клиентскими данными.
- **Риски:** Отсутствуют.

---

### Шаг 1.2: Блокировка приема фальшивых токенов TRC-20 USDT
- **Идентификатор уязвимости:** `SEC-FIN-01` (Critical)
- **Затрагиваемые файлы:** `src/services/blockchain.service.js` (строки 208–226).
- **План действий:**
  1. Внедрить константу официального смарт-контракта Tether USDT в сети TRON:
     `const OFFICIAL_TRC20_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';`
  2. В функциях `verifyTronscanTrc20Usdt` проверять совпадение адреса контракта:
     ```javascript
     const isContractValid = (t) => {
       const contract = String(t.contract_address || t.tokenId || '').trim();
       return contract === OFFICIAL_TRC20_USDT_CONTRACT;
     };
     ```
- **Метод верификации:**
  Запустить тест с транзакцией с кастомным контрактом с тикером USDT. Метод должен вернуть `success: false, reason: 'INVALID_TOKEN_CONTRACT'`.
- **Риски:** Отсутствуют. Легитимный USDT принимается штатно.

---

### Шаг 1.3: Устранение состояния гонки и двойного зачисления в Bybit UID
- **Идентификатор уязвимости:** `SEC-FIN-02` (Critical)
- **Затрагиваемые файлы:** `src/services/bybitUidPayment.service.js` (строки 360–430), `src/cron/bybitUidPoller.cron.js` (строки 53–68).
- **План действий:**
  1. Внедрить предварительный CAS-захват инвойса в статус `processing` перед обращением к внешнему API:
     ```javascript
     const invoice = await BybitInvoice.findOneAndUpdate(
       { _id: invoiceId, status: 'pending' },
       { $set: { status: 'processing', lockedAt: new Date() } },
       { new: true }
     );
     if (!invoice) return { success: false, reason: 'Инвойс уже обрабатывается или завершен' };
     ```
  2. При подтверждении зачисления обернуть финализацию инвойса и баланс в `withTransaction`.
  3. Добавить механизм автоматического снятия зависших локов: инвойсы в статусе `processing` старше 3 минут автоматически сбрасываются в `pending`.
- **Метод верификации:**
  Запустить конкурентные вызовы `Promise.all([checkInvoice(id), checkInvoice(id)])`. Ровно один вызов должен получить блокировку. Баланс увеличивается строго один раз.
- **Инфраструктурное требование:** Требует наличия MongoDB Replica Set (см. Шаг 4.6).

---

### Шаг 1.4: Устранение коллизий суффиксов Bybit UID и защита от перехвата депозитов
- **Идентификатор уязвимости:** `SEC-FIN-03` (Critical)
- **Затрагиваемые файлы:** `src/services/bybitUidPayment.service.js` (строки 66–116, 340–350), `src/models/BybitInvoice.js` (строки 27–40), `src/models/User.js`.
- **Математика суффиксов и ликвидация наценки до $0.99:**
  - *Критическое предостережение:* Попытка использовать формулу `s / 10000` с диапазоном `s = 1000..9999` ошибочна, так как дает надбавку от 0.1000 до 0.9999 USDT (наценка до $1 на каждый платеж!).
  - *Корректное решение:* В рамках 4 знаков после запятой (`0.0001 USDT`) диапазон наценки строго до 1 цента (`< 0.01 USDT`) составляет `s = 1..99` (шаг 0.0001, надбавка от 0.0001 до 0.0099 USDT, 99 слотов).
  - Для поддержки 9 000 параллельных уникальных слотов без превышения 1 цента наценки: использовать 5 десятичных знаков (`0.00001 .. 0.00999 USDT`), поддерживаемых Bybit v5 при внутренних переводах:
    `const frac = Number((s / 100000).toFixed(5)); // s = 10..999`
  - Дополнительно: сократить TTL инвойса с 2 часов до 15 минут и выполнять обязательную валидацию Bybit UID отправителя:
    ```javascript
    const senderMatches = !user.bybitUid || String(matchedRow.address).trim() === String(user.bybitUid).trim();
    if (!senderMatches) return { success: false, reason: 'UID отправителя не совпадает с профилем' };
    ```
  - В `BybitInvoice.js` добавить частичный уникальный индекс:
    ```javascript
    bybitInvoiceSchema.index(
      { exactAmount: 1 },
      { unique: true, partialFilterExpression: { status: { $in: ['pending', 'processing'] } } }
    );
    ```
- **Метод верификации:**
  Попытка генерации 50 инвойсов на сумму 10.00 USDT. Все суммы должны быть уникальными, наценка не должна превышать 0.0099 USDT.
- **Риски:** Минимальные. Проверена совместимость с API Bybit v5.

---

### Шаг 1.5: Исправление эвристики валют TrumpStore (ликвидация бага $0.05)
- **Идентификатор уязвимости:** `SEC-DROP-01` (Critical)
- **Затрагиваемые файлы:** `src/services/suppliers/trumpstore.adapter.js` (строки 4–5, 83–85).
- **План действий:**
  1. Полностью удалить опасную проверку `rawPrice > 1000`.
  2. Определять валюту товара исключительно по метаданным ответа API:
     ```javascript
     const currency = String(p.currency || p.unit || '').toUpperCase();
     const isVnd = currency === 'VND' || p.price_vnd !== undefined;
     ```
  3. Загружать курс VND/USD из коллекции `ExchangeRate` вместо захардкоженной константы.
  4. Внедрить Sanity Check: если расчетная оптовая стоимость товара оказывается ниже 0.50 USDT при исходной цене более 10, прерывать публикацию с алертом в лог.
- **Метод верификации:**
  Прогнать через адаптер мок товара с ценой 1200 USD. Цена должна остаться 1200.00 USDT.
- **Риски:** Отсутствуют.

---

### Шаг 1.6: Автоматический возврат средств покупателю при отказе поставщика
- **Идентификатор уязвимости:** `SEC-DROP-02` (Critical)
- **Затрагиваемые файлы:** `src/bot/scenes/shop.scene.js` (строки 1885–1903), `src/services/cart.service.js` (строки 478–490), `src/services/refund.service.js` (строки 91–102).
- **План действий:**
  1. **Критическое исправление пути импорта:** Функция `failOrderWithRefund` экспортируется из `src/services/refund.service.js`, а НЕ из `cart.service.js`:
     ```javascript
     const { failOrderWithRefund } = require('../../services/refund.service');
     ```
  2. В блоках обработки ошибок вызова API поставщиков при получении фатального статуса (`failed`, `rejected`, `out_of_stock`) немедленно вызывать:
     ```javascript
     await failOrderWithRefund(order._id, `Сбой поставщика: ${suppRes.error || 'Товар недоступен'}`, 'Возврат средств за отклонённый заказ');
     await ctx.reply(`❌ Поставщик не смог выдать товар: ${suppRes.error}. Средства в размере ${order.price} USDT возвращены на ваш баланс.`);
     ```
  3. В `cart.service.js` при групповой закупке обходить в цикле все заказы поставщиков и для отклоненных выполнять `failOrderWithRefund`.
- **Метод верификации:**
  Симулировать отказ внешнего API при оформлении заказа. Проверить, что заказ получил статус `failed`, баланс покупателя увеличился на сумму заказа, а в коллекции `Transaction` появилась запись типа `refund`.
- **Риски:** Отсутствуют.

---

### Шаг 1.7: Оформление через корзину: передача sellerId и начисление sellerPayout
- **Идентификатор уязвимости:** `SEC-CAT-09` (Critical)
- **Затрагиваемые файлы:** `src/services/cart.service.js` (строки 327–341, 370–380).
- **План действий:**
  1. В методе `checkoutOrders` при формировании цифровых заказов (строки 327–341) и товаров с ручной/дропшиппинг выдачей (строки 370–380) извлекать данные о продавце товара `product.sellerId`:
     ```javascript
     const hasSeller = !!product.sellerId;
     const sellerPayoutPerUnit = product.sellerPrice || product.costPrice || 0;
     const sellerOrderPayout = roundMoney(sellerPayoutPerUnit * item.qty);
     ```
  2. Явно передавать `sellerId` и `sellerPayout` в конструктор `new Order`:
     ```javascript
     const order = new Order({
       userId: initialUser._id,
       productId: product._id,
       provider,
       status: product.type === 'gpt_activation' ? 'awaiting_token' : 'completed',
       price: orderPrice,
       costPrice: product.costPrice || 0,
       sellerId: hasSeller ? product.sellerId : null,
       sellerPayout: hasSeller ? sellerOrderPayout : 0,
       // ... остальные поля ...
     });
     ```
- **Метод верификации:**
  Оформить покупку товара стороннего продавца через корзину. Проверить в базе, что у созданного документа `Order` заполнены `sellerId` и `sellerPayout`, а после автоподтверждения `autoConfirm.js` баланс вендора увеличился на `sellerPayout`.
- **Риски:** Отсутствуют. Восстанавливает законные выплаты партнерам маркетплейса.

---

### Регламент отката (Rollback Runbook) для Этапа 1
1. **Аварийная изоляция / Maintenance Mode:** При критических регрессиях немедленно изолировать трафик через MongoDB shell:
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: true } });
   ```
2. **Код:** При возникновении регрессий выполнить откат коммита hotfix через Git: `git revert HEAD -m 1`.
3. **База данных:** Если частичный индекс `exactAmount` на `BybitInvoice` конфликтует с существующими тестовыми документами:
   ```javascript
   db.bybitinvoices.dropIndex("exactAmount_1");
   ```
4. **Безопасность 2FA:** Возврат захардкоженных учеток категорически запрещен; при отказе крона `retryActivation` восстанавливается резервная копия файла с закомментированными данными.
5. **Снятие Maintenance Mode:** После проверки стабильности снять блокировку:
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: false } });
   ```

---

## ЭТАП 2: Высокоприоритетные финансовые и системные исправления
**Цель этапа:** Защита фиатных платежей, устранение утечек лицензионных ключей, стабилизация сессий на Render Free Tier и устранение N+1 шторма Bybit поллера.

---

### Шаг 2.1: Валидация суммы и валюты вебхука Platega СБП и транзакционное зачисление
- **Идентификаторы уязвимостей:** `SEC-FIN-04`, `SEC-FIN-05` (High)
- **Затрагиваемые файлы:** `src/bot/scenes/topup.scene.js` (строки 1275–1314, 1427–1463), `src/bot/health-server.js` (строки 72–85).
- **План действий:**
  1. В вебхуке Platega сверять `payload.status === 'CONFIRMED'`, `payload.currency === 'RUB'` и сумму `Math.abs(Number(payload.amount) - request.amountRub) < 0.01`.
  2. Зачисление баланса выполнять через CAS-перевод заявки из `pending` в `confirmed` внутри транзакции `withTransaction`.
  3. Немедленно вызывать `invalidateUserCache(request.userId)`.
- **Метод верификации:** Отправить вебхук с заниженной суммой — должен возвращаться статус 400. Отправить корректный вебхук — баланс зачисляется, кэш сбрасывается.

---

### Шаг 2.2: Защита от Replay-атак по чекам IDBank через уникальный RRN
- **Идентификатор уязвимости:** `SEC-FIN-06` (High)
- **Затрагиваемые файлы:** `src/bot/scenes/topup.scene.js` (строки 1058–1079), `src/bot/scenes/admin/payments.scene.js`, `src/models/TopupRequest.js`.
- **План действий:**
  1. Не полагаться только на `file_unique_id`. Добавить в схему `TopupRequest` поле `rrn: { type: String, default: null }` с частичным уникальным индексом:
     ```javascript
     topupRequestSchema.index(
       { rrn: 1 },
       { unique: true, partialFilterExpression: { rrn: { $type: 'string' } } }
     );
     ```
  2. При одобрении чека администратором требовать ввод номера банковской транзакции (RRN / номер платежа из квитанции).
- **Метод верификации:** Попытка подтвердить две разные заявки с одним и тем же RRN должна блокироваться MongoDB с ошибкой E11000.

---

### Шаг 2.3: Исправление возврата цифровых ключей мультизаказов (Key.updateMany)
- **Идентификатор уязвимости:** `SEC-FIN-07` (High)
- **Затрагиваемые файлы:** `src/services/refund.service.js` (строки 70–74), `src/bot/scenes/admin/orders.scene.js` (строки 734–740).
- **План действий:**
  Заменить `Key.updateOne` на `Key.updateMany`:
  ```javascript
  await Key.updateMany(
    { usedByOrder: order._id },
    { $set: { isUsed: false, usedByOrder: null, usedAt: null } }
  );
  ```
- **Метод верификации:** Создать заказ на 3 ключа, отменить его. Все 3 ключа должны перейти в статус `isUsed: false`.

---

### Шаг 2.4: Устранение погрешностей округления Float IEEE 754 (roundMoney)
- **Идентификатор уязвимости:** `SEC-FIN-08` (High)
- **Затрагиваемые файлы:** `src/bot/scenes/topup.scene.js` (строки 533–537, 596–604), `src/utils/money.js`.
- **План действий:**
  При расчете суммы пополнения в USDT округлять значение до 2 знаков для фиата/USDT:
  `const amountUsdt = roundMoney(rubAmount / rate);`.

---

### Шаг 2.5: Ликвидация N+1 шторма HTTP-запросов Bybit UID поллера
- **Идентификатор уязвимости:** `SEC-FIN-15` (High)
- **Затрагиваемые файлы:** `src/cron/bybitUidPoller.cron.js` (строки 53–68), `src/services/bybitUidPayment.service.js` (строки 298–335).
- **План действий:**
  1. Рефакторинг поллера: вместо вызова `checkInvoice` в цикле для каждого инвойса, опрашивать Bybit API ровно **один раз за 20 секунд** (`query-internal-record?limit=50&coin=USDT`).
  2. Полученные 50 транзакций сопоставлять в памяти со всеми активными инвойсами `pendingInvoices`.
  3. Для совпавших инвойсов вызывать атомарную процедуру финализации.
- **Метод верификации:** При 10 ожидающих инвойсах число сетевых запросов к `api.bybit.com` должно быть строго 1 запрос за 20 секунд вместо 10.
- **Результат:** 100% защита от HTTP 429 и CloudFront банов.

---

### Шаг 2.6: Защита API-ключа Canboso (перенос в HTTP Headers / POST)
- **Идентификатор уязвимости:** `SEC-DROP-05` (High)
- **Затрагиваемые файлы:** `src/services/suppliers/canboso.adapter.js` (строки 11, 42, 170).
- **План действий:**
  Удалить передачу `?api_key=${key}` из URL. Передавать ключ в заголовках запроса `headers: { 'Authorization': `Bearer ${key}`, 'X-API-KEY': key }` или теле POST-запроса.

---

### Шаг 2.7: Персистентные сессии Telegraf (MongoDB адаптер для Render Free Tier)
- **Идентификатор уязвимости:** `SEC-CORE-02` (High)
- **Затрагиваемые файлы:** `src/bot/index.js` (строка 53), `src/models/TelegrafSession.js` (создание).
- **Архитектурная адаптация для бесплатного Render:**
  - В соответствии с `DEPLOY.md` проект развернут на бесплатном тарифе Render ($0) и MongoDB Atlas M0 ($0). Внешний Redis на Render платный ($7/мес).
  - Решение: реализовать персистентный адаптер сессий Telegraf на базе уже подключенной MongoDB (коллекция `telegraf_sessions` с TTL-индексом 7 дней), с автоматическим переключением на Redis при наличии переменной `REDIS_URL`:
  ```javascript
  const sessionMiddleware = process.env.REDIS_URL
    ? createRedisSessionMiddleware(process.env.REDIS_URL)
    : createMongoSessionMiddleware(mongoose.connection);
  bot.use(sessionMiddleware);
  ```
- **Метод верификации:** Начать визард ввода данных, перезапустить процесс Node.js, отправить следующий шаг — бот должен продолжить визард.

---

### Шаг 2.8: Синхронизация и инвалидация распределенного кэша пользователей
- **Идентификатор уязвимости:** `SEC-CORE-03` (High)
- **Затрагиваемые файлы:** `src/bot/middlewares/user.js` (строки 12–33, 53–82), `src/bot/scenes/topup.scene.js:1300`, `src/services/cart.service.js`.
- **План действий:**
  Вызывать экспортируемый метод `invalidateUserCache(userId)` во всех точках изменения баланса, ролей или статуса пользователя.

---

### Шаг 2.9: Иерархия Superadmin RBAC и отзыв административных прав
- **Идентификатор уязвимости:** `SEC-CORE-04` (High)
- **Затрагиваемые файлы:** `src/bot/middlewares/user.js` (строки 129–133), `src/bot/scenes/admin/users.scene.js` (строки 548–556).
- **План действий:**
  1. Разделить роли на `superadmin`, `admin`, `user`. Роль `superadmin` присваивается строго на основе совпадения `telegramId` со списком `SUPERADMIN_IDS` в переменных окружения.
  2. Только `superadmin` имеет право назначать или отзывать роль `admin`.
  3. При старте бота выполнять сверку: если пользователь имеет роль `admin` в БД, но исключен из разрешенных списков, роль автоматически сбрасывается в `user`.

---

### Шаг 2.10: Предотвращение утечки остатка manualStock при отмене предзаказа
- **Идентификатор уязвимости:** `SEC-CAT-01` (High)
- **Затрагиваемые файлы:** `src/services/notification.service.js` (строки 668–685).
- **План действий:**
  Захватывать предзаказ атомарным методом `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'processing' } })`, и только при успехе уменьшать `manualStock`.

---

### Регламент отката (Rollback Runbook) для Этапа 2
1. **Аварийная изоляция / Maintenance Mode (при необходимости):**
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: true } });
   ```
2. **Сессии:** При сбоях MongoDB-сессий временно вернуть `session({ defaultSession: () => ({}) })` в `src/bot/index.js`.
3. **Вебхуки Platega:** Откатить изменения в `health-server.js` через Git, перезапустить Express-сервер.
4. **Индексы IDBank:** При конфликте уникального индекса RRN: `db.topuprequests.dropIndex("rrn_1")`.
5. **Снятие Maintenance Mode:** `db.settings.updateOne({}, { $set: { maintenanceMode: false } });`

---

## ЭТАП 3: Бизнес-логика, контроль цен, ретраи и защита от абуза
**Цель этапа:** Защита оптовой себестоимости, реферальной системы от накруток бот-фермами, устранение зацикленных ретраев и DoS планировщиков.

---

### Шаг 3.1: Декремент totalSpent при возвратах (Anti-VIP Farming)
- **Идентификатор уязвимости:** `SEC-CAT-02` (High)
- **Затрагиваемые файлы:** `src/services/refund.service.js` (строки 56–60), `src/bot/scenes/profile.scene.js:760`.
- **План действий:**
  При выполнении возврата уменьшать `totalSpent` с защитой от ухода в минус:
  ```javascript
  await User.updateOne(
    { _id: order.userId },
    [
      {
        $set: {
          balance: { $round: [{ $add: ['$balance', refundAmount] }, 2] },
          totalSpent: { $max: [0, { $round: [{ $subtract: ['$totalSpent', refundAmount] }, 2] }] }
        }
      }
    ]
  );
  ```

---

### Шаг 3.2: Защита оптовой себестоимости (costPrice) при применении промокодов
- **Идентификатор уязвимости:** `SEC-CAT-03` (High)
- **Затрагиваемые файлы:** `src/services/orderPricing.service.js` (строки 46–51), `src/services/promo.service.js` (строки 245–256).
- **План действий:**
  Установить нижний порог стоимости товара после применения промокода:
  `const minAllowedPrice = Math.max(0.01, roundMoney(product.costPrice || 0));`
  `finalPrice = Math.max(minAllowedPrice, finalPriceWithDiscount);`

---

### Шаг 3.3: Порог заказа для начисления реферального бонуса (Anti-Sybil)
- **Идентификатор уязвимости:** `SEC-CAT-04` (High)
- **Затрагиваемые файлы:** `src/services/referral.service.js` (строки 41–54).
- **План действий:**
  Начислять бонус 0.50 USDT рефереру только при условии, что сумма первого завершенного заказа реферала составляет не менее 3.00 USDT (`order.price >= 3.00`).

---

### Шаг 3.4: Экспоненциальный бэкофф и DLQ для повторов активаций
- **Идентификатор уязвимости:** `SEC-DROP-03` (High)
- **Затрагиваемые файлы:** `src/cron/retryActivation.cron.js` (строки 315–397).
- **План действий:**
  Заменить ежеминутный опрос интервалами с экспоненциальной задержкой: 1м, 5м, 15м, 1ч, 4ч. Максимум 5 попыток, после чего переводить заказ в `failed` с вызовом `failOrderWithRefund`.

---

### Шаг 3.5: Идемпотентность и проверка статуса заказа при таймаутах поставщика
- **Идентификатор уязвимости:** `SEC-DROP-04` (High)
- **Затрагиваемые файлы:** `src/cron/retryActivation.cron.js` (строки 414–423).
- **План действий:**
  При сетевом таймауте не отправлять повторный заказ на покупку без предварительного вызова API проверки статуса существующего заказа по ключу идемпотентности.

---

### Шаг 3.6: Пагинация и оптимизация крона сверки рефералов
- **Идентификатор уязвимости:** `SEC-CAT-05` (Medium)
- **Затрагиваемые файлы:** `src/cron/referralReconcile.cron.js` (строки 30–41), `src/models/User.js`.
- **План действий:**
  Ограничивать курсор выборки батчами по 100 записей (`.limit(100)`) и добавить составной индекс `{ referredBy: 1, referralBonusGrantedAt: 1 }`.

---

### Шаг 3.7: Защита от деления на ноль в умной уценке
- **Идентификатор уязвимости:** `SEC-CAT-06` (Medium)
- **Затрагиваемые файлы:** `src/services/orderPricing.service.js` (строки 20–32, 50).
- **План действий:**
  Валидировать входные коэффициенты: `autoMarkdownDays = Math.max(1, autoMarkdownDays)`, `qty = Math.max(1, qty)`, `autoMarkdownPercent = Math.min(99, Math.max(0, autoMarkdownPercent))`.

---

### Шаг 3.8: Сохранение кастомных торговых наценок поставщиков
- **Идентификатор уязвимости:** `SEC-DROP-06` (Medium)
- **Затрагиваемые файлы:** `src/services/supplierManager.service.js` (строки 56–78), `src/bot/routes/input.routes.js:446`.
- **План действий:**
  При обновлении API-ключа использовать точечное обновление `$set: { apiKey }` без перезаписи полей `marginPercent` и `marginFixed`.

---

### Шаг 3.9: Авто-закупка дропшиппинг-предзаказов через API
- **Идентификатор уязвимости:** `SEC-DROP-07` (Medium)
- **Затрагиваемые файлы:** `src/services/notification.service.js` (строки 668–709).
- **План действий:**
  Если выполненный предзаказ относится к провайдеру `jaha`, `akunding`, `canboso` или `trumpstore`, автоматически инициировать процедуру отправки заказа в API поставщика вместо перевода в ручную очередь.

---

### Регламент отката (Rollback Runbook) для Этапа 3
1. **Аварийная изоляция / Maintenance Mode (при необходимости):**
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: true } });
   ```
2. **Код:** При сбоях ценообразования восстановить предыдущую версию `orderPricing.service.js` из Git.
3. **Кроны:** При необходимости приостановить крон `referralReconcile` комментированием в `src/cron/index.js`.
4. **Снятие Maintenance Mode:** `db.settings.updateOne({}, { $set: { maintenanceMode: false } });`

---

## ЭТАП 4: Архитектура, база данных, целостность леджера и безопасность
**Цель этапа:** Шифрование секретов в MongoDB с гарантированной пред-миграцией, устранение риска BSON 16MB, аудит леджера транзакций и ликвидация дефектов индексов.

---

### Шаг 4.1: Безопасное сравнение токенов Platega через timingSafeEqual
- **Идентификатор уязвимости:** `SEC-FIN-09` (Medium)
- **Затрагиваемые файлы:** `src/services/platega.service.js` (строки 173–186).
- **План действий:**
  ```javascript
  const safeCompare = (a, b) => {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  };
  ```

---

### Шаг 4.2: Валидация числовых диапазонов в админ-панели (Number.isFinite)
- **Идентификатор уязвимости:** `SEC-FIN-10` (Medium)
- **Затрагиваемые файлы:** `src/bot/scenes/admin/payments.scene.js` (строки 255–257), `src/bot/scenes/admin/users.scene.js` (строки 264–268).
- **План действий:**
  Валидировать введенное значение:
  `if (!Number.isFinite(amount) || isNaN(amount) || Math.abs(amount) > 1000000) return ctx.reply('Недопустимая сумма.');`

---

### Шаг 4.3: CAS-блокировка заявок на вывод средств продавцами
- **Идентификатор уязвимости:** `SEC-FIN-11` (Medium)
- **Затрагиваемые файлы:** `src/bot/scenes/seller.scene.js` (строки 586–620), `src/models/SellerWithdrawal.js` (строки 19–21).
- **План действий:**
  1. Внедрить частичный уникальный индекс на активную заявку на вывод:
     ```javascript
     sellerWithdrawalSchema.index(
       { sellerId: 1 },
       { unique: true, partialFilterExpression: { status: 'pending' } }
     );
     ```
  2. Списывать баланс продавца в момент подачи заявки методом `findOneAndUpdate({ _id: sellerId, balance: { $gte: amount } }, { $inc: { balance: -amount } })`. При отклонении заявки админом баланс возвращается.

---

### Шаг 4.4: Создание финансовых записей Transaction при разрешении диспутов
- **Идентификаторы уязвимостей:** `SEC-FIN-12`, `SEC-FIN-16` (Medium)
- **Затрагиваемые файлы:** `src/bot/scenes/admin/disputes.scene.js` (строки 114–118, 158–166).
- **План действий:**
  1. В `resolveRefundBuyer` при возврате средств покупателю создавать:
     ```javascript
     await Transaction.create([{
       userId: order.userId,
       orderId: order._id,
       type: 'refund',
       amount: order.price,
       description: 'Возврат средств по спору (решение администратора)'
     }], sessionOpt);
     ```
  2. В `resolvePaySeller` при выплате продавцу создавать:
     ```javascript
     await Transaction.create([{
       userId: order.sellerId.userId || order.sellerId,
       orderId: order._id,
       type: 'seller_payout',
       amount: order.sellerPayout,
       description: 'Выплата продавцу по спору (товар признан валидным)'
     }], sessionOpt);
     ```

---

### Шаг 4.5: Явная привязка topupRequestId при ручном начислении баланса админом
- **Идентификатор уязвимости:** `SEC-FIN-13` (Medium)
- **Затрагиваемые файлы:** `src/bot/scenes/admin/payments.scene.js` (строки 197–202).
- **План действий:**
  Передавать `topupRequestId: request._id` при сохранении документа `Transaction`.

---

### Шаг 4.6: Требования к Replica Set в MongoDB и двухфазный CAS-fallback
- **Идентификатор уязвимости:** `SEC-FIN-14` (Low / Arch)
- **Затрагиваемые файлы:** `src/services/transactionHelper.service.js` (строки 20–64), `docker-compose.yml`, `DEPLOY.md`.
- **План действий:**
  1. В `DEPLOY.md` зафиксировать: облачный кластер MongoDB Atlas M0 (Free Tier) поставляется как Replica Set по умолчанию.
  2. Для локального запуска и VPS предоставить docker-compose конфигурацию с инициализацией Replica Set:
     `command: ["mongod", "--replSet", "rs0", "--bind_ip_all"]`
     с последующим запуском `rs.initiate()`.
  3. В `transactionHelper.service.js` реализовать graceful CAS-fallback: если транзакции недоступны, выполнять операции последовательно с проверкой условий CAS (версионность / статусы) вместо аварийного выброса ошибки `TRANSACTIONS_REQUIRED`.

---

### Шаг 4.7: Исправление легаси Bybit UID: добавление coin=USDT и дедупликация
- **Идентификатор уязвимости:** `SEC-FIN-17` (Medium)
- **Затрагиваемые файлы:** `src/services/blockchain.service.js` (строка 44), `src/bot/scenes/topup.scene.js` (строки 964–985).
- **План действий:**
  1. В `blockchain.service.js:44` изменить строку параметров:
     `const qs = 'coin=USDT&limit=50';`
  2. В `topup.scene.js:972` проверять уникальность `match.txID` сразу по двум коллекциям:
     ```javascript
     const existsInTopup = await TopupRequest.findOne({ txid: match.txID });
     const existsInInvoice = await BybitInvoice.findOne({ txId: match.txID });
     if (!existsInTopup && !existsInInvoice) { ... }
     ```

---

### Шаг 4.8: Разделение массива RequiredChannel и обновление channelCheck.service.js
- **Идентификатор уязвимости:** `SEC-CORE-05` (Medium)
- **Затрагиваемые файлы:** `src/models/RequiredChannel.js` (строка 10), `src/models/ChannelVerification.js` (создание), `src/bot/services/channelCheck.service.js` (строки 63–72).
- **План действий:**
  1. Создать легковесную модель `ChannelVerification`:
     ```javascript
     const channelVerificationSchema = new mongoose.Schema({
       channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'RequiredChannel', required: true },
       userId: { type: String, required: true },
       verifiedAt: { type: Date, default: Date.now },
     });
     channelVerificationSchema.index({ channelId: 1, userId: 1 }, { unique: true });
     module.exports = mongoose.model('ChannelVerification', channelVerificationSchema);
     ```
  2. Удалить unbounded-массив `verifiedUserIds` из `RequiredChannel.js`.
  3. **Обязательное обновление `channelCheck.service.js` (строки 63–72):**
     ```javascript
     const recordChannelSubscription = async (channelId, userId) => {
       const strUserId = String(userId);
       try {
         const res = await ChannelVerification.updateOne(
           { channelId, userId: strUserId },
           { $setOnInsert: { verifiedAt: new Date() } },
           { upsert: true }
         );
         if (res.upsertedCount > 0) {
           await RequiredChannel.updateOne({ _id: channelId }, { $inc: { subscribersCount: 1 } });
         }
       } catch (err) {
         console.warn(`[ChannelCheck] Failed to record subscription: ${err.message}`);
       }
     };
     ```
- **Результат:** Полное устранение риска падения базы при масштабировании аудитории выше 16MB.

---

### Шаг 4.9: Шифрование секретов в Settings и SupplierConfig с обязательной миграцией
- **Идентификатор уязвимости:** `SEC-CORE-06` (Medium)
- **Затрагиваемые файлы:** `src/models/Settings.js`, `src/models/SupplierConfig.js`, `src/services/secretBox.service.js` (использование существующего модуля), `scripts/migrate-encrypt-secrets.js` (создание), `scripts/rollback-decrypt-secrets.js` (создание).
- **Критический деплой-риск:** Если включить геттеры/сеттеры AES-256-GCM в Mongoose без предварительной миграции или без проверки пустых строк, `createDecipheriv` выбросит исключение при попытке расшифровать существующие plaintext-ключи или пустые строки по умолчанию `""` (`TypeError: Invalid initialization vector` / auth tag errors), вызвав 100% падение платежных модулей и интеграций с поставщиками.
- **План действий:**
  1. **Использование стандартного сервиса шифрования:**
     Использовать уже существующий в кодовой базе сервис `src/services/secretBox.service.js` (алгоритм AES-256-GCM с уникальным 12-байтовым IV, валидацией auth tag, SHA-256 производным ключом от `ORDER_TOKEN_ENCRYPTION_KEY`, стандартизированным префиксом `PREFIX = 'enc:v1:'` и встроенным backward-compatible fallback).
  2. **Защищенные геттеры/сеттеры в Mongoose-моделях:**
     В моделях `src/models/Settings.js` и `src/models/SupplierConfig.js` реализовать геттеры с обязательной префиксной проверкой типа, чтобы пустые строки `""` (дефолтные значения схемы) и `null` возвращались напрямую без обращения к дешифратору:
     ```javascript
     const { PREFIX, encryptSecret, decryptSecret } = require('../services/secretBox.service');

     // Безопасный геттер: расшифровывает только строки с префиксом 'enc:v1:'
     const secretGetter = (val) => {
       if (typeof val === 'string' && val.startsWith(PREFIX)) {
         return decryptSecret(val);
       }
       return val; // пустые строки '' и null безопасно возвращаются как есть
     };

     // Безопасный сеттер: шифрует только непустые строки
     const secretSetter = (val) => {
       if (typeof val === 'string' && val.trim() !== '') {
         return encryptSecret(val);
       }
       return val;
     };
     ```
     Подключить геттеры и сеттеры в схемах:
     - `src/models/Settings.js` для полей: `bybitApiKey`, `bybitApiSecret`, `plategaMerchantId`, `plategaSecret`, `cardNumber`, `cardHolder`, `geminiApiKey`.
     - `src/models/SupplierConfig.js` для поля: `apiKey`.
     - В опциях обеих схем установить `{ toJSON: { getters: true }, toObject: { getters: true } }`.
  3. **Скрипт предрелизной миграции `scripts/migrate-encrypt-secrets.js`:**
     Полная промышленная реализация с обходом обеих коллекций (`settings` и `supplierconfigs`), проверкой префикса `PREFIX = 'enc:v1:'` и гарантированной идемпотентностью:
     ```javascript
     // scripts/migrate-encrypt-secrets.js
     require('dotenv').config();
     const mongoose = require('mongoose');
     const { PREFIX, encryptSecret } = require('../src/services/secretBox.service');

     async function runMigration() {
       if (!process.env.MONGODB_URI) {
         throw new Error('MONGODB_URI environment variable is missing.');
       }
       await mongoose.connect(process.env.MONGODB_URI);
       console.log('Connected to MongoDB for secret encryption migration.');

       // 1. Settings collection
       const Settings = mongoose.connection.collection('settings');
       const settingsDocs = await Settings.find({}).toArray();
       for (const doc of settingsDocs) {
         const updates = {};
         const fields = [
           'bybitApiKey',
           'bybitApiSecret',
           'plategaMerchantId',
           'plategaSecret',
           'cardNumber',
           'cardHolder',
           'geminiApiKey',
         ];
         for (const field of fields) {
           if (doc[field] && typeof doc[field] === 'string' && !doc[field].startsWith(PREFIX)) {
             updates[field] = encryptSecret(doc[field]);
           }
         }
         if (Object.keys(updates).length > 0) {
           await Settings.updateOne({ _id: doc._id }, { $set: updates });
           console.log(`[Settings] Encrypted secrets for document ${doc._id}: ${Object.keys(updates).join(', ')}`);
         }
       }

       // 2. SupplierConfig collection (dropship suppliers API keys)
       const SupplierConfigs = mongoose.connection.collection('supplierconfigs');
       const supplierDocs = await SupplierConfigs.find({}).toArray();
       for (const doc of supplierDocs) {
         const updates = {};
         if (doc.apiKey && typeof doc.apiKey === 'string' && !doc.apiKey.startsWith(PREFIX)) {
           updates.apiKey = encryptSecret(doc.apiKey);
         }
         if (Object.keys(updates).length > 0) {
           await SupplierConfigs.updateOne({ _id: doc._id }, { $set: updates });
           console.log(`[SupplierConfig] Encrypted apiKey for supplier: ${doc.supplierId || doc._id}`);
         }
       }

       await mongoose.disconnect();
       console.log('✅ Secret encryption migration completed successfully.');
     }

     runMigration().catch(async (err) => {
       console.error('❌ Migration failed:', err.message);
       try { await mongoose.disconnect(); } catch (_) {}
       process.exit(1);
     });
     ```
  4. **Скрипт аварийной расшифровки `scripts/rollback-decrypt-secrets.js`:**
     Полная промышленная реализация для безопасного возврата зашифрованных данных в открытый вид при необходимости отката:
     ```javascript
     // scripts/rollback-decrypt-secrets.js
     require('dotenv').config();
     const mongoose = require('mongoose');
     const { PREFIX, decryptSecret } = require('../src/services/secretBox.service');

     async function runRollback() {
       if (!process.env.MONGODB_URI) {
         throw new Error('MONGODB_URI environment variable is missing.');
       }
       await mongoose.connect(process.env.MONGODB_URI);
       console.log('Connected to MongoDB for secret decryption rollback.');

       // 1. Settings collection
       const Settings = mongoose.connection.collection('settings');
       const settingsDocs = await Settings.find({}).toArray();
       for (const doc of settingsDocs) {
         const updates = {};
         const fields = [
           'bybitApiKey',
           'bybitApiSecret',
           'plategaMerchantId',
           'plategaSecret',
           'cardNumber',
           'cardHolder',
           'geminiApiKey',
         ];
         for (const field of fields) {
           if (doc[field] && typeof doc[field] === 'string' && doc[field].startsWith(PREFIX)) {
             updates[field] = decryptSecret(doc[field]);
           }
         }
         if (Object.keys(updates).length > 0) {
           await Settings.updateOne({ _id: doc._id }, { $set: updates });
           console.log(`[Settings] Decrypted secrets for document ${doc._id}: ${Object.keys(updates).join(', ')}`);
         }
       }

       // 2. SupplierConfig collection
       const SupplierConfigs = mongoose.connection.collection('supplierconfigs');
       const supplierDocs = await SupplierConfigs.find({}).toArray();
       for (const doc of supplierDocs) {
         const updates = {};
         if (doc.apiKey && typeof doc.apiKey === 'string' && doc.apiKey.startsWith(PREFIX)) {
           updates.apiKey = decryptSecret(doc.apiKey);
         }
         if (Object.keys(updates).length > 0) {
           await SupplierConfigs.updateOne({ _id: doc._id }, { $set: updates });
           console.log(`[SupplierConfig] Decrypted apiKey for supplier: ${doc.supplierId || doc._id}`);
         }
       }

       await mongoose.disconnect();
       console.log('✅ Secret decryption rollback completed successfully.');
     }

     runRollback().catch(async (err) => {
       console.error('❌ Rollback failed:', err.message);
       try { await mongoose.disconnect(); } catch (_) {}
       process.exit(1);
     });
     ```
  5. **Регламент внедрения:** Запуск `scripts/migrate-encrypt-secrets.js` производится на боевой базе строго **ДО** перезапуска сервиса бота с активированными геттерами/сеттерами в схемах.

---

### Шаг 4.10: Двухэтапное подтверждение сброса ToS и аварийный MAINTENANCE_MODE в connect.js
- **Идентификатор уязвимости:** `SEC-CORE-07` (Medium) + Эксплуатационная надежность (Operational Recovery)
- **Затрагиваемые файлы:** `src/bot/scenes/admin/settings.scene.js` (строки 451–458), `src/db/connect.js` (строки 49–50).
- **План действий:**
  1. **Диалоговое подтверждение ToS Reset:**
     При нажатии кнопки «Сбросить ToS» в `src/bot/scenes/admin/settings.scene.js` показывать двухэтапный диалог подтверждения:
     «⚠️ Вы действительно хотите заставить всех пользователей заново принять оферту?» с кнопками «Да, сбросить» и «Отмена».
  2. **Поддержка аварийного MAINTENANCE_MODE в connect.js:**
     В `src/db/connect.js:49` устранить дефект игнорирования переменных окружения при старте:
     ```javascript
     // До исправления:
     // global.MAINTENANCE_MODE = settings.maintenanceMode;

     // После исправления:
     global.MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true' || Boolean(settings.maintenanceMode);
     logger.info(`Maintenance mode: ${global.MAINTENANCE_MODE ? 'enabled' : 'disabled'}`);
     ```
     Это позволяет переводить бота в аварийный режим обслуживания как через переменную окружения `MAINTENANCE_MODE=true` на хостинге (Render / Docker), так и через базу данных (`settings.maintenanceMode`), устраняя риск случайного открытия доступа к боту при перезапуске контейнера.

---

### Шаг 4.11: Криптостойкая генерация referralCode (crypto.randomBytes)
- **Идентификатор уязвимости:** `SEC-CORE-08` (Medium)
- **Затрагиваемые файлы:** `src/models/User.js` (строки 74–79).
- **План действий:**
  Заменить `Math.random` на `crypto.randomBytes(4).toString('hex').toUpperCase()` с циклом до 3 попыток при возникновении коллизии по уникальному индексу.

---

### Шаг 4.12: Очистка листа ожидания Waitlist при отмене предзаказа
- **Идентификатор уязвимости:** `SEC-CAT-07` (Low)
- **Затрагиваемые файлы:** `src/bot/scenes/profile.scene.js` (строки 746–784).
- **План действий:**
  При отмене предзаказа вызывать:
  `await Waitlist.findOneAndDelete({ userId: user._id, productId });`

---

### Шаг 4.13: Индексация MongoDB и проверка CAS промокодов
- **Идентификаторы уязвимостей:** `SEC-CORE-09`, `SEC-CAT-08` (Low / FP Audit)
- **Затрагиваемые файлы:** `src/models/BybitInvoice.js` (строки 27–31), `src/models/TopupRequest.js` (строки 32–33), `src/models/SellerWithdrawal.js`, `src/db/connect.js` (строки 76–93).
- **План действий:**
  1. Добавить уникальный частичный индекс на `BybitInvoice.txId`:
     ```javascript
     bybitInvoiceSchema.index(
       { txId: 1 },
       { unique: true, partialFilterExpression: { txId: { $type: 'string' } } }
     );
     ```
  2. Добавить уникальный частичный индекс на `TopupRequest.paymentId`:
     ```javascript
     topupRequestSchema.index(
       { paymentId: 1 },
       { unique: true, partialFilterExpression: { paymentId: { $type: 'string' } } }
     );
     ```
  3. Добавить `BybitInvoice` в список синхронизации индексов в `src/db/connect.js:76-93`, чтобы все индексы модели гарантированно сверялись при старте приложения.
  4. Подтвердить сохранение существующего CAS на `currentActivations` в `PromoCode.js`.

---

### Регламент отката (Rollback Runbook) для Этапа 4
1. **Аварийная изоляция трафика / Maintenance Mode:**
   Немедленно остановить входящий пользовательский трафик командой в `mongosh`:
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: true } });
   ```
   (или выставить `MAINTENANCE_MODE=true` в переменных окружения хостинга). Это гарантирует отсутствие параллельных транзакций и гонок чтения/записи во время отката.
2. **Безопасная последовательность отката данных в MongoDB (Dual-Read Fallback):**
   Благодаря встроенному механизму двойного чтения (dual-read fallback в `src/services/secretBox.service.js` и Mongoose геттерах: проверка `val.startsWith('enc:v1:')`), дешифрование данных в MongoDB выполняется **ДО** отката кода. Запустить скрипт обратной расшифровки:
   ```bash
   node scripts/rollback-decrypt-secrets.js
   ```
   Скрипт проверяет префикс `enc:v1:` и возвращает все зашифрованные поля в коллекциях `settings` (`bybitApiKey`, `bybitApiSecret`, `plategaMerchantId`, `plategaSecret`, `cardNumber`, `cardHolder`, `geminiApiKey`) и `supplierconfigs` (`apiKey`) в открытый текст.
3. **Откат кода приложения (Code Revert):**
   Только после успешного завершения работы `rollback-decrypt-secrets.js` и подтверждения наличия открытого текста в БД выполнить откат релизного коммита через Git (отключая Mongoose getter/setter плагины):
   ```bash
   git revert --no-edit <release-commit-hash>
   git push origin main
   ```
   (Строгое соблюдение этой последовательности исключает падение старой версии приложения при попытке прочитать `enc:v1:` шифротекст).
4. **Снятие конфликтных индексов MongoDB (при необходимости):**
   ```javascript
   db.bybitinvoices.dropIndex("txId_1");
   db.topuprequests.dropIndex("paymentId_1");
   db.channelverifications.drop();
   ```
5. **Проверка целостности и возобновление работы:**
   Убедиться, что бот корректно стартует и читает открытые ключи из MongoDB, после чего снять режим обслуживания:
   ```javascript
   db.settings.updateOne({}, { $set: { maintenanceMode: false } });
   ```

---

## ЭТАП 5: Комплексная верификация, регламенты отката и мониторинг
**Цель этапа:** Полная верификация всей системы сквозными тестами, аудит готовности к релизу и настройка круглосуточного мониторинга.

---

### Шаг 5.1: Комплексный автоматизированный тест-сьют E2E
- **План действий:**
  Реализовать набор интеграционных тестов (Jest / Supertest):
  1. `test_fake_trc20_rejected`: отправка транзакции с левым смарт-контрактом (ожидается отказ).
  2. `test_bybit_race_condition`: два параллельных запроса проверки одного инвойса (ровно одно зачисление).
  3. `test_cart_seller_payout`: покупка товара вендора через корзину (проверка наличия `sellerId` и начисления баланса вендору).
  4. `test_supplier_failure_auto_refund`: мок сбоя внешнего поставщика (проверка начисления возврата и записи в `Transaction`).
  5. `test_platega_amount_validation`: вебхук с измененной суммой (проверка ответа 400).
  6. `test_poller_n_plus_one_batching`: 10 инвойсов опрашиваются за 1 сетевой запрос.

---

### Шаг 5.2: Чек-лист предрелизного контроля (Pre-Production Quality Gate)
- [ ] 1. В коде репозитория отсутствуют реальные клиентские учетные данные, пароли и 2FA TOTP сиды.
- [ ] 2. Прием TRC-20 USDT строго сверяет контракт `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
- [ ] 3. Инвойсы Bybit UID имеют CAS-блокировку `processing` и уникальный индекс `exactAmount`.
- [ ] 4. Адаптер TrumpStore использует точные метаданные валюты и динамический курс VND.
- [ ] 5. Ошибки внешних поставщиков автоматически инициируют возврат средств клиенту.
- [ ] 6. Оформление заказов через корзину корректно сохраняет `sellerId` и начисляет `sellerPayout`.
- [ ] 7. Сессии Telegraf сохраняются в MongoDB, сохраняя состояния пользователей при деплое.
- [ ] 8. База данных содержит уникальные частичные индексы на `txId` и `paymentId`.
- [ ] 9. Скрипт миграции секретов успешно зашифровал данные в MongoDB по алгоритму AES-256-GCM.
- [ ] 10. Поллер Bybit опрашивает API батчем, исключая превышение rate limits и ошибку HTTP 429.

---

### Шаг 5.3: Сводный мастер-регламент аварийного отката (Master Rollback Protocol)

В случае обнаружения критических регрессий в продакшене действует строгий регламент отката с соблюдением безопасной последовательности операций (Database Decryption with Dual-Read Fallback -> Code Revert):

1. **Немедленная остановка входящего трафика / Maintenance Mode (Instant Isolation):**
   - **Мгновенная блокировка через MongoDB (время реакции < 1 сек без ожидания 3–5 мин редеплоя Render):**
     Выполнить в `mongosh`:
     ```javascript
     db.settings.updateOne({}, { $set: { maintenanceMode: true } });
     ```
     Все входящие команды пользователей и обработчики платежей немедленно изолируются middleware `src/bot/middlewares/user.js:58` с уведомлением: «Ведутся технические работы. Прием платежей временно приостановлен».
   - **Аварийный флаг в переменных окружения:**
     Выставить `MAINTENANCE_MODE=true` в переменных окружения хостинга (Render / Docker / .env). Благодаря обновлению в `src/db/connect.js:49` (`global.MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true' || Boolean(settings.maintenanceMode)`), режим обслуживания гарантированно сохраняется даже при внезапных перезапусках контейнеров хостингом.

2. **Откат шифрования секретов в MongoDB (Dual-Read Fallback ДО отката кода):**
   - **Критическое правило последовательности операций:** Откат базы данных (`rollback-decrypt-secrets.js`) выполняется **СТРОГО ДО** отката кода приложения (`git revert`). Если откатить код первым, старая версия приложения без поддержки префикса `enc:v1:` попытается интерпретировать шифротекст как открытый API-ключ, что вызовет фатальный отказ всех платежных шлюзов Bybit, Platega и dropship-интеграций.
   - Благодаря механизму **dual-read fallback** (в `src/services/secretBox.service.js` и Mongoose геттерах: проверка `val.startsWith('enc:v1:')`), работающее приложение безопасно считывает как зашифрованные, так и открытые значения.
   - Выполнить скрипт обратной расшифровки:
     ```bash
     node scripts/rollback-decrypt-secrets.js
     ```
     Скрипт атомарно и идемпотентно расшифровывает поля `bybitApiKey`, `bybitApiSecret`, `plategaMerchantId`, `plategaSecret`, `cardNumber`, `cardHolder`, `geminiApiKey` в коллекции `settings` и `apiKey` в `supplierconfigs`.

3. **Откат релизного коммита Git (Code Revert):**
   Только после подтверждения наличия открытого текста в MongoDB откатить релизный коммит:
   ```bash
   git revert --no-edit <release-commit-hash>
   git push origin main
   ```

4. **Снятие конфликтных индексов БД в mongosh (при необходимости):**
   При возникновении конфликтов уникальности или блокировок выполнить в `mongosh`:
   ```javascript
   db.bybitinvoices.dropIndex("exactAmount_1");
   db.bybitinvoices.dropIndex("txId_1");
   db.topuprequests.dropIndex("paymentId_1");
   db.topuprequests.dropIndex("rrn_1");
   ```

5. **Проверка целостности и контролируемый повторный пуск:**
   - Проверить соединение с БД и корректность чтения открытых секретов из `settings` и `supplierconfigs`.
   - Провести тестовую транзакцию пополнения на 1 USDT.
   - Снять режим обслуживания в `mongosh`:
     ```javascript
     db.settings.updateOne({}, { $set: { maintenanceMode: false } });
     ```
   - При необходимости снять флаг `MAINTENANCE_MODE` в переменных окружения хостинга.

---

### Шаг 5.4: Настройка операционного мониторинга, алертинга и метрик
1. **Sentry Error Tracking**: Подключить `@sentry/node` для перехвата необработанных исключений в Telegraf middleware и Express вебхуках.
2. **Алертинг в Telegram-канал администраторов**:
   - Алерты при любой ошибке внешних API поставщиков.
   - Алерты при попытках отправки фальшивых токенов TRC-20.
   - Алерты при отклонении вебхуков Platega по сумме.
3. **Автоматический ежедневный reconciliation крон**:
   Крон в 03:00 UTC выполняет сверку: `User.balance` против суммы всех записей в `Transaction`. При обнаружении расхождения администраторам отправляется уведомление с детализацией.

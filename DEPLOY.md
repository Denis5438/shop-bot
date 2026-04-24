# 🚀 Деплой Shop Bot на Render + UptimeRobot

Пошаговая инструкция для бесплатного деплоя Telegram-бота на Render с обходом 15-минутного сна через UptimeRobot.

**Стек (всё бесплатно):**
- 🖥️ **Render** — хостинг Node.js ($0)
- 🗄️ **MongoDB Atlas** — база данных ($0, тариф M0)
- 📡 **UptimeRobot** — пингер, чтобы Render не засыпал ($0)

---

## ⚠️ Перед стартом — критичная безопасность

В твоём `.env` **уже лежат реальные секреты**: `BOT_TOKEN`, `MONGODB_URI` с паролем, `BYBIT_API_SECRET`, `BSCSCAN_API_KEY`. Они **не должны попасть в GitHub**.

✅ Я уже создал `.gitignore`, который исключает `.env`.
⚠️ Но если ты случайно сделаешь `git add .env` с флагом `-f`, он всё равно попадёт в историю. **Никогда не добавляй .env с `-f`!**

**Проверка перед пушем:**
```bash
git status
```
Файл `.env` **не должен появиться** в списке "Untracked files" или "Changes to be committed".

---

## Часть 1: Загрузка в GitHub

### 1.1. Установи Git (если ещё не установлен)

Скачай с [git-scm.com](https://git-scm.com/download/win) и установи с настройками по умолчанию.

Проверь в PowerShell:
```powershell
git --version
```

### 1.2. Настрой свой аккаунт (один раз)

```powershell
git config --global user.name "Твоё Имя"
git config --global user.email "твой@email.com"
```

### 1.3. Создай репозиторий на GitHub

1. Зайди на [github.com](https://github.com), нажми **➕ → New repository**.
2. Название: `shop-bot` (или любое).
3. **Visibility: Private** ⚠️ (обязательно — не Public!).
4. НЕ добавляй README, .gitignore, лицензию — они уже есть локально.
5. Нажми **Create repository**.
6. На следующей странице GitHub покажет URL репозитория — скопируй его, выглядит как:
   ```
   https://github.com/ТВОЙ_ЛОГИН/shop-bot.git
   ```

### 1.4. Инициализируй git в папке проекта

Открой PowerShell в папке `c:\Users\user\Desktop\Shop bot` и выполни:

```powershell
# Инициализация
git init

# ВАЖНО: проверь, что .env НЕ будет добавлен
git status
# В списке "Untracked files" НЕ должно быть ".env"
# (там должен быть только .env.example)

# Добавляем все файлы (кроме тех, что в .gitignore)
git add .

# Ещё раз проверим, что .env не добавлен
git status
# Ищи строку: "new file: .env" — её быть НЕ ДОЛЖНО
# Должно быть только ".env.example"

# Первый коммит
git commit -m "Initial commit: shop bot with health-server"

# Привязываем remote (подставь свой URL из 1.3)
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/shop-bot.git

# Пушим
git push -u origin main
```

GitHub может попросить логин. Используй **Personal Access Token** вместо пароля:
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)
- Scope: `repo` (только)
- Срок: 90 дней
- Копируй токен и используй его как пароль при пуше.

### 1.5. Если случайно закоммитил .env

**Сразу:**
1. Пересоздай **все** секреты: `BOT_TOKEN` у @BotFather (`/revoke`), Bybit API, BSCScan API, смени пароль MongoDB.
2. Удали файл из истории:
   ```powershell
   git rm --cached .env
   git commit -m "Remove .env from repo"
   git push
   ```
3. Добавь новые секреты только в Render env vars (Часть 2).

---

## Часть 2: Настройка MongoDB Atlas (бесплатно)

Если у тебя уже есть работающий MongoDB URI в `.env` — **пропусти этот раздел**. Иначе:

1. Регистрация: [cloud.mongodb.com](https://cloud.mongodb.com) (free, без карты).
2. **Build a Database → M0 Free** → провайдер AWS, регион ближайший к Render (обычно Frankfurt или N. Virginia).
3. **Database Access** → Add New Database User → пароль (запиши).
4. **Network Access** → Add IP Address → **Allow access from anywhere** (`0.0.0.0/0`). Это нужно для Render.
5. **Database → Connect → Drivers → Node.js** → скопируй URI вида:
   ```
   mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/shopbot?retryWrites=true&w=majority
   ```
6. Замени `<password>` на твой реальный пароль. Сохрани на потом.

---

## Часть 3: Деплой на Render

### 3.1. Регистрация

1. Зайди на [render.com](https://render.com), нажми **Get Started for Free**.
2. **Войди через GitHub** — это сразу подключит репозитории.

### 3.2. Создание Web Service

1. Dashboard → **New + → Web Service**.
2. Найди свой `shop-bot` репозиторий → **Connect**.
3. Заполни форму:

| Поле | Значение |
|---|---|
| **Name** | `shop-bot` (будет в URL) |
| **Region** | Frankfurt (ближе к Telegram API) |
| **Branch** | `main` |
| **Root Directory** | (оставь пустым) |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node index.js` |
| **Instance Type** | **Free** |

### 3.3. Environment Variables (КРИТИЧНО)

Пролистай вниз до **Environment Variables** → **Add Environment Variable**.

Добавь **КАЖДУЮ** переменную из твоего локального `.env` (скопируй значения оттуда):

```
BOT_TOKEN            = твой_токен_от_BotFather
MONGODB_URI          = mongodb+srv://...
ADMIN_IDS            = 6540555219
REFERRAL_BONUS       = 0.5
MIN_TOPUP            = 1
ITEMS_PER_PAGE       = 5
DEFAULT_ANALYTICS_CURRENCY = USDT
TOPUP_WALLET         = твой_TRC20_адрес
TOPUP_NETWORK        = TRC-20 (TRON)
BSCSCAN_API_KEY      = твой_ключ
BYBIT_API_KEY        = твой_ключ
BYBIT_API_SECRET     = твой_секрет
```

⚠️ **PORT не добавляй** — Render устанавливает его автоматически.

### 3.4. Запуск

Нажми **Create Web Service**. Render начнёт сборку (2-5 минут).

**Следи за логами** (вкладка Logs). Должно появиться:
```
🚀 Запуск бота...
🩺 Health-server слушает порт 10000 (GET /health, /ping, /)
✅ Бот запущен и ждёт сообщений!
```

### 3.5. Проверка HTTP-эндпоинта

Render покажет твой URL вверху страницы, типа:
```
https://shop-bot-xxxx.onrender.com
```

Открой в браузере:
- `https://shop-bot-xxxx.onrender.com/` → должен вернуть JSON со `status: running`
- `https://shop-bot-xxxx.onrender.com/health` → JSON с `status: ok, mongo: connected`
- `https://shop-bot-xxxx.onrender.com/ping` → `pong`

Если `/health` показывает `mongo: disconnected` — проверь `MONGODB_URI` и **Network Access** в Atlas.

### 3.6. Проверка бота

Напиши боту в Telegram — он должен ответить. Если да — **деплой успешен** 🎉

---

## Часть 4: UptimeRobot (антисон)

### 4.1. Регистрация

[uptimerobot.com](https://uptimerobot.com) → Sign Up Free. Без карты.

### 4.2. Создание монитора

Dashboard → **+ New monitor** → **HTTP(s)**.

| Поле | Значение |
|---|---|
| **Monitor Type** | HTTP(s) |
| **Friendly Name** | `Shop Bot` |
| **URL** | `https://shop-bot-xxxx.onrender.com/health` |
| **Monitoring Interval** | **5 minutes** |
| **Monitor Timeout** | 30 seconds |

**Advanced Settings:**
- **HTTP Method:** GET
- **Alert When:** Down
- **Keyword** (опционально): `"status":"ok"` — тогда алерт сработает и при падении Mongo.

**Alert Contacts:** твой email уже добавлен по умолчанию.

Нажми **Create Monitor**.

### 4.3. (Опционально) Telegram-алерты

1. В UptimeRobot → **My Settings → Add Alert Contact**
2. Type: **Telegram** → следуй инструкции (добавить их бота, получить chat_id).
3. На странице монитора → отметь Telegram в Alert Contacts.

---

## Часть 5: Обновление кода

После первого деплоя — каждый раз, когда ты хочешь обновить бота:

```powershell
git add .
git commit -m "описание изменений"
git push
```

Render **автоматически** задеплоит новую версию через 1-3 минуты. Следи за вкладкой Logs.

---

## Ограничения Free-тарифа Render

| Ограничение | Значение | Что делать |
|---|---|---|
| Время работы | 750 часов/мес | 24/7 = ~730 ч — укладываемся впритык |
| RAM | 512 MB | Хватает, но без запаса |
| Сон без HTTP | 15 минут | Решаем UptimeRobot'ом |
| Холодный старт | ~30 сек | Не должно быть, если пинг работает |
| Логи | Последние 15 мин | Для истории — переноси в Mongo/Winston |

Если бот начнёт тупить или вылетать — значит пора думать про VPS ($3-5/мес) из предыдущего разговора (Aeza, RackNerd).

---

## Troubleshooting

### Render: "Port scan timeout"
→ Сервис не слушает `process.env.PORT`. В нашем коде `health-server.js` это уже учтено, но проверь логи — должно быть `Health-server слушает порт XXXX`.

### Render: "Out of memory"
→ 512 MB закончились. Убери неиспользуемые библиотеки или апгрейдь до Starter ($7/мес).

### UptimeRobot: "Host is down"
→ Render засыпает быстрее, чем раз в 5 мин? Проверь что URL правильный. Попробуй интервал 3 мин.

### Бот не отвечает в Telegram, но /health возвращает OK
→ Возможно `BOT_TOKEN` неправильный в Render env. Проверь вкладку Environment в настройках сервиса.

### MongoDB: "MongoNetworkError"
→ **Network Access** в Atlas не пускает IP Render. Добавь `0.0.0.0/0` в whitelist.

---

## Полезные ссылки

- [Render Docs: Node.js](https://render.com/docs/deploy-node-express-app)
- [MongoDB Atlas Free](https://www.mongodb.com/cloud/atlas/register)
- [UptimeRobot Docs](https://uptimerobot.com/help/)
- [BotFather](https://t.me/BotFather)

**Готово.** Если что-то пойдёт не так — скинь мне логи из Render и разберёмся.

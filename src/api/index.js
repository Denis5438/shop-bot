const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { authRouter } = require('./routes/auth.routes');
const { catalogRouter } = require('./routes/catalog.routes');
const { cartRouter } = require('./routes/cart.routes');
const { ordersRouter } = require('./routes/orders.routes');
const { paymentsRouter } = require('./routes/payments.routes');
const { adminRouter } = require('./routes/admin.routes');
const { supportRouter } = require('./routes/support.routes');
const { optionalAuth } = require('./middlewares/auth.middleware');
const logger = require('../config/logger');

const app = express();

// ─── Защитные Middleware ──────────────────────────────────────────
// 1. CORS с поддержкой куки и кросс-доменных запросов фронтенда
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'cf-connecting-ip'],
}));

// 2. Парсеры тела запроса и куки
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 3. Опциональная проверка аутентификации для гранулярного rate-limit
app.use(optionalAuth);

// 4. Sliding-Window Rate-Limiter (в памяти)
const rateBuckets = new Map();
const applyRateLimit = (windowMs = 60000, maxRequests = 60) => (req, res, next) => {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  // Если пользователь аутентифицирован, лимитируем по userId, иначе по IP
  const clientKey = req.user ? `user:${req.user._id}` : `ip:${ip}`;
  const endpointKey = `${req.baseUrl || ''}${req.path}`;
  const key = `${clientKey}:${endpointKey}`;
  const now = Date.now();

  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  } else {
    bucket.count += 1;
  }

  // Периодическая очистка устаревших бакетов
  if (rateBuckets.size > 20000) {
    for (const [k, b] of rateBuckets.entries()) {
      if (now > b.resetAt) rateBuckets.delete(k);
    }
  }

  if (bucket.count > maxRequests) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Слишком много запросов. Пожалуйста, подождите минуту.',
    });
  }

  next();
};

// ─── Маршруты API v1 ──────────────────────────────────────────────

// Health check для API
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'TIG MARKET Web API v1', time: new Date().toISOString() });
});

// 1. Авторизация (сессии, Telegram-код, 1-клик, MiniApp initData)
// Внутри authRouter эндпоинты имеют свои точечные проверки
app.use('/api/v1/auth/check-status', applyRateLimit(60000, 120));
app.use('/api/v1/auth', applyRateLimit(60000, 30), authRouter);

// 2. Каталог и товары (120 req/min для быстрого скролла и фильтрации)
app.use('/api/v1/catalog', applyRateLimit(60000, 120), catalogRouter);

// 3. Корзина пользователя (60 req/min)
app.use('/api/v1/cart', applyRateLimit(60000, 60), cartRouter);

// 4. Заказы и чекаут (checkout: 10 req/min, остальные: 60 req/min)
app.use('/api/v1/orders/checkout', applyRateLimit(60000, 10));
app.use('/api/v1/orders', applyRateLimit(60000, 60), ordersRouter);

// 5. Мультиканальные платежи (Bybit UID, Platega СБП, Крипта TRC20/BEP20/TON)
app.use('/api/v1/payments/bybit-uid/check', applyRateLimit(60000, 5));
app.use('/api/v1/payments/bybit-uid/create', applyRateLimit(60000, 30));
app.use('/api/v1/payments/platega/create', applyRateLimit(60000, 30));
app.use('/api/v1/payments/crypto/submit', applyRateLimit(60000, 15));
app.use('/api/v1/payments', applyRateLimit(60000, 120), paymentsRouter);

// 6. Админ-панель веб-сайта (180 req/min)
app.use('/api/v1/admin', applyRateLimit(60000, 180), adminRouter);

// 7. Система поддержки (180 req/min)
app.use('/api/v1/support', applyRateLimit(60000, 180), supportRouter);

// Обработчик 404 для неизвестных эндпоинтов API
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'API эндпоинт не найден' });
});

// ─── Раздача статики витрины сайта (Frontend Next.js Export) ─────────
const staticDir = path.resolve(__dirname, '../../website/frontend/out');
if (fs.existsSync(staticDir)) {
  // Раздача статических ассетов (_next, изображения, css, js)
  app.use(express.static(staticDir));

  // Маршрутизация HTML страниц (Next.js export)
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();

    const cleanPath = req.path.replace(/\/+$/, '') || '/';
    if (cleanPath === '/') {
      const rootIndex = path.join(staticDir, 'index.html');
      if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
    }

    // Поиск директории с index.html (например /auth/signin -> /auth/signin/index.html)
    const dirIndex = path.join(staticDir, cleanPath, 'index.html');
    if (fs.existsSync(dirIndex)) {
      return res.sendFile(dirIndex);
    }

    // Прямой html-файл (например /auth/signin.html)
    const directHtml = path.join(staticDir, `${cleanPath}.html`);
    if (fs.existsSync(directHtml)) {
      return res.sendFile(directHtml);
    }

    // 404 страница сайта
    const notFoundHtml = path.join(staticDir, '404.html');
    if (fs.existsSync(notFoundHtml)) {
      return res.status(404).sendFile(notFoundHtml);
    }

    const fallbackIndex = path.join(staticDir, 'index.html');
    if (fs.existsSync(fallbackIndex)) {
      return res.sendFile(fallbackIndex);
    }

    next();
  });
}



// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  logger.error(`[ExpressAPI Error] ${err.message}`, { stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Внутренняя ошибка сервера' : err.message,
  });
});

module.exports = app;

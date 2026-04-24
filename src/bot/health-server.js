// ============================================================
// Минимальный HTTP-сервер для Render / UptimeRobot.
//
// Render Free усыпляет Web Service после 15 минут без HTTP-запросов,
// а также требует, чтобы сервис слушал порт из process.env.PORT.
// Этот модуль решает обе задачи:
//   1) слушает PORT и отвечает 200 на /health, /ping, /
//   2) позволяет внешнему пингеру (UptimeRobot) будить сервис раз в 5 минут.
//
// Сервер намеренно сделан на нативном модуле `http` без Express —
// чтобы не плодить зависимости и не трогать остальной код бота.
// ============================================================

const http = require('http');
const mongoose = require('mongoose');
const logger = require('../config/logger');

const START_TIME = Date.now();

/**
 * Формирует JSON-ответ о состоянии сервиса.
 * Проверяется только mongoose.connection.readyState, чтобы не давать
 * наружу чувствительных данных (env, токены и т.п.).
 */
function buildHealthPayload() {
  const readyState = mongoose.connection?.readyState ?? 0;
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  const mongoStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const mongo = mongoStates[readyState] || 'unknown';
  const healthy = readyState === 1;

  return {
    status: healthy ? 'ok' : 'degraded',
    uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    mongo,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Запускает HTTP-сервер.
 * @param {number} port - порт из process.env.PORT или 3000 по умолчанию
 * @returns {http.Server} instance сервера — его нужно закрыть при shutdown
 */
function startHealthServer(port = 3000) {
  const server = http.createServer((req, res) => {
    // Ответ на любые методы, кроме GET/HEAD → 405.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method Not Allowed');
    }

    // Нормализация пути (обрезаем query-string, slash в конце).
    const urlPath = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    // /ping — самый быстрый ответ, без проверок. Используется для keep-alive.
    if (urlPath === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('pong');
    }

    // /health — полноценный health-check с MongoDB.
    if (urlPath === '/health') {
      const payload = buildHealthPayload();
      const statusCode = payload.status === 'ok' ? 200 : 503;
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(payload));
    }

    // Корень — короткая информация + ссылки.
    if (urlPath === '/') {
      const payload = {
        service: 'shop-bot',
        status: 'running',
        endpoints: ['/health', '/ping'],
        uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(payload));
    }

    // Всё остальное — 404.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Явно обрабатываем ошибки запуска (например, порт занят) — иначе упадёт процесс.
  server.on('error', (err) => {
    logger.error(`❌ Health-server error: ${err.message}`);
  });

  server.listen(port, () => {
    logger.info(`🩺 Health-server слушает порт ${port} (GET /health, /ping, /)`);
  });

  return server;
}

/**
 * Грейсфул shutdown: закрывает сервер и дожидается завершения активных соединений.
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function stopHealthServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close((err) => {
      if (err) logger.warn(`⚠️ Health-server close warning: ${err.message}`);
      else logger.info('🩺 Health-server остановлен');
      resolve();
    });
    // Страховка: если соединения висят >3 сек, принудительно выходим.
    setTimeout(() => resolve(), 3000).unref();
  });
}

module.exports = { startHealthServer, stopHealthServer };

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/db/connect');
const createBot = require('./src/bot/index');
const currencyService = require('./src/services/currency.service');
const autoConfirmCron = require('./src/cron/autoConfirm');
const logger = require('./src/config/logger');
const notif = require('./src/services/notification.service');
const { startHealthServer, stopHealthServer } = require('./src/bot/health-server');

const main = async () => {
  logger.info('🚀 Запуск бота...');

  // Подключение к MongoDB
  await connectDB();

  // Инициализация курса валют (возвращает node-cron задачу для остановки)
  const rateTask = await currencyService.init();

  // Инициализация фоновых задач (Cron) - тоже сохраняем для остановки
  const autoConfirmTask = autoConfirmCron.init();

  // Создаём и запускаем бота
  const bot = createBot();

  // HTTP health-server (нужен для Render + UptimeRobot). Запускаем ДО bot.launch(),
  // чтобы Render сразу увидел слушающий порт и не убил сервис по таймауту старта.
  const healthPort = parseInt(process.env.PORT, 10) || 3000;
  const healthServer = startHealthServer(healthPort);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return; // защита от повторного входа
    shuttingDown = true;
    logger.info(`⛔ Получен ${signal}, останавливаю бота...`);
    try {
      if (typeof bot.context?.__clearCronHandles === 'function') {
        await bot.context.__clearCronHandles();
      }
    } catch (_) {}
    // Останавливаем node-cron задачи (они не в cronHandles бота)
    try { rateTask?.stop(); } catch (_) {}
    try { autoConfirmTask?.stop(); } catch (_) {}
    try { bot.stop(signal); } catch (_) {}
    try { await stopHealthServer(healthServer); } catch (_) {}
    // Закрываем соединение с БД, чтобы не оборвать незавершённые записи
    try { await mongoose.connection.close(); } catch (_) {}
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Логируем ДО launch(): в Telegraf 4 bot.launch() резолвится только при
  // ОСТАНОВКЕ бота, поэтому лог после await печатался бы лишь при выключении.
  logger.info('✅ Бот запущен и ждёт сообщений!');
  await bot.launch();
};

// Глобальные обработчики ошибок для предотвращения падения процесса
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`💥 Необработанное исключение (unhandledRejection): ${reason}`);
  const msg = `⚠️ <b>Unhandled Rejection</b>\n\n<pre>${String(reason).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  notif.sendAdminAlertThrottled(msg, { parse_mode: 'HTML' });
});

process.on('uncaughtException', (err) => {
  logger.error(`💥 Критическая ошибка (uncaughtException): ${err.message}`, { stack: err.stack });
  const msg = `⚠️ <b>Uncaught Exception</b>\n\n<pre>${String(err.message).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  // После необработанного исключения процесс в неопределённом состоянии
  // (для платёжного бота это опасно). Пытаемся уведомить админов и завершаемся -
  // платформа (Render и т.п.) поднимет чистый процесс.
  notif.sendToAdmins(msg, { parse_mode: 'HTML' })
    .catch(() => {})
    .finally(() => {
      setTimeout(() => process.exit(1), 1000); // даём время уйти сообщению
    });
});

main().catch((err) => {
  logger.error(`💥 Критическая ошибка при запуске: ${err.message}`);
  process.exit(1);
});

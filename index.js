require('dotenv').config();
const connectDB = require('./src/db/connect');
const createBot = require('./src/bot/index');
const currencyService = require('./src/services/currency.service');
const autoConfirmCron = require('./src/cron/autoConfirm');
const logger = require('./src/config/logger');
const { startHealthServer, stopHealthServer } = require('./src/bot/health-server');

const main = async () => {
  logger.info('🚀 Запуск бота...');

  // Подключение к MongoDB
  await connectDB();

  // Инициализация курса валют
  await currencyService.init();

  // Инициализация фоновых задач (Cron)
  autoConfirmCron.init();

  // Создаём и запускаем бота
  const bot = createBot();

  // HTTP health-server (нужен для Render + UptimeRobot). Запускаем ДО bot.launch(),
  // чтобы Render сразу увидел слушающий порт и не убил сервис по таймауту старта.
  const healthPort = parseInt(process.env.PORT, 10) || 3000;
  const healthServer = startHealthServer(healthPort);

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`⛔ Получен ${signal}, останавливаю бота...`);
    try {
      if (typeof bot.context?.__clearCronHandles === 'function') {
        await bot.context.__clearCronHandles();
      }
    } catch (_) {}
    try { bot.stop(signal); } catch (_) {}
    try { await stopHealthServer(healthServer); } catch (_) {}
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Запуск
  await bot.launch();
  logger.info('✅ Бот запущен и ждёт сообщений!');
};

// Глобальные обработчики ошибок для предотвращения падения процесса
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`💥 Необработанное исключение (unhandledRejection): ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`💥 Критическая ошибка (uncaughtException): ${err.message}`);
  // process.exit(1); // Опционально: если ошибка критичная, лучше падать, иначе - логгировать
});

main().catch((err) => {
  logger.error(`💥 Критическая ошибка при запуске: ${err.message}`);
  process.exit(1);
});

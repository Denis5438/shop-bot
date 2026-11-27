const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { BOT_TOKEN } = require('../config');
const logger = require('../config/logger');

// --- Scenes ---
const tokenCollectionScene = require('./scenes/token_collection.scene');

// Middlewares
const userMiddleware = require('./middlewares/user');
const i18nMiddleware = require('./middlewares/i18n');
const { authMiddleware, isAdminOrAbove } = require('./middlewares/auth');
const { tosMiddleware } = require('./middlewares/tos');
const sessionClearMiddleware = require('./middlewares/sessionClear');


const referralScene = require('./scenes/referral.scene');



// Services
const notif = require('../services/notification.service');
const supportNotify = require('../services/supportNotify.service');
const digest = require('../services/notification-digest.service');
const { getSettings, invalidateCache } = require('../services/settingsCache.service');
const { escapeHtml } = require('./utils/ui');

// Models & Core
const User = require('../models/User');
const Settings = require('../models/Settings');
const { createMongoSessionStore } = require('../models/TelegrafSession');

const createBot = () => {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан в .env');

  const bot = new Telegraf(BOT_TOKEN);

  // Установка бота в notification service
  notif.setBot(bot);
  supportNotify.setBot(bot);
  digest.setBot(bot);

  // Инициализация digest-режима из настроек БД (асинхронно, не блокируем запуск).
  (async () => {
    try {
      const settings = await getSettings();
      if (settings?.adminDigestEnabled) {
        digest.setDigestEnabled(true);
        const intervalMin = Math.max(1, settings.adminDigestIntervalMinutes || 60);
        digest.startAutoFlush(intervalMin * 60 * 1000);
      }
    } catch (err) {
      logger.warn(`[Digest init] failed to read settings: ${err.message}`);
    }
  })();

  // Session
  bot.use(session({
    store: createMongoSessionStore(),
    defaultSession: () => ({}),
  }));
  bot.use(sessionClearMiddleware());

  // Scenes (Stage)
  const stage = new Scenes.Stage([tokenCollectionScene]);
  bot.use(stage.middleware());

  // User / i18n / auth
  bot.use(userMiddleware);
  bot.use(i18nMiddleware);
  bot.use(authMiddleware);
  // ToS-гейт: должен идти ПОСЛЕ user/i18n (чтобы знать ctx.user и ctx.t)
  // и ДО любых сцен/обработчиков, иначе пользователь без согласия пройдёт мимо.
  bot.use(tosMiddleware);

  bot.use(async (ctx, next) => {
    const callbackData = ctx.callbackQuery?.data;

    if (callbackData === 'menu:referral') {
      await ctx.answerCbQuery().catch(() => {});
      try {
        await referralScene.showReferral(ctx);
      } catch (err) {
        logger.warn(`showReferral error: ${err.message}`);
        await ctx.reply('⚠️ Не удалось загрузить реферальную программу. Попробуйте позже.').catch(() => {});
      }
      return;
    }

    if (callbackData === 'topup:card_paid') {
      const topup = ctx.session?.topup;
      if (!topup || topup.method !== 'card') {
        await ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true }).catch(() => {});
        return;
      }

      topup.step = 'proof';
      await ctx.answerCbQuery('✅ Отлично! Пришлите скриншот чека.').catch(() => {});
      await ctx.editMessageText(
        `✅ <b>Оплата подтверждена</b>\n\n📸 Теперь пришлите <b>скриншот чека</b> для проверки оператором:`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'menu:topup')]]),
        }
      ).catch(() => {});
      return;
    }

    return next();
  });

  // Takeover interceptor (Live Takeover Mode)
  bot.use(async (ctx, next) => {
    if (!ctx.user) return next();

    // 1. Admin sends message during taking over somebody (only in private chat)
    if (
      ctx.chat?.type === 'private' &&
      ctx.session &&
      ctx.session.adminAction === 'takeover_chat' &&
      isAdminOrAbove(ctx.user) &&
      ctx.message?.text
    ) {
      const targetId = ctx.session.takeoverUserId;
      if (targetId) {
        try {
          const targetUser = await User.findOne({ telegramId: targetId });
          const targetLang = targetUser?.language || 'ru';
          const prefix = i18nMiddleware.translate(targetLang, 'support_operator_prefix');
          const safeText = escapeHtml(ctx.message.text);
          await ctx.telegram.sendMessage(targetId, `${prefix}${safeText}`, { parse_mode: 'HTML' });
        } catch (e) {}
        // DO NOT halt propagation if it's a specific admin stop command, but we'll use a callback button to stop.
        // Haulting normal bot logic so admin commands don't trigger
        return; 
      }
    }

    // 2. User is being taken over by an admin (only in private chat)
    if (ctx.chat?.type === 'private' && ctx.user.takeoverBy && ctx.message?.text) {
      // Авто-отмена перехвата через 30 минут
      const TAKEOVER_TIMEOUT = 30 * 60 * 1000;
      if (ctx.user.takeoverAt && (Date.now() - new Date(ctx.user.takeoverAt).getTime() > TAKEOVER_TIMEOUT)) {
        // updateOne вместо save(): документ может быть общим для параллельных
        // апдейтов (кэш middleware) - save() кинул бы ParallelSaveError
        ctx.user.takeoverBy = null;
        ctx.user.takeoverAt = null;
        await User.updateOne({ _id: ctx.user._id }, { $set: { takeoverBy: null, takeoverAt: null } });
        // Продолжаем обычную обработку
        return next();
      }
      try {
        const safeText = escapeHtml(ctx.message.text);
        await ctx.telegram.sendMessage(
          ctx.user.takeoverBy,
          `📨 <b>От @${escapeHtml(ctx.user.username || ctx.user.telegramId)}</b>:\n${safeText}\n\n<i>(Вы в режиме перехвата. Просто напишите ответное сообщение)</i>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {}
      return; // Halt normal bot logic for user
    }

    return next();
  });

  // ─────────────────── КРОНЫ ───────────────────
  // Храним handles интервалов, чтобы очищать их при остановке бота.
  // Логика кронов вынесена в src/cron/* (staleOrders, retryActivation,
  // referralReconcile) без изменения поведения.
  const cronHandles = [];
  cronHandles.push(require('../cron/staleOrders.cron').start(bot));
  cronHandles.push(require('../cron/retryActivation.cron').start(bot));
  cronHandles.push(require('../cron/referralReconcile.cron').start());
  cronHandles.push(require('../cron/bybitUidPoller.cron').start(bot));
  cronHandles.push(require('../cron/supportSla.cron').start(bot));

  require('./routes/admin_catalog.routes')(bot);

  // Экспортируем функцию очистки всех интервалов на объекте bot -
  // вызовется при SIGINT/SIGTERM из index.js.
  bot.context.__clearCronHandles = async () => {
    for (const h of cronHandles) {
      try { clearInterval(h); } catch (_) {}
    }
    cronHandles.length = 0;
    // Сбрасываем остатки буфера digest-режима (если что-то не успело уйти).
    try {
      digest.stopAutoFlush();
      await digest.flush();
    } catch (_) {}
  };

  // Миграция группового чата саппортов в супергруппу (group -> supergroup)
  bot.on('migrate_to_chat_id', async (ctx, next) => {
    try {
      const oldChatId = ctx.chat?.id;
      const newChatId = ctx.message?.migrate_to_chat_id;
      if (oldChatId && newChatId) {
        const settings = await getSettings();
        if (settings?.supportChatId && Number(settings.supportChatId) === Number(oldChatId)) {
          const updated = await Settings.findOneAndUpdate(
            { name: 'global' },
            {
              $set: {
                supportChatId: Number(newChatId),
                ...(ctx.chat?.title ? { supportChatTitle: ctx.chat.title } : {}),
              },
            },
            { new: true }
          );
          if (updated) invalidateCache(updated);
          else invalidateCache();
          logger.info(`[Bot] Чат саппортов мигрировал в супергруппу: ${oldChatId} -> ${newChatId}`);
        }
      }
    } catch (err) {
      logger.warn(`[Bot] migrate_to_chat_id handler error: ${err.message}`);
    }
    return next();
  });

  // ─────────────────── МАРШРУТЫ (вынесены в модули) ───────────────────
  // Порядок подключения повторяет прежний порядок регистрации хендлеров.
  require('./routes/core.routes')(bot);
  require('./routes/shop.routes')(bot);
  require('./routes/profile.routes')(bot);
  require('./routes/admin.routes')(bot);
  require('./routes/support.routes')(bot);
  require('./routes/support_admin.routes')(bot);
  require('./handlers/activation.handler')(bot);
  require('./routes/input.routes')(bot);
  require('./routes/webAuth.routes').registerWebAuthRoutes(bot);

  bot.telegram.getMe().then((botInfo) => {
    if (botInfo?.username) {
      try {
        require('../api/routes/auth.routes').setBotUsername(botInfo.username);
      } catch (_) {}
      try {
        supportNotify.setBotUsername(botInfo.username);
      } catch (_) {}
    }
  }).catch(() => {});

  if (typeof bot.telegram?.setMyCommands === 'function') {
    bot.telegram.setMyCommands([
      { command: 'start', description: '🏠 Главное меню' },
      { command: 'menu', description: '📋 Открыть меню' },
      { command: 'support', description: '🎧 Поддержка / Панель саппорта' },
      { command: 'code', description: '🔐 Код входа на сайт' },
      { command: 'seller', description: '🏪 Кабинет продавца' },
    ]).catch(() => {});
  }

  // Ошибки
  bot.catch((err, ctx) => {
    // Игнорируем ошибку просроченных инлайн-кнопок (при перезапусках бота)
    if (err.message && err.message.includes('query is too old')) return;

    logger.error(`❌ Ошибка бота: ${err.message}`, { stack: err.stack });

    // Оповещаем админов - через throttle, чтобы при массовом сбое (например,
    // недоступна БД) не заспамить админов и не упереться в лимит Telegram.
    const errorMsg = `⚠️ <b>Критическая ошибка в боте!</b>\n\n<pre>${escapeHtml(err.message)}</pre>`;
    notif.sendAdminAlertThrottled(errorMsg, { parse_mode: 'HTML' });

    ctx.reply('❌ Произошла ошибка. Попробуйте ещё раз.')
      .catch(() => { });
  });

  return bot;
};

module.exports = createBot;

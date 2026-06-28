const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { BOT_TOKEN } = require('../config');
const logger = require('../config/logger');

// --- Scenes ---
const tokenCollectionScene = require('./scenes/token_collection.scene');

// Middlewares
const userMiddleware = require('./middlewares/user');
const i18nMiddleware = require('./middlewares/i18n');
const { authMiddleware, adminMiddleware } = require('./middlewares/auth');
const { tosMiddleware, tosGateKeyboard, tosGateText, PRIVACY_URL, AGREEMENT_URL } = require('./middlewares/tos');

// Keyboards
const { mainKeyboard, languageKeyboard } = require('./keyboards/main.keyboard');
const { adminMainKeyboard } = require('./keyboards/admin.keyboard');

// User Scenes
const shopScene = require('./scenes/shop.scene');
const profileScene = require('./scenes/profile.scene');
const topupScene = require('./scenes/topup.scene');
const referralScene = require('./scenes/referral.scene');

// Admin Scenes
const adminScene = require('./scenes/admin/admin.scene');
const productsScene = require('./scenes/admin/products.scene');
const keysScene = require('./scenes/admin/keys.scene');
const ordersScene = require('./scenes/admin/orders.scene');
const usersScene = require('./scenes/admin/users.scene');
const paymentsScene = require('./scenes/admin/payments.scene');
const statsScene = require('./scenes/admin/stats.scene');
const settingsScene = require('./scenes/admin/settings.scene');
const sellerWithdrawalsScene = require('./scenes/admin/seller_withdrawals.scene');
const disputesScene = require('./scenes/admin/disputes.scene');
const buyerEscrowScene = require('./scenes/buyer_escrow.scene');

// User Seller cabinet
const sellerScene = require('./scenes/seller.scene');

// Services
const notif = require('../services/notification.service');
const digest = require('../services/notification-digest.service');
const { getSettings } = require('../services/settingsCache.service');
const { toRub } = require('../services/currency.service');
const { finishActivation, retryActivation } = require('../services/activation.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../services/referral.service');
const { withTransaction } = require('../services/transactionHelper.service');
const {
  buildKeyQueryForProduct,
  resolveOrderProvider,
} = require('../services/provider.service');
const { escapeHtml } = require('./utils/ui');

// Models & Core
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const Key = require('../models/Key');

const createBot = () => {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан в .env');

  const bot = new Telegraf(BOT_TOKEN);

  // Установка бота в notification service
  notif.setBot(bot);
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
  bot.use(session({ defaultSession: () => ({}) }));

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

    // 1. Admin sends message during taking over somebody
    if (ctx.session && ctx.session.adminAction === 'takeover_chat' && ctx.user.role === 'admin' && ctx.message?.text) {
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

    // 2. User is being taken over by an admin
    if (ctx.user.takeoverBy && ctx.message?.text) {
      // Авто-отмена перехвата через 30 минут
      const TAKEOVER_TIMEOUT = 30 * 60 * 1000;
      if (ctx.user.takeoverAt && (Date.now() - new Date(ctx.user.takeoverAt).getTime() > TAKEOVER_TIMEOUT)) {
        ctx.user.takeoverBy = null;
        ctx.user.takeoverAt = null;
        await ctx.user.save();
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

  // ─────────────────── АВТО-ОТМЕНА ───────────────────
  // Храним handles интервалов, чтобы очищать их при остановке бота.
  const cronHandles = [];

  // Каждую минуту проверяем заказы старше 30 минут
  cronHandles.push(setInterval(async () => {
    try {
      // Если нет активного подключения к БД — пропускаем итерацию
      if (mongoose.connection.readyState !== 1) return;

      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
      const staleOrders = await Order.find({ status: 'awaiting_token', createdAt: { $lt: thirtyMinsAgo } });

      for (const order of staleOrders) {
        let cancelledOrder = null;
        let refundedUser = null;

        await withTransaction(async (session) => {
          const sessionOptions = session ? { session } : undefined;

          cancelledOrder = await Order.findOneAndUpdate(
            { _id: order._id, status: 'awaiting_token' },
            {
              $set: {
                status: 'cancelled',
                activationResult: 'Авто-отмена (таймаут)',
                nextRetryAt: null,
              },
            },
            { new: true, ...sessionOptions }
          );

          if (!cancelledOrder) return;

          refundedUser = await User.findById(cancelledOrder.userId, null, sessionOptions);
          if (refundedUser) {
            refundedUser.balance = parseFloat((refundedUser.balance + cancelledOrder.price).toFixed(8));
            await refundedUser.save(sessionOptions);
          }

          await new Transaction({
            userId: cancelledOrder.userId,
            type: 'refund',
            amount: cancelledOrder.price,
            orderId: cancelledOrder._id,
            description: 'Авто-отмена: истекло время ожидания токена',
          }).save(sessionOptions);

          await Key.updateOne(
            { usedByOrder: cancelledOrder._id },
            { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
            sessionOptions
          );
        });

        if (!cancelledOrder) continue;

        if (refundedUser) {
          bot.telegram.sendMessage(
            refundedUser.telegramId,
            `⏳ <b>Время ожидания токена истекло (30 мин)!</b>\n\nВаш заказ <code>${cancelledOrder._id}</code> был автоматически отменён.\n💰 Средства возвращены на баланс.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        logger.warn(`Пропуск авто-отмены: временная проблема с сетью (ошибка DNS).`);
      } else {
        logger.error(`Ошибка авто-отмены заказов: ${err.message}`);
      }
    }
  }, 60_000));

  // ─────────────────── RETRY АКТИВАЦИИ ───────────────────
  // Каждую минуту проверяем заказы в статусе retry с наступившим nextRetryAt.
  // Внутренний хелпер атомарно делает rollback (статус→failed, возврат
  // баланса, проводка Transaction, освобождение ключа) одной транзакцией —
  // защищает от частичных state'ов при падении процесса между шагами.
  const failOrderWithRefund = async (orderId, reason, txDescription) => {
    let cancelledOrder = null;
    let user = null;

    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      cancelledOrder = await Order.findOneAndUpdate(
        { _id: orderId, status: { $nin: ['completed', 'cancelled', 'failed'] } },
        {
          $set: {
            status: 'failed',
            activationResult: reason,
            nextRetryAt: null,
          },
        },
        { new: true, ...sessionOptions }
      );

      if (!cancelledOrder) return;

      user = await User.findById(cancelledOrder.userId, null, sessionOptions);
      if (user) {
        user.balance = parseFloat((user.balance + cancelledOrder.price).toFixed(8));
        await user.save(sessionOptions);
      }

      await new Transaction({
        userId: cancelledOrder.userId,
        type: 'refund',
        amount: cancelledOrder.price,
        orderId: cancelledOrder._id,
        description: txDescription,
      }).save(sessionOptions);

      await Key.updateOne(
        { usedByOrder: cancelledOrder._id },
        { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
        sessionOptions
      );
    });

    return { cancelledOrder, user };
  };

  // Guard: предотвращаем наложение итераций retry-крона при лагах БД/API.
  // Если предыдущий тик ещё работает — пропускаем текущий.
  let retryCronBusy = false;
  cronHandles.push(setInterval(async () => {
    if (retryCronBusy) return;
    retryCronBusy = true;
    try {
      if (mongoose.connection.readyState !== 1) return;
      const MAX_RETRIES = 3;

      const now = new Date();
      const retryOrders = await Order.find({
        status: 'retry',
        nextRetryAt: { $lte: now },
      }).populate('productId');

      for (const order of retryOrders) {
        // Перечитываем — статус мог измениться
        const fresh = await Order.findById(order._id).populate('productId');
        if (!fresh || fresh.status !== 'retry') continue;
        const provider = resolveOrderProvider(fresh, fresh.productId);

        const key = await Key.findById(fresh.keyId);

        // Нет ключа или токена — фейлим атомарно
        if (!key || !fresh.tokenRaw) {
          const { user } = await failOrderWithRefund(
            fresh._id,
            'Retry: потерян ключ или токен',
            'Автовозврат: потерян ключ при retry'
          );
          if (user) {
            bot.telegram.sendMessage(
              user.telegramId,
              `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать. Средства возвращены.`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          continue;
        }

        // Нет apiOrderId — нельзя повторить шаг 2, фейлим
        if (!fresh.apiOrderId) {
          await failOrderWithRefund(
            fresh._id,
            `Retry: нет api_order_id для повторной попытки`,
            'Автовозврат: нет api_order_id при retry'
          );
          continue;
        }

        const apiOrderId = fresh.apiOrderId;

        try {
          const result = await retryActivation(provider, apiOrderId, fresh.tokenRaw);

          if (result.success) {
            fresh.status = 'completed';
            fresh.provider = provider;
            fresh.activationResult = `api_order_id: ${apiOrderId} (retry OK, попытка ${fresh.retryCount})`;
            fresh.nextRetryAt = null;
            await fresh.save();

            const user = await User.findById(fresh.userId);
            if (user) {
              await notif.notifyUserOrderCompleted(user, fresh, fresh.productId, 'Активация завершена после повторной попытки!');
              await grantReferralBonusForFirstCompletedOrder(user._id);
            }
            await notif.sendToAdmins(
              `✅ <b>Retry-активация успешна</b>\n📋 Заказ: <code>${fresh._id}</code> (попытка ${fresh.retryCount})`
            );
          } else {
            // Снова ошибка — увеличиваем retryCount
            const canRetry = result.retryable !== false;
            if (!canRetry || fresh.retryCount >= MAX_RETRIES) {
              const { user } = await failOrderWithRefund(
                fresh._id,
                `После ${MAX_RETRIES} попыток (retry): ${result.message}`,
                `Автовозврат: ${MAX_RETRIES} retry попыток исчерпаны`
              );
              if (user) {
                bot.telegram.sendMessage(
                  user.telegramId,
                  `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать после ${MAX_RETRIES} попыток. Средства возвращены.`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            } else {
              // Планируем следующий retry
              fresh.retryCount += 1;
              fresh.nextRetryAt = new Date(Date.now() + 5 * 60 * 1000);
              fresh.activationResult = result.message;
              await fresh.save();
              logger.info(`[Retry] Заказ ${fresh._id}: попытка ${fresh.retryCount}/${MAX_RETRIES} отложена`);
            }
          }
        } catch (err) {
          logger.error(`[Retry] Критическая ошибка для заказа ${fresh._id}: ${err.message}`);
          const nextCount = (fresh.retryCount || 0) + 1;
          if (nextCount >= MAX_RETRIES) {
            const { user } = await failOrderWithRefund(
              fresh._id,
              `После ${MAX_RETRIES} попыток (retry exception): ${err.message}`,
              `Автовозврат: ${MAX_RETRIES} retry попыток исчерпаны (exception)`
            );
            if (user) {
              bot.telegram.sendMessage(
                user.telegramId,
                `❌ <b>Ошибка активации</b>\n\nЗаказ <code>${fresh._id}</code> не удалось активировать. Средства возвращены.`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } else {
            // Откладываем retry
            fresh.retryCount = nextCount;
            fresh.nextRetryAt = new Date(Date.now() + 5 * 60 * 1000);
            await fresh.save();
          }
        }
      }
    } catch (err) {
      logger.error(`Ошибка retry-крона: ${err.message}`);
    } finally {
      retryCronBusy = false;
    }
  }, 60_000));

  // ─────────────────── КОМАНДЫ ───────────────────

  cronHandles.push(setInterval(async () => {
    try {
      if (mongoose.connection.readyState !== 1) return;

      const referredUsers = await User.find({
        referredBy: { $ne: null },
        referralBonusGrantedAt: null,
      }).select('_id');

      for (const user of referredUsers) {
        await grantReferralBonusForFirstCompletedOrder(user._id);
      }
    } catch (err) {
      logger.error(`Ошибка reconcile реферальных бонусов: ${err.message}`);
    }
  }, 60_000));

  // Экспортируем функцию очистки всех интервалов на объекте bot —
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

  bot.start(async (ctx) => {
    const user = ctx.user;
    const t = ctx.t;

    // Если первый раз — предлагаем выбрать язык
    if (!user) {
      return ctx.reply('⚠️ Не удалось загрузить профиль. Попробуйте позже или обратитесь в поддержку.').catch(() => {});
    }

    // ToS-гейт: пока не принял — показываем экран согласия. Админы пропущены
    // на уровне tosMiddleware, но дублируем условие здесь для надёжности.
    if (!user.acceptedToS && user.role !== 'admin') {
      return ctx.reply(tosGateText(t), { parse_mode: 'HTML', ...tosGateKeyboard(t) });
    }

    const isNew = Date.now() - new Date(user.createdAt).getTime() < 5000;

    if (isNew) {
      return ctx.reply('🌐 Выберите язык / Choose language:', languageKeyboard());
    }

    await ctx.reply(
      t('welcome_back', { name: user.firstName, balance: user.balance.toFixed(2), balanceRub: toRub(user.balance) }),
      { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
    );
  });

  // ─────────────────── ToS: согласие / отказ ───────────────────
  bot.action('tos:accept', async (ctx) => {
    const t = ctx.t;
    if (ctx.user && !ctx.user.acceptedToS) {
      ctx.user.acceptedToS = true;
      ctx.user.acceptedToSAt = new Date();
      await ctx.user.save().catch((err) => logger.error(`tos:accept save: ${err.message}`));
    }
    await ctx.answerCbQuery(t('tos_accepted_alert')).catch(() => {});
    try {
      await ctx.editMessageText(
        t('welcome_back', {
          name: escapeHtml(ctx.user.firstName),
          balance: ctx.user.balance.toFixed(2),
          balanceRub: toRub(ctx.user.balance),
        }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      );
    } catch (_) {
      await ctx.reply(
        t('welcome_back', {
          name: escapeHtml(ctx.user.firstName),
          balance: ctx.user.balance.toFixed(2),
          balanceRub: toRub(ctx.user.balance),
        }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      ).catch(() => {});
    }
  });

  bot.action('tos:decline', async (ctx) => {
    const t = ctx.t;
    await ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.editMessageText(t('tos_declined'), { parse_mode: 'HTML' });
    } catch (_) {
      await ctx.reply(t('tos_declined'), { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ─── BUYER ESCROW ────────────────────────────────────────────────────────────
  bot.action(/^buyer:confirm_order:(.+)$/, async (ctx) => {
    await buyerEscrowScene.confirmOrder(ctx, ctx.match[1]);
  });

  bot.action(/^buyer:dispute_order:(.+)$/, async (ctx) => {
    await buyerEscrowScene.disputeOrder(ctx, ctx.match[1]);
  });

  // ─────────────────── ДОКУМЕНТЫ ───────────────────
  bot.action('menu:documents', async (ctx) => {
    const t = ctx.t;
    await ctx.answerCbQuery().catch(() => {});
    const lines = [
      t('documents_title'),
      '',
      t('documents_text'),
    ];
    if (ctx.user?.acceptedToSAt) {
      lines.push('');
      lines.push(t('documents_accepted_at', {
        date: new Date(ctx.user.acceptedToSAt).toLocaleString('ru-RU'),
      }));
    }
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(t('tos_privacy'), PRIVACY_URL)],
      [Markup.button.url(t('tos_agreement'), AGREEMENT_URL)],
      [Markup.button.callback(t('btn_back'), 'menu:main')],
    ]);
    try {
      await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', ...keyboard });
    } catch (_) {
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...keyboard }).catch(() => {});
    }
  });

  bot.command('admin', adminMiddleware, async (ctx) => {
    await adminScene.showAdminMain(ctx);
  });

  // ─── SELLER: Кабинет продавца ───
  bot.command('seller', async (ctx) => {
    await sellerScene.showSellerCabinet(ctx);
  });

  bot.action('seller:cabinet', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerCabinet(ctx);
  });

  bot.action('seller:orders', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'active');
  });

  bot.action('seller:orders:active', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'active');
  });

  bot.action('seller:orders:history', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'history');
  });

  bot.action(/^seller:order:complete:(.+)$/, async (ctx) => {
    await sellerScene.completeSellerOrder(ctx, ctx.match[1]);
  });

  bot.action('seller:wallet:setup', async (ctx) => {
    await sellerScene.startWalletSetup(ctx);
  });

  bot.action(/^seller:wallet:net:(.+)$/, async (ctx) => {
    await sellerScene.handleWalletNetworkChoice(ctx, ctx.match[1]);
  });

  bot.action('seller:withdraw:start', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.startWithdraw(ctx);
  });

  bot.action('seller:withdraw:all', async (ctx) => {
    await sellerScene.handleWithdrawAll(ctx);
  });

  bot.action(/^seller:withdraw:confirm:([\d.]+)$/, async (ctx) => {
    await sellerScene.confirmWithdraw(ctx, ctx.match[1]);
  });

  bot.action('seller:noop', (ctx) => ctx.answerCbQuery());

  // ─────────────────── ЯЗЫК ───────────────────
  bot.action('lang:ru', async (ctx) => {
    ctx.user.language = 'ru';
    await ctx.user.save();
    await ctx.answerCbQuery('✅ Язык: Русский');
    await ctx.editMessageText(
      `🏪 <b>Добро пожаловать, ${escapeHtml(ctx.user.firstName)}!</b>\n\n` +
      `💡 <b>Быстрый старт:</b>\n` +
      `🛒 <b>Магазин</b> — выберите товар и оплатите с баланса\n` +
      `💰 <b>Пополнить</b> — карта, USDT (TRC-20/BEP-20), Bybit UID\n` +
      `👤 <b>Профиль</b> — баланс, заказы, реферальный код\n\n` +
      `💰 Баланс: ${ctx.user.balance.toFixed(2)} USDT (~${toRub(ctx.user.balance)} ₽)`,
      { parse_mode: 'HTML', ...mainKeyboard(ctx.t, ctx.isSeller) }
    ).catch(() => {});
  });

  bot.action('lang:en', async (ctx) => {
    ctx.user.language = 'en';
    await ctx.user.save();
    await ctx.answerCbQuery('✅ Language: English');
    await ctx.editMessageText(
      `🏪 <b>Welcome, ${escapeHtml(ctx.user.firstName)}!</b>\n\n` +
      `💡 <b>Quick start:</b>\n` +
      `🛒 <b>Shop</b> — pick a product & pay from balance\n` +
      `💰 <b>Top up</b> — card, USDT (TRC-20/BEP-20), Bybit UID\n` +
      `👤 <b>Profile</b> — balance, orders, referral code\n\n` +
      `💰 Balance: ${ctx.user.balance.toFixed(2)} USDT (~${toRub(ctx.user.balance)} ₽)`,
      { parse_mode: 'HTML', ...mainKeyboard(ctx.t, ctx.isSeller) }
    ).catch(() => {});
  });

  // Кнопка «Сменить язык» из главного меню
  bot.action('menu:lang', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🌐 <b>Выберите язык / Choose language:</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🇷🇺 Русский', 'lang:ru'), Markup.button.callback('🇬🇧 English', 'lang:en')],
          [Markup.button.callback('⬅️ Назад', 'menu:main')],
        ]),
      }
    ).catch(() => {});
  });

  // ─────────────────── ГЛАВНОЕ МЕНЮ ───────────────────
  bot.action('menu:main', async (ctx) => {
    await ctx.answerCbQuery();
    const t = ctx.t;
    try {
      await ctx.editMessageText(
        t('welcome_back', { name: escapeHtml(ctx.user.firstName), balance: ctx.user.balance.toFixed(2), balanceRub: toRub(ctx.user.balance) }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      );
    } catch (_) {
      await ctx.reply(
        t('welcome_back', { name: escapeHtml(ctx.user.firstName), balance: ctx.user.balance.toFixed(2), balanceRub: toRub(ctx.user.balance) }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      );
    }
  });

  bot.action('menu:shop', async (ctx) => {
    await shopScene.showShopPage(ctx, 1);
  });

  bot.action('menu:profile', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showProfile(ctx);
  });

  bot.action('menu:topup', async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.startTopup(ctx);
  });

  // Быстрое пополнение на нужную сумму (из карточки товара при нехватке средств)
  bot.action(/^topup:quick:([\d.]+)$/, async (ctx) => {
    const amount = parseFloat(ctx.match[1]);
    if (!amount || amount <= 0) {
      return ctx.answerCbQuery('⚠️ Некорректная сумма', { show_alert: true });
    }
    await ctx.answerCbQuery();
    await topupScene.startTopupWithAmount(ctx, amount);
  });

  // ─────────────────── ПОПОЛНЕНИЕ — выбор способа ───────────────────
  // Авто-оплата (стаб) — ничего не делаем
  bot.action('topup:auto_stub', (ctx) => ctx.answerCbQuery('⚠️ Временно недоступно', { show_alert: true }));

  // Прямой перевод
  bot.action('topup:method:direct', async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.showDirectOptions(ctx);
  });

  // Назад (к выбору платёжной системы)
  bot.action('topup:pay:back', async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.showDirectOptions(ctx);
  });

  // Карта
  bot.action('topup:pay:card', async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.showCardDetails(ctx);
  });

  // Bybit — выбор сети
  bot.action('topup:pay:bybit', async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.showBybitOptions(ctx);
  });

  // Bybit — конкретная сеть
  bot.action(/^topup:network:(trc20|bep20|uid)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await topupScene.showBybitNetwork(ctx, ctx.match[1]);
  });



  // UX-1: быстрые пресеты сумм на экране ввода.
  bot.action(/^topup:preset:(usdt|rub):(\d+(?:\.\d+)?)$/, async (ctx) => {
    await topupScene.handlePresetAmount(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action('topup:enter_txid', async (ctx) => {
    await topupScene.handleEnterTxid(ctx);
  });

  // «Я оплатил» — подтверждение оплаты картой
  bot.action('topup:card_paid', async (ctx) => {
    const topup = ctx.session?.topup;
    if (!topup || topup.method !== 'card') {
      return ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true });
    }
    if (topup.step === 'proof') {
      return ctx.answerCbQuery('✅ Уже ожидаем скриншот чека');
    }
    topup.step = 'proof';
    await ctx.answerCbQuery('✅ Отлично! Пришлите скриншот чека.');
    await ctx.editMessageText(
      `✅ <b>Оплата подтверждена!</b>\n\n📸 Теперь пришлите <b>скриншот чека</b> для проверки оператором:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'menu:topup')]]),
      }
    ).catch(() => {});
  });

  bot.action('menu:support', async (ctx) => {
    await ctx.answerCbQuery();
    const t = ctx.t;
    const lang = ctx.user?.language || 'ru';
    const { TEXTS } = require('./constants/ux');
    const supportLink = TEXTS.SUPPORT_URL;
    const btnLabel = lang === 'en' ? '✉️ Write to Support' : '✉️ Написать поддержке';

    try {
      await ctx.editMessageText(
        t('support_text'),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url(btnLabel, supportLink)],
            [Markup.button.callback(t('btn_back'), 'menu:main')],
          ]),
        }
      );
    } catch (_) { }
  });

  bot.action('menu:about', async (ctx) => {
    await ctx.answerCbQuery();
    const t = ctx.t;

    try {
      await ctx.editMessageText(
        t('about_text'),
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:main')]]),
        }
      );
    } catch (_) { }
  });

  // ─────────────────── МАГАЗИН ───────────────────
  bot.action(/^shop:page:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await shopScene.showShopPage(ctx, page);
  });

  // Формат: shop:product:<id>:<page?> — page опционален для обратной совместимости.
  bot.action(/^shop:product:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.showProduct(ctx, productId, page);
  });

  bot.action(/^shop:buy:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.confirmPurchase(ctx, productId, page);
  });

  bot.action(/^shop:confirm:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.processPurchase(ctx, productId, page);
  });

  bot.action('shop:noop', (ctx) => ctx.answerCbQuery());

  // Бесплатная проверка токена до оплаты (№6 Auto-token verification)
  bot.action(/^shop:check_token:(.+)$/, async (ctx) => {
    const productId = ctx.match[1];
    const t = ctx.t || ((k) => k);
    ctx.session = ctx.session || {};
    ctx.session.tokenCheck = {
      productId,
      startedAt: Date.now(),
    };
    await ctx.answerCbQuery().catch(() => {});
    const text =
      `${t('token_check_title')}\n\n` +
      `${t('token_check_intro')}\n\n` +
      `${t('token_check_how_to')}`;
    const opts = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t('btn_cancel'), `shop:check_token_cancel:${productId}`)],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts);
    }
  });

  bot.action(/^shop:check_token_cancel:(.+)$/, async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.tokenCheck = null;
    await ctx.answerCbQuery('❌ Отменено').catch(() => {});
    await shopScene.showProduct(ctx, ctx.match[1]);
  });

  // ─────────────────── ПРОФИЛЬ ───────────────────
  bot.action('profile:orders', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showOrders(ctx, 'all', 1);
  });

  bot.action(/^profile:orders:(active|all):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showOrders(ctx, ctx.match[1], parseInt(ctx.match[2]));
  });

  // №20 Достижения
  bot.action('profile:achievements', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showAchievements(ctx);
  });

  bot.action(/^profile:continue_order:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('▶️ Продолжаю...');
    const orderId = ctx.match[1];
    const Order = require('../models/Order');
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'awaiting_token') {
      return ctx.reply('❌ Заказ уже не активен.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В профиль', 'menu:profile')]]),
      });
    }
    await ctx.scene.enter('token_collection', { orderId: orderId.toString() });
  });

  bot.action('profile:lang', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showLanguageSelect(ctx);
  });

  // ─────────────────── ADMIN — ГЛАВНОЕ МЕНЮ ───────────────────
  bot.action('admin:main', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await adminScene.showAdminMain(ctx);
  });

  // ─── ADMIN: Товары ───
  bot.action('admin:products', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await productsScene.showProductsList(ctx);
  });

  bot.action('admin:product:add', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await productsScene.startAddProduct(ctx);
  });

  bot.action(/^admin:product:edit:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.showProductEdit(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:toggle:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.toggleProduct(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:delete_confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.confirmDeleteProduct(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.deleteProduct(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:clone:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.cloneProduct(ctx, ctx.match[1]);
  });

  // Рассылка нового товара — сначала экран выбора сегмента (№16).
  bot.action(/^admin:product:broadcast:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const Product = require('../models/Product');
    const product = await Product.findById(productId);
    if (!product) return ctx.reply('❌ Товар не найден');

    // Собираем количество пользователей в каждом сегменте параллельно
    const counts = await Promise.all(
      notif.SEGMENTS.map((s) => notif.countSegment(s.key))
    );

    const SEGMENT_LABELS = {
      all:          'Все активные',
      vip:          'VIP (50+ USDT)',
      active:       'Активные (30 дней)',
      inactive:     'Уснувшие (30+ дней без покупок)',
      new:          'Новички (< 7 дней)',
      no_purchases: 'Без покупок',
    };

    const rows = notif.SEGMENTS.map((s, i) => [
      Markup.button.callback(
        `${s.icon} ${SEGMENT_LABELS[s.key]} — ${counts[i]}`,
        `admin:broadcast:${productId}:${s.key}`
      ),
    ]);
    rows.push([Markup.button.callback('❌ Отмена', 'admin:products')]);

    const text =
      `📢 <b>Рассылка товара</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n\n` +
      `<blockquote>Выберите сегмент получателей. Число рядом — это сколько людей в сегменте.</blockquote>`;

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    }
  });

  // Запуск рассылки на конкретный сегмент (после выбора в предыдущем хэндлере).
  bot.action(/^admin:broadcast:([^:]+):(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery('📢 Запускаю рассылку...');
    await ctx.editMessageReplyMarkup(null).catch(() => {});

    const productId = ctx.match[1];
    const segment = ctx.match[2];
    const Product = require('../models/Product');
    const Key = require('../models/Key');

    const product = await Product.findById(productId);
    if (!product) return ctx.reply('❌ Товар не найден');

    const stock = product.type === 'manual'
      ? '∞'
      : await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));

    const { label } = await notif.buildSegmentQuery(segment);
    const totalInSegment = await notif.countSegment(segment);

    await ctx.editMessageText(
      `📢 <b>Рассылка запущена...</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n\n` +
      `🎯 Сегмент: <b>${escapeHtml(label)}</b>\n` +
      `👥 Получателей: <b>${totalInSegment}</b>\n\n` +
      `<blockquote>⏳ Примерно ${Math.ceil((totalInSegment * 50) / 1000)} сек на отправку.\nПодождите...</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    const { sent, failed } = await notif.broadcastNewProduct(product, stock, segment);

    await ctx.reply(
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `🎯 Сегмент: <b>${label}</b>\n` +
      `📤 Отправлено: <b>${sent}</b>\n` +
      `❌ Ошибок: <b>${failed}</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('📦 К товарам', 'admin:products')]]),
      }
    );
  });

  bot.action(/^admin:product:field:(\w+):(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminAction = 'edit_product_field';
    ctx.session.field = ctx.match[1];
    ctx.session.productId = ctx.match[2];
    await ctx.reply(`✏️ Введите новое значение для поля <b>${ctx.match[1]}</b>:`, { parse_mode: 'HTML' });
  });

  bot.action(/^admin:product:type:(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.session.newProduct) {
      await ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true }).catch(() => {});
      return;
    }
    const type = ctx.match[1];
    ctx.session.newProduct.type = type;
    // Поставщик выбирается автоматически в handleProductInput — шаг выбора убран
    await productsScene.askNameForNewProduct(ctx, type);
  });

  // ─── ADMIN: Ключи ───
  bot.action('admin:keys', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await keysScene.showKeysList(ctx);
  });

  bot.action(/^admin:keys:add:(.+)$/, adminMiddleware, async (ctx) => {
    await keysScene.startAddKeys(ctx, ctx.match[1]);
  });

  bot.action(/^admin:keys:clear:(.+)$/, adminMiddleware, async (ctx) => {
    await keysScene.clearUsedKeys(ctx, ctx.match[1]);
  });

  bot.action('admin:noop', (ctx) => ctx.answerCbQuery());

  // ─── ADMIN: Заказы ───
  bot.action('admin:orders', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await ordersScene.showOrdersList(ctx, 'active');
  });

  bot.action(/^admin:orders:([a-zA-Z0-9_]+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await ordersScene.showOrdersList(ctx, ctx.match[1], parseInt(ctx.match[2] || 1));
  });

  bot.action(/^admin:order:(.{24})$/, adminMiddleware, async (ctx) => {
    await ordersScene.showOrderDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:activate:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.confirmAndActivate(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:complete:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.completeOrderManually(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:cancel:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.cancelOrder(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Пользователи ───
  bot.action('admin:users', adminMiddleware, async (ctx) => {
    // Показываем список всех пользователей
    await usersScene.showAllUsers(ctx, 1);
  });

  // Пагинация списка пользователей
  bot.action(/^admin:users:page:(\d+)$/, adminMiddleware, async (ctx) => {
    await usersScene.showAllUsers(ctx, parseInt(ctx.match[1]));
  });

  // Глобальный поиск (отдельная кнопка)
  bot.action('admin:search', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.showGlobalSearch(ctx);
  });

  bot.action(/^admin:user:view:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.showUserProfile(ctx, ctx.match[1]);
  });

  bot.action(/^admin:user:balance:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.startChangeBalance(ctx, ctx.match[1]);
  });

  bot.action(/^admin:user:(ban|unban):(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.toggleBan(ctx, ctx.match[2]);
  });

  bot.action(/^admin:user:(promote|demote):(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.toggleRole(ctx, ctx.match[2]);
  });

  bot.action(/^admin:user:txs:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.showUserTransactions(ctx, ctx.match[1]);
  });

  bot.action(/^admin:takeover:start:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.startTakeover(ctx, ctx.match[1]);
  });

  bot.action(/^admin:takeover:stop:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.stopTakeover(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Платежи ───
  bot.action('admin:payments', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await paymentsScene.showPaymentsList(ctx);
  });

  bot.action(/^admin:payment:(.{24})$/, adminMiddleware, async (ctx) => {
    await paymentsScene.showPaymentDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.confirmPayment(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:approve:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.approvePayment(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:edit_amount:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.editPaymentAmount(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:reject:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.rejectPayment(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Продавцы ───
  bot.action('admin:sellers:withdrawals', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showWithdrawalsList(ctx);
  });

  bot.action('admin:sellers:withdrawals:history', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showWithdrawalsHistory(ctx);
  });

  bot.action(/^admin:sellers:withdrawal:(.{24})$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.showWithdrawalDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:withdrawal:confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.confirmWithdrawal(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:withdrawal:reject:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.rejectWithdrawal(ctx, ctx.match[1]);
  });

  bot.action('admin:sellers:list', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showSellersList(ctx);
  });

  bot.action('admin:sellers:add', adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.startAddSeller(ctx);
  });

  bot.action(/^admin:sellers:view:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.showSellerProfile(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:toggle:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.toggleSeller(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:balance:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.startEditSellerBalance(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.deleteSeller(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Назначение продавца на товар ───
  bot.action(/^admin:product:seller:(.{24})$/, adminMiddleware, async (ctx) => {
    await productsScene.askSellerForProduct(ctx, ctx.match[1]);
  });

  bot.action(/^adm:ps:p:(.+):(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.pickSellerForProduct(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^admin:product:seller:manual:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.askManualSellerInput(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:seller:remove:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.removeSellerFromProduct(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Споры (Disputes) ────────────────────────────────────────────────
  bot.action(/^admin:disputes:list$/, adminMiddleware, async (ctx) => {
    await disputesScene.listDisputes(ctx, 1);
  });
  bot.action(/^admin:disputes:page:(\d+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.listDisputes(ctx, parseInt(ctx.match[1]));
  });
  bot.action(/^admin:disputes:view:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.viewDispute(ctx, ctx.match[1]);
  });
  bot.action(/^admin:disputes:refund:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.resolveRefundBuyer(ctx, ctx.match[1]);
  });
  bot.action(/^admin:disputes:pay:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.resolvePaySeller(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Статистика ───
  bot.action('admin:stats', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showStats(ctx);
  });

  bot.action('admin:chart', adminMiddleware, async (ctx) => {
    await statsScene.showSalesChart(ctx);
  });

  // ─── ADMIN: Логистика ───
  bot.action('admin:logistics', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showLogistics(ctx, 'month', 'USDT');
  });

  bot.action(/^admin:logistics:(\w+):(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showLogistics(ctx, ctx.match[1], ctx.match[2]);
  });

  // ─── ADMIN: Настройки ───
  bot.action('admin:settings', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await settingsScene.showSettings(ctx);
  });

  bot.action('admin:settings:toggle_maintenance', adminMiddleware, async (ctx) => {
    await settingsScene.toggleMaintenance(ctx);
  });

  bot.action('admin:settings:toggle_smart_pricing', adminMiddleware, async (ctx) => {
    await settingsScene.toggleSmartPricing(ctx);
  });

  bot.action('admin:settings:toggle_markdown', adminMiddleware, async (ctx) => {
    await settingsScene.toggleMarkdown(ctx);
  });

  bot.action('admin:settings:toggle_digest', adminMiddleware, async (ctx) => {
    await settingsScene.toggleDigest(ctx);
  });

  bot.action(/^admin:settings:edit:(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await settingsScene.startEditSetting(ctx, ctx.match[1]);
  });

  bot.action('admin:settings:refresh_rate', adminMiddleware, async (ctx) => {
    await settingsScene.refreshRate(ctx);
  });

  // ─── ADMIN: Написать пользователю ───
  bot.action(/^admin:msg:user:(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminAction = 'send_message';
    ctx.session.targetTelegramId = parseInt(ctx.match[1]);
    await ctx.reply(`📨 Введите сообщение для пользователя <code>${ctx.match[1]}</code>:`, {
      parse_mode: 'HTML',
      ...require('telegraf').Markup.inlineKeyboard([[require('telegraf').Markup.button.callback('❌ Отмена', 'admin:main')]]),
    });
  });


  // ─────────────────── АКТИВАЦИЯ: Подтверждение email ───────────────────
  bot.action(/^activation:confirm:(yes|no):(.+)$/, async (ctx) => {
    const isYes = ctx.match[1] === 'yes';
    const dbOrderId = ctx.match[2];

    await ctx.answerCbQuery(isYes ? '⏳ Завершаю активацию...' : '⏳ Отменяю...');
    await ctx.editMessageReplyMarkup(null).catch(() => { });

    const pending = ctx.session?.pendingActivation;

    // Защита: если данные потеряны (перезапуск бота и т.п.)
    if (!pending || pending.dbOrderId !== dbOrderId) {
      return ctx.reply('❌ Сессия активации истекла. Пожалуйста, начните покупку заново.');
    }

    const Order = require('../models/Order');
    const Key = require('../models/Key');
    const Transaction = require('../models/Transaction');

    const order = await Order.findById(dbOrderId).populate('productId');

    if (isYes) {
      // ── Шаг 2: Привязываем токен ──
      const progressBar = (pct) => {
        const filled = Math.round(pct / 10);
        const empty = 10 - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
      };
      const step2Msg = await ctx.reply(
        `⚙️ <b>Шаг 2 из 2</b> — Привязка токена...\n${progressBar(10)} 🔄 Запускаю привязку...`,
        { parse_mode: 'HTML' }
      );

      let animDots = 0;
      let animIndex = 0;
      const animStates = [
          `${progressBar(40)} 🔄 Отправка токена в сервис`,
          `${progressBar(70)} ⏳ Ожидание подтверждения`,
          `${progressBar(90)} ⚙️ Финализация настроек аккаунта`
      ];
      const animInterval = setInterval(() => {
        if (animIndex >= animStates.length) return;
        animDots = (animDots + 1) % 4;
        const dotStr = '.'.repeat(animDots);
        ctx.telegram.editMessageText(
          ctx.chat.id, step2Msg.message_id, null,
          `⚙️ <b>Шаг 2 из 2</b> — Привязка токена...\n${animStates[animIndex]}${dotStr}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        if (animDots === 3) animIndex++;
      }, 1200);

      const provider = pending.provider || resolveOrderProvider(order, order.productId);
      const result = await finishActivation(provider, pending.apiOrderId, pending.token);
      ctx.session.pendingActivation = null;

      clearInterval(animInterval);

      if (result.success) {
        order.status = 'completed';
        order.provider = provider;
        order.apiOrderId = pending.apiOrderId;
        order.activationResult = `api_order_id: ${pending.apiOrderId}`;
        await order.save();

        await ctx.telegram.editMessageText(
          ctx.chat.id, step2Msg.message_id, null,
          `🎉 <b>Активация завершена!</b>\n\n` +
          `<blockquote>✅ Шаг 2 из 2 — Токен привязан!</blockquote>\n\n` +
          `Спасибо за покупку! Ваша подписка активирована.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
          }
        ).catch(() => ctx.reply(
          `🎉 <b>Активация завершена!</b> Спасибо за покупку!`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:main')]]) }
        ));

        await notif.notifyUserOrderCompleted(ctx.user, order, order.productId, 'Активация завершена успешно.');
        await grantReferralBonusForFirstCompletedOrder(order.userId);
        await notif.sendToAdmins(
          `✅ <b>Заказ выполнен (авто-активация)</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📋 ID: <code>${order._id}</code>\n` +
          `👤 ${escapeHtml(ctx.user.firstName)} (@${escapeHtml(ctx.user.username || ctx.user.telegramId)})\n` +
          `📦 ${escapeHtml(order.productId?.icon || '📦')} ${escapeHtml(order.productId?.name || 'Товар')}\n` +
          `💰 ${order.price} USDT`
        );
      } else {
        // Шаг 2 провалился — ставим в retry (до 3 попыток), потом failed
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 5 * 60 * 1000; // 5 минут

        const currentRetryCount = order.retryCount || 0;

        if (currentRetryCount < MAX_RETRIES) {
          // Ставим в retry — крон попробует снова
          order.status = 'retry';
          order.provider = provider;
          order.apiOrderId = pending.apiOrderId;
          order.activationResult = result.message;
          order.retryCount = currentRetryCount + 1;
          order.nextRetryAt = new Date(Date.now() + RETRY_DELAY);
          await order.save();

          await ctx.telegram.editMessageText(
            ctx.chat.id, step2Msg.message_id, null,
            `⏳ <b>Временная ошибка активации</b>\n\n` +
            `Попробую ещё раз автоматически (попытка ${order.retryCount}/${MAX_RETRIES}).\n` +
            `Ожидайте, это может занять несколько минут.`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В главное меню', 'menu:main')]]),
            }
          ).catch(() => {});

          await notif.sendToAdmins(
            `⚠️ <b>Ошибка шага 2 (retry ${order.retryCount}/${MAX_RETRIES})</b>\n` +
            `📋 Заказ: <code>${order._id}</code>\n` +
            `❌ ${String(result.message).substring(0, 200)}`
          );
        } else {
          // Исчерпаны попытки — откатываем
          const key = await Key.findById(pending.keyId);
          if (key) { key.isUsed = false; key.usedByOrder = null; await key.save(); }

          order.status = 'failed';
          order.activationResult = `После ${MAX_RETRIES} попыток: ${result.message}`;
          order.nextRetryAt = null;
          await order.save();

          const user = ctx.user;
          user.balance = parseFloat((user.balance + order.price).toFixed(8));
          await user.save();

          await new Transaction({
            userId: user._id, type: 'refund', amount: order.price,
            orderId: order._id, description: `Автовозврат: не удалось активировать за ${MAX_RETRIES} попыток`,
          }).save();

          const tokenLen = pending.token?.length ?? '?';
          const safeErr = String(result.message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          await ctx.telegram.editMessageText(
            ctx.chat.id, step2Msg.message_id, null,
            `❌ <b>Ошибка активации</b>\n\n` +
            `<blockquote><code>${safeErr}</code>\n\n` +
            `📏 Длина токена: <b>${tokenLen} симв.</b>\n` +
            `💡 Убедитесь, что скопировали <b>весь</b> текст /api/auth/session</blockquote>\n\n` +
            `💰 Средства возвращены на баланс.`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([
                [Markup.button.url('🆘 Написать поддержку', 'https://t.me/Tigrano_o')],
                [Markup.button.callback('⬅️ В главное меню', 'menu:main')]
              ]),
            }
          ).catch(() => {});
          await notif.notifyAdminTokenReceived(order, ctx.user, order.productId);
        }
      }

    } else {
      // ── Пользователь нажал «Нет» — откатываем ключ, возвращаем деньги ──
      // Возвращаем ключ в пул
      const key = await Key.findById(pending.keyId);
      if (key) { key.isUsed = false; key.usedByOrder = null; await key.save(); }

      // Сбрасываем заказ обратно в awaiting_token
      // retryCount/apiOrderId/nextRetryAt также сбрасываются — для нового
      // токена это «чистая» попытка активации, а не продолжение предыдущей.
      order.status = 'awaiting_token';
      order.keyId = null;
      order.retryCount = 0;
      order.apiOrderId = null;
      order.nextRetryAt = null;
      order.activationResult = null;
      await order.save();

      ctx.session.pendingActivation = null;

      await ctx.reply(
        `🔄 <b>Понял, не ваш аккаунт.</b>\n\nПожалуйста, отправьте токен ещё раз — возможно, он был неверным или устаревшим.`,
        { parse_mode: 'HTML' }
      );

      // Возвращаемся в сцену сбора токена
      await ctx.scene.enter('token_collection', { orderId: dbOrderId });
    }
  });


  bot.on('text', async (ctx, next) => {
    const session = ctx.session || {};

    // Бесплатная проверка токена (№6): пользователь прислал токен без оплаты.
    if (session.tokenCheck && session.tokenCheck.productId) {
      const { validateChatgptToken, formatCheckReport } = require('../services/token-check.service');
      const t = ctx.t || ((k) => k);
      const productId = session.tokenCheck.productId;
      // Сбрасываем флаг СРАЗУ, чтобы повторные сообщения не триггерили проверку.
      ctx.session.tokenCheck = null;

      const result = validateChatgptToken(ctx.message.text);
      const report = formatCheckReport(result);

      const buttons = [];
      if (result.ok) {
        buttons.push([Markup.button.callback(t('token_check_place_order'), `shop:buy:${productId}`)]);
      } else {
        buttons.push([Markup.button.callback(t('token_check_try_another'), `shop:check_token:${productId}`)]);
      }
      buttons.push([Markup.button.callback(t('token_check_back_to_product'), `shop:product:${productId}`)]);

      await ctx.reply(report, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons),
      });

      // Удаляем сообщение с токеном, чтобы он не висел в истории чата.
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }
      return;
    }

    // Обработка отправки сообщения пользователю (от админа)
    if (session.adminAction === 'send_message' && ctx.user.role === 'admin') {
      const targetId = session.targetTelegramId;
      ctx.session.adminAction = null;
      ctx.session.targetTelegramId = null;
      await notif.sendToUser(targetId, `📨 Сообщение от администратора:\n\n${escapeHtml(ctx.message.text)}`);
      await ctx.reply('✅ Сообщение отправлено.');
      return;
    }

    // Подтверждение суммы пополнения (админ)
    if (session.adminAction === 'confirm_topup' && ctx.user.role === 'admin') {
      if (await paymentsScene.finalizeTopup(ctx, ctx.message.text)) return;
    }

    // Редактирование настроек (admin)
    if (await settingsScene.handleSettingsInput(ctx)) return;

    // Поиск (admin)
    if (await usersScene.handleGlobalSearch(ctx)) return;

    // Изменение баланса (admin)
    if (await usersScene.handleBalanceChange(ctx)) return;

    // Добавление товара (admin) — включает назначение продавца
    if (await productsScene.handleProductInput(ctx)) return;

    // Добавление ключей (admin)
    if (await keysScene.handleKeysInput(ctx)) return;

    // Seller: привязка кошелька (адрес)
    if (await sellerScene.handleWalletAddressInput(ctx)) return;

    // Добавление продавца (admin)
    if (await sellerWithdrawalsScene.handleAddSellerInput(ctx)) return;

    // Изменение баланса продавца (admin)
    if (await sellerWithdrawalsScene.handleEditSellerBalanceInput(ctx)) return;

    // Seller: доставка заказа (текст)
    if (await sellerScene.handleSellerDelivery(ctx)) return;

    // Seller: ввод суммы вывода
    if (await sellerScene.handleWithdrawAmountInput(ctx)) return;

    // Сумма пополнения (пользователь вводит число)
    if (await topupScene.handleAmountInput(ctx)) return;

    // Хэш транзакции текстом (пополнение)
    if (await topupScene.handleTopupProof(ctx)) return;

    return next();
  });

  // Фото/документ: подтверждение оплаты, файлы ключей или данные от продавца
  bot.on(['photo', 'document'], async (ctx, next) => {
    // Сначала проверяем документ = txt-файл с ключами (админ)
    if (ctx.message?.document && await keysScene.handleKeysInput(ctx)) return;
    // Доставка заказа продавцом (если он прислал файл или фото)
    if (await sellerScene.handleSellerDelivery(ctx)) return;
    // Потом остальное (фото-чек пополнения)
    if (await topupScene.handleTopupProof(ctx)) return;
    return next();
  });

  // Ошибки
  bot.catch((err, ctx) => {
    // Игнорируем ошибку просроченных инлайн-кнопок (при перезапусках бота)
    if (err.message && err.message.includes('query is too old')) return;

    logger.error(`❌ Ошибка бота: ${err.message}`, { stack: err.stack });
    ctx.reply('❌ Произошла ошибка. Попробуйте ещё раз.')
      .catch(() => { });
  });

  return bot;
};

module.exports = createBot;

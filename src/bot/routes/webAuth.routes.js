const crypto = require('crypto');
const { Markup } = require('telegraf');
const AuthSession = require('../../models/AuthSession');
const User = require('../../models/User');
const logger = require('../../config/logger');

/**
 * Генерация и отправка одноразового кода для входа на сайт.
 */
const sendWebAuthCode = async (ctx) => {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const rawCode = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // 1. Сохраняем код в профиле пользователя (для прямого ввода на сайте)
    await User.updateOne(
      { telegramId: fromId },
      { $set: { webAuthCodeHash: codeHash, webAuthCodeExpiresAt: expiresAt } }
    );

    // 2. Ищем недавнюю pending-сессию из браузера (за последние 10 минут)
    const recentSession = await AuthSession.findOne({
      status: 'pending',
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    }).sort({ createdAt: -1 });

    let keyboard = null;
    if (recentSession) {
      recentSession.codeHash = codeHash;
      recentSession.telegramId = fromId;
      recentSession.status = 'code_issued';
      recentSession.codeExpiresAt = expiresAt;
      await recentSession.save();

      // Длина callback_data в Telegram ограничена 64 байтами.
      // Используем короткий префикс wa: и 24-значный ObjectId (всего 27 байт).
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⚡ Подтвердить вход в 1 клик', `wa:${recentSession._id}`)],
      ]);
    }

    const text =
      `🔐 <b>Код для входа на сайт</b>\n\n` +
      `Ваш одноразовый код:\n` +
      `<code>${rawCode}</code>\n\n` +
      `⏱ Код действует <b>5 минут</b>.\n` +
      `<i>Введите эти 6 цифр в поле на сайте</i>` +
      (keyboard ? ` <i>или нажмите кнопку ниже для мгновенного входа:</i>` : `.`);

    if (keyboard) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    logger.error(`[WebAuth] Ошибка генерации кода: ${err.message}`);
    await ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.').catch(() => {});
  }
};

/**
 * Регистрация обработчиков авторизации на веб-сайте через Telegram-бота.
 * @param {import('telegraf').Telegraf} bot
 */
const registerWebAuthRoutes = (bot) => {
  // Обработка кнопки 1-клик подтверждения входа (wa:<objectId> или webauth:approve:<token>)
  bot.action(/^(?:wa:([a-f0-9]{24})|webauth:approve:([a-f0-9]+))$/, async (ctx) => {
    try {
      const sessionIdOrToken = ctx.match[1] || ctx.match[2];
      const fromId = ctx.from?.id;

      let session = null;
      if (ctx.match[1]) {
        session = await AuthSession.findOne({
          _id: sessionIdOrToken,
          status: { $in: ['pending', 'code_issued'] },
        });
      } else {
        session = await AuthSession.findOne({
          sessionToken: sessionIdOrToken,
          status: { $in: ['pending', 'code_issued'] },
        });
      }

      if (!session) {
        return await ctx.answerCbQuery('❌ Сессия входа истекла или не найдена', { show_alert: true });
      }

      if (session.telegramId && session.telegramId !== fromId) {
        return await ctx.answerCbQuery('❌ Эта сессия привязана к другому пользователю', { show_alert: true });
      }

      // Переводим в статус authenticated
      session.status = 'authenticated';
      session.telegramId = fromId;
      session.verifiedAt = new Date();
      await session.save();

      await ctx.answerCbQuery('✅ Вход успешно подтверждён!', { show_alert: false });
      await ctx.editMessageText(
        '✅ <b>Вход на сайт успешно подтверждён!</b>\n\n' +
        'Страница в вашем браузере обновится автоматически через пару секунд.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    } catch (err) {
      logger.error(`[WebAuth] Ошибка подтверждения входа в 1 клик: ${err.message}`);
      await ctx.answerCbQuery('⚠️ Произошла ошибка. Попробуйте ввести код вручную.', { show_alert: true }).catch(() => {});
    }
  });

  // Кнопка из главного меню
  bot.action('menu:webauth_code', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendWebAuthCode(ctx);
  });

  // Команды /code, /login, /auth, /site
  bot.command(['code', 'login', 'auth', 'site'], sendWebAuthCode);
};

/**
 * Обработка входа через deep link /start auth_<sessionToken>.
 * Вызывается из основного bot.start обработчика.
 */
const handleWebAuthStart = async (ctx, sessionToken) => {
  try {
    const fromId = ctx.from?.id;
    if (!sessionToken) return false;

    const session = await AuthSession.findOne({
      sessionToken,
      status: { $in: ['pending', 'code_issued'] },
    });

    if (!session) {
      await ctx.reply(
        '❌ <b>Сессия авторизации не найдена или истекла.</b>\n\n' +
        'Пожалуйста, вернитесь на сайт и нажмите кнопку «Войти» заново.',
        { parse_mode: 'HTML' }
      );
      return true;
    }

    // Генерируем криптостойкий 6-значный код от 100000 до 999999 (граница 1000000 эксклюзивная)
    const rawCode = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');

    session.codeHash = codeHash;
    session.telegramId = fromId;
    session.status = 'code_issued';
    session.codeExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 минут
    session.attempts = 0;
    await session.save();

    // Форматируем код с пробелом для удобства чтения: 123 456
    const formattedCode = `${rawCode.slice(0, 3)} ${rawCode.slice(3)}`;

    const text =
      `🔐 <b>Вход на сайт магазина</b>\n\n` +
      `Ваш одноразовый код для входа:\n` +
      `<code>${rawCode}</code>\n\n` +
      `⏱ Код действует <b>5 минут</b> и сработает только в браузере, где был запрошен вход.\n\n` +
      `<i>Нажмите на код выше, чтобы скопировать его, или нажмите кнопку ниже для мгновенного входа:</i>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Подтвердить вход в 1 клик', `wa:${session._id}`)],
    ]);

    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    return true;
  } catch (err) {
    logger.error(`[WebAuth] Ошибка генерации кода: ${err.message}`);
    await ctx.reply('⚠️ Произошла ошибка генерации кода. Попробуйте снова на сайте.');
    return true;
  }
};

module.exports = {
  registerWebAuthRoutes,
  handleWebAuthStart,
};

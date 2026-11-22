const crypto = require('crypto');
const { Markup } = require('telegraf');
const AuthSession = require('../../models/AuthSession');
const logger = require('../../config/logger');

/**
 * Регистрация обработчиков авторизации на веб-сайте через Telegram-бота.
 * @param {import('telegraf').Telegraf} bot
 */
const registerWebAuthRoutes = (bot) => {
  // Обработка кнопки 1-клик подтверждения входа
  bot.action(/^webauth:approve:([a-f0-9]{64})$/, async (ctx) => {
    try {
      const sessionToken = ctx.match[1];
      const fromId = ctx.from?.id;

      const session = await AuthSession.findOne({
        sessionToken,
        status: { $in: ['pending', 'code_issued'] },
      });

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
      [Markup.button.callback('⚡ Подтвердить вход в 1 клик', `webauth:approve:${sessionToken}`)],
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

const User = require('../../models/User');
const Seller = require('../../models/Seller');
const { ADMIN_IDS } = require('../../config');
const logger = require('../../config/logger');

// Middleware: загружает пользователя из БД, создаёт если нет
const userMiddleware = async (ctx, next) => {
  try {
    if (!ctx.from) return next();

    const telegramId = ctx.from.id;
    let user = await User.findOne({ telegramId });

    if (!user) {
      // Создаём нового пользователя
      const isAdmin = ADMIN_IDS.includes(telegramId);

      // Проверяем реферальный код из start команды.
      // ctx.startPayload не устанавливается в обычном middleware — его выставляет
      // только bot.start(). Извлекаем из ctx.message.text для совместимости.
      let referredBy = null;
      let refCode = ctx.startPayload || null;
      if (!refCode && typeof ctx.message?.text === 'string') {
        const m = ctx.message.text.match(/^\/start(?:@\w+)?\s+(\S+)/);
        if (m) refCode = m[1].trim();
      }
      if (refCode) {
        const referrer = await User.findOne({ referralCode: refCode });
        if (referrer && referrer.telegramId !== telegramId) {
          referredBy = referrer._id;
        }
      }

      user = new User({
        telegramId,
        username: ctx.from.username || null,
        firstName: ctx.from.first_name || '',
        lastName: ctx.from.last_name || '',
        language: ctx.from.language_code === 'ru' ? 'ru' : 'en',
        role: isAdmin ? 'admin' : 'user',
        referredBy,
      });
      await user.save();
      logger.info(`Новый пользователь: ${telegramId} (@${ctx.from.username || 'no_username'})`);
    } else {
      // Обновляем имя/username только если изменились
      let changed = false;
      const newUsername = ctx.from.username || null;
      const newFirstName = ctx.from.first_name || user.firstName;
      const newLastName = ctx.from.last_name || user.lastName;

      if (user.username !== newUsername) { user.username = newUsername; changed = true; }
      if (user.firstName !== newFirstName) { user.firstName = newFirstName; changed = true; }
      if (user.lastName !== newLastName) { user.lastName = newLastName; changed = true; }

      // Автоматически повышаем до админа если в списке
      if (ADMIN_IDS.includes(telegramId) && user.role !== 'admin') {
        user.role = 'admin';
        changed = true;
      }
      if (changed) await user.save();
    }

    ctx.user = user;
    ctx.isSeller = await Seller.exists({ telegramId, isActive: true }) != null;

    if (global.MAINTENANCE_MODE && user.role !== 'admin') {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🛠 Тех. обслуживание', { show_alert: true }).catch(() => {});
      }
      await ctx.reply(
        '🛠 <b>Магазин на техническом обслуживании.</b>\n' +
        'Мы проводим профилактические работы, пожалуйста, подождите!\n\n' +
        'Возвращайтесь немного позже.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    return next();
  } catch (err) {
    logger.error(`userMiddleware error: ${err.message}`, { stack: err.stack });

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('⚠️ Временная ошибка. Попробуйте ещё раз.', { show_alert: true }).catch(() => {});
      return;
    }

    await ctx.reply('⚠️ Временная ошибка сервиса. Попробуйте ещё раз через несколько секунд.').catch(() => {});
    return;
  }
};

module.exports = userMiddleware;

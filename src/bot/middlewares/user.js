const User = require('../../models/User');
const Seller = require('../../models/Seller');
const { ADMIN_IDS } = require('../../config');
const logger = require('../../config/logger');

// ─── Кэш пользователей ────────────────────────────────────────────────────────
// Раньше КАЖДЫЙ апдейт любого пользователя делал 2 запроса к БД (User.findOne
// + Seller.exists) - это множитель на весь трафик бота. Кэшируем пару
// {user, isSeller} на короткий TTL. Обновлённый в обработчике ctx.user
// записывается обратно в кэш после next(), поэтому изменения (баланс после
// покупки, смена языка) видны сразу же.
const USER_CACHE_TTL_MS = 30 * 1000;
const USER_CACHE_MAX = 5000;
const userCache = new Map(); // telegramId → { user, isSeller, ts }

const cacheCleanup = () => {
  if (userCache.size <= USER_CACHE_MAX) return;
  const now = Date.now();
  // Сначала удаляем протухшие
  for (const [key, entry] of userCache) {
    if (now - entry.ts > USER_CACHE_TTL_MS) userCache.delete(key);
  }
  // Если всё ещё переполнен — удаляем самые старые записи (LRU), а не весь кэш
  if (userCache.size > USER_CACHE_MAX) {
    const excess = userCache.size - USER_CACHE_MAX + Math.floor(USER_CACHE_MAX * 0.2);
    let removed = 0;
    for (const key of userCache.keys()) {
      if (removed >= excess) break;
      userCache.delete(key);
      removed++;
    }
  }
};

// Точечная инвалидация (например, из админки после бана/смены роли/зачисления)
const invalidateUserCache = (telegramId) => {
  userCache.delete(telegramId);
};

// Полный сброс кэша (массовые операции: сброс ToS всем пользователям и т.п.)
const clearUserCache = () => {
  userCache.clear();
};

// Middleware: загружает пользователя из БД, создаёт если нет
const userMiddleware = async (ctx, next) => {
  try {
    if (!ctx.from) return next();

    const telegramId = ctx.from.id;

    // ── Быстрый путь: свежая запись в кэше ──
    const cached = userCache.get(telegramId);
    if (cached && Date.now() - cached.ts < USER_CACHE_TTL_MS && cached.user) {
      ctx.user = cached.user;
      ctx.isSeller = cached.isSeller;

      if (global.MAINTENANCE_MODE && ctx.user.role !== 'admin') {
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

      try {
        return await next();
      } finally {
        // Обработчик мог заменить ctx.user свежим документом (покупка, топап) -
        // мутируем СУЩЕСТВУЮЩУЮ запись, не пересоздавая её: если за время
        // обработки запись инвалидировали (бан/зачисление из админки),
        // set() воскресил бы её - мутация удалённого объекта безвредна.
        if (ctx.user) {
          cached.user = ctx.user;
        }
      }
    }

    // ── Медленный путь: чтение из БД ──
    let user = await User.findOne({ telegramId });

    if (!user) {
      // Создаём нового пользователя
      const isAdmin = ADMIN_IDS.includes(telegramId);

      // Проверяем реферальный код из start команды.
      // ctx.startPayload не устанавливается в обычном middleware - его выставляет
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

    cacheCleanup();
    const entry = { user, isSeller: ctx.isSeller, ts: Date.now() };
    userCache.set(telegramId, entry);

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

    try {
      return await next();
    } finally {
      if (ctx.user) {
        entry.user = ctx.user;
      }
    }
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
module.exports.invalidateUserCache = invalidateUserCache;
module.exports.clearUserCache = clearUserCache;

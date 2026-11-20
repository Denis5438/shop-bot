// Middleware: проверяет бан и права доступа
const authMiddleware = (ctx, next) => {
  if (ctx.user?.isBanned) {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('🚫 Вы заблокированы', { show_alert: true }).catch(() => {});
    }
    return ctx.reply('🚫 Вы заблокированы в этом боте.');
  }
  return next();
};

const adminMiddleware = (ctx, next) => {
  if (!ctx.user || (ctx.user.role !== 'admin' && ctx.user.role !== 'superadmin')) {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('🚫 Нет доступа', { show_alert: true }).catch(() => {});
    }
    return ctx.reply('🚫 Нет доступа.');
  }
  return next();
};

const superadminMiddleware = (ctx, next) => {
  if (!ctx.user || ctx.user.role !== 'superadmin') {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('🚫 Доступно только главному администратору', { show_alert: true }).catch(() => {});
    }
    return ctx.reply('🚫 Доступно только главному администратору.');
  }
  return next();
};

module.exports = { authMiddleware, adminMiddleware, superadminMiddleware };

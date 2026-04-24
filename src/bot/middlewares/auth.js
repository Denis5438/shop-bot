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
  if (!ctx.user || ctx.user.role !== 'admin') {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('🚫 Нет доступа', { show_alert: true }).catch(() => {});
    }
    return ctx.reply('🚫 Нет доступа.');
  }
  return next();
};

module.exports = { authMiddleware, adminMiddleware };

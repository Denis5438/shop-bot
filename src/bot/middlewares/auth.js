// Middleware: проверяет бан и права доступа (RBAC)
const isSupportOrAbove = (user) => ['support', 'moderator', 'admin', 'superadmin'].includes(user?.role);
const isModeratorOrAbove = (user) => ['moderator', 'admin', 'superadmin'].includes(user?.role);
const isAdminOrAbove = (user) => ['admin', 'superadmin'].includes(user?.role);
const isSuperAdmin = (user) => user?.role === 'superadmin';

const denyAccess = (ctx, message = '🚫 Нет доступа') => {
  if (ctx.callbackQuery) {
    ctx.answerCbQuery(message, { show_alert: true }).catch(() => {});
  }
  if (!ctx.chat || ctx.chat.type === 'private') {
    return ctx.reply(`${message}.`);
  }
  return undefined;
};

const authMiddleware = (ctx, next) => {
  if (ctx.user?.isBanned) {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('🚫 Вы заблокированы', { show_alert: true }).catch(() => {});
    }
    if (!ctx.chat || ctx.chat.type === 'private') {
      return ctx.reply('🚫 Вы заблокированы в этом боте.');
    }
    return undefined;
  }
  return next();
};

const supportMiddleware = (ctx, next) => {
  if (!isSupportOrAbove(ctx.user)) {
    return denyAccess(ctx);
  }
  return next();
};

const moderatorMiddleware = (ctx, next) => {
  if (!isModeratorOrAbove(ctx.user)) {
    return denyAccess(ctx);
  }
  return next();
};

const adminMiddleware = (ctx, next) => {
  if (!isAdminOrAbove(ctx.user)) {
    return denyAccess(ctx);
  }
  return next();
};

const superadminMiddleware = (ctx, next) => {
  if (!isSuperAdmin(ctx.user)) {
    return denyAccess(ctx, '🚫 Доступно только главному администратору');
  }
  return next();
};

module.exports = {
  isSupportOrAbove,
  isModeratorOrAbove,
  isAdminOrAbove,
  isSuperAdmin,
  authMiddleware,
  supportMiddleware,
  moderatorMiddleware,
  adminMiddleware,
  superadminMiddleware,
};

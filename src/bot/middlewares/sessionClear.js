/**
 * Middleware для очистки сессии при глобальной навигации.
 * Предотвращает залипание состояний (например, ожидание ввода кошелька),
 * когда пользователь нажал кнопку возврата в главное меню или ввел команду.
 */
module.exports = () => {
  return async (ctx, next) => {
    if (ctx.session) {
      const isCommand = ctx.message && ctx.message.text && ctx.message.text.startsWith('/');
      const isMainMenu = ctx.callbackQuery && ctx.callbackQuery.data === 'menu:main';
      const isAdminMenu = ctx.callbackQuery && ctx.callbackQuery.data === 'admin:main';

      if (isCommand || isMainMenu || isAdminMenu) {
        // Очищаем потенциально "залипшие" состояния
        ctx.session.adminAction = null;
        ctx.session.sellerAction = null;
        ctx.session.topupAction = null;
        ctx.session.deliverOrderId = null;
        ctx.session.keysProductId = null;
        ctx.session.newProduct = null;
        ctx.session.productId = null;
      }
    }
    return next();
  };
};

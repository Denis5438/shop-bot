/**
 * Middleware для очистки сессии при глобальной навигации.
 * Предотвращает залипание состояний (например, ожидание ввода кошелька),
 * когда пользователь нажал кнопку возврата в главное меню или ввел команду.
 */
module.exports = () => {
  return async (ctx, next) => {
    if (ctx.session) {
      const isCommand = ctx.message && ctx.message.text && ctx.message.text.startsWith('/');
      const cbData = ctx.callbackQuery?.data;
      const isMainMenu = cbData === 'menu:main';
      const isAdminMenu = cbData === 'admin:main';
      const isSupportNav = cbData === 'support:panel' || cbData === 'sp:home' || cbData === 'adm_sup:hub';

      if (isCommand || isMainMenu || isAdminMenu || isSupportNav) {
        // Очищаем потенциально "залипшие" состояния
        ctx.session.adminAction = null;
        ctx.session.sellerAction = null;
        ctx.session.topup = null;
        ctx.session.step = null;
        ctx.session.userAction = null;
        ctx.session.customerSearchMsgId = null;
        ctx.session.deliverOrderId = null;
        ctx.session.keysProductId = null;
        ctx.session.newProduct = null;
        ctx.session.productId = null;
        ctx.session.supportAction = null;
        ctx.session.staffAdminAction = null;
        ctx.session.activeTicketId = null;
        ctx.session.supportTopic = null;
        ctx.session.supportOrderId = null;
      }
    }
    return next();
  };
};

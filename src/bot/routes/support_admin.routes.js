/**
 * Маршруты админ/модер-центра управления саппортами (adm_sup:*).
 */

const supportAdminScene = require('../scenes/admin/support_admin.scene');
const { adminMiddleware, moderatorMiddleware } = require('../middlewares/auth');

const privateOnly = async (ctx, next) => {
  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    await ctx.answerCbQuery('ℹ️ Откройте панель управления в ЛС бота', { show_alert: true }).catch(() => {});
    return;
  }
  return next();
};

module.exports = (bot) => {
  bot.action('adm_sup:noop', moderatorMiddleware, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });

  // Главный хаб саппортов и модерации
  bot.action('adm_sup:hub', moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.showSupportHub(ctx);
  });

  // Очередь всех вопросов и эскалаций
  bot.action(/^adm_sup:q:(all|waiting|esc|closed)(?::(\d+))?$/, moderatorMiddleware, privateOnly, async (ctx) => {
    const tab = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await supportAdminScene.showAdminTicketsQueue(ctx, tab, page);
  });

  // Команда и активность
  bot.action(/^adm_sup:team(?::(\d+))?$/, moderatorMiddleware, privateOnly, async (ctx) => {
    const page = ctx.match[1] ? parseInt(ctx.match[1], 10) : 1;
    await supportAdminScene.showTeamList(ctx, page);
  });

  // Подробная статистика сотрудника и RBAC-кнопки роли
  bot.action(/^adm_sup:st:([a-f0-9]{24}):(today|7d|30d|all)$/, moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.showStaffStats(ctx, ctx.match[1], ctx.match[2]);
  });

  // Изменение роли сотрудника (строгая RBAC-проверка внутри)
  bot.action(/^adm_sup:role:([a-f0-9]{24}):(u|s|m|a)$/, moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.changeStaffRole(ctx, ctx.match[1], ctx.match[2]);
  });

  // Поиск и назначение нового сотрудника
  bot.action('adm_sup:add', moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.startAddStaff(ctx);
  });

  // Лог изменений ролей
  bot.action(/^adm_sup:log(?::(\d+))?$/, moderatorMiddleware, privateOnly, async (ctx) => {
    const page = ctx.match[1] ? parseInt(ctx.match[1], 10) : 1;
    await supportAdminScene.showAuditLogs(ctx, page);
  });

  // Безопасный поиск юзера / заказа / тикета (доступен модератору)
  bot.action('adm_sup:find', moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.startModSearch(ctx);
  });

  // Безопасная карточка покупателя из поиска модератора
  bot.action(/^adm_sup:u:([a-f0-9]{24})$/, moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.showSafeUserCard(ctx, ctx.match[1]);
  });

  // Чат саппортов (просмотр для модератора, редактирование только для admin+)
  bot.action('adm_sup:chat', moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.showSupportChatSettings(ctx);
  });

  bot.action('adm_sup:chat_off', adminMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.disableSupportChat(ctx);
  });

  bot.action('adm_sup:chat_id', adminMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.startSetChatId(ctx);
  });

  // Параметры SLA и быстрые шаблоны (просмотр для модератора, редактирование только для admin+)
  bot.action('adm_sup:cfg', moderatorMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.showSupportSettings(ctx);
  });

  bot.action(/^adm_sup:cfg:(sla|max|auto|tpl_add|tpl_reset)$/, adminMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.startCfgEdit(ctx, ctx.match[1]);
  });

  bot.action(/^adm_sup:tpl_del:(\d+)$/, adminMiddleware, privateOnly, async (ctx) => {
    await supportAdminScene.deleteQuickReply(ctx, ctx.match[1]);
  });
};

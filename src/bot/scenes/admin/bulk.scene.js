const { Markup } = require('telegraf');
const bulkService = require('../../../services/bulkOperations.service');
const User = require('../../../models/User');
const Order = require('../../../models/Order');

// Главное меню массовых операций
const showBulkMain = async (ctx) => {
  const usersCount = await User.countDocuments();
  const ordersCount = await Order.countDocuments();

  const text = `⚡ <b>Массовые операции</b>\n\n` +
    `👥 Всего пользователей: <b>${usersCount}</b>\n` +
    `📦 Всего заказов: <b>${ordersCount}</b>\n\n` +
    `Выберите действие для массового изменения:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Обнулить ВСЕ балансы', 'admin:bulk:reset_bal_confirm')],
    [Markup.button.callback('🎁 Начислить баланс ВСЕМ', 'admin:bulk:give_bal_prompt')],
    [Markup.button.callback('🛡 Массовая гарантия (выдать/снять)', 'admin:bulk:warranty_menu')],
    [Markup.button.callback('⬅️ В админку', 'admin:main')],
  ]);

  const opts = { parse_mode: 'HTML', ...keyboard };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

// Экран подтверждения сброса балансов
const showResetBalanceConfirm = async (ctx) => {
  const text = `⚠️ <b>ВНИМАНИЕ! Обнуление ВСЕХ балансов!</b>\n\n` +
    `Вы собираетесь сбросить балансы абсолютно <b>ВСЕХ</b> пользователей до <b>0.00 USDT</b>.\n\n` +
    `<i>Это действие необратимо. Подтверждаете?</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔥 Да, обнулить ВСЕ балансы в 0', 'admin:bulk:reset_bal_exec')],
    [Markup.button.callback('❌ Отмена', 'admin:bulk:main')],
  ]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

// Выполнение обнуления всех балансов
const execResetBalances = async (ctx) => {
  const count = await bulkService.resetAllBalances();
  await ctx.answerCbQuery('✅ Все балансы обнулены!', { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

// Запрос суммы для начисления всем
const promptGiveBalance = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'bulk_give_balance';

  const text = `🎁 <b>Массовое начисление баланса</b>\n\n` +
    `Введите сумму в USDT, которую хотите зачислить <b>КАЖДОМУ</b> пользователю (например: <code>1.5</code> или <code>5</code>):`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

// Меню массовой гарантии
const showBulkWarrantyMenu = async (ctx) => {
  const text = `🛡 <b>Массовое управление гарантией</b>\n\n` +
    `Выберите действие для изменения срока гарантии по всем заказам:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить +7 дней ко ВСЕМ заказам', 'admin:bulk:warr_add:7')],
    [Markup.button.callback('➕ Добавить +30 дней ко ВСЕМ заказам', 'admin:bulk:warr_add:30')],
    [Markup.button.callback('❌ Снять гарантию у ВСЕХ заказов (0 дн.)', 'admin:bulk:warr_reset_exec')],
    [Markup.button.callback('⬅️ Назад', 'admin:bulk:main')],
  ]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

// Добавление дней гарантии
const execAddWarranty = async (ctx, days) => {
  const count = await bulkService.bulkAddWarranty(days);
  await ctx.answerCbQuery(`✅ Гарантия продлена на +${days} дн. (${count} заказов)!`, { show_alert: true }).catch(() => {});
  await showBulkWarrantyMenu(ctx);
};

// Снятие гарантии со всех заказов
const execResetWarranty = async (ctx) => {
  const count = await bulkService.bulkResetWarranty();
  await ctx.answerCbQuery(`✅ Гарантия обнулена по ${count} заказам!`, { show_alert: true }).catch(() => {});
  await showBulkWarrantyMenu(ctx);
};

module.exports = {
  showBulkMain,
  showResetBalanceConfirm,
  execResetBalances,
  promptGiveBalance,
  showBulkWarrantyMenu,
  execAddWarranty,
  execResetWarranty,
};

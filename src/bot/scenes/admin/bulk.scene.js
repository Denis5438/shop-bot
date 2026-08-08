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
    [
      Markup.button.callback('🗑 Обнулить логистику', 'admin:bulk:reset_logistics_confirm'),
      Markup.button.callback('🗑 Обнулить товары', 'admin:bulk:reset_products_confirm'),
    ],
    [
      Markup.button.callback('🗑 Обнулить категории', 'admin:bulk:reset_categories_confirm'),
    ],
    [
      Markup.button.callback('🙈 Скрыть все товары', 'admin:bulk:hide_products_confirm'),
      Markup.button.callback('🙈 Скрыть категории', 'admin:bulk:hide_categories_confirm'),
    ],
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

// --- Подтверждения и выполнение очистки/скрытия ---

const showResetLogisticsConfirm = async (ctx) => {
  const text = `⚠️ <b>Очистка логистики</b>\n\nВы собираетесь безвозвратно удалить <b>ВСЕ</b> заказы и историю транзакций пополнений. Балансы пользователей при этом сохранятся.\nПодтверждаете?`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔥 Да, удалить ВСЮ логистику', 'admin:bulk:reset_logistics_exec')], [Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
};
const execResetLogistics = async (ctx) => {
  const count = await bulkService.deleteAllLogistics();
  await ctx.answerCbQuery(`✅ Логистика очищена! (Удалено ${count.orders} заказов, ${count.transactions} транзакций)`, { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

const showResetProductsConfirm = async (ctx) => {
  const text = `⚠️ <b>Очистка товаров</b>\n\nВы собираетесь безвозвратно удалить <b>ВСЕ</b> товары из базы. Категории и логистика не пострадают.\nПодтверждаете?`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔥 Да, удалить ВСЕ товары', 'admin:bulk:reset_products_exec')], [Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
};
const execResetProducts = async (ctx) => {
  const count = await bulkService.deleteAllProducts();
  await ctx.answerCbQuery(`✅ Удалено ${count} товаров!`, { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

const showResetCategoriesConfirm = async (ctx) => {
  const text = `⚠️ <b>Очистка категорий</b>\n\nВы собираетесь безвозвратно удалить <b>ВСЕ</b> категории. Товары и логистика не пострадают.\nПодтверждаете?`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔥 Да, удалить ВСЕ категории', 'admin:bulk:reset_categories_exec')], [Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
};
const execResetCategories = async (ctx) => {
  const count = await bulkService.deleteAllCategories();
  await ctx.answerCbQuery(`✅ Удалено ${count} категорий!`, { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

const showHideProductsConfirm = async (ctx) => {
  const text = `🙈 <b>Скрыть все товары</b>\n\nВы собираетесь перевести <b>ВСЕ</b> товары в статус неактивных (невидимых для покупателей).\nПодтверждаете?`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🙈 Да, скрыть ВСЕ товары', 'admin:bulk:hide_products_exec')], [Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
};
const execHideProducts = async (ctx) => {
  const count = await bulkService.hideAllProducts();
  await ctx.answerCbQuery(`✅ Скрыто ${count} товаров!`, { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

const showHideCategoriesConfirm = async (ctx) => {
  const text = `🙈 <b>Скрыть все категории</b>\n\nВы собираетесь перевести <b>ВСЕ</b> категории в статус неактивных (невидимых для покупателей).\nПодтверждаете?`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🙈 Да, скрыть ВСЕ категории', 'admin:bulk:hide_categories_exec')], [Markup.button.callback('❌ Отмена', 'admin:bulk:main')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
};
const execHideCategories = async (ctx) => {
  const count = await bulkService.hideAllCategories();
  await ctx.answerCbQuery(`✅ Скрыто ${count} категорий!`, { show_alert: true }).catch(() => {});
  await showBulkMain(ctx);
};

module.exports = {
  showBulkMain,
  showResetBalanceConfirm,
  execResetBalances,
  promptGiveBalance,
  showBulkWarrantyMenu,
  execAddWarranty,
  execResetWarranty,
  showResetLogisticsConfirm,
  execResetLogistics,
  showResetProductsConfirm,
  execResetProducts,
  showResetCategoriesConfirm,
  execResetCategories,
  showHideProductsConfirm,
  execHideProducts,
  showHideCategoriesConfirm,
  execHideCategories,
};

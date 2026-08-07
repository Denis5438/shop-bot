const { Markup } = require('telegraf');
const supplierManager = require('../../../services/supplierManager.service');
const { escapeHtml } = require('../../utils/ui');

/**
 * Главное меню управления внешними поставщиками
 */
const showSuppliersMain = async (ctx) => {
  const suppliers = await supplierManager.getAllSuppliers();

  let text = `🔌 <b>Внешние Поставщики (Drop-Shipping API)</b>\n\n` +
    `Здесь вы можете подключить API сторонних магазинов для автоматического импорта каталогов и мгновенного авто-выкупа товаров:\n\n`;

  const buttons = [];

  for (const s of suppliers) {
    const statusIcon = s.apiKey ? '🟢' : '⚪';
    const balanceStr = s.apiKey ? `(${s.cachedBalance.toFixed(2)} USDT)` : '(Не настроен)';
    text += `${statusIcon} <b>${escapeHtml(s.title)}</b> ${balanceStr}\n` +
      `└ Наценка: <b>+${s.marginPercent}%</b> | Авто-выкуп: ${s.isEnabled ? 'Включен ⚡' : 'Выключен'}\n\n`;

    buttons.push([Markup.button.callback(`${s.title}`, `admin:supplier:view:${s.supplierId}`)]);
  }

  buttons.push([Markup.button.callback('⬅️ В админку', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

/**
 * Карточка конкретного поставщика
 */
const showSupplierDetail = async (ctx, supplierId) => {
  const suppliers = await supplierManager.getAllSuppliers();
  const supplier = suppliers.find((s) => s.supplierId === supplierId);
  if (!supplier) return ctx.answerCbQuery('❌ Поставщик не найден', { show_alert: true });

  const status = supplier.apiKey ? '✅ Подключен и готов к работе' : '⚪ Ключ не задан';
  const keyMasked = supplier.apiKey
    ? `<code>${supplier.apiKey.substring(0, 8)}...${supplier.apiKey.substring(supplier.apiKey.length - 4)}</code>`
    : '<i>не задан</i>';

  const text = `🔌 <b>Настройки поставщика: ${escapeHtml(supplier.title)}</b>\n\n` +
    `📡 Статус: <b>${status}</b>\n` +
    `🔑 API Ключ: ${keyMasked}\n` +
    `💰 Баланс на счёте поставщика: <b>${supplier.cachedBalance.toFixed(2)} USDT</b>\n` +
    `📈 Ваша наценка: <b>+${supplier.marginPercent}%</b>\n` +
    `🕒 Последняя синхронизация: ${supplier.lastSyncAt ? new Date(supplier.lastSyncAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'никогда'}`;

  const buttons = [
    [Markup.button.callback('🔑 Задать / сменить API-ключ', `admin:supplier:key:${supplierId}`)],
    [Markup.button.callback('📈 Изменить наценку %', `admin:supplier:margin:${supplierId}`)],
    [Markup.button.callback('📥 Импортировать ВСЕ товары в 1 клик', `admin:supplier:import:${supplierId}`)],
    [Markup.button.callback('🔄 Обновить баланс', `admin:supplier:refresh:${supplierId}`)],
    [Markup.button.callback('⬅️ К поставщикам', 'admin:suppliers')],
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

/**
 * Старт ввода API-ключа
 */
const startSetApiKey = async (ctx, supplierId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'supplier_set_key';
  ctx.session.targetSupplierId = supplierId;

  const text = `🔑 <b>Ввод API-ключа</b>\n\n` +
    `Отправьте API-ключ (токен авторизации) для поставщика <code>${supplierId}</code> сообщением в чат:`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:supplier:view:${supplierId}`)]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

/**
 * Старт изменения наценки
 */
const startSetMargin = async (ctx, supplierId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'supplier_set_margin';
  ctx.session.targetSupplierId = supplierId;

  const text = `📈 <b>Настройка наценки</b>\n\n` +
    `Введите процент наценки на все товары этого поставщика (например: <code>30</code> для +30% или <code>50</code> для +50%):`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:supplier:view:${supplierId}`)]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

/**
 * Запуск импорта каталога
 */
const execImportCatalog = async (ctx, supplierId) => {
  await ctx.answerCbQuery('⏳ Начинаем импорт каталога...', { show_alert: false }).catch(() => {});
  const res = await supplierManager.importSupplierCatalog(supplierId);

  if (!res.success) {
    await ctx.reply(`❌ Ошибка импорта: ${res.error}`, {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin:supplier:view:${supplierId}`)]]),
    });
    return;
  }

  const successText = `✅ <b>Импорт товаров завершен!</b>\n\n` +
    `📦 Получено от поставщика: <b>${res.totalReceived}</b> шт.\n` +
    `✨ Новых товаров создано: <b>${res.importedCount}</b>\n` +
    `🔄 Существующих обновлено: <b>${res.updatedCount}</b>\n\n` +
    `<i>Все товары автоматически выставлены в магазин с вашей наценкой!</i>`;

  await ctx.reply(successText, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню поставщика', `admin:supplier:view:${supplierId}`)]]),
  });
};

/**
 * Обновление баланса
 */
const execRefreshBalance = async (ctx, supplierId) => {
  const res = await supplierManager.refreshSupplierBalance(supplierId);
  if (res.success) {
    await ctx.answerCbQuery(`✅ Баланс обновлен: ${res.balance.toFixed(2)} USDT`, { show_alert: true }).catch(() => {});
  } else {
    await ctx.answerCbQuery(`❌ ${res.error}`, { show_alert: true }).catch(() => {});
  }
  await showSupplierDetail(ctx, supplierId);
};

module.exports = {
  showSuppliersMain,
  showSupplierDetail,
  startSetApiKey,
  startSetMargin,
  execImportCatalog,
  execRefreshBalance,
};

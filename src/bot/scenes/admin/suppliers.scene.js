const { Markup } = require('telegraf');
const supplierManager = require('../../../services/supplierManager.service');
const { escapeHtml, safeEdit } = require('../../utils/ui');

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
  await safeEdit(ctx, text, opts);
};

/**
 * Карточка конкретного поставщика
 */
const showSupplierDetail = async (ctx, supplierId) => {
  let suppliers = await supplierManager.getAllSuppliers();
  let supplier = suppliers.find((s) => s.supplierId === supplierId);
  if (!supplier) return ctx.answerCbQuery('❌ Поставщик не найден', { show_alert: true });

  // Если ключ задан, но в кэше 0 или баланс не обновлялся больше 5 минут — обновляем в фоне
  if (supplier.apiKey && (supplier.cachedBalance === 0 || !supplier.lastSyncAt || Date.now() - new Date(supplier.lastSyncAt).getTime() > 5 * 60 * 1000)) {
    const refreshed = await supplierManager.refreshSupplierBalance(supplierId).catch(() => null);
    if (refreshed?.success) {
      supplier.cachedBalance = refreshed.balance;
      supplier.lastSyncAt = new Date();
    }
  }

  const pricingService = require('../../../services/pricing.service');
  const status = supplier.apiKey ? '✅ Подключен и готов к работе' : '⚪ Ключ не задан';
  const keyMasked = supplier.apiKey
    ? `<code>${supplier.apiKey.substring(0, 8)}...${supplier.apiKey.substring(supplier.apiKey.length - 4)}</code>`
    : '<i>не задан</i>';

  const pricingDesc = pricingService.formatPricingDescription(supplier);

  const currentOnlyStatus = supplier.currentOnly !== false ? '🟢 Только актуальные' : '⚪ Все товары';
  const filterDesc = supplier.currentOnly !== false
    ? '🟢 Только актуальные (без архивных)'
    : '⚪ Все товары (включая неактивные)';

  const text = `🔌 <b>Настройки поставщика: ${escapeHtml(supplier.title)}</b>\n\n` +
    `📡 Статус: <b>${status}</b>\n` +
    `🔑 API Ключ: ${keyMasked}\n` +
    `💰 Баланс на счёте поставщика: <b>${supplier.cachedBalance.toFixed(2)} USDT</b>\n` +
    `📈 ${pricingDesc}\n` +
    `📦 Фильтр каталога: <b>${filterDesc}</b>\n` +
    `🕒 Последняя синхронизация: ${supplier.lastSyncAt ? new Date(supplier.lastSyncAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'никогда'}`;

  const buttons = [
    [Markup.button.callback('🔑 Задать / сменить API-ключ', `admin:supplier:key:${supplierId}`)],
    [Markup.button.callback('📈 Настроить наценку (Smart / %)', `admin:supplier:margin_menu:${supplierId}`)],
    [Markup.button.callback(`📦 Каталог: ${currentOnlyStatus}`, `admin:supplier:toggle_current:${supplierId}`)],
    [Markup.button.callback('📥 Импортировать ВСЕ товары в 1 клик', `admin:supplier:import:${supplierId}`)],
    [Markup.button.callback('🔄 Синхронизировать остатки и склад', `admin:supplier:sync:${supplierId}`)],
    [Markup.button.callback('💰 Проверить баланс', `admin:supplier:refresh:${supplierId}`)],
    [Markup.button.callback('⬅️ К поставщикам', 'admin:suppliers')],
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

/**
 * Меню настройки наценки (Выбор простого % или Smart Pricing пресетов)
 */
const showMarginMenu = async (ctx, supplierId) => {
  const suppliers = await supplierManager.getAllSuppliers();
  const supplier = suppliers.find((s) => s.supplierId === supplierId);
  if (!supplier) return ctx.answerCbQuery('❌ Поставщик не найден', { show_alert: true });

  const pricingService = require('../../../services/pricing.service');
  const currentDesc = pricingService.formatPricingDescription(supplier);

  const text = `📈 <b>Настройка ценообразования: ${escapeHtml(supplier.title)}</b>\n\n` +
    `Текущий режим:\n${currentDesc}\n\n` +
    `<b>Выберите режим наценки:</b>\n\n` +
    `⚡ <b>Умная градуированная наценка (Smart Pricing):</b>\n` +
    `Адаптирует процент в зависимости от оптовой цены товара (на дешевых больше маржа, на дорогих — доступная цена).\n\n` +
    `🔘 <b>Простой единый процент:</b>\n` +
    `Один фиксированный процент наценки на все товары поставщика.`;

  const buttons = [
    [Markup.button.callback('🎯 Smart: Стандарт (30% ➔ 20% ➔ 15% ➔ 8%)', `admin:supplier:preset:${supplierId}:standard`)],
    [Markup.button.callback('💰 Smart: Макс. прибыль (40% ➔ 25% ➔ 20% ➔ 12%)', `admin:supplier:preset:${supplierId}:high_profit`)],
    [Markup.button.callback('🔥 Smart: Минимум (20% ➔ 12% ➔ 8% ➔ 5%)', `admin:supplier:preset:${supplierId}:minimal`)],
    [Markup.button.callback('✏️ Задать единый фиксированный %', `admin:supplier:margin_simple:${supplierId}`)],
    [Markup.button.callback('⬅️ Назад к поставщику', `admin:supplier:view:${supplierId}`)],
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

/**
 * Применение пресета Smart Pricing
 */
const applySmartPreset = async (ctx, supplierId, presetKey) => {
  const SupplierConfig = require('../../../models/SupplierConfig');
  const liveSync = require('../../../services/supplierLiveSync.service');

  await SupplierConfig.findOneAndUpdate(
    { supplierId },
    {
      $set: {
        smartPricingEnabled: true,
        smartPricingPreset: presetKey,
      },
    },
    { new: true, upsert: true }
  );

  await ctx.answerCbQuery('⚡ Умная наценка активирована! Пересчитываю цены...', { show_alert: false }).catch(() => {});

  // Автоматически синхронизируем и пересчитываем цены товаров
  const syncRes = await liveSync.syncSupplierStock(supplierId);
  const updatedInfo = syncRes.success ? ` (Обновлено товаров: ${syncRes.updatedCount})` : '';

  const text = `✅ <b>Умная наценка успешно применена!</b>${updatedInfo}\n\nВсе цены в магазине автоматически пересчитаны по новым правилам.`;
  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В карточку поставщика', `admin:supplier:view:${supplierId}`)]]),
  });
};

/**
 * Старт ввода API-ключа
 */
const startSetApiKey = async (ctx, supplierId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'supplier_set_key';
  ctx.session.targetSupplierId = supplierId;
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const text = `🔑 <b>Ввод API-ключа</b>\n\n` +
    `Отправьте API-ключ (токен авторизации) для поставщика <code>${supplierId}</code> сообщением в чат:`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:supplier:view:${supplierId}`)]]);
  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

/**
 * Старт изменения простого фиксированного процента наценки
 */
const startSetMargin = async (ctx, supplierId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'supplier_set_margin';
  ctx.session.targetSupplierId = supplierId;
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const text = `📈 <b>Настройка простого процента наценки</b>\n\n` +
    `Введите процент наценки на все товары этого поставщика (например: <code>15</code> для +15% или <code>30</code> для +30%):\n\n` +
    `<i>(Это отключит Smart Pricing и включит единый процент на все товары)</i>`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:supplier:margin_menu:${supplierId}`)]]);
  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

/**
 * Запуск импорта каталога
 */
const execImportCatalog = async (ctx, supplierId) => {
  await ctx.answerCbQuery('⏳ Импортируем каталог...').catch(() => {});
  await safeEdit(ctx, '⏳ <b>Импорт каталога поставщика...</b>\n\n<i>Получаем каталог и сохраняем товары в базу данных магазина...</i>', {
    parse_mode: 'HTML',
  });

  const res = await supplierManager.importSupplierCatalog(supplierId);

  if (!res.success) {
    const errText = `❌ Ошибка импорта: ${res.error}`;
    await safeEdit(ctx, errText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin:supplier:view:${supplierId}`)]]),
    });
    return;
  }

  const successText = `✅ <b>Импорт товаров завершен!</b>\n\n` +
    `📦 Получено от поставщика: <b>${res.totalReceived}</b> шт.\n` +
    `✨ Новых товаров создано: <b>${res.importedCount}</b>\n` +
    `🔄 Существующих обновлено: <b>${res.updatedCount}</b>\n\n` +
    `<i>Все товары автоматически выставлены в магазин с вашей наценкой!</i>`;

  await safeEdit(ctx, successText, {
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

/**
 * Синхронизация остатков поставщика
 */
const execSyncStock = async (ctx, supplierId) => {
  await ctx.answerCbQuery('⏳ Синхронизируем остатки...', { show_alert: false }).catch(() => {});
  const liveSync = require('../../../services/supplierLiveSync.service');
  const res = await liveSync.syncSupplierStock(supplierId);

  if (res.success) {
    await ctx.answerCbQuery(`✅ Синхронизировано! Обновлено товаров: ${res.updatedCount}`, { show_alert: true }).catch(() => {});
  } else {
    await ctx.answerCbQuery(`❌ ${res.error}`, { show_alert: true }).catch(() => {});
  }
  await showSupplierDetail(ctx, supplierId);
};

/**
 * Переключение фильтра актуальных товаров (current_only)
 */
const toggleCurrentOnly = async (ctx, supplierId) => {
  const SupplierConfig = require('../../../models/SupplierConfig');
  const config = await SupplierConfig.findOne({ supplierId });
  if (!config) return ctx.answerCbQuery('❌ Поставщик не найден', { show_alert: true });

  config.currentOnly = config.currentOnly === false ? true : false;
  await config.save();

  const msg = config.currentOnly ? '🟢 Включен фильтр: только актуальные товары' : '⚪ Выключен фильтр: загрузка абсолютно всех товаров';
  await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {});
  await showSupplierDetail(ctx, supplierId);
};

module.exports = {
  showSuppliersMain,
  showSupplierDetail,
  showMarginMenu,
  applySmartPreset,
  startSetApiKey,
  startSetMargin,
  execImportCatalog,
  execRefreshBalance,
  execSyncStock,
  toggleCurrentOnly,
};

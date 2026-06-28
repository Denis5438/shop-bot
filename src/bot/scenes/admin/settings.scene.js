const { Markup } = require('telegraf');
const { getRate, getUpdatedAt, fetchRate } = require('../../../services/currency.service');
const Settings = require('../../../models/Settings');
const { getSettings: getCachedSettings, invalidateCache } = require('../../../services/settingsCache.service');
const { TOPUP_WALLET, TOPUP_NETWORK, MIN_TOPUP, REFERRAL_BONUS } = require('../../../config');
const digest = require('../../../services/notification-digest.service');
const { escapeHtml } = require('../../utils/ui');

/**
 * Возвращает настройки для ЧТЕНИЯ (showSettings, отображение).
 * Использует кэш — быстрее, но возвращает plain object без .save().
 */
const getSettings = async () => {
  const cached = await getCachedSettings();
  if (cached && cached._id) return cached;
  // Fallback: если кеш вернул пустой объект (настройки ещё не созданы).
  // Здесь возвращается Mongoose-документ, но showSettings только читает поля,
  // так что это безопасно.
  return getLiveSettings();
};

/**
 * Возвращает настройки как Mongoose-документ для ЗАПИСИ (.save() работает).
 * Всегда идёт в БД — использовать только в toggle* и handleSettingsInput,
 * где нужно мутировать и сохранять.
 */
const getLiveSettings = async () => {
  let settings = await Settings.findOne({ name: 'global' });
  if (!settings) {
    settings = await Settings.create({
      name: 'global',
      maintenanceMode: false,
      topupWallet: TOPUP_WALLET,
      topupNetwork: TOPUP_NETWORK,
      minTopup: MIN_TOPUP,
      referralBonus: REFERRAL_BONUS,
    });
  }
  return settings;
};

const showSettings = async (ctx) => {
  const settings = await getSettings();
  global.MAINTENANCE_MODE = settings.maintenanceMode;

  const modeText = settings.maintenanceMode ? '🔴 Вкл' : '🟢 Выкл';
  const modeBtnStr = settings.maintenanceMode ? '🛡 Режим ТО: Выкл' : '🛡 Режим ТО: Вкл';

  const smartPriceText = settings.smartPricing ? '🔴 Вкл' : '🟢 Выкл';
  const smartBtnStr = settings.smartPricing ? '🚕 Smart-Цены: Выкл' : '🚕 Smart-Цены: Вкл';
  const fmt = (value, fallback = 'не задан') => escapeHtml(value || fallback);

  const text =
    `⚙️ <b>Настройки бота</b>\n\n` +
    `💳 Кошелёк для пополнений:\n<code>${fmt(settings.topupWallet)}</code>\n` +
    `🌐 Сеть: <b>${fmt(settings.topupNetwork)}</b>\n\n` +
    `🏦 Карта: <code>${fmt(settings.cardNumber, 'не задана')}</code>\n` +
    `👤 Держатель: <code>${fmt(settings.cardHolder)}</code>\n\n` +
    `🔴 TRC-20: <code>${fmt(settings.bybitTrc20Address)}</code>\n` +
    `🟡 BEP-20: <code>${fmt(settings.bybitBep20Address)}</code>\n\n` +
    `💵 Минимум пополнения: <b>${settings.minTopup} USDT</b>\n` +
    `⭐ Реферальный бонус: <b>${settings.referralBonus} USDT</b>\n\n` +
    `💸 Мин. вывод продавца: <b>${settings.minSellerWithdraw ?? 5} USDT</b>\n` +
    `⏱ Авто-подтверждение заказа: <b>${settings.autoConfirmHours ?? 24} ч.</b>\n\n` +
    `🚕 Умные цены (x1.2 при &lt;10 шт): <b>${smartPriceText}</b>\n` +
    `📉 Умная уценка (-${settings.autoMarkdownPercent}% / ${settings.autoMarkdownDays}дн): <b>${settings.autoMarkdownEnabled ? '🔴 Вкл' : '🟢 Выкл'}</b>\n` +
    `📬 Сводка уведомлений (digest): <b>${settings.adminDigestEnabled ? `🔴 Вкл (каждые ${settings.adminDigestIntervalMinutes || 60} мин)` : '🟢 Выкл (всё сразу)'}</b>\n\n` +
    `💱 Текущий курс: 1 USD = <b>${getRate()} ₽</b>\n` +
    `🕐 Обновлён: ${getUpdatedAt()}\n\n` +
    `🛡 Тех. обслуживание: <b>${modeText}</b>`;

  const buttons = [
    [Markup.button.callback('✏️ Изменить кошелёк', 'admin:settings:edit:topupWallet')],
    [Markup.button.callback('✏️ Изменить сеть', 'admin:settings:edit:topupNetwork')],
    [Markup.button.callback('✏️ Номер карты', 'admin:settings:edit:cardNumber')],
    [Markup.button.callback('✏️ Держатель карты', 'admin:settings:edit:cardHolder')],
    [Markup.button.callback('✏️ TRC-20 адрес', 'admin:settings:edit:bybitTrc20Address')],
    [Markup.button.callback('✏️ BEP-20 адрес', 'admin:settings:edit:bybitBep20Address')],
    [Markup.button.callback('✏️ Минимальное пополнение', 'admin:settings:edit:minTopup')],
    [Markup.button.callback('✏️ Реферальный бонус', 'admin:settings:edit:referralBonus')],
    [Markup.button.callback('💸 Мин. вывод продавца (USDT)', 'admin:settings:edit:minSellerWithdraw')],
    [Markup.button.callback('⏱ Часов до авто-подтверждения', 'admin:settings:edit:autoConfirmHours')],
    [Markup.button.callback(smartBtnStr, 'admin:settings:toggle_smart_pricing')],
    [Markup.button.callback(settings.autoMarkdownEnabled ? '📉 Умная уценка: Выкл' : '📉 Умная уценка: Вкл', 'admin:settings:toggle_markdown')],
    [Markup.button.callback('⏳ Дни простоя для уценки', 'admin:settings:edit:autoMarkdownDays')],
    [Markup.button.callback('🔢 Процент уценки (%)', 'admin:settings:edit:autoMarkdownPercent')],
    [Markup.button.callback(
      settings.adminDigestEnabled ? '📬 Сводка уведомлений: Выкл' : '📬 Сводка уведомлений: Вкл',
      'admin:settings:toggle_digest'
    )],
    [Markup.button.callback('⏰ Интервал сводки (мин)', 'admin:settings:edit:adminDigestIntervalMinutes')],
    [Markup.button.callback('🔄 Обновить курс вручную', 'admin:settings:refresh_rate')],
    [Markup.button.callback(modeBtnStr, 'admin:settings:toggle_maintenance')],
    [Markup.button.callback('⬅️ В панель', 'admin:main')]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

const refreshRate = async (ctx) => {
  await ctx.answerCbQuery('⏳ Обновляю курс...');
  await fetchRate();
  await showSettings(ctx);
};

const toggleMaintenance = async (ctx) => {
  const settings = await getLiveSettings();
  settings.maintenanceMode = !settings.maintenanceMode;
  await settings.save();
  invalidateCache();
  global.MAINTENANCE_MODE = settings.maintenanceMode;
  
  await ctx.answerCbQuery(settings.maintenanceMode ? '🛠 Режим ТО включён' : '✅ Режим ТО выключен');
  await showSettings(ctx);
};

const toggleSmartPricing = async (ctx) => {
  const settings = await getLiveSettings();
  settings.smartPricing = !settings.smartPricing;
  await settings.save();
  invalidateCache();
  await ctx.answerCbQuery(settings.smartPricing ? '🚕 Smart-Цены включены' : '✅ Smart-Цены выключены');
  await showSettings(ctx);
};

const toggleMarkdown = async (ctx) => {
  const settings = await getLiveSettings();
  settings.autoMarkdownEnabled = !settings.autoMarkdownEnabled;
  await settings.save();
  invalidateCache();
  await ctx.answerCbQuery(settings.autoMarkdownEnabled ? '📉 Умная уценка включена' : '✅ Умная уценка выключена');
  await showSettings(ctx);
};

// #17 Admin digest: переключатель режима агрегации уведомлений.
// Синхронизирует состояние в БД и в runtime-сервисе (setDigestEnabled + auto-flush).
const toggleDigest = async (ctx) => {
  const settings = await getLiveSettings();
  settings.adminDigestEnabled = !settings.adminDigestEnabled;
  await settings.save();
  invalidateCache();

  if (settings.adminDigestEnabled) {
    digest.setDigestEnabled(true);
    const intervalMin = Math.max(1, settings.adminDigestIntervalMinutes || 60);
    digest.startAutoFlush(intervalMin * 60 * 1000);
    await ctx.answerCbQuery('📬 Сводка включена');
  } else {
    digest.setDigestEnabled(false);
    digest.stopAutoFlush();
    // Финальный flush перед остановкой — чтобы накопленное не потерялось.
    await digest.flush();
    await ctx.answerCbQuery('✅ Сводка выключена — всё отправляется сразу');
  }

  await showSettings(ctx);
};

// Запрос на редактирование поля
const startEditSetting = async (ctx, field) => {
  const fieldNames = {
    topupWallet: 'кошелёк для пополнения (TRC20)',
    topupNetwork: 'сеть для пополнения (TRC20 и т.д.)',
    minTopup: 'минимальную сумму пополнения (в USDT)',
    referralBonus: 'реферальный бонус за приглашение (в USDT)',
    autoMarkdownDays: 'кол-во дней простоя (после которых снижается цена)',
    autoMarkdownPercent: 'процент скидки на каждый период простоя (например 5 или 10)',
    cardNumber: 'номер карты для пополнения',
    cardHolder: 'имя держателя карты',
    bybitTrc20Address: 'адрес Bybit TRC-20',
    bybitBep20Address: 'адрес Bybit BEP-20',
    bybitUid: 'Bybit UID',
    adminDigestIntervalMinutes: 'интервал сводки уведомлений в минутах (от 5 до 1440)',
    minSellerWithdraw: 'минимальную сумму вывода для продавцов (в USDT, например: 5)',
    autoConfirmHours: 'кол-во часов на проверку заказа (после чего деньги уходят продавцу)',
  };
  
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'edit_setting';
  ctx.session.settingField = field;
  
  await ctx.reply(`✏️ Введите новое значение для: <b>${fieldNames[field]}</b>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:settings')]])
  });
};

// Обработка текстового ввода для изменения
const handleSettingsInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'edit_setting') return false;

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const field = session.settingField;
  const value = ctx.message.text.trim();
  const update = {};

  const numericFields = ['minTopup', 'referralBonus', 'autoMarkdownDays', 'autoMarkdownPercent', 'adminDigestIntervalMinutes', 'minSellerWithdraw', 'autoConfirmHours'];
  
  if (numericFields.includes(field)) {
    const num = parseFloat(value.replace(',', '.'));
    if (isNaN(num) || num < 0) {
      await ctx.reply('❌ Неверное числовое значение. Введите положительное число:');
      return true;
    }
    // Для интервала сводки — ограничиваем разумным диапазоном (5 мин — 24 ч).
    if (field === 'adminDigestIntervalMinutes' && (num < 5 || num > 1440)) {
      await ctx.reply('❌ Интервал должен быть от 5 до 1440 минут.');
      return true;
    }
    update[field] = num;
  } else {
    update[field] = value;
  }

  const settings = await getLiveSettings();
  Object.assign(settings, update);
  await settings.save();
  invalidateCache();

  // Если меняли интервал и digest включён — перезапускаем auto-flush с новым значением.
  if (field === 'adminDigestIntervalMinutes' && settings.adminDigestEnabled) {
    digest.startAutoFlush(settings.adminDigestIntervalMinutes * 60 * 1000);
  }

  ctx.session.adminAction = null;
  ctx.session.settingField = null;

  await ctx.reply('✅ Настройка успешно сохранена.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К настройкам', 'admin:settings')]])
  });
  return true;
};

module.exports = { showSettings, refreshRate, toggleMaintenance, toggleSmartPricing, toggleMarkdown, toggleDigest, startEditSetting, handleSettingsInput };

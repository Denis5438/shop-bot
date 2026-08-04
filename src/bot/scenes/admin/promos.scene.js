const { Markup } = require('telegraf');
const PromoCode = require('../../../models/PromoCode');
const PromoUsage = require('../../../models/PromoUsage');
const { escapeHtml } = require('../../utils/ui');

// Показ главного меню промокодов
const showPromosMain = async (ctx) => {
  const promos = await PromoCode.find().sort({ createdAt: -1 }).lean();
  const usageCount = await PromoUsage.countDocuments();

  let text = `🎟 <b>Управление Промокодами</b>\n\n`;
  text += `📊 Всего использований: <b>${usageCount}</b>\n\n`;

  if (promos.length === 0) {
    text += `<i>Промокодов пока нет. Создайте первый!</i>`;
  } else {
    text += `<b>Список промокодов:</b>\n`;
    for (const p of promos) {
      const typeLabel = p.type === 'balance' ? '💳 На баланс' : p.type === 'percent' ? '📉 Скидка %' : '💰 Скидка USDT';
      const valStr = p.type === 'percent' ? `${p.value}%` : `${p.value} USDT`;
      const actStr = p.maxActivations === -1 ? `${p.currentActivations} / ∞` : `${p.currentActivations} / ${p.maxActivations}`;
      const statusStr = p.isActive ? '🟢' : '🔴';

      text += `${statusStr} <code>${escapeHtml(p.code)}</code> — <b>${valStr}</b> (${typeLabel})\n`;
      text += `└ Использовано: <b>${actStr}</b>\n\n`;
    }
  }

  const buttons = [
    [Markup.button.callback('➕ Создать промокод', 'admin:promo:create')],
  ];

  if (promos.length > 0) {
    buttons.push([Markup.button.callback('🗑 Удалить промокод', 'admin:promo:delete_select')]);
  }
  buttons.push([Markup.button.callback('⬅️ В админку', 'menu:admin')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

// Выбор типа промокода при создании
const startCreatePromo = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.userAction = 'promo_create_code';
  ctx.session.newPromo = {};

  const text = `🎟 <b>Создание нового промокода</b>\n\n` +
    `Шаг 1 из 4: Напишите код промокода (например: <code>WELCOME100</code> или <code>SUMMER2026</code>):`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:promos')]]);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...keyboard }));
};

// Выбор удаления
const showDeleteSelect = async (ctx) => {
  const promos = await PromoCode.find({ isActive: true }).lean();
  if (promos.length === 0) {
    return ctx.answerCbQuery('Нет активных промокодов', { show_alert: true });
  }

  const buttons = promos.map((p) => [
    Markup.button.callback(`🗑 <code>${p.code}</code>`, `admin:promo:delete:${p._id}`),
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:promos')]);

  const text = `🗑 <b>Выберите промокод для удаления:</b>`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
};

// Удаление промокода
const deletePromo = async (ctx, promoId) => {
  await PromoCode.findByIdAndDelete(promoId);
  await ctx.answerCbQuery('✅ Промокод удалён!', { show_alert: true }).catch(() => {});
  await showPromosMain(ctx);
};

module.exports = {
  showPromosMain,
  startCreatePromo,
  showDeleteSelect,
  deletePromo,
};

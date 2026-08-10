const { Markup } = require('telegraf');
const PromoCode = require('../../../models/PromoCode');
const PromoUsage = require('../../../models/PromoUsage');
const { escapeHtml, safeEdit } = require('../../utils/ui');

/**
 * Главный экран управления промокодами
 */
const showPromosMain = async (ctx) => {
  const promos = await PromoCode.find().sort({ createdAt: -1 }).lean();
  const usageCount = await PromoUsage.countDocuments();

  let text = `🎟 <b>Генератор Промокодов и Акций</b>\n\n`;
  text += `📊 Всего активаций: <b>${usageCount}</b> | Создано кодов: <b>${promos.length}</b>\n\n`;

  const buttons = [];

  if (promos.length === 0) {
    text += `<i>Промокодов пока нет. Нажмите кнопку ниже, чтобы запустить акцию!</i>`;
  } else {
    text += `<b>Список промокодов:</b>\n`;
    for (const p of promos) {
      const typeLabel = p.type === 'balance' ? '💳 На баланс' : p.type === 'percent' ? '📉 Скидка %' : '💰 Скидка USDT';
      const valStr = p.type === 'percent' ? `${p.value}%` : `${p.value} USDT`;
      const actStr = p.maxActivations === -1 ? `${p.currentActivations} / ∞` : `${p.currentActivations} / ${p.maxActivations}`;
      const statusIcon = p.isActive ? '🟢' : '🔴';
      const expStr = p.expiresAt ? (new Date() > new Date(p.expiresAt) ? ' (⏰ Истёк)' : ` (до ${new Date(p.expiresAt).toLocaleDateString('ru-RU')})`) : '';

      text += `${statusIcon} <code>${escapeHtml(p.code)}</code> — <b>${valStr}</b> (${typeLabel})\n`;
      text += `└ Активаций: <b>${actStr}</b>${expStr}\n\n`;

      buttons.push([Markup.button.callback(`🎟 ${p.code} (${valStr})`, `admin:promo:view:${p._id}`)]);
    }
  }

  buttons.push([Markup.button.callback('➕ Создать новый промокод', 'admin:promo:create')]);
  buttons.push([Markup.button.callback('⬅️ В админку', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

/**
 * Карточка конкретного промокода
 */
const showPromoDetail = async (ctx, promoId) => {
  const promo = await PromoCode.findById(promoId).lean();
  if (!promo) return ctx.answerCbQuery('❌ Промокод не найден', { show_alert: true });

  const usages = await PromoUsage.find({ promoId: promo._id }).sort({ usedAt: -1 }).limit(10).populate('userId').lean();

  const typeLabel = promo.type === 'balance' ? '💳 Пополнение баланса' : promo.type === 'percent' ? '📉 Процентная скидка' : '💰 Фиксированная скидка USDT';
  const valStr = promo.type === 'percent' ? `${promo.value}%` : `${promo.value} USDT`;
  const actStr = promo.maxActivations === -1 ? `${promo.currentActivations} / ∞ (безлимит)` : `${promo.currentActivations} из ${promo.maxActivations}`;
  const statusStr = promo.isActive ? '🟢 Активен' : '🔴 Отключен';
  const expStr = promo.expiresAt
    ? (new Date() > new Date(promo.expiresAt) ? '⏰ <b>Истёк</b>' : `📅 До ${new Date(promo.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`)
    : '♾ Без ограничения по времени';

  let text = `🎟 <b>Промокод: <code>${escapeHtml(promo.code)}</code></b>\n\n` +
    `📌 Тип: <b>${typeLabel}</b>\n` +
    `🎁 Номинал: <b>${valStr}</b>\n` +
    `📡 Статус: <b>${statusStr}</b>\n` +
    `👥 Использовано: <b>${actStr}</b>\n` +
    `⏳ Срок действия: ${expStr}\n\n`;

  if (usages.length > 0) {
    text += `<b>Последние активации:</b>\n`;
    usages.forEach((u, i) => {
      const username = u.userId?.username ? `@${u.userId.username}` : `ID ${u.userId?.telegramId || '?'}`;
      text += `${i + 1}. ${username} — ${new Date(u.usedAt || u.createdAt).toLocaleDateString('ru-RU')}\n`;
    });
    text += `\n`;
  }

  const toggleBtnText = promo.isActive ? '🔴 Приостановить' : '🟢 Включить';

  const buttons = [
    [Markup.button.callback('📢 Сгенерировать пост для канала', `admin:promo:post:${promo._id}`)],
    [Markup.button.callback(toggleBtnText, `admin:promo:toggle:${promo._id}`)],
    [Markup.button.callback('🗑 Удалить промокод', `admin:promo:delete:${promo._id}`)],
    [Markup.button.callback('⬅️ К списку промокодов', 'admin:promos')],
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

/**
 * Генерация красивого поста для публикации в Telegram-канале
 */
const generateChannelPost = async (ctx, promoId) => {
  const promo = await PromoCode.findById(promoId).lean();
  if (!promo) return ctx.answerCbQuery('❌ Промокод не найден', { show_alert: true });

  const valStr = promo.type === 'percent' ? `скидку ${promo.value}%` : `${promo.value} USDT на баланс`;
  const botUsername = ctx.botInfo?.username || 'наш_бот';

  const postText = `🎁 <b>РАЗДАЧА ПРОМОКОДОВ ДЛЯ ПОДПИСЧИКОВ!</b>\n\n` +
    `Используйте эксклюзивный промокод в нашем боте и получите <b>${valStr}</b> на любые покупки! ⚡\n\n` +
    `🎟 Промокод: <code>${escapeHtml(promo.code)}</code> <i>(нажмите, чтобы скопировать)</i>\n\n` +
    `👉 <b>Как активировать:</b>\n` +
    `1. Перейдите в бота: @${botUsername}\n` +
    `2. Откройте «👤 Профиль» ➔ «🎟 Промокод»\n` +
    `3. Введите код и забирайте бонус!\n\n` +
    `⏳ <i>Количество активаций ограничено. Успейте воспользоваться!</i>`;

  await safeEdit(ctx, postText, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ В карточку промокода', `admin:promo:view:${promo._id}`)],
    ]),
  });
};

/**
 * Переключение статуса активности промокода
 */
const togglePromoStatus = async (ctx, promoId) => {
  const promo = await PromoCode.findById(promoId);
  if (!promo) return ctx.answerCbQuery('❌ Промокод не найден', { show_alert: true });

  promo.isActive = !promo.isActive;
  await promo.save();

  await ctx.answerCbQuery(promo.isActive ? '🟢 Промокод активирован!' : '🔴 Промокод приостановлен!', { show_alert: true }).catch(() => {});
  await showPromoDetail(ctx, promoId);
};

/**
 * Старт визарда создания промокода
 */
const startCreatePromo = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.userAction = 'promo_create_code';
  ctx.session.newPromo = {};
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const randomCode = `PROMO${Math.floor(1000 + Math.random() * 9000)}`;

  const text = `🎟 <b>Создание нового промокода</b>\n\n` +
    `<b>Шаг 1 из 4:</b> Напишите свой код в чат (например: <code>WELCOME2026</code>, <code>SALE20</code>)\n` +
    `или нажмите кнопку для генерации случайного кода:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`🎲 Использовать: ${randomCode}`, `admin:promo:quick_code:${randomCode}`)],
    [Markup.button.callback('❌ Отмена', 'admin:promos')],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

/**
 * Удаление промокода
 */
const deletePromo = async (ctx, promoId) => {
  await PromoCode.findByIdAndDelete(promoId);
  await ctx.answerCbQuery('✅ Промокод удалён!', { show_alert: true }).catch(() => {});
  await showPromosMain(ctx);
};

module.exports = {
  showPromosMain,
  showPromoDetail,
  generateChannelPost,
  togglePromoStatus,
  startCreatePromo,
  deletePromo,
};

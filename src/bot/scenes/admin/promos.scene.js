const { Markup } = require('telegraf');
const PromoCode = require('../../../models/PromoCode');
const PromoUsage = require('../../../models/PromoUsage');
const Category = require('../../../models/Category');
const Product = require('../../../models/Product');
const { escapeHtml, safeEdit } = require('../../utils/ui');

/**
 * Хелпер для рендеринга шагов визарда создания промокода.
 * Если вызов из callback - редактирует инлайн, если из текстового ввода - редактирует wizardMsgId или шлет новое.
 */
const renderWizardStep = async (ctx, text, keyboard) => {
  const targetMsgId = ctx.session?.wizardMsgId;
  const opts = { parse_mode: 'HTML', ...keyboard };
  if (ctx.callbackQuery) {
    return safeEdit(ctx, text, opts);
  }
  if (targetMsgId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, opts);
      return;
    } catch (_) {}
  }
  const sent = await ctx.reply(text, opts);
  if (sent?.message_id && ctx.session) {
    ctx.session.wizardMsgId = sent.message_id;
  }
  return sent;
};

/**
 * Главный экран управления промокодами
 */
const showPromosMain = async (ctx) => {
  const promos = await PromoCode.find().sort({ createdAt: -1 }).populate('productId').lean();
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
      let condBadge = '';
      if (p.discountTarget === 'second_item') {
        condBadge = ' | 🎁 1+1';
      } else if (p.minQuantity > 1) {
        condBadge = ` | 🛍 от ${p.minQuantity} шт.`;
      }
      if (p.audienceCondition === 'repeat_only') {
        condBadge += ' | 🔄 Со 2-й покупки';
      } else if (p.audienceCondition === 'first_only') {
        condBadge += ' | 🆕 1-й заказ';
      }

      const prodStr = p.productId?.name ? escapeHtml(p.productId.name) : 'Все товары';
      text += `${statusIcon} <code>${escapeHtml(p.code)}</code> — <b>${valStr}</b> (${typeLabel})\n`;
      text += `└ 📦 <b>${prodStr}</b>${condBadge} | Активаций: <b>${actStr}</b>${expStr}\n\n`;

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
  const promo = await PromoCode.findById(promoId).populate('productId').lean();
  if (!promo) return ctx.answerCbQuery('❌ Промокод не найден', { show_alert: true });

  const usages = await PromoUsage.find({ promoId: promo._id }).sort({ usedAt: -1 }).limit(10).populate('userId').lean();

  const typeLabel = promo.type === 'balance' ? '💳 Пополнение баланса' : promo.type === 'percent' ? '📉 Процентная скидка' : '💰 Фиксированная скидка USDT';
  const valStr = promo.type === 'percent' ? `${promo.value}%` : `${promo.value} USDT`;
  const actStr = promo.maxActivations === -1 ? `${promo.currentActivations} / ∞ (безлимит)` : `${promo.currentActivations} из ${promo.maxActivations}`;
  const statusStr = promo.isActive ? '🟢 Активен' : '🔴 Отключен';
  const expStr = promo.expiresAt
    ? (new Date() > new Date(promo.expiresAt) ? '⏰ <b>Истёк</b>' : `📅 До ${new Date(promo.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`)
    : '♾ Без ограничения по времени';

  const prodStr = promo.productId ? (promo.productId.name ? `📦 ${escapeHtml(promo.productId.name)}` : '📦 Товар') : '🌐 Все товары';

  let qtyCondStr = '🛒 Стандартный (от 1 шт.)';
  if (promo.discountTarget === 'second_item') {
    qtyCondStr = '🎁 1+1 (скидка на 2-ю шт.)';
  } else if (promo.minQuantity > 1) {
    qtyCondStr = `🛍 От ${promo.minQuantity} шт.`;
  }

  let audStr = '👥 Для всех';
  if (promo.audienceCondition === 'repeat_only') {
    audStr = '🔄 Со 2-й покупки (повторные заказы)';
  } else if (promo.audienceCondition === 'first_only') {
    audStr = '🆕 Только на первый заказ';
  }

  let text = `🎟 <b>Промокод: <code>${escapeHtml(promo.code)}</code></b>\n\n` +
    `📌 Тип: <b>${typeLabel}</b>\n` +
    `🎁 Номинал: <b>${valStr}</b>\n` +
    `📦 Привязка: <b>${prodStr}</b>\n` +
    `🛍 Условие: <b>${qtyCondStr}</b>\n` +
    `👥 Аудитория: <b>${audStr}</b>\n` +
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
  const promo = await PromoCode.findById(promoId).populate('productId').lean();
  if (!promo) return ctx.answerCbQuery('❌ Промокод не найден', { show_alert: true });

  const valStr = promo.type === 'percent' ? `скидку ${promo.value}%` : `${promo.value} USDT на баланс`;
  const botUsername = ctx.botInfo?.username || 'наш_бот';

  let scopeStr = 'на любые покупки';
  if (promo.productId?.name) {
    scopeStr = `на покупку товара <b>«${escapeHtml(promo.productId.name)}»</b>`;
  }

  let extraCond = '';
  if (promo.discountTarget === 'second_item') {
    extraCond += `\n🎁 <b>Акция 1+1:</b> скидка действует на 2-ю единицу товара!`;
  } else if (promo.minQuantity > 1) {
    extraCond += `\n🛍 <b>Условие:</b> действует при заказе от ${promo.minQuantity} шт.!`;
  }

  if (promo.audienceCondition === 'repeat_only') {
    extraCond += `\n🔄 <b>Для постоянных клиентов:</b> скидка действует со 2-й покупки!`;
  } else if (promo.audienceCondition === 'first_only') {
    extraCond += `\n🆕 <b>Для новых клиентов:</b> скидка действует только на первый заказ!`;
  }

  const postText = `🎁 <b>РАЗДАЧА ПРОМОКОДОВ ДЛЯ ПОДПИСЧИКОВ!</b>\n\n` +
    `Используйте эксклюзивный промокод в нашем боте и получите <b>${valStr}</b> ${scopeStr}! ⚡${extraCond}\n\n` +
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
    `<b>Шаг 1 из 7:</b> Напишите свой код в чат (например: <code>WELCOME2026</code>, <code>SALE20</code>)\n` +
    `или нажмите кнопку для генерации случайного кода:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`🎲 Использовать: ${randomCode}`, `admin:promo:quick_code:${randomCode}`)],
    [Markup.button.callback('❌ Отмена', 'admin:promos')],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

/**
 * Шаг 5: Выбор области применения промокода (На все товары / На конкретный товар)
 */
const showPromoScopeStep = async (ctx) => {
  const session = ctx.session || {};
  const promoCode = session.newPromo?.code || '---';

  const text = `🎟 <b>Создание промокода:</b> <code>${escapeHtml(promoCode)}</code>\n\n` +
    `<b>Шаг 5 из 7:</b> Выберите область применения скидки:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🌐 На все товары', 'admin:promo:scope:all')],
    [Markup.button.callback('📦 На конкретный товар', 'admin:promo:scope:product')],
    [Markup.button.callback('❌ Отмена', 'admin:promos')],
  ]);

  await renderWizardStep(ctx, text, keyboard);
};

/**
 * Интерактивный выбор категорий для привязки промокода
 */
const showPromoProductCategories = async (ctx) => {
  const [categories, uncategorizedCount] = await Promise.all([
    Category.find({ isActive: true }).sort({ sortOrder: 1 }).lean(),
    Product.countDocuments({ categoryId: null, isActive: true }),
  ]);

  const buttons = [];
  categories.forEach((c) => {
    buttons.push([Markup.button.callback(`${c.icon || '📁'} ${c.name}`, `admin:promo:sel_cat:${c._id}:1`)]);
  });

  if (uncategorizedCount > 0) {
    buttons.push([Markup.button.callback(`📦 Без категории (${uncategorizedCount})`, 'admin:promo:sel_cat:none:1')]);
  }

  buttons.push([Markup.button.callback('🔍 Все активные товары', 'admin:promo:sel_cat:all:1')]);
  buttons.push([Markup.button.callback('⬅️ Назад к выбору привязки', 'admin:promo:step:scope')]);
  buttons.push([Markup.button.callback('❌ Отмена', 'admin:promos')]);

  const text = `📦 <b>Выбор товара для промокода</b>\n\n` +
    `Выберите категорию товаров:`;

  await renderWizardStep(ctx, text, Markup.inlineKeyboard(buttons));
};

/**
 * Интерактивный показ товаров с пагинацией для выбора конкретного товара в промокод
 */
const showPromoCategoryProducts = async (ctx, catId, page = 1) => {
  page = Math.max(1, parseInt(page, 10) || 1);
  const limit = 8;
  const skip = (page - 1) * limit;

  let filter = { isActive: true };
  let title = 'Товары';

  if (catId === 'none') {
    filter.categoryId = null;
    title = 'Без категории';
  } else if (catId === 'all') {
    title = 'Все товары';
  } else {
    filter.categoryId = catId;
    const cat = await Category.findById(catId).lean();
    if (cat) title = `${cat.icon || '📁'} ${cat.name}`;
  }

  const [products, totalCount] = await Promise.all([
    Product.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  const buttons = products.map((p) => [
    Markup.button.callback(`${p.icon || '📦'} ${p.name} ($${p.price})`, `admin:promo:set_product:${p._id}`)
  ]);

  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `admin:promo:sel_cat:${catId}:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'admin:noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `admin:promo:sel_cat:${catId}:${page + 1}`));
  if (nav.length > 1) buttons.push(nav);

  buttons.push([Markup.button.callback('⬅️ К категориям', 'admin:promo:scope:product')]);
  buttons.push([Markup.button.callback('❌ Отмена', 'admin:promos')]);

  const text = `📦 <b>Выбор товара для промокода</b>\n` +
    `Категория: <b>${escapeHtml(title)}</b> (всего: ${totalCount} шт.)\n\n` +
    `Нажмите на товар, чтобы привязать к нему промокод:`;

  await renderWizardStep(ctx, text, Markup.inlineKeyboard(buttons));
};

/**
 * Шаг 6: Выбор условия по количеству товара в заказе
 */
const showPromoQuantityStep = async (ctx, productName = null) => {
  const session = ctx.session || {};
  const promoCode = session.newPromo?.code || '---';

  if (!productName && session.newPromo?.productId) {
    const p = await Product.findById(session.newPromo.productId).lean();
    if (p) productName = p.name;
  }

  const targetLine = productName
    ? `📦 Привязка: <b>${escapeHtml(productName)}</b>\n\n`
    : `🌐 Привязка: <b>Все товары</b>\n\n`;

  const text = `🎟 <b>Создание промокода:</b> <code>${escapeHtml(promoCode)}</code>\n` +
    targetLine +
    `<b>Шаг 6 из 7:</b> Выберите условие по количеству товара:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Стандартный (от 1 шт)', 'admin:promo:qty:standard')],
    [Markup.button.callback('🛍 От 2 шт', 'admin:promo:qty:min2')],
    [Markup.button.callback('🎁 1+1 (скидка на 2-ю шт)', 'admin:promo:qty:second_item')],
    [Markup.button.callback('⬅️ Назад к привязке', 'admin:promo:step:scope')],
    [Markup.button.callback('❌ Отмена', 'admin:promos')],
  ]);

  await renderWizardStep(ctx, text, keyboard);
};

/**
 * Шаг 7: Выбор целевой аудитории
 */
const showPromoAudienceStep = async (ctx) => {
  const session = ctx.session || {};
  const promoCode = session.newPromo?.code || '---';
  const isBalance = session.newPromo?.type === 'balance';

  const stepNumber = isBalance ? '5 из 5' : '7 из 7';
  const text = `🎟 <b>Создание промокода:</b> <code>${escapeHtml(promoCode)}</code>\n\n` +
    `<b>Шаг ${stepNumber}:</b> Выберите целевую аудиторию:`;

  const backAction = isBalance ? 'admin:promos' : 'admin:promo:step:qty';

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Для всех', 'admin:promo:aud:all')],
    [Markup.button.callback('🔄 Со 2-й покупки (повторные заказы)', 'admin:promo:aud:repeat_only')],
    [Markup.button.callback('🆕 Только на первый заказ', 'admin:promo:aud:first_only')],
    [Markup.button.callback('⬅️ Назад', backAction)],
    [Markup.button.callback('❌ Отмена', 'admin:promos')],
  ]);

  await renderWizardStep(ctx, text, keyboard);
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
  renderWizardStep,
  showPromoScopeStep,
  showPromoProductCategories,
  showPromoCategoryProducts,
  showPromoQuantityStep,
  showPromoAudienceStep,
  deletePromo,
};

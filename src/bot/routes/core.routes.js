/**
 * Базовые маршруты: /start, ToS, язык, главное меню, топап-навигация, кабинет продавца, escrow-кнопки покупателя.
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const User = require('../../models/User');
const adminScene = require('../scenes/admin/admin.scene');
const buyerEscrowScene = require('../scenes/buyer_escrow.scene');
const logger = require('../../config/logger');
const profileScene = require('../scenes/profile.scene');
const sellerScene = require('../scenes/seller.scene');
const shopScene = require('../scenes/shop.scene');
const cartScene = require('../scenes/cart.scene');
const topupScene = require('../scenes/topup.scene');
const { Markup } = require('telegraf');
const { adminMiddleware } = require('../middlewares/auth');
const { escapeHtml, formatDateTimeMSK, safeEdit } = require('../utils/ui');
const { mainKeyboard, languageKeyboard } = require('../keyboards/main.keyboard');
const { toRub } = require('../../services/currency.service');
const { tosGateKeyboard, tosGateText, PRIVACY_URL, AGREEMENT_URL } = require('../middlewares/tos');
const { checkUserSubscriptions } = require('../services/channelCheck.service');

const showChannelSubScreen = async (ctx, subCheckResult, isEdit = false) => {
  const { results } = subCheckResult;
  let text = `📢 <b>Для использования бота необходимо подписаться на наши каналы:</b>\n\n`;

  const buttons = [];

  results.forEach((item, idx) => {
    const icon = item.isSubscribed ? '✅' : '❌';
    const statusText = item.isSubscribed ? '<i>Подписан</i>' : '<b>НЕ подписан</b>';
    text += `${idx + 1}. <b>${escapeHtml(item.channel.title)}</b> — ${icon} ${statusText}\n`;

    buttons.push([
      Markup.button.url(`${item.isSubscribed ? '✅' : '📢'} ${idx + 1}. ${item.channel.title}`, item.channel.inviteLink),
    ]);
  });

  text += `\n<i>После подписки на все каналы нажмите кнопку ниже для проверки!</i>`;
  buttons.push([Markup.button.callback('🔄 Проверить подписку', 'channel:check_sub')]);

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
    } catch (err) {
      if (err?.description?.includes('message is not modified')) {
        return;
      }
      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) }).catch(() => {});
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  }
};

module.exports = (bot) => {
  bot.start(async (ctx) => {
    const user = ctx.user;
    const t = ctx.t;

    // Если первый раз - предлагаем выбрать язык
    if (!user) {
      return ctx.reply('⚠️ Не удалось загрузить профиль. Попробуйте позже или обратитесь в поддержку.').catch(() => {});
    }

    // Показываем выбор языка ТОЛЬКО совершенно новым пользователям (первый запуск)
    const isBrandNewUser = (Date.now() - new Date(user.createdAt).getTime() < 10000) && !user.languageSelected;

    if (isBrandNewUser) {
      return ctx.reply('🌐 Выберите язык / Choose language:', languageKeyboard());
    }

    // Экран Оферты (ToS) на языке пользователя (если не принял)
    if (!user.acceptedToS) {
      return ctx.reply(tosGateText(t), { parse_mode: 'HTML', ...tosGateKeyboard(t) });
    }

    // Проверка обязательной подписки на каналы
    const subCheck = await checkUserSubscriptions(ctx.telegram, user.telegramId);
    if (subCheck.isEnabled && !subCheck.allSubscribed) {
      return showChannelSubScreen(ctx, subCheck, false);
    }

    await ctx.reply(
      t('welcome_back', { name: user.firstName, balance: user.balance.toFixed(2), balanceRub: toRub(user.balance) }),
      { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
    );
  });

  // ─────────────────── ToS: согласие / отказ ───────────────────
  bot.action('tos:accept', async (ctx) => {
    const t = ctx.t;
    if (ctx.user && !ctx.user.acceptedToS) {
      // updateOne вместо save(): кэшированный документ общий для параллельных
      // апдейтов (двойной клик по кнопке давал бы ParallelSaveError)
      ctx.user.acceptedToS = true;
      ctx.user.acceptedToSAt = new Date();
      await User.updateOne(
        { _id: ctx.user._id },
        { $set: { acceptedToS: true, acceptedToSAt: ctx.user.acceptedToSAt } }
      ).catch((err) => logger.error(`tos:accept save: ${err.message}`));
    }
    await ctx.answerCbQuery(t('tos_accepted_alert')).catch(() => {});

    // Проверка обязательной подписки на каналы после оферты
    const subCheck = await checkUserSubscriptions(ctx.telegram, ctx.user.telegramId);
    if (subCheck.isEnabled && !subCheck.allSubscribed) {
      return showChannelSubScreen(ctx, subCheck, true);
    }

    try {
      await ctx.editMessageText(
        t('welcome_back', {
          name: escapeHtml(ctx.user.firstName),
          balance: ctx.user.balance.toFixed(2),
          balanceRub: toRub(ctx.user.balance),
        }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      );
    } catch (_) {
      await ctx.reply(
        t('welcome_back', {
          name: escapeHtml(ctx.user.firstName),
          balance: ctx.user.balance.toFixed(2),
          balanceRub: toRub(ctx.user.balance),
        }),
        { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
      ).catch(() => {});
    }
  });

  // ─────────────────── Проверка подписки на каналы ───────────────────
  bot.action('channel:check_sub', async (ctx) => {
    const subCheck = await checkUserSubscriptions(ctx.telegram, ctx.from.id);
    if (!subCheck.isEnabled || subCheck.allSubscribed) {
      await ctx.answerCbQuery('✅ Отлично! Вы подписаны на все каналы. Добро пожаловать!');
      const user = ctx.user;
      const t = ctx.t;
      try {
        await ctx.editMessageText(
          t('welcome', { name: escapeHtml(user.firstName), balance: user.balance.toFixed(2), balanceRub: toRub(user.balance) }),
          { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
        );
      } catch (_) {
        await ctx.reply(
          t('welcome', { name: escapeHtml(user.firstName), balance: user.balance.toFixed(2), balanceRub: toRub(user.balance) }),
          { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
        ).catch(() => {});
      }
      return;
    }

    await ctx.answerCbQuery('❌ Вы ещё не подписались на все каналы! Проверьте список со значком ❌', { show_alert: true });
    await showChannelSubScreen(ctx, subCheck, true);
  });

  bot.action(/^profile:cancel_preorder:(.+)$/, async (ctx) => {
    await profileScene.cancelPreorder(ctx, ctx.match[1]);
  });

  bot.action('tos:accept_broadcast', async (ctx) => {
    const t = ctx.t;
    if (ctx.user) {
      ctx.user.acceptedToS = true;
      ctx.user.acceptedToSAt = new Date();
      await User.updateOne(
        { _id: ctx.user._id },
        { $set: { acceptedToS: true, acceptedToSAt: ctx.user.acceptedToSAt } }
      ).catch((err) => logger.error(`tos:accept_broadcast save: ${err.message}`));
    }
    const alertMsg = t('tos_accepted_alert') || '✅ Вы успешно приняли условия Оферты!';
    await ctx.answerCbQuery(alertMsg, { show_alert: true }).catch(() => {});
    const dateStr = formatDateTimeMSK(new Date());
    const acceptedBtnText = ctx.user?.language === 'en' ? `✅ Terms accepted (${dateStr})` : `✅ Оферта принята (${dateStr})`;
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([[Markup.button.callback(acceptedBtnText, 'shop:noop')]]).reply_markup
    ).catch(() => {});
  });

  bot.action('tos:decline', async (ctx) => {
    const t = ctx.t;
    await ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.editMessageText(t('tos_declined'), { parse_mode: 'HTML' });
    } catch (_) {
      await ctx.reply(t('tos_declined'), { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // ─── BUYER ESCROW ────────────────────────────────────────────────────────────
  bot.action(/^buyer:confirm_order:(.+)$/, async (ctx) => {
    await buyerEscrowScene.confirmOrder(ctx, ctx.match[1]);
  });

  bot.action(/^buyer:dispute_order:(.+)$/, async (ctx) => {
    await buyerEscrowScene.disputeOrder(ctx, ctx.match[1]);
  });

  // ─────────────────── ДОКУМЕНТЫ ───────────────────
  bot.action('menu:documents', async (ctx) => {
    const t = ctx.t;
    await ctx.answerCbQuery().catch(() => {});
    const lines = [
      t('documents_title'),
      '',
      t('documents_text'),
    ];
    if (ctx.user?.acceptedToSAt) {
      lines.push('');
      lines.push(t('documents_accepted_at', {
        date: formatDateTimeMSK(ctx.user.acceptedToSAt),
      }));
    }
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(t('tos_privacy'), PRIVACY_URL)],
      [Markup.button.url(t('tos_agreement'), AGREEMENT_URL)],
      [Markup.button.callback(t('btn_back'), 'menu:main')],
    ]);
    await safeEdit(ctx, lines.join('\n'), { parse_mode: 'HTML', ...keyboard });
  });

  bot.command('admin', adminMiddleware, async (ctx) => {
    await adminScene.showAdminMain(ctx);
  });

  // ─── SELLER: Кабинет продавца ───
  bot.command('seller', async (ctx) => {
    await sellerScene.showSellerCabinet(ctx);
  });

  bot.action('seller:cabinet', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerCabinet(ctx);
  });

  bot.action('seller:orders', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'active');
  });

  bot.action('seller:orders:active', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'active');
  });

  bot.action('seller:orders:history', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.showSellerOrders(ctx, 'history');
  });

  bot.action(/^seller:order:complete:(.+)$/, async (ctx) => {
    await sellerScene.completeSellerOrder(ctx, ctx.match[1]);
  });

  bot.action('seller:wallet:setup', async (ctx) => {
    await sellerScene.startWalletSetup(ctx);
  });

  bot.action(/^seller:wallet:net:(.+)$/, async (ctx) => {
    await sellerScene.handleWalletNetworkChoice(ctx, ctx.match[1]);
  });

  bot.action('seller:withdraw:start', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sellerScene.startWithdraw(ctx);
  });

  bot.action('seller:withdraw:all', async (ctx) => {
    await sellerScene.handleWithdrawAll(ctx);
  });

  bot.action(/^seller:withdraw:confirm:([\d.]+)$/, async (ctx) => {
    await sellerScene.confirmWithdraw(ctx, ctx.match[1]);
  });

  bot.action('seller:noop', (ctx) => ctx.answerCbQuery());

  // ─── Привязка аккаунта продавца (подтверждение админом) ────────────────────
  // Защита от захвата аккаунта по username: заявка создаётся в findSeller,
  // привязка происходит только после явного подтверждения админа.
  bot.action(/^seller:bind:approve:([a-f0-9]{24})$/, adminMiddleware, async (ctx) => {
    const Seller = require('../../models/Seller');
    const seller = await Seller.findOneAndUpdate(
      { _id: ctx.match[1], telegramId: null, claimTelegramId: { $ne: null } },
      [{
        $set: {
          telegramId: '$claimTelegramId',
          claimTelegramId: null,
          claimUsername: null,
          claimRequestedAt: null,
        },
      }],
      { new: true }
    );
    if (!seller) {
      return ctx.answerCbQuery('❌ Заявка не найдена или уже обработана', { show_alert: true });
    }
    await ctx.answerCbQuery('✅ Продавец привязан');
    // Сброс кэша middleware - флаг isSeller должен обновиться сразу
    require('../middlewares/user').invalidateUserCache(seller.telegramId);
    await ctx.editMessageText(`✅ Продавец <b>${seller.username}</b> привязан к Telegram ID <code>${seller.telegramId}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
    const notifService = require('../../services/notification.service');
    await notifService.sendToUser(seller.telegramId, '✅ Ваш аккаунт продавца подтверждён! Откройте кабинет: /seller').catch(() => {});
  });

  bot.action(/^seller:bind:reject:([a-f0-9]{24})$/, adminMiddleware, async (ctx) => {
    const Seller = require('../../models/Seller');
    const seller = await Seller.findOneAndUpdate(
      { _id: ctx.match[1], claimTelegramId: { $ne: null } },
      { $set: { claimTelegramId: null, claimUsername: null, claimRequestedAt: null } },
      { new: false }
    );
    if (!seller) {
      return ctx.answerCbQuery('❌ Заявка не найдена или уже обработана', { show_alert: true });
    }
    await ctx.answerCbQuery('Заявка отклонена');
    await ctx.editMessageText(`❌ Заявка на привязку продавца <b>${seller.username}</b> отклонена.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  // ─────────────────── ЯЗЫК ───────────────────
  bot.action('lang:ru', async (ctx) => {
    // updateOne вместо save(): документ общий для параллельных апдейтов (кэш)
    ctx.user.language = 'ru';
    await User.updateOne({ _id: ctx.user._id }, { $set: { language: 'ru' } });
    ctx.i18n?.setLocale('ru');
    const t = ctx.t || ((k) => k);
    await ctx.answerCbQuery('✅ Язык: Русский');

    if (!ctx.user.acceptedToS) {
      return ctx.editMessageText(tosGateText(t), { parse_mode: 'HTML', ...tosGateKeyboard(t) }).catch(() => {});
    }

    await ctx.editMessageText(
      t('welcome_back', { name: escapeHtml(ctx.user.firstName), balance: ctx.user.balance.toFixed(2), balanceRub: toRub(ctx.user.balance) }),
      { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
    ).catch(() => {});
  });

  bot.action('lang:en', async (ctx) => {
    // updateOne вместо save(): документ общий для параллельных апдейтов (кэш)
    ctx.user.language = 'en';
    await User.updateOne({ _id: ctx.user._id }, { $set: { language: 'en' } });
    ctx.i18n?.setLocale('en');
    const t = ctx.t || ((k) => k);
    await ctx.answerCbQuery('✅ Language: English');

    if (!ctx.user.acceptedToS) {
      return ctx.editMessageText(tosGateText(t), { parse_mode: 'HTML', ...tosGateKeyboard(t) }).catch(() => {});
    }

    await ctx.editMessageText(
      t('welcome_back', { name: escapeHtml(ctx.user.firstName), balance: ctx.user.balance.toFixed(2), balanceRub: toRub(ctx.user.balance) }),
      { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) }
    ).catch(() => {});
  });

  // Кнопка «Сменить язык» из главного меню
  bot.action('menu:lang', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🌐 <b>Выберите язык / Choose language:</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🇷🇺 Русский', 'lang:ru'), Markup.button.callback('🇬🇧 English', 'lang:en')],
          [Markup.button.callback('⬅️ Назад', 'menu:main')],
        ]),
      }
    ).catch(() => {});
  });

  // ─────────────────── ГЛАВНОЕ МЕНЮ ───────────────────
  bot.action('menu:main', async (ctx) => {
    const t = ctx.t;
    const text = t('welcome_back', {
      name: escapeHtml(ctx.user.firstName),
      balance: ctx.user.balance.toFixed(2),
      balanceRub: toRub(ctx.user.balance),
    });
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...mainKeyboard(t, ctx.isSeller) });
  });

  bot.action('menu:shop', async (ctx) => {
    await shopScene.showShopPage(ctx, 1);
  });

  // ─── КОРЗИНА ТОВАРОВ ───
  bot.action(['menu:cart', 'cart:main'], async (ctx) => {
    await cartScene.showCart(ctx);
  });

  bot.action(/^cart:add:(.+)$/, async (ctx) => {
    await cartScene.handleAddToCart(ctx, ctx.match[1]);
  });

  bot.action(/^cart:qty:(.+):(-?\d+)$/, async (ctx) => {
    await cartScene.handleUpdateQty(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^cart:remove:(.+)$/, async (ctx) => {
    await cartScene.handleRemoveItem(ctx, ctx.match[1]);
  });

  bot.action('cart:clear', async (ctx) => {
    await cartScene.handleClearCart(ctx);
  });

  bot.action('cart:checkout', async (ctx) => {
    await cartScene.handleCheckout(ctx);
  });

  bot.action('cart:promo', async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.userAction = 'enter_promo';
    ctx.session.promoReturnTo = 'cart';
    const text = `🎟 <b>Применение промокода</b>\n\n` +
      `Введите код купона/промокода в ответном сообщении для получения скидки на корзину:`;
    await safeEdit(ctx, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад в корзину', 'menu:cart')]]),
    });
  });

  bot.action('menu:profile', async (ctx) => {
    await profileScene.showProfile(ctx);
  });

  bot.action('menu:topup', async (ctx) => {
    await topupScene.startTopup(ctx);
  });

  // Быстрое пополнение на нужную сумму (из карточки товара при нехватке средств)
  bot.action(/^topup:quick:([\d.]+)$/, async (ctx) => {
    const amount = parseFloat(ctx.match[1]);
    if (!amount || amount <= 0) {
      return ctx.answerCbQuery('⚠️ Некорректная сумма', { show_alert: true });
    }
    await topupScene.startTopupWithAmount(ctx, amount);
  });

  // ─────────────────── ПОПОЛНЕНИЕ - выбор способа ───────────────────
  // Авто-оплата (стаб) - ничего не делаем
  bot.action('topup:auto_stub', (ctx) => ctx.answerCbQuery('⚠️ Временно недоступно', { show_alert: true }));

  // Прямой перевод
  bot.action('topup:method:direct', async (ctx) => {
    await topupScene.showDirectOptions(ctx);
  });

  // Назад (к выбору платёжной системы)
  bot.action('topup:pay:back', async (ctx) => {
    await topupScene.showDirectOptions(ctx);
  });

  // Карта
  bot.action('topup:pay:card', async (ctx) => {
    await topupScene.showCardDetails(ctx);
  });

  // Bybit - выбор сети
  bot.action('topup:pay:bybit', async (ctx) => {
    await topupScene.showBybitOptions(ctx);
  });

  // Bybit - конкретная сеть
  bot.action(/^topup:network:(trc20|bep20|uid)$/, async (ctx) => {
    await topupScene.showBybitNetwork(ctx, ctx.match[1]);
  });

  // UX-1: быстрые пресеты сумм на экране ввода.
  bot.action(/^topup:preset:(usdt|rub):(\d+(?:\.\d+)?)$/, async (ctx) => {
    await topupScene.handlePresetAmount(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action('topup:enter_txid', async (ctx) => {
    await topupScene.handleEnterTxid(ctx);
  });

  // «Я оплатил» - подтверждение оплаты картой
  bot.action('topup:card_paid', async (ctx) => {
    const topup = ctx.session?.topup;
    if (!topup || topup.method !== 'card') {
      return ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true });
    }
    if (topup.step === 'proof') {
      return ctx.answerCbQuery('✅ Уже ожидаем скриншот чека');
    }
    topup.step = 'proof';
    await safeEdit(
      ctx,
      `✅ <b>Оплата подтверждена!</b>\n\n📸 Теперь пришлите <b>скриншот чека</b> для проверки оператором:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'menu:topup')]]),
      }
    );
  });

  bot.action('menu:support', async (ctx) => {
    const t = ctx.t;
    const lang = ctx.user?.language || 'ru';
    const { TEXTS } = require('../constants/ux');
    const supportLink = TEXTS.SUPPORT_URL;
    const btnLabel = lang === 'en' ? '✉️ Write to Support' : '✉️ Написать поддержке';

    await safeEdit(
      ctx,
      t('support_text'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url(btnLabel, supportLink)],
          [Markup.button.callback(t('btn_back'), 'menu:main')],
        ]),
      }
    );
  });

  bot.action('menu:about', async (ctx) => {
    const t = ctx.t;
    await safeEdit(
      ctx,
      t('about_text'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'menu:main')]]),
      }
    );
  });
};

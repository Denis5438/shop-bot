/**
 * Маршруты профиля (profile:*).
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const profileScene = require('../scenes/profile.scene');
const { Markup } = require('telegraf');

module.exports = (bot) => {
  // ─────────────────── ПРОФИЛЬ ───────────────────
  bot.action('profile:orders', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showOrders(ctx, 'all', 1);
  });

  bot.action(/^profile:orders:(active|all):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showOrders(ctx, ctx.match[1], parseInt(ctx.match[2]));
  });

  bot.action(/^profile:order:detail:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showOrderDetail(ctx, ctx.match[1]);
  });

  bot.action(/^profile:order:send_data:(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const mongoose = require('mongoose');
    const lang = ctx.user?.language || 'ru';

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
    }

    const Order = require('../../models/Order');
    const order = await Order.findById(orderId)
      .populate('productId')
      .populate('keyId')
      .populate('replacedKeyId');

    if (!order || !ctx.user?._id || order.userId.toString() !== ctx.user._id.toString()) {
      return ctx.answerCbQuery(lang === 'en' ? '❌ Order not found' : '❌ Заказ не найден', { show_alert: true });
    }

    const itemValue = order.replacedKeyId?.value || order.deliveryData || order.keyId?.value;
    if (!itemValue || order.status !== 'completed') {
      const emptyAlert = lang === 'en'
        ? '⚠️ Product data is not available yet'
        : '⚠️ Данные товара пока недоступны';
      return ctx.answerCbQuery(emptyAlert, { show_alert: true });
    }

    const { formatDigitalItem, escapeHtml } = require('../utils/ui');
    const productName = (lang === 'en' && order.productId?.nameEn ? order.productId.nameEn : order.productId?.name) || (lang === 'en' ? 'Product' : 'Товар');
    const icon = order.productId?.icon || '🔐';

    const maxPreLen = 2500;
    const safeCopyVal = itemValue.length > maxPreLen ? `${itemValue.slice(0, maxPreLen)}...` : itemValue;

    const msg = lang === 'en'
      ? `🔐 <b>Your Account / Order Data</b>\n\n` +
        `📦 <b>Product:</b> ${escapeHtml(icon)} ${escapeHtml(productName)}\n` +
        `📋 <b>Order:</b> <code>${order._id}</code>\n\n` +
        `👤 <b>Login Credentials:</b>\n` +
        `${formatDigitalItem(itemValue, lang)}\n\n` +
        `📋 <b>Full line (tap to copy all):</b>\n` +
        `<pre><code>${escapeHtml(safeCopyVal)}</code></pre>\n\n` +
        `💡 <i>These details are always available in your order history.</i>`
      : `🔐 <b>Данные вашего аккаунта / заказа</b>\n\n` +
        `📦 <b>Товар:</b> ${escapeHtml(icon)} ${escapeHtml(productName)}\n` +
        `📋 <b>Заказ:</b> <code>${order._id}</code>\n\n` +
        `👤 <b>Данные для входа:</b>\n` +
        `${formatDigitalItem(itemValue, lang)}\n\n` +
        `📋 <b>Полная связка (нажмите для копирования целиком):</b>\n` +
        `<pre><code>${escapeHtml(safeCopyVal)}</code></pre>\n\n` +
        `💡 <i>Эти данные всегда сохранены в вашем профиле и доступны в любое время.</i>`;

    const backBtn = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'en' ? '📋 Back to order' : '📋 К заказу', `profile:order:detail:${order._id}`)],
    ]);

    try {
      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...backBtn,
      });
      const alertText = lang === 'en'
        ? '✅ Account data sent to chat!'
        : '✅ Данные аккаунта отправлены в чат!';
      await ctx.answerCbQuery(alertText, { show_alert: true });
    } catch (_) {
      try {
        const plainHeader = lang === 'en' ? '🔐 Your order data:\n\n' : '🔐 Данные вашего заказа:\n\n';
        await ctx.reply(plainHeader + itemValue, backBtn);
        const alertText = lang === 'en'
          ? '✅ Account data sent to chat!'
          : '✅ Данные аккаунта отправлены в чат!';
        await ctx.answerCbQuery(alertText, { show_alert: true });
      } catch (sendErr) {
        const failAlert = lang === 'en'
          ? '❌ Failed to send data to chat'
          : '❌ Не удалось отправить данные в чат';
        await ctx.answerCbQuery(failAlert, { show_alert: true });
      }
    }
  });

  bot.action('profile:referral', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const referralScene = require('../scenes/referral.scene');
    await referralScene.showReferral(ctx);
  });

  bot.action(/^profile:warranty:claim:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    ctx.session = ctx.session || {};
    ctx.session.userAction = 'warranty_claim';
    ctx.session.claimOrderId = orderId;

    await ctx.reply(
      `🛡 <b>Запрос замены по гарантии</b>\n\n` +
      `Пожалуйста, напишите описание проблемы (что не работает в аккаунте), и при желании отправьте скриншот ошибки:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `profile:order:detail:${orderId}`)]]),
      }
    );
  });

  // ─── История пополнений ─────────────────────────────────────
  bot.action('profile:topups', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await profileScene.showTopupHistory(ctx, 1);
  });

  bot.action(/^profile:topups:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await profileScene.showTopupHistory(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^profile:topup:detail:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await profileScene.showTopupDetail(ctx, ctx.match[1]);
  });

  bot.action('profile:noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

  // №20 Достижения
  bot.action('profile:achievements', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showAchievements(ctx);
  });

  bot.action(/^profile:continue_order:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('▶️ Продолжаю...');
    const orderId = ctx.match[1];
    const Order = require('../../models/Order');
    const order = await Order.findById(orderId);
    if (!order || order.status !== 'awaiting_token') {
      return ctx.reply('❌ Заказ уже не активен.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В профиль', 'menu:profile')]]),
      });
    }
    await ctx.scene.enter('token_collection', { orderId: orderId.toString() });
  });

  bot.action('profile:lang', async (ctx) => {
    await ctx.answerCbQuery();
    await profileScene.showLanguageSelect(ctx);
  });

  bot.action('profile:toggle_btn_style', async (ctx) => {
    await profileScene.toggleBtnStyle(ctx);
  });

  bot.action('user:activate_promo', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    ctx.session = ctx.session || {};
    ctx.session.userAction = 'enter_promo';
    ctx.session.promoReturnTo = 'profile';
    if (ctx.callbackQuery?.message?.message_id) {
      ctx.session.promoMsgId = ctx.callbackQuery.message.message_id;
    }

    const text = `🎟 <b>Активация промокода</b>\n\n` +
      `Введите ваш промокод в ответном сообщении:`;

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'promo:cancel')]]);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...keyboard }));
  });
};

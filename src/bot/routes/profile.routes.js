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
};

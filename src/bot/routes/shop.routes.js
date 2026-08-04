/**
 * Маршруты магазина (shop:*).
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const shopScene = require('../scenes/shop.scene');
const { Markup } = require('telegraf');

module.exports = (bot) => {
  // ─────────────────── МАГАЗИН ───────────────────
  bot.action('shop:main', async (ctx) => {
    await shopScene.showShopPage(ctx);
  });

  bot.action(/^shop:category:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const categoryId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.showCategory(ctx, categoryId, page);
  });

  bot.action(/^shop:toggle_out:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const categoryId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.toggleOutOfStock(ctx, categoryId, page);
  });

  // shop:page is deprecated for categories, but left for backward compatibility if any
  bot.action(/^shop:page:(\d+)$/, async (ctx) => {
    await shopScene.showShopPage(ctx);
  });

  // Формат: shop:product:<id>:<page?> - page опционален для обратной совместимости.
  bot.action(/^shop:product:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.showProduct(ctx, productId, page);
  });

  bot.action(/^shop:notify:([^:]+)$/, async (ctx) => {
    const productId = ctx.match[1];
    await shopScene.handleWaitlist(ctx, productId);
  });

  bot.action(/^shop:preorder_qty:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showPreorderQuantitySelect(ctx, productId, page, qty);
  });

  bot.action(/^shop:preorder_qty_inc:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showPreorderQuantitySelect(ctx, productId, page, qty + 1);
  });

  bot.action(/^shop:preorder_qty_dec:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showPreorderQuantitySelect(ctx, productId, page, Math.max(1, qty - 1));
  });

  bot.action(/^shop:preorder_qty_set:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showPreorderQuantitySelect(ctx, productId, page, qty);
  });

  bot.action(/^shop:preorder:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const qty = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.confirmPreorder(ctx, productId, qty);
  });

  bot.action(/^shop:preorder_confirm:([^:]+)(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const qty = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await shopScene.processPreorder(ctx, productId, qty);
  });

  bot.action(/^shop:qty:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showQuantitySelect(ctx, productId, page, qty);
  });

  bot.action(/^shop:qty_inc:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showQuantitySelect(ctx, productId, page, qty + 1);
  });

  bot.action(/^shop:qty_dec:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showQuantitySelect(ctx, productId, page, qty - 1);
  });

  bot.action(/^shop:qty_set:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.showQuantitySelect(ctx, productId, page, qty);
  });

  bot.action(/^shop:buy:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.confirmPurchase(ctx, productId, page, qty);
  });

  bot.action(/^shop:confirm:([^:]+)(?::(\d+))?(?::(\d+))?$/, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    const qty = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await shopScene.processPurchase(ctx, productId, page, qty);
  });

  bot.action('shop:noop', (ctx) => ctx.answerCbQuery());

  // Бесплатная проверка токена до оплаты (№6 Auto-token verification)
  bot.action(/^shop:check_token:(.+)$/, async (ctx) => {
    const productId = ctx.match[1];
    const t = ctx.t || ((k) => k);
    ctx.session = ctx.session || {};
    ctx.session.tokenCheck = {
      productId,
      startedAt: Date.now(),
    };
    await ctx.answerCbQuery().catch(() => {});
    const text =
      `${t('token_check_title')}\n\n` +
      `${t('token_check_intro')}\n\n` +
      `${t('token_check_how_to')}`;
    const opts = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t('btn_cancel'), `shop:check_token_cancel:${productId}`)],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts);
    }
  });

  bot.action(/^shop:check_token_cancel:(.+)$/, async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.tokenCheck = null;
    await ctx.answerCbQuery('❌ Отменено').catch(() => {});
    await shopScene.showProduct(ctx, ctx.match[1]);
  });
};

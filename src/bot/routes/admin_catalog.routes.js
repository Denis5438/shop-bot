/**
 * Админ: категории и привязка категории к товару (локальный isAdmin-гейт сохранён как в оригинале).
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const categoriesScene = require('../scenes/admin/categories.scene');
const productsScene = require('../scenes/admin/products.scene');
const { Markup } = require('telegraf');

module.exports = (bot) => {
  // ─────────────────── КАТЕГОРИИ (АДМИН) ───────────────────
  const isAdmin = (ctx, next) => (ctx.user?.role === 'admin' ? next() : null);

  bot.action('admin:categories', isAdmin, async (ctx) => {
    await categoriesScene.showCategories(ctx);
  });

  bot.action('admin:category:add', isAdmin, async (ctx) => {
    await categoriesScene.startAddCategory(ctx);
  });

  bot.action(/^admin:category:edit:([^:]+)$/, isAdmin, async (ctx) => {
    await categoriesScene.showCategoryEdit(ctx, ctx.match[1]);
  });

  bot.action(/^admin:category:products:([^:]+)(?::(\d+))?$/, isAdmin, async (ctx) => {
    const catId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await categoriesScene.showCategoryProducts(ctx, catId, page);
  });

  bot.action(/^admin:product:add_to_cat:([^:]+)$/, isAdmin, async (ctx) => {
    const catId = ctx.match[1];
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'add_product';
    ctx.session.newProduct = { categoryId: catId };
    ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

    const Category = require('../../models/Category');
    const cat = await Category.findById(catId);
    const catName = cat ? `${cat.icon} ${cat.name}` : 'выбранную';

    const text =
      `➕ <b>Новый товар в категорию «${catName}»</b>\n\n` +
      `Выберите <b>тип товара</b>:\n\n` +
      `🔑 <b>Ключи</b> - бот сразу отправляет ключ/код из базы\n` +
      `🤖 <b>GPT Активация</b> - авто-активация на аккаунте пользователя\n` +
      `✋ <b>Ручной</b> - выдаёте товар сами вручную`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔑 Ключи', 'admin:product:add_type:key'),
        Markup.button.callback('🤖 GPT Активация', 'admin:product:add_type:gpt_activation'),
      ],
      [Markup.button.callback('✋ Ручной', 'admin:product:add_type:manual')],
      [Markup.button.callback('❌ Отмена', `admin:category:edit:${catId}`)],
    ]);

    const { safeEdit } = require('../utils/ui');
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action(/^admin:category:toggle:([^:]+)$/, isAdmin, async (ctx) => {
    const Category = require('../../models/Category');
    const cat = await Category.findById(ctx.match[1]);
    if (cat) {
      cat.isActive = !cat.isActive;
      await cat.save();
    }
    await categoriesScene.showCategoryEdit(ctx, ctx.match[1]);
  });

  bot.action(/^admin:category:del:([^:]+)$/, isAdmin, async (ctx) => {
    const Category = require('../../models/Category');
    const Product = require('../../models/Product');
    const hasProducts = await Product.exists({ categoryId: ctx.match[1] });
    if (hasProducts) {
      return ctx.answerCbQuery('❌ Сначала удалите или переместите все товары из этой категории!', { show_alert: true });
    }
    await Category.findByIdAndDelete(ctx.match[1]);
    await ctx.answerCbQuery('✅ Категория удалена');
    await categoriesScene.showCategories(ctx);
  });

  // ─────────────────── ТОВАРЫ: СМЕНА КАТЕГОРИИ ───────────────────
  bot.action(/^admin:product:set_cat:([^:]+)(?::([^:]+))?(?::(\d+))?$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const session = ctx.session || {};
    const catId = ctx.match[1] === 'none' ? null : ctx.match[1];
    const directProductId = ctx.match[2];
    const directPage = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;

    const Product = require('../../models/Product');

    // Если передан directProductId или session.adminAction === 'edit_product_field'
    if (directProductId || session.adminAction === 'edit_product_field') {
      const rawId = directProductId || session.productId;
      if (!rawId) {
        return ctx.answerCbQuery('❌ Ошибка: товар не найден', { show_alert: true });
      }
      const productId = String(rawId).split(':')[0]; // Защита от суффикса :page
      const page = directPage || session.productPage || 1;

      await Product.updateOne({ _id: productId }, { $set: { categoryId: catId } });
      ctx.session.adminAction = null;
      ctx.session.productId = null;
      ctx.session.field = null;
      ctx.session.productPage = null;
      await productsScene.showProductEdit(ctx, productId, page);
      return;
    }

    if (session.adminAction === 'add_product') {
      const np = session.newProduct || {};
      const { normalizeProviderForType } = require('../../services/provider.service');
      const provider = normalizeProviderForType(np.type, 'local');
      const product = new Product({
        name: np.name,
        nameEn: np.nameEn,
        price: np.price,
        costPrice: np.costPrice,
        type: np.type,
        provider,
        deliveryMethod: np.type === 'gpt_activation' ? 'activation' : 'ready_account',
        description: np.description,
        descriptionEn: np.descriptionEn,
        icon: np.icon,
        categoryId: catId
      });
      await product.save();
      
      ctx.session.adminAction = null;
      ctx.session.newProduct = null;

      if (np.type === 'key' || np.type === 'gpt_activation') {
        const keysScene = require('../scenes/admin/keys.scene');
        await keysScene.askKeysAfterCreate(ctx, product);
      } else {
        const { escapeHtml } = require('../utils/ui');
        await ctx.editMessageText(
          `✅ <b>Товар «${escapeHtml(product.name)}» создан!</b>\n📦 Тип: ✋ Ручной\n\n` +
          `Хотите назначить продавца на этот товар?`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('👤 Назначить продавца', `admin:product:seller:${product._id}`)],
              [Markup.button.callback('📣 Разослать всем', `admin:product:broadcast:${product._id}`)],
              [Markup.button.callback('📦 К товарам', 'admin:products')],
            ]),
          }
        ).catch(() => {});
      }
      return;
    }
  });

  bot.action(/^admin:product:field:category:(.+?)(?::(\d+))?$/, isAdmin, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'edit_product_field';
    ctx.session.productId = productId;
    ctx.session.productPage = page;
    ctx.session.field = 'category';

    const Category = require('../../models/Category');
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 });
    const buttons = categories.map(cat => [
      Markup.button.callback(`${cat.icon} ${cat.name}`, `admin:product:set_cat:${cat._id}:${productId}:${page}`)
    ]);
    buttons.push([Markup.button.callback('Без категории', `admin:product:set_cat:none:${productId}:${page}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}:${page}`)]);

    const { safeEdit } = require('../utils/ui');
    await safeEdit(ctx, 'Выберите новую категорию:', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    });
    await ctx.answerCbQuery().catch(() => {});
  });
};

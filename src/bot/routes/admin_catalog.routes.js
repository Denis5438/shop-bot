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

  // ─────────────────── ТОВАРЫ ───────────────────
  bot.action(/^admin:product:set_cat:(.+)$/, isAdmin, async (ctx) => {
    const session = ctx.session;
    if (session.adminAction !== 'add_product' && session.adminAction !== 'edit_product_field') return;
    
    const Product = require('../../models/Product');
    const catId = ctx.match[1] === 'none' ? null : ctx.match[1];
    
    if (session.adminAction === 'add_product') {
      const np = session.newProduct;
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
    } else if (session.adminAction === 'edit_product_field') {
      const { productId } = session;
      await Product.updateOne({ _id: productId }, { $set: { categoryId: catId } });
      ctx.session.adminAction = null;
      ctx.session.productId = null;
      ctx.session.field = null;
      await ctx.answerCbQuery('✅ Категория изменена');
      await productsScene.showProductEdit(ctx, productId);
    }
  });

  bot.action(/^admin:product:field:category:(.+)$/, isAdmin, async (ctx) => {
    ctx.session.adminAction = 'edit_product_field';
    ctx.session.productId = ctx.match[1];
    ctx.session.field = 'category';

    const Category = require('../../models/Category');
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 });
    const buttons = categories.map(cat => [
      Markup.button.callback(`${cat.icon} ${cat.name}`, `admin:product:set_cat:${cat._id}`)
    ]);
    buttons.push([Markup.button.callback('Без категории', 'admin:product:set_cat:none')]);
    buttons.push([Markup.button.callback('❌ Отмена', `admin:product:edit:${ctx.match[1]}`)]);

    await ctx.editMessageText('Выберите новую категорию:', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    });
  });
};

const { Markup } = require('telegraf');
const Category = require('../../../models/Category');
const Product = require('../../../models/Product');
const { escapeHtml, safeEdit } = require('../../utils/ui');

const showCategories = async (ctx) => {
  const categories = await Category.find().sort({ sortOrder: 1 });
  const buttons = categories.map(cat => [
    Markup.button.callback(`${cat.icon} ${cat.name} ${cat.isActive ? '' : '(Скрыта)'}`, `admin:category:edit:${cat._id}`)
  ]);

  buttons.push([Markup.button.callback('➕ Создать категорию', 'admin:category:add')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  const text = `🗂 <b>Управление Категориями</b>\n\nВыберите категорию для редактирования или создайте новую:`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const startAddCategory = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_category';
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const text = `➕ <b>Новая категория</b>\n\nВведите название (например: <code>ChatGPT</code>):`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:categories')]]);
  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
};

const handleCategoryInput = async (ctx) => {
  const session = ctx.session || {};

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const targetMsgId = session.wizardMsgId;

  if (session.adminAction === 'add_category') {
    const name = ctx.message.text.trim();
    if (!name) return true;

    session.newCategoryName = name;
    session.adminAction = 'add_category_icon';

    const text = `Название: <b>${escapeHtml(name)}</b>\n\nТеперь отправьте эмодзи для категории (например: 🤖):`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:categories')]]);

    if (targetMsgId) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
        return true;
      } catch (_) {}
    }

    const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    if (sent?.message_id) session.wizardMsgId = sent.message_id;
    return true;
  }

  if (session.adminAction === 'add_category_icon') {
    const icon = ctx.message.text.trim();
    if (!icon) return true;

    const cat = new Category({ name: session.newCategoryName, icon });
    await cat.save();

    session.adminAction = null;
    session.newCategoryName = null;
    session.wizardMsgId = null;

    const text = `✅ Категория <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b> успешно создана!`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🗂 К категориям', 'admin:categories')]]);

    if (targetMsgId) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
        return true;
      } catch (_) {}
    }

    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    return true;
  }

  return false;
};

const showCategoryEdit = async (ctx, catId) => {
  const cat = await Category.findById(catId);
  if (!cat) return ctx.answerCbQuery('❌ Не найдена', { show_alert: true });

  const productsCount = await Product.countDocuments({ categoryId: catId });

  const text =
    `🗂 Категория: <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b>\n` +
    `📦 Товаров в категории: <b>${productsCount} шт.</b>\n` +
    `🔘 Статус: ${cat.isActive ? '✅ Активна' : '🔴 Скрыта'}\n\n` +
    `Выберите действие:`;

  const buttons = [
    [Markup.button.callback('➕ Добавить товар из списка', `admin:category:attach:${cat._id}:1`)],
  ];

  if (productsCount > 0) {
    buttons.push([Markup.button.callback(`📦 Товары категории (${productsCount} шт.)`, `admin:category:products:${cat._id}:1`)]);
  }

  buttons.push([Markup.button.callback('➕ Создать новый товар', `admin:product:add_to_cat:${cat._id}`)]);

  buttons.push([
    cat.isActive
      ? Markup.button.callback('🔴 Скрыть', `admin:category:toggle:${cat._id}`)
      : Markup.button.callback('🟢 Показать', `admin:category:toggle:${cat._id}`),
    Markup.button.callback('🗑 Удалить', `admin:category:del:${cat._id}`)
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:categories')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const showAttachProductsToCategory = async (ctx, catId, page = 1) => {
  page = Math.max(1, parseInt(page, 10) || 1);
  const cat = await Category.findById(catId);
  if (!cat) return ctx.answerCbQuery('❌ Категория не найдена', { show_alert: true });

  const limit = 8;
  const skip = (page - 1) * limit;

  const [products, totalCount] = await Promise.all([
    Product.find().populate('categoryId').sort({ categoryId: 1, createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  const buttons = products.map(p => {
    const isThisCat = p.categoryId?._id?.toString() === catId.toString() || p.categoryId?.toString() === catId.toString();
    const otherCat = !isThisCat && p.categoryId ? ` (${p.categoryId.name})` : '';
    const label = isThisCat
      ? `✅ ${p.name} (В этой)`
      : (!p.categoryId ? `➕ ${p.name} (Без кат.)` : `🔄 ${p.name}${otherCat}`);
    return [Markup.button.callback(label, `adm:c_add:${catId}:${p._id}`)];
  });

  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `admin:category:attach:${catId}:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'admin:noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `admin:category:attach:${catId}:${page + 1}`));
  if (nav.length > 1) buttons.push(nav);

  buttons.push([Markup.button.callback('✅ Готово (к категории)', `admin:category:edit:${catId}`)]);

  const text =
    `🗂 Привязка товаров к <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b>\n\n` +
    `💡 <i>Нажмите на товар, чтобы добавить его в эту категорию или убрать:</i>\n\n` +
    `• ✅ — товар уже в этой категории\n` +
    `• ➕ — товар без категории\n` +
    `• 🔄 — переместить из другой категории`;

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const toggleProductCategory = async (ctx, catId, productId, page = 1) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const isCurrent = product.categoryId?.toString() === catId.toString();
  if (isCurrent) {
    product.categoryId = null;
    await product.save();
    await ctx.answerCbQuery('➖ Товар отвязан от категории').catch(() => {});
  } else {
    product.categoryId = catId;
    await product.save();
    await ctx.answerCbQuery('✅ Товар добавлен в эту категорию!').catch(() => {});
  }

  await showAttachProductsToCategory(ctx, catId, page);
};

const showCategoryProducts = async (ctx, catId, page = 1) => {
  page = Math.max(1, parseInt(page, 10) || 1);
  const cat = await Category.findById(catId);
  if (!cat) return ctx.answerCbQuery('❌ Категория не найдена', { show_alert: true });

  const limit = 8;
  const skip = (page - 1) * limit;
  const [products, totalCount] = await Promise.all([
    Product.find({ categoryId: catId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments({ categoryId: catId }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  const buttons = products.map(p => [
    Markup.button.callback(`${p.icon || '📦'} ${p.name} ($${p.price}) ${p.isActive ? '' : '🔴'}`, `admin:product:edit:${p._id}:${page}`)
  ]);

  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `admin:category:products:${catId}:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'admin:noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `admin:category:products:${catId}:${page + 1}`));
  if (nav.length > 1) buttons.push(nav);

  buttons.push([Markup.button.callback('➕ Привязать товар сюда', `admin:category:attach:${catId}:1`)]);
  buttons.push([Markup.button.callback('⬅️ К категории', `admin:category:edit:${catId}`)]);

  const text =
    `🗂 Категория: <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b>\n` +
    `📦 Список товаров (Всего: ${totalCount} шт.):\n\n` +
    `Выберите товар для редактирования:`;

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

module.exports = {
  showCategories,
  startAddCategory,
  handleCategoryInput,
  showCategoryEdit,
  showCategoryProducts,
  showAttachProductsToCategory,
  toggleProductCategory
};

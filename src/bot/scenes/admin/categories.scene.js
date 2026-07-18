const { Markup } = require('telegraf');
const Category = require('../../../models/Category');
const Product = require('../../../models/Product');
const { escapeHtml } = require('../../utils/ui');

const showCategories = async (ctx) => {
  const categories = await Category.find().sort({ sortOrder: 1 });
  const buttons = categories.map(cat => [
    Markup.button.callback(`${cat.icon} ${cat.name} ${cat.isActive ? '' : '(Скрыта)'}`, `admin:category:edit:${cat._id}`)
  ]);

  buttons.push([Markup.button.callback('➕ Создать категорию', 'admin:category:add')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  const text = `🗂 <b>Управление Категориями</b>\n\nВыберите категорию для редактирования или создайте новую:`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

const startAddCategory = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_category';
  
  await ctx.editMessageText(
    `➕ <b>Новая категория</b>\n\nВведите название (например: <code>ChatGPT</code>):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:categories')]])
    }
  ).catch(() => {});
};

const handleCategoryInput = async (ctx) => {
  const session = ctx.session || {};

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  if (session.adminAction === 'add_category') {
    const name = ctx.message.text.trim();
    if (!name) return true;

    session.newCategoryName = name;
    session.adminAction = 'add_category_icon';

    await ctx.reply(`Название: <b>${escapeHtml(name)}</b>\n\nТеперь отправьте эмодзи для категории (например: 🤖):`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:categories')]])
    });
    return true;
  }

  if (session.adminAction === 'add_category_icon') {
    const icon = ctx.message.text.trim();
    if (!icon) return true;

    const cat = new Category({ name: session.newCategoryName, icon });
    await cat.save();

    session.adminAction = null;
    session.newCategoryName = null;

    await ctx.reply(`✅ Категория <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b> создана!`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🗂 К категориям', 'admin:categories')]])
    });
    return true;
  }

  return false;
};

const showCategoryEdit = async (ctx, catId) => {
  const cat = await Category.findById(catId);
  if (!cat) return ctx.answerCbQuery('❌ Не найдена', { show_alert: true });

  const text = `🗂 Категория: <b>${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</b>\n\nВыберите действие:`;
  const buttons = [
    [
      cat.isActive
        ? Markup.button.callback('🔴 Скрыть', `admin:category:toggle:${cat._id}`)
        : Markup.button.callback('🟢 Показать', `admin:category:toggle:${cat._id}`),
      Markup.button.callback('🗑 Удалить', `admin:category:del:${cat._id}`)
    ],
    [Markup.button.callback('⬅️ Назад', 'admin:categories')]
  ];

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

module.exports = {
  showCategories,
  startAddCategory,
  handleCategoryInput,
  showCategoryEdit
};

const { Markup } = require('telegraf');
const axios = require('axios');
const Product = require('../../../models/Product');
const Key = require('../../../models/Key');
const { getProviderLabel, resolveProductProvider, buildKeyQueryForProduct } = require('../../../services/provider.service');
const notif = require('../../../services/notification.service');
const { escapeHtml, safeEdit } = require('../../utils/ui');

const showKeysList = async (ctx) => {
  const products = await Product.find().sort({ sortOrder: 1 }).lean();

  if (products.length === 0) {
    const text = '🔑 <b>Управление Ключами</b>\n\nНет созданных товаров.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:main')]]);
    return safeEdit(ctx, text, keyboard);
  }

  // Оптимизация: 2 aggregation-запроса вместо 2N countDocuments в цикле.
  // Группируем ключи по productId и статусу isUsed.
  const [activeCounts, usedCounts] = await Promise.all([
    Key.aggregate([
      { $match: { isUsed: false } },
      { $group: { _id: '$productId', count: { $sum: 1 } } },
    ]),
    Key.aggregate([
      { $match: { isUsed: true } },
      { $group: { _id: '$productId', count: { $sum: 1 } } },
    ]),
  ]);

  const activeMap = new Map(activeCounts.map((r) => [String(r._id), r.count]));
  const usedMap = new Map(usedCounts.map((r) => [String(r._id), r.count]));

  let text = '🔑 <b>Управление Авто-товарами и Ключами</b>\n\n';
  const buttons = [];

  for (const product of products) {
    const pId = String(product._id);
    const active = activeMap.get(pId) || 0;
    const used = usedMap.get(pId) || 0;
    const provider = resolveProductProvider(product);

    text +=
      `📦 <b>${escapeHtml(product.name)}</b>\n` +
      `   ├ Доступно: <b>${active}</b> шт.\n` +
      `   ├ Использовано: <b>${used}</b> шт.\n` +
      `   └ Поставщик: ${escapeHtml(getProviderLabel(provider))}\n\n`;

    buttons.push([
      Markup.button.callback(
        `➕ Загрузить: ${product.name.slice(0, 16)}`,
        `admin:keys:add:${product._id}`
      ),
    ]);

    if (used > 0) {
      buttons.push([
        Markup.button.callback(`🗑 Очистить использ. (${used})`, `admin:keys:clear:${product._id}`),
      ]);
    }
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);
  await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
};

const askKeysAfterCreate = async (ctx, product) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_keys';
  ctx.session.keysProductId = product._id.toString();
  ctx.session.keysProductAfterCreate = true;

  const text =
    `✅ <b>Товар «${escapeHtml(product.name)}» создан!</b>\n\n` +
    `🔑 <b>Загрузка авто-товаров / аккаунтов / ключей:</b>\n\n` +
    `▫️ Отправьте <b>.txt файл</b> (каждый товар с новой строки)\n` +
    `▫️ Или отправьте <b>текстовое сообщение</b>:\n\n` +
    `<i>Поддерживаемые форматы (по 1 строке на товар):</i>\n` +
    `• <code>login:pass</code>\n` +
    `• <code>login:pass:2fa</code>\n` +
    `• <code>login|pass|2fa</code>\n` +
    `• <code>https://ссылка</code>\n` +
    `• <code>промокод_или_ключ</code>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⏩ Пропустить (добавлю позже)', `admin:product:broadcast:${product._id}`)],
    [Markup.button.callback('❌ Отмена', 'admin:products')],
  ]);

  const sent = await safeEdit(ctx, text, keyboard);
  if (sent?.message_id) ctx.session.wizardMsgId = sent.message_id;
};

const startAddKeys = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_keys';
  ctx.session.keysProductId = productId;
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const text =
    `🔑 <b>Загрузка товаров для: ${escapeHtml(product.name)}</b>\n\n` +
    `▫️ Отправьте <b>.txt файл</b> (каждый товар с новой строки)\n` +
    `▫️ Или отправьте <b>текстовое сообщение</b>:\n\n` +
    `<i>Поддерживаемые форматы (по 1 строке на товар):</i>\n` +
    `• <code>login:pass</code>\n` +
    `• <code>login:pass:2fa</code>\n` +
    `• <code>login|pass|2fa</code>\n` +
    `• <code>https://ссылка</code>\n` +
    `• <code>промокод_или_ключ</code>`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]]);
  await safeEdit(ctx, text, keyboard);
};

const handleKeysInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'add_keys') return false;

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const targetMsgId = session.wizardMsgId;
  const productId = session.keysProductId;
  const afterCreate = session.keysProductAfterCreate || false;
  const product = await Product.findById(productId);

  if (!product) {
    ctx.session.adminAction = null;
    ctx.session.keysProductId = null;
    ctx.session.keysProductAfterCreate = false;
    ctx.session.wizardMsgId = null;
    await ctx.reply('❌ Товар не найден.');
    return true;
  }

  const provider = resolveProductProvider(product);
  let lines = [];

  if (ctx.message?.text) {
    lines = ctx.message.text.split('\n').map((line) => line.trim()).filter(Boolean);
  } else if (ctx.message?.document) {
    const file = ctx.message.document;
    if (!file.mime_type?.includes('text') && !file.file_name?.endsWith('.txt')) {
      await ctx.reply('❌ Пришлите txt-файл или введите ключи текстом.');
      return true;
    }

    const link = await ctx.telegram.getFileLink(file.file_id);
    const res = await axios.get(link.href, {
      responseType: 'text',
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
    });
    lines = String(res.data).split('\n').map((line) => line.trim()).filter(Boolean);
  } else {
    return false;
  }

  if (lines.length === 0) {
    await ctx.reply('❌ Список ключей пуст. Попробуйте ещё раз.');
    return true;
  }

  const existingValues = new Set(await Key.distinct('value', buildKeyQueryForProduct(product)));
  const newKeys = lines.filter((value) => !existingValues.has(value));

  if (newKeys.length === 0) {
    await ctx.reply('⚠️ Все эти ключи уже есть в базе данных.');
    return true;
  }

  const docs = newKeys.map((value) => ({ productId, provider, value }));
  await Key.insertMany(docs);

  await notif.notifyWaitlist(product);

  const skipped = lines.length - newKeys.length;
  ctx.session.adminAction = null;
  ctx.session.keysProductId = null;
  ctx.session.keysProductAfterCreate = false;
  ctx.session.wizardMsgId = null;

  const successText =
    `✅ <b>Добавлено ${newKeys.length} ключей!</b>` +
    `\n🧩 Поставщик: ${escapeHtml(getProviderLabel(provider))}` +
    (skipped > 0 ? `\n⚠️ Пропущено дублей: ${skipped}` : '');

  const buttons = afterCreate
    ? [
        [Markup.button.callback(`📣 Разослать всем (${newKeys.length} шт.)`, `admin:product:broadcast:${productId}`)],
        [Markup.button.callback('📦 К товарам', 'admin:products')],
      ]
    : [[Markup.button.callback('🔑 К ключам', 'admin:keys')]];

  if (targetMsgId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, successText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons),
      });
      return true;
    } catch (_) {}
  }

  await ctx.reply(successText, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });

  return true;
};

const clearUsedKeys = async (ctx, productId) => {
  const product = await Product.findById(productId);
  const deleted = product
    ? await Key.deleteMany(buildKeyQueryForProduct(product, { isUsed: true }))
    : await Key.deleteMany({ productId, isUsed: true });

  await ctx.answerCbQuery(`🗑 Удалено ${deleted.deletedCount} использованных ключей`);
  await showKeysList(ctx);
};

module.exports = { showKeysList, startAddKeys, askKeysAfterCreate, handleKeysInput, clearUsedKeys };

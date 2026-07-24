const { Markup } = require('telegraf');
const axios = require('axios');
const Key = require('../../../models/Key');
const Product = require('../../../models/Product');
const {
  buildKeyQueryForProduct,
  getProviderLabel,
  resolveProductProvider,
} = require('../../../services/provider.service');
const { escapeHtml } = require('../../utils/ui');
const notif = require('../../../services/notification.service');

const showKeysList = async (ctx) => {
  const products = await Product.find({ isActive: true }).sort({ sortOrder: 1 });

  if (products.length === 0) {
    return ctx.editMessageText('🔑 Нет созданных товаров.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:main')]]),
    });
  }

  const buttons = [];
  let text = `🔑 <b>Управление ключами</b>\n\n`;

  for (const product of products) {
    const free = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    const used = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: true }));
    const provider = getProviderLabel(resolveProductProvider(product));

    text += `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n`;
    text += `   🧩 ${escapeHtml(provider)}\n`;
    text += `   🟢 Свободных: ${free} | 🔴 Использованных: ${used}\n\n`;

    buttons.push([
      Markup.button.callback(`➕ Добавить в: ${product.name.substring(0, 20)}`, `admin:keys:add:${product._id}`),
    ]);
    buttons.push([
      Markup.button.callback(`🗑 Очистить использ. (${used})`, `admin:keys:clear:${product._id}`),
    ]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (err) {
    // «message is not modified» - нормальное состояние после clearUsedKeys,
    // когда ничего не изменилось. Не ломаем поток.
    if (err.description?.includes('message is not modified')) {
      return ctx.answerCbQuery('✅ Уже актуально').catch(() => {});
    }
    // Все прочие - fallback на новое сообщение.
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  }
};

const askKeysAfterCreate = async (ctx, product) => {
  ctx.session.adminAction = 'add_keys';
  ctx.session.keysProductId = product._id.toString();
  ctx.session.keysProductAfterCreate = true;

  await ctx.reply(
    `✅ <b>Товар «${escapeHtml(product.name)}» создан!</b>\n\n` +
    `🔑 <b>Загрузка авто-товаров / аккаунтов / ключей:</b>\n\n` +
    `▫️ Отправьте <b>.txt файл</b> (каждый товар с новой строки)\n` +
    `▫️ Или отправьте <b>текстовое сообщение</b>:\n\n` +
    `<i>Поддерживаемые форматы (по 1 строке на товар):</i>\n` +
    `• <code>login:pass</code>\n` +
    `• <code>login:pass:2fa</code>\n` +
    `• <code>login|pass|2fa</code>\n` +
    `• <code>https://ссылка</code>\n` +
    `• <code>промокод_или_ключ</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏩ Пропустить (добавлю позже)', `admin:product:broadcast:${product._id}`)],
        [Markup.button.callback('❌ Отмена', 'admin:products')],
      ]),
    }
  );
};

const startAddKeys = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_keys';
  ctx.session.keysProductId = productId;

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

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]]),
    });
  }
  await ctx.answerCbQuery().catch(() => {});
};

const handleKeysInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'add_keys') return false;

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const productId = session.keysProductId;
  const afterCreate = session.keysProductAfterCreate || false;
  const product = await Product.findById(productId);

  if (!product) {
    ctx.session.adminAction = null;
    ctx.session.keysProductId = null;
    ctx.session.keysProductAfterCreate = false;
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
    const res = await axios.get(link.href, { responseType: 'text' });
    lines = String(res.data).split('\n').map((line) => line.trim()).filter(Boolean);
  } else {
    return false;
  }

  if (lines.length === 0) {
    await ctx.reply('❌ Список ключей пуст. Попробуйте ещё раз.');
    return true;
  }

  const existing = await Key.find(buildKeyQueryForProduct(product)).select('value');
  const existingValues = new Set(existing.map((item) => item.value));
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

  const successText =
    `✅ <b>Добавлено ${newKeys.length} ключей!</b>` +
    `\n🧩 Поставщик: ${escapeHtml(getProviderLabel(provider))}` +
    (skipped > 0 ? `\n⚠️ Пропущено дублей: ${skipped}` : '');

  if (afterCreate) {
    await ctx.reply(successText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`📣 Разослать всем (${newKeys.length} шт.)`, `admin:product:broadcast:${productId}`)],
        [Markup.button.callback('📦 К товарам', 'admin:products')],
      ]),
    });
  } else {
    await ctx.reply(successText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔑 К ключам', 'admin:keys')]]),
    });
  }

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

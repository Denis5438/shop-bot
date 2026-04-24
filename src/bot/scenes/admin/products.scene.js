const { Markup } = require('telegraf');
const Product = require('../../../models/Product');
const Key = require('../../../models/Key');
const Order = require('../../../models/Order');
const keysScene = require('./keys.scene');
const { escapeHtml } = require('../../utils/ui');
const {
  buildKeyQueryForProduct,
  getProviderLabel,
  getProvidersForProductType,
  normalizeProviderForType,
  resolveProductProvider,
} = require('../../../services/provider.service');

const TYPE_LABELS = {
  key: '🔑 Ключи',
  gpt_activation: '🤖 GPT Активация',
  manual: '✋ Ручной',
};

const ACTIVE_ORDER_STATUSES = ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'];

const showProductsList = async (ctx) => {
  const products = await Product.find().sort({ sortOrder: 1, createdAt: -1 });

  if (products.length === 0) {
    return ctx.editMessageText('📦 Товаров пока нет.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить товар', 'admin:product:add')],
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  }

  let text = `📦 <b>Управление товарами</b> (${products.length} шт.)\n\n`;
  const buttons = [];

  for (const product of products) {
    const stock = product.type === 'manual'
      ? '∞'
      : await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    const status = product.isActive ? '✅' : '🔴';
    const provider = getProviderLabel(resolveProductProvider(product));

    text += `${status} ${escapeHtml(product.icon || '📦')} ${escapeHtml(product.name)} — ${product.price} USDT | Остаток: ${stock}\n`;
    text += `   <i>${escapeHtml(provider)}</i>\n`;
    buttons.push([Markup.button.callback(`✏️ ${product.name.substring(0, 25)}`, `admin:product:edit:${product._id}`)]);
  }

  buttons.push([Markup.button.callback('➕ Добавить товар', 'admin:product:add')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const showProductEdit = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const stock = product.type === 'manual'
    ? '∞'
    : await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));

  const deliveryLabel = product.deliveryMethod === 'ready_account'
    ? '📦 Готовый аккаунт'
    : '🔑 Активация на своём аккаунте';

  const providerLabel = getProviderLabel(resolveProductProvider(product));

  const text =
    `✏️ <b>Редактирование товара</b>\n\n` +
    `📦 Название: ${escapeHtml(product.name)}\n` +
    `💰 Цена продажи: ${product.price} USDT\n` +
    `💸 Закупочная цена: ${product.costPrice || 0} USDT\n` +
    `🔑 Тип: ${escapeHtml(TYPE_LABELS[product.type] || product.type)}\n` +
    `🧩 Поставщик: ${escapeHtml(providerLabel)}\n` +
    `🚚 Выдача: ${deliveryLabel}\n` +
    `📦 Остаток ключей: ${stock}\n` +
    `🔘 Статус: ${product.isActive ? '✅ Активен' : '🔴 Скрыт'}`;

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Изменить название', `admin:product:field:name:${productId}`)],
      [Markup.button.callback('✏️ Название (EN)', `admin:product:field:nameEn:${productId}`)],
      [Markup.button.callback('💰 Изменить цену', `admin:product:field:price:${productId}`)],
      [Markup.button.callback('💸 Закупочная цена', `admin:product:field:costPrice:${productId}`)],
      [Markup.button.callback('📝 Описание (RU)', `admin:product:field:description:${productId}`)],
      [Markup.button.callback('📝 Описание (EN)', `admin:product:field:descriptionEn:${productId}`)],
      [Markup.button.callback('🔑 Добавить ключи', `admin:keys:add:${productId}`)],
      [Markup.button.callback('📣 Разослать', `admin:product:broadcast:${productId}`)],
      [Markup.button.callback('👯 Клонировать товар', `admin:product:clone:${productId}`)],
      [
        product.isActive
          ? Markup.button.callback('🔴 Скрыть', `admin:product:toggle:${productId}`)
          : Markup.button.callback('✅ Показать', `admin:product:toggle:${productId}`),
        Markup.button.callback('🗑 Удалить', `admin:product:delete_confirm:${productId}`),
      ],
      [Markup.button.callback('⬅️ Назад', 'admin:products')],
    ]),
  });
  await ctx.answerCbQuery().catch(() => {});
};

const startAddProduct = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_product';
  ctx.session.newProduct = {};

  await ctx.editMessageText(
    `➕ <b>Новый товар</b>\n\n` +
    `Сначала выберите <b>тип товара</b>:\n\n` +
    `🔑 <b>Ключи</b> — бот сразу отправляет ключ/код из базы\n` +
    `🤖 <b>GPT Активация</b> — авто-активация на аккаунте пользователя\n` +
    `✋ <b>Ручной</b> — выдаёте товар сами вручную`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Ключи', 'admin:product:type:key')],
        [Markup.button.callback('🤖 GPT Активация', 'admin:product:type:gpt_activation')],
        [Markup.button.callback('✋ Ручной', 'admin:product:type:manual')],
        [Markup.button.callback('❌ Отмена', 'admin:products')],
      ]),
    }
  );
};

const askProviderForNewProduct = async (ctx, type) => {
  const buttons = getProvidersForProductType(type).map((provider) => [
    Markup.button.callback(getProviderLabel(provider), `admin:product:provider:${provider}`),
  ]);

  buttons.push([Markup.button.callback('⬅️ Назад к типу', 'admin:product:add')]);

  await ctx.editMessageText(
    `✅ Тип: <b>${escapeHtml(TYPE_LABELS[type] || type)}</b>\n\n` +
    `Теперь выберите <b>поставщика / источник</b> для этого товара:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    }
  ).catch(() => {});
};

const askNameForNewProduct = async (ctx, type, provider) => {
  const typeLabel = TYPE_LABELS[type] || type;
  const providerLabel = getProviderLabel(provider);

  await ctx.editMessageText(
    `✅ Тип: <b>${escapeHtml(typeLabel)}</b>\n` +
    `🧩 Поставщик: <b>${escapeHtml(providerLabel)}</b>\n\n` +
    `Теперь введите <b>название</b> товара:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:products')]]),
    }
  ).catch(() => {});
};

const handleProductInput = async (ctx) => {
  const session = ctx.session || {};

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  if (session.adminAction === 'add_product') {
    const np = session.newProduct || {};

    if (!np.type) return true;

    if (np.type !== 'manual' && !np.provider) {
      return true;
    }

    if (!np.name) {
      np.name = ctx.message.text.trim();
      ctx.session.newProduct = np;
      await ctx.reply('Введите цену продажи в USDT\nПример: <code>1.6</code>', {
        parse_mode: 'HTML',
      });
      return true;
    }

    if (!np.price) {
      const price = parseFloat(ctx.message.text.replace(',', '.'));
      if (Number.isNaN(price) || price <= 0) {
        await ctx.reply('❌ Неверная цена. Введите число больше 0:');
        return true;
      }
      np.price = price;
      ctx.session.newProduct = np;
      await ctx.reply('Введите закупочную цену в USDT (ваши расходы)\nПример: <code>0.8</code>', {
        parse_mode: 'HTML',
      });
      return true;
    }

    if (np.costPrice === undefined) {
      const costPrice = parseFloat(ctx.message.text.replace(',', '.'));
      np.costPrice = Number.isNaN(costPrice) ? 0 : costPrice;
      ctx.session.newProduct = np;
      await ctx.reply('Введите описание товара (на русском):');
      return true;
    }

    if (!np.description) {
      np.description = ctx.message.text.trim();
      ctx.session.newProduct = np;
      await ctx.reply(
        'Введите описание товара (на английском):\nПример: <code>ChatGPT Plus subscription activation</code>',
        { parse_mode: 'HTML' }
      );
      return true;
    }

    if (!np.descriptionEn) {
      np.descriptionEn = ctx.message.text.trim();
      ctx.session.newProduct = np;
      await ctx.reply('Введите название товара на английском:\nПример: <code>ChatGPT Plus</code>', {
        parse_mode: 'HTML',
      });
      return true;
    }

    if (!np.nameEn) {
      np.nameEn = ctx.message.text.trim();
      ctx.session.newProduct = np;
      await ctx.reply('Введите иконку (эмодзи) для товара\nПример: 🤖');
      return true;
    }

    if (!np.icon) {
      np.icon = ctx.message.text.trim();

      const provider = normalizeProviderForType(np.type, np.provider || 'local');
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
      });
      await product.save();

      ctx.session.adminAction = null;
      ctx.session.newProduct = null;

      if (np.type === 'key' || np.type === 'gpt_activation') {
        await keysScene.askKeysAfterCreate(ctx, product);
      } else {
        await ctx.reply(
          `✅ <b>Товар «${escapeHtml(product.name)}» создан!</b>\n📦 Тип: ✋ Ручной\n🧩 Поставщик: ${escapeHtml(getProviderLabel(provider))}`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📣 Разослать всем', `admin:product:broadcast:${product._id}`)],
              [Markup.button.callback('📦 К товарам', 'admin:products')],
            ]),
          }
        );
      }
      return true;
    }
  }

  if (session.adminAction === 'edit_product_field') {
    const { productId, field } = session;
    const value = ctx.message.text.trim();

    const update = {};
    if (field === 'price' || field === 'costPrice') {
      const num = parseFloat(value.replace(',', '.'));
      if (Number.isNaN(num)) {
        await ctx.reply('❌ Неверное число. Попробуйте ещё раз.');
        return true;
      }
      update[field] = num;
    } else {
      update[field] = value;
    }

    await Product.findByIdAndUpdate(productId, update);

    ctx.session.adminAction = null;
    ctx.session.productId = null;
    ctx.session.field = null;

    await ctx.reply('✅ Изменено!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('📦 К товарам', 'admin:products')]]),
    });
    return true;
  }

  return false;
};

const toggleProduct = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  product.isActive = !product.isActive;
  await product.save();
  await showProductEdit(ctx, productId);
};

const confirmDeleteProduct = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const [activeOrders, allOrders, keysCount] = await Promise.all([
    Order.countDocuments({ productId, status: { $in: ACTIVE_ORDER_STATUSES } }),
    Order.countDocuments({ productId }),
    Key.countDocuments({ productId }),
  ]);

  if (activeOrders > 0) {
    const buttons = [];
    if (product.isActive) {
      buttons.push([Markup.button.callback('🔴 Скрыть товар', `admin:product:toggle:${productId}`)]);
    }
    buttons.push([Markup.button.callback('⬅️ Назад', `admin:product:edit:${productId}`)]);

    await ctx.answerCbQuery('Нельзя удалить: есть активные заказы', { show_alert: true }).catch(() => {});
    return ctx.editMessageText(
      `⚠️ <b>Удаление заблокировано</b>\n\n` +
      `📦 ${escapeHtml(product.name)}\n` +
      `🧾 Активных заказов: <b>${activeOrders}</b>\n\n` +
      `Сначала завершите или отмените активные заказы. Товар можно скрыть, чтобы новые покупки не создавались.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  }

  const actionText = allOrders > 0
    ? `У товара есть история заказов (${allOrders}). При подтверждении товар будет только скрыт, история и ключи сохранятся.`
    : `У товара нет заказов. При подтверждении будут удалены товар и его ключи (${keysCount}).`;

  await ctx.answerCbQuery().catch(() => {});
  return ctx.editMessageText(
    `⚠️ <b>Подтвердите действие</b>\n\n` +
    `📦 ${escapeHtml(product.name)}\n\n` +
    `${actionText}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(allOrders > 0 ? '🗄 Скрыть без удаления' : '🗑 Да, удалить', `admin:product:delete:${productId}`)],
        [Markup.button.callback('⬅️ Отмена', `admin:product:edit:${productId}`)],
      ]),
    }
  );
};

const deleteProduct = async (ctx, productId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const activeOrders = await Order.countDocuments({ productId, status: { $in: ACTIVE_ORDER_STATUSES } });
  if (activeOrders > 0) {
    await ctx.answerCbQuery('Нельзя удалить: есть активные заказы', { show_alert: true });
    return showProductEdit(ctx, productId);
  }

  const allOrders = await Order.countDocuments({ productId });
  if (allOrders > 0) {
    if (product.isActive) {
      product.isActive = false;
      await product.save();
    }
    await ctx.answerCbQuery('🗄 Товар скрыт, история сохранена');
    return showProductEdit(ctx, productId);
  }

  await Product.deleteOne({ _id: productId });
  await Key.deleteMany({ productId });
  await ctx.answerCbQuery('🗑 Товар удалён');
  await showProductsList(ctx);
};

const cloneProduct = async (ctx, productId) => {
  const original = await Product.findById(productId);
  if (!original) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const clone = new Product({
    name: `${original.name} (Копия)`,
    nameEn: original.nameEn,
    price: original.price,
    costPrice: original.costPrice,
    type: original.type,
    provider: resolveProductProvider(original),
    deliveryMethod: original.deliveryMethod,
    description: original.description,
    descriptionEn: original.descriptionEn,
    icon: original.icon,
    isActive: false,
  });

  await clone.save();
  await showProductEdit(ctx, clone._id);
};

module.exports = {
  showProductsList,
  showProductEdit,
  startAddProduct,
  askProviderForNewProduct,
  askNameForNewProduct,
  handleProductInput,
  toggleProduct,
  confirmDeleteProduct,
  deleteProduct,
  cloneProduct,
};

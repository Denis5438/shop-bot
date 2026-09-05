const { Markup } = require('telegraf');
const Product = require('../../../models/Product');
const Key = require('../../../models/Key');
const Order = require('../../../models/Order');
const Seller = require('../../../models/Seller');
const keysScene = require('./keys.scene');
const notif = require('../../../services/notification.service');
const { escapeHtml, extractTextWithEmojis, safeEdit } = require('../../utils/ui');
const {
  buildKeyQueryForProduct,
  getProviderLabel,
  normalizeProviderForType,
  resolveProductProvider,
} = require('../../../services/provider.service');

const TYPE_LABELS = {
  key: '🔑 Ключи',
  gpt_activation: '🤖 GPT Активация',
  manual: '✋ Ручной',
};

const ACTIVE_ORDER_STATUSES = ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'];

const PRODUCTS_PER_PAGE = 7;

const showProductsList = async (ctx, page = 1, searchQuery = null) => {
  const query = {};
  if (searchQuery && typeof searchQuery === 'string' && searchQuery.trim()) {
    query.name = new RegExp(searchQuery.trim(), 'i');
  }

  const total = await Product.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / PRODUCTS_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const products = await Product.find(query)
    .sort({ sortOrder: 1, createdAt: -1 })
    .skip((safePage - 1) * PRODUCTS_PER_PAGE)
    .limit(PRODUCTS_PER_PAGE)
    .lean();

  if (products.length === 0) {
    const emptyText = searchQuery
      ? `🔍 По запросу «<b>${escapeHtml(searchQuery)}</b>» ничего не найдено.`
      : '📦 <b>Управление Товарами</b>\n\nСписок товаров пуст.';
    const emptyButtons = [
      [Markup.button.callback('🔍 Повторить поиск', 'admin:product:search')],
      [Markup.button.callback('➕ Добавить товар', 'admin:product:add')],
      [Markup.button.callback('⬅️ В панель управления', 'admin:main')],
    ];
    return safeEdit(ctx, emptyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(emptyButtons) });
  }

  const pIds = products.map((p) => p._id);
  const keyCounts = await Key.aggregate([
    { $match: { productId: { $in: pIds }, isUsed: false } },
    { $group: { _id: { productId: '$productId', provider: '$provider' }, count: { $sum: 1 } } },
  ]);

  const countsMap = new Map();
  for (const row of keyCounts) {
    const pidStr = String(row._id.productId);
    const prov = row._id.provider || '__null__';
    if (!countsMap.has(pidStr)) countsMap.set(pidStr, {});
    countsMap.get(pidStr)[prov] = row.count;
  }

  const searchHeader = searchQuery ? `🔍 Результаты поиска «<b>${escapeHtml(searchQuery)}</b>»\n\n` : '';
  let text = `📦 <b>Управление Товарами</b>  ·  Стр. ${safePage}/${totalPages}\n\n` + searchHeader;
  const buttons = [];

  for (const product of products) {
    const c = countsMap.get(String(product._id)) || {};
    const prov = product.provider || 'local';
    const autoKeys = (c[prov] || 0) + (c['__null__'] || 0);
    const stock = autoKeys > 0
      ? autoKeys
      : (product.type === 'manual' || ['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider)
          ? (product.manualStock === -1 ? '∞' : product.manualStock)
          : 0);
    const status = product.isActive ? '✅' : '🔴';
    const typeLabel = TYPE_LABELS[product.type] || product.type;

    text +=
      `${status} <b>${escapeHtml(product.name)}</b> — <b>${product.price} USDT</b>\n` +
      `   ├ Тип: ${typeLabel} | Поставщик: ${escapeHtml(product.provider || 'local')}\n` +
      `   └ В наличии: <b>${stock}</b> шт.\n\n`;

    buttons.push([
      Markup.button.callback(
        `${status} ${product.icon || '📦'} ${product.name.slice(0, 22)}`,
        `admin:product:edit:${product._id}:${safePage}`
      ),
    ]);
  }

  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback('⬅️ Назад', `admin:products:${safePage - 1}`));
  }
  navRow.push(Markup.button.callback(`${safePage}/${totalPages}`, 'admin:noop'));
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback('Вперёд ➡️', `admin:products:${safePage + 1}`));
  }
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    Markup.button.callback('🔍 Найти товар', 'admin:product:search'),
    Markup.button.callback('➕ Добавить товар', 'admin:product:add'),
  ]);
  buttons.push([Markup.button.callback('⬅️ В панель управления', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const showProductEdit = async (ctx, productId, page = 1) => {
  const product = await Product.findById(productId).populate('sellerId').populate('categoryId');
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const autoKeysCount = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
  const stock = autoKeysCount > 0
    ? `${autoKeysCount} шт. (автовыдача ⚡)`
    : (product.type === 'manual' || ['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider)
        ? (product.manualStock === -1 ? '∞ (ручной остаток)' : `${product.manualStock} шт.`)
        : '0 шт. (нет в наличии)');

  const deliveryLabel = product.deliveryMethod === 'ready_account'
    ? '📦 Готовый аккаунт'
    : '🔑 Активация на своём аккаунте';

  const sellerLine = product.sellerId
    ? `👤 Продавец: @${escapeHtml(product.sellerId.username)} (${product.sellerPrice} USDT)`
    : '👤 Продавец: не назначен';

  const nameEnStr = product.nameEn ? `<b>${escapeHtml(product.nameEn)}</b>` : '<i>не задано</i>';
  const descStatus = `${product.description ? 'RU ✅' : 'RU ⚪'} | ${product.descriptionEn ? 'EN ✅' : 'EN ⚪'}`;

  const originLabel = product.itemOrigin === 'supplier' ? '👤 От поставщика' : '🛡 Верифицированный ✅';

  const now = Date.now();
  const isFlash = Boolean(
    product.flashSale?.enabled &&
    product.flashSale.expiresAt &&
    new Date(product.flashSale.expiresAt).getTime() > now &&
    product.flashSale.discountPercent > 0
  );

  let flashSaleLine = '⚡ Flash Sale: ⚪ Выкл';
  if (isFlash) {
    const leftMs = Math.max(0, new Date(product.flashSale.expiresAt).getTime() - now);
    const leftH = Math.floor(leftMs / (1000 * 3600));
    const leftM = Math.floor((leftMs % (1000 * 3600)) / (1000 * 60));
    const discounted = Math.max(0.01, product.price * (1 - product.flashSale.discountPercent / 100));
    flashSaleLine = `⚡ Flash Sale: 🔥 <b>Вкл (-${product.flashSale.discountPercent}% ➔ ${discounted.toFixed(2)} USDT)</b>, осталось ~${leftH}ч ${leftM}м`;
  }

  const text =
    `✏️ <b>Редактирование товара</b>\n\n` +
    `📦 Название (RU): <b>${escapeHtml(product.name)}</b>\n` +
    `🇬🇧 Название (EN): ${nameEnStr}\n` +
    `💰 <b>Цена продажи: ${product.price} USDT</b>\n` +
    `💸 Закупочная цена: <b>${product.costPrice || 0} USDT</b>\n` +
    `🔑 Источник: ${escapeHtml(product.provider || 'local')}\n` +
    `🗂 Категория: ${product.categoryId ? escapeHtml(product.categoryId.name) : 'Нет'}\n` +
    `🚚 Выдача: ${deliveryLabel}\n` +
    `📦 Остаток: <b>${stock}</b>\n` +
    `📝 Описания: ${descStatus}\n` +
    `🛡 Гарантия: ${product.warrantyDays ?? 5} дн.\n` +
    `⏳ Срок подписки: ${product.subscriptionDays ? `${product.subscriptionDays} дн.` : 'Бессрочно'}\n` +
    `📍 Происхождение: <b>${originLabel}</b>\n` +
    `${flashSaleLine}\n` +
    `${sellerLine}\n` +
    `🔘 Статус: ${product.isActive ? '✅ Активен (виден в магазине)' : '🔴 Скрыт'}`;

  const buttons = [
    [Markup.button.callback('💰 Изменить цену продажи', `admin:product:field:price:${productId}:${page}`)],
    [Markup.button.callback('💸 Закупочная цена', `admin:product:field:costPrice:${productId}:${page}`)],
    [Markup.button.callback(isFlash ? `🔥 Flash Sale: -${product.flashSale.discountPercent}% (Управление)` : '⚡ Включить Flash Sale (Акция)', `admin:product:flash:${productId}:${page}`)],
    [
      Markup.button.callback('✏️ Название (RU)', `admin:product:field:name:${productId}:${page}`),
      Markup.button.callback('🇬🇧 Название (EN)', `admin:product:field:nameEn:${productId}:${page}`),
    ],
    [
      Markup.button.callback('📝 Описание (RU)', `admin:product:field:description:${productId}:${page}`),
      Markup.button.callback('🇬🇧 Описание (EN)', `admin:product:field:descriptionEn:${productId}:${page}`),
    ],
    [Markup.button.callback('🗂 Изменить категорию', `admin:product:field:category:${productId}:${page}`)],
    [Markup.button.callback('📦 Задать остаток вручную', `admin:product:set_stock:${productId}:${page}`)],
    [
      Markup.button.callback('🛡 Срок гарантии', `admin:product:field:warrantyDays:${productId}:${page}`),
      Markup.button.callback('⏳ Срок подписки', `admin:product:field:subscriptionDays:${productId}:${page}`),
    ],
    [
      Markup.button.callback(
        product.itemOrigin === 'supplier' ? '👤 Тип: Поставщик' : '🛡 Тип: Верифицирован',
        `adm:p_orig:${productId}:${page}`
      ),
    ],
    [Markup.button.callback('🔑 Загрузить ключи (TXT)', `admin:keys:add:${productId}`)],
    [Markup.button.callback('📣 Сделать рассылку товара', `admin:product:broadcast:${productId}`)],
    [Markup.button.callback('👯 Клонировать товар', `admin:product:clone:${productId}`)],
  ];

  buttons.push([
    product.isActive
      ? Markup.button.callback('🔴 Скрыть товар', `admin:product:toggle:${productId}:${page}`)
      : Markup.button.callback('✅ Показать в магазине', `admin:product:toggle:${productId}:${page}`),
    Markup.button.callback('🗑 Удалить', `admin:product:delete_confirm:${productId}:${page}`),
  ]);
  buttons.push([Markup.button.callback('⬅️ К списку товаров', `admin:products:${page}`)]);

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
};

const startAddProduct = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_product';
  ctx.session.newProduct = {};
  ctx.session.wizardMsgId = ctx.callbackQuery?.message?.message_id;

  const text =
    `➕ <b>Новый товар</b>\n\n` +
    `Сначала выберите <b>тип товара</b>:\n\n` +
    `🔑 <b>Ключи</b> - бот сразу отправляет ключ/код из базы\n` +
    `🤖 <b>GPT Активация</b> - авто-активация на аккаунте пользователя\n` +
    `✋ <b>Ручной</b> - выдаёте товар сами вручную`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔑 Ключи', 'admin:product:type:key')],
      [Markup.button.callback('🤖 GPT Активация', 'admin:product:type:gpt_activation')],
      [Markup.button.callback('✋ Ручной', 'admin:product:type:manual')],
      [Markup.button.callback('❌ Отмена', 'admin:products')],
    ]),
  });
};

const askNameForNewProduct = async (ctx, type) => {
  const typeLabel = TYPE_LABELS[type] || type;

  await ctx.editMessageText(
    `✅ Тип: <b>${escapeHtml(typeLabel)}</b>\n\n` +
    `Введите <b>название</b> товара:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:products')]]),
    }
  ).catch(() => {});
};

// ─── Назначение продавца на товар ────────────────────────────────────────────
const askSellerForProduct = async (ctx, productId) => {
  const product = await Product.findById(productId).populate('sellerId');
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const currentSeller = product.sellerId
    ? `\n\n👤 Текущий продавец: @${escapeHtml(product.sellerId.username)} (цена: ${product.sellerPrice} USDT)`
    : '';

  // Загружаем всех существующих продавцов
  const sellers = await Seller.find({ isActive: true }).sort({ username: 1 }).limit(20);

  await ctx.answerCbQuery().catch(() => {});

  const buttons = [];

  if (sellers.length > 0) {
    for (const seller of sellers) {
      const isCurrently = product.sellerId?.toString() === seller._id.toString();
      const label = `${isCurrently ? '✅ ' : ''}@${seller.username}`;
      buttons.push([Markup.button.callback(label, `adm:ps:p:${productId}:${seller._id}`)]);
    }
  }

  buttons.push([Markup.button.callback('✏️ Ввести @username вручную', `admin:product:seller:manual:${productId}`)]);

  if (product.sellerId) {
    buttons.push([Markup.button.callback('🗑 Убрать продавца', `admin:product:seller:remove:${productId}`)]);
  }

  buttons.push([Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]);

  const sellerListText = sellers.length > 0
    ? `Выберите продавца из списка или введите вручную:`
    : `Продавцов пока нет. Введите @username:` ;

  const text =
    `👤 <b>Назначить продавца</b>${currentSeller}\n\n` +
    sellerListText;

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

// ─── Быстрый выбор продавца по кнопке ──────────────────────────────────────
const pickSellerForProduct = async (ctx, productId, sellerId) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const seller = await Seller.findById(sellerId);
  if (!seller) return ctx.answerCbQuery('❌ Продавец не найден', { show_alert: true });

  // Просим цену продавца
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'set_product_seller_price';
  ctx.session.productId = productId;
  ctx.session.sellerIdForProduct = seller._id.toString();

  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `👤 Продавец: @${escapeHtml(seller.username)}\n\n` +
    `Введите сколько USDT из цены товара получает продавец:\n` +
    `<i>Цена товара: ${product.price} USDT - введите меньше этой суммы.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]])  ,
    }
  );
};

// ─── Ручной ввод @username продавца ──────────────────────────────────────────
const askManualSellerInput = async (ctx, productId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'set_product_seller';
  ctx.session.productId = productId;

  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `✏️ Введите @username продавца (без @):\n` +
    `<i>Если продавец ещё не зарегистрирован в боте - запись будет создана автоматически.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]]),
    }
  );
};

const handleProductInput = async (ctx) => {
  const session = ctx.session || {};

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  // ─── Flash Sale: ввод своего процента ───────────────────────────────────────
  if (session.adminAction === 'flash_custom_pct') {
    const { flashProductId, flashPage } = session;
    const text = (ctx.message?.text || '').trim().replace('%', '');
    const pct = parseInt(text, 10);
    if (isNaN(pct) || pct < 1 || pct > 99) {
      await ctx.reply('❌ Введите число от 1 до 99 (процент скидки):');
      return true;
    }
    session.adminAction = null;
    session.flashWizard = session.flashWizard || {};
    session.flashWizard.discountPercent = pct;
    await showFlashSaleMenu(ctx, flashProductId, flashPage);
    return true;
  }

  // ─── Flash Sale: ввод своего времени ────────────────────────────────────────
  if (session.adminAction === 'flash_custom_dur') {
    const { flashProductId, flashPage } = session;
    const text = (ctx.message?.text || '').trim();
    const dur = parseFloat(text.replace(',', '.'));
    if (isNaN(dur) || dur <= 0 || dur > 720) {
      await ctx.reply('❌ Введите число часов от 0.5 до 720 (например: 2 или 12):');
      return true;
    }
    session.adminAction = null;
    session.flashWizard = session.flashWizard || {};
    session.flashWizard.durationHours = dur;
    await showFlashSaleMenu(ctx, flashProductId, flashPage);
    return true;
  }

  // ─── Назначение продавца ──────────────────────────────────────────────────
  if (session.adminAction === 'set_product_seller') {
    const { productId } = session;
    const username = (ctx.message?.text || '').trim().replace(/^@/, '');

    if (!username || username.length < 2) {
      await ctx.reply('❌ Некорректный username. Введите без @:');
      return true;
    }

    // Ищем продавца в базе
    let seller = await Seller.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });

    if (!seller) {
      // Продавца нет - создаём запись (без telegramId, он не зарегистрирован в боте)
      seller = new Seller({ username: username.toLowerCase(), displayName: username });
      await seller.save();
      // Отправляем уведомление (оно сработает, когда telegramId появится, но пока его нет)
      // На самом деле, мы можем уведомить его только когда он зайдёт в бота, или сейчас если он уже есть в User
      const User = require('../../../models/User');
      const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
      if (user) {
        seller.telegramId = user.telegramId;
        await seller.save();
        await notif.notifySellerWelcome(seller);
      }
    }

    // Переходим к вводу цены продавца
    ctx.session.sellerIdForProduct = seller._id.toString();
    ctx.session.adminAction = 'set_product_seller_price';

    await ctx.reply(
      `👤 Продавец: @${escapeHtml(seller.username)}\n\n` +
      `Введите сколько USDT из цены товара идёт продавцу:\n` +
      `<i>Например, если цена товара 3 USDT, введите 2 - и 2 USDT идут продавцу, 1 вам.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]]),
      }
    );
    return true;
  }

  // ─── Цена продавца ────────────────────────────────────────────────────────
  if (session.adminAction === 'set_product_seller_price') {
    const { productId, sellerIdForProduct } = session;
    const sellerPrice = parseFloat((ctx.message?.text || '').replace(',', '.'));

    if (Number.isNaN(sellerPrice) || sellerPrice < 0) {
      await ctx.reply('❌ Введите корректную сумму (например: 2 или 1.5):');
      return true;
    }

    const product = await Product.findById(productId);
    if (!product) {
      await ctx.reply('❌ Товар не найден.');
      ctx.session.adminAction = null;
      return true;
    }

    if (sellerPrice >= product.price) {
      await ctx.reply(`❌ Цена продавца (${sellerPrice}) не может быть >= цены товара (${product.price}). Введите меньшее значение:`);
      return true;
    }

    product.sellerId = sellerIdForProduct;
    product.sellerPrice = sellerPrice;
    await product.save();

    ctx.session.adminAction = null;
    ctx.session.productId = null;
    ctx.session.sellerIdForProduct = null;

    const seller = await Seller.findById(sellerIdForProduct);
    await ctx.reply(
      `✅ <b>Продавец назначен!</b>\n\n` +
      `👤 @${escapeHtml(seller?.username || '?')}\n` +
      `💰 Получает: <b>${sellerPrice} USDT</b> из ${product.price} USDT\n` +
      `💵 Ваша доля: <b>${(product.price - sellerPrice).toFixed(2)} USDT</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('📦 К товарам', 'admin:products')]]),
      }
    );
    return true;
  }

  if (session.adminAction === 'add_product') {
    const np = session.newProduct || {};

    if (!np.type) return true;

    if (!np.name) {
      np.name = extractTextWithEmojis(ctx.message).trim();
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
      np.description = extractTextWithEmojis(ctx.message).trim();
      ctx.session.newProduct = np;
      await ctx.reply(
        'Введите описание товара (на английском):\nПример: <code>ChatGPT Plus subscription activation</code>',
        { parse_mode: 'HTML' }
      );
      return true;
    }

    if (!np.descriptionEn) {
      np.descriptionEn = extractTextWithEmojis(ctx.message).trim();
      ctx.session.newProduct = np;
      await ctx.reply('Введите название товара на английском:\nПример: <code>ChatGPT Plus</code>', {
        parse_mode: 'HTML',
      });
      return true;
    }

    if (!np.nameEn) {
      np.nameEn = extractTextWithEmojis(ctx.message).trim();
      ctx.session.newProduct = np;
      await ctx.reply('Введите иконку (эмодзи) для товара\nПример: 🤖');
      return true;
    }

    if (!np.icon) {
      np.icon = extractTextWithEmojis(ctx.message).trim();
      ctx.session.newProduct = np;

      const Category = require('../../../models/Category');
      const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 });
      
      if (np.categoryId || categories.length === 0) {
        // Категория уже выбрана или категорий нет - сохраняем сразу
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
          categoryId: np.categoryId || null,
        });
        await product.save();
        ctx.session.adminAction = null;
        ctx.session.newProduct = null;

        if (np.type === 'key' || np.type === 'gpt_activation') {
          await keysScene.askKeysAfterCreate(ctx, product);
        } else {
          await ctx.reply(
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
          );
        }
        return true;
      }

      const buttons = categories.map(cat => [
        Markup.button.callback(`${cat.icon} ${cat.name}`, `admin:product:set_cat:${cat._id}`)
      ]);
      buttons.push([Markup.button.callback('Без категории', 'admin:product:set_cat:none')]);

      await ctx.reply('Выберите категорию для товара:', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
      });
      return true;
    }
  }

  // ─── ПОИСК ТОВАРА ПО НАЗВАНИЮ ───
  if (session.adminAction === 'product_search') {
    const queryStr = ctx.message.text.trim();
    session.adminAction = null;
    await showProductsList(ctx, 1, queryStr);
    return true;
  }

  if (session.adminAction === 'edit_product_field') {
    const { productId, field, productPage } = session;
    const value = extractTextWithEmojis(ctx.message).trim();
    const page = productPage || 1;

    const update = {};
    if (field === 'price' || field === 'costPrice') {
      const num = parseFloat(value.replace(',', '.'));
      if (Number.isNaN(num) || num < 0) {
        await ctx.reply('❌ Неверное число. Введите корректную цену (например: 4.50):');
        return true;
      }
      update[field] = num;
    } else if (field === 'warrantyDays' || field === 'subscriptionDays') {
      const num = parseInt(value, 10);
      if (Number.isNaN(num) || num < 0) {
        await ctx.reply('❌ Введите корректное число дней (например: 30 или 0 для бессрочного):');
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

    await ctx.reply(`✅ Поле <b>${field}</b> успешно обновлено!`, { parse_mode: 'HTML' });
    await showProductEdit(ctx, productId, page);
    return true;
  }

  if (session.adminAction === 'set_manual_stock') {
    const { productId, productPage } = session;
    const page = productPage || 1;
    const value = ctx.message.text.trim();
    const stock = parseInt(value, 10);

    if (Number.isNaN(stock) || (stock < 0 && stock !== -1)) {
      await ctx.reply('❌ Неверное число. Введите число >= 0 или -1 для бесконечности.');
      return true;
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      productId,
      { $set: { manualStock: stock } },
      { new: true }
    );
    ctx.session.adminAction = null;
    ctx.session.productId = null;

    if (updatedProduct && (stock > 0 || stock === -1)) {
      const notif = require('../../../services/notification.service');
      notif.broadcastRestock(updatedProduct).catch(() => {});
    }

    await ctx.reply(`✅ Остаток установлен: <b>${stock === -1 ? '∞' : stock}</b> шт.!`, { parse_mode: 'HTML' });
    await showProductEdit(ctx, productId, page);
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
    // Seller не клонируем - назначать нужно явно
  });

  await clone.save();
  await showProductEdit(ctx, clone._id);
};

// ─── Убрать продавца с товара ─────────────────────────────────────────────────
const removeSellerFromProduct = async (ctx, productId) => {
  await Product.findByIdAndUpdate(productId, { $set: { sellerId: null, sellerPrice: 0 } });
  await ctx.answerCbQuery('✅ Продавец снят').catch(() => {});
  await showProductEdit(ctx, productId);
};

// ─── Переключение типа/происхождения товара ──────────────────────────────────
const toggleProductOrigin = async (ctx, productId, page = 1) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  product.itemOrigin = product.itemOrigin === 'supplier' ? 'verified' : 'supplier';
  await product.save();

  const label = product.itemOrigin === 'supplier' ? '👤 От поставщика' : '🛡 Верифицированный';
  await ctx.answerCbQuery(`Статус: ${label}`).catch(() => {});
  await showProductEdit(ctx, productId, page);
};

// ─── FLASH SALE (Горящие часы) ────────────────────────────────────────────────
const showFlashSaleMenu = async (ctx, productId, page = 1) => {
  const product = await Product.findById(productId);
  if (!product) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const now = Date.now();
  const isFlash = Boolean(
    product.flashSale?.enabled &&
    product.flashSale.expiresAt &&
    new Date(product.flashSale.expiresAt).getTime() > now &&
    product.flashSale.discountPercent > 0
  );

  ctx.session = ctx.session || {};
  ctx.session.flashWizard = ctx.session.flashWizard || {
    discountPercent: 20,
    durationHours: 4,
  };

  const discountPercent = ctx.session.flashWizard.discountPercent || 20;
  const durationHours = ctx.session.flashWizard.durationHours || 4;
  const promoPrice = Math.max(0.01, product.price * (1 - discountPercent / 100)).toFixed(2);

  let text = '';
  const buttons = [];

  if (isFlash) {
    const leftMs = Math.max(0, new Date(product.flashSale.expiresAt).getTime() - now);
    const leftH = Math.floor(leftMs / (1000 * 3600));
    const leftM = Math.floor((leftMs % (1000 * 3600)) / (1000 * 60));
    const leftS = Math.floor((leftMs % (1000 * 60)) / 1000);
    const activePrice = Math.max(0.01, product.price * (1 - product.flashSale.discountPercent / 100)).toFixed(2);

    text =
      `🔥 <b>Flash Sale активен для товара!</b>\n\n` +
      `📦 Товар: <b>${escapeHtml(product.name)}</b>\n` +
      `💰 Обычная цена: <b>${product.price} USDT</b>\n` +
      `🏷 Акционная цена: <b>${activePrice} USDT</b> (-${product.flashSale.discountPercent}%)\n` +
      `⏳ До конца акции: <b>${leftH}ч ${leftM}м ${leftS}с</b>\n\n` +
      `<i>Вы можете продлить акцию или остановить её досрочно.</i>`;

    buttons.push([
      Markup.button.callback('⏳ +2 часа', `admin:flash:extend:${productId}:${page}:2`),
      Markup.button.callback('⏳ +6 часов', `admin:flash:extend:${productId}:${page}:6`),
      Markup.button.callback('⏳ +24 часа', `admin:flash:extend:${productId}:${page}:24`),
    ]);
    buttons.push([Markup.button.callback('🛑 Остановить Flash Sale', `admin:flash:stop:${productId}:${page}`)]);
  } else {
    text =
      `⚡ <b>Настройка Flash Sale (Горящие часы)</b>\n\n` +
      `📦 Товар: <b>${escapeHtml(product.name)}</b>\n` +
      `💰 Базовая цена: <b>${product.price} USDT</b>\n` +
      `📉 Выбранная скидка: <b>-${discountPercent}%</b>\n` +
      `⏳ Длительность: <b>${durationHours} ч.</b>\n` +
      `🏷 Цена со скидкой: <b>${promoPrice} USDT</b>\n\n` +
      `<i>Выберите процент скидки и длительность ниже:</i>`;

    const pctPresets = [10, 20, 30, 50];
    const pctButtons = pctPresets.map((p) =>
      Markup.button.callback(p === discountPercent ? `🔘 -${p}%` : `-${p}%`, `admin:flash:pct:${productId}:${page}:${p}`)
    );
    pctButtons.push(Markup.button.callback('✍️ %', `admin:flash:custom_pct:${productId}:${page}`));

    const durPresets = [2, 4, 6, 12, 24];
    const durButtons = durPresets.map((d) =>
      Markup.button.callback(d === durationHours ? `🔘 ${d}ч` : `${d}ч`, `admin:flash:dur:${productId}:${page}:${d}`)
    );
    durButtons.push(Markup.button.callback('✍️ ч', `admin:flash:custom_dur:${productId}:${page}`));

    buttons.push(pctButtons);
    buttons.push(durButtons);
    buttons.push([Markup.button.callback('🚀 Запустить Flash Sale', `admin:flash:start:${productId}:${page}`)]);
  }

  buttons.push([Markup.button.callback('⬅️ Назад к товару', `admin:product:edit:${productId}:${page}`)]);

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
};

const startFlashSale = async (ctx, productId, page = 1) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const discountPercent = Math.min(99, Math.max(1, ctx.session?.flashWizard?.discountPercent || 20));
  const durationHours = Math.max(0.1, ctx.session?.flashWizard?.durationHours || 4);

  product.flashSale = {
    enabled: true,
    discountPercent,
    expiresAt: new Date(Date.now() + durationHours * 3600 * 1000),
    startedAt: new Date(),
  };

  await product.save();
  await ctx.answerCbQuery(`🔥 Flash Sale на ${durationHours}ч со скидкой -${discountPercent}% запущен!`, { show_alert: true });
  await showProductEdit(ctx, productId, page);
};

const stopFlashSale = async (ctx, productId, page = 1) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  if (product.flashSale) {
    product.flashSale.enabled = false;
    product.flashSale.expiresAt = new Date();
    await product.save();
  }

  await ctx.answerCbQuery('🛑 Flash Sale остановлен', { show_alert: true });
  await showProductEdit(ctx, productId, page);
};

const extendFlashSale = async (ctx, productId, page = 1, hours = 2) => {
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const numHours = parseFloat(hours) || 2;
  const currentExpiry = product.flashSale?.expiresAt ? new Date(product.flashSale.expiresAt).getTime() : Date.now();
  const baseTime = Math.max(Date.now(), currentExpiry);

  product.flashSale = product.flashSale || {};
  product.flashSale.enabled = true;
  product.flashSale.expiresAt = new Date(baseTime + numHours * 3600 * 1000);
  await product.save();

  await ctx.answerCbQuery(`⏳ Акция продлена на +${numHours} ч.`).catch(() => {});
  await showFlashSaleMenu(ctx, productId, page);
};

module.exports = {
  showProductsList,
  showProductEdit,
  startAddProduct,
  askNameForNewProduct,
  handleProductInput,
  toggleProduct,
  confirmDeleteProduct,
  deleteProduct,
  cloneProduct,
  askSellerForProduct,
  pickSellerForProduct,
  askManualSellerInput,
  removeSellerFromProduct,
  toggleProductOrigin,
  showFlashSaleMenu,
  startFlashSale,
  stopFlashSale,
  extendFlashSale,
};

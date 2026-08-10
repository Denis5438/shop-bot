const { Markup } = require('telegraf');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Key = require('../../models/Key');
const Order = require('../../models/Order');
const Transaction = require('../../models/Transaction');
const Waitlist = require('../../models/Waitlist');
const { ITEMS_PER_PAGE } = require('../../config');
const { toRub } = require('../../services/currency.service');
const { getSettings } = require('../../services/settingsCache.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const {
  buildKeyQueryForProduct,
  resolveProductProvider,
} = require('../../services/provider.service');
const notif = require('../../services/notification.service');
const Seller = require('../../models/Seller');
const { mainKeyboard } = require('../keyboards/main.keyboard');
const { balanceHeader, errorScreen, escapeHtml, formatDigitalItem, safeEdit } = require('../utils/ui');

const getEffectivePrice = async (product, stockCount, activePromo = null) => {
  const settings = await getSettings();
  let price = product.price;

  if (settings?.smartPricing && product.type !== 'manual') {
    const rawStock = parseFloat(stockCount);
    if (!Number.isNaN(rawStock) && rawStock > 0 && rawStock < 10) {
      price = parseFloat((price * 1.2).toFixed(2));
    }
  }

  if (settings?.autoMarkdownEnabled && settings?.autoMarkdownPercent > 0 && settings?.autoMarkdownDays > 0) {
    const lastSaleBase = product.lastSoldAt || product.createdAt;
    const lastSaleAt = lastSaleBase instanceof Date ? lastSaleBase.getTime() : Date.now();
    const daysSinceLastSale = (Date.now() - lastSaleAt) / (1000 * 60 * 60 * 24);
    const periods = Math.floor(daysSinceLastSale / settings.autoMarkdownDays);

    if (periods > 0) {
      const discountMult = Math.pow(1 - (settings.autoMarkdownPercent / 100), periods);
      const discountedPrice = price * discountMult;
      const costLimit = product.costPrice || 0;
      price = parseFloat(Math.max(discountedPrice, costLimit).toFixed(2));
    }
  }

  if (activePromo) {
    const promoService = require('../../services/promo.service');
    const discountRes = promoService.calculateDiscount(activePromo, price, product._id);
    if (discountRes.valid) {
      price = discountRes.finalPrice;
    }
  }

  return price;
};

const clearActivePromo = async (ctx) => {
  // Очищаем применённый промокод из сессии и профиля пользователя после успешной покупки
  if (ctx.session?.activePromo || ctx.user?.activePromoCode) {
    ctx.session.activePromo = null;
    const User = require('../../models/User');
    await User.updateOne({ _id: ctx.user._id }, { $set: { activePromoCode: null } }).catch(() => {});
  }
};

const getActivePromoFromCtx = async (ctx) => {
  if (ctx.session?.activePromo) return ctx.session.activePromo;
  if (ctx.user?.activePromoCode) {
    const PromoCode = require('../../models/PromoCode');
    const promo = await PromoCode.findById(ctx.user.activePromoCode).lean();
    if (promo && promo.isActive) {
      const activeObj = {
        success: true,
        type: promo.type,
        code: promo.code,
        promoId: promo._id,
        value: promo.value,
        minOrderAmount: promo.minOrderAmount,
        productId: promo.productId ? promo.productId.toString() : null,
        isActive: true,
      };
      ctx.session = ctx.session || {};
      ctx.session.activePromo = activeObj;
      return activeObj;
    }
  }
  return null;
};

const stockIndicator = (stock, t) => {
  if (stock === '∞') return t ? t('shop_stock_infinite') : '♾️ Unlimited';
  if (stock > 10) return t ? t('shop_stock_high', { count: stock }) : `🟢 ${stock} pcs`;
  if (stock > 3) return t ? t('shop_stock_medium', { count: stock }) : `🟡 ${stock} pcs - low`;
  if (stock > 0) return t ? t('shop_stock_low', { count: stock }) : `🔴 ${stock} pcs - last`;
  return t ? t('shop_out_of_stock') : '⛔ Out of stock';
};

const getStock = async (product, autoKeysPrecomputed = null) => {
  const autoKeys = autoKeysPrecomputed !== null
    ? autoKeysPrecomputed
    : await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
  if (autoKeys > 0) return autoKeys;
  if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider)) {
    const mStock = product.manualStock;
    if (mStock === -1) return '∞';
    return (typeof mStock === 'number') ? mStock : 0;
  }
  if (product.type === 'manual') {
    return product.manualStock === -1 ? '∞' : (product.manualStock || 0);
  }
  return autoKeys;
};

/**
 * Остатки для СПИСКА товаров одной агрегацией вместо countDocuments на каждый
 * товар (раньше открытие магазина делало до ~60-70 запросов к БД).
 * Возвращает Map: productId(строка) → остаток (число или '∞').
 * Семантика идентична getStock().
 */
const getStockMap = async (products) => {
  const map = new Map();
  if (!products.length) return map;

  const rows = await Key.aggregate([
    { $match: { productId: { $in: products.map((p) => p._id) }, isUsed: false } },
    { $group: { _id: { productId: '$productId', provider: '$provider' }, cnt: { $sum: 1 } } },
  ]);

  // Счётчики по товару в разрезе провайдера (provider: null учитывается как совместимый)
  const counts = new Map();
  for (const r of rows) {
    const pid = String(r._id.productId);
    const prov = r._id.provider || '__null__';
    if (!counts.has(pid)) counts.set(pid, {});
    counts.get(pid)[prov] = r.cnt;
  }

  for (const p of products) {
    const pid = String(p._id);
    const c = counts.get(pid) || {};
    const provider = resolveProductProvider(p);
    const autoKeys = (c[provider] || 0) + (c['__null__'] || 0);
    let stock = autoKeys;
    if (autoKeys === 0) {
      if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(p.provider)) {
        const manualStock = p.manualStock;
        stock = manualStock === -1 ? '∞' : ((typeof manualStock === 'number') ? manualStock : 0);
      } else if (p.type === 'manual') {
        const manualStock = p.manualStock ?? -1;
        stock = manualStock === -1 ? '∞' : (manualStock || 0);
      }
    }
    map.set(pid, stock);
  }
  return map;
};

const showShopPage = async (ctx) => {
  const t = ctx.t || ((k) => k);
  const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 }).lean();

  if (categories.length === 0) {
    const msg = t('shop_empty') || 'Магазин пуст';
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, mainKeyboard(t, ctx.isSeller)).catch(() => {});
      return ctx.answerCbQuery().catch(() => {});
    }
    return ctx.reply(msg, mainKeyboard(t, ctx.isSeller));
  }

  // Статус наличия по всем категориям: один запрос товаров + одна агрегация
  // остатков (раньше - запросы в цикле по каждой категории и каждому товару).
  const allProducts = await Product.find({ isActive: true })
    .select('categoryId type manualStock provider')
    .lean();
  const stockMap = await getStockMap(allProducts);
  const statusByCat = new Map();
  for (const p of allProducts) {
    if (!p.categoryId) continue;
    const catKey = String(p.categoryId);
    if (statusByCat.get(catKey) === 'success') continue;
    const stock = stockMap.get(String(p._id));
    statusByCat.set(catKey, (stock === '∞' || stock > 0) ? 'success' : 'danger');
  }

  const isCollapsed = ctx.session?.shopMainOutOfStockCollapsed ?? true;

  const inStockCats = [];
  const outOfStockCats = [];

  for (const cat of categories) {
    const statusColor = statusByCat.get(String(cat._id)) || 'danger';
    if (statusColor === 'success') {
      inStockCats.push(cat);
    } else {
      outOfStockCats.push(cat);
    }
  }

  const isClassicTheme = ctx.user?.btnStyle === 'classic';
  const buttons = [];

  // 1. Категории в наличии (сетка по 3 в ряд)
  let row = [];
  for (const cat of inStockCats) {
    const label = `${cat.icon || '📁'} ${cat.name}`;
    const btn = Markup.button.callback(label, `shop:category:${cat._id}:1`);
    if (!isClassicTheme) btn.style = 'success';
    row.push(btn);

    if (row.length === 3) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);

  // 2. Сворачиваемый блок "Нет в наличии" для категорий
  if (outOfStockCats.length > 0) {
    const toggleIcon = isCollapsed ? '▼' : '▲';
    const toggleLabel = `Нет в наличии · ${outOfStockCats.length} ${toggleIcon}`;
    buttons.push([Markup.button.callback(toggleLabel, 'shop:toggle_out_main')]);

    if (!isCollapsed) {
      let outRow = [];
      for (const cat of outOfStockCats) {
        const label = `${cat.icon || '📁'} ${cat.name}`;
        const btn = Markup.button.callback(label, `shop:category:${cat._id}:1`);
        if (!isClassicTheme) btn.style = 'danger';
        outRow.push(btn);

        if (outRow.length === 3) {
          buttons.push(outRow);
          outRow = [];
        }
      }
      if (outRow.length > 0) buttons.push(outRow);
    }
  }

  buttons.push([Markup.button.callback(t('btn_back') || '⬅️ Назад', 'menu:main')]);

  const text = t('shop_title') || '🛒 Магазин';
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const showCategory = async (ctx, categoryId, page = 1) => {
  const t = ctx.t || ((k) => k);
  const category = await Category.findById(categoryId);
  if (!category || !category.isActive) {
    return ctx.answerCbQuery('❌ Категория не найдена', { show_alert: true });
  }

  const products = await Product.find({ categoryId, isActive: true })
    .sort({ sortOrder: 1, createdAt: -1 })
    .select('name nameEn icon price costPrice type manualStock provider lastSoldAt createdAt')
    .lean();

  if (products.length === 0) {
    return ctx.answerCbQuery('Пустая категория', { show_alert: true });
  }

  const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const paginated = products.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  const stockMap = await getStockMap(paginated);
  const buttons = [];
  const lang = ctx.user?.language || 'ru';

  const activePromo = await getActivePromoFromCtx(ctx);

  for (const product of paginated) {
    const stock = stockMap.get(String(product._id));
    const effectivePrice = await getEffectivePrice(product, stock, activePromo);
    const displayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
    const stockBadge = stock === '∞' ? '∞' : stock;

    let priceLabelStr = `$${effectivePrice}`;
    if (product.price > effectivePrice) {
      priceLabelStr = `̶$̶${product.price} ➔ $${effectivePrice}`;
    }

    const label = `${product.icon || '📦'} ${displayName} | ${priceLabelStr} | 📦 ${stockBadge}`;
    const btn = Markup.button.callback(label, `shop:product:${product._id}:${safePage}`);
    if (ctx.user?.btnStyle !== 'classic') {
      btn.style = (stock === '∞' || stock > 0) ? 'success' : 'danger';
    }

    buttons.push([btn]);
  }

  const navButtons = [];
  if (safePage > 1) navButtons.push(Markup.button.callback('⬅️', `shop:category:${categoryId}:${safePage - 1}`));
  navButtons.push(Markup.button.callback(`${safePage}/${totalPages}`, 'shop:noop'));
  if (safePage < totalPages) navButtons.push(Markup.button.callback('➡️', `shop:category:${categoryId}:${safePage + 1}`));
  if (navButtons.length) buttons.push(navButtons);

  buttons.push([
    Markup.button.callback('🔄 Обновить', `shop:category:${categoryId}:${safePage}`),
    Markup.button.callback('⬅️ К категориям', 'shop:main'),
  ]);

  const text = `📁 <b>${escapeHtml(category.name)}</b>\nВыберите продукт:`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };

  await ctx.editMessageText(text, opts).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
};

const toggleOutOfStock = async (ctx, categoryId, page = 1) => {
  ctx.session = ctx.session || {};
  ctx.session.outOfStockCollapsed = !ctx.session.outOfStockCollapsed;
  await ctx.answerCbQuery().catch(() => {});
  await showCategory(ctx, categoryId, page);
};

const showProduct = async (ctx, productId, fromPage = 1) => {
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery(ctx.t ? ctx.t('err_not_found') : '❌ Not found', { show_alert: true });
  }

  const t = ctx.t || ((k) => k);
  const stock = await getStock(product);
  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const description = lang === 'en' && product.descriptionEn ? product.descriptionEn : product.description;
  const activePromo = await getActivePromoFromCtx(ctx);
  const effectivePrice = await getEffectivePrice(product, stock, activePromo);
  const outOfStock = stock !== '∞' && stock === 0;

  let alertLine = '';
  if (!activePromo) {
    if (effectivePrice > product.price) {
      alertLine = '\n' + t('shop_alert_high_demand');
    } else if (effectivePrice < product.price) {
      alertLine = '\n' + t('shop_alert_markdown');
    }
  }

  const priceLabel = lang === 'en' ? '💰 Price' : '💰 Цена';
  const stockLabel = lang === 'en' ? '📦 Stock' : '📦 Наличие';

  let priceDisplay = `<b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)`;
  if (effectivePrice < product.price) {
    const promoNote = activePromo ? ` (Промокод ${activePromo.code})` : '';
    priceDisplay = `<s>${product.price} USDT</s> ➔ <b>${effectivePrice} USDT</b> 🔥${promoNote} (~${toRub(effectivePrice)} ₽)`;
  }

  const text =
    balanceHeader(ctx.user) +
    `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(name)}</b>\n\n` +
    `<blockquote>${priceLabel}: ${priceDisplay}${alertLine}\n` +
    `${stockLabel}: ${stockIndicator(stock, t)}</blockquote>\n\n` +
    `${description ? `<blockquote expandable>📝 ${escapeHtml(description)}</blockquote>\n` : ''}`;

  const buttons = [];
  if (!outOfStock) {
    if (product.type !== 'gpt_activation') {
      buttons.push([
        Markup.button.callback(t('btn_buy') || '⚡ Купить', `shop:qty:${productId}:${fromPage}:1`),
        Markup.button.callback('🛒 В корзину (+1)', `cart:add:${productId}`),
      ]);
    } else {
      buttons.push([Markup.button.callback(t('btn_buy'), `shop:buy:${productId}:${fromPage}:1`)]);
    }
  } else {
    buttons.push([Markup.button.callback('🔔 Уведомить о наличии', `shop:notify:${productId}`)]);
    buttons.push([Markup.button.callback('⏳ Сделать предзаказ', `shop:preorder_qty:${productId}:${fromPage}:1`)]);
  }

  // Кнопка перехода в корзину, если в ней есть товары
  const cartItems = ctx.user?.cart || [];
  const cartCount = cartItems.reduce((acc, it) => acc + (it.qty || 1), 0);
  if (cartCount > 0) {
    buttons.push([Markup.button.callback(`🛍 Перейти в корзину (${cartCount} шт.)`, 'menu:cart')]);
  }

  if (product.type === 'gpt_activation') {
    buttons.push([Markup.button.callback(t('shop_check_token'), `shop:check_token:${productId}`)]);
  }
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  buttons.push([Markup.button.callback(t('shop_back_to_list'), `shop:page:${safePage}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const handleWaitlist = async (ctx, productId) => {
  try {
    const product = await Product.findById(productId);
    if (!product || !product.isActive) {
      return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
    }
    
    // Check if they are already in waitlist
    const existing = await Waitlist.findOne({ userId: ctx.user._id, productId });
    if (existing) {
      return ctx.answerCbQuery('🔔 Вы уже подписаны на уведомления об этом товаре!', { show_alert: true });
    }

    await new Waitlist({ userId: ctx.user._id, productId }).save();
    return ctx.answerCbQuery('✅ Вы подписались! Как только товар появится, мы пришлем уведомление.', { show_alert: true });
  } catch (err) {
    return ctx.answerCbQuery('❌ Ошибка подписки', { show_alert: true });
  }
};

const showQuantitySelect = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  const product = await Product.findById(productId);
  const t = ctx.t || ((k) => k);

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && qty > stock) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const effectivePrice = await getEffectivePrice(product, stock);
  const total = parseFloat((effectivePrice * qty).toFixed(2));

  const text = t('shop_qty_title') + '\n\n' + t('shop_qty_total', { qty, total });

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const lang = ctx.user?.language || 'ru';
  const unit = lang === 'en' ? 'pcs' : 'шт';
  const buttons = [
    [
      Markup.button.callback('➖', `shop:qty_dec:${productId}:${safePage}:${qty}`),
      Markup.button.callback(`${qty} ${unit}`, 'shop:noop'),
      Markup.button.callback('➕', `shop:qty_inc:${productId}:${safePage}:${qty}`),
    ],
    [
      Markup.button.callback(`5 ${unit}`, `shop:qty_set:${productId}:${safePage}:5`),
      Markup.button.callback(`10 ${unit}`, `shop:qty_set:${productId}:${safePage}:10`),
      Markup.button.callback(`20 ${unit}`, `shop:qty_set:${productId}:${safePage}:20`),
    ],
    [Markup.button.callback(t('shop_qty_confirm_btn'), `shop:buy:${productId}:${safePage}:${qty}`)],
    [Markup.button.callback(t('btn_back'), `shop:product:${productId}:${safePage}`)]
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const confirmPurchase = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  const user = ctx.user;
  const product = await Product.findById(productId);
  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  const stock = await getStock(product);
  if (stock !== '∞' && stock < qty) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const productName = lang === 'en' && product.nameEn ? product.nameEn : product.name;

  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));
  
  if (user.balance < totalCost) {
    const diff = parseFloat((totalCost - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${diff} USDT` : `💰 Пополнить на ${diff} USDT`;
    const otherLabel = lang === 'en' ? '💳 Other amount' : '💳 Другая сумма';
    const backLabel = t('btn_back');
    const text = t('product_not_enough', {
      price: totalCost,
      balance: user.balance.toFixed(2),
      diff
    });
    return safeEdit(ctx, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(topupLabel, `topup:quick:${diff}`)],
        [Markup.button.callback(otherLabel, 'menu:topup')],
        [Markup.button.callback(backLabel, `shop:product:${productId}:${safePage}`)],
      ]),
    });
  }

  const newBalance = (user.balance - totalCost).toFixed(2);
  const confirmBtnLabel = lang === 'en'
    ? `✅ Yes, buy for ${totalCost} USDT`
    : `✅ Да, купить за ${totalCost} USDT`;
  const backToProductLabel = lang === 'en' ? '⬅️ Back to product' : '⬅️ Вернуться к товару';

  let text;
  if (qty > 1) {
    text = t('product_buy_confirm_qty', {
      name: escapeHtml(productName),
      qty,
      price: totalCost,
      priceRub: toRub(totalCost),
      balance: user.balance.toFixed(2),
      newBalance
    });
  } else {
    text = t('product_buy_confirm', {
      name: escapeHtml(productName),
      price: effectivePrice,
      priceRub: toRub(effectivePrice),
      balance: user.balance.toFixed(2),
      newBalance
    });
  }

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(confirmBtnLabel, `shop:confirm:${productId}:${safePage}:${qty}`)],
      [Markup.button.callback(backToProductLabel, `shop:product:${productId}:${safePage}`)],
    ]),
  };
  await safeEdit(ctx, text, opts);
  await ctx.answerCbQuery().catch(() => {});
};

const processPurchase = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  void fromPage;
  const user = ctx.user;
  const product = await Product.findById(productId);

  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';

  if (!product || !product.isActive) {
    return ctx.answerCbQuery(t('err_not_found'), { show_alert: true });
  }

  // Один countDocuments вместо двух одинаковых (getStock ниже переиспользует счётчик)
  const autoKeysAvailable = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
  const stock = await getStock(product, autoKeysAvailable);
  if (stock !== '∞' && qty > stock) {
    return ctx.answerCbQuery(t('shop_qty_not_enough', { stock }), { show_alert: true });
  }

  const activePromo = await getActivePromoFromCtx(ctx);
  const effectivePrice = await getEffectivePrice(product, stock, activePromo);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));

  if (user.balance < totalCost) {
    const deficit = parseFloat((totalCost - user.balance).toFixed(2));
    const topupLabel = lang === 'en' ? `💰 Top up ${deficit} USDT` : `💰 Пополнить на ${deficit} USDT`;
    const text = t('product_not_enough', {
      price: totalCost,
      balance: user.balance.toFixed(2),
      diff: deficit
    });
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(topupLabel, `topup:quick:${deficit}`)],
      [Markup.button.callback(t('btn_back'), `shop:product:${product._id}`)],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
    return ctx.answerCbQuery().catch(() => {});
  }

  const provider = resolveProductProvider(product);
  const isAutoKeyProduct = autoKeysAvailable >= qty;

  const User = require('../../models/User');
  const { withTransaction } = require('../../services/transactionHelper.service');

  let orders = [];
  let allocatedKeys = [];
  let usedSession = null;      // была ли реальная MongoDB-транзакция
  let balanceDebited = false;  // дошли ли до списания (для компенсации без транзакции)
  let manualStockDebited = false;

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;
      usedSession = session;
      // withTransaction может перезапустить callback при transient-ошибке -
      // сбрасываем накопленное состояние.
      orders = [];
      allocatedKeys = [];
      balanceDebited = false;
      manualStockDebited = false;

      if (isAutoKeyProduct) {
        // Атомарный захват каждого ключа: findOneAndUpdate с условием isUsed:false
        // гарантирует, что два параллельных покупателя НЕ получат один ключ
        // (раньше find + updateMany без условия позволяли выдать ключ дважды).
        for (let i = 0; i < qty; i++) {
          const claimed = await Key.findOneAndUpdate(
            buildKeyQueryForProduct(product, { isUsed: false }),
            { $set: { isUsed: true, usedAt: new Date() } },
            { new: true, ...(sessionOptions || {}) }
          );
          if (!claimed) break;
          allocatedKeys.push(claimed);
        }
        if (allocatedKeys.length < qty) {
          throw new Error('OUT_OF_STOCK');
        }
      }

      // Атомарное списание: условие balance >= totalCost прямо в фильтре.
      // Раньше "прочитал → изменил → save()" позволяло двойным кликом купить
      // дважды на один баланс.
      const debitedUser = await User.findOneAndUpdate(
        { _id: user._id, balance: { $gte: totalCost } },
        { $inc: { balance: -totalCost, totalSpent: totalCost } },
        { new: true, ...(sessionOptions || {}) }
      );
      if (!debitedUser) {
        throw new Error('INSUFFICIENT_BALANCE');
      }
      balanceDebited = true;
      ctx.user = debitedUser;

      if (!isAutoKeyProduct && (product.type === 'manual' || ['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider))) {
        if (product.manualStock !== -1) {
          // Атомарное уменьшение остатка с условием manualStock >= qty (защита от оверселла)
          const stockRes = await Product.updateOne(
            { _id: product._id, manualStock: { $gte: qty } },
            { $inc: { manualStock: -qty } },
            sessionOptions
          );
          if (!stockRes.modifiedCount) throw new Error('OUT_OF_STOCK');
          manualStockDebited = true;
          product.manualStock -= qty; // локально для дальнейшего отображения
        }

        const order = new Order({
          userId: user._id,
          productId: product._id,
          provider,
          price: totalCost,
          qty: qty,
          costPrice: (product.costPrice || 0) * qty,
          status: 'pending',
          keyId: null,
          confirmedAt: null,
          activationResult: null,
          warrantyDays: product.warrantyDays ?? 5,
        });
        await order.save(sessionOptions);
        orders.push(order);
      } else {
        for (let i = 0; i < qty; i++) {
          const allocatedKey = allocatedKeys[i] || null;
          const order = new Order({
            userId: user._id,
            productId: product._id,
            provider,
            price: effectivePrice,
            qty: 1,
            costPrice: product.costPrice || 0,
            status: product.type === 'gpt_activation' ? 'awaiting_token' : isAutoKeyProduct ? 'completed' : 'pending',
            keyId: allocatedKey ? allocatedKey._id : null,
            confirmedAt: isAutoKeyProduct ? new Date() : null,
            activationResult: isAutoKeyProduct ? 'Ключ выдан автоматически' : null,
            warrantyDays: product.warrantyDays ?? 5,
          });
          await order.save(sessionOptions);
          orders.push(order);

          if (allocatedKey) {
            await Key.updateOne(
              { _id: allocatedKey._id },
              { $set: { usedByOrder: order._id } },
              sessionOptions
            );
            allocatedKey.usedByOrder = order._id;
          }
        }
      }

      // lastSoldAt точечно, не затирая другие поля товара
      await Product.updateOne(
        { _id: product._id },
        { $set: { lastSoldAt: new Date() } },
        sessionOptions
      );

      await new Transaction({
        userId: user._id,
        type: 'purchase',
        amount: -totalCost,
        orderId: orders[0]._id, // Привязываем транзакцию к первому заказу для простоты
        description: `Покупка: ${product.name} (x${qty})`,
      }).save(sessionOptions);
    });
  } catch (err) {
    // В режиме реальных транзакций откат вернул баланс в БД, но ctx.user уже
    // мог быть заменён «списанным» документом - перечитываем актуальный.
    if (usedSession && balanceDebited) {
      try {
        const restored = await User.findById(user._id);
        if (restored) ctx.user = restored;
      } catch (_) {}
    }
    // Компенсация для режима БЕЗ транзакций (standalone MongoDB): реальная
    // транзакция откатывает всё сама, здесь возвращаем вручную.
    if (!usedSession) {
      if (allocatedKeys.length > 0) {
        try {
          const keyIds = allocatedKeys.map(k => k._id);
          await Key.updateMany(
            { _id: { $in: keyIds }, usedByOrder: null },
            { $set: { isUsed: false, usedAt: null } }
          );
        } catch (_) {}
      }
      // Сколько заказов ДОЛЖНО было создаться: manual-товар без автоключей -
      // один заказ на весь qty; остальное - по одному заказу на штуку.
      const expectedOrders = (!isAutoKeyProduct && product.type === 'manual') ? 1 : qty;
      if (balanceDebited && orders.length < expectedOrders) {
        try {
          // Возвращаем ПРОПОРЦИОНАЛЬНО числу несозданных заказов (раньше -
          // только при 0 созданных, что при qty>1 давало недовозврат).
          const missing = expectedOrders - orders.length;
          const refundAmount = parseFloat((totalCost * missing / expectedOrders).toFixed(8));
          if (refundAmount > 0) {
            await User.updateOne(
              { _id: user._id },
              { $inc: { balance: refundAmount, totalSpent: -refundAmount } }
            );
            if (ctx.user) ctx.user.balance = parseFloat((ctx.user.balance + refundAmount).toFixed(8));
            require('../../middlewares/user').invalidateUserCache(user.telegramId);
          }
        } catch (_) {}
      }
      if (manualStockDebited && orders.length === 0) {
        try {
          await Product.updateOne({ _id: product._id }, { $inc: { manualStock: qty } });
        } catch (_) {}
      }
    }

    if (err.message === 'INSUFFICIENT_BALANCE') {
      return ctx.answerCbQuery(t('err_insufficient_balance'), { show_alert: true });
    }
    if (err.message === 'OUT_OF_STOCK') {
      return ctx.answerCbQuery(t('err_out_of_stock'), { show_alert: true });
    }

    await ctx.answerCbQuery('❌').catch(() => {});
    await errorScreen(ctx, {
      title: lang === 'en' ? '💥 Order failed' : '💥 Не удалось оформить заказ',
      message: lang === 'en'
        ? 'An unexpected error occurred. Any charged funds have been returned.\n\nYou can try again or contact support.'
        : 'Произошла непредвиденная ошибка. Списанные средства возвращены.\n\nМожно попробовать снова или обратиться в поддержку.',
      retryAction: `shop:buy:${productId}`,
      backAction: 'menu:main',
    });
    throw err;
  }

  // Начисление продавцу (sellerPayout холдируется) и уведомления
  const productDisplayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  let sellerTotalPayout = 0;

  if (product.sellerId && product.sellerPrice > 0) {
    try {
      const seller = await Seller.findById(product.sellerId);
      if (seller && seller.isActive) {
        const payoutPerItem = parseFloat(product.sellerPrice.toFixed(8));
        sellerTotalPayout = parseFloat((payoutPerItem * qty).toFixed(8));
        
        const orderIds = orders.map(o => o._id);
        
        if (product.type === 'manual') {
          // Для manual у нас всего 1 заказ с qty = N
          await Order.updateMany(
            { _id: { $in: orderIds } },
            { $set: { sellerId: seller._id, sellerPayout: sellerTotalPayout } }
          );
        } else {
          // Для key у нас N заказов с qty = 1
          await Order.updateMany(
            { _id: { $in: orderIds } },
            { $set: { sellerId: seller._id, sellerPayout: payoutPerItem } }
          );
        }
        
        // Отправляем одно сводное уведомление продавцу
        const summaryOrder = { ...orders[0].toObject(), sellerPayout: sellerTotalPayout, qty };
        await notif.notifySellerNewOrder(seller, summaryOrder, product, ctx.user);
      }
    } catch (sellerErr) {
      const logger = require('../../config/logger');
      logger.error(`[Seller payout] Ошибка начисления продавцу: ${sellerErr.message}`);
    }
  }

  // Отправляем мгновенное уведомление администратору о каждой покупке
  for (const order of orders) {
    await notif.notifyAdminNewOrder(order, ctx.user, product).catch(() => {});
  }

  if (product.type === 'gpt_activation') {
    const orderLbl = lang === 'en' ? 'Order' : 'Заказ';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📋 ${orderLbl}: <code>${orders[0]._id}</code>\n` +
      `💰 ${chargedLbl}: <b>${totalCost} USDT</b>\n\n` +
      `⏳ ${lang === 'en' ? 'Requesting your token...' : 'Сейчас запрошу ваш токен...'}`;
    const opts = { parse_mode: 'HTML' };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
    await ctx.scene.enter('token_collection', { orderId: orders[0]._id.toString() });
  } else if (isAutoKeyProduct) {
    await grantReferralBonusForFirstCompletedOrder(orders[0].userId);

    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const qtyLbl = lang === 'en' ? 'Quantity' : 'Количество';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const keyLbl = lang === 'en' ? '🔑 <b>Your keys:</b>' : '🔑 <b>Ваши ключи:</b>';
    
    let keysText = '';
    if (qty === 1) {
      keysText = formatDigitalItem(allocatedKeys[0].value, lang);
    } else {
      allocatedKeys.forEach((k, idx) => {
        keysText += `<b>#${idx + 1}</b>\n${formatDigitalItem(k.value, lang)}\n\n`;
      });
    }

    const text =
      `✅ <b>${lang === 'en' ? 'Order completed automatically' : 'Заказ выполнен автоматически'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📊 ${qtyLbl}: <b>${qty}</b>\n` +
      `💰 ${chargedLbl}: <b>${totalCost} USDT</b>\n\n` +
      `${keyLbl}\n${keysText}`;

    const buyMoreLabel = lang === 'en' ? '🛒 Buy more' : '🛒 Купить ещё';
    const menuLabel = t('back_to_menu');
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(buyMoreLabel, `shop:product:${product._id}`)],
        [Markup.button.callback(menuLabel, 'menu:main')],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  } else if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(product.provider)) {
    // ─── Автоматический выкуп у внешнего поставщика через API (On-Demand) ───
    const supplierManager = require('../../services/supplierManager.service');
    const suppRes = await supplierManager.fulfillSupplierOrder(product, qty, ctx.user);

    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const qtyLbl = lang === 'en' ? 'Quantity' : 'Количество';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';

    if (suppRes.success && suppRes.deliveryData) {
      await Order.updateOne(
        { _id: orders[0]._id },
        {
          $set: {
            status: 'completed',
            confirmedAt: new Date(),
            deliveryData: String(suppRes.deliveryData),
            activationResult: 'Автовыдача через API поставщика ⚡',
          },
        }
      );
      orders[0].status = 'completed';
      orders[0].deliveryData = String(suppRes.deliveryData);

      const text =
        `✅ <b>${lang === 'en' ? 'Order delivered automatically ⚡' : 'Товар выдан моментально через API ⚡'}</b>\n\n` +
        `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
        `📊 ${qtyLbl}: <b>${qty}</b>\n` +
        `💰 ${chargedLbl}: <b>${totalCost} USDT</b>\n\n` +
        `🔑 <b>Ваши данные для доступа:</b>\n` +
        `<code>${escapeHtml(String(suppRes.deliveryData))}</code>\n\n` +
        `🛡 <i>Гарантия на заказ: ${product.warrantyDays ?? 5} дн.</i>`;

      const opts = {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Купить ещё', `shop:product:${product._id}`)],
          [Markup.button.callback(t('back_to_menu'), 'menu:main')],
        ]),
      };
      try {
        await ctx.editMessageText(text, opts);
      } catch (_) {
        await ctx.reply(text, opts).catch(() => {});
      }
      await ctx.answerCbQuery().catch(() => {});
    } else {
      // Если у поставщика сбой или 0 остатков - заказ ставится в очередь ручной выдачи
      const errNote = `Ошибка API поставщика: ${suppRes.error || 'неизвестно'}`;
      await Order.updateOne(
        { _id: orders[0]._id },
        { $set: { status: 'pending', notes: errNote } }
      );
      orders[0].status = 'pending';
      orders[0].notes = errNote;

      const text =
        `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ принят в обработку'}</b>\n\n` +
        `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
        `📊 ${qtyLbl}: <b>${qty}</b>\n` +
        `💰 ${chargedLbl}: ${totalCost} USDT\n\n` +
        `⏳ Товар будет выдан оператором в течение нескольких минут!`;

      const opts = {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(t('back_to_menu'), 'menu:main')]]),
      };
      try {
        await ctx.editMessageText(text, opts);
      } catch (_) {
        await ctx.reply(text, opts).catch(() => {});
      }
      await ctx.answerCbQuery().catch(() => {});
    }
  } else {
    const productLbl = lang === 'en' ? 'Product' : 'Товар';
    const qtyLbl = lang === 'en' ? 'Quantity' : 'Количество';
    const chargedLbl = lang === 'en' ? 'Charged' : 'Списано';
    const text =
      `✅ <b>${lang === 'en' ? 'Order created' : 'Заказ создан'}</b>\n\n` +
      `📦 ${productLbl}: ${escapeHtml(product.icon || '📦')} ${escapeHtml(productDisplayName)}\n` +
      `📊 ${qtyLbl}: <b>${qty}</b>\n` +
      `💰 ${chargedLbl}: ${totalCost} USDT\n\n` +
      `⏳ ${lang === 'en' ? 'An operator will process your order shortly.' : 'Оператор обработает заказ в ближайшее время.'}`;

    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(t('back_to_menu'), 'menu:main')]]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  }

  if (product.type !== 'manual') {
    const remaining = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    const LOW_STOCK_THRESHOLD = 5;
    const LOW_STOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 часов

    if (remaining <= LOW_STOCK_THRESHOLD) {
      const lastNotifiedAt = product.lowStockNotifiedAt
        ? new Date(product.lowStockNotifiedAt).getTime()
        : 0;
      const elapsedMs = Date.now() - lastNotifiedAt;

      if (elapsedMs >= LOW_STOCK_COOLDOWN_MS) {
        await notif.notifyAdminLowStock(product, remaining);
        await Product.updateOne(
          { _id: product._id },
          { $set: { lowStockNotifiedAt: new Date() } }
        );
      }
    } else if (product.lowStockNotifiedAt) {
      // Запасы восполнили - сбрасываем флаг, чтобы в следующий раз уведомить сразу.
      await Product.updateOne(
        { _id: product._id },
        { $set: { lowStockNotifiedAt: null } }
      );
    }
  }
};

const showPreorderQuantitySelect = async (ctx, productId, fromPage = 1, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;

  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const t = ctx.t || ((k) => k);
  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const stock = await getStock(product);
  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);

  const unit = lang === 'en' ? 'pcs' : 'шт';
  const isRu = lang === 'ru';

  const text = balanceHeader(ctx.user) +
    `⏳ <b>Выбор количества для предзаказа</b>\n\n` +
    `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(name)}</b>\n\n` +
    `💰 <b>Цена за 1 шт:</b> ${effectivePrice} USDT (~${toRub(effectivePrice)} ₽)\n` +
    `📦 <b>Выбрано:</b> <b>${qty} ${unit}</b>\n` +
    `💵 <b>Итого к списанию:</b> <b>${totalCost} USDT</b> (~${toRub(totalCost)} ₽)\n\n` +
    `<i>💡 Бот выдаст вам все ${qty} ${unit} первой очередью сразу при пополнении склада!</i>`;

  const buttons = [
    [
      Markup.button.callback('➖', `shop:preorder_qty_dec:${productId}:${safePage}:${qty}`),
      Markup.button.callback(`${qty} ${unit}`, 'shop:noop'),
      Markup.button.callback('➕', `shop:preorder_qty_inc:${productId}:${safePage}:${qty}`),
    ],
    [
      Markup.button.callback(`5 ${unit}`, `shop:preorder_qty_set:${productId}:${safePage}:5`),
      Markup.button.callback(`10 ${unit}`, `shop:preorder_qty_set:${productId}:${safePage}:10`),
      Markup.button.callback(`20 ${unit}`, `shop:preorder_qty_set:${productId}:${safePage}:20`),
    ],
    [Markup.button.callback(isRu ? `⏳ Предзаказать ${qty} ${unit} (${totalCost} USDT)` : `⏳ Pre-order ${qty} ${unit} (${totalCost} USDT)`, `shop:preorder:${productId}:${qty}`)],
    [Markup.button.callback(t('btn_back'), `shop:product:${productId}:${safePage}`)]
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
};

const confirmPreorder = async (ctx, productId, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;

  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const stock = await getStock(product);
  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));
  const unit = lang === 'en' ? 'pcs' : 'шт';

  const isRu = lang === 'ru';
  const title = isRu ? '⏳ <b>Подтверждение предзаказа</b>' : '⏳ <b>Pre-order Confirmation</b>';
  const infoText = isRu
    ? `Вы собираетесь зарезервировать товар <b>${escapeHtml(name)}</b> в количестве <b>${qty} ${unit}</b>.\n\n` +
      `💰 <b>Общая сумма списания:</b> ${totalCost} USDT (~${toRub(totalCost)} ₽)\n` +
      `💳 <b>Ваш баланс:</b> ${ctx.user.balance.toFixed(2)} USDT\n\n` +
      `<i>💡 Как только склад пополнится (появятся новые аккаунты), бот автоматически выдаст вам товар в личку первейшей очередью! Вы сможете отменить предзаказ в любой момент в «Мои заказы».</i>`
    : `You are about to pre-order <b>${escapeHtml(name)}</b> (qty: <b>${qty} ${unit}</b>).\n\n` +
      `💰 <b>Total Price:</b> ${totalCost} USDT\n` +
      `💳 <b>Your balance:</b> ${ctx.user.balance.toFixed(2)} USDT\n\n` +
      `<i>💡 As soon as stock arrives, the bot will automatically deliver items to your PM in priority queue! You can cancel anytime in "My Orders".</i>`;

  const btnConfirm = isRu ? `✅ Подтвердить предзаказ (${qty} ${unit}) — ${totalCost} USDT` : `✅ Confirm Pre-order (${qty} ${unit}) — ${totalCost} USDT`;
  const btnBack = isRu ? '⬅️ Назад' : '⬅️ Back';

  const buttons = [
    [Markup.button.callback(btnConfirm, `shop:preorder_confirm:${productId}:${qty}`)],
    [Markup.button.callback(btnBack, `shop:product:${productId}`)],
  ];

  try {
    await ctx.editMessageText(`${title}\n\n${infoText}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(`${title}\n\n${infoText}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
  await ctx.answerCbQuery().catch(() => {});
};

const processPreorder = async (ctx, productId, qty = 1) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;

  const user = ctx.user;
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const stock = await getStock(product);
  const effectivePrice = await getEffectivePrice(product, stock);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));

  if (user.balance < totalCost) {
    return ctx.answerCbQuery(`❌ Недостаточно средств. Нужно: ${totalCost} USDT, ваш баланс: ${user.balance.toFixed(2)} USDT`, { show_alert: true });
  }

  // Атомарное списание с условием в фильтре: двойной клик по кнопке предзаказа
  // раньше создавал 2×qty оплаченных предзаказов при одном списании.
  const User = require('../../models/User');
  const { withTransaction } = require('../../services/transactionHelper.service');
  const createdOrders = [];
  let preorderUsedSession = null;
  let preorderDebited = false;

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;
      preorderUsedSession = session;
      createdOrders.length = 0;
      preorderDebited = false;

      const debitedUser = await User.findOneAndUpdate(
        { _id: user._id, balance: { $gte: totalCost } },
        { $inc: { balance: -totalCost, totalSpent: totalCost } },
        { new: true, ...(sessionOptions || {}) }
      );
      if (!debitedUser) throw new Error('INSUFFICIENT_BALANCE');
      preorderDebited = true;
      ctx.user = debitedUser;

      for (let i = 0; i < qty; i++) {
        const order = new Order({
          userId: user._id,
          productId: product._id,
          price: effectivePrice,
          qty: 1,
          status: 'preorder_pending',
          warrantyDays: product.warrantyDays ?? 5,
        });
        await order.save(sessionOptions);
        createdOrders.push(order);
      }

      const Transaction = require('../../models/Transaction');
      await new Transaction({
        userId: user._id,
        type: 'purchase',
        amount: -totalCost,
        orderId: createdOrders[0]._id,
        description: `Предзаказ: ${product.name} (x${qty})`,
      }).save(sessionOptions);
    });
  } catch (err) {
    // В режиме реальных транзакций откат вернул баланс в БД - перечитываем ctx.user
    if (preorderUsedSession && preorderDebited) {
      try {
        const restored = await User.findById(user._id);
        if (restored) ctx.user = restored;
      } catch (_) {}
    }
    // Компенсация в режиме без транзакций
    if (!preorderUsedSession && preorderDebited && createdOrders.length === 0) {
      await User.updateOne(
        { _id: user._id },
        { $inc: { balance: totalCost, totalSpent: -totalCost } }
      ).catch(() => {});
      if (ctx.user) ctx.user.balance = parseFloat((ctx.user.balance + totalCost).toFixed(8));
    }
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return ctx.answerCbQuery(`❌ Недостаточно средств. Нужно: ${totalCost} USDT`, { show_alert: true });
    }
    throw err;
  }

  await Waitlist.updateOne(
    { userId: user._id, productId: product._id },
    { $setOnInsert: { userId: user._id, productId: product._id } },
    { upsert: true }
  );

  const isRu = (user.language || 'ru') === 'ru';
  const unit = isRu ? 'шт' : 'pcs';
  const msgText = isRu
    ? `⏳ <b>Предзаказ на ${qty} ${unit} успешно зарезервирован!</b>\n\n` +
      `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
      `💰 <b>Всего списано:</b> ${totalCost} USDT\n\n` +
      `<i>Ваши предзаказы поставлены в 1-ю очередь. Бот автоматически пришлёт данные товара вам в личные сообщения при пополнении склада!</i>`
    : `⏳ <b>Pre-order for ${qty} ${unit} successfully placed!</b>\n\n` +
      `📦 <b>Product:</b> ${escapeHtml(product.nameEn || product.name)}\n` +
      `<i>Your pre-order is in priority queue. The bot will automatically send product data to your PM on stock arrival!</i>`;

  const buttons = [
    [Markup.button.callback(isRu ? '📋 Мои заказы' : '📋 My Orders', 'profile:orders:all:1')],
    [Markup.button.callback(isRu ? '🛒 В магазин' : '🛒 Shop', 'shop:main')],
  ];

  try {
    await ctx.editMessageText(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(msgText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
  await ctx.answerCbQuery('⏳ Предзаказ успешно создан!').catch(() => {});

  notif.sendToAdmins(
    `⏳ <b>Новый Предзаказ!</b>\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
    `👤 <b>Покупатель:</b> @${escapeHtml(user.username || user.telegramId)}\n` +
    `💰 <b>Сумма:</b> ${effectivePrice} USDT`
  ).catch(() => {});
};

const toggleShopMainOutOfStock = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.shopMainOutOfStockCollapsed = !ctx.session.shopMainOutOfStockCollapsed;
  await ctx.answerCbQuery().catch(() => {});
  await showShopPage(ctx);
};

module.exports = { showShopPage, showCategory, showProduct, confirmPurchase, processPurchase, showQuantitySelect, handleWaitlist, confirmPreorder, processPreorder, showPreorderQuantitySelect, toggleOutOfStock, toggleShopMainOutOfStock };

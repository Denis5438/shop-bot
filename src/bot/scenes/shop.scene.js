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
const { getEffectivePrice } = require('../../services/orderPricing.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const {
  buildKeyQueryForProduct,
  resolveProductProvider,
} = require('../../services/provider.service');
const notif = require('../../services/notification.service');
const Seller = require('../../models/Seller');
const promoService = require('../../services/promo.service');
const { balanceHeader, errorScreen, escapeHtml, formatDateTimeMSK, formatDigitalItem, safeEdit } = require('../utils/ui');
const { mainKeyboard } = require('../keyboards/main.keyboard');

const PRIVACY_URL = 'https://telegra.ph/Politika-konfidencialnosti-08-17-78';
const AGREEMENT_URL = 'https://telegra.ph/Polzovatelskoe-soglashenie-08-17-44';

const clearActivePromo = async (ctx) => {
  // Очищаем применённый промокод из сессии и базы данных пользователя
  if (ctx.session) ctx.session.activePromo = null;
  if (ctx.user) ctx.user.activePromoCode = null;
  if (ctx.user?._id) {
    const User = require('../../models/User');
    await User.updateOne({ _id: ctx.user._id }, { $set: { activePromoCode: null } }).catch(() => {});
  }
};

const getActivePromoFromCtx = async (ctx) => {
  const promoId = ctx.session?.activePromo?.promoId || ctx.user?.activePromoCode;
  if (!promoId) return null;

  const PromoCode = require('../../models/PromoCode');
  const PromoUsage = require('../../models/PromoUsage');

  // ВСЕГДА проверяем актуальный статус промокода в базе данных!
  const promo = await PromoCode.findById(promoId).lean();

  // 1. Промокод удален из базы или выключен администратором
  if (!promo || !promo.isActive) {
    await clearActivePromo(ctx);
    return null;
  }

  // 2. Промокод истёк по времени
  if (promo.expiresAt && new Date() > new Date(promo.expiresAt)) {
    await clearActivePromo(ctx);
    return null;
  }

  // 3. Превышен общий лимит активаций
  if (promo.maxActivations !== -1 && promo.currentActivations >= promo.maxActivations) {
    await clearActivePromo(ctx);
    return null;
  }

  // 4. Проверяем лимит использований этим пользователем
  if (ctx.user?._id) {
    const userUsageCount = await PromoUsage.countDocuments({ promoId: promo._id, userId: ctx.user._id });
    if (promo.maxPerUser !== -1 && userUsageCount >= promo.maxPerUser) {
      await clearActivePromo(ctx);
      return null;
    }
  }

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
    .select('name nameEn icon price costPrice type manualStock provider sortOrder lastSoldAt createdAt')
    .lean();

  if (products.length === 0) {
    return ctx.answerCbQuery('Пустая категория', { show_alert: true });
  }

  const stockMap = await getStockMap(products);

  const allInStock = [];
  const allOutOfStock = [];

  for (const p of products) {
    const stock = stockMap.get(String(p._id));
    if (stock === '∞' || (typeof stock === 'number' && stock > 0)) {
      allInStock.push({ product: p, stock });
    } else {
      allOutOfStock.push({ product: p, stock: 0 });
    }
  }

  // Сортировка внутри каждой группы
  const sortFn = (a, b) => {
    const orderA = a.product.sortOrder || 0;
    const orderB = b.product.sortOrder || 0;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(b.product.createdAt || 0) - new Date(a.product.createdAt || 0);
  };
  allInStock.sort(sortFn);
  allOutOfStock.sort(sortFn);

  // По умолчанию блок отсутствующих свернут
  const isCollapsed = ctx.session?.outOfStockCollapsed !== false;

  // Если свернуто и есть товары в наличии - пагинируем только товары в наличии!
  let activeList = [];
  if (isCollapsed && allInStock.length > 0) {
    activeList = allInStock;
  } else {
    activeList = [...allInStock, ...allOutOfStock];
  }

  const totalPages = Math.max(1, Math.ceil(activeList.length / ITEMS_PER_PAGE));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const paginated = activeList.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  const buttons = [];
  const lang = ctx.user?.language || 'ru';
  const isClassicTheme = ctx.user?.btnStyle === 'classic';
  const activePromo = await getActivePromoFromCtx(ctx);

  for (const { product, stock } of paginated) {
    const hasStock = stock === '∞' || (typeof stock === 'number' && stock > 0);
    const effectivePrice = await getEffectivePrice(product, stock, activePromo);
    const displayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
    const stockBadge = stock === '∞' ? '∞' : stock;

    let priceLabelStr = `$${effectivePrice}`;
    if (product.price > effectivePrice) {
      priceLabelStr = `̶$̶${product.price} ➔ $${effectivePrice}`;
    }

    const isFlash = Boolean(
      product.flashSale?.enabled &&
      product.flashSale.expiresAt &&
      new Date(product.flashSale.expiresAt) > new Date() &&
      product.flashSale.discountPercent > 0
    );
    const flashPrefix = isFlash ? '⚡ ' : '';

    const maxNameLen = 18;
    const shortName = displayName.length > maxNameLen ? displayName.substring(0, maxNameLen - 1) + '…' : displayName;
    const label = `${flashPrefix}${product.icon || '📦'} ${shortName} · ${priceLabelStr} · 📦 ${stockBadge}`;
    const btn = Markup.button.callback(label, `shop:product:${product._id}:${safePage}`);
    if (!isClassicTheme) btn.style = hasStock ? 'success' : 'danger';
    buttons.push([btn]);
  }

  // Кнопка сворачивания / разворачивания отсутствующих товаров (предзаказа)
  if (allOutOfStock.length > 0 && allInStock.length > 0) {
    const toggleIcon = isCollapsed ? '▼' : '▲';
    const toggleLabel = isCollapsed
      ? (lang === 'en' ? `⏳ Out of stock (${allOutOfStock.length}) ${toggleIcon}` : `⏳ Нет в наличии (предзаказ) · ${allOutOfStock.length} ${toggleIcon}`)
      : (lang === 'en' ? `⏳ Hide out of stock ${toggleIcon}` : `⏳ Скрыть отсутствующие товары ${toggleIcon}`);
    buttons.push([Markup.button.callback(toggleLabel, `shop:toggle_out:${categoryId}:${safePage}`)]);
  }

  const navButtons = [];
  if (safePage > 1) navButtons.push(Markup.button.callback('⬅️', `shop:category:${categoryId}:${safePage - 1}`));
  if (totalPages > 1) navButtons.push(Markup.button.callback(`${safePage}/${totalPages}`, 'shop:noop'));
  if (safePage < totalPages) navButtons.push(Markup.button.callback('➡️', `shop:category:${categoryId}:${safePage + 1}`));
  if (navButtons.length) buttons.push(navButtons);

  buttons.push([
    Markup.button.callback(lang === 'en' ? '🔄 Refresh' : '🔄 Обновить', `shop:category:${categoryId}:${safePage}`),
    Markup.button.callback(lang === 'en' ? '⬅️ To Categories' : '⬅️ К категориям', 'shop:main'),
  ]);

  const text = `📁 <b>${escapeHtml(category.name)}</b>\n${lang === 'en' ? 'Select a product:' : 'Выберите товар:'}`;
  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };

  await safeEdit(ctx, text, opts);
};

const toggleOutOfStock = async (ctx, categoryId, page = 1) => {
  ctx.session = ctx.session || {};
  ctx.session.outOfStockCollapsed = ctx.session.outOfStockCollapsed === false ? true : false;
  await ctx.answerCbQuery().catch(() => {});
  await showCategory(ctx, categoryId, 1);
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
  const statusLabel = t('product_status_label') || (lang === 'en' ? 'Status' : 'Статус');
  const isSupplier = product.itemOrigin === 'supplier'
    || Boolean(product.provider && product.provider !== 'local')
    || Boolean(product.supplierProductCode)
    || Boolean(product.sellerId && product.itemOrigin !== 'verified');
  const statusIcon = isSupplier ? '👤' : '🛡';
  const originText = isSupplier
    ? (t('product_origin_supplier') || (lang === 'en' ? 'Supplier Product' : 'От поставщика'))
    : (t('product_origin_verified') || (lang === 'en' ? 'Verified' : 'Верифицированный'));

  let warrantyLine = '';
  if (typeof product.warrantyDays === 'number') {
    const warrantyLabel = t('product_warranty_label') || (lang === 'en' ? '⏳ Warranty' : '⏳ Гарантия');
    const warrantyVal = product.warrantyDays === 0
      ? (lang === 'en' ? 'No warranty' : 'Без гарантии')
      : (t('product_warranty_days', { days: product.warrantyDays }) || (lang === 'en' ? `${product.warrantyDays} days` : `${product.warrantyDays} дн.`));
    warrantyLine = `\n${warrantyLabel}: <b>${warrantyVal}</b>`;
  }

  let durationLine = '';
  if (product.subscriptionDays && product.subscriptionDays > 0) {
    const durationLabel = lang === 'en' ? '⏳ Duration' : '⏳ Подписка';
    const durationVal = lang === 'en' ? `${product.subscriptionDays} days` : `${product.subscriptionDays} дн.`;
    durationLine = `\n${durationLabel}: <b>${durationVal}</b>`;
  }

  const now = Date.now();
  const isFlashSale = Boolean(
    product.flashSale?.enabled &&
    product.flashSale.expiresAt &&
    new Date(product.flashSale.expiresAt).getTime() > now &&
    product.flashSale.discountPercent > 0
  );

  let flashSaleBlock = '';
  if (isFlashSale) {
    const diffMs = Math.max(0, new Date(product.flashSale.expiresAt).getTime() - now);
    const totalSecs = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    const pad = (n) => String(n).padStart(2, '0');
    const timerStr = `${pad(hours)}:${pad(mins)}:${pad(secs)}`;

    flashSaleBlock = lang === 'en'
      ? `\n\n<blockquote>🔥 <b>FLASH SALE -${product.flashSale.discountPercent}%!</b>\n⏳ Ends in: <code>${timerStr}</code></blockquote>`
      : `\n\n<blockquote>🔥 <b>FLASH SALE -${product.flashSale.discountPercent}%!</b>\n⏳ До конца скидки: <code>${timerStr}</code></blockquote>`;
  }

  let priceDisplay = `<b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)`;
  if (effectivePrice < product.price) {
    const promoNote = activePromo ? ` (Промокод ${activePromo.code})` : '';
    const flashNote = isFlashSale ? ` 🔥 (-${product.flashSale.discountPercent}%)` : ' 🔥';
    priceDisplay = `<s>${product.price} USDT</s> ➔ <b>${effectivePrice} USDT</b>${flashNote}${promoNote} (~${toRub(effectivePrice)} ₽)`;
  }

  const text =
    balanceHeader(ctx.user) +
    `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(name)}</b>\n\n` +
    `<blockquote>${priceLabel}: ${priceDisplay}${alertLine}\n` +
    `${stockLabel}: ${stockIndicator(stock, t)}\n` +
    `${statusIcon} ${statusLabel}: <b>${originText}</b>${warrantyLine}${durationLine}</blockquote>` +
    `${flashSaleBlock}\n\n` +
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

  const promoBtnLabel = activePromo
    ? (lang === 'en' ? `🎟 Promo: ${activePromo.code} (${activePromo.type === 'percent' ? '-' + activePromo.value + '%' : '-' + activePromo.value + ' USDT'})` : `🎟 Промокод: ${activePromo.code} (${activePromo.type === 'percent' ? '-' + activePromo.value + '%' : '-' + activePromo.value + ' USDT'})`)
    : (lang === 'en' ? '🎟 Enter Promo Code' : '🎟 Ввести промокод');
  buttons.push([Markup.button.callback(promoBtnLabel, `shop:promo_prompt:${productId}:${fromPage}:1`)]);

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const backAction = product.categoryId
    ? `shop:category:${product.categoryId}:${safePage}`
    : `shop:page:${safePage}`;
  const bottomRow = [Markup.button.callback(t('shop_back_to_list'), backAction)];
  if (isFlashSale) {
    bottomRow.unshift(Markup.button.callback(lang === 'en' ? '🔄 Refresh' : '🔄 Обновить', `shop:product:${productId}:${safePage}`));
  }
  buttons.push(bottomRow);

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
  const maxAvailable = stock === '∞' ? 99999 : stock;
  if (stock !== '∞' && qty > stock) {
    qty = stock;
  }

  const activePromo = await getActivePromoFromCtx(ctx);
  const effectivePrice = await getEffectivePrice(product, stock, activePromo);
  const total = parseFloat((effectivePrice * qty).toFixed(2));
  const totalRub = toRub(total);

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const lang = ctx.user?.language || 'ru';
  const unit = lang === 'en' ? 'pcs' : 'шт.';
  const productName = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const stockText = stock === '∞' ? '∞ (неограниченно)' : `${stock} шт.`;

  const text =
    `📦 <b>${escapeHtml(productName)}</b>\n\n` +
    `📊 <b>Выбор количества:</b>\n` +
    `📦 В наличии на складе: <b>${stockText}</b>\n` +
    `💰 Цена за 1 шт: <b>${effectivePrice} USDT</b> (~${toRub(effectivePrice)} ₽)\n\n` +
    `🛒 Выбрано: <b>${qty} ${unit}</b>\n` +
    `💵 Итого к оплате: <b>${total} USDT</b> (~${totalRub} ₽)`;

  const buttons = [];

  // Ряд 1: Кнопки - / текущее количество / +
  buttons.push([
    Markup.button.callback('➖', `shop:qty_dec:${productId}:${safePage}:${qty}`),
    Markup.button.callback(`${qty} ${unit}`, 'shop:noop'),
    Markup.button.callback('➕', `shop:qty_inc:${productId}:${safePage}:${qty}`),
  ]);

  // Ряд 2: Быстрые пресеты 5 / 10 / 20 (если остаток позволяет)
  const presetsRow = [];
  if (maxAvailable >= 5) presetsRow.push(Markup.button.callback(`5 ${unit}`, `shop:qty_set:${productId}:${safePage}:5`));
  if (maxAvailable >= 10) presetsRow.push(Markup.button.callback(`10 ${unit}`, `shop:qty_set:${productId}:${safePage}:10`));
  if (maxAvailable >= 20) presetsRow.push(Markup.button.callback(`20 ${unit}`, `shop:qty_set:${productId}:${safePage}:20`));
  if (presetsRow.length > 0) buttons.push(presetsRow);

  // Ряд 3: Кнопка моментальной покупки всего доступного остатка
  if (typeof stock === 'number' && stock > 1) {
    const maxBuyLabel = lang === 'en' ? `⚡ Купить максимум (${stock} ${unit})` : `⚡ Купить максимум (${stock} ${unit})`;
    buttons.push([Markup.button.callback(maxBuyLabel, `shop:buy:${productId}:${safePage}:${stock}`)]);
  }

  // Ряд 4: Ввести точное число
  buttons.push([
    Markup.button.callback(lang === 'en' ? '🔢 Enter Custom Quantity' : '🔢 Ввести точное число', `shop:qty_custom:${productId}:${safePage}`)
  ]);

  // Ряд 5: Продолжить с выбранным количеством
  buttons.push([
    Markup.button.callback(lang === 'en' ? '✅ Continue' : '✅ Продолжить', `shop:buy:${productId}:${safePage}:${qty}`)
  ]);

  // Ряд 6: Назад к товару
  buttons.push([
    Markup.button.callback(lang === 'en' ? '⬅️ Back to product' : '⬅️ К товару', `shop:product:${productId}:${safePage}`)
  ]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
};

const startCustomQuantity = async (ctx, productId, fromPage = 1) => {
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const stock = await getStock(product);
  const lang = ctx.user?.language || 'ru';
  const stockText = stock === '∞' ? '∞' : `${stock}`;

  ctx.session = ctx.session || {};
  ctx.session.userAction = 'enter_shop_quantity';
  ctx.session.qtyCustomProductId = productId;
  ctx.session.qtyCustomPage = safePage;
  ctx.session.qtyCustomMaxStock = stock === '∞' ? 99999 : stock;
  ctx.session.qtyCustomMsgId = ctx.callbackQuery?.message?.message_id;

  const text =
    `🔢 <b>Ввод количества товара</b>\n\n` +
    `Введите необходимое количество сообщением в чат:\n` +
    `<i>(Доступно для заказа: от 1 до ${stockText} шт.)</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', `shop:qty:${productId}:${safePage}:1`)],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery().catch(() => {});
};

const confirmPurchase = async (ctx, productId, fromPage = 1, qty = 1, tosChecked = false) => {
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

  const activePromo = await getActivePromoFromCtx(ctx);
  const baseEffectivePrice = await getEffectivePrice(product, stock, null);
  const promoDiscount = activePromo
    ? promoService.calculateDiscount(activePromo, baseEffectivePrice * qty, product._id)
    : { valid: false, discountAmount: 0 };
  const totalCost = promoDiscount.valid
    ? promoDiscount.finalPrice
    : parseFloat((baseEffectivePrice * qty).toFixed(2));
  const effectivePrice = Number((totalCost / qty).toFixed(2));
  const totalCostRub = toRub(totalCost);

  const promoInfoLine = activePromo
    ? `\n🏷 <b>Скидка по промокоду:</b> <code>${activePromo.code}</code> (${activePromo.type === 'percent' ? '-' + activePromo.value + '%' : '-' + activePromo.value + ' USDT'})`
    : '';

  const tariffLine = qty > 1
    ? `${qty} шт.`
    : (product.warrantyDays ? `${product.warrantyDays} дн. гарантии` : '1 шт.');

  const text =
    `<b>Перед оплатой</b>\n` +
    `Проверьте условия заказа — это займёт меньше минуты.\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(productName)}\n` +
    `📊 <b>Тариф / Количество:</b> ${tariffLine}\n` +
    `💰 <b>Цена:</b> <b>${totalCost} USDT</b> (~${totalCostRub} ₽)${promoInfoLine}\n\n` +
    `<b>Поставьте галочку, только если вы:</b>\n` +
    `• Прочитали описание товара и проверили состав заказа, срок и способ выдачи.\n` +
    `• Поняли правила использования товара и последствия их нарушения, включая запрет менять данные общего аккаунта, если он указан в описании.\n` +
    `• Прочитали политику возврата и гарантии и принимаете её условия.\n\n` +
    `<i>Цена и способ списания будут подтверждены на следующем шаге.</i>`;

  const checkmarkIcon = tosChecked ? '☑️' : '◻️';
  const toggleNext = tosChecked ? '0' : '1';
  const checkBtnLabel = lang === 'en'
    ? `${checkmarkIcon} I have read and agree to all terms`
    : `${checkmarkIcon} Я ознакомился со всем и принимаю условия`;

  const buttons = [
    [Markup.button.callback('📜 Условия покупки и возврата', `shop:terms_info:${productId}:${safePage}:${qty}`)],
    [Markup.button.callback(checkBtnLabel, `shop:tos_toggle:${productId}:${safePage}:${qty}:${toggleNext}`)],
  ];

  if (tosChecked) {
    const payBtnLabel = lang === 'en' ? '💰 Accept and Proceed to Payment' : '💰 Принять и перейти к оплате';
    buttons.push([Markup.button.callback(payBtnLabel, `shop:pay_step:${productId}:${safePage}:${qty}`)]);
  }

  buttons.push([Markup.button.callback(lang === 'en' ? '📝 Open Product Description' : '📝 Открыть описание товара', `shop:desc_info:${productId}:${safePage}:${qty}`)]);

  const isMultiQtyProduct = product.type !== 'gpt_activation';
  const backAction = isMultiQtyProduct
    ? `shop:qty:${productId}:${safePage}:${qty}`
    : `shop:product:${productId}:${safePage}`;
  const backLabel = isMultiQtyProduct
    ? (lang === 'en' ? '⬅️ Back to quantity' : '⬅️ К выбору количества')
    : (lang === 'en' ? '⬅️ Back to product' : '⬅️ К товару');

  buttons.push([Markup.button.callback(backLabel, backAction)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
  await ctx.answerCbQuery().catch(() => {});
};

const handlePayStep = async (ctx, productId, fromPage = 1, qty = 1) => {
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

  const activePromo = await getActivePromoFromCtx(ctx);
  const effectivePrice = await getEffectivePrice(product, stock, activePromo);
  const totalCost = parseFloat((effectivePrice * qty).toFixed(2));
  const totalCostRub = toRub(totalCost);

  // Хватает ли баланса пользователя
  if (user.balance >= totalCost) {
    // Баланса хватает - выполняем списание и выдачу
    await processPurchase(ctx, productId, fromPage, qty);
    return;
  }

  // Баланса не хватает - экран "Чем платим?"
  const diff = parseFloat((totalCost - user.balance).toFixed(2));
  const diffRub = toRub(diff);

  const text =
    `<b>${escapeHtml(productName)}</b>\n` +
    `Сумма заказа: <b>${totalCost} USDT</b> (~${totalCostRub} ₽)\n` +
    `Ваш текущий баланс: <b>${user.balance.toFixed(2)} USDT</b>\n` +
    `Необходимо доплатить: <b>${diff} USDT</b> (~${diffRub} ₽)\n\n` +
    `<b>Чем платим?</b>\n\n` +
    `<i>Условия подтверждены для этой попытки оплаты.</i>`;

  const buttons = [
    [
      Markup.button.callback(`💳 Картой ₽ / СБП · ${diffRub} ₽`, `topup:quick:${diff}`),
      Markup.button.callback(`💰 Криптой · USDT/TON`, `topup:quick:${diff}`),
    ],
    [
      Markup.button.callback(`📊 Bybit · UID · ${diff} USDT`, `topup:quick:${diff}`),
      Markup.button.callback(`⭐ Telegram Stars`, `topup:quick:${diff}`),
    ],
    [Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад к условиям', `shop:buy:${productId}:${safePage}:${qty}`)],
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery().catch(() => {});
};

const showTermsInfo = async (ctx, productId, fromPage = 1, qty = 1, isPreorder = false) => {
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const lang = ctx.user?.language || 'ru';

  const lines = [
    lang === 'en' ? '📄 <b>Rules & Terms of Service</b>' : '📄 <b>Правила и оферта</b>',
    '',
    lang === 'en' ? 'Official service documents:' : 'Официальные документы сервиса:',
  ];

  if (ctx.user?.acceptedToSAt) {
    lines.push('');
    lines.push(
      lang === 'en'
        ? `✅ Terms accepted: ${formatDateTimeMSK(ctx.user.acceptedToSAt)}`
        : `✅ Условия приняты: ${formatDateTimeMSK(ctx.user.acceptedToSAt)}`
    );
  }

  const backAction = isPreorder
    ? `shop:preorder:${productId}:${safePage}:${qty}`
    : `shop:buy:${productId}:${safePage}:${qty}`;

  const buttons = [
    [Markup.button.url(lang === 'en' ? '📄 Privacy Policy' : '📄 Политика конфиденциальности', PRIVACY_URL)],
    [Markup.button.url(lang === 'en' ? '📋 Terms of Service' : '📋 Пользовательское соглашение', AGREEMENT_URL)],
    [Markup.button.callback(lang === 'en' ? '⬅️ Back' : '⬅️ Назад', backAction)],
  ];

  await safeEdit(ctx, lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery().catch(() => {});
};

const showProductDescInfo = async (ctx, productId, fromPage = 1, qty = 1, isPreorder = false) => {
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const product = await Product.findById(productId);
  if (!product) return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });

  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const description = lang === 'en' && product.descriptionEn ? product.descriptionEn : (product.description || 'Описание отсутствует.');
  const deliveryLabel = product.deliveryMethod === 'activation'
    ? (lang === 'en' ? '🔑 Activation on your account' : '🔑 Активация на вашем аккаунте')
    : (lang === 'en' ? '📦 Ready account / key' : '📦 Готовый аккаунт / ключ');

  const isSupplier = product.itemOrigin === 'supplier'
    || Boolean(product.provider && product.provider !== 'local')
    || Boolean(product.supplierProductCode)
    || Boolean(product.sellerId && product.itemOrigin !== 'verified');
  const statusIcon = isSupplier ? '👤' : '🛡';
  const originText = isSupplier
    ? (lang === 'en' ? 'Supplier Product' : 'От поставщика')
    : (lang === 'en' ? 'Verified' : 'Верифицированный');

  const warrantyVal = product.warrantyDays === 0
    ? (lang === 'en' ? 'No warranty' : 'Без гарантии')
    : `${product.warrantyDays ?? 5} дн.`;

  const durationLine = product.subscriptionDays && product.subscriptionDays > 0
    ? `⏳ <b>${lang === 'en' ? 'Duration' : 'Срок подписки'}:</b> ${product.subscriptionDays} дн.\n`
    : '';

  const text =
    `📝 <b>Описание товара: ${escapeHtml(name)}</b>\n\n` +
    `${statusIcon} <b>Статус:</b> ${originText}\n` +
    `🚚 <b>Способ выдачи:</b> ${deliveryLabel}\n` +
    `⏳ <b>Срок гарантии:</b> ${warrantyVal}\n` +
    durationLine +
    `\n<b>Подробная информация:</b>\n` +
    `<blockquote>${escapeHtml(description)}</blockquote>`;

  const backAction = isPreorder
    ? `shop:preorder:${productId}:${safePage}:${qty}`
    : `shop:buy:${productId}:${safePage}:${qty}`;

  const buttons = [
    [Markup.button.callback(lang === 'en' ? '⬅️ Back to agreement' : '⬅️ Назад к соглашению', backAction)],
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  await ctx.answerCbQuery().catch(() => {});
};

const startCheckoutPromo = async (ctx, productId, fromPage = 1, qty = 1) => {
  ctx.session = ctx.session || {};
  ctx.session.userAction = 'enter_promo';
  ctx.session.promoReturnTo = 'checkout';
  ctx.session.promoCheckoutProductId = productId;
  ctx.session.promoCheckoutPage = fromPage;
  ctx.session.promoCheckoutQty = qty;
  ctx.session.promoMsgId = ctx.callbackQuery?.message?.message_id;

  const text =
    `🎟 <b>Ввод промокода</b>\n\n` +
    `Отправьте промокод в чат сообщением, чтобы получить скидку на ваш заказ:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Отмена', 'promo:cancel')],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
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
  const productDisplayName = lang === 'en' && product.nameEn ? product.nameEn : product.name;

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
  const baseEffectivePrice = await getEffectivePrice(product, stock, null);
  const promoDiscount = activePromo
    ? promoService.calculateDiscount(activePromo, baseEffectivePrice * qty, product._id)
    : { valid: false, discountAmount: 0, finalPrice: parseFloat((baseEffectivePrice * qty).toFixed(2)) };
  const totalCost = promoDiscount.valid
    ? promoDiscount.finalPrice
    : parseFloat((baseEffectivePrice * qty).toFixed(2));
  const effectivePrice = Number((totalCost / qty).toFixed(2));

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
  let supplierItems = [];
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
      supplierItems = [];
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

      const hasSeller = Boolean(product.sellerId && product.sellerPrice > 0);
      const payoutPerItem = hasSeller ? parseFloat(product.sellerPrice.toFixed(8)) : 0;
      const sellerTotalPayout = hasSeller ? parseFloat((payoutPerItem * qty).toFixed(8)) : 0;

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
          sellerId: hasSeller ? product.sellerId : null,
          sellerPayout: hasSeller ? sellerTotalPayout : 0,
          status: 'pending',
          keyId: null,
          confirmedAt: null,
          activationResult: null,
          warrantyDays: product.warrantyDays ?? 5,
          subscriptionDays: product.subscriptionDays ?? 30,
        });
        if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(provider)) {
          order.supplierIdempotencyKey = `ord-${order._id}`;
        }
        await order.save(sessionOptions);
        orders.push(order);
        if (['jaha', 'akunding', 'canboso', 'trumpstore'].includes(provider)) {
          supplierItems.push({ order, product, qty });
        }
      } else {
        let remainingOrderPrice = totalCost;
        for (let i = 0; i < qty; i++) {
          const allocatedKey = allocatedKeys[i] || null;
          const isLastOrder = i === qty - 1;
          const orderPrice = isLastOrder
            ? Number(remainingOrderPrice.toFixed(8))
            : Number((totalCost / qty).toFixed(8));
          remainingOrderPrice = Number((remainingOrderPrice - orderPrice).toFixed(8));
          const order = new Order({
            userId: user._id,
            productId: product._id,
            provider,
            price: orderPrice,
            qty: 1,
            costPrice: product.costPrice || 0,
            sellerId: hasSeller ? product.sellerId : null,
            sellerPayout: hasSeller ? payoutPerItem : 0,
            status: product.type === 'gpt_activation' ? 'awaiting_token' : isAutoKeyProduct ? 'completed' : 'pending',
            keyId: allocatedKey ? allocatedKey._id : null,
            confirmedAt: isAutoKeyProduct ? new Date() : null,
            activationResult: isAutoKeyProduct ? 'Ключ выдан автоматически' : null,
            warrantyDays: product.warrantyDays ?? 5,
            subscriptionDays: product.subscriptionDays ?? 30,
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

      if (activePromo?.promoId && promoDiscount?.valid && promoDiscount?.discountAmount > 0) {
        await promoService.consumeDiscountPromo({
          promoId: activePromo.promoId,
          userId: user._id,
          orderId: orders[0]?._id || null,
          discountAmount: promoDiscount.discountAmount,
          session,
        });
      }

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

    if (err.code === 'TRANSACTIONS_REQUIRED' || err.message === 'TRANSACTIONS_REQUIRED') {
      return ctx.answerCbQuery(
        lang === 'en'
          ? 'Payment is temporarily unavailable because the database does not support financial transactions.'
          : 'Оплата временно недоступна: база данных не поддерживает финансовые транзакции.',
        { show_alert: true }
      );
    }
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return ctx.answerCbQuery(t('err_insufficient_balance'), { show_alert: true });
    }
    if (err.message === 'OUT_OF_STOCK') {
      return ctx.answerCbQuery(t('err_out_of_stock'), { show_alert: true });
    }
    if (String(err.message || '').startsWith('PROMO_')) {
      return ctx.answerCbQuery(
        lang === 'en' ? 'The promo code is no longer available. No funds were charged.' : 'Промокод больше нельзя применить. Деньги не списаны.',
        { show_alert: true }
      );
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

  await clearActivePromo(ctx);

  // Уведомление продавца (sellerId и sellerPayout уже сохранены в заказе атомарно)
  if (product.sellerId && product.sellerPrice > 0) {
    try {
      const seller = await Seller.findById(product.sellerId);
      if (seller && seller.isActive) {
        const payoutPerItem = parseFloat(product.sellerPrice.toFixed(8));
        const sellerTotalPayout = parseFloat((payoutPerItem * qty).toFixed(8));
        const summaryOrder = { ...orders[0].toObject(), sellerPayout: sellerTotalPayout, qty };
        await notif.notifySellerNewOrder(seller, summaryOrder, product, ctx.user);
      }
    } catch (sellerErr) {
      const logger = require('../../config/logger');
      logger.error(`[Seller notification] Ошибка отправки уведомления продавцу: ${sellerErr.message}`);
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
  } else if (supplierItems.length > 0) {
    // ─── Автоматический выкуп у внешнего поставщика через API (On-Demand) ───
    const supplierManager = require('../../services/supplierManager.service');
    const supplierItem = supplierItems[0];
    let suppRes;
    try {
      suppRes = await supplierManager.fulfillSupplierOrder(
        supplierItem.product,
        supplierItem.qty,
        ctx.user,
        { orderId: supplierItem.order._id, idempotencyKey: supplierItem.order.supplierIdempotencyKey }
      );
    } catch (supplierErr) {
      suppRes = { success: false, error: supplierErr.message };
    }

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
            supplierOrderId: String(suppRes.orderNumber || suppRes.orderId || ''),
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
    [Markup.button.callback(lang === 'en' ? '🔢 Enter Custom Quantity' : '🔢 Ввести точное число', `shop:preorder_qty_custom:${productId}:${safePage}`)],
    [Markup.button.callback(isRu ? `⏳ Предзаказать ${qty} ${unit} (${totalCost} USDT)` : `⏳ Pre-order ${qty} ${unit} (${totalCost} USDT)`, `shop:preorder:${productId}:${qty}`)],
    [Markup.button.callback(lang === 'en' ? '⬅️ Back to product' : '⬅️ К товару', `shop:product:${productId}:${safePage}`)]
  ];

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
};

const startPreorderCustomQuantity = async (ctx, productId, fromPage = 1) => {
  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const lang = ctx.user?.language || 'ru';

  ctx.session = ctx.session || {};
  ctx.session.userAction = 'enter_shop_quantity';
  ctx.session.isPreorderCustomQty = true;
  ctx.session.qtyCustomProductId = productId;
  ctx.session.qtyCustomPage = safePage;
  ctx.session.qtyCustomMaxStock = 99999;
  ctx.session.qtyCustomMsgId = ctx.callbackQuery?.message?.message_id;

  const text =
    `🔢 <b>Ввод количества для предзаказа</b>\n\n` +
    `Введите необходимое количество сообщением в чат:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'en' ? '❌ Cancel' : '❌ Отмена', `shop:preorder_qty:${productId}:${safePage}:1`)],
  ]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery().catch(() => {});
};

const confirmPreorder = async (ctx, productId, fromPage = 1, qty = 1, tosChecked = false) => {
  qty = parseInt(qty, 10);
  if (isNaN(qty) || qty < 1) qty = 1;

  const product = await Product.findById(productId);
  if (!product || !product.isActive) {
    return ctx.answerCbQuery('❌ Товар не найден', { show_alert: true });
  }

  const safePage = Math.max(1, parseInt(fromPage, 10) || 1);
  const lang = ctx.user?.language || 'ru';
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name;
  const stock = await getStock(product);

  const activePromo = await getActivePromoFromCtx(ctx);
  const baseEffectivePrice = await getEffectivePrice(product, stock, null);
  const baseTotal = parseFloat((baseEffectivePrice * qty).toFixed(2));

  const promoDiscount = activePromo
    ? promoService.calculateDiscount(activePromo, baseTotal, product._id)
    : { valid: false, discountAmount: 0 };

  const totalCost = promoDiscount.valid
    ? promoDiscount.finalPrice
    : baseTotal;
  const totalCostRub = toRub(totalCost);
  const baseTotalRub = toRub(baseTotal);
  const unit = lang === 'en' ? 'pcs' : 'шт.';

  const isRu = lang === 'ru';
  const tariffLine = qty > 1 ? `${qty} ${unit}` : (product.warrantyDays ? `${product.warrantyDays} дн. гарантии` : `1 ${unit}`);

  let priceDisplay = `<b>${totalCost} USDT</b> (~${totalCostRub} ₽)`;
  let promoInfoLine = '';
  if (promoDiscount.valid && totalCost < baseTotal) {
    const promoNote = ` (${activePromo.type === 'percent' ? '-' + activePromo.value + '%' : '-' + activePromo.value + ' USDT'})`;
    promoInfoLine = `\n🏷 <b>Скидка по промокоду:</b> <code>${activePromo.code}</code>${promoNote}`;
    priceDisplay = `<s>${baseTotal} USDT</s> ➔ <b>${totalCost} USDT</b> 🔥${promoNote} (~${totalCostRub} ₽)`;
  }

  const text =
    `<b>Перед оформлением предзаказа</b>\n` +
    `Проверьте условия заказа — это займёт меньше минуты.\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(name)}\n` +
    `📊 <b>Тариф / Количество:</b> ${tariffLine}\n` +
    `💰 <b>Цена:</b> ${priceDisplay}${promoInfoLine}\n\n` +
    `<b>Поставьте галочку, только если вы:</b>\n` +
    `• Прочитали описание товара и согласны с условиями предзаказа.\n` +
    `• Понимаете, что товар будет выдан автоматически, как только пополнится склад.\n` +
    `• Знаете, что можете отменить предзаказ с возвратом средств в любой момент в «Мои заказы».\n\n` +
    `<i>Сумма ${totalCost} USDT будет зарезервирована с вашего баланса.</i>`;

  const checkmarkIcon = tosChecked ? '☑️' : '◻️';
  const toggleNext = tosChecked ? '0' : '1';
  const checkBtnLabel = isRu
    ? `${checkmarkIcon} Я ознакомился со всем и принимаю условия`
    : `${checkmarkIcon} I have read and agree to all terms`;

  const buttons = [
    [Markup.button.callback(isRu ? '📜 Условия покупки и возврата' : '📜 Terms & Refund Policy', `shop:preorder_terms_info:${productId}:${safePage}:${qty}`)],
    [Markup.button.callback(checkBtnLabel, `shop:preorder_tos_toggle:${productId}:${safePage}:${qty}:${toggleNext}`)],
  ];

  if (tosChecked) {
    const payBtnLabel = isRu
      ? `⏳ Зарезервировать и оформить (${totalCost} USDT)`
      : `⏳ Pre-order & Reserve (${totalCost} USDT)`;
    buttons.push([Markup.button.callback(payBtnLabel, `shop:preorder_confirm:${productId}:${qty}`)]);
  }

  buttons.push([Markup.button.callback(isRu ? '📝 Открыть описание товара' : '📝 Open Product Description', `shop:preorder_desc_info:${productId}:${safePage}:${qty}`)]);
  buttons.push([Markup.button.callback(isRu ? '⬅️ К выбору количества' : '⬅️ Back to quantity', `shop:preorder_qty:${productId}:${safePage}:${qty}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  await safeEdit(ctx, text, opts);
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
  const activePromo = await getActivePromoFromCtx(ctx);
  const baseEffectivePrice = await getEffectivePrice(product, stock, null);
  const baseTotal = parseFloat((baseEffectivePrice * qty).toFixed(2));

  const promoDiscount = activePromo
    ? promoService.calculateDiscount(activePromo, baseTotal, product._id)
    : { valid: false, discountAmount: 0 };

  const totalCost = promoDiscount.valid
    ? promoDiscount.finalPrice
    : baseTotal;
  const effectivePricePerItem = Number((totalCost / qty).toFixed(2));
  const totalCostRub = toRub(totalCost);
  const baseTotalRub = toRub(baseTotal);

  if (user.balance < totalCost) {
    return ctx.answerCbQuery(`❌ Недостаточно средств. Нужно: ${totalCost} USDT, ваш баланс: ${user.balance.toFixed(2)} USDT`, { show_alert: true });
  }

  // Атомарное списание с условием в фильтре
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

      const discountPerItem = promoDiscount.valid && promoDiscount.discountAmount > 0
        ? parseFloat((promoDiscount.discountAmount / qty).toFixed(8))
        : 0;

      for (let i = 0; i < qty; i++) {
        const order = new Order({
          userId: user._id,
          productId: product._id,
          price: effectivePricePerItem,
          qty: 1,
          costPrice: (product.costPrice || 0),
          promoDiscount: discountPerItem,
          promoCode: promoDiscount.valid && activePromo ? activePromo.code : null,
          status: 'preorder_pending',
          warrantyDays: product.warrantyDays ?? 5,
          subscriptionDays: product.subscriptionDays ?? 30,
        });
        await order.save(sessionOptions);
        createdOrders.push(order);
      }

      if (activePromo?.promoId && promoDiscount?.valid && promoDiscount?.discountAmount > 0) {
        await promoService.consumeDiscountPromo({
          promoId: activePromo.promoId,
          userId: user._id,
          orderId: createdOrders[0]?._id || null,
          discountAmount: promoDiscount.discountAmount,
          session,
        });
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
    if (preorderUsedSession && preorderDebited) {
      try {
        const restored = await User.findById(user._id);
        if (restored) ctx.user = restored;
      } catch (_) {}
    }
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

  await clearActivePromo(ctx);

  await Waitlist.updateOne(
    { userId: user._id, productId: product._id },
    { $setOnInsert: { userId: user._id, productId: product._id } },
    { upsert: true }
  );

  const isRu = (user.language || 'ru') === 'ru';
  const unit = isRu ? 'шт' : 'pcs';

  const userPriceDisplay = (promoDiscount.valid && totalCost < baseTotal)
    ? `<s>${baseTotal} USDT</s> ➔ <b>${totalCost} USDT</b> 🔥`
    : `<b>${totalCost} USDT</b>`;

  const msgText = isRu
    ? `⏳ <b>Предзаказ на ${qty} ${unit} успешно зарезервирован!</b>\n\n` +
      `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
      `💰 <b>Всего списано:</b> ${userPriceDisplay}\n\n` +
      `<i>Ваши предзаказы поставлены в 1-ю очередь. Бот автоматически пришлёт данные товара вам в личные сообщения при пополнении склада!</i>`
    : `⏳ <b>Pre-order for ${qty} ${unit} successfully placed!</b>\n\n` +
      `📦 <b>Product:</b> ${escapeHtml(product.nameEn || product.name)}\n` +
      `💰 <b>Total charged:</b> ${userPriceDisplay}\n\n` +
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

  const adminPriceDisplay = (promoDiscount.valid && totalCost < baseTotal)
    ? `<s>${baseTotal} USDT</s> ➔ <b>${totalCost} USDT</b> 🔥 (~${totalCostRub} ₽)`
    : `<b>${totalCost} USDT</b> (~${totalCostRub} ₽)`;

  const adminPromoLine = promoDiscount.valid && activePromo
    ? `\n🏷 <b>Промокод:</b> <code>${activePromo.code}</code> (${activePromo.type === 'percent' ? '-' + activePromo.value + '%' : '-' + activePromo.value + ' USDT'})`
    : '';

  notif.sendToAdmins(
    `⏳ <b>Новый Предзаказ!</b>\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n` +
    `📊 <b>Количество:</b> <b>${qty} ${unit}</b>\n` +
    `👤 <b>Покупатель:</b> @${escapeHtml(user.username || user.telegramId)} (ID <code>${user.telegramId}</code>)\n` +
    `💰 <b>Сумма списания:</b> ${adminPriceDisplay}${adminPromoLine}`
  ).catch(() => {});
};

const toggleShopMainOutOfStock = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.shopMainOutOfStockCollapsed = !ctx.session.shopMainOutOfStockCollapsed;
  await ctx.answerCbQuery().catch(() => {});
  await showShopPage(ctx);
};

module.exports = {
  showShopPage,
  showCategory,
  showProduct,
  confirmPurchase,
  processPurchase,
  showQuantitySelect,
  startCustomQuantity,
  handleWaitlist,
  confirmPreorder,
  processPreorder,
  showPreorderQuantitySelect,
  startPreorderCustomQuantity,
  toggleOutOfStock,
  toggleShopMainOutOfStock,
  handlePayStep,
  showTermsInfo,
  showProductDescInfo,
  startCheckoutPromo,
};

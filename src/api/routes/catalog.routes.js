const express = require('express');
const mongoose = require('mongoose');
const Category = require('../../models/Category');
const Product = require('../../models/Product');
const Key = require('../../models/Key');
const { getEffectivePrice } = require('../../services/orderPricing.service');
const { getAvailableStock } = require('../../services/cart.service');
const { resolveProductProvider, isSupplierProvider } = require('../../services/provider.service');
const currencyService = require('../../services/currency.service');
const settingsCache = require('../../services/settingsCache.service');
const logger = require('../../config/logger');

const router = express.Router();

/**
 * Вспомогательная функция для безопасного экранирования регулярных выражений (защита от ReDoS)
 */
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const isInstantProduct = (prod) => Boolean(
  prod && (
    prod.type === 'key' ||
    prod.deliveryMethod === 'ready_account' ||
    prod.provider === 'jaha'
  )
);

const isActiveFlashSale = (prod, now = new Date()) => Boolean(
  prod?.flashSale?.enabled &&
  prod.flashSale.expiresAt &&
  new Date(prod.flashSale.expiresAt) > now &&
  Number(prod.flashSale.discountPercent) > 0
);

/**
 * Batch-подсчёт остатков для массива товаров за 1 Key.aggregate запрос (без N+1).
 */
const getStockMap = async (products) => {
  const stockMap = new Map();
  if (!Array.isArray(products) || products.length === 0) return stockMap;

  const productIds = products.map((p) => p._id);
  const keyRows = await Key.aggregate([
    { $match: { productId: { $in: productIds }, isUsed: false } },
    { $group: { _id: { productId: '$productId', provider: '$provider' }, count: { $sum: 1 } } },
  ]);

  const countsByProd = new Map();
  for (const row of keyRows) {
    const pid = String(row._id.productId);
    const prov = row._id.provider || null;
    if (!countsByProd.has(pid)) countsByProd.set(pid, new Map());
    countsByProd.get(pid).set(prov, row.count);
  }

  for (const prod of products) {
    const pid = String(prod._id);
    const prov = resolveProductProvider(prod);
    const prodKeyMap = countsByProd.get(pid);
    let autoKeys = 0;
    if (prodKeyMap) {
      if (prov === 'local' || prov === 'u1traby') {
        autoKeys = (prodKeyMap.get(prov) || 0) + (prodKeyMap.get(null) || 0);
      } else {
        autoKeys = prodKeyMap.get(prov) || 0;
      }
    }

    let stock = autoKeys;
    if (stock === 0 && (isSupplierProvider(prod.provider) || prod.type === 'manual')) {
      stock = prod.manualStock === -1 ? 9999 : Math.max(0, Number(prod.manualStock) || 0);
    }
    stockMap.set(pid, stock);
  }

  return stockMap;
};

const formatCatalogProduct = (prod, stockCount, effectivePrice) => ({
  id: prod._id,
  name: prod.name,
  nameEn: prod.nameEn || '',
  description: prod.description || '',
  descriptionEn: prod.descriptionEn || '',
  icon: prod.icon || '📦',
  type: prod.type,
  deliveryMethod: prod.deliveryMethod,
  provider: prod.provider || 'local',
  isInstant: isInstantProduct(prod),
  itemOrigin: prod.itemOrigin || 'verified',
  isActive: prod.isActive !== false,
  price: prod.price,
  costPrice: prod.costPrice || 0,
  officialPrice: prod.officialPrice || 0,
  officialDiscountPercent: prod.officialDiscountPercent || 0,
  effectivePrice,
  stockCount,
  inStock: stockCount > 0,
  warrantyDays: prod.warrantyDays ?? 5,
  subscriptionDays: prod.subscriptionDays ?? 30,
  category: prod.categoryId
    ? { id: prod.categoryId._id, name: prod.categoryId.name, icon: prod.categoryId.icon }
    : null,
  flashSale: prod.flashSale?.enabled && prod.flashSale.expiresAt && new Date(prod.flashSale.expiresAt) > new Date()
    ? {
        enabled: true,
        discountPercent: prod.flashSale.discountPercent,
        expiresAt: prod.flashSale.expiresAt,
      }
    : null,
});

/**
 * 0. Метаданные витрины (живой курс, режим ТО сайта)
 * GET /api/v1/catalog/meta
 */
router.get('/meta', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    return res.json({
      success: true,
      currentRateRub: currencyService.getRate(settings),
      updatedAt: currencyService.getUpdatedAt(),
      webMaintenanceMode: Boolean(settings?.webMaintenanceMode),
    });
  } catch (err) {
    logger.error(`[CatalogAPI] Ошибка получения метаданных: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось загрузить метаданные' });
  }
});

/**
 * 1. Получение списка активных категорий с расширенной статистикой (3 batch-запроса, без N+1)
 * GET /api/v1/catalog/categories
 */
router.get('/categories', async (req, res) => {
  try {
    const [categories, activeProducts] = await Promise.all([
      Category.find({ isActive: true }).sort({ sortOrder: 1, _id: 1 }).lean(),
      Product.find({ isActive: true })
        .sort({ sortOrder: 1, price: 1, _id: 1 })
        .select('name categoryId price costPrice type deliveryMethod provider manualStock flashSale lastSoldAt createdAt sortOrder')
        .lean(),
    ]);

    const stockMap = await getStockMap(activeProducts);
    const now = new Date();
    const recentThresholdMs = now.getTime() - 14 * 24 * 60 * 60 * 1000;

    const statsByCat = new Map();
    for (const cat of categories) {
      statsByCat.set(String(cat._id), {
        productCount: 0,
        inStockCount: 0,
        minPrice: null,
        maxPrice: null,
        hasFlashSale: false,
        hasInstant: false,
        recentSoldCount: 0,
        previewTitles: [],
      });
    }

    await Promise.all(
      activeProducts.map(async (prod) => {
        const cid = prod.categoryId ? String(prod.categoryId) : null;
        const stat = cid ? statsByCat.get(cid) : null;
        if (!stat) return;

        const stockCount = stockMap.get(String(prod._id)) ?? 0;
        const effectivePrice = await getEffectivePrice(prod, stockCount, null);

        stat.productCount += 1;
        if (stockCount > 0) stat.inStockCount += 1;
        if (stat.minPrice === null || effectivePrice < stat.minPrice) stat.minPrice = effectivePrice;
        if (stat.maxPrice === null || effectivePrice > stat.maxPrice) stat.maxPrice = effectivePrice;
        if (isActiveFlashSale(prod, now)) stat.hasFlashSale = true;
        if (isInstantProduct(prod)) stat.hasInstant = true;

        const soldTime = prod.lastSoldAt ? new Date(prod.lastSoldAt).getTime() : 0;
        const createdTime = prod.createdAt ? new Date(prod.createdAt).getTime() : 0;
        if (soldTime >= recentThresholdMs && soldTime > createdTime + 60000) {
          stat.recentSoldCount += 1;
        }
      })
    );

    // Сохраняем исходный порядок сортировки для previewTitles (in-stock в приоритете, затем остальные)
    for (const prod of activeProducts) {
      const cid = prod.categoryId ? String(prod.categoryId) : null;
      const stat = cid ? statsByCat.get(cid) : null;
      if (!stat || stat.previewTitles.length >= 3) continue;
      const stockCount = stockMap.get(String(prod._id)) ?? 0;
      if (stockCount > 0) {
        const title = String(prod.name || '').trim().slice(0, 42);
        if (title && !stat.previewTitles.includes(title)) stat.previewTitles.push(title);
      }
    }
    for (const prod of activeProducts) {
      const cid = prod.categoryId ? String(prod.categoryId) : null;
      const stat = cid ? statsByCat.get(cid) : null;
      if (!stat || stat.previewTitles.length >= 3) continue;
      const title = String(prod.name || '').trim().slice(0, 42);
      if (title && !stat.previewTitles.includes(title)) stat.previewTitles.push(title);
    }

    const categoriesWithStats = categories.map((cat) => {
      const stat = statsByCat.get(String(cat._id));
      const popularScore =
        stat.inStockCount * 10 +
        stat.productCount * 2 +
        (stat.hasFlashSale ? 5 : 0) +
        stat.recentSoldCount * 3;

      return {
        id: cat._id,
        name: cat.name,
        icon: cat.icon || '📁',
        sortOrder: cat.sortOrder || 0,
        productCount: stat.productCount,
        inStockCount: stat.inStockCount,
        minPrice: stat.minPrice,
        maxPrice: stat.maxPrice,
        hasFlashSale: stat.hasFlashSale,
        hasInstant: stat.hasInstant,
        popularScore,
        previewTitles: stat.previewTitles,
      };
    });

    return res.json({
      success: true,
      categories: categoriesWithStats,
      totalProducts: activeProducts.length,
    });
  } catch (err) {
    logger.error(`[CatalogAPI] Ошибка получения категорий: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось загрузить категории' });
  }
});

/**
 * 2. Получение списка товаров с фильтрацией, пагинацией и ценами
 * GET /api/v1/catalog/products
 */
router.get('/products', async (req, res) => {
  try {
    const {
      categoryId,
      search,
      type,
      origin,
      inStock,
      minPrice,
      maxPrice,
      instantOnly,
      flashOnly,
      sort,
      page = 1,
      limit = 24,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 24));
    const skip = (pageNum - 1) * limitNum;
    const onlyInStock = inStock === 'true' || inStock === '1' || inStock === true;
    const onlyInstant = instantOnly === 'true' || instantOnly === '1' || instantOnly === true;
    const onlyFlash = flashOnly === 'true' || flashOnly === '1' || flashOnly === true;

    const minPriceNum = minPrice !== undefined && minPrice !== '' && Number.isFinite(Number(minPrice))
      ? Number(minPrice)
      : null;
    const maxPriceNum = maxPrice !== undefined && maxPrice !== '' && Number.isFinite(Number(maxPrice))
      ? Number(maxPrice)
      : null;

    // Базовый фильтр: только активные товары
    const filter = { isActive: true };
    const andConditions = [];

    // Фильтр по категории
    const hasCategoryFilter = Boolean(categoryId && categoryId !== 'all');
    if (hasCategoryFilter) {
      if (!mongoose.isValidObjectId(categoryId)) {
        return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
      }
      filter.categoryId = new mongoose.Types.ObjectId(categoryId);
    }

    // Фильтр по типу
    if (type && ['key', 'gpt_activation', 'manual'].includes(type)) {
      filter.type = type;
    }

    // Фильтр по происхождению
    if (origin && ['verified', 'supplier'].includes(origin)) {
      filter.itemOrigin = origin;
    }

    // Мгновенная выдача
    if (onlyInstant) {
      andConditions.push({
        $or: [
          { type: 'key' },
          { deliveryMethod: 'ready_account' },
          { provider: 'jaha' },
        ],
      });
    }

    // Активный Flash Sale
    if (onlyFlash) {
      filter['flashSale.enabled'] = true;
      filter['flashSale.discountPercent'] = { $gt: 0 };
      filter['flashSale.expiresAt'] = { $gt: new Date() };
    }

    // Текстовый поиск с экранированием ReDoS
    if (search && typeof search === 'string' && search.trim().length > 0) {
      const sanitized = escapeRegex(search.trim().slice(0, 50));
      andConditions.push({
        $or: [
          { name: { $regex: sanitized, $options: 'i' } },
          { nameEn: { $regex: sanitized, $options: 'i' } },
          { description: { $regex: sanitized, $options: 'i' } },
          { descriptionEn: { $regex: sanitized, $options: 'i' } },
        ],
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    // Сортировка: при categoryId и дефолтной сортировке как в боте { sortOrder: 1, price: 1, _id: 1 }
    const effectiveSort = sort || 'sortOrder';
    let sortOptions = hasCategoryFilter ? { sortOrder: 1, price: 1, _id: 1 } : { sortOrder: 1, _id: 1 };
    if (effectiveSort === 'price_asc') sortOptions = { price: 1, _id: 1 };
    else if (effectiveSort === 'price_desc') sortOptions = { price: -1, _id: 1 };
    else if (effectiveSort === 'newest') sortOptions = { createdAt: -1, _id: 1 };
    else if (effectiveSort === 'popular') sortOptions = { lastSoldAt: -1, _id: 1 };

    const settings = await settingsCache.getSettings();
    const currentRateRub = currencyService.getRate(settings);

    const needsInMemoryFilter =
      onlyInStock ||
      minPriceNum !== null ||
      maxPriceNum !== null ||
      effectiveSort === 'price_asc' ||
      effectiveSort === 'price_desc';

    let pagedProducts = [];
    let totalCount = 0;

    if (needsInMemoryFilter) {
      const allProducts = await Product.find(filter)
        .populate('categoryId', 'name icon')
        .sort(sortOptions)
        .skip(0)
        .limit(5000)
        .lean();

      const stockMap = await getStockMap(allProducts);

      const enriched = await Promise.all(
        allProducts.map(async (prod) => {
          const stockCount = stockMap.get(String(prod._id)) ?? 0;
          const effectivePrice = await getEffectivePrice(prod, stockCount, null);
          return { prod, stockCount, effectivePrice };
        })
      );

      const filtered = enriched.filter(({ stockCount, effectivePrice }) => {
        if (onlyInStock && stockCount <= 0) return false;
        if (minPriceNum !== null && effectivePrice < minPriceNum) return false;
        if (maxPriceNum !== null && effectivePrice > maxPriceNum) return false;
        return true;
      });

      if (effectiveSort === 'price_asc') {
        filtered.sort((a, b) => a.effectivePrice - b.effectivePrice);
      } else if (effectiveSort === 'price_desc') {
        filtered.sort((a, b) => b.effectivePrice - a.effectivePrice);
      }

      totalCount = filtered.length;
      const sliced = filtered.slice(skip, skip + limitNum);
      pagedProducts = sliced.map(({ prod, stockCount, effectivePrice }) =>
        formatCatalogProduct(prod, stockCount, effectivePrice)
      );
    } else {
      const [products, count] = await Promise.all([
        Product.find(filter)
          .populate('categoryId', 'name icon')
          .sort(sortOptions)
          .skip(skip)
          .limit(limitNum)
          .lean(),
        Product.countDocuments(filter),
      ]);
      totalCount = count;

      const stockMap = await getStockMap(products);

      pagedProducts = await Promise.all(
        products.map(async (prod) => {
          const stockCount = stockMap.get(String(prod._id)) ?? 0;
          const effectivePrice = await getEffectivePrice(prod, stockCount, null);
          return formatCatalogProduct(prod, stockCount, effectivePrice);
        })
      );
    }

    return res.json({
      success: true,
      products: pagedProducts,
      currentRateRub,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[CatalogAPI] Ошибка получения списка товаров: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось загрузить товары' });
  }
});

/**
 * 3. Детальная информация о конкретном товаре
 * GET /api/v1/catalog/products/:id
 */
router.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const prod = await Product.findOne({ _id: id, isActive: true })
      .populate('categoryId', 'name icon')
      .lean();

    if (!prod) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND', message: 'Товар не найден или скрыт' });
    }

    const settings = await settingsCache.getSettings();
    const stockCount = await getAvailableStock(prod);
    const effectivePrice = await getEffectivePrice(prod, stockCount, null);

    return res.json({
      success: true,
      currentRateRub: currencyService.getRate(settings),
      product: formatCatalogProduct(prod, stockCount, effectivePrice),
    });
  } catch (err) {
    logger.error(`[CatalogAPI] Ошибка получения товара ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Внутренняя ошибка сервера' });
  }
});

module.exports = { catalogRouter: router };

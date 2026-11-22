const express = require('express');
const mongoose = require('mongoose');
const Category = require('../../models/Category');
const Product = require('../../models/Product');
const { getEffectivePrice } = require('../../services/orderPricing.service');
const { getAvailableStock } = require('../../services/cart.service');
const logger = require('../../config/logger');

const router = express.Router();

/**
 * Вспомогательная функция для безопасного экранирования регулярных выражений (защита от ReDoS)
 */
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * 1. Получение списка активных категорий с количеством товаров
 * GET /api/v1/catalog/categories
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, _id: 1 })
      .lean();

    // Быстрая агрегация количества активных товаров по категориям за 1 запрос
    const productCounts = await Product.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map();
    let totalProducts = 0;
    for (const item of productCounts) {
      if (item._id) {
        countMap.set(item._id.toString(), item.count);
      }
      totalProducts += item.count;
    }

    const categoriesWithCount = categories.map((cat) => ({
      id: cat._id,
      name: cat.name,
      icon: cat.icon || '📁',
      sortOrder: cat.sortOrder || 0,
      productCount: countMap.get(cat._id.toString()) || 0,
    }));

    return res.json({
      success: true,
      categories: categoriesWithCount,
      totalProducts,
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
      sort = 'sortOrder',
      page = 1,
      limit = 24,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
    const skip = (pageNum - 1) * limitNum;

    // Базовый фильтр: только активные товары
    const filter = { isActive: true };

    // Фильтр по категории
    if (categoryId && categoryId !== 'all') {
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

    // Текстовый поиск с экранированием ReDoS
    if (search && typeof search === 'string' && search.trim().length > 0) {
      const sanitized = escapeRegex(search.trim().slice(0, 50));
      filter.$or = [
        { name: { $regex: sanitized, $options: 'i' } },
        { nameEn: { $regex: sanitized, $options: 'i' } },
        { description: { $regex: sanitized, $options: 'i' } },
      ];
    }

    // Сортировка
    let sortOptions = { sortOrder: 1, _id: 1 };
    if (sort === 'price_asc') sortOptions = { price: 1 };
    else if (sort === 'price_desc') sortOptions = { price: -1 };
    else if (sort === 'newest') sortOptions = { createdAt: -1 };
    else if (sort === 'popular') sortOptions = { lastSoldAt: -1 };

    const [products, totalCount] = await Promise.all([
      Product.find(filter)
        .populate('categoryId', 'name icon')
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(filter),
    ]);

    // Обогащаем товары актуальными остатками и эффективными ценами (smart-pricing / markdown / flash sale)
    const enrichedProducts = await Promise.all(
      products.map(async (prod) => {
        const stockCount = await getAvailableStock(prod);
        const effectivePrice = await getEffectivePrice(prod, stockCount, null);

        // Безопасная карточка товара без внутренних служебных полей
        return {
          id: prod._id,
          name: prod.name,
          nameEn: prod.nameEn || '',
          description: prod.description || '',
          descriptionEn: prod.descriptionEn || '',
          icon: prod.icon || '📦',
          type: prod.type,
          deliveryMethod: prod.deliveryMethod,
          itemOrigin: prod.itemOrigin || 'verified',
          price: prod.price,
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
        };
      })
    );

    return res.json({
      success: true,
      products: enrichedProducts,
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

    const stockCount = await getAvailableStock(prod);
    const effectivePrice = await getEffectivePrice(prod, stockCount, null);

    return res.json({
      success: true,
      product: {
        id: prod._id,
        name: prod.name,
        nameEn: prod.nameEn || '',
        description: prod.description || '',
        descriptionEn: prod.descriptionEn || '',
        icon: prod.icon || '📦',
        type: prod.type,
        deliveryMethod: prod.deliveryMethod,
        itemOrigin: prod.itemOrigin || 'verified',
        price: prod.price,
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
      },
    });
  } catch (err) {
    logger.error(`[CatalogAPI] Ошибка получения товара ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Внутренняя ошибка сервера' });
  }
});

module.exports = { catalogRouter: router };

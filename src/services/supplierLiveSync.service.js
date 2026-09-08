const SupplierConfig = require('../models/SupplierConfig');
const Product = require('../models/Product');
const Category = require('../models/Category');
const logger = require('../config/logger');
const jahaAdapter = require('./suppliers/jaha.adapter');
const akundingAdapter = require('./suppliers/akunding.adapter');
const canbosoAdapter = require('./suppliers/canboso.adapter');
const trumpstoreAdapter = require('./suppliers/trumpstore.adapter');

const ADAPTERS = {
  jaha: jahaAdapter,
  akunding: akundingAdapter,
  canboso: canbosoAdapter,
  trumpstore: trumpstoreAdapter,
};

/**
 * Синхронизация остатков и цен со складом конкретного поставщика
 */
const syncSupplierStock = async (supplierId) => {
  const config = await SupplierConfig.findOne({ supplierId, isEnabled: true });
  if (!config || !config.apiKey) {
    return { success: false, error: 'API-ключ не настроен' };
  }

  const adapter = ADAPTERS[supplierId];
  if (!adapter) return { success: false, error: 'Адаптер не найден' };

  // 1. Получаем актуальный баланс
  const balRes = await adapter.getBalance(config.apiKey);
  if (balRes.success) {
    config.cachedBalance = balRes.balance;
  }

  // 2. Получаем актуальный каталог и остатки
  const prodRes = await adapter.getProducts(config.apiKey, { currentOnly: config.currentOnly !== false });
  if (!prodRes.success || !prodRes.products) {
    return { success: false, error: prodRes.error || 'Не удалось получить остатки' };
  }

  let updatedCount = 0;
  const supplierCodesMap = new Map();

  for (const item of prodRes.products) {
    const code = String(item.productCode);
    const stockCount = typeof item.stock === 'number' ? item.stock : (item.stock ? 99 : 0);
    supplierCodesMap.set(code, {
      stock: stockCount,
      costPrice: item.priceUsdt,
      warrantyDays: item.warrantyDays,
      subscriptionDays: item.subscriptionDays,
    });
  }

  // 3. Обновляем все товары этого поставщика в нашей базе
  const dbProducts = await Product.find({ provider: supplierId }).select('name supplierProductCode manualStock costPrice price officialPrice officialDiscountPercent').lean();
  const pricingService = require('./pricing.service');
  const geminiPricing = require('./geminiPricing.service');
  const isGeminiMode = config.smartPricingPreset === 'gemini_ai';
  const bulkOps = [];

  const isOnlyInStock = config.currentOnly !== false;

  for (const p of dbProducts) {
    if (!p.supplierProductCode) continue;

    const liveData = supplierCodesMap.get(String(p.supplierProductCode));
    if (liveData) {
      const newStock = liveData.stock;
      const newCost = liveData.costPrice && liveData.costPrice > 0 ? liveData.costPrice : p.costPrice;
      let newRetail = liveData.costPrice && liveData.costPrice > 0
        ? pricingService.calculateRetailPrice(liveData.costPrice, config)
        : p.price;
      let officialPrice = p.officialPrice || 0;
      let officialDiscountPercent = p.officialDiscountPercent || 0;

      if (isGeminiMode && liveData.costPrice && liveData.costPrice > 0) {
        const evalRes = geminiPricing.calculateFallbackPrice(p.name, liveData.costPrice);
        newRetail = evalRes.recommendedPrice;
        officialPrice = evalRes.officialPrice;
        officialDiscountPercent = evalRes.discountPercent;
      }

      const newActive = isOnlyInStock ? newStock > 0 : true;

      bulkOps.push({
        updateOne: {
          filter: { _id: p._id },
          update: {
            $set: {
              manualStock: newStock,
              costPrice: newCost,
              price: newRetail,
              officialPrice,
              officialDiscountPercent,
              isActive: newActive,
              itemOrigin: 'supplier',
              ...(typeof liveData.warrantyDays === 'number' ? { warrantyDays: liveData.warrantyDays } : {}),
              ...(typeof liveData.subscriptionDays === 'number' ? { subscriptionDays: liveData.subscriptionDays } : {}),
            },
          },
        },
      });
      updatedCount++;
    } else {
      if (p.manualStock !== 0 || (isOnlyInStock && p.isActive)) {
        bulkOps.push({
          updateOne: {
            filter: { _id: p._id },
            update: {
              $set: {
                manualStock: 0,
                ...(isOnlyInStock ? { isActive: false } : {}),
              },
            },
          },
        });
        updatedCount++;
      }
    }
  }

  let newImportedCount = 0;

  if (config.autoImportNewProducts !== false) {
    const existingCodesSet = new Set(dbProducts.map((p) => String(p.supplierProductCode)));
    const newItems = prodRes.products.filter((item) => item.productCode && !existingCodesSet.has(String(item.productCode)));

    if (newItems.length > 0) {
      const existingCategories = await Category.find().lean();
      const categoryCache = new Map();
      for (const cat of existingCategories) {
        categoryCache.set(cat.name.toLowerCase().trim(), cat._id);
      }

      for (const item of newItems) {
        const catName = (item.category || 'Внешние товары').trim();
        const catKey = catName.toLowerCase();
        let categoryId = categoryCache.get(catKey);

        if (!categoryId) {
          const newCat = await Category.create({
            name: catName,
            nameEn: catName,
            icon: item.icon || '📦',
            isActive: true,
            sortOrder: 10,
          });
          categoryId = newCat._id;
          categoryCache.set(catKey, categoryId);
        }

        const wholesaleCost = parseFloat(item.priceUsdt || 0);
        let retailPrice = pricingService.calculateRetailPrice(wholesaleCost, config);
        let officialPrice = 0;
        let officialDiscountPercent = 0;

        if (isGeminiMode && wholesaleCost > 0) {
          const evalRes = geminiPricing.calculateFallbackPrice(item.name, wholesaleCost);
          retailPrice = evalRes.recommendedPrice;
          officialPrice = evalRes.officialPrice || 0;
          officialDiscountPercent = evalRes.discountPercent || 0;
        }

        const codeStr = String(item.productCode);
        const stockCount = typeof item.stock === 'number' ? item.stock : (item.stock ? 99 : 0);
        const isActive = isOnlyInStock ? stockCount > 0 : true;

        bulkOps.push({
          updateOne: {
            filter: {
              provider: supplierId,
              supplierProductCode: codeStr,
            },
            update: {
              $set: {
                name: item.name,
                ...(item.nameEn ? { nameEn: item.nameEn } : {}),
                ...(item.description ? { description: item.description } : {}),
                ...(item.descriptionEn ? { descriptionEn: item.descriptionEn } : {}),
                costPrice: wholesaleCost,
                price: retailPrice,
                officialPrice,
                officialDiscountPercent,
                manualStock: stockCount,
                categoryId,
                icon: item.icon || '📦',
                type: 'manual',
                deliveryMethod: 'ready_account',
                isActive,
                warrantyDays: typeof item.warrantyDays === 'number' ? item.warrantyDays : 5,
                subscriptionDays: typeof item.subscriptionDays === 'number' ? item.subscriptionDays : 30,
                itemOrigin: 'supplier',
              },
            },
            upsert: true,
          },
        });
        newImportedCount++;
      }
    }
  }

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps, { ordered: false });
  }

  config.lastSyncAt = new Date();
  await config.save();

  logger.info(`[SupplierSync] ${supplierId}: обновлено ${updatedCount} товаров, авто-импортировано новинок: ${newImportedCount}`);

  return {
    success: true,
    supplierId,
    balance: config.cachedBalance,
    updatedCount,
    newImportedCount,
  };
};

/**
 * Синхронизация всех активных поставщиков
 */
const syncAllSuppliers = async () => {
  const configs = await SupplierConfig.find({ isEnabled: true, apiKey: { $ne: null } });
  const results = [];

  for (const cfg of configs) {
    if (cfg.apiKey) {
      const res = await syncSupplierStock(cfg.supplierId);
      results.push(res);
    }
  }

  return results;
};

module.exports = {
  syncSupplierStock,
  syncAllSuppliers,
};

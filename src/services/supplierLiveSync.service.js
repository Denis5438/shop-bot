const SupplierConfig = require('../models/SupplierConfig');
const Product = require('../models/Product');
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
    });
  }

  // 3. Обновляем все товары этого поставщика в нашей базе
  const dbProducts = await Product.find({ provider: supplierId }).select('supplierProductCode manualStock costPrice price').lean();
  const pricingService = require('./pricing.service');
  const bulkOps = [];

  const isOnlyInStock = config.currentOnly !== false;

  for (const p of dbProducts) {
    if (!p.supplierProductCode) continue;

    const liveData = supplierCodesMap.get(String(p.supplierProductCode));
    if (liveData) {
      const newStock = liveData.stock;
      const newCost = liveData.costPrice && liveData.costPrice > 0 ? liveData.costPrice : p.costPrice;
      const newRetail = liveData.costPrice && liveData.costPrice > 0
        ? pricingService.calculateRetailPrice(liveData.costPrice, config)
        : p.price;
      const newActive = isOnlyInStock ? newStock > 0 : true;

      bulkOps.push({
        updateOne: {
          filter: { _id: p._id },
          update: {
            $set: {
              manualStock: newStock,
              costPrice: newCost,
              price: newRetail,
              isActive: newActive,
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

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps, { ordered: false });
  }

  config.lastSyncAt = new Date();
  await config.save();

  return {
    success: true,
    supplierId,
    balance: config.cachedBalance,
    updatedCount,
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

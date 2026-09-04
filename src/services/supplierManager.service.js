const SupplierConfig = require('../models/SupplierConfig');
const Product = require('../models/Product');
const Category = require('../models/Category');

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

const SUPPLIER_META = {
  jaha: { title: '🤖 Jaha Digital API', defaultMargin: 30 },
  akunding: { title: '🛒 Akunding Store API', defaultMargin: 30 },
  canboso: { title: '🌐 Canboso API', defaultMargin: 30 },
  trumpstore: { title: '🏛️ Trump Store API', defaultMargin: 30 },
};

/**
 * Инициализация записей поставщиков в БД
 */
const initSuppliers = async () => {
  const knownIds = Object.keys(SUPPLIER_META);
  for (const [sId, meta] of Object.entries(SUPPLIER_META)) {
    const exists = await SupplierConfig.findOne({ supplierId: sId });
    if (!exists) {
      await SupplierConfig.create({
        supplierId: sId,
        title: meta.title,
        marginPercent: meta.defaultMargin,
        marginFixed: 0,
      });
    }
  }
  // Удаляем записи поставщиков, которых больше нет в коде
  await SupplierConfig.deleteMany({ supplierId: { $nin: knownIds } }).catch(() => {});
};

/**
 * Получение списка всех поставщиков со статусами
 */
const getAllSuppliers = async () => {
  await initSuppliers();
  return SupplierConfig.find({ supplierId: { $in: Object.keys(SUPPLIER_META) } }).lean();
};

/**
 * Сохранение API-ключа и наценки поставщика
 */
const saveSupplierKey = async (supplierId, apiKey, marginPercent = 30, marginFixed = 0) => {
  const cleanKey = String(apiKey || '').trim();
  const adapter = ADAPTERS[supplierId];
  let balance = 0;

  if (cleanKey && adapter) {
    const balRes = await adapter.getBalance(cleanKey);
    if (balRes.success) {
      balance = balRes.balance;
    }
  }

  const updated = await SupplierConfig.findOneAndUpdate(
    { supplierId },
    {
      apiKey: cleanKey,
      marginPercent: parseFloat(marginPercent) || 30,
      marginFixed: parseFloat(marginFixed) || 0,
      cachedBalance: balance,
      lastSyncAt: new Date(),
      isEnabled: Boolean(cleanKey),
    },
    { new: true, upsert: true }
  );

  return updated;
};

/**
 * Проверка баланса поставщика
 */
const refreshSupplierBalance = async (supplierId) => {
  const config = await SupplierConfig.findOne({ supplierId });
  if (!config || !config.apiKey) return { success: false, error: 'Ключ не задан' };

  const adapter = ADAPTERS[supplierId];
  if (!adapter) return { success: false, error: 'Адаптер не найден' };

  const res = await adapter.getBalance(config.apiKey);
  if (res.success) {
    config.cachedBalance = res.balance;
    config.lastSyncAt = new Date();
    await config.save();
  }
  return res;
};

/**
 * Импорт всех товаров от поставщика в 1 клик с автоматической наценкой
 */
const importSupplierCatalog = async (supplierId, options = {}) => {
  const config = await SupplierConfig.findOne({ supplierId });
  if (!config || !config.apiKey) {
    return { success: false, error: 'Сначала укажите API-ключ поставщика в настройках!' };
  }

  const adapter = ADAPTERS[supplierId];
  if (!adapter) return { success: false, error: 'Адаптер не поддерживается' };

  const catRes = await adapter.getProducts(config.apiKey, { currentOnly: config.currentOnly !== false });
  if (!catRes.success || !catRes.products || catRes.products.length === 0) {
    return { success: false, error: catRes.error || 'У поставщика нет доступных товаров.' };
  }

  const marginPercent = options.marginPercent !== undefined ? parseFloat(options.marginPercent) : config.marginPercent;
  const marginFixed = options.marginFixed !== undefined ? parseFloat(options.marginFixed) : config.marginFixed;

  const isOnlyInStock = config.currentOnly !== false;

  // Если включен режим "Только в наличии" — импортируем только товары со stock > 0
  const productsToProcess = isOnlyInStock
    ? catRes.products.filter((p) => (p.stock || 0) > 0)
    : catRes.products;

  // Если режим "Только в наличии" — деактивируем в базе все товары поставщика с 0 остатком
  if (isOnlyInStock) {
    await Product.updateMany(
      { provider: supplierId, manualStock: { $lte: 0 } },
      { $set: { isActive: false } }
    );
  } else {
    // В режиме "Все товары" восстанавливаем видимость всех товаров поставщика
    await Product.updateMany(
      { provider: supplierId },
      { $set: { isActive: true } }
    );
  }

  // 1. Предзагрузка всех существующих категорий в Map
  const existingCategories = await Category.find().lean();
  const categoryCache = new Map();
  for (const cat of existingCategories) {
    categoryCache.set(cat.name.toLowerCase().trim(), cat._id);
  }

  // 2. Предзагрузка всех существующих товаров данного поставщика
  const existingProducts = await Product.find({ provider: supplierId })
    .select('supplierProductCode _id')
    .lean();
  const existingCodesSet = new Set(
    existingProducts.map((p) => String(p.supplierProductCode))
  );

  const pricingService = require('./pricing.service');
  const bulkOps = [];
  let importedCount = 0;
  let updatedCount = 0;

  for (const item of productsToProcess) {
    if (!item.productCode || !item.name) continue;

    // Сопоставление / создание категории
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

    // Расчёт розничной цены с учётом умной наценки
    const wholesaleCost = parseFloat(item.priceUsdt || 0);
    const retailPrice = pricingService.calculateRetailPrice(wholesaleCost, config);
    const codeStr = String(item.productCode);

    const isExisting = existingCodesSet.has(codeStr);
    if (isExisting) {
      updatedCount++;
    } else {
      importedCount++;
      existingCodesSet.add(codeStr);
    }

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
            manualStock: item.stock ?? 0,
            categoryId: categoryId,
            icon: item.icon || '📦',
            type: 'manual',
            deliveryMethod: 'ready_account',
            isActive: true,
            warrantyDays: 5,
          },
        },
        upsert: true,
      },
    });
  }

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps, { ordered: false });
  }

  config.lastSyncAt = new Date();
  await config.save();

  return {
    success: true,
    totalReceived: catRes.products.length,
    importedCount,
    updatedCount,
  };
};

/**
 * Моментальный выкуп и доставка товара у поставщика при заказе
 */
const fulfillSupplierOrder = async (product, quantity, user, options = {}) => {
  const supplierId = product.provider;
  const config = await SupplierConfig.findOne({ supplierId, isEnabled: true });

  if (!config || !config.apiKey) {
    return { success: false, error: 'Поставщик временно недоступен (API-ключ не настроен)' };
  }

  const adapter = ADAPTERS[supplierId];
  if (!adapter) {
    return { success: false, error: 'Адаптер поставщика не найден' };
  }

  // The key must survive timeouts and manual/cron retries. Callers create it
  // from the persisted local order id; never derive it from the current time.
  const idempotencyKey = options.idempotencyKey || (options.orderId ? `ord-${options.orderId}` : null);
  if (!idempotencyKey) {
    return { success: false, error: 'Не задан постоянный idempotency key заказа' };
  }
  const res = await adapter.createOrder(config.apiKey, {
    productCode: product.supplierProductCode,
    quantity: quantity,
    maxUnitPrice: (product.costPrice || product.price) * 1.5,
    idempotencyKey,
    externalOrderId: options.externalOrderId || idempotencyKey,
  });

  return res;
};

module.exports = {
  initSuppliers,
  getAllSuppliers,
  saveSupplierKey,
  refreshSupplierBalance,
  importSupplierCatalog,
  fulfillSupplierOrder,
};

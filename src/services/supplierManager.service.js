const SupplierConfig = require('../models/SupplierConfig');
const Product = require('../models/Product');
const Category = require('../models/Category');

const jahaAdapter = require('./suppliers/jaha.adapter');
const akundingAdapter = require('./suppliers/akunding.adapter');
const canbosoAdapter = require('./suppliers/canboso.adapter');

const ADAPTERS = {
  jaha: jahaAdapter,
  akunding: akundingAdapter,
  canboso: canbosoAdapter,
};

const SUPPLIER_META = {
  jaha: { title: '🤖 Jaha Digital API', defaultMargin: 30 },
  akunding: { title: '🛒 Akunding Store API', defaultMargin: 30 },
  canboso: { title: '🌐 Canboso API', defaultMargin: 30 },
};

/**
 * Инициализация записей поставщиков в БД
 */
const initSuppliers = async () => {
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
};

/**
 * Получение списка всех поставщиков со статусами
 */
const getAllSuppliers = async () => {
  await initSuppliers();
  return SupplierConfig.find().lean();
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

  const catRes = await adapter.getProducts(config.apiKey);
  if (!catRes.success || !catRes.products || catRes.products.length === 0) {
    return { success: false, error: catRes.error || 'У поставщика нет доступных товаров.' };
  }

  const marginPercent = options.marginPercent !== undefined ? parseFloat(options.marginPercent) : config.marginPercent;
  const marginFixed = options.marginFixed !== undefined ? parseFloat(options.marginFixed) : config.marginFixed;

  let importedCount = 0;
  let updatedCount = 0;

  // Кеш категорий для быстрого сопоставления
  const categoryCache = new Map();

  for (const item of catRes.products) {
    if (!item.productCode || !item.name) continue;

    // 1. Поиск или создание подходящей категории в нашем магазине
    const catName = (item.category || 'Внешние товары').trim();
    let categoryId = categoryCache.get(catName);

    if (!categoryId) {
      let category = await Category.findOne({ name: catName });
      if (!category) {
        category = await Category.create({
          name: catName,
          nameEn: catName,
          icon: item.icon || '📦',
          isActive: true,
          sortOrder: 10,
        });
      }
      categoryId = category._id;
      categoryCache.set(catName, categoryId);
    }

    // 2. Расчёт розничной цены продажи с учётом вашей маржи
    const wholesaleCost = parseFloat(item.priceUsdt || 0);
    let retailPrice = wholesaleCost * (1 + marginPercent / 100) + marginFixed;
    retailPrice = Math.max(0.5, Math.round(retailPrice * 100) / 100);

    // 3. Создание или обновление товара в базе данных
    const existing = await Product.findOne({
      provider: supplierId,
      supplierProductCode: String(item.productCode),
    });

    if (existing) {
      existing.name = item.name;
      if (item.nameEn) existing.nameEn = item.nameEn;
      if (item.description) existing.description = item.description;
      if (item.descriptionEn) existing.descriptionEn = item.descriptionEn;
      existing.costPrice = wholesaleCost;
      existing.price = retailPrice;
      existing.manualStock = item.stock;
      existing.categoryId = categoryId;
      existing.icon = item.icon || existing.icon || '📦';
      existing.isActive = true;
      await existing.save();
      updatedCount++;
    } else {
      await Product.create({
        name: item.name,
        nameEn: item.nameEn || '',
        description: item.description || '',
        descriptionEn: item.descriptionEn || '',
        price: retailPrice,
        costPrice: wholesaleCost,
        provider: supplierId,
        supplierProductCode: String(item.productCode),
        manualStock: item.stock,
        categoryId: categoryId,
        icon: item.icon || '📦',
        type: 'manual',
        deliveryMethod: 'ready_account',
        isActive: true,
        warrantyDays: 5,
      });
      importedCount++;
    }
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
const fulfillSupplierOrder = async (product, quantity, user) => {
  const supplierId = product.provider;
  const config = await SupplierConfig.findOne({ supplierId, isEnabled: true });

  if (!config || !config.apiKey) {
    return { success: false, error: 'Поставщик временно недоступен (API-ключ не настроен)' };
  }

  const adapter = ADAPTERS[supplierId];
  if (!adapter) {
    return { success: false, error: 'Адаптер поставщика не найден' };
  }

  const idempotencyKey = `ord-${product._id}-${user._id}-${Date.now()}`;
  const res = await adapter.createOrder(config.apiKey, {
    productCode: product.supplierProductCode,
    quantity: quantity,
    maxUnitPrice: (product.costPrice || product.price) * 1.5,
    idempotencyKey,
    externalOrderId: idempotencyKey,
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

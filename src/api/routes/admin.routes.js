const express = require('express');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const Key = require('../../models/Key');
const Order = require('../../models/Order');
const PromoCode = require('../../models/PromoCode');
const PromoUsage = require('../../models/PromoUsage');
const SupplierConfig = require('../../models/SupplierConfig');
const TopupRequest = require('../../models/TopupRequest');
const SellerWithdrawal = require('../../models/SellerWithdrawal');
const Seller = require('../../models/Seller');
const Transaction = require('../../models/Transaction');
const Settings = require('../../models/Settings');

const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middlewares/auth.middleware');
const settingsCache = require('../../services/settingsCache.service');
const currencyService = require('../../services/currency.service');
const { getEffectivePrice } = require('../../services/orderPricing.service');
const { withTransaction } = require('../../services/transactionHelper.service');
const { PREFIX, decryptSecret } = require('../../services/secretBox.service');
const {
  buildKeyQueryForProduct,
  normalizeProviderForType,
  resolveOrderProvider,
  resolveProductProvider,
} = require('../../services/provider.service');
const notif = require('../../services/notification.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../services/referral.service');
const supplierManager = require('../../services/supplierManager.service');
const supplierLiveSync = require('../../services/supplierLiveSync.service');
const bulkService = require('../../services/bulkOperations.service');
const supportService = require('../../services/support.service');
const supportNotify = require('../../services/supportNotify.service');
const { invalidateUserCache, clearUserCache } = require('../../bot/middlewares/user');
const { notifyManualCompletion } = require('../../bot/scenes/admin/orders.scene');
const { escapeHtml, formatDigitalItem } = require('../../bot/utils/ui');
const logger = require('../../config/logger');

const router = express.Router();

// Все маршруты админки защищены JWT и ролью admin/superadmin
router.use(authenticateToken, requireAdmin);

// ─── Вспомогательные функции ──────────────────────────────────────────────────

const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const round2 = (val) => Number((Number(val) || 0).toFixed(2));

const resolvePlainSecret = (val) => {
  if (typeof val !== 'string') return '';
  if (val.startsWith(PREFIX)) {
    try {
      return decryptSecret(val) || '';
    } catch (_) {
      return '';
    }
  }
  return val;
};

const maskSecret = (val) => {
  const plain = resolvePlainSecret(val).trim();
  if (!plain) return '';
  if (plain.length <= 4) return '••••';
  return `••••••••${plain.slice(-4)}`;
};

const isMaskedInput = (val) => typeof val === 'string' && val.includes('••••');

const parsePagination = (query, defaultLimit = 25, maxLimit = 100) => {
  const pageNum = Math.max(1, parseInt(query?.page, 10) || 1);
  const limitNum = Math.min(maxLimit, Math.max(1, parseInt(query?.limit, 10) || defaultLimit));
  return { pageNum, limitNum, skip: (pageNum - 1) * limitNum };
};

const getPeriodRange = (period) => {
  const now = new Date();
  let from;

  switch (period) {
    case 'day':
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week': {
      const day = now.getDay() || 7;
      from = new Date(now);
      from.setDate(now.getDate() - day + 1);
      from.setHours(0, 0, 0, 0);
      break;
    }
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'year':
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(0);
  }

  return { from, to: now };
};

const calcOfficialDiscountPercent = (price, officialPrice) => {
  const p = Number(price) || 0;
  const off = Number(officialPrice) || 0;
  if (off > p && off > 0) {
    return Math.round(((off - p) / off) * 100);
  }
  return 0;
};

const computeProductKeyCounts = async (productIds) => {
  if (!productIds || productIds.length === 0) return new Map();
  const rows = await Key.aggregate([
    { $match: { productId: { $in: productIds } } },
    {
      $group: {
        _id: { productId: '$productId', provider: '$provider', isUsed: '$isUsed' },
        count: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const pid = String(row._id.productId);
    const prov = row._id.provider || '__null__';
    const usedKey = row._id.isUsed ? 'used' : 'free';
    if (!map.has(pid)) map.set(pid, {});
    const byProv = map.get(pid);
    if (!byProv[prov]) byProv[prov] = { free: 0, used: 0 };
    byProv[prov][usedKey] += row.count;
  }
  return map;
};

const extractKeyCountsForProduct = (prod, countsMap) => {
  const byProv = countsMap.get(String(prod._id)) || {};
  const prov = resolveProductProvider(prod);

  let freeKeysCount = 0;
  let usedKeysCount = 0;

  if (prov === 'local' || prov === 'u1traby') {
    freeKeysCount = (byProv[prov]?.free || 0) + (byProv.__null__?.free || 0);
    usedKeysCount = (byProv[prov]?.used || 0) + (byProv.__null__?.used || 0);
  } else {
    freeKeysCount = byProv[prov]?.free || 0;
    usedKeysCount = byProv[prov]?.used || 0;
  }

  const stockCount = freeKeysCount > 0
    ? freeKeysCount
    : ((prod.type === 'manual' || prod.provider === 'jaha')
        ? (prod.manualStock === -1 ? 9999 : Math.max(0, Number(prod.manualStock) || 0))
        : 0);

  return { freeKeysCount, usedKeysCount, stockCount };
};

const formatAdminProduct = async (prod, countsMap) => {
  const { freeKeysCount, usedKeysCount, stockCount } = extractKeyCountsForProduct(prod, countsMap);
  const effectivePrice = await getEffectivePrice(prod, stockCount, null);

  return {
    id: prod._id,
    name: prod.name,
    nameEn: prod.nameEn || '',
    description: prod.description || '',
    descriptionEn: prod.descriptionEn || '',
    price: prod.price,
    costPrice: prod.costPrice || 0,
    officialPrice: prod.officialPrice || 0,
    officialDiscountPercent: prod.officialDiscountPercent || 0,
    effectivePrice,
    icon: prod.icon || '📦',
    type: prod.type,
    deliveryMethod: prod.deliveryMethod,
    itemOrigin: prod.itemOrigin || 'verified',
    provider: prod.provider || 'local',
    manualStock: prod.manualStock ?? -1,
    stockCount,
    freeKeysCount,
    usedKeysCount,
    isActive: prod.isActive !== false,
    sortOrder: prod.sortOrder || 0,
    warrantyDays: prod.warrantyDays ?? 5,
    subscriptionDays: prod.subscriptionDays ?? 30,
    category: prod.categoryId && typeof prod.categoryId === 'object' && prod.categoryId._id
      ? { id: prod.categoryId._id, name: prod.categoryId.name, icon: prod.categoryId.icon }
      : null,
    flashSale: prod.flashSale?.enabled
      ? {
          enabled: Boolean(prod.flashSale.enabled),
          discountPercent: prod.flashSale.discountPercent || 0,
          expiresAt: prod.flashSale.expiresAt || null,
          startedAt: prod.flashSale.startedAt || null,
        }
      : null,
    createdAt: prod.createdAt,
  };
};

const formatAdminOrder = (o) => ({
  id: o._id,
  status: o.status,
  price: o.price,
  costPrice: o.costPrice || 0,
  profit: round2((o.price || 0) - (o.costPrice || 0)),
  qty: o.qty || 1,
  provider: o.provider || null,
  deliveryData: o.deliveryData || null,
  key: o.replacedKeyId?.value || o.keyId?.value || o.deliveryData || null,
  notes: o.notes || null,
  activationResult: o.activationResult || null,
  warrantyDays: o.warrantyDays ?? 5,
  subscriptionDays: o.subscriptionDays ?? 30,
  replacementStatus: o.replacementStatus || 'none',
  replacementReason: o.replacementReason || null,
  disputeStatus: o.disputeStatus || null,
  createdAt: o.createdAt,
  confirmedAt: o.confirmedAt || null,
  user: o.userId && typeof o.userId === 'object'
    ? {
        id: o.userId._id,
        telegramId: o.userId.telegramId,
        username: o.userId.username || null,
        firstName: o.userId.firstName || '',
      }
    : null,
  product: o.productId && typeof o.productId === 'object'
    ? {
        id: o.productId._id,
        name: o.productId.name,
        icon: o.productId.icon || '📦',
        type: o.productId.type,
      }
    : null,
});

const formatSupplierResponse = (s) => {
  const plainKey = resolvePlainSecret(s.apiKey);
  return {
    supplierId: s.supplierId,
    title: s.title,
    hasApiKey: Boolean(plainKey && plainKey.trim()),
    apiKeyMask: maskSecret(plainKey),
    isEnabled: Boolean(s.isEnabled),
    cachedBalance: s.cachedBalance || 0,
    marginPercent: s.marginPercent ?? 30,
    marginFixed: s.marginFixed ?? 0,
    smartPricingEnabled: Boolean(s.smartPricingEnabled),
    smartPricingPreset: s.smartPricingPreset || 'standard',
    currentOnly: s.currentOnly !== false,
    autoImportNewProducts: s.autoImportNewProducts !== false,
    notifyAdminOnSync: s.notifyAdminOnSync !== false,
    notifyUsersOnRestock: Boolean(s.notifyUsersOnRestock),
    geminiMarkupPercent: s.geminiMarkupPercent ?? 25,
    geminiMaxMarkupUsd: s.geminiMaxMarkupUsd ?? 15,
    geminiMinProfitUsd: s.geminiMinProfitUsd ?? 1.0,
    lastSyncAt: s.lastSyncAt || null,
  };
};

const formatSettingsResponse = (raw) => {
  const s = typeof raw?.toObject === 'function' ? raw.toObject({ getters: true }) : (raw || {});
  const cardNumberPlain = resolvePlainSecret(s.cardNumber);
  const plategaMerchantPlain = resolvePlainSecret(s.plategaMerchantId);
  const plategaSecretPlain = resolvePlainSecret(s.plategaSecret);
  const bybitKeyPlain = resolvePlainSecret(s.bybitApiKey);
  const bybitSecretPlain = resolvePlainSecret(s.bybitApiSecret);
  const geminiKeyPlain = resolvePlainSecret(s.geminiApiKey);

  return {
    webPayments: {
      webMaintenanceMode: Boolean(s.webMaintenanceMode),
      webPlategaEnabled: s.webPlategaEnabled !== false,
      webBybitUidEnabled: s.webBybitUidEnabled !== false,
      webCryptoTrc20Enabled: s.webCryptoTrc20Enabled !== false,
      webCryptoBep20Enabled: s.webCryptoBep20Enabled !== false,
      webCryptoTonEnabled: s.webCryptoTonEnabled !== false,
    },
    botPayments: {
      maintenanceMode: Boolean(s.maintenanceMode),
      plategaEnabled: s.plategaEnabled !== false,
      cardEnabled: s.cardEnabled !== false,
      bybitEnabled: s.bybitEnabled !== false,
    },
    currency: {
      currencyMode: s.currencyMode || 'bybit_p2p',
      manualRate: s.manualRate ?? 95,
      currencyOffset: s.currencyOffset ?? 0,
      baseRateRub: currencyService.getBaseRate(),
      effectiveRateRub: currencyService.getRate(s),
      updatedAt: currencyService.getUpdatedAt(),
    },
    pricing: {
      smartPricing: Boolean(s.smartPricing),
      autoMarkdownEnabled: Boolean(s.autoMarkdownEnabled),
      autoMarkdownDays: s.autoMarkdownDays ?? 3,
      autoMarkdownPercent: s.autoMarkdownPercent ?? 5,
    },
    limits: {
      minTopup: s.minTopup ?? 1,
      referralBonus: s.referralBonus ?? 0.5,
      minSellerWithdraw: s.minSellerWithdraw ?? 5,
      autoConfirmHours: s.autoConfirmHours ?? 24,
    },
    walletsAndSecrets: {
      topupWallet: s.topupWallet || '',
      topupNetwork: s.topupNetwork || 'TRC-20 (TRON)',
      bybitUid: s.bybitUid || '',
      bybitTrc20Address: s.bybitTrc20Address || '',
      bybitBep20Address: s.bybitBep20Address || '',
      tonAddress: s.tonAddress || '',
      cardHolder: s.cardHolder ? resolvePlainSecret(s.cardHolder) : '',
      cardNumberMask: maskSecret(cardNumberPlain),
      hasCardNumber: Boolean(cardNumberPlain && cardNumberPlain.trim()),
      plategaMerchantIdMask: maskSecret(plategaMerchantPlain),
      hasPlategaMerchantId: Boolean(plategaMerchantPlain && plategaMerchantPlain.trim()),
      plategaSecretMask: maskSecret(plategaSecretPlain),
      hasPlategaSecret: Boolean(plategaSecretPlain && plategaSecretPlain.trim()),
      bybitApiKeyMask: maskSecret(bybitKeyPlain),
      hasBybitApiKey: Boolean(bybitKeyPlain && bybitKeyPlain.trim()),
      bybitApiSecretMask: maskSecret(bybitSecretPlain),
      hasBybitApiSecret: Boolean(bybitSecretPlain && bybitSecretPlain.trim()),
      hasGeminiKey: Boolean(geminiKeyPlain && geminiKeyPlain.trim()),
      geminiApiKeyMask: maskSecret(geminiKeyPlain),
    },
  };
};

// ─── 1. Статистика и аналитика ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const period = ['day', 'week', 'month', 'year', 'all'].includes(req.query.period)
      ? req.query.period
      : 'month';
    const { from, to } = getPeriodRange(period);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const settings = await settingsCache.getSettings();

    const [
      totalUsers,
      newUsersToday,
      bannedUsers,
      totalOrders,
      completedFacets,
      pendingOrders,
      preorderOrders,
      disputedOrders,
      pendingWarranties,
      pendingTopups,
      pendingWithdrawals,
      totalProducts,
      activeProducts,
      keyStats,
      periodRevenueAgg,
      periodRefundAgg,
      periodTopupAgg,
      newUsersPeriod,
      recentTopProductsAgg,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: todayStart } }),
      User.countDocuments({ isBanned: true }),
      Order.countDocuments(),
      Order.aggregate([
        { $match: { status: 'completed' } },
        {
          $facet: {
            total: [{ $group: { _id: null, revenue: { $sum: '$price' }, count: { $sum: 1 } } }],
            today: [
              { $match: { confirmedAt: { $gte: todayStart } } },
              { $group: { _id: null, revenue: { $sum: '$price' } } },
            ],
            month: [
              { $match: { confirmedAt: { $gte: monthStart } } },
              { $group: { _id: null, revenue: { $sum: '$price' } } },
            ],
          },
        },
      ]),
      Order.countDocuments({ status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'] } }),
      Order.countDocuments({ status: 'preorder_pending' }),
      Order.countDocuments({ status: 'disputed' }),
      Order.countDocuments({ replacementStatus: 'pending' }),
      TopupRequest.countDocuments({ status: 'pending' }),
      SellerWithdrawal.countDocuments({ status: 'pending' }),
      Product.countDocuments(),
      Product.countDocuments({ isActive: true }),
      Key.aggregate([{ $group: { _id: '$isUsed', cnt: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { status: 'completed', confirmedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$price' },
            cost: { $sum: '$costPrice' },
            count: { $sum: 1 },
          },
        },
      ]),
      Transaction.aggregate([
        { $match: { type: 'refund', createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      TopupRequest.aggregate([
        { $match: { status: 'confirmed', processedAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
      Order.aggregate([
        { $match: { status: 'completed', confirmedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$productId',
            count: { $sum: 1 },
            revenue: { $sum: '$price' },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      ]),
    ]);

    const facet0 = completedFacets[0] || {};
    const totalRevenue = round2(facet0.total?.[0]?.revenue || 0);
    const completedOrders = facet0.total?.[0]?.count || 0;
    const todayRevenue = round2(facet0.today?.[0]?.revenue || 0);
    const monthRevenue = round2(facet0.month?.[0]?.revenue || 0);

    const keysFree = keyStats.find((k) => k._id === false)?.cnt || 0;
    const keysUsed = keyStats.find((k) => k._id === true)?.cnt || 0;

    const pRev = round2(periodRevenueAgg[0]?.revenue || 0);
    const pCost = round2(periodRevenueAgg[0]?.cost || 0);
    const pProfit = round2(pRev - pCost);
    const pRefunds = round2(Math.abs(periodRefundAgg[0]?.total || 0));
    const pTopups = round2(periodTopupAgg[0]?.total || 0);
    const pCount = periodRevenueAgg[0]?.count || 0;

    return res.json({
      success: true,
      stats: {
        totalRevenue,
        todayRevenue,
        monthRevenue,
        totalOrders,
        completedOrders,
        pendingOrders,
        preorderOrders,
        disputedOrders,
        pendingWarranties,
        pendingTopups,
        pendingWithdrawals,
        totalUsers,
        newUsersToday,
        bannedUsers,
        totalProducts,
        activeProducts,
        keysFree,
        keysUsed,
        currentRateRub: currencyService.getRate(settings),
        baseRateRub: currencyService.getBaseRate(),
        updatedAt: currencyService.getUpdatedAt(),
        logistics: {
          periodRevenue: pRev,
          periodCost: pCost,
          periodProfit: pProfit,
          periodRefunds: pRefunds,
          periodTopups: pTopups,
          periodCount: pCount,
          newUsersPeriod,
        },
        recentTopProducts: recentTopProductsAgg.map((row) => ({
          productId: row._id,
          name: row.product?.name || 'Товар удалён',
          icon: row.product?.icon || '📦',
          count: row.count || 0,
          revenue: round2(row.revenue || 0),
        })),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка получения статистики: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 2. Товары (CRUD + Flash Sale + Clone) ────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const { pageNum, limitNum, skip } = parsePagination(req.query, 50, 500);
    const { categoryId, search, type, status, provider } = req.query;

    const filter = {};
    if (status === 'active') filter.isActive = true;
    else if (status === 'hidden') filter.isActive = false;

    if (categoryId && categoryId !== 'all') {
      if (categoryId === 'none') {
        filter.categoryId = null;
      } else if (!mongoose.isValidObjectId(categoryId)) {
        return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
      } else {
        filter.categoryId = new mongoose.Types.ObjectId(categoryId);
      }
    }

    if (type && ['key', 'gpt_activation', 'manual'].includes(type)) {
      filter.type = type;
    }

    if (provider && ['local', 'u1traby', 'jaha', 'akunding', 'canboso', 'trumpstore'].includes(provider)) {
      filter.provider = provider;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const sanitized = escapeRegex(search.trim().slice(0, 60));
      filter.$or = [
        { name: { $regex: sanitized, $options: 'i' } },
        { nameEn: { $regex: sanitized, $options: 'i' } },
      ];
    }

    const [products, totalCount] = await Promise.all([
      Product.find(filter)
        .populate('categoryId', 'name icon')
        .sort({ sortOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const countsMap = await computeProductKeyCounts(products.map((p) => p._id));
    const formatted = await Promise.all(products.map((p) => formatAdminProduct(p, countsMap)));

    return res.json({
      success: true,
      products: formatted,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка товаров: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const price = Number(body.price);

    if (!name) {
      return res.status(400).json({ success: false, error: 'NAME_REQUIRED', message: 'Укажите название товара' });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, error: 'INVALID_PRICE', message: 'Цена должна быть больше 0' });
    }

    const costPrice = body.costPrice !== undefined ? Math.max(0, Number(body.costPrice) || 0) : 0;
    const officialPrice = body.officialPrice !== undefined ? Math.max(0, Number(body.officialPrice) || 0) : 0;
    const type = ['key', 'gpt_activation', 'manual'].includes(body.type) ? body.type : 'key';
    const provider = body.provider === 'jaha'
      ? 'jaha'
      : normalizeProviderForType(type, body.provider || 'local');
    const deliveryMethod = ['activation', 'ready_account'].includes(body.deliveryMethod)
      ? body.deliveryMethod
      : (type === 'gpt_activation' ? 'activation' : 'ready_account');

    let categoryId = null;
    if (body.categoryId && body.categoryId !== 'none') {
      if (!mongoose.isValidObjectId(body.categoryId)) {
        return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
      }
      categoryId = body.categoryId;
    }

    const product = new Product({
      name,
      nameEn: String(body.nameEn || '').trim(),
      description: String(body.description || '').trim(),
      descriptionEn: String(body.descriptionEn || '').trim(),
      price,
      costPrice,
      officialPrice,
      officialDiscountPercent: calcOfficialDiscountPercent(price, officialPrice),
      icon: String(body.icon || '📦').trim() || '📦',
      type,
      provider,
      deliveryMethod,
      itemOrigin: ['verified', 'supplier'].includes(body.itemOrigin) ? body.itemOrigin : 'verified',
      categoryId,
      manualStock: body.manualStock !== undefined ? parseInt(body.manualStock, 10) : -1,
      isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
      sortOrder: body.sortOrder !== undefined ? (parseInt(body.sortOrder, 10) || 0) : 0,
      warrantyDays: body.warrantyDays !== undefined ? Math.max(0, Number(body.warrantyDays) || 0) : 5,
      subscriptionDays: body.subscriptionDays !== undefined ? Math.max(0, parseInt(body.subscriptionDays, 10) || 0) : 30,
    });

    await product.save();
    const populated = await Product.findById(product._id).populate('categoryId', 'name icon').lean();
    const countsMap = await computeProductKeyCounts([product._id]);
    const formatted = await formatAdminProduct(populated || product, countsMap);

    return res.status(201).json({ success: true, product: formatted });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка создания товара: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const existing = await Product.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });
    }

    const body = req.body || {};
    const prevManualStock = existing.manualStock;

    if (body.name !== undefined) {
      const trimmed = String(body.name).trim();
      if (!trimmed) return res.status(400).json({ success: false, error: 'NAME_REQUIRED' });
      existing.name = trimmed;
    }
    if (body.nameEn !== undefined) existing.nameEn = String(body.nameEn || '').trim();
    if (body.description !== undefined) existing.description = String(body.description || '').trim();
    if (body.descriptionEn !== undefined) existing.descriptionEn = String(body.descriptionEn || '').trim();
    if (body.icon !== undefined) existing.icon = String(body.icon || '📦').trim() || '📦';

    if (body.price !== undefined) {
      const p = Number(body.price);
      if (!Number.isFinite(p) || p <= 0) {
        return res.status(400).json({ success: false, error: 'INVALID_PRICE' });
      }
      existing.price = p;
    }
    if (body.costPrice !== undefined) {
      const cp = Number(body.costPrice);
      if (!Number.isFinite(cp) || cp < 0) {
        return res.status(400).json({ success: false, error: 'INVALID_COST_PRICE' });
      }
      existing.costPrice = cp;
    }
    if (body.officialPrice !== undefined) {
      const op = Number(body.officialPrice);
      if (!Number.isFinite(op) || op < 0) {
        return res.status(400).json({ success: false, error: 'INVALID_OFFICIAL_PRICE' });
      }
      existing.officialPrice = op;
    }

    if (body.price !== undefined || body.officialPrice !== undefined) {
      existing.officialDiscountPercent = calcOfficialDiscountPercent(existing.price, existing.officialPrice);
    }

    if (body.type !== undefined && ['key', 'gpt_activation', 'manual'].includes(body.type)) {
      existing.type = body.type;
    }
    if (body.deliveryMethod !== undefined && ['activation', 'ready_account'].includes(body.deliveryMethod)) {
      existing.deliveryMethod = body.deliveryMethod;
    }
    if (body.itemOrigin !== undefined && ['verified', 'supplier'].includes(body.itemOrigin)) {
      existing.itemOrigin = body.itemOrigin;
    }
    if (body.provider !== undefined && ['local', 'u1traby', 'jaha', 'akunding', 'canboso', 'trumpstore'].includes(body.provider)) {
      existing.provider = body.provider;
    }
    if (body.categoryId !== undefined) {
      if (!body.categoryId || body.categoryId === 'none') {
        existing.categoryId = null;
      } else if (!mongoose.isValidObjectId(body.categoryId)) {
        return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
      } else {
        existing.categoryId = body.categoryId;
      }
    }
    if (body.manualStock !== undefined) {
      const ms = parseInt(body.manualStock, 10);
      if (Number.isNaN(ms) || (ms < 0 && ms !== -1)) {
        return res.status(400).json({ success: false, error: 'INVALID_STOCK', message: 'Остаток должен быть >= 0 или -1' });
      }
      existing.manualStock = ms;
    }
    if (body.isActive !== undefined) existing.isActive = Boolean(body.isActive);
    if (body.sortOrder !== undefined) existing.sortOrder = parseInt(body.sortOrder, 10) || 0;
    if (body.warrantyDays !== undefined) existing.warrantyDays = Math.max(0, Number(body.warrantyDays) || 0);
    if (body.subscriptionDays !== undefined) existing.subscriptionDays = Math.max(0, parseInt(body.subscriptionDays, 10) || 0);

    await existing.save();

    if (body.manualStock !== undefined && (existing.manualStock > 0 || existing.manualStock === -1) && existing.manualStock !== prevManualStock) {
      notif.notifyWaitlist(existing).catch((e) => logger.warn(`[AdminAPI] notifyWaitlist: ${e.message}`));
    }

    const populated = await Product.findById(existing._id).populate('categoryId', 'name icon').lean();
    const countsMap = await computeProductKeyCounts([existing._id]);
    const formatted = await formatAdminProduct(populated || existing, countsMap);

    return res.json({ success: true, product: formatted });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления товара ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/products/:id/flash-sale', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });
    }

    const { action, enabled, discountPercent, durationHours, hours } = req.body || {};

    if (action === 'stop' || enabled === false) {
      product.flashSale = {
        ...(product.flashSale?.toObject ? product.flashSale.toObject() : (product.flashSale || {})),
        enabled: false,
        expiresAt: new Date(),
      };
    } else if (action === 'extend') {
      const addHours = Math.min(720, Math.max(0.5, Number(durationHours || hours) || 2));
      const currentExpiry = product.flashSale?.expiresAt ? new Date(product.flashSale.expiresAt).getTime() : Date.now();
      const baseTime = Math.max(Date.now(), currentExpiry);
      product.flashSale = {
        enabled: true,
        discountPercent: product.flashSale?.discountPercent || Math.min(99, Math.max(1, parseInt(discountPercent, 10) || 20)),
        startedAt: product.flashSale?.startedAt || new Date(),
        expiresAt: new Date(baseTime + addHours * 3600 * 1000),
      };
    } else {
      const pct = parseInt(discountPercent, 10) || 20;
      if (pct < 1 || pct > 99) {
        return res.status(400).json({ success: false, error: 'INVALID_DISCOUNT', message: 'Скидка должна быть от 1 до 99%' });
      }
      const dur = Math.min(720, Math.max(0.1, Number(durationHours || hours) || 4));
      product.flashSale = {
        enabled: true,
        discountPercent: pct,
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + dur * 3600 * 1000),
      };
    }

    await product.save();
    const populated = await Product.findById(product._id).populate('categoryId', 'name icon').lean();
    const countsMap = await computeProductKeyCounts([product._id]);
    const formatted = await formatAdminProduct(populated || product, countsMap);

    return res.json({ success: true, product: formatted });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка Flash Sale ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/products/:id/clone', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const original = await Product.findById(id).lean();
    if (!original) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });
    }

    const clone = new Product({
      name: `${original.name} (Копия)`,
      nameEn: original.nameEn || '',
      price: original.price,
      costPrice: original.costPrice || 0,
      officialPrice: original.officialPrice || 0,
      officialDiscountPercent: original.officialDiscountPercent || 0,
      type: original.type,
      provider: resolveProductProvider(original),
      deliveryMethod: original.deliveryMethod,
      itemOrigin: original.itemOrigin || 'verified',
      description: original.description || '',
      descriptionEn: original.descriptionEn || '',
      icon: original.icon || '📦',
      categoryId: original.categoryId || null,
      manualStock: original.manualStock ?? -1,
      warrantyDays: original.warrantyDays ?? 5,
      subscriptionDays: original.subscriptionDays ?? 30,
      sortOrder: original.sortOrder || 0,
      isActive: false,
    });

    await clone.save();
    const populated = await Product.findById(clone._id).populate('categoryId', 'name icon').lean();
    const countsMap = await computeProductKeyCounts([clone._id]);
    const formatted = await formatAdminProduct(populated || clone, countsMap);

    return res.status(201).json({ success: true, product: formatted });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка клонирования товара ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });
    }

    const activeOrders = await Order.countDocuments({
      productId: id,
      status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'] },
    });

    if (activeOrders > 0) {
      return res.status(409).json({
        success: false,
        error: 'ACTIVE_ORDERS_EXIST',
        message: `Нельзя удалить товар: есть активные заказы (${activeOrders} шт.)`,
      });
    }

    const allOrders = await Order.countDocuments({ productId: id });
    if (allOrders > 0) {
      product.isActive = false;
      await product.save();
      return res.json({
        success: true,
        archived: true,
        deleted: false,
        message: 'У товара есть история заказов — товар скрыт (архивирован)',
      });
    }

    await Product.deleteOne({ _id: id });
    await Key.deleteMany({ productId: id });
    return res.json({ success: true, deleted: true, archived: false, message: 'Товар и его ключи удалены' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка удаления товара ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 3. Категории (CRUD) ─────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const [categories, productCounts] = await Promise.all([
      Category.find().sort({ sortOrder: 1, _id: 1 }).lean(),
      Product.aggregate([{ $group: { _id: '$categoryId', count: { $sum: 1 } } }]),
    ]);

    const countMap = new Map();
    for (const row of productCounts) {
      if (row._id) countMap.set(String(row._id), row.count);
    }

    return res.json({
      success: true,
      categories: categories.map((c) => ({
        id: c._id,
        name: c.name,
        icon: c.icon || '📁',
        sortOrder: c.sortOrder || 0,
        isActive: c.isActive !== false,
        productCount: countMap.get(String(c._id)) || 0,
      })),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка категорий: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, icon = '📁', sortOrder = 0, isActive = true } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ success: false, error: 'NAME_REQUIRED', message: 'Укажите название категории' });
    }

    const cat = await Category.create({
      name: cleanName,
      icon: String(icon || '📁').trim() || '📁',
      sortOrder: parseInt(sortOrder, 10) || 0,
      isActive: Boolean(isActive),
    });

    return res.status(201).json({
      success: true,
      category: {
        id: cat._id,
        name: cat.name,
        icon: cat.icon,
        sortOrder: cat.sortOrder,
        isActive: cat.isActive,
        productCount: 0,
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка создания категории: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
    }

    const cat = await Category.findById(id);
    if (!cat) {
      return res.status(404).json({ success: false, error: 'CATEGORY_NOT_FOUND' });
    }

    const { name, icon, sortOrder, isActive } = req.body || {};
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return res.status(400).json({ success: false, error: 'NAME_REQUIRED' });
      cat.name = cleanName;
    }
    if (icon !== undefined) cat.icon = String(icon || '📁').trim() || '📁';
    if (sortOrder !== undefined) cat.sortOrder = parseInt(sortOrder, 10) || 0;
    if (isActive !== undefined) cat.isActive = Boolean(isActive);

    await cat.save();
    const productCount = await Product.countDocuments({ categoryId: cat._id });

    return res.json({
      success: true,
      category: {
        id: cat._id,
        name: cat.name,
        icon: cat.icon,
        sortOrder: cat.sortOrder,
        isActive: cat.isActive,
        productCount,
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления категории ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_CATEGORY_ID' });
    }

    const cat = await Category.findById(id);
    if (!cat) {
      return res.status(404).json({ success: false, error: 'CATEGORY_NOT_FOUND' });
    }

    const hasProducts = await Product.exists({ categoryId: id });
    if (hasProducts) {
      return res.status(400).json({
        success: false,
        error: 'CATEGORY_HAS_PRODUCTS',
        message: 'Нельзя удалить категорию: сначала удалите или переместите товары из неё',
      });
    }

    await Category.findByIdAndDelete(id);
    return res.json({ success: true, message: 'Категория удалена' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка удаления категории ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 4. Ключи (Summary, Список, Батч-импорт, Удаление, Очистка) ─────────────
router.get('/keys/summary', async (req, res) => {
  try {
    const [products, keyAgg] = await Promise.all([
      Product.find().sort({ sortOrder: 1, createdAt: -1 }).select('name icon type provider manualStock').lean(),
      Key.aggregate([
        {
          $group: {
            _id: { productId: '$productId', isUsed: '$isUsed' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const freeMap = new Map();
    const usedMap = new Map();
    for (const row of keyAgg) {
      const pid = String(row._id.productId);
      if (row._id.isUsed) usedMap.set(pid, (usedMap.get(pid) || 0) + row.count);
      else freeMap.set(pid, (freeMap.get(pid) || 0) + row.count);
    }

    const summary = products.map((p) => {
      const pid = String(p._id);
      return {
        productId: p._id,
        name: p.name,
        icon: p.icon || '📦',
        type: p.type,
        provider: resolveProductProvider(p),
        freeCount: freeMap.get(pid) || 0,
        usedCount: usedMap.get(pid) || 0,
        manualStock: p.manualStock ?? -1,
      };
    });

    return res.json({ success: true, summary });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка сводки ключей: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.get('/keys/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const product = await Product.findById(productId).lean();
    if (!product) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' });
    }

    const { pageNum, limitNum, skip } = parsePagination(req.query, 50, 200);
    const { status } = req.query;

    const query = buildKeyQueryForProduct(product);
    if (status === 'free' || status === 'unused') query.isUsed = false;
    else if (status === 'used') query.isUsed = true;

    const [keys, totalCount] = await Promise.all([
      Key.find(query).sort({ isUsed: 1, createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Key.countDocuments(query),
    ]);

    return res.json({
      success: true,
      keys: keys.map((k) => ({
        id: k._id,
        value: k.value,
        isUsed: Boolean(k.isUsed),
        provider: k.provider || 'local',
        createdAt: k.createdAt,
        usedAt: k.usedAt || null,
        usedByOrder: k.usedByOrder || null,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка ключей товара ${req.params.productId}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/keys/import', async (req, res) => {
  try {
    const { productId, rawText, keys } = req.body || {};
    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID', message: 'Укажите корректный ID товара' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND', message: 'Товар не найден' });
    }

    let lines = [];
    if (Array.isArray(keys)) {
      lines = keys.map((k) => String(k || '').trim()).filter(Boolean);
    } else if (typeof rawText === 'string') {
      lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }

    if (lines.length === 0) {
      return res.status(400).json({ success: false, error: 'EMPTY_KEYS', message: 'Список ключей пуст' });
    }

    if (lines.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'TOO_MANY_KEYS',
        message: 'Максимум 5000 строк за один импорт',
      });
    }

    if (lines.some((line) => line.length > 1000)) {
      return res.status(400).json({
        success: false,
        error: 'KEY_LINE_TOO_LONG',
        message: 'Максимальная длина одной строки — 1000 символов',
      });
    }

    const provider = resolveProductProvider(product);
    const existingList = await Key.distinct('value', buildKeyQueryForProduct(product));
    const existingSet = new Set(existingList);
    const batchSeen = new Set();
    const newKeys = [];

    for (const val of lines) {
      if (!existingSet.has(val) && !batchSeen.has(val)) {
        batchSeen.add(val);
        newKeys.push(val);
      }
    }

    const skippedCount = lines.length - newKeys.length;
    let addedCount = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < newKeys.length; i += BATCH_SIZE) {
      const slice = newKeys.slice(i, i + BATCH_SIZE).map((value) => ({
        productId: product._id,
        provider,
        value,
      }));
      try {
        const inserted = await Key.insertMany(slice, { ordered: false });
        addedCount += Array.isArray(inserted) ? inserted.length : slice.length;
      } catch (bulkErr) {
        if (Array.isArray(bulkErr?.insertedDocs)) {
          addedCount += bulkErr.insertedDocs.length;
        } else {
          throw bulkErr;
        }
      }
    }

    if (addedCount > 0) {
      notif.notifyWaitlist(product).catch((e) => logger.warn(`[AdminAPI] notifyWaitlist: ${e.message}`));
    }

    return res.json({
      success: true,
      addedCount,
      skippedCount,
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка импорта ключей: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.delete('/keys/product/:productId/clear-used', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const product = await Product.findById(productId);
    const result = product
      ? await Key.deleteMany(buildKeyQueryForProduct(product, { isUsed: true }))
      : await Key.deleteMany({ productId, isUsed: true });

    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка очистки использованных ключей: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.delete('/keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    if (!mongoose.isValidObjectId(keyId)) {
      return res.status(400).json({ success: false, error: 'INVALID_KEY_ID' });
    }

    const key = await Key.findById(keyId);
    if (!key) {
      return res.status(404).json({ success: false, error: 'KEY_NOT_FOUND' });
    }

    if (key.isUsed) {
      return res.status(400).json({
        success: false,
        error: 'KEY_ALREADY_USED',
        message: 'Нельзя удалить уже использованный ключ',
      });
    }

    await Key.deleteOne({ _id: keyId, isUsed: false });
    return res.json({ success: true, message: 'Ключ удалён' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка удаления ключа ${req.params.keyId}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 5. Заказы (Просмотр, Выполнение, Отмена, Гарантия, Спор) ───────────────
router.get('/orders', async (req, res) => {
  try {
    const { pageNum, limitNum, skip } = parsePagination(req.query, 25, 100);
    const filterKey = String(req.query.filter || req.query.status || 'all').toLowerCase();
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const conditions = [];
    if (filterKey === 'active') {
      conditions.push({ status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'] } });
    } else if (filterKey === 'preorder') {
      conditions.push({ status: 'preorder_pending' });
    } else if (filterKey === 'completed') {
      conditions.push({ status: 'completed' });
    } else if (filterKey === 'cancelled') {
      conditions.push({ status: { $in: ['cancelled', 'failed'] } });
    } else if (filterKey === 'disputed') {
      conditions.push({ status: 'disputed' });
    } else if (filterKey === 'warranty') {
      conditions.push({ replacementStatus: 'pending' });
    }

    if (search) {
      if (mongoose.isValidObjectId(search) && /^[0-9a-fA-F]{24}$/.test(search)) {
        conditions.push({ _id: new mongoose.Types.ObjectId(search) });
      } else {
        const clean = search.replace(/^@/, '').slice(0, 60);
        const re = new RegExp(escapeRegex(clean), 'i');
        const userOr = [{ username: re }, { firstName: re }];
        if (/^\d+$/.test(clean)) {
          userOr.push({ telegramId: Number(clean) });
        }
        const [matchedUsers, matchedProducts] = await Promise.all([
          User.find({ $or: userOr }).select('_id').limit(50).lean(),
          Product.find({ name: re }).select('_id').limit(50).lean(),
        ]);

        const searchOr = [{ supplierOrderId: re }];
        if (matchedUsers.length > 0) searchOr.push({ userId: { $in: matchedUsers.map((u) => u._id) } });
        if (matchedProducts.length > 0) searchOr.push({ productId: { $in: matchedProducts.map((p) => p._id) } });
        conditions.push({ $or: searchOr });
      }
    }

    const query = conditions.length > 1 ? { $and: conditions } : (conditions[0] || {});

    const [orders, totalCount] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('userId', 'telegramId username firstName')
        .populate('productId', 'name icon type')
        .populate('keyId', 'value')
        .populate('replacedKeyId', 'value')
        .lean(),
      Order.countDocuments(query),
    ]);

    return res.json({
      success: true,
      orders: orders.map(formatAdminOrder),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка заказов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/orders/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const existing = await Order.findById(id).populate('userId').populate('productId');
    if (!existing) {
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    }

    if (['completed', 'cancelled', 'failed'].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: 'ORDER_ALREADY_CLOSED',
        message: 'Заказ уже завершён или отменён',
      });
    }

    const rawDelivery = req.body?.deliveryData;
    const hasDeliveryData = typeof rawDelivery === 'string' && rawDelivery.trim().length > 0;

    const updateSet = {
      status: 'completed',
      provider: resolveOrderProvider(existing, existing.productId),
      adminId: req.user._id,
      confirmedAt: new Date(),
      activationResult: 'Выполнено вручную оператором',
      nextRetryAt: null,
    };
    if (hasDeliveryData) {
      updateSet.deliveryData = rawDelivery.trim();
    }

    const completedOrder = await Order.findOneAndUpdate(
      { _id: id, status: { $nin: ['completed', 'cancelled', 'failed'] } },
      { $set: updateSet },
      { new: true }
    )
      .populate('userId', 'telegramId username firstName language')
      .populate('productId', 'name icon type')
      .populate('keyId', 'value')
      .populate('replacedKeyId', 'value');

    if (!completedOrder) {
      return res.status(409).json({ success: false, error: 'ORDER_ALREADY_CLOSED' });
    }

    const buyer = completedOrder.userId;
    if (buyer) {
      await notifyManualCompletion(buyer, completedOrder, completedOrder.productId).catch(() => {});
      await grantReferralBonusForFirstCompletedOrder(buyer._id).catch(() => {});
    }

    if (completedOrder.sellerId && completedOrder.sellerPayout > 0 && !completedOrder.sellerPaidAt) {
      const paidMark = await Order.findOneAndUpdate(
        { _id: completedOrder._id, sellerPaidAt: null },
        { $set: { sellerPaidAt: new Date() } },
        { new: true }
      );
      if (paidMark) {
        await Seller.findByIdAndUpdate(completedOrder.sellerId, {
          $inc: { balance: completedOrder.sellerPayout, totalEarned: completedOrder.sellerPayout },
        }).catch((e) => logger.error(`[AdminAPI] Ошибка выплаты продавцу: ${e.message}`));
      }
    }

    return res.json({ success: true, order: formatAdminOrder(completedOrder) });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка выполнения заказа ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/orders/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const preview = await Order.findById(id).populate('productId').lean();
    if (!preview) {
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    }
    if (['completed', 'cancelled', 'failed'].includes(preview.status)) {
      return res.status(400).json({
        success: false,
        error: 'ORDER_ALREADY_CLOSED',
        message: 'Заказ уже закрыт',
      });
    }

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Отменено администратором';

    let cancelledOrder = null;
    let refundedUser = null;

    await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : undefined;

      cancelledOrder = await Order.findOneAndUpdate(
        { _id: id, status: { $nin: ['completed', 'cancelled', 'failed'] } },
        {
          $set: {
            status: 'cancelled',
            adminId: req.user._id,
            nextRetryAt: null,
            notes: reason,
          },
        },
        { new: true, ...(sessionOpt || {}) }
      );

      if (!cancelledOrder) return;

      const user = await User.findOneAndUpdate(
        { _id: cancelledOrder.userId?._id || cancelledOrder.userId },
        { $inc: { balance: cancelledOrder.price } },
        { new: true, ...(sessionOpt || {}) }
      );

      if (!user) {
        throw new Error('CANCEL_USER_NOT_FOUND');
      }
      refundedUser = user;

      await new Transaction({
        userId: user._id,
        type: 'refund',
        amount: cancelledOrder.price,
        orderId: cancelledOrder._id,
        description: `Возврат: ${reason}`,
      }).save(sessionOpt);

      if (cancelledOrder.keyId) {
        await Key.updateOne(
          { _id: cancelledOrder.keyId },
          { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
          sessionOpt
        );
      }
    });

    if (!cancelledOrder) {
      return res.status(409).json({ success: false, error: 'ORDER_ALREADY_CLOSED', message: 'Заказ уже закрыт' });
    }

    if (refundedUser) {
      invalidateUserCache(refundedUser.telegramId);
      await notif.notifyUserOrderCancelled(refundedUser, cancelledOrder, preview.productId, reason).catch(() => {});
    }

    return res.json({
      success: true,
      refundedAmount: cancelledOrder.price,
      newUserBalance: refundedUser?.balance ?? null,
    });
  } catch (err) {
    if (err.message === 'CANCEL_USER_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Покупатель не найден' });
    }
    logger.error(`[AdminAPI] Ошибка отмены заказа ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/orders/:id/warranty', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const { action, deliveryData, reason } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'INVALID_ACTION', message: 'Допустимые действия: approve | reject' });
    }

    const order = await Order.findById(id).populate('productId').populate('userId');
    if (!order) {
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    }
    if (order.replacementStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'WARRANTY_NOT_PENDING',
        message: 'Заявка на замену не найдена или уже обработана',
      });
    }

    if (action === 'reject') {
      const rejectReason = typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : 'Не подтверждено модератором';

      const rejected = await Order.findOneAndUpdate(
        { _id: id, replacementStatus: 'pending' },
        { $set: { replacementStatus: 'rejected', replacementRejectReason: rejectReason } },
        { new: true }
      );
      if (!rejected) {
        return res.status(409).json({ success: false, error: 'WARRANTY_NOT_PENDING' });
      }

      if (order.userId?.telegramId) {
        await notif.sendToUser(
          order.userId.telegramId,
          `❌ <b>Заявка на замену по гарантии отклонена.</b>\nПричина: ${escapeHtml(rejectReason)}`
        ).catch(() => {});
      }

      return res.json({ success: true, replacementStatus: 'rejected' });
    }

    // action === 'approve'
    const manualValue = typeof deliveryData === 'string' && deliveryData.trim() ? deliveryData.trim() : null;
    const product = order.productId;
    let newValue = manualValue;
    let allocatedKey = null;

    if (!manualValue) {
      allocatedKey = await Key.findOneAndUpdate(
        buildKeyQueryForProduct(product, { isUsed: false }),
        { $set: { isUsed: true, usedAt: new Date(), usedByOrder: order._id } },
        { new: true }
      );
      if (!allocatedKey) {
        return res.status(400).json({
          success: false,
          error: 'NO_KEYS_AVAILABLE',
          message: 'Нет свободных ключей на складе. Передайте данные замены вручную в deliveryData.',
        });
      }
      newValue = allocatedKey.value;
    }

    const claimed = await Order.findOneAndUpdate(
      { _id: id, replacementStatus: 'pending' },
      {
        $set: {
          replacementStatus: 'approved',
          deliveryData: newValue,
          replacedAt: new Date(),
          ...(allocatedKey ? { replacedKeyId: allocatedKey._id } : {}),
        },
      },
      { new: true }
    );

    if (!claimed) {
      if (allocatedKey) {
        await Key.updateOne(
          { _id: allocatedKey._id },
          { $set: { isUsed: false, usedAt: null, usedByOrder: null } }
        ).catch(() => {});
      }
      return res.status(409).json({ success: false, error: 'WARRANTY_NOT_PENDING' });
    }

    if (order.userId?.telegramId) {
      const userLang = order.userId.language || 'ru';
      const itemFormatted = formatDigitalItem(newValue, userLang);
      await notif.sendToUser(
        order.userId.telegramId,
        `✅ <b>Ваша заявка на замену по гарантии одобрена!</b>\n\n` +
        `📦 <b>Товар:</b> ${escapeHtml(product?.name || 'Товар')}\n\n` +
        `📦 <b>Ваш новый аккаунт / ключ:</b>\n${itemFormatted}`
      ).catch(() => {});
    }

    return res.json({
      success: true,
      replacementStatus: 'approved',
      deliveryData: newValue,
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка замены по гарантии ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/orders/:id/dispute', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const resolution = req.body?.resolution || req.body?.action;
    if (!['refund_buyer', 'pay_seller'].includes(resolution)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_RESOLUTION',
        message: 'Допустимые решения: refund_buyer | pay_seller',
      });
    }

    let order = null;

    if (resolution === 'refund_buyer') {
      await withTransaction(async (session) => {
        const sessionOpt = session ? { session } : {};
        order = await Order.findOneAndUpdate(
          { _id: id, status: 'disputed' },
          {
            $set: {
              status: 'cancelled',
              disputeStatus: 'resolved',
              activationResult: 'Спор: возврат средств покупателю',
            },
          },
          { new: true, ...sessionOpt }
        ).populate('userId').populate('sellerId');
        if (!order) return;

        if (order.userId) {
          const refundAmount = (typeof order.price === 'number' && Number.isFinite(order.price) && order.price > 0)
            ? order.price
            : 0;

          await User.updateOne(
            { _id: order.userId._id },
            { $inc: { balance: refundAmount, totalSpent: -refundAmount } },
            sessionOpt
          );
          await User.updateOne(
            { _id: order.userId._id, totalSpent: { $lt: 0 } },
            { $set: { totalSpent: 0 } },
            sessionOpt
          );

          await new Transaction({
            userId: order.userId._id,
            orderId: order._id,
            type: 'refund',
            amount: refundAmount,
            description: `Возврат средств по спору (заказ #${order._id})`,
          }).save(sessionOpt);
        }
      });

      if (!order) {
        return res.status(404).json({ success: false, error: 'DISPUTE_NOT_FOUND', message: 'Спор не найден или уже закрыт' });
      }

      if (order.userId) {
        invalidateUserCache(order.userId.telegramId);
        await notif.sendToUser(
          order.userId.telegramId,
          `✅ <b>Спор решён в вашу пользу!</b>\nДеньги (${order.price} USDT) возвращены на ваш баланс.`
        ).catch(() => {});
      }
      if (order.sellerId?.telegramId) {
        await notif.sendToUser(
          order.sellerId.telegramId,
          `❌ <b>Спор закрыт не в вашу пользу.</b>\nЗаказ отменён, средства возвращены покупателю.`
        ).catch(() => {});
      }

      return res.json({ success: true, resolution: 'refund_buyer', status: 'cancelled' });
    }

    // resolution === 'pay_seller'
    await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      order = await Order.findOneAndUpdate(
        { _id: id, status: 'disputed' },
        {
          $set: {
            status: 'completed',
            confirmedAt: new Date(),
            disputeStatus: 'resolved',
            activationResult: 'Спор: выплата продавцу',
          },
        },
        { new: true, ...sessionOpt }
      ).populate('userId').populate('sellerId');
      if (!order) return;

      if (order.sellerId && order.sellerPayout > 0) {
        await Seller.updateOne(
          { _id: order.sellerId._id },
          { $inc: { balance: order.sellerPayout, totalEarned: order.sellerPayout } },
          sessionOpt
        );
        await Order.updateOne({ _id: order._id }, { $set: { sellerPaidAt: new Date() } }, sessionOpt);

        const sellerUserId = order.sellerId.userId || (order.userId?._id ? order.userId._id : null);
        await new Transaction({
          userId: sellerUserId,
          sellerId: order.sellerId._id,
          orderId: order._id,
          type: 'seller_payout',
          amount: order.sellerPayout,
          description: `Выплата продавцу по спору (заказ #${order._id})`,
        }).save(sessionOpt);
      }
    });

    if (!order) {
      return res.status(404).json({ success: false, error: 'DISPUTE_NOT_FOUND', message: 'Спор не найден или уже закрыт' });
    }

    if (order.userId?._id) {
      grantReferralBonusForFirstCompletedOrder(order.userId._id).catch(() => {});
    }
    if (order.sellerId?.telegramId) {
      await notif.sendToUser(
        order.sellerId.telegramId,
        `✅ <b>Спор решён в вашу пользу!</b>\nВы получили <b>${order.sellerPayout} USDT</b> за заказ.`
      ).catch(() => {});
    }
    if (order.userId?.telegramId) {
      await notif.sendToUser(
        order.userId.telegramId,
        `❌ <b>Спор закрыт не в вашу пользу.</b>\nАдминистратор признал товар валидным. Деньги переведены продавцу.`
      ).catch(() => {});
    }

    return res.json({ success: true, resolution: 'pay_seller', status: 'completed' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка решения спора ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 6. Пользователи (Список, Детали, Баланс, Роль/Бан, Сообщение) ───────────
router.get('/users', async (req, res) => {
  try {
    const { pageNum, limitNum, skip } = parsePagination(req.query, 25, 100);
    const filterKey = String(req.query.filter || 'all').toLowerCase();
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const conditions = [];
    if (filterKey === 'with_balance') conditions.push({ balance: { $gt: 0 } });
    else if (filterKey === 'banned') conditions.push({ isBanned: true });
    else if (filterKey === 'admins') conditions.push({ role: { $in: ['admin', 'superadmin'] } });
    else if (filterKey === 'support') conditions.push({ role: 'support' });
    else if (filterKey === 'moderator') conditions.push({ role: 'moderator' });
    else if (filterKey === 'staff') conditions.push({ role: { $in: ['support', 'moderator', 'admin', 'superadmin'] } });

    if (search) {
      if (mongoose.isValidObjectId(search) && /^[0-9a-fA-F]{24}$/.test(search)) {
        conditions.push({ _id: new mongoose.Types.ObjectId(search) });
      } else {
        const clean = search.replace(/^@/, '').slice(0, 60);
        const re = new RegExp(escapeRegex(clean), 'i');
        const orArr = [{ username: re }, { firstName: re }, { lastName: re }];
        if (/^\d+$/.test(clean)) orArr.push({ telegramId: Number(clean) });
        conditions.push({ $or: orArr });
      }
    }

    const query = conditions.length > 1 ? { $and: conditions } : (conditions[0] || {});
    const sort = filterKey === 'with_balance' ? { balance: -1 } : { createdAt: -1 };

    const [users, totalCount, balanceAgg] = await Promise.all([
      User.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .select('telegramId username firstName lastName balance totalSpent role isBanned language acceptedToS createdAt')
        .lean(),
      User.countDocuments(query),
      User.aggregate([{ $match: { balance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
    ]);

    return res.json({
      success: true,
      users: users.map((u) => ({
        id: u._id,
        telegramId: u.telegramId,
        username: u.username || null,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        balance: round2(u.balance),
        totalSpent: round2(u.totalSpent),
        role: u.role || 'user',
        isBanned: Boolean(u.isBanned),
        language: u.language || 'ru',
        acceptedToS: Boolean(u.acceptedToS),
        createdAt: u.createdAt,
      })),
      totalBalanceSum: round2(balanceAgg[0]?.total || 0),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка пользователей: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_USER_ID' });
    }

    const user = await User.findById(id)
      .select('telegramId username firstName lastName balance totalSpent role isBanned language acceptedToS acceptedToSAt referralCode createdAt')
      .lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    const [ordersCount, referralsCount, recentTransactions] = await Promise.all([
      Order.countDocuments({ userId: user._id }),
      User.countDocuments({ referredBy: user._id }),
      Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    return res.json({
      success: true,
      user: {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username || null,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        balance: round2(user.balance),
        totalSpent: round2(user.totalSpent),
        role: user.role || 'user',
        isBanned: Boolean(user.isBanned),
        language: user.language || 'ru',
        acceptedToS: Boolean(user.acceptedToS),
        acceptedToSAt: user.acceptedToSAt || null,
        referralCode: user.referralCode || null,
        createdAt: user.createdAt,
      },
      stats: {
        ordersCount,
        referralsCount,
      },
      recentTransactions: recentTransactions.map((tx) => ({
        id: tx._id,
        type: tx.type,
        amount: tx.amount,
        orderId: tx.orderId || null,
        topupRequestId: tx.topupRequestId || null,
        description: tx.description || '',
        createdAt: tx.createdAt,
      })),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка профиля пользователя ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/users/:id/balance', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_USER_ID' });
    }

    const { delta, action, reason } = req.body || {};
    const isZeroAction = action === 'zero';
    let deltaNum = 0;

    if (isZeroAction) {
      if (req.user.role !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'SUPERADMIN_REQUIRED',
          message: 'Обнуление баланса доступно только главному администратору (superadmin)',
        });
      }
    } else {
      deltaNum = Number(delta);
      if (!Number.isFinite(deltaNum) || deltaNum === 0 || Math.abs(deltaNum) > 1000000) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_AMOUNT',
          message: 'Укажите ненулевую сумму в пределах от -1 000 000 до +1 000 000',
        });
      }
      if (Math.abs(deltaNum) > 100 && req.user.role !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'SUPERADMIN_REQUIRED',
          message: 'Изменение баланса более чем на 100 USDT доступно только главному администратору (superadmin)',
        });
      }
    }

    let updatedUser = null;
    let actualDelta = 0;

    await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : undefined;

      if (isZeroAction) {
        const beforeUser = await User.findOneAndUpdate(
          { _id: id, balance: { $gt: 0 } },
          { $set: { balance: 0 } },
          { new: false, ...(sessionOpt || {}) }
        );

        if (!beforeUser) {
          const checkUser = await User.findById(id, null, sessionOpt);
          if (!checkUser) throw new Error('BALANCE_USER_NOT_FOUND');
          throw new Error('BALANCE_ALREADY_ZERO');
        }

        const debited = Number(beforeUser.balance) || 0;
        actualDelta = -debited;
        updatedUser = { ...beforeUser.toObject(), balance: 0 };

        await new Transaction({
          userId: beforeUser._id,
          type: 'manual_debit',
          amount: actualDelta,
          description: reason ? `Обнуление баланса (${String(reason).trim()})` : 'Полное списание баланса администратором',
        }).save(sessionOpt);
        return;
      }

      if (deltaNum < 0) {
        const decRes = await User.findOneAndUpdate(
          { _id: id, balance: { $gte: -deltaNum } },
          { $inc: { balance: deltaNum } },
          { new: true, ...(sessionOpt || {}) }
        );
        if (decRes) {
          updatedUser = decRes;
          actualDelta = deltaNum;
        } else {
          const prevZeroCheck = await User.findOneAndUpdate(
            { _id: id, balance: { $gt: 0 } },
            { $set: { balance: 0 } },
            { new: false, ...(sessionOpt || {}) }
          );
          if (!prevZeroCheck) {
            const exists = await User.findById(id, null, sessionOpt);
            if (!exists) throw new Error('BALANCE_USER_NOT_FOUND');
            throw new Error('BALANCE_ALREADY_ZERO');
          }
          actualDelta = -(Number(prevZeroCheck.balance) || 0);
          updatedUser = { ...prevZeroCheck.toObject(), balance: 0 };
        }
      } else {
        updatedUser = await User.findOneAndUpdate(
          { _id: id },
          { $inc: { balance: deltaNum } },
          { new: true, ...(sessionOpt || {}) }
        );
        if (!updatedUser) throw new Error('BALANCE_USER_NOT_FOUND');
        actualDelta = deltaNum;
      }

      await new Transaction({
        userId: updatedUser._id,
        type: actualDelta > 0 ? 'manual_credit' : 'manual_debit',
        amount: actualDelta,
        description: reason ? String(reason).trim() : 'Ручное изменение баланса администратором (Web)',
      }).save(sessionOpt);
    });

    if (updatedUser?.telegramId) {
      invalidateUserCache(updatedUser.telegramId);
    }

    return res.json({
      success: true,
      newBalance: round2(updatedUser?.balance || 0),
      delta: actualDelta,
    });
  } catch (err) {
    if (err.message === 'BALANCE_USER_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    if (err.message === 'BALANCE_ALREADY_ZERO') {
      return res.status(400).json({ success: false, error: 'BALANCE_ALREADY_ZERO', message: 'Баланс уже равен 0' });
    }
    logger.error(`[AdminAPI] Ошибка изменения баланса ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_USER_ID' });
    }

    if (String(id) === String(req.user._id)) {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_MODIFY_SELF',
        message: 'Нельзя изменять собственный статус блокировки или роль',
      });
    }

    const target = await User.findById(id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    if (target.role === 'superadmin') {
      return res.status(403).json({
        success: false,
        error: 'CANNOT_MODIFY_SUPERADMIN',
        message: 'Нельзя блокировать или менять роль главного администратора',
      });
    }

    const { isBanned, role, reason } = req.body || {};

    let updatedTarget = target;

    if (role !== undefined) {
      if (req.user.role !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'SUPERADMIN_REQUIRED',
          message: 'Изменение ролей доступно только главному администратору (superadmin)',
        });
      }
      if (!['user', 'support', 'moderator', 'admin'].includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_ROLE',
          message: 'Допустимые роли: user | support | moderator | admin',
        });
      }
      const roleRes = await supportService.assignStaffRole({
        actorUser: req.user,
        targetUser: target,
        newRole: role,
        reason: typeof reason === 'string' ? reason.trim().slice(0, 300) : '',
      });
      if (!roleRes.ok) {
        const status = roleRes.error === 'CANNOT_ESCALATE_ROLE' || roleRes.error === 'FORBIDDEN' ? 403 : 400;
        return res.status(status).json({
          success: false,
          error: roleRes.error || 'ROLE_UPDATE_FAILED',
          message: 'Не удалось изменить роль пользователя',
        });
      }
      updatedTarget = roleRes.user || target;
      if (roleRes.changed) {
        await supportNotify.notifyOwnerRoleChange({
          actorUser: req.user,
          targetUser: updatedTarget,
          oldRole: roleRes.oldRole,
          newRole: roleRes.newRole,
          reason: typeof reason === 'string' ? reason.trim() : '',
        }).catch(() => {});
      }
    }

    if (isBanned !== undefined) {
      updatedTarget = await User.findByIdAndUpdate(
        target._id,
        { $set: { isBanned: Boolean(isBanned) } },
        { new: true }
      ) || updatedTarget;
      invalidateUserCache(target.telegramId);
    }

    return res.json({
      success: true,
      user: {
        id: updatedTarget._id,
        telegramId: updatedTarget.telegramId,
        username: updatedTarget.username || null,
        firstName: updatedTarget.firstName || '',
        role: updatedTarget.role,
        isBanned: Boolean(updatedTarget.isBanned),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления пользователя ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/users/:id/message', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_USER_ID' });
    }

    const rawText = req.body?.message ?? req.body?.text ?? '';
    const message = String(rawText).trim();
    if (!message || message.length > 4000) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_MESSAGE',
        message: 'Сообщение должно содержать от 1 до 4000 символов',
      });
    }

    const user = await User.findById(id).select('telegramId').lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    await notif.sendToUser(user.telegramId, `💬 <b>Сообщение от поддержки:</b>\n\n${escapeHtml(message)}`);
    return res.json({ success: true, message: 'Сообщение отправлено пользователю' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка отправки сообщения пользователю ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 7. Промокоды (CRUD) ─────────────────────────────────────────────────────
router.get('/promos', async (req, res) => {
  try {
    const [promos, totalUsages] = await Promise.all([
      PromoCode.find().sort({ createdAt: -1 }).populate('productId', 'name').lean(),
      PromoUsage.countDocuments(),
    ]);

    return res.json({
      success: true,
      promos: promos.map((p) => ({
        id: p._id,
        code: p.code,
        type: p.type,
        value: p.value,
        maxActivations: p.maxActivations,
        currentActivations: p.currentActivations || 0,
        maxPerUser: p.maxPerUser,
        minOrderAmount: p.minOrderAmount || 0,
        productId: p.productId?._id || p.productId || null,
        productName: p.productId?.name || null,
        minQuantity: p.minQuantity || 1,
        discountTarget: p.discountTarget || 'all',
        audienceCondition: p.audienceCondition || 'all',
        expiresAt: p.expiresAt || null,
        isActive: p.isActive !== false,
        createdAt: p.createdAt,
      })),
      totalUsages,
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка промокодов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/promos', async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    const type = body.type;
    const value = Number(body.value);

    if (!code || code.length < 2 || code.length > 64) {
      return res.status(400).json({ success: false, error: 'INVALID_CODE', message: 'Некорректный код промокода' });
    }
    if (!['balance', 'percent', 'fixed'].includes(type)) {
      return res.status(400).json({ success: false, error: 'INVALID_TYPE', message: 'Тип должен быть balance | percent | fixed' });
    }
    if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100)) {
      return res.status(400).json({ success: false, error: 'INVALID_VALUE', message: 'Некорректный номинал промокода' });
    }

    const exists = await PromoCode.findOne({ code }).lean();
    if (exists) {
      return res.status(409).json({ success: false, error: 'PROMO_EXISTS', message: 'Промокод с таким именем уже существует' });
    }

    let productId = null;
    if (body.productId && body.productId !== 'all') {
      if (!mongoose.isValidObjectId(body.productId)) {
        return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
      }
      productId = body.productId;
    }

    const promo = await PromoCode.create({
      code,
      type,
      value,
      maxActivations: body.maxActivations !== undefined ? (parseInt(body.maxActivations, 10) || -1) : -1,
      maxPerUser: body.maxPerUser !== undefined ? (parseInt(body.maxPerUser, 10) || 1) : 1,
      minOrderAmount: body.minOrderAmount !== undefined ? Math.max(0, Number(body.minOrderAmount) || 0) : 0,
      productId,
      minQuantity: body.minQuantity !== undefined ? Math.max(1, parseInt(body.minQuantity, 10) || 1) : 1,
      discountTarget: ['all', 'second_item'].includes(body.discountTarget) ? body.discountTarget : 'all',
      audienceCondition: ['all', 'first_only', 'repeat_only'].includes(body.audienceCondition) ? body.audienceCondition : 'all',
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
    });

    const populated = await PromoCode.findById(promo._id).populate('productId', 'name').lean();
    const p = populated || promo;

    return res.status(201).json({
      success: true,
      promo: {
        id: p._id,
        code: p.code,
        type: p.type,
        value: p.value,
        maxActivations: p.maxActivations,
        currentActivations: p.currentActivations || 0,
        maxPerUser: p.maxPerUser,
        minOrderAmount: p.minOrderAmount || 0,
        productId: p.productId?._id || p.productId || null,
        productName: p.productId?.name || null,
        minQuantity: p.minQuantity || 1,
        discountTarget: p.discountTarget || 'all',
        audienceCondition: p.audienceCondition || 'all',
        expiresAt: p.expiresAt || null,
        isActive: p.isActive !== false,
        createdAt: p.createdAt,
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка создания промокода: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/promos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PROMO_ID' });
    }

    const promo = await PromoCode.findById(id);
    if (!promo) {
      return res.status(404).json({ success: false, error: 'PROMO_NOT_FOUND' });
    }

    const body = req.body || {};
    if (body.isActive !== undefined) promo.isActive = Boolean(body.isActive);
    if (body.value !== undefined) {
      const v = Number(body.value);
      if (!Number.isFinite(v) || v <= 0 || (promo.type === 'percent' && v > 100)) {
        return res.status(400).json({ success: false, error: 'INVALID_VALUE' });
      }
      promo.value = v;
    }
    if (body.maxActivations !== undefined) promo.maxActivations = parseInt(body.maxActivations, 10) || -1;
    if (body.maxPerUser !== undefined) promo.maxPerUser = parseInt(body.maxPerUser, 10) || 1;
    if (body.minOrderAmount !== undefined) promo.minOrderAmount = Math.max(0, Number(body.minOrderAmount) || 0);
    if (body.minQuantity !== undefined) promo.minQuantity = Math.max(1, parseInt(body.minQuantity, 10) || 1);
    if (body.discountTarget !== undefined && ['all', 'second_item'].includes(body.discountTarget)) {
      promo.discountTarget = body.discountTarget;
    }
    if (body.audienceCondition !== undefined && ['all', 'first_only', 'repeat_only'].includes(body.audienceCondition)) {
      promo.audienceCondition = body.audienceCondition;
    }
    if (body.expiresAt !== undefined) promo.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

    await promo.save();
    return res.json({ success: true, promo: { id: promo._id, code: promo.code, isActive: promo.isActive } });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления промокода ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.delete('/promos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_PROMO_ID' });
    }

    const deleted = await PromoCode.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'PROMO_NOT_FOUND' });
    }

    return res.json({ success: true, message: 'Промокод удалён' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка удаления промокода ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 8. Поставщики (С маскированием apiKey) ──────────────────────────────────
router.get('/suppliers', async (req, res) => {
  try {
    const suppliers = await supplierManager.getAllSuppliers();
    return res.json({
      success: true,
      suppliers: suppliers.map(formatSupplierResponse),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка поставщиков: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/suppliers/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;
    const body = req.body || {};

    let config = await SupplierConfig.findOne({ supplierId });
    if (!config) {
      return res.status(404).json({ success: false, error: 'SUPPLIER_NOT_FOUND' });
    }

    // Смена API-ключа — строго superadmin (игнорируем маску и пустую строку)
    if (body.apiKey !== undefined && !isMaskedInput(body.apiKey)) {
      const cleanKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (cleanKey || body.apiKey === null) {
        if (req.user.role !== 'superadmin') {
          return res.status(403).json({
            success: false,
            error: 'SUPERADMIN_REQUIRED',
            message: 'Изменение API-ключа поставщика доступно только главному администратору (superadmin)',
          });
        }
        config = await supplierManager.saveSupplierKey(
          supplierId,
          body.apiKey === null ? '' : cleanKey,
          body.marginPercent,
          body.marginFixed
        );
      }
    }

    if (body.isEnabled !== undefined) config.isEnabled = Boolean(body.isEnabled);
    if (body.marginPercent !== undefined && Number.isFinite(Number(body.marginPercent))) {
      config.marginPercent = Number(body.marginPercent);
    }
    if (body.marginFixed !== undefined && Number.isFinite(Number(body.marginFixed))) {
      config.marginFixed = Number(body.marginFixed);
    }
    if (body.smartPricingEnabled !== undefined) config.smartPricingEnabled = Boolean(body.smartPricingEnabled);
    if (body.smartPricingPreset !== undefined && ['standard', 'high_profit', 'minimal', 'gemini_ai', 'custom'].includes(body.smartPricingPreset)) {
      config.smartPricingPreset = body.smartPricingPreset;
    }
    if (body.autoImportNewProducts !== undefined) config.autoImportNewProducts = Boolean(body.autoImportNewProducts);
    if (body.notifyAdminOnSync !== undefined) config.notifyAdminOnSync = Boolean(body.notifyAdminOnSync);
    if (body.notifyUsersOnRestock !== undefined) config.notifyUsersOnRestock = Boolean(body.notifyUsersOnRestock);
    if (body.geminiMarkupPercent !== undefined && Number.isFinite(Number(body.geminiMarkupPercent))) {
      config.geminiMarkupPercent = Number(body.geminiMarkupPercent);
    }
    if (body.geminiMaxMarkupUsd !== undefined && Number.isFinite(Number(body.geminiMaxMarkupUsd))) {
      config.geminiMaxMarkupUsd = Number(body.geminiMaxMarkupUsd);
    }
    if (body.geminiMinProfitUsd !== undefined && Number.isFinite(Number(body.geminiMinProfitUsd))) {
      config.geminiMinProfitUsd = Number(body.geminiMinProfitUsd);
    }

    let currentOnlyChanged = false;
    if (body.currentOnly !== undefined && Boolean(body.currentOnly) !== Boolean(config.currentOnly !== false)) {
      config.currentOnly = Boolean(body.currentOnly);
      currentOnlyChanged = true;
    }

    config.updatedAt = new Date();
    await config.save();

    if (currentOnlyChanged) {
      if (config.currentOnly) {
        await Product.updateMany({ provider: supplierId, manualStock: { $lte: 0 } }, { $set: { isActive: false } });
      } else {
        await Product.updateMany({ provider: supplierId }, { $set: { isActive: true } });
      }
    }

    return res.json({ success: true, supplier: formatSupplierResponse(config) });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления поставщика ${req.params.supplierId}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/suppliers/:supplierId/refresh', async (req, res) => {
  try {
    const result = await supplierManager.refreshSupplierBalance(req.params.supplierId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: 'REFRESH_FAILED', message: result.error || 'Не удалось обновить баланс' });
    }
    return res.json({ success: true, balance: result.balance });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления баланса поставщика: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/suppliers/:supplierId/sync', async (req, res) => {
  try {
    const result = await supplierLiveSync.syncSupplierStock(req.params.supplierId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: 'SYNC_FAILED', message: result.error || 'Ошибка синхронизации' });
    }
    return res.json(result);
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка синхронизации поставщика: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/suppliers/:supplierId/import', async (req, res) => {
  try {
    const result = await supplierManager.importSupplierCatalog(req.params.supplierId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: 'IMPORT_FAILED', message: result.error || 'Ошибка импорта' });
    }
    return res.json(result);
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка импорта каталога поставщика: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 9. Топапы (TopupRequest) и Выводы продавцов (SellerWithdrawal) ──────────
router.get('/topups', async (req, res) => {
  try {
    const { pageNum, limitNum, skip } = parsePagination(req.query, 30, 100);
    const status = req.query.status || 'pending';
    const filter = status === 'all' ? {} : { status };

    const [topups, totalCount] = await Promise.all([
      TopupRequest.find(filter)
        .sort({ createdAt: status === 'pending' ? 1 : -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('userId', 'telegramId username firstName')
        .lean(),
      TopupRequest.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      topups: topups.map((t) => ({
        id: t._id,
        amount: t.amount || 0,
        amountRub: t.amountRub || null,
        status: t.status,
        method: t.method || 'unknown',
        network: t.network || null,
        txid: t.txid || null,
        proofText: t.proofText || null,
        payUrl: t.payUrl || null,
        createdAt: t.createdAt,
        processedAt: t.processedAt || null,
        user: t.userId && typeof t.userId === 'object'
          ? {
              id: t.userId._id,
              telegramId: t.userId.telegramId,
              username: t.userId.username || null,
              firstName: t.userId.firstName || '',
            }
          : null,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка топапов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/topups/:id/approve', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_REQUEST_ID' });
    }

    const existing = await TopupRequest.findById(id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'REQUEST_NOT_FOUND' });
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'ALREADY_PROCESSED', message: 'Заявка уже обработана' });
    }

    const finalAmount = req.body?.amount !== undefined ? Number(req.body.amount) : Number(existing.amount);
    if (!Number.isFinite(finalAmount) || finalAmount <= 0 || finalAmount > 1000000) {
      return res.status(400).json({ success: false, error: 'INVALID_AMOUNT', message: 'Некорректная сумма зачисления' });
    }

    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;
    let approvedRequest = null;
    let approvedUser = null;

    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;
      approvedRequest = await TopupRequest.findOneAndUpdate(
        { _id: id, status: 'pending' },
        {
          $set: {
            amount: finalAmount,
            status: 'confirmed',
            adminId: req.user._id,
            processedAt: new Date(),
            ...(note ? { notes: note } : {}),
          },
        },
        { new: true, ...(sessionOptions || {}) }
      );
      if (!approvedRequest) return;

      approvedUser = await User.findByIdAndUpdate(
        approvedRequest.userId,
        { $inc: { balance: finalAmount } },
        { new: true, ...(sessionOptions || {}) }
      );
      if (!approvedUser) {
        throw new Error('TOPUP_USER_NOT_FOUND');
      }

      await new Transaction({
        userId: approvedUser._id,
        type: 'topup',
        amount: finalAmount,
        topupRequestId: approvedRequest._id,
        description: `Пополнение подтверждено администратором (${finalAmount} USDT)`,
      }).save(sessionOptions);
    });

    if (!approvedRequest || !approvedUser) {
      return res.status(409).json({ success: false, error: 'ALREADY_PROCESSED', message: 'Заявка уже обработана' });
    }

    invalidateUserCache(approvedUser.telegramId);
    await notif.notifyUserTopupConfirmed(approvedUser, finalAmount).catch(() => {});

    return res.json({
      success: true,
      creditedAmount: finalAmount,
      newBalance: round2(approvedUser.balance),
      status: 'confirmed',
    });
  } catch (err) {
    if (err.message === 'TOPUP_USER_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    logger.error(`[AdminAPI] Ошибка одобрения топапа ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/topups/:id/reject', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_REQUEST_ID' });
    }

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Не прошла проверку';

    const request = await TopupRequest.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          adminId: req.user._id,
          processedAt: new Date(),
          notes: reason,
        },
      },
      { new: true }
    ).populate('userId');

    if (!request) {
      return res.status(409).json({ success: false, error: 'ALREADY_PROCESSED', message: 'Заявка не найдена или уже обработана' });
    }

    const user = request.userId?.telegramId ? request.userId : await User.findById(request.userId);
    if (user) {
      await notif.notifyUserTopupRejected(user, request.amount || 0, reason).catch(() => {});
    }

    return res.json({ success: true, status: 'rejected' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка отклонения топапа ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const { pageNum, limitNum, skip } = parsePagination(req.query, 30, 100);
    const status = req.query.status || 'pending';
    const filter = status === 'all' ? {} : { status };

    const [withdrawals, totalCount] = await Promise.all([
      SellerWithdrawal.find(filter)
        .sort({ createdAt: status === 'pending' ? 1 : -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('sellerId', 'username telegramId')
        .lean(),
      SellerWithdrawal.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      withdrawals: withdrawals.map((w) => ({
        id: w._id,
        amount: w.amount,
        network: w.network || 'TRC-20',
        walletAddress: w.walletAddress,
        status: w.status,
        createdAt: w.createdAt,
        processedAt: w.processedAt || null,
        seller: w.sellerId && typeof w.sellerId === 'object'
          ? {
              id: w.sellerId._id,
              username: w.sellerId.username || null,
              telegramId: w.sellerId.telegramId || null,
            }
          : null,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка списка выводов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/withdrawals/:id/confirm', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_WITHDRAWAL_ID' });
    }

    const withdrawal = await SellerWithdrawal.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'completed', processedAt: new Date() } },
      { new: true }
    ).populate('sellerId');

    if (!withdrawal) {
      return res.status(409).json({ success: false, error: 'ALREADY_PROCESSED', message: 'Заявка не найдена или уже обработана' });
    }

    await notif.notifySellerWithdrawalResult(withdrawal.sellerId, withdrawal, 'confirmed').catch(() => {});
    return res.json({ success: true, status: 'completed' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка подтверждения вывода ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/withdrawals/:id/reject', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_WITHDRAWAL_ID' });
    }

    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
    let withdrawal = null;

    await withTransaction(async (session) => {
      const sessionOpt = session ? { session } : undefined;
      withdrawal = await SellerWithdrawal.findOneAndUpdate(
        { _id: id, status: 'pending' },
        {
          $set: {
            status: 'rejected',
            processedAt: new Date(),
            ...(reason ? { adminNote: reason } : {}),
          },
        },
        { new: true, ...(sessionOpt || {}) }
      ).populate('sellerId');

      if (!withdrawal) return;

      if (withdrawal.sellerId) {
        await Seller.updateOne(
          { _id: withdrawal.sellerId._id },
          { $inc: { balance: withdrawal.amount } },
          sessionOpt
        );
      }
    });

    if (!withdrawal) {
      return res.status(409).json({ success: false, error: 'ALREADY_PROCESSED', message: 'Заявка не найдена или уже обработана' });
    }

    await notif.notifySellerWithdrawalResult(withdrawal.sellerId, withdrawal, 'rejected').catch(() => {});
    return res.json({ success: true, status: 'rejected' });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка отклонения вывода ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 10. Массовые операции ───────────────────────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { action, confirm, amount, days, productId } = req.body || {};

    if (confirm !== true) {
      return res.status(400).json({
        success: false,
        error: 'CONFIRMATION_REQUIRED',
        message: 'Требуется явное подтверждение массовой операции (confirm: true)',
      });
    }

    const SUPERADMIN_BULK_ACTIONS = ['grant_balance', 'reset_balances'];
    if (SUPERADMIN_BULK_ACTIONS.includes(action) && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        error: 'SUPERADMIN_REQUIRED',
        message: 'Массовые финансовые операции с балансами доступны только главному администратору (superadmin)',
      });
    }

    let affectedCount = 0;

    switch (action) {
      case 'hide_products':
        affectedCount = await bulkService.hideAllProducts();
        break;
      case 'show_products': {
        const resShow = await Product.updateMany({}, { $set: { isActive: true } });
        affectedCount = resShow.modifiedCount || 0;
        break;
      }
      case 'hide_categories':
        affectedCount = await bulkService.hideAllCategories();
        break;
      case 'show_categories': {
        const resCatShow = await Category.updateMany({}, { $set: { isActive: true } });
        affectedCount = resCatShow.modifiedCount || 0;
        break;
      }
      case 'add_warranty': {
        const daysNum = parseInt(days, 10);
        if (!Number.isInteger(daysNum) || daysNum <= 0 || daysNum > 3650) {
          return res.status(400).json({ success: false, error: 'INVALID_DAYS', message: 'Укажите количество дней от 1 до 3650' });
        }
        affectedCount = await bulkService.bulkAddWarranty(daysNum, productId || null);
        break;
      }
      case 'reset_warranty':
        affectedCount = await bulkService.bulkResetWarranty(productId || null);
        break;
      case 'grant_balance': {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0 || amt > 1000) {
          return res.status(400).json({ success: false, error: 'INVALID_AMOUNT', message: 'Сумма должна быть от 0.01 до 1000 USDT' });
        }
        affectedCount = await bulkService.grantBalanceToAll(amt);
        clearUserCache();
        break;
      }
      case 'reset_balances':
        affectedCount = await bulkService.resetAllBalances();
        clearUserCache();
        break;
      default:
        return res.status(400).json({ success: false, error: 'INVALID_BULK_ACTION', message: 'Неизвестная массовая операция' });
    }

    return res.json({ success: true, action, affectedCount });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка массовой операции: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 11. Настройки (С разделением web* / bot* и маскированием секретов) ───────
const getOrCreateLiveSettings = async () => {
  let settings = await Settings.findOne({ name: 'global' });
  if (!settings) {
    settings = await Settings.create({ name: 'global' });
  }
  return settings;
};

const SUPERADMIN_SETTING_FIELDS = new Set([
  'webMaintenanceMode',
  'webPlategaEnabled',
  'webBybitUidEnabled',
  'webCryptoTrc20Enabled',
  'webCryptoBep20Enabled',
  'webCryptoTonEnabled',
  'maintenanceMode',
  'plategaEnabled',
  'cardEnabled',
  'bybitEnabled',
  'topupWallet',
  'topupNetwork',
  'bybitUid',
  'bybitTrc20Address',
  'bybitBep20Address',
  'tonAddress',
  'cardHolder',
  'cardNumber',
  'plategaMerchantId',
  'plategaSecret',
  'bybitApiKey',
  'bybitApiSecret',
  'geminiApiKey',
  'minTopup',
  'referralBonus',
  'minSellerWithdraw',
  'autoConfirmHours',
]);

const SECRET_SETTING_FIELDS = new Set([
  'cardNumber',
  'cardHolder',
  'plategaMerchantId',
  'plategaSecret',
  'bybitApiKey',
  'bybitApiSecret',
  'geminiApiKey',
]);

const BOOLEAN_SETTING_FIELDS = new Set([
  'webMaintenanceMode',
  'webPlategaEnabled',
  'webBybitUidEnabled',
  'webCryptoTrc20Enabled',
  'webCryptoBep20Enabled',
  'webCryptoTonEnabled',
  'maintenanceMode',
  'plategaEnabled',
  'cardEnabled',
  'bybitEnabled',
  'smartPricing',
  'autoMarkdownEnabled',
]);

const NUMERIC_SETTING_FIELDS = new Set([
  'manualRate',
  'currencyOffset',
  'autoMarkdownDays',
  'autoMarkdownPercent',
  'minTopup',
  'referralBonus',
  'minSellerWithdraw',
  'autoConfirmHours',
]);

const WALLET_STRING_FIELDS = new Set([
  'topupWallet',
  'topupNetwork',
  'bybitUid',
  'bybitTrc20Address',
  'bybitBep20Address',
  'tonAddress',
]);

router.get('/settings', async (req, res) => {
  try {
    let settings = await Settings.findOne({ name: 'global' });
    if (!settings) {
      settings = await settingsCache.getSettings();
    }
    return res.json({
      success: true,
      settings: formatSettingsResponse(settings),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка чтения настроек: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const raw = req.body || {};
    // Поддерживаем как плоский объект, так и вложенные секции из GET /settings
    const flat = {
      ...(raw.webPayments && typeof raw.webPayments === 'object' ? raw.webPayments : {}),
      ...(raw.botPayments && typeof raw.botPayments === 'object' ? raw.botPayments : {}),
      ...(raw.currency && typeof raw.currency === 'object' ? raw.currency : {}),
      ...(raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {}),
      ...(raw.limits && typeof raw.limits === 'object' ? raw.limits : {}),
      ...(raw.walletsAndSecrets && typeof raw.walletsAndSecrets === 'object' ? raw.walletsAndSecrets : {}),
      ...raw,
    };

    const updates = {};
    for (const [key, val] of Object.entries(flat)) {
      if (val === undefined) continue;
      if (SECRET_SETTING_FIELDS.has(key)) {
        // Игнорируем маски (••••) и пустые значения, чтобы случайный submit формы не стёр ключи
        if (isMaskedInput(val)) continue;
        if (typeof val === 'string' && val.trim() === '') continue;
        if (val === null) {
          updates[key] = '';
        } else {
          updates[key] = String(val).trim();
        }
      } else if (BOOLEAN_SETTING_FIELDS.has(key)) {
        updates[key] = Boolean(val);
      } else if (NUMERIC_SETTING_FIELDS.has(key)) {
        const num = Number(val);
        if (!Number.isFinite(num)) {
          return res.status(400).json({ success: false, error: 'INVALID_NUMBER', message: `Некорректное число для ${key}` });
        }
        if (key === 'manualRate' && num <= 0) {
          return res.status(400).json({ success: false, error: 'INVALID_RATE', message: 'Ручной курс должен быть > 0' });
        }
        if (key !== 'currencyOffset' && num < 0) {
          return res.status(400).json({ success: false, error: 'INVALID_NUMBER', message: `${key} не может быть отрицательным` });
        }
        updates[key] = num;
      } else if (WALLET_STRING_FIELDS.has(key)) {
        updates[key] = String(val || '').trim();
      } else if (key === 'currencyMode' && ['bybit_p2p', 'manual'].includes(val)) {
        updates.currencyMode = val;
      }
    }

    const attemptedSuperAdminField = Object.keys(updates).find((k) => SUPERADMIN_SETTING_FIELDS.has(k));
    if (attemptedSuperAdminField && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        error: 'SUPERADMIN_REQUIRED',
        message: 'Изменение платёжных настроек, кошельков, секретов и лимитов доступно только главному администратору (superadmin)',
      });
    }

    const settings = await getOrCreateLiveSettings();
    Object.assign(settings, updates);
    await settings.save();
    settingsCache.invalidateCache(settings);

    if (updates.maintenanceMode !== undefined) {
      global.MAINTENANCE_MODE = Boolean(settings.maintenanceMode);
    }

    return res.json({
      success: true,
      settings: formatSettingsResponse(settings),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка сохранения настроек: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

router.post('/settings/refresh-rate', async (req, res) => {
  try {
    await currencyService.fetchRate();
    const settings = await settingsCache.getSettings();
    const effective = currencyService.getRate(settings);
    return res.json({
      success: true,
      baseRateRub: currencyService.getBaseRate(),
      effectiveRateRub: effective,
      currentRateRub: effective,
      updatedAt: currencyService.getUpdatedAt(),
    });
  } catch (err) {
    logger.error(`[AdminAPI] Ошибка обновления курса: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

module.exports = { adminRouter: router };

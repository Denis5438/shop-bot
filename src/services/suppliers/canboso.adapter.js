const axios = require('axios');

const BASE_URL = 'https://canboso.com/api/v2/telegram-buyer';

/**
 * Получение баланса Canboso
 * API: GET /api/v2/telegram-buyer/balance?key=...
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/balance`, {
      params: { key: apiKey },
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    const data = res.data;
    // Баланс может быть в VND или USD, берём usdtBalance если есть, иначе balanceUsd
    const balance = parseFloat(data?.usdtBalance ?? data?.balanceUsd ?? data?.balance ?? 0);
    return {
      success: true,
      balance,
      username: data?.requester?.name || 'Canboso Reseller',
      currency: data?.walletCurrency || 'USD',
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || 'Ошибка подключения к Canboso API',
    };
  }
};

/**
 * Получение каталога товаров от Canboso
 * API: GET /api/v2/telegram-buyer/products?key=...
 * Возвращает: { success, products: [{ _id, product_name, pricing, stats, ... }] }
 */
const getProducts = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/products`, {
      params: { key: apiKey },
      headers: { Accept: 'application/json' },
      timeout: 15000,
    });

    const data = res.data;
    if (!data?.success) {
      return { success: false, error: data?.message || 'Canboso вернул ошибку', products: [] };
    }

    const items = Array.isArray(data.products) ? data.products : [];
    return {
      success: true,
      products: items.map((p) => {
        // Остаток берём из stats.available, если есть
        let stockVal = 0;
        if (p.stats?.available !== undefined && p.stats.available !== null) {
          stockVal = Number(p.stats.available);
        } else if (p.stats?.total !== undefined && p.stats?.sold !== undefined) {
          stockVal = Math.max(0, Number(p.stats.total) - Number(p.stats.sold));
        }

        // Цена: usdPricing (в USD) предпочтительнее, иначе pricing (в валюте кошелька)
        const priceUsdt = parseFloat(p.usdPricing || p.walletPricing || p.pricing || 0);

        return {
          productCode: String(p._id || p.product_id),
          name: p.product_name || p.product_name_raw || p.name || 'Без названия',
          nameEn: p.product_name || '',
          description: p.description || p.description_raw || '',
          descriptionEn: p.description || '',
          priceUsdt,
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: 'Canboso Digital',
          icon: '🌐',
          // Доп. данные для покупки
          isSlotProduct: p.isSlotProduct || false,
          requiresCustomerEmail: p.requiresCustomerEmail || false,
          slotProductType: p.slotProductType || 'account',
        };
      }),
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || 'Не удалось получить каталог Canboso',
      products: [],
    };
  }
};

/**
 * Автоматический выкуп заказа у Canboso
 * API: POST /api/v2/telegram-buyer/purchase
 * Body: { key, product_id, quantity }
 * Header: Idempotency-Key
 * Возвращает: { success, orderCode, deliveredAccounts: [{ user, password, ... }], ... }
 */
const createOrder = async (apiKey, { productCode, quantity = 1, idempotencyKey }) => {
  try {
    const body = {
      key: apiKey,
      product_id: String(productCode),
      quantity: parseInt(quantity, 10) || 1,
    };

    const res = await axios.post(`${BASE_URL}/purchase`, body, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': String(idempotencyKey),
      },
      timeout: 30000,
    });

    const data = res.data;

    if (!data?.success) {
      return {
        success: false,
        error: data?.message || 'Canboso: покупка не удалась',
      };
    }

    // Формируем текст выдачи из deliveredAccounts
    let deliveryData = null;
    if (Array.isArray(data.deliveredAccounts) && data.deliveredAccounts.length > 0) {
      deliveryData = data.deliveredAccounts
        .map((acc) => {
          const parts = [];
          if (acc.user || acc.login || acc.email) parts.push(`Login: ${acc.user || acc.login || acc.email}`);
          if (acc.password || acc.pass) parts.push(`Password: ${acc.password || acc.pass}`);
          if (acc.twoFactor || acc.code || acc.secret || acc['2fa'] || acc.totp) {
            parts.push(`2FA: ${acc.twoFactor || acc.code || acc.secret || acc['2fa'] || acc.totp}`);
          }
          if (acc.verifyEmail || acc.recovery) parts.push(`Recovery: ${acc.verifyEmail || acc.recovery}`);
          if (acc.token) parts.push(`Token: ${acc.token}`);
          return parts.join(' | ');
        })
        .join('\n');
    } else if (data.key || data.account || data.delivery || data.content) {
      deliveryData = String(data.key || data.account || data.delivery || data.content);
    }

    const status = deliveryData
      ? (data.autoCompleted ? 'completed' : (data.status || 'completed'))
      : (data.status || 'processing');

    return {
      success: true,
      orderNumber: data.orderCode || data.orderId,
      deliveryData: deliveryData || null,
      status,
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
};

/**
 * Проверка статуса заказа у Canboso
 */
const getOrder = async (apiKey, orderNumber) => {
  try {
    const res = await axios.get(`${BASE_URL}/orders/${encodeURIComponent(orderNumber)}`, {
      params: { key: apiKey },
      headers: { Accept: 'application/json' },
      timeout: 15000,
    });
    const data = res.data;
    let deliveryData = null;
    if (Array.isArray(data?.deliveredAccounts) && data.deliveredAccounts.length > 0) {
      deliveryData = data.deliveredAccounts
        .map((acc) => {
          const parts = [];
          if (acc.user || acc.login || acc.email) parts.push(`Login: ${acc.user || acc.login || acc.email}`);
          if (acc.password || acc.pass) parts.push(`Password: ${acc.password || acc.pass}`);
          if (acc.twoFactor || acc.code || acc.secret || acc['2fa'] || acc.totp) {
            parts.push(`2FA: ${acc.twoFactor || acc.code || acc.secret || acc['2fa'] || acc.totp}`);
          }
          if (acc.verifyEmail || acc.recovery) parts.push(`Recovery: ${acc.verifyEmail || acc.recovery}`);
          if (acc.token) parts.push(`Token: ${acc.token}`);
          return parts.join(' | ');
        })
        .join('\n');
    } else if (data?.key || data?.account || data?.delivery || data?.content) {
      deliveryData = String(data.key || data.account || data.delivery || data.content);
    }
    return {
      success: true,
      orderNumber: data?.orderCode || data?.orderId || orderNumber,
      deliveryData: deliveryData || null,
      status: deliveryData ? 'completed' : (data?.status || 'processing'),
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
  getOrder,
};

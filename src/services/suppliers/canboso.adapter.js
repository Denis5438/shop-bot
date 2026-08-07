const axios = require('axios');

const BASE_URL = 'https://canboso.com/api';

/**
 * Получение профиля и баланса Canboso
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/v1/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    return {
      success: true,
      balance: parseFloat(res.data?.balance || res.data?.usdt || 0),
      username: res.data?.username || 'Canboso Reseller',
      raw: res.data,
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
 */
const getProducts = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/v1/products`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const items = Array.isArray(res.data) ? res.data : (res.data?.products || []);
    return {
      success: true,
      products: items.map((p) => ({
        productCode: String(p.id || p.product_code || p.code),
        name: p.name || p.title,
        nameEn: p.name_en || '',
        description: p.description || '',
        descriptionEn: p.description_en || '',
        priceUsdt: parseFloat(p.price || p.price_usdt || 0),
        stock: p.stock !== undefined ? p.stock : (p.in_stock ? 99 : 0),
        category: p.category_name || p.category || 'Canboso Digital',
        icon: '🌐',
      })),
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
 */
const createOrder = async (apiKey, { productCode, quantity = 1, idempotencyKey }) => {
  try {
    const res = await axios.post(
      `${BASE_URL}/v1/orders`,
      {
        product_code: productCode,
        quantity: quantity,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': String(idempotencyKey),
        },
        timeout: 25000,
      }
    );

    return {
      success: true,
      orderNumber: res.data?.id || res.data?.order_id,
      deliveryData: res.data?.content || res.data?.keys || res.data?.data || JSON.stringify(res.data),
      status: res.data?.status || 'completed',
      raw: res.data,
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
};

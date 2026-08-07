const axios = require('axios');

const BASE_URL = 'https://akunding.shop/api/v1';

/**
 * Получение профиля и баланса Akunding Store
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    return {
      success: true,
      balance: parseFloat(res.data?.balance || res.data?.usdt || 0),
      username: res.data?.username || res.data?.email || 'Akunding Reseller',
      raw: res.data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message || 'Ошибка подключения к Akunding API',
    };
  }
};

/**
 * Получение каталога товаров от Akunding Store
 */
const getProducts = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/products?include_out_of_stock=false`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const items = Array.isArray(res.data) ? res.data : (res.data?.products || []);
    return {
      success: true,
      products: items.map((p) => {
        let stockVal = 0;
        if (p.is_available === false || p.in_stock === false || p.status === 'out_of_stock' || p.status === 'disabled') {
          stockVal = 0;
        } else if (p.stock !== undefined && p.stock !== null && !isNaN(Number(p.stock))) {
          stockVal = Number(p.stock);
        } else if (p.quantity !== undefined && p.quantity !== null && !isNaN(Number(p.quantity))) {
          stockVal = Number(p.quantity);
        } else if (p.count !== undefined && p.count !== null && !isNaN(Number(p.count))) {
          stockVal = Number(p.count);
        } else if (p.in_stock === true) {
          stockVal = 1;
        }

        return {
          productCode: String(p.id || p.product_id),
          name: p.name || p.title,
          nameEn: p.name_en || '',
          description: p.description || '',
          descriptionEn: p.description_en || '',
          priceUsdt: parseFloat(p.price || p.price_usdt || 0),
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: p.category_name || p.category || 'Akunding Accounts',
          icon: '🛒',
        };
      }),
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message || 'Не удалось получить каталог Akunding',
      products: [],
    };
  }
};

/**
 * Автоматический выкуп заказа у Akunding Store
 */
const createOrder = async (apiKey, { productCode, quantity = 1, idempotencyKey }) => {
  try {
    const res = await axios.post(
      `${BASE_URL}/orders`,
      {
        product_id: parseInt(productCode, 10) || productCode,
        quantity: parseInt(quantity, 10) || 1,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': String(idempotencyKey),
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
      error: err.response?.data?.detail || err.response?.data?.message || err.message,
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
};

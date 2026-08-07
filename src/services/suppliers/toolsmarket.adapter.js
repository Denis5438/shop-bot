const axios = require('axios');

const BASE_URL = 'https://api.toolsmarket.online/api/v1';

/**
 * Получение баланса ToolsMarket
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/balance`, {
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    return {
      success: true,
      balance: parseFloat(res.data?.balance || 0),
      username: res.data?.username || 'ToolsMarket Reseller',
      successCount: res.data?.success_count || 0,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || 'Ошибка подключения к ToolsMarket API',
    };
  }
};

/**
 * Получение каталога товаров от ToolsMarket
 */
const getProducts = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const items = Array.isArray(res.data) ? res.data : (res.data?.products || []);
    return {
      success: true,
      products: items.map((p) => ({
        productCode: String(p.id || p.product_id || p.code),
        name: p.name || p.title,
        nameEn: p.name_en || '',
        description: p.description || '',
        descriptionEn: p.description_en || '',
        priceUsdt: parseFloat(p.price || p.price_usdt || p.cost || 0),
        stock: p.stock || (p.available ? 99 : 0),
        category: p.category || 'Tools & Activations',
        icon: '⚡',
      })),
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message || 'Не удалось получить каталог ToolsMarket',
      products: [],
    };
  }
};

/**
 * Автоматический выкуп товара у ToolsMarket
 */
const createOrder = async (apiKey, { productCode, quantity = 1, email = null }) => {
  try {
    const res = await axios.post(
      `${BASE_URL}/buy`,
      {
        product_id: productCode,
        quantity: quantity,
        email: email,
      },
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );

    return {
      success: true,
      orderNumber: res.data?.order_id || res.data?.job_id || res.data?.id,
      deliveryData: res.data?.key || res.data?.account || res.data?.result || JSON.stringify(res.data),
      status: 'completed',
      raw: res.data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.response?.data?.detail || err.message,
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
};

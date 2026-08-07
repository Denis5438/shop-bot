const axios = require('axios');

const BASE_URL = 'https://api.jahadigital.shop/v1';

/**
 * Получение баланса аккаунта в Jaha Digital
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/account`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    return {
      success: true,
      balance: parseFloat(res.data?.balance || res.data?.usdt_balance || 0),
      username: res.data?.username || res.data?.telegram_id || 'Jaha Reseller',
      raw: res.data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message || 'Ошибка подключения к Jaha API',
    };
  }
};

/**
 * Получение всех доступных товаров от Jaha Digital
 */
const getProducts = async (apiKey) => {
  try {
    let allProducts = [];
    let cursor = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore && pageCount < 5) {
      pageCount++;
      const url = cursor
        ? `${BASE_URL}/products?limit=100&cursor=${encodeURIComponent(cursor)}`
        : `${BASE_URL}/products?limit=100`;

      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      });

      const data = res.data;
      const items = Array.isArray(data) ? data : (data.items || data.products || []);
      allProducts = allProducts.concat(items);

      if (data.next_cursor) {
        cursor = data.next_cursor;
      } else {
        hasMore = false;
      }
    }

    return {
      success: true,
      products: allProducts.map((p) => {
        let stockVal = 0;
        if (p.stock_count !== undefined && p.stock_count !== null) stockVal = Number(p.stock_count);
        else if (p.stock !== undefined && p.stock !== null) stockVal = Number(p.stock);
        else if (p.available_count !== undefined && p.available_count !== null) stockVal = Number(p.available_count);
        else if (p.quantity !== undefined && p.quantity !== null) stockVal = Number(p.quantity);
        else if (p.in_stock === true) stockVal = 1;
        else if (p.in_stock === false) stockVal = 0;

        return {
          productCode: p.product_code || p.id || p.code,
          name: p.name || p.title || p.product_name,
          nameEn: p.name_en || p.title_en || '',
          description: p.description || '',
          descriptionEn: p.description_en || '',
          priceUsdt: parseFloat(p.price_usdt || p.price || 0),
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: p.category_name || p.category || 'AI & Digital Tools',
          icon: p.icon || '🤖',
          deliveryType: p.delivery_type || 'instant',
        };
      }),
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message || 'Не удалось получить каталог Jaha',
      products: [],
    };
  }
};

/**
 * Автоматический выкуп заказа у Jaha Digital
 */
const createOrder = async (apiKey, { productCode, quantity = 1, maxUnitPrice = 999, idempotencyKey, externalOrderId }) => {
  try {
    const res = await axios.post(
      `${BASE_URL}/orders`,
      {
        product_code: productCode,
        quantity: quantity,
        max_unit_price_usdt: String(maxUnitPrice),
        external_order_id: String(externalOrderId || idempotencyKey),
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': String(idempotencyKey),
        },
        timeout: 25000,
      }
    );

    return {
      success: true,
      orderNumber: res.data?.order_number || res.data?.order_id || res.data?.id,
      deliveryData: res.data?.delivery || res.data?.keys || res.data?.data || JSON.stringify(res.data),
      status: res.data?.status || 'completed',
      raw: res.data,
    };
  } catch (err) {
    const detail = err.response?.data?.detail || err.response?.data?.message || err.message;
    return {
      success: false,
      error: detail,
      code: err.response?.data?.code || 'purchase_failed',
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
};

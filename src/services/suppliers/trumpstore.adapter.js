const axios = require('axios');

const BASE_URL = 'https://api-ca7cdf16.bug.edu.vn/api/client';

/**
 * Получение баланса Trump Store
 * API: GET /api/client/wallet
 * Auth: Authorization: Bearer <apiKey>
 */
const getBalance = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/wallet`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    const data = res.data;
    // Пробуем разные варианты поля баланса
    const balance = parseFloat(
      data?.balance ?? data?.wallet?.balance ?? data?.usdt ?? data?.amount ?? 0
    );
    return {
      success: true,
      balance,
      username: data?.username || data?.name || data?.email || 'Trump Store Reseller',
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.response?.data?.error || err.message || 'Ошибка подключения к Trump Store API',
    };
  }
};

/**
 * Получение каталога товаров от Trump Store
 * API: GET /api/client/products
 * Auth: Authorization: Bearer <apiKey>
 */
const getProducts = async (apiKey) => {
  try {
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    // Ответ может быть массивом или обёрнут в { data: [...] } / { products: [...] }
    const raw = res.data;
    const items = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.products)
          ? raw.products
          : [];

    return {
      success: true,
      products: items.map((p) => {
        // Определяем остаток
        let stockVal = 0;
        if (p.stock !== undefined && p.stock !== null && !isNaN(Number(p.stock))) {
          stockVal = Number(p.stock);
        } else if (p.quantity !== undefined && p.quantity !== null && !isNaN(Number(p.quantity))) {
          stockVal = Number(p.quantity);
        } else if (p.available_count !== undefined && !isNaN(Number(p.available_count))) {
          stockVal = Number(p.available_count);
        } else if (p.in_stock === true || p.is_available === true) {
          stockVal = 99;
        }

        return {
          productCode: String(p.id || p.product_id || p._id),
          name: p.name || p.title || 'Без названия',
          nameEn: p.name_en || p.name || '',
          description: p.description || '',
          descriptionEn: p.description_en || p.description || '',
          priceUsdt: parseFloat(p.price || p.price_usdt || p.cost || 0),
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: p.category_name || p.category || 'Trump Store',
          icon: '🏛️',
        };
      }),
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.response?.data?.error || err.message || 'Не удалось получить каталог Trump Store',
      products: [],
    };
  }
};

/**
 * Автоматический выкуп заказа у Trump Store
 * API: POST /api/client/orders
 * Auth: Authorization: Bearer <apiKey>
 * Body: { product_id, qty, plan_id, customer_input }
 */
const createOrder = async (apiKey, { productCode, quantity = 1, idempotencyKey, customerEmail }) => {
  try {
    const body = {
      product_id: parseInt(productCode, 10) || productCode,
      qty: parseInt(quantity, 10) || 1,
      plan_id: null,
      customer_input: customerEmail || null,
    };

    const res = await axios.post(`${BASE_URL}/orders`, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    });

    const data = res.data;

    // Проверяем успешность
    if (data?.success === false || data?.error) {
      return {
        success: false,
        error: data?.message || data?.error || 'Trump Store: покупка не удалась',
      };
    }

    // Формируем текст выдачи
    let deliveryData = '';

    // Если в ответе есть аккаунты / ключи
    if (Array.isArray(data?.accounts) && data.accounts.length > 0) {
      deliveryData = data.accounts
        .map((acc, i) => {
          const parts = [];
          if (acc.login || acc.user || acc.email) parts.push(`Login: ${acc.login || acc.user || acc.email}`);
          if (acc.password || acc.pass) parts.push(`Password: ${acc.password || acc.pass}`);
          if (acc.token) parts.push(`Token: ${acc.token}`);
          const prefix = data.accounts.length > 1 ? `#${i + 1}: ` : '';
          return prefix + parts.join(' | ');
        })
        .join('\n');
    } else if (data?.key || data?.account || data?.result || data?.content) {
      deliveryData = String(data.key || data.account || data.result || data.content);
    } else if (data?.data) {
      // Рекурсивно ищем полезные данные
      deliveryData = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
    } else if (data?.order_id || data?.id) {
      deliveryData = `Заказ #${data.order_id || data.id} принят. Ожидайте выдачи.`;
    } else {
      deliveryData = JSON.stringify(data);
    }

    return {
      success: true,
      orderNumber: data?.order_id || data?.id || data?.orderCode,
      deliveryData,
      status: data?.status || 'completed',
      raw: data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.response?.data?.error || err.message,
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
};

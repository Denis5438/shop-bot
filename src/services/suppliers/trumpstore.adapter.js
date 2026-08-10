const axios = require('axios');

const BASE_URL = 'https://api-ca7cdf16.bug.edu.vn/api/client';
// Курс VND к USD / USDT (по курсу из бота Trump Store)
const VND_TO_USD_RATE = 26129.0;

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
    const rawBal = parseFloat(
      data?.data?.balance ?? data?.balance ?? data?.wallet?.balance ?? data?.usdt ?? data?.amount ?? 0
    );
    // Конвертируем баланс из VND в USD
    const balance = rawBal > 0 ? Math.round((rawBal / VND_TO_USD_RATE) * 100) / 100 : 0;
    return {
      success: true,
      balance,
      username: data?.data?.chat_id ? `Trump User #${data.data.chat_id}` : (data?.username || 'Trump Store Reseller'),
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
        // Определяем остаток из API (Trump Store использует stock_count)
        let stockVal = 0;
        if (p.stock_count !== undefined && p.stock_count !== null && !isNaN(Number(p.stock_count))) {
          stockVal = Number(p.stock_count);
        } else if (p.stock !== undefined && p.stock !== null && !isNaN(Number(p.stock))) {
          stockVal = Number(p.stock);
        } else if (p.quantity !== undefined && p.quantity !== null && !isNaN(Number(p.quantity))) {
          stockVal = Number(p.quantity);
        } else if (p.available_count !== undefined && !isNaN(Number(p.available_count))) {
          stockVal = Number(p.available_count);
        } else if (p.in_stock === true || p.is_available === true) {
          stockVal = 99;
        }

        // Конвертируем оптовую цену из VND в USD (USDT)
        const rawPrice = parseFloat(p.price || p.price_usdt || p.cost || 0);
        const priceUsdt = rawPrice > 1000 ? Math.round((rawPrice / VND_TO_USD_RATE) * 100) / 100 : rawPrice;

        return {
          productCode: String(p.id || p.product_id || p._id),
          name: p.name || p.title || 'Без названия',
          nameEn: p.name_en || p.name || '',
          description: p.description || '',
          descriptionEn: p.description_en || p.description || '',
          priceUsdt,
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: p.category || p.category_name || 'Trump Store',
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
    if (data?.success === false || data?.error || data?.ok === false) {
      return {
        success: false,
        error: data?.message || data?.error || 'Trump Store: покупка не удалась',
      };
    }

    // Формируем текст выдачи
    let deliveryData = '';

    const payload = data?.data || data;

    // Если в ответе есть аккаунты / ключи
    if (Array.isArray(payload?.accounts) && payload.accounts.length > 0) {
      deliveryData = payload.accounts
        .map((acc, i) => {
          const parts = [];
          if (acc.login || acc.user || acc.email) parts.push(`Login: ${acc.login || acc.user || acc.email}`);
          if (acc.password || acc.pass) parts.push(`Password: ${acc.password || acc.pass}`);
          if (acc.token) parts.push(`Token: ${acc.token}`);
          const prefix = payload.accounts.length > 1 ? `#${i + 1}: ` : '';
          return prefix + parts.join(' | ');
        })
        .join('\n');
    } else if (payload?.key || payload?.account || payload?.result || payload?.content) {
      deliveryData = String(payload.key || payload.account || payload.result || payload.content);
    } else if (payload?.data) {
      deliveryData = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data);
    } else if (payload?.order_id || payload?.id) {
      deliveryData = `Заказ #${payload.order_id || payload.id} принят. Ожидайте выдачи.`;
    } else {
      deliveryData = JSON.stringify(payload);
    }

    return {
      success: true,
      orderNumber: payload?.order_id || payload?.id || payload?.orderCode,
      deliveryData,
      status: payload?.status || 'completed',
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

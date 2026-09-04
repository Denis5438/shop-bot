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
    const acc = res.data?.account || res.data || {};
    const rawBalance = acc.balance_usdt ?? acc.balance ?? acc.usdt_balance ?? res.data?.balance_usdt ?? res.data?.balance ?? 0;
    return {
      success: true,
      balance: parseFloat(rawBalance) || 0,
      username: acc.client_id || acc.username || acc.telegram_id || 'Jaha Reseller',
      currency: acc.currency || 'USDT',
      status: acc.status || 'active',
      raw: res.data,
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message || 'Ошибка подключения к Jaha API',
    };
  }
};

const formatError = (err) => {
  const data = err.response?.data;
  if (!data) return err.message || 'Ошибка подключения к Jaha API';
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) {
    return data.detail.map((e) => {
      const loc = Array.isArray(e.loc) ? e.loc.filter((l) => l !== 'body').join('.') : '';
      return `${loc ? loc + ': ' : ''}${e.msg || 'некорректное значение'}`;
    }).join('; ');
  }
  if (data.message) return data.message;
  return err.message || 'Неизвестная ошибка Jaha API';
};

/**
 * Получение всех доступных товаров от Jaha Digital
 * @param {string} apiKey - API ключ
 * @param {Object} options - { currentOnly: boolean }
 */
const getProducts = async (apiKey, options = {}) => {
  try {
    const currentOnly = options.currentOnly !== false;
    let allProducts = [];
    let cursor = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore && pageCount < 50) {
      pageCount++;
      const params = new URLSearchParams({ limit: '100' });
      if (currentOnly) params.set('current_only', 'true');
      if (cursor) params.set('cursor', cursor);

      const url = `${BASE_URL}/products?${params.toString()}`;

      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      });

      const data = res.data;
      const items = Array.isArray(data) ? data : (data.items || data.products || data.data || []);
      if (items.length === 0) {
        hasMore = false;
        break;
      }
      allProducts = allProducts.concat(items);

      const nextCur = data.next_cursor || data.cursor || data.next;
      if (nextCur && nextCur !== cursor) {
        cursor = nextCur;
      } else {
        hasMore = false;
      }
    }

    return {
      success: true,
      products: allProducts.map((p) => {
        let stockVal = 0;
        const status = String(p.status || '').toLowerCase();
        // По официальной документации Jaha: покупаемыми считаются только позиции со status=available и available > 0
        if (status === 'available' || status === 'in_stock') {
          if (typeof p.available === 'number') stockVal = p.available;
          else if (typeof p.stock === 'number') stockVal = p.stock;
          else if (typeof p.quantity === 'number') stockVal = p.quantity;
          else if (typeof p.count === 'number') stockVal = p.count;
          else if (typeof p.stock_count === 'number') stockVal = p.stock_count;
          else if (typeof p.available_count === 'number') stockVal = p.available_count;
          else stockVal = 1;
        } else {
          stockVal = 0;
        }

        // Интеллектуальное определение категории по названию товара, если категория не указана
        const prodName = p.name || p.title || p.product_name || '';
        let detectedCategory = p.category_name || p.category || p.category_title || p.group || p.section || '';

        if (!detectedCategory || detectedCategory === 'AI & Digital Tools' || detectedCategory === 'Внешние товары') {
          const lower = prodName.toLowerCase();
          if (lower.includes('chatgpt') || lower.includes('gpt') || lower.includes('openai')) detectedCategory = 'ChatGPT';
          else if (lower.includes('claude')) detectedCategory = 'Claude';
          else if (lower.includes('canva')) detectedCategory = 'Canva';
          else if (lower.includes('veo')) detectedCategory = 'Veo';
          else if (lower.includes('cdk')) detectedCategory = 'CDK';
          else if (lower.includes('youtube')) detectedCategory = 'Youtube';
          else if (lower.includes('netflix')) detectedCategory = 'Netflix';
          else if (lower.includes('spotify')) detectedCategory = 'Spotify';
          else if (lower.includes('capcut')) detectedCategory = 'CapCut';
          else if (lower.includes('cursor')) detectedCategory = 'Cursor';
          else if (lower.includes('zoom')) detectedCategory = 'Zoom';
          else if (lower.includes('windows') || lower.includes('key win')) detectedCategory = 'Key Windows';
          else if (lower.includes('office')) detectedCategory = 'Office 365';
          else if (lower.includes('gemini')) detectedCategory = 'Gemini';
          else if (lower.includes('api')) detectedCategory = 'API';
          else if (lower.includes('open art') || lower.includes('openart')) detectedCategory = 'Open Art';
          else if (lower.includes('coursera')) detectedCategory = 'Coursera';
          else if (lower.includes('steam')) detectedCategory = 'Steam';
          else if (lower.includes('vpn')) detectedCategory = 'VPN';
          else if (lower.includes('figma')) detectedCategory = 'Figma';
          else if (lower.includes('discord')) detectedCategory = 'Discord';
          else if (lower.includes('kling')) detectedCategory = 'Kling AI';
          else if (lower.includes('elevenlabs') || lower.includes('eleven')) detectedCategory = 'ElevenLabs';
          else if (lower.includes('gamma')) detectedCategory = 'Gamma';
          else if (lower.includes('manus')) detectedCategory = 'Manus';
          else if (lower.includes('lovable')) detectedCategory = 'Lovable';
          else if (lower.includes('leonardo')) detectedCategory = 'Leonardo AI';
          else if (lower.includes('heygen')) detectedCategory = 'HeyGen';
          else if (lower.includes('grok')) detectedCategory = 'Grok';
          else if (lower.includes('adobe')) detectedCategory = 'Adobe';
          else if (lower.includes('suno')) detectedCategory = 'Suno';
          else if (lower.includes('perplexity')) detectedCategory = 'Perplexity';
          else if (lower.includes('higgsfield')) detectedCategory = 'Higgsfield';
          else if (lower.includes('kiro')) detectedCategory = 'Kiro';
          else if (lower.includes('kimi')) detectedCategory = 'Kimi';
          else if (lower.includes('github') || lower.includes('copilot')) detectedCategory = 'GitHub';
          else if (lower.includes('twitter') || lower.includes(' x ')) detectedCategory = 'X / Twitter';
          else detectedCategory = detectedCategory || 'AI & Digital Tools';
        }

        return {
          productCode: p.code || p.product_code || p.id,
          name: prodName,
          nameEn: p.name_en || p.title_en || '',
          description: p.description || '',
          descriptionEn: p.description_en || '',
          priceUsdt: parseFloat(p.price_usdt || p.price || 0),
          stock: isNaN(stockVal) ? 0 : Math.max(0, stockVal),
          category: detectedCategory,
          icon: p.icon || '🤖',
          deliveryType: p.delivery_type || 'instant',
        };
      }),
    };
  } catch (err) {
    return {
      success: false,
      error: formatError(err),
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

    const orderData = res.data;
    const delivery = orderData?.delivery || orderData?.keys || orderData?.key || orderData?.account || orderData?.data || orderData?.content;
    const orderNum = orderData?.order_number || orderData?.order_id || orderData?.id;
    const status = orderData?.status || (delivery ? 'completed' : 'processing');

    return {
      success: true,
      orderNumber: orderNum,
      deliveryData: delivery ? String(delivery) : (orderNum ? `Заказ поставщика: #${orderNum}` : null),
      status,
      raw: orderData,
    };
  } catch (err) {
    const detail = formatError(err);
    return {
      success: false,
      error: detail,
      code: err.response?.data?.code || 'purchase_failed',
    };
  }
};

/**
 * Проверка статуса и получение выданного товара по номеру заказа в Jaha Digital
 */
const getOrder = async (apiKey, orderNumber) => {
  try {
    const res = await axios.get(`${BASE_URL}/orders/${encodeURIComponent(orderNumber)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const orderData = res.data;
    const delivery = orderData?.delivery || orderData?.keys || orderData?.key || orderData?.account || orderData?.data || orderData?.content;
    const status = orderData?.status || (delivery ? 'completed' : 'processing');

    return {
      success: true,
      orderNumber: orderData?.order_number || orderNumber,
      status,
      deliveryData: delivery ? String(delivery) : null,
      raw: orderData,
    };
  } catch (err) {
    return {
      success: false,
      error: formatError(err),
    };
  }
};

module.exports = {
  getBalance,
  getProducts,
  createOrder,
  getOrder,
};

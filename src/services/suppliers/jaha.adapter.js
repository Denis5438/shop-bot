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
  if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  return err.message || 'Неизвестная ошибка Jaha API';
};

/**
 * Интеллектуальное определение срока действия подписки и срока гарантии
 * из названия (title) и описания (description) товара
 */
const parseSubscriptionAndWarranty = (name = '', description = '') => {
  const cleanName = (name || '').trim();
  const lowerName = cleanName.toLowerCase();
  // Очищаем описание от возможных длинных UUID/хэшей
  const cleanDesc = (description || '').replace(/[a-f0-9]{4,}-[a-f0-9-]{10,}/gi, '');
  const lowerDesc = cleanDesc.toLowerCase();

  // 1. ОПРЕДЕЛЕНИЕ СРОКА ПОДПИСКИ (subscriptionDays)
  let subscriptionDays = null;

  // Очищаем название от упоминаний гарантии, чтобы они не сбивали парсинг подписки
  const nameWithoutWarranty = lowerName
    .replace(/\([^)]*(?:warranty|гарант|w\d|nw|fw)[^)]*\)/g, '')
    .replace(/\[[^\]]*(?:warranty|гарант|w\d|nw|fw)[^\]]*\]/g, '')
    .replace(/warranty\s*24\s*h/g, '')
    .replace(/w24h/g, '')
    .replace(/\b\d+\s*(?:d|day|days|дн|дней|день)\s*warranty\b/g, '')
    .replace(/warranty\s*\d+\s*[a-zа-я]+/g, '')
    .replace(/гарантия\s*\d+\s*[a-zа-я]+/g, '')
    .replace(/-\s*full warranty/g, '')
    .replace(/full warranty/g, '');

  // 1.1 Диапазон месяцев (например, 17-18 months, 2-4 месяца)
  const nameRangeMatch = nameWithoutWarranty.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:month|months|m|мес|месяц|месяца|месяцев)/i);
  if (nameRangeMatch) {
    const avg = (parseInt(nameRangeMatch[1]) + parseInt(nameRangeMatch[2])) / 2;
    subscriptionDays = Math.round(avg * 30);
  }

  // 1.2 Годы в названии (1-5 years, 1Y, 1-5 лет, 3 года)
  if (!subscriptionDays) {
    const yearMatch = nameWithoutWarranty.match(/(?:^|\s|\b)([1-5])\s*(?:year|years|y|год|года|лет)(?=$|\s|[^\p{L}\p{N}])/iu);
    if (yearMatch) {
      subscriptionDays = parseInt(yearMatch[1]) * 365;
    }
  }

  // 1.3 Месяцы в названии: 1 Month, 3 Months, 18M, 1M, 3M, 6M, 12M
  if (!subscriptionDays) {
    const monthWordsMatch = nameWithoutWarranty.match(/(?:^|\s|\b)([1-9]|[1-3]\d)\s*(?:month|months|мес|месяц|месяца|месяцев)(?=$|\s|[^\p{L}\p{N}])/iu);
    if (monthWordsMatch) {
      subscriptionDays = parseInt(monthWordsMatch[1]) * 30;
    } else {
      // Краткая запись: 1M..36M, исключая Credit, Token, Cre, Balance, Model
      const shortMMatch = nameWithoutWarranty.match(/\b([1-9]|[1-3]\d)\s*m\b(?!\s*(?:credit|token|cre|balance|point|req|model))/);
      if (shortMMatch) {
        subscriptionDays = parseInt(shortMMatch[1]) * 30;
      }
    }
  }

  // 1.4 Дни в названии: 1 Day, 7 Days, 30 Days, 3D, 7D, 30D, 24H
  if (!subscriptionDays) {
    if (/\b24\s*h(ours)?\b/.test(nameWithoutWarranty)) {
      subscriptionDays = 1;
    } else {
      const dayMatch = nameWithoutWarranty.match(/(?:^|\s|\b)(\d{1,3})\s*(?:day|days|дн|дней|день|d)(?=$|\s|[^\p{L}\p{N}])/iu);
      if (dayMatch && parseInt(dayMatch[1]) <= 365) {
        subscriptionDays = parseInt(dayMatch[1]);
      }
    }
  }

  // 1.5 Поиск в описании, если в названии не указано явно
  if (!subscriptionDays) {
    const descTermMatch = cleanDesc.match(/(?:срок|период|длительность|подписка на|duration|period)[\s:]*(\d{1,3})\s*(месяц|месяца|месяцев|month|months|m|дн|дней|день|days|d|год|года|лет|year|years|y)/iu);
    if (descTermMatch) {
      const num = parseInt(descTermMatch[1]);
      const unit = descTermMatch[2].toLowerCase();
      if (unit.startsWith('мес') || unit.startsWith('m')) {
        subscriptionDays = num <= 36 ? num * 30 : 30;
      } else if (unit.startsWith('дн') || unit.startsWith('d') || unit.startsWith('ден')) {
        subscriptionDays = num <= 365 ? num : 30;
      } else if (unit.startsWith('год') || unit.startsWith('лет') || unit.startsWith('y')) {
        subscriptionDays = num <= 5 ? num * 365 : 365;
      }
    }
  }

  if (!subscriptionDays || subscriptionDays <= 0) {
    subscriptionDays = 30;
  }

  // 2. ОПРЕДЕЛЕНИЕ СРОКА ГАРАНТИИ (warrantyDays)
  let warrantyDays = null;

  // 2.0 Проверка на ЧАСЫ в названии (W12H, [W12H], (W6H), W24H, 12 hours warranty, 12 ч. гарантия и т.д.):
  const hourTagMatch = cleanName.match(/(?:^|\s|\[|\()w(\d+)\s*h(?:our|ours)?(?:\b|\]|\))/i);
  const hourPhraseMatch = lowerName.match(/(?:(\d+)\s*(?:h|hours?|ч|часа?|часов)\s*(?:warranty|гаранти[яи]))|(?:(?:warranty|гаранти[яи])\s*[:\s]*(\d+)\s*(?:h|hours?|ч|часа?|часов))/iu);
  if (hourTagMatch) {
    const hours = parseInt(hourTagMatch[1], 10);
    warrantyDays = hours / 24;
  } else if (hourPhraseMatch) {
    const hours = parseInt(hourPhraseMatch[1] || hourPhraseMatch[2], 10);
    warrantyDays = hours / 24;
  } else if (/\b(nw|no[-\s]?warranty)\b/i.test(lowerName) || /\[nw\]|\(nw\)/i.test(cleanName) || /без гарантии/iu.test(lowerName)) {
    warrantyDays = 0;
  } else if (
    /\bw(\d+)\s*d?\b/i.test(cleanName) ||
    /\(w(\d+)d?\)/i.test(cleanName) ||
    /\[w(\d+)d?\]/i.test(cleanName)
  ) {
    const m = cleanName.match(/w(\d+)\s*d?/i);
    if (m) warrantyDays = parseInt(m[1], 10);
  } else if (/(\d+)\s*(?:d|day|days|дн|дней|день)\s*warranty/iu.test(lowerName) || /warranty\s*[:\s]*(\d+)\s*(?:d|day|days|дн|дней|день)/iu.test(lowerName)) {
    const m = lowerName.match(/(\d+)\s*(?:d|day|days|дн|дней|день)\s*warranty/iu) || lowerName.match(/warranty\s*[:\s]*(\d+)\s*(?:d|day|days|дн|дней|день)/iu);
    if (m) warrantyDays = parseInt(m[1], 10);
  } else if (/warranty\s*[:\s]*(\d+)\s*(?:month|months|m|мес|месяц|месяца|месяцев)/iu.test(lowerName)) {
    const m = lowerName.match(/warranty\s*[:\s]*(\d+)\s*(?:month|months|m|мес|месяц|месяца|месяцев)/iu);
    if (m) warrantyDays = parseInt(m[1], 10) * 30;
  } else if (/warranty\s*[:\s]*(\d+)\s*(?:year|years|y|год|года|лет)/iu.test(lowerName)) {
    const m = lowerName.match(/warranty\s*[:\s]*(\d+)\s*(?:year|years|y|год|года|лет)/iu);
    if (m) warrantyDays = parseInt(m[1], 10) * 365;
  } else if (
    /\b(fw|full[-\s]?warranty|fully covered|fully guaranteed|полная гарантия)\b/iu.test(lowerName) ||
    /\[fw\]|\(fw\)/i.test(cleanName)
  ) {
    warrantyDays = subscriptionDays;
  } else if (/warranty\s*24\s*h/i.test(lowerName) || /w24h/i.test(lowerName)) {
    warrantyDays = 1;
  }

  // 2.2 Проверка в ОПИСАНИИ:
  if (warrantyDays === null) {
    const descHourMatch = lowerDesc.match(/(?:warranty|гарантия)[\s:]*(\d+)\s*(?:h|hours?|ч|часа?|часов)/iu);
    if (descHourMatch) {
      const hours = parseInt(descHourMatch[1], 10);
      warrantyDays = hours / 24;
    } else if (/\b(nw|no[-\s]?warranty)\b/i.test(lowerDesc) || /без гарантии/iu.test(lowerDesc)) {
      warrantyDays = 0;
    } else if (
      /\b(fw|full[-\s]?warranty|fully covered|fully guaranteed|полная гарантия|гарантия на весь срок)\b/iu.test(lowerDesc) ||
      /гарантия\s*(?:на\s*)?подписку/iu.test(lowerDesc)
    ) {
      warrantyDays = subscriptionDays;
    } else if (/(?:warranty|гарантия)[\s:]*(\d+)\s*(?:day|days|дн|дней|день)/iu.test(lowerDesc)) {
      const m = lowerDesc.match(/(?:warranty|гарантия)[\s:]*(\d+)\s*(?:day|days|дн|дней|день)/iu);
      if (m) warrantyDays = parseInt(m[1], 10);
    } else if (/(?:warranty|гарантия)[\s:]*(\d+)\s*(?:month|months|мес|месяц|месяца)/iu.test(lowerDesc)) {
      const m = lowerDesc.match(/(?:warranty|гарантия)[\s:]*(\d+)\s*(?:month|months|мес|месяц|месяца)/iu);
      if (m) warrantyDays = parseInt(m[1], 10) * 30;
    } else if (/гарантия активации/iu.test(lowerDesc)) {
      warrantyDays = 1;
    }
  }

  // 2.3 Значение по умолчанию:
  if (warrantyDays === null) {
    if (subscriptionDays === 1) {
      warrantyDays = 1;
    } else {
      warrantyDays = 5;
    }
  }

  // Защита: гарантия не может превышать срок действия
  if (warrantyDays > subscriptionDays) {
    warrantyDays = subscriptionDays;
  }

  return { subscriptionDays, warrantyDays };
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

        const durationInfo = parseSubscriptionAndWarranty(prodName, p.description || '');

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
          warrantyDays: durationInfo.warrantyDays,
          subscriptionDays: durationInfo.subscriptionDays,
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
 * Рекурсивное извлечение текстовых данных выданного товара из произвольной структуры ответа Jaha Digital
 */
const extractItemDelivery = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof val === 'number') {
    return String(val);
  }
  if (Array.isArray(val)) {
    const parts = val.map(extractItemDelivery).filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (typeof val === 'object') {
    // 1. Структура логин / пароль / 2fa
    const login = (typeof val.login === 'string' && val.login.trim()) ||
                  (typeof val.email === 'string' && val.email.trim()) ||
                  (typeof val.username === 'string' && val.username.trim()) ||
                  (typeof val.user === 'string' && val.user.trim()) ||
                  (typeof val.account === 'string' && val.account.trim() && (val.password || val.pass) ? val.account.trim() : null);

    const password = (typeof val.password === 'string' && val.password.trim()) ||
                     (typeof val.pass === 'string' && val.pass.trim()) ||
                     (typeof val.password === 'number' ? String(val.password) : null) ||
                     (typeof val.pass === 'number' ? String(val.pass) : null);

    const secret = (typeof val.secret === 'string' && val.secret.trim()) ||
                   (typeof val.totp === 'string' && val.totp.trim()) ||
                   (typeof val.otp === 'string' && val.otp.trim()) ||
                   (typeof val.two_factor === 'string' && val.two_factor.trim()) ||
                   (typeof val['2fa'] === 'string' && val['2fa'].trim()) ||
                   (typeof val.twoFactor === 'string' && val.twoFactor.trim()) ||
                   (typeof val.two_factor_secret === 'string' && val.two_factor_secret.trim()) ||
                   (typeof val.twoFactorSecret === 'string' && val.twoFactorSecret.trim()) ||
                   (typeof val.secret_key === 'string' && val.secret_key.trim()) ||
                   (typeof val.secretKey === 'string' && val.secretKey.trim()) ||
                   (typeof val.code === 'string' && val.code.trim()) ||
                   (typeof val.code === 'number' ? String(val.code) : null);

    if (login && password) {
      return [login, password, secret].filter(Boolean).join(' | ');
    }

    // 2. Прямые ключи с контентом/данными
    const directKeys = [
      'delivery', 'delivery_data', 'delivered_data', 'additions', 'addition', 'order_additions',
      'items', 'item', 'keys', 'key', 'account', 'account_details', 'credentials', 'credential',
      'fulfillment', 'result', 'data', 'content', 'text', 'value', 'code', 'codes',
      'token', 'tokens', 'details', 'license', 'licenses'
    ];
    for (const k of directKeys) {
      if (val[k] !== undefined && val[k] !== null && val[k] !== '') {
        const res = extractItemDelivery(val[k]);
        if (res) return res;
      }
    }
  }
  return null;
};

const extractDeliveryData = (orderData) => {
  if (!orderData || typeof orderData !== 'object') return null;

  // Прямые поля верхнего уровня
  const candidateKeys = [
    'delivery',
    'delivery_data',
    'delivered_data',
    'additions',
    'addition',
    'order_additions',
    'items',
    'item',
    'keys',
    'key',
    'account',
    'account_details',
    'credentials',
    'credential',
    'fulfillment',
    'result',
    'data',
    'content',
    'text',
    'value',
    'codes',
    'code',
    'token',
    'tokens',
    'details',
    'license',
    'licenses',
  ];

  for (const k of candidateKeys) {
    if (orderData[k] !== undefined && orderData[k] !== null && orderData[k] !== '') {
      const res = extractItemDelivery(orderData[k]);
      if (res) return res;
    }
  }

  // Если данные завернуты в orderData.order
  if (orderData.order && typeof orderData.order === 'object') {
    const res = extractDeliveryData(orderData.order);
    if (res) return res;
  }

  // Если данные завернуты в orderData.data
  if (orderData.data && typeof orderData.data === 'object' && !Array.isArray(orderData.data)) {
    const res = extractDeliveryData(orderData.data);
    if (res) return res;
  }

  return null;
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

    const orderData = res.data?.order || res.data;
    const orderNum = orderData?.order_number || orderData?.order_id || orderData?.id || res.data?.order_number || res.data?.order_id;
    let deliveryStr = extractDeliveryData(res.data) || extractDeliveryData(orderData);

    if (!deliveryStr && orderNum) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let orderRes = await getOrder(apiKey, orderNum);
      if (orderRes && orderRes.success && orderRes.deliveryData) {
        deliveryStr = orderRes.deliveryData;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        orderRes = await getOrder(apiKey, orderNum);
        if (orderRes && orderRes.success && orderRes.deliveryData) {
          deliveryStr = orderRes.deliveryData;
        }
      }
    }

    const rawStatus = String(orderData?.status || res.data?.status || '').toLowerCase();
    const status = deliveryStr ? 'completed' : (rawStatus || 'processing');

    return {
      success: true,
      orderNumber: orderNum,
      deliveryData: deliveryStr || null,
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
 * Проверка статуса и получение выданного товара по номеру заказа в Jaha Digital.
 * Передаёт query-параметр include_additions=true, чтобы Jaha возвращал добавленные
 * поставщиком данные при не-мгновенной выдаче.
 */
const getOrder = async (apiKey, orderNumber) => {
  try {
    let res;
    try {
      res = await axios.get(`${BASE_URL}/orders/${encodeURIComponent(orderNumber)}?include_additions=true`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      });
    } catch (errWithAdditions) {
      if (errWithAdditions.response && errWithAdditions.response.status >= 400 && errWithAdditions.response.status < 500) {
        // Fallback без query param если эндпоинт отклонил параметр
        res = await axios.get(`${BASE_URL}/orders/${encodeURIComponent(orderNumber)}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          timeout: 15000,
        });
      } else {
        throw errWithAdditions;
      }
    }

    const orderData = res.data?.order || res.data;
    const deliveryStr = extractDeliveryData(res.data) || extractDeliveryData(orderData);
    const rawStatus = String(orderData?.status || res.data?.status || '').toLowerCase();
    const status = deliveryStr ? 'completed' : (rawStatus || 'processing');

    return {
      success: true,
      orderNumber: orderData?.order_number || orderNumber,
      status,
      deliveryData: deliveryStr || null,
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
  parseSubscriptionAndWarranty,
  extractDeliveryData,
};

/**
 * Клиентский API модуль для взаимодействия с бекендом через relative URL /api/v1
 * Поддерживает автоматическую отправку и прием httpOnly cookies (credentials: 'include')
 */

const API_BASE = '/api/v1';

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include', // автоматическая передача auth_token cookie
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || data.error || 'Ошибка запроса к серверу');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// ─── Авторизация через Telegram ─────────────────────────────────────
export const authApi = {
  // Получение deep-link и sessionToken для Telegram
  getSession: () => request('/auth/session', { method: 'POST' }),

  // Проверка 6-значного кода
  verifyCode: (sessionToken, code) =>
    request('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ sessionToken, code }),
    }),

  // Polling статуса (для мгновенного 1-клик входа из бота)
  checkStatus: (token) => request(`/auth/check-status?token=${encodeURIComponent(token)}`),

  // Текущий профиль пользователя
  getMe: () => request('/auth/me'),

  // Выход из системы
  logout: () => request('/auth/logout', { method: 'POST' }),
};

// ─── Каталог и товары ───────────────────────────────────────────────
export const catalogApi = {
  getCategories: () => request('/catalog/categories'),

  getProducts: (params = {}) => {
    const query = new URLSearchParams();
    if (params.categoryId && params.categoryId !== 'all') query.set('categoryId', params.categoryId);
    if (params.search) query.set('search', params.search);
    if (params.type) query.set('type', params.type);
    if (params.sort) query.set('sort', params.sort);
    if (params.page) query.set('page', params.page);
    if (params.limit) query.set('limit', params.limit);
    return request(`/catalog/products?${query.toString()}`);
  },

  getProductById: (id) => request(`/catalog/products/${id}`),
};

// ─── Корзина ────────────────────────────────────────────────────────
export const cartApi = {
  getCart: () => request('/cart'),

  addItem: (productId, qty = 1) =>
    request('/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, qty }),
    }),

  updateQty: (productId, qty) =>
    request(`/cart/items/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify({ qty }),
    }),

  removeItem: (productId) =>
    request(`/cart/items/${productId}`, {
      method: 'DELETE',
    }),

  clearCart: () =>
    request('/cart', {
      method: 'DELETE',
    }),

  applyPromo: (code) =>
    request('/cart/promo', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  removePromo: () =>
    request('/cart/promo', {
      method: 'DELETE',
    }),
};

// ─── Заказы и чекаут ────────────────────────────────────────────────
export const ordersApi = {
  checkout: (cartVersion) =>
    request('/orders/checkout', {
      method: 'POST',
      body: JSON.stringify({ cartVersion }),
    }),

  getOrders: (params = {}) => {
    const query = new URLSearchParams();
    if (params.page) query.set('page', params.page);
    if (params.limit) query.set('limit', params.limit);
    if (params.status) query.set('status', params.status);
    return request(`/orders?${query.toString()}`);
  },

  getOrderById: (id) => request(`/orders/${id}`),
};

// ─── Платежи ────────────────────────────────────────────────────────
export const paymentsApi = {
  getMethods: () => request('/payments/methods'),

  // Bybit UID
  createBybitInvoice: (amount, orderId = null) =>
    request('/payments/bybit-uid/create', {
      method: 'POST',
      body: JSON.stringify({ amount, orderId }),
    }),

  getBybitStatus: (invoiceId) => request(`/payments/bybit-uid/status/${invoiceId}`),

  cancelBybitInvoice: (invoiceId) =>
    request(`/payments/bybit-uid/cancel/${invoiceId}`, {
      method: 'POST',
    }),

  checkBybitInvoiceManual: (invoiceId) =>
    request(`/payments/bybit-uid/check/${invoiceId}`, {
      method: 'POST',
    }),

  // Platega СБП
  createPlategaPayment: (amountUsdt, returnUrl = null) =>
    request('/payments/platega/create', {
      method: 'POST',
      body: JSON.stringify({ amountUsdt, returnUrl }),
    }),

  getPlategaStatus: (requestId) => request(`/payments/platega/status/${requestId}`),

  // Crypto
  getCryptoAddresses: () => request('/payments/crypto/addresses'),

  submitCryptoTxid: (network, amount, txid) =>
    request('/payments/crypto/submit', {
      method: 'POST',
      body: JSON.stringify({ network, amount, txid }),
    }),
};

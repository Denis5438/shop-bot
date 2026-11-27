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

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== null && val !== '') {
      query.set(key, String(val));
    }
  });
  const str = query.toString();
  return str ? `?${str}` : '';
}

// ─── Авторизация через Telegram ─────────────────────────────────────
export const authApi = {
  getSession: () => request('/auth/session', { method: 'POST' }),

  verifyCode: (sessionToken, code) =>
    request('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ sessionToken, code }),
    }),

  checkStatus: (token) => request(`/auth/check-status?token=${encodeURIComponent(token)}`),

  getMe: () => request('/auth/me'),

  logout: () => request('/auth/logout', { method: 'POST' }),
};

// ─── Каталог и товары ───────────────────────────────────────────────
export const catalogApi = {
  getMeta: () => request('/catalog/meta'),

  getCategories: () => request('/catalog/categories'),

  getProducts: (params = {}) => {
    const qs = buildQuery({
      categoryId: params.categoryId,
      search: params.search,
      type: params.type,
      origin: params.origin,
      inStock: params.inStock ? 'true' : undefined,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      instantOnly: params.instantOnly ? 'true' : undefined,
      flashOnly: params.flashOnly ? 'true' : undefined,
      sort: params.sort,
      page: params.page,
      limit: params.limit,
    });
    return request(`/catalog/products${qs}`);
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
    const qs = buildQuery({
      page: params.page,
      limit: params.limit,
      status: params.status,
    });
    return request(`/orders${qs}`);
  },

  getOrderById: (id) => request(`/orders/${id}`),
};

// ─── Платежи ────────────────────────────────────────────────────────
export const paymentsApi = {
  getMethods: () => request('/payments/methods'),

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

  createPlategaPayment: (amountUsdt, returnUrl = null) =>
    request('/payments/platega/create', {
      method: 'POST',
      body: JSON.stringify({ amountUsdt, returnUrl }),
    }),

  getPlategaStatus: (requestId) => request(`/payments/platega/status/${requestId}`),

  getCryptoAddresses: () => request('/payments/crypto/addresses'),

  submitCryptoTxid: (network, amount, txid) =>
    request('/payments/crypto/submit', {
      method: 'POST',
      body: JSON.stringify({ network, amount, txid }),
    }),
};

// ─── Админ-панель (/api/v1/admin) ───────────────────────────────────
export const adminApi = {
  // Статистика и логистика
  getStats: (period = 'month') =>
    request(`/admin/stats?period=${encodeURIComponent(period)}`),

  // Товары
  getProducts: (params = {}) =>
    request(`/admin/products${buildQuery(params)}`),

  createProduct: (payload) =>
    request('/admin/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateProduct: (id, payload) =>
    request(`/admin/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  setFlashSale: (id, payload) =>
    request(`/admin/products/${id}/flash-sale`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  cloneProduct: (id) =>
    request(`/admin/products/${id}/clone`, {
      method: 'POST',
    }),

  deleteProduct: (id) =>
    request(`/admin/products/${id}`, {
      method: 'DELETE',
    }),

  // Категории
  getCategories: () => request('/admin/categories'),

  createCategory: (payload) =>
    request('/admin/categories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCategory: (id, payload) =>
    request(`/admin/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteCategory: (id) =>
    request(`/admin/categories/${id}`, {
      method: 'DELETE',
    }),

  // Ключи
  getKeysSummary: () => request('/admin/keys/summary'),

  getProductKeys: (productId, params = {}) =>
    request(`/admin/keys/product/${productId}${buildQuery(params)}`),

  importKeys: (productId, rawText) =>
    request('/admin/keys/import', {
      method: 'POST',
      body: JSON.stringify({ productId, rawText }),
    }),

  deleteKey: (keyId) =>
    request(`/admin/keys/${keyId}`, {
      method: 'DELETE',
    }),

  clearUsedKeys: (productId) =>
    request(`/admin/keys/product/${productId}/clear-used`, {
      method: 'DELETE',
    }),

  // Заказы, споры и гарантия
  getOrders: (params = {}) =>
    request(`/admin/orders${buildQuery(params)}`),

  completeOrder: (id, deliveryData) =>
    request(`/admin/orders/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ deliveryData }),
    }),

  cancelOrder: (id, reason = '') =>
    request(`/admin/orders/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resolveWarranty: (id, payload) =>
    request(`/admin/orders/${id}/warranty`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  resolveDispute: (id, payload) =>
    request(`/admin/orders/${id}/dispute`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Пользователи
  getUsers: (params = {}) =>
    request(`/admin/users${buildQuery(params)}`),

  getUserById: (id) => request(`/admin/users/${id}`),

  adjustUserBalance: (id, payload) =>
    request(`/admin/users/${id}/balance`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateUser: (id, payload) =>
    request(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  sendMessageToUser: (id, text) =>
    request(`/admin/users/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  // Промокоды
  getPromos: () => request('/admin/promos'),

  createPromo: (payload) =>
    request('/admin/promos', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updatePromo: (id, payload) =>
    request(`/admin/promos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deletePromo: (id) =>
    request(`/admin/promos/${id}`, {
      method: 'DELETE',
    }),

  // Поставщики
  getSuppliers: () => request('/admin/suppliers'),

  updateSupplier: (supplierId, payload) =>
    request(`/admin/suppliers/${supplierId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  refreshSupplier: (supplierId) =>
    request(`/admin/suppliers/${supplierId}/refresh`, {
      method: 'POST',
    }),

  syncSupplier: (supplierId) =>
    request(`/admin/suppliers/${supplierId}/sync`, {
      method: 'POST',
    }),

  importSupplier: (supplierId) =>
    request(`/admin/suppliers/${supplierId}/import`, {
      method: 'POST',
    }),

  // Заявки на пополнение и выводы продавцов
  getTopups: (params = {}) =>
    request(`/admin/topups${buildQuery(params)}`),

  approveTopup: (id, note = '') =>
    request(`/admin/topups/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  rejectTopup: (id, reason = '') =>
    request(`/admin/topups/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  getWithdrawals: (params = {}) =>
    request(`/admin/withdrawals${buildQuery(params)}`),

  confirmWithdrawal: (id, reason = '') =>
    request(`/admin/withdrawals/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  rejectWithdrawal: (id, reason = '') =>
    request(`/admin/withdrawals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Массовые операции
  runBulk: (payload) =>
    request('/admin/bulk', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Настройки
  getSettings: () => request('/admin/settings'),

  updateSettings: (payload) =>
    request('/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  refreshCurrencyRate: () =>
    request('/admin/settings/refresh-rate', {
      method: 'POST',
    }),
};

// ─── Единый Центр Поддержки (/api/v1/support) ───────────────────────
export const supportApi = {
  getMeta: () => request('/support/meta'),

  getTickets: (params = {}) =>
    request(`/support/tickets${buildQuery(params)}`),

  createTicket: (payload) =>
    request('/support/tickets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getTicket: (id) => request(`/support/tickets/${id}`),

  replyTicket: (id, payload) =>
    request(`/support/tickets/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  closeTicket: (id) =>
    request(`/support/tickets/${id}/close`, {
      method: 'POST',
    }),

  rateTicket: (id, rating) =>
    request(`/support/tickets/${id}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),

  getMediaUrl: (ticketId, msgId) =>
    `/api/v1/support/tickets/${ticketId}/media/${msgId}`,

  // Сотрудники (support / moderator / admin)
  toggleDuty: () =>
    request('/support/staff/duty', {
      method: 'POST',
    }),

  getQueues: (params = {}) =>
    request(`/support/staff/queues${buildQuery(params)}`),

  getQuickReplies: () => request('/support/staff/quick-replies'),

  takeTicket: (id) =>
    request(`/support/staff/tickets/${id}/take`, {
      method: 'POST',
    }),

  staffReply: (id, payload) =>
    request(`/support/staff/tickets/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  staffEscalate: (id, reason = '') =>
    request(`/support/staff/tickets/${id}/escalate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  staffClose: (id) =>
    request(`/support/staff/tickets/${id}/close`, {
      method: 'POST',
    }),

  // Модерация команды и настройки
  getTeam: () => request('/support/mod/team'),

  getStaffStats: (id, period = '30d') =>
    request(`/support/mod/staff/${id}/stats${buildQuery({ period })}`),

  assignRole: (payload) =>
    request('/support/mod/staff/role', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getAuditLogs: (params = {}) =>
    request(`/support/mod/audit-logs${buildQuery(params)}`),

  getSupportSettings: () => request('/support/mod/settings'),

  updateSupportSettings: (payload) =>
    request('/support/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
};

const { Markup } = require('telegraf');

// Главная клавиатура администратора
const adminMainKeyboard = (counts = { pendingOrders: 0, pendingPayments: 0 }) => {
  const ordersBadge = counts.pendingOrders > 0 ? ` (🔴 ${counts.pendingOrders})` : '';
  const paymentsBadge = counts.pendingPayments > 0 ? ` (🔴 ${counts.pendingPayments})` : '';

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 Товары', 'admin:products'),
      Markup.button.callback('🔑 Ключи', 'admin:keys'),
    ],
    [
      Markup.button.callback(`📋 Заказы${ordersBadge}`, 'admin:orders'),
      Markup.button.callback('👥 Пользователи', 'admin:users'),
    ],
    [
      Markup.button.callback(`💳 Платежи${paymentsBadge}`, 'admin:payments'),
      Markup.button.callback('📊 Статистика', 'admin:stats'),
    ],
    [
      Markup.button.callback('📈 Логистика', 'admin:logistics'),
      Markup.button.callback('📉 Графики продаж', 'admin:chart'),
    ],
    [Markup.button.callback('⚙️ Настройки', 'admin:settings')],
    [Markup.button.callback('🔍 Глобальный Поиск', 'admin:search')],
  ]);
};

const adminBackKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]);

module.exports = { adminMainKeyboard, adminBackKeyboard };

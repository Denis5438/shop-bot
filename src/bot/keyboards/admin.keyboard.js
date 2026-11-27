const { Markup } = require('telegraf');

// Главная клавиатура администратора
const adminMainKeyboard = (counts = { pendingOrders: 0, pendingPayments: 0, pendingSellerWithdrawals: 0, pendingDisputes: 0, pendingWarranties: 0, pendingPreorders: 0, activeSupportTickets: 0 }) => {
  const ordersBadge = counts.pendingOrders > 0 ? ` (🔴 ${counts.pendingOrders})` : '';
  const preordersBadge = counts.pendingPreorders > 0 ? ` (⏳ ${counts.pendingPreorders})` : '';
  const paymentsBadge = counts.pendingPayments > 0 ? ` (🔴 ${counts.pendingPayments})` : '';
  const sellersBadge = counts.pendingSellerWithdrawals > 0 ? ` (🔴 ${counts.pendingSellerWithdrawals})` : '';
  const warrantiesBadge = counts.pendingWarranties > 0 ? ` (🔴 ${counts.pendingWarranties})` : '';
  const supportBadge = (counts.activeSupportTickets || 0) > 0 ? ` (🔴 ${counts.activeSupportTickets})` : '';

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 Товары', 'admin:products'),
      Markup.button.callback('🗂 Категории', 'admin:categories'),
    ],
    [
      Markup.button.callback('🔑 Ключи', 'admin:keys'),
      Markup.button.callback(`📋 Заказы${ordersBadge}${preordersBadge}`, 'admin:orders'),
    ],
    [
      Markup.button.callback('👥 Пользователи', 'admin:users'),
      Markup.button.callback(`💳 Платежи${paymentsBadge}`, 'admin:payments'),
    ],
    [
      Markup.button.callback('📊 Статистика', 'admin:stats'),
      Markup.button.callback('📈 Логистика', 'admin:logistics'),
      Markup.button.callback('📉 Графики продаж', 'admin:chart'),
    ],
    [
      Markup.button.callback(`💸 Продавцы${sellersBadge}`, 'admin:sellers:withdrawals'),
      Markup.button.callback(`🛡 Замены${warrantiesBadge}`, 'admin:warranties:list'),
    ],
    [
      Markup.button.callback(`⚠️ Споры${counts.pendingDisputes > 0 ? ` (🔴 ${counts.pendingDisputes})` : ''}`, 'admin:disputes:list')
    ],
    [Markup.button.callback('📢 Обязательная подписка (Каналы)', 'admin:req_channels')],
    [Markup.button.callback('🎟 Промокоды', 'admin:promos')],
    [Markup.button.callback('🔌 Внешние Поставщики (API)', 'admin:suppliers')],
    [Markup.button.callback('⚡ Массовые операции', 'admin:bulk')],
    [Markup.button.callback(`🎧 Настройки саппортов${supportBadge}`, 'adm_sup:hub')],
    [Markup.button.callback('⚙️ Настройки', 'admin:settings')],
    [Markup.button.callback('🔍 Глобальный Поиск', 'admin:search')],
  ]);
};

// Ограниченная клавиатура модератора (без доступа к товарам, ключам, платежам и настройкам)
const moderatorMainKeyboard = (counts = { activeSupportTickets: 0 }) => {
  const supportBadge = (counts.activeSupportTickets || 0) > 0 ? ` (🔴 ${counts.activeSupportTickets})` : '';

  return Markup.inlineKeyboard([
    [Markup.button.callback(`🎧 Вопросы и Команда${supportBadge}`, 'adm_sup:hub')],
    [Markup.button.callback('🎧 Моя панель саппорта', 'sp:home')],
    [Markup.button.callback('🔍 Найти юзера / заказ', 'adm_sup:find')],
    [Markup.button.callback('⬅️ В главное меню', 'menu:main')],
  ]);
};

const adminBackKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]);

module.exports = { adminMainKeyboard, moderatorMainKeyboard, adminBackKeyboard };

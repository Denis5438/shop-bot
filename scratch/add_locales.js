const fs = require('fs');
const path = require('path');

const ruPath = path.join(__dirname, '../src/locales/ru.json');
const enPath = path.join(__dirname, '../src/locales/en.json');

const ruData = JSON.parse(fs.readFileSync(ruPath, 'utf-8'));
const enData = JSON.parse(fs.readFileSync(enPath, 'utf-8'));

const updates = {
  support_hello: {
    ru: "👨‍💻 <b>Поддержка на связи!</b>\n\nОператор готов помочь вам. Напишите ваш вопрос — мы ответим прямо здесь.",
    en: "👨‍💻 <b>Support is online!</b>\n\nOur operator is ready to help you. Write your question — we will answer right here."
  },
  support_operator_prefix: {
    ru: "👨‍💻 <b>Поддержка:</b>\n",
    en: "👨‍💻 <b>Support:</b>\n"
  },
  profile_level: { ru: "Уровень", en: "Level" },
  profile_id: { ru: "ID", en: "ID" },
  profile_name: { ru: "Имя", en: "Name" },
  profile_balance: { ru: "Баланс", en: "Balance" },
  profile_orders: { ru: "Заказов", en: "Orders" },
  profile_spent: { ru: "Потрачено", en: "Spent" },
  profile_ref_code: { ru: "Реф. код", en: "Ref. code" },
  profile_joined: { ru: "В боте с", en: "Joined" },
  orders_page: { ru: "стр.", en: "page" },
  orders_tab_all: { ru: "☑️ Все", en: "☑️ All" },
  orders_tab_active: { ru: "🔄 Активные", en: "🔄 Active" },
  seller_new_order_title: {
    ru: "📦 <b>Новый заказ!</b>\n\n{icon} <b>{productName}</b>\n📋 Заказ: <code>{orderId}</code>\n👤 Покупатель: {buyerTag}\n💰 Ваш доход: <b>+{payout} USDT</b>\n\n<blockquote>Выполните заказ и нажмите кнопку ниже.</blockquote>",
    en: "📦 <b>New order!</b>\n\n{icon} <b>{productName}</b>\n📋 Order: <code>{orderId}</code>\n👤 Buyer: {buyerTag}\n💰 Your income: <b>+{payout} USDT</b>\n\n<blockquote>Fulfill the order and click the button below.</blockquote>"
  },
  seller_new_order_btn_complete: { ru: "✅ Выполнил заказ", en: "✅ Order fulfilled" }
};

for (const [key, trans] of Object.entries(updates)) {
  ruData[key] = trans.ru;
  enData[key] = trans.en;
}

fs.writeFileSync(ruPath, JSON.stringify(ruData, null, 2), 'utf-8');
fs.writeFileSync(enPath, JSON.stringify(enData, null, 2), 'utf-8');

console.log('Locales updated successfully!');

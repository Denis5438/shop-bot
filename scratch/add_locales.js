const fs = require('fs');
const path = require('path');

const ruPath = path.join(__dirname, '../src/locales/ru.json');
const enPath = path.join(__dirname, '../src/locales/en.json');

const ru = JSON.parse(fs.readFileSync(ruPath, 'utf8'));
const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

const newRu = {
  "buyer_confirmation_title": "✅ Продавец передал данные по заказу <b>{name}</b>!\n\n",
  "buyer_confirmation_btn_ok": "✅ Всё работает",
  "buyer_confirmation_btn_bad": "❌ Не работает (Спор)",
  "seller_order_awaiting_confirmation_success": "✅ <b>Данные отправлены покупателю!</b>\n\n📦 Товар: {name}\n\n⏳ Ожидаем подтверждения от покупателя (до {hours} ч.).\n<i>Как только покупатель проверит данные (или выйдет время), вы получите <b>+{payout} USDT</b> на баланс.</i>",
  "buyer_dispute_opened": "❌ <b>Спор открыт!</b>\n\nАдминистратор подключится к решению проблемы в ближайшее время.",
  "seller_dispute_opened": "⚠️ <b>Покупатель открыл спор!</b>\n\nЗаказ: {name}\nПокупатель заявил, что выданные данные не работают. Ожидайте решения администратора.",
  "buyer_order_confirmed": "✅ <b>Заказ подтверждён!</b> Спасибо за покупку.",
  "seller_order_confirmed": "✅ <b>Покупатель подтвердил заказ!</b>\n\nЗаказ: {name}\n💰 Вы получили <b>+{payout} USDT</b> на баланс.",
};

const newEn = {
  "buyer_confirmation_title": "✅ The seller has delivered the data for order <b>{name}</b>!\n\n",
  "buyer_confirmation_btn_ok": "✅ Everything works",
  "buyer_confirmation_btn_bad": "❌ Not working (Dispute)",
  "seller_order_awaiting_confirmation_success": "✅ <b>Data sent to buyer!</b>\n\n📦 Product: {name}\n\n⏳ Awaiting buyer confirmation (up to {hours} h.).\n<i>Once the buyer verifies the data (or time expires), you will receive <b>+{payout} USDT</b> to your balance.</i>",
  "buyer_dispute_opened": "❌ <b>Dispute opened!</b>\n\nAn administrator will assist in resolving the issue shortly.",
  "seller_dispute_opened": "⚠️ <b>Buyer opened a dispute!</b>\n\nOrder: {name}\nThe buyer reported that the provided data is not working. Please await the administrator's decision.",
  "buyer_order_confirmed": "✅ <b>Order confirmed!</b> Thank you for your purchase.",
  "seller_order_confirmed": "✅ <b>Buyer confirmed the order!</b>\n\nOrder: {name}\n💰 You received <b>+{payout} USDT</b> to your balance.",
};

Object.assign(ru, newRu);
Object.assign(en, newEn);

fs.writeFileSync(ruPath, JSON.stringify(ru, null, 2) + '\n');
fs.writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n');
console.log('Locales updated successfully!');

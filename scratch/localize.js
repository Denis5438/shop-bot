const fs = require('fs');
const path = require('path');

const ruPath = path.join(__dirname, '../src/locales/ru.json');
const enPath = path.join(__dirname, '../src/locales/en.json');
const scenePath = path.join(__dirname, '../src/bot/scenes/seller.scene.js');

const newKeysRu = {
  "seller_access_denied_title": "🚫 <b>Доступ закрыт</b>\n\n",
  "seller_access_denied_text": "Вы не зарегистрированы как продавец.\nЕсли вы хотите стать продавцом — обратитесь к администратору.",
  "seller_banned": "❌ Ваш аккаунт продавца заблокирован. Обратитесь к администратору.",
  "seller_wallet_unlinked": "💳 Кошелёк: <i>не привязан</i>",
  "seller_wallet_linked": "💳 Кошелёк: <code>{wallet}</code>\n🌐 Сеть: <b>{network}</b>",
  "seller_cabinet_title": "🏪 <b>Кабинет продавца</b>\n\n<blockquote>👤 @{username}\n💰 Баланс: <b>{balance} USDT</b>\n📈 Всего заработано: <b>{earned} USDT</b>\n📦 Активных заказов: <b>{activeOrders}</b>\n{walletLine}</blockquote>\n\n<i>Команды: /seller — кабинет</i>",
  "seller_btn_my_orders": "📦 Мои заказы",
  "seller_btn_link_wallet": "💳 Привязать кошелёк",
  "seller_btn_change_wallet": "💳 Изменить кошелёк",
  "seller_btn_withdraw": "💸 Вывести средства (мин. {min} USDT)",
  "seller_btn_withdraw_pending": "⏳ Заявка на вывод ожидает",
  "seller_btn_withdraw_no_wallet": "⚠️ Сначала привяжите кошелёк",
  "seller_btn_withdraw_min": "🔒 Вывод от {min} USDT (есть {balance})",
  "seller_no_access": "❌ Нет доступа",
  "seller_orders_empty_active": "📭 Активных заказов нет.",
  "seller_orders_empty_history": "📭 Истории заказов нет.",
  "seller_orders_title": "🗂 <b>Мои заказы</b>\n\n{text}",
  "seller_orders_list_title": "🗂 <b>Мои заказы</b> ({type}):\n\n",
  "seller_order_active_type": "активные",
  "seller_order_history_type": "история",
  "seller_btn_order_complete": "✅ Выполнил — {name}",
  "seller_btn_orders_active": "📦 Активные",
  "seller_btn_orders_history": "📋 История",
  "seller_btn_cabinet": "⬅️ Кабинет",
  "seller_order_not_found": "❌ Заказ не найден или уже закрыт",
  "seller_order_deliver_title": "📦 <b>Выполнение заказа</b>\n\nТовар: <b>{name}</b>\n\nПожалуйста, отправьте <b>данные от аккаунта</b> (логин:пароль, ссылку или любой текст).\n<i>Вы также можете отправить файл или фото.</i>\n\nЭти данные будут пересланы покупателю, после чего заказ закроется и вы получите оплату.",
  "seller_buyer_order_completed": "✅ Ваш заказ <b>{name}</b> выполнен продавцом!\n\n",
  "seller_buyer_order_data": "<b>Данные заказа:</b>\n<code>{data}</code>",
  "seller_deliver_need_file": "❌ Пожалуйста, отправьте текст, фото или документ.",
  "seller_order_completed_success": "✅ <b>Заказ успешно выполнен!</b>\n\n📦 Товар: {name}\n💰 Доход: <b>+{payout} USDT</b>\n\nВаш текущий баланс: <b>{balance} USDT</b>\n<i>Данные были успешно отправлены покупателю.</i>",
  "seller_wallet_setup_title": "💳 <b>Привязка кошелька</b>{current}\n\nВведите ваш <b>USDT адрес</b> (любая сеть — TRC-20, BEP-20, APTOS и др.):",
  "seller_wallet_setup_current": "\n\nТекущий адрес: <code>{wallet}</code> ({network})",
  "seller_wallet_invalid_address": "❌ Некорректный адрес. Введите ваш USDT адрес:",
  "seller_wallet_address_accepted": "📬 Адрес принят!\n\nТеперь введите <b>название сети</b>:\n\nПримеры: <code>TRC-20</code>, <code>BEP-20</code>, <code>APTOS</code>, <code>SOL</code>, <code>ERC-20</code>",
  "seller_wallet_invalid_network": "❌ Введите название сети:",
  "seller_session_expired": "⚠️ Сессия устарела",
  "seller_wallet_saved": "✅ <b>Кошелёк привязан!</b>\n\n🌐 Сеть: <b>{network}</b>\n💳 Адрес: <code>{wallet}</code>",
  "seller_withdraw_min_error": "❌ Минимум {min} USDT для вывода",
  "seller_withdraw_pending_error": "⏳ У вас уже есть ожидающая заявка",
  "seller_withdraw_first_link_error": "❌ Сначала привяжите кошелёк",
  "seller_withdraw_title": "💸 <b>Вывод средств</b>\n\n💰 Доступно: <b>{balance} USDT</b>\n💳 Кошелёк: <code>{wallet}</code>\n🌐 Сеть: <b>{network}</b>\n\nВведите сумму для вывода (мин. {min} USDT):",
  "seller_withdraw_title_short": "💸 <b>Вывод средств</b>\n\nВведите сумму (мин. {min} USDT):",
  "seller_btn_withdraw_all": "💸 Вывести всё ({balance} USDT)",
  "seller_withdraw_invalid_amount": "❌ Введите корректную сумму (например: {min}):",
  "seller_withdraw_insufficient": "❌ Недостаточно средств. Доступно: {balance} USDT",
  "seller_withdraw_confirm_title": "💸 <b>Подтверждение вывода</b>\n\n<blockquote>💰 Сумма: <b>{amount} USDT</b>\n💳 Кошелёк: <code>{wallet}</code>\n🌐 Сеть: <b>{network}</b></blockquote>\n\nПодтвердите заявку на вывод.",
  "seller_btn_confirm": "✅ Подтвердить",
  "seller_withdraw_created_alert": "✅ Заявка создана!",
  "seller_withdraw_created": "✅ <b>Заявка на вывод создана!</b>\n\n💰 Сумма: <b>{amount} USDT</b>\n💳 Кошелёк: <code>{wallet}</code>\n🌐 Сеть: <b>{network}</b>\n\n⏳ Администратор обработает заявку в ближайшее время.",
  "seller_btn_to_cabinet": "🏪 В кабинет",
  "seller_order_closed_alert": "✅ Заказ закрыт!"
};

const newKeysEn = {
  "seller_access_denied_title": "🚫 <b>Access Denied</b>\n\n",
  "seller_access_denied_text": "You are not registered as a seller.\nIf you want to become a seller, please contact the administrator.",
  "seller_banned": "❌ Your seller account is blocked. Contact the administrator.",
  "seller_wallet_unlinked": "💳 Wallet: <i>not linked</i>",
  "seller_wallet_linked": "💳 Wallet: <code>{wallet}</code>\n🌐 Network: <b>{network}</b>",
  "seller_cabinet_title": "🏪 <b>Seller Cabinet</b>\n\n<blockquote>👤 @{username}\n💰 Balance: <b>{balance} USDT</b>\n📈 Total earned: <b>{earned} USDT</b>\n📦 Active orders: <b>{activeOrders}</b>\n{walletLine}</blockquote>\n\n<i>Commands: /seller — cabinet</i>",
  "seller_btn_my_orders": "📦 My orders",
  "seller_btn_link_wallet": "💳 Link wallet",
  "seller_btn_change_wallet": "💳 Change wallet",
  "seller_btn_withdraw": "💸 Withdraw funds (min. {min} USDT)",
  "seller_btn_withdraw_pending": "⏳ Withdrawal request pending",
  "seller_btn_withdraw_no_wallet": "⚠️ Link your wallet first",
  "seller_btn_withdraw_min": "🔒 Withdrawal from {min} USDT (you have {balance})",
  "seller_no_access": "❌ No access",
  "seller_orders_empty_active": "📭 No active orders.",
  "seller_orders_empty_history": "📭 No order history.",
  "seller_orders_title": "🗂 <b>My orders</b>\n\n{text}",
  "seller_orders_list_title": "🗂 <b>My orders</b> ({type}):\n\n",
  "seller_order_active_type": "active",
  "seller_order_history_type": "history",
  "seller_btn_order_complete": "✅ Done — {name}",
  "seller_btn_orders_active": "📦 Active",
  "seller_btn_orders_history": "📋 History",
  "seller_btn_cabinet": "⬅️ Cabinet",
  "seller_order_not_found": "❌ Order not found or already closed",
  "seller_order_deliver_title": "📦 <b>Order fulfillment</b>\n\nProduct: <b>{name}</b>\n\nPlease send the <b>account credentials</b> (login:password, link, or any text).\n<i>You can also send a file or photo.</i>\n\nThese details will be forwarded to the buyer, after which the order will be closed and you will receive your payment.",
  "seller_buyer_order_completed": "✅ Your order <b>{name}</b> was fulfilled by the seller!\n\n",
  "seller_buyer_order_data": "<b>Order data:</b>\n<code>{data}</code>",
  "seller_deliver_need_file": "❌ Please send text, photo, or document.",
  "seller_order_completed_success": "✅ <b>Order successfully fulfilled!</b>\n\n📦 Product: {name}\n💰 Income: <b>+{payout} USDT</b>\n\nYour current balance: <b>{balance} USDT</b>\n<i>The details have been successfully sent to the buyer.</i>",
  "seller_wallet_setup_title": "💳 <b>Wallet Setup</b>{current}\n\nEnter your <b>USDT address</b> (any network — TRC-20, BEP-20, APTOS, etc.):",
  "seller_wallet_setup_current": "\n\nCurrent address: <code>{wallet}</code> ({network})",
  "seller_wallet_invalid_address": "❌ Invalid address. Enter your USDT address:",
  "seller_wallet_address_accepted": "📬 Address accepted!\n\nNow enter the <b>network name</b>:\n\nExamples: <code>TRC-20</code>, <code>BEP-20</code>, <code>APTOS</code>, <code>SOL</code>, <code>ERC-20</code>",
  "seller_wallet_invalid_network": "❌ Enter network name:",
  "seller_session_expired": "⚠️ Session expired",
  "seller_wallet_saved": "✅ <b>Wallet linked!</b>\n\n🌐 Network: <b>{network}</b>\n💳 Address: <code>{wallet}</code>",
  "seller_withdraw_min_error": "❌ Minimum {min} USDT for withdrawal",
  "seller_withdraw_pending_error": "⏳ You already have a pending request",
  "seller_withdraw_first_link_error": "❌ Link your wallet first",
  "seller_withdraw_title": "💸 <b>Withdraw funds</b>\n\n💰 Available: <b>{balance} USDT</b>\n💳 Wallet: <code>{wallet}</code>\n🌐 Network: <b>{network}</b>\n\nEnter amount to withdraw (min. {min} USDT):",
  "seller_withdraw_title_short": "💸 <b>Withdraw funds</b>\n\nEnter amount (min. {min} USDT):",
  "seller_btn_withdraw_all": "💸 Withdraw all ({balance} USDT)",
  "seller_withdraw_invalid_amount": "❌ Enter a valid amount (e.g. {min}):",
  "seller_withdraw_insufficient": "❌ Insufficient funds. Available: {balance} USDT",
  "seller_withdraw_confirm_title": "💸 <b>Withdrawal Confirmation</b>\n\n<blockquote>💰 Amount: <b>{amount} USDT</b>\n💳 Wallet: <code>{wallet}</code>\n🌐 Network: <b>{network}</b></blockquote>\n\nConfirm the withdrawal request.",
  "seller_btn_confirm": "✅ Confirm",
  "seller_withdraw_created_alert": "✅ Request created!",
  "seller_withdraw_created": "✅ <b>Withdrawal request created!</b>\n\n💰 Amount: <b>{amount} USDT</b>\n💳 Wallet: <code>{wallet}</code>\n🌐 Network: <b>{network}</b>\n\n⏳ An administrator will process your request shortly.",
  "seller_btn_to_cabinet": "🏪 To cabinet",
  "seller_order_closed_alert": "✅ Order closed!"
};

const updateLocales = (filePath, keys) => {
  let content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  content = { ...content, ...keys };
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
};

updateLocales(ruPath, newKeysRu);
updateLocales(enPath, newKeysEn);
console.log('Locales updated!');

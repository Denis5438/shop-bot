const fs = require('fs');
const path = require('path');

const sellerPath = path.join(__dirname, '../src/bot/scenes/seller.scene.js');
let code = fs.readFileSync(sellerPath, 'utf8');

// The replacement logic:
const replacements = [
  // showSellerCabinet
  [`return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });`],
  [`const text =\\n      \`🚫 <b>Доступ закрыт</b>\\n\\n\` +\\n      \`Вы не зарегистрированы как продавец.\\n\` +\\n      \`Если вы хотите стать продавцом — обратитесь к администратору.\`;`, `const text = ctx.t('seller_access_denied_title') + ctx.t('seller_access_denied_text');`],
  [`Markup.button.callback('⬅️ Главное меню', 'menu:main')`, `Markup.button.callback(ctx.t('back_to_menu'), 'menu:main')`],
  [`await ctx.reply('❌ Ваш аккаунт продавца заблокирован. Обратитесь к администратору.')`, `await ctx.reply(ctx.t('seller_banned'))`],
  [
    `const walletLine = seller.walletAddress\n    ? \`💳 Кошелёк: <code>\${escapeHtml(seller.walletAddress)}</code>\\n🌐 Сеть: <b>\${escapeHtml(seller.walletNetwork || '—')}</b>\`\n    : \`💳 Кошелёк: <i>не привязан</i>\`;`,
    `const walletLine = seller.walletAddress\n    ? ctx.t('seller_wallet_linked', { wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') })\n    : ctx.t('seller_wallet_unlinked');`
  ],
  [
    `const text =\n    \`🏪 <b>Кабинет продавца</b>\\n\\n\` +\n    \`<blockquote>👤 @\${escapeHtml(seller.username)}\\n\` +\n    \`💰 Баланс: <b>\${seller.balance.toFixed(2)} USDT</b>\\n\` +\n    \`📈 Всего заработано: <b>\${seller.totalEarned.toFixed(2)} USDT</b>\\n\` +\n    \`📦 Активных заказов: <b>\${activeOrders}</b>\\n\` +\n    \`\${walletLine}</blockquote>\\n\\n\` +\n    \`<i>Команды: /seller — кабинет</i>\`;`,
    `const text = ctx.t('seller_cabinet_title', {\n    username: escapeHtml(seller.username),\n    balance: seller.balance.toFixed(2),\n    earned: seller.totalEarned.toFixed(2),\n    activeOrders,\n    walletLine\n  });`
  ],
  [`Markup.button.callback('📦 Мои заказы', 'seller:orders')`, `Markup.button.callback(ctx.t('seller_btn_my_orders'), 'seller:orders')`],
  [`Markup.button.callback('💳 Привязать кошелёк', 'seller:wallet:setup')`, `Markup.button.callback(ctx.t('seller_btn_link_wallet'), 'seller:wallet:setup')`],
  [`Markup.button.callback('💳 Изменить кошелёк', 'seller:wallet:setup')`, `Markup.button.callback(ctx.t('seller_btn_change_wallet'), 'seller:wallet:setup')`],
  [`Markup.button.callback(\`💸 Вывести средства (мин. \${minWithdraw} USDT)\`, 'seller:withdraw:start')`, `Markup.button.callback(ctx.t('seller_btn_withdraw', { min: minWithdraw }), 'seller:withdraw:start')`],
  [`Markup.button.callback('⏳ Заявка на вывод ожидает', 'seller:noop')`, `Markup.button.callback(ctx.t('seller_btn_withdraw_pending'), 'seller:noop')`],
  [`Markup.button.callback('⚠️ Сначала привяжите кошелёк', 'seller:noop')`, `Markup.button.callback(ctx.t('seller_btn_withdraw_no_wallet'), 'seller:noop')`],
  [`Markup.button.callback(\`🔒 Вывод от \${minWithdraw} USDT (есть \${seller.balance.toFixed(2)})\`, 'seller:noop')`, `Markup.button.callback(ctx.t('seller_btn_withdraw_min', { min: minWithdraw, balance: seller.balance.toFixed(2) }), 'seller:noop')`],
  
  // showSellerOrders
  [
    `const emptyText = filter === 'active' ? '📭 Активных заказов нет.' : '📭 Истории заказов нет.';`,
    `const emptyText = filter === 'active' ? ctx.t('seller_orders_empty_active') : ctx.t('seller_orders_empty_history');`
  ],
  [`Markup.button.callback('📦 Активные', 'seller:orders:active')`, `Markup.button.callback(ctx.t('seller_btn_orders_active'), 'seller:orders:active')`],
  [`Markup.button.callback('📋 История', 'seller:orders:history')`, `Markup.button.callback(ctx.t('seller_btn_orders_history'), 'seller:orders:history')`],
  [`Markup.button.callback('⬅️ Кабинет', 'seller:cabinet')`, `Markup.button.callback(ctx.t('seller_btn_cabinet'), 'seller:cabinet')`],
  [`await ctx.editMessageText(\`🗂 <b>Мои заказы</b>\\n\\n\${emptyText}\`, opts);`, `await ctx.editMessageText(ctx.t('seller_orders_title', { text: emptyText }), opts);`],
  [`await ctx.reply(\`🗂 <b>Мои заказы</b>\\n\\n\${emptyText}\`, opts);`, `await ctx.reply(ctx.t('seller_orders_title', { text: emptyText }), opts);`],
  [`let text = \`🗂 <b>Мои заказы</b> (\${filter === 'active' ? 'активные' : 'история'}):\\n\\n\`;`, `let text = ctx.t('seller_orders_list_title', { type: filter === 'active' ? ctx.t('seller_order_active_type') : ctx.t('seller_order_history_type') });`],
  [`Markup.button.callback(\n          \`✅ Выполнил — \${escapeHtml((product?.name || 'Заказ').substring(0, 22))}\`,\n          \`seller:order:complete:\${order._id}\`\n        )`, `Markup.button.callback(\n          ctx.t('seller_btn_order_complete', { name: escapeHtml((product?.name || 'Заказ').substring(0, 22)) }),\n          \`seller:order:complete:\${order._id}\`\n        )`],
  
  // completeSellerOrder
  [`return ctx.answerCbQuery('❌ Заказ не найден или уже закрыт', { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_order_not_found'), { show_alert: true });`],
  [
    `const text =\n    \`📦 <b>Выполнение заказа</b>\\n\\n\` +\n    \`Товар: <b>\${escapeHtml(order.productId?.name || 'Товар')}</b>\\n\\n\` +\n    \`Пожалуйста, отправьте <b>данные от аккаунта</b> (логин:пароль, ссылку или любой текст).\\n\` +\n    \`<i>Вы также можете отправить файл или фото.</i>\\n\\n\` +\n    \`Эти данные будут пересланы покупателю, после чего заказ закроется и вы получите оплату.\`;`,
    `const text = ctx.t('seller_order_deliver_title', { name: escapeHtml(order.productId?.name || 'Товар') });`
  ],
  [`Markup.button.callback('❌ Отмена', 'seller:orders')`, `Markup.button.callback(ctx.t('btn_cancel'), 'seller:orders')`],
  
  // handleSellerDelivery
  [`await ctx.reply('❌ Заказ не найден или уже закрыт.', {`, `await ctx.reply(ctx.t('seller_order_not_found'), {`],
  [`let deliveryText = \`✅ Ваш заказ <b>\${escapeHtml(order.productId?.name || 'Товар')}</b> выполнен продавцом!\\n\\n\`;`, `let deliveryText = ctx.t('seller_buyer_order_completed', { name: escapeHtml(order.productId?.name || 'Товар') });`],
  [`deliveryText += \`<b>Данные заказа:</b>\\n<code>\${escapeHtml(ctx.message.text)}</code>\`;`, `deliveryText += ctx.t('seller_buyer_order_data', { data: escapeHtml(ctx.message.text) });`],
  [`await ctx.reply('❌ Пожалуйста, отправьте текст, фото или документ.');`, `await ctx.reply(ctx.t('seller_deliver_need_file'));`],
  [
    `const text =\n    \`✅ <b>Заказ успешно выполнен!</b>\\n\\n\` +\n    \`📦 Товар: \${escapeHtml(order.productId?.name || 'Товар')}\\n\` +\n    \`💰 Доход: <b>+\${(order.sellerPayout || 0).toFixed(2)} USDT</b>\\n\\n\` +\n    \`Ваш текущий баланс: <b>\${(freshSeller?.balance || seller.balance).toFixed(2)} USDT</b>\\n\` +\n    \`<i>Данные были успешно отправлены покупателю.</i>\`;`,
    `const text = ctx.t('seller_order_completed_success', { name: escapeHtml(order.productId?.name || 'Товар'), payout: (order.sellerPayout || 0).toFixed(2), balance: (freshSeller?.balance || seller.balance).toFixed(2) });`
  ],
  [`Markup.button.callback('📦 К заказам', 'seller:orders')`, `Markup.button.callback(ctx.t('seller_btn_my_orders'), 'seller:orders')`],
  
  // startWalletSetup
  [
    `const currentLine = seller.walletAddress\n    ? \`\\n\\nТекущий адрес: <code>\${escapeHtml(seller.walletAddress)}</code> (\${escapeHtml(seller.walletNetwork || '—')})\`\n    : '';`,
    `const currentLine = seller.walletAddress\n    ? ctx.t('seller_wallet_setup_current', { wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') })\n    : '';`
  ],
  [
    `const text =\n    \`💳 <b>Привязка кошелька</b>\${currentLine}\\n\\n\` +\n    \`Введите ваш <b>USDT адрес</b> (любая сеть — TRC-20, BEP-20, APTOS и др.):\`;`,
    `const text = ctx.t('seller_wallet_setup_title', { current: currentLine });`
  ],
  [`Markup.button.callback('❌ Отмена', 'seller:cabinet')`, `Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')`],
  
  // handleWalletAddressInput
  [`await ctx.reply('❌ Некорректный адрес. Введите ваш USDT адрес:');`, `await ctx.reply(ctx.t('seller_wallet_invalid_address'));`],
  [`await ctx.reply(\n      \`📬 Адрес принят!\\n\\nТеперь введите <b>название сети</b>:\\n\\nПримеры: <code>TRC-20</code>, <code>BEP-20</code>, <code>APTOS</code>, <code>SOL</code>, <code>ERC-20</code>\`,\n      {`, `await ctx.reply(ctx.t('seller_wallet_address_accepted'), {`],
  [`await ctx.reply('❌ Введите название сети:');`, `await ctx.reply(ctx.t('seller_wallet_invalid_network'));`],
  
  // handleWalletNetworkChoice
  [`await ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true })`, `await ctx.answerCbQuery(ctx.t('seller_session_expired'), { show_alert: true })`],
  
  // saveWallet
  [
    `\`✅ <b>Кошелёк привязан!</b>\\n\\n\` +\n    \`🌐 Сеть: <b>\${escapeHtml(network)}</b>\\n\` +\n    \`💳 Адрес: <code>\${escapeHtml(address)}</code>\``,
    `ctx.t('seller_wallet_saved', { network: escapeHtml(network), wallet: escapeHtml(address) })`
  ],
  [`Markup.button.callback('🏪 В кабинет', 'seller:cabinet')`, `Markup.button.callback(ctx.t('seller_btn_to_cabinet'), 'seller:cabinet')`],
  
  // startWithdraw
  [`return ctx.answerCbQuery('❌ Сначала привяжите кошелёк', { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_withdraw_first_link_error'), { show_alert: true });`],
  [`return ctx.answerCbQuery(\`❌ Минимум \${minWithdraw} USDT для вывода\`, { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_withdraw_min_error', { min: minWithdraw }), { show_alert: true });`],
  [`return ctx.answerCbQuery('⏳ У вас уже есть ожидающая заявка', { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_withdraw_pending_error'), { show_alert: true });`],
  [
    `\`💸 <b>Вывод средств</b>\\n\\n\` +\n      \`💰 Доступно: <b>\${seller.balance.toFixed(2)} USDT</b>\\n\` +\n      \`💳 Кошелёк: <code>\${escapeHtml(seller.walletAddress)}</code>\\n\` +\n      \`🌐 Сеть: <b>\${escapeHtml(seller.walletNetwork || '—')}</b>\\n\\n\` +\n      \`Введите сумму для вывода (мин. \${minWithdraw} USDT):\``,
    `ctx.t('seller_withdraw_title', { balance: seller.balance.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—'), min: minWithdraw })`
  ],
  [`Markup.button.callback(\`💸 Вывести всё (\${seller.balance.toFixed(2)} USDT)\`, \`seller:withdraw:all\`)`, `Markup.button.callback(ctx.t('seller_btn_withdraw_all', { balance: seller.balance.toFixed(2) }), \`seller:withdraw:all\`)`],
  [`\`💸 <b>Вывод средств</b>\\n\\nВведите сумму (мин. \${minWithdraw} USDT):\``, `ctx.t('seller_withdraw_title_short', { min: minWithdraw })`],
  
  // handleWithdrawAmountInput
  [`await ctx.reply(\`❌ Введите корректную сумму (например: \${minWithdraw}):\`);`, `await ctx.reply(ctx.t('seller_withdraw_invalid_amount', { min: minWithdraw }));`],
  [`await ctx.reply(\`❌ Минимальная сумма вывода — \${minWithdraw} USDT\`);`, `await ctx.reply(ctx.t('seller_withdraw_min_error', { min: minWithdraw }));`],
  [`await ctx.reply(\`❌ Недостаточно средств. Доступно: \${seller.balance.toFixed(2)} USDT\`);`, `await ctx.reply(ctx.t('seller_withdraw_insufficient', { balance: seller.balance.toFixed(2) }));`],
  
  // processWithdrawAmount
  [
    `const text =\n    \`💸 <b>Подтверждение вывода</b>\\n\\n\` +\n    \`<blockquote>💰 Сумма: <b>\${amount.toFixed(2)} USDT</b>\\n\` +\n    \`💳 Кошелёк: <code>\${escapeHtml(seller.walletAddress)}</code>\\n\` +\n    \`🌐 Сеть: <b>\${escapeHtml(seller.walletNetwork || '—')}</b></blockquote>\\n\\n\` +\n    \`Подтвердите заявку на вывод.\`;`,
    `const text = ctx.t('seller_withdraw_confirm_title', { amount: amount.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') });`
  ],
  [`Markup.button.callback('✅ Подтвердить', \`seller:withdraw:confirm:\${amount.toFixed(2)}\`)`, `Markup.button.callback(ctx.t('seller_btn_confirm'), \`seller:withdraw:confirm:\${amount.toFixed(2)}\`)`],
  
  // confirmWithdraw
  [`return ctx.answerCbQuery(\`❌ Минимум \${minWithdraw} USDT\`, { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_withdraw_min_error', { min: minWithdraw }), { show_alert: true });`],
  [`return ctx.answerCbQuery('❌ Недостаточно средств', { show_alert: true });`, `return ctx.answerCbQuery(ctx.t('seller_withdraw_insufficient', { balance: seller.balance.toFixed(2) }), { show_alert: true });`],
  [`await ctx.answerCbQuery('✅ Заявка создана!');`, `await ctx.answerCbQuery(ctx.t('seller_withdraw_created_alert'));`],
  [
    `const text =\n    \`✅ <b>Заявка на вывод создана!</b>\\n\\n\` +\n    \`💰 Сумма: <b>\${amount.toFixed(2)} USDT</b>\\n\` +\n    \`💳 Кошелёк: <code>\${escapeHtml(seller.walletAddress)}</code>\\n\` +\n    \`🌐 Сеть: <b>\${escapeHtml(seller.walletNetwork || '—')}</b>\\n\\n\` +\n    \`⏳ Администратор обработает заявку в ближайшее время.\`;`,
    `const text = ctx.t('seller_withdraw_created', { amount: amount.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') });`
  ],
  [`await ctx.answerCbQuery('✅ Заказ закрыт!');`, `await ctx.answerCbQuery(ctx.t('seller_order_closed_alert'));`]
];

for (const [search, replace] of replacements) {
  if (code.includes(search)) {
    code = code.replace(search, replace);
    // Replace multiple occurrences if exist
    while (code.includes(search)) {
      code = code.replace(search, replace);
    }
  } else {
    console.warn("NOT FOUND:\n", search);
  }
}

fs.writeFileSync(sellerPath, code, 'utf8');
console.log("Seller scene updated");

/**
 * seller.scene.js
 * Личный кабинет продавца — доступен по команде /seller
 * Продавец может:
 *  - посмотреть баланс
 *  - привязать/изменить крипто-кошелёк (любая сеть — текстом)
 *  - подать заявку на вывод (минимум из настроек)
 *  - видеть свои заказы (активные и историю)
 */

const { Markup } = require('telegraf');
const Seller = require('../../models/Seller');
const SellerWithdrawal = require('../../models/SellerWithdrawal');
const Order = require('../../models/Order');
const notif = require('../../services/notification.service');
const { escapeHtml } = require('../utils/ui');
const i18n = require('../middlewares/i18n');
const { getSettings } = require('../../services/settingsCache.service');

// ─── Получить минимальный вывод из настроек ───────────────────────────────────
const getMinWithdraw = async () => {
  try {
    const settings = await getSettings();
    return (settings?.minSellerWithdraw > 0) ? settings.minSellerWithdraw : 5;
  } catch (_) {
    return 5;
  }
};

// ─── Найти продавца ───────────────────────────────────────────
const findSeller = async (ctx) => {
  const telegramId = ctx.from?.id || ctx.user?.telegramId;
  let seller = await Seller.findOne({ telegramId });

  if (!seller && ctx.from?.username) {
    // Ищем продавца, добавленного админом по юзернейму (у которого ещё нет telegramId)
    seller = await Seller.findOne({ username: { $regex: new RegExp(`^${ctx.from.username}$`, 'i') }, telegramId: null });
    if (seller) {
      seller.telegramId = telegramId;
      await seller.save();
    }
  }

  return seller;
};

// ─── Главная страница кабинета продавца ──────────────────────────────────────
const showSellerCabinet = async (ctx) => {
  const seller = await findSeller(ctx);

  if (!seller) {
    const text = ctx.t('seller_access_denied_title') + ctx.t('seller_access_denied_text');
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('back_to_menu'), 'menu:main')]]),
      });
    } catch (_) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('back_to_menu'), 'menu:main')]]),
      });
    }
    return;
  }

  if (!seller.isActive) {
    await ctx.reply(ctx.t('seller_banned')).catch(() => {});
    return;
  }

  const minWithdraw = await getMinWithdraw();

  // Считаем активные заказы для этого продавца
  const activeOrders = await Order.countDocuments({ sellerId: seller._id, status: 'pending' });

  const walletLine = seller.walletAddress
    ? ctx.t('seller_wallet_linked', { wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') })
    : ctx.t('seller_wallet_unlinked');

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });

  const text = ctx.t('seller_cabinet_title', {
    username: escapeHtml(seller.username),
    balance: seller.balance.toFixed(2),
    earned: seller.totalEarned.toFixed(2),
    activeOrders,
    walletLine
  });

  const buttons = [
    [Markup.button.callback(ctx.t('seller_btn_my_orders'), 'seller:orders')],
  ];

  if (!seller.walletAddress) {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_link_wallet'), 'seller:wallet:setup')]);
  } else {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_change_wallet'), 'seller:wallet:setup')]);
  }

  if (seller.balance >= minWithdraw && seller.walletAddress && !pendingWithdrawal) {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_withdraw', { min: minWithdraw }), 'seller:withdraw:start')]);
  } else if (pendingWithdrawal) {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_withdraw_pending'), 'seller:noop')]);
  } else if (!seller.walletAddress) {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_withdraw_no_wallet'), 'seller:noop')]);
  } else {
    buttons.push([Markup.button.callback(ctx.t('seller_btn_withdraw_min', { min: minWithdraw, balance: seller.balance.toFixed(2) }), 'seller:noop')]);
  }

  buttons.push([Markup.button.callback(ctx.t('back_to_menu'), 'menu:main')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

// ─── Заказы продавца ─────────────────────────────────────────────────────────
const showSellerOrders = async (ctx, filter = 'active') => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  const query = { sellerId: seller._id };
  if (filter === 'active') {
    query.status = 'pending';
  } else {
    query.status = { $in: ['completed', 'cancelled'] };
  }

  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .limit(20)
    .populate('productId')
    .populate('userId');

  if (!orders.length) {
    const emptyText = filter === 'active' ? ctx.t('seller_orders_empty_active') : ctx.t('seller_orders_empty_history');
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(ctx.t('seller_btn_orders_active'), 'seller:orders:active'),
          Markup.button.callback(ctx.t('seller_btn_orders_history'), 'seller:orders:history'),
        ],
        [Markup.button.callback(ctx.t('seller_btn_cabinet'), 'seller:cabinet')],
      ]),
    };
    try {
      await ctx.editMessageText(ctx.t('seller_orders_title', { text: emptyText }), opts);
    } catch (_) {
      await ctx.reply(ctx.t('seller_orders_title', { text: emptyText }), opts);
    }
    return;
  }

  let text = ctx.t('seller_orders_list_title', { type: filter === 'active' ? ctx.t('seller_order_active_type') : ctx.t('seller_order_history_type') });
  const buttons = [];

  for (const order of orders) {
    const product = order.productId;
    const date = new Date(order.createdAt).toLocaleDateString('ru-RU');
    const statusIcon = order.status === 'pending' ? '⏳' : order.status === 'completed' ? '✅' : '❌';
    text += `${statusIcon} ${escapeHtml(product?.name || 'Товар')} | ${order.sellerPayout?.toFixed(2) || '0.00'} USDT | ${date}\n`;

    if (order.status === 'pending') {
      buttons.push([
        Markup.button.callback(
          ctx.t('seller_btn_order_complete', { name: escapeHtml((product?.name || 'Заказ').substring(0, 22)) }),
          `seller:order:complete:${order._id}`
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback(ctx.t('seller_btn_orders_active'), 'seller:orders:active'),
    Markup.button.callback(ctx.t('seller_btn_orders_history'), 'seller:orders:history'),
  ]);
  buttons.push([Markup.button.callback(ctx.t('seller_btn_cabinet'), 'seller:cabinet')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

// ─── Выполнить заказ (Шаг 1: запрос данных) ──────────────────────────────────
const completeSellerOrder = async (ctx, orderId) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  const order = await Order.findOne({
    _id: orderId,
    sellerId: seller._id,
    status: 'pending',
  }).populate('productId');

  if (!order) {
    return ctx.answerCbQuery(ctx.t('seller_order_not_found'), { show_alert: true });
  }

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = 'deliver_order';
  ctx.session.deliverOrderId = orderId;

  await ctx.answerCbQuery().catch(() => {});

  const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
  const text = ctx.t('seller_order_deliver_title', { name: productName });

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_cancel'), 'seller:orders')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_cancel'), 'seller:orders')]]),
    });
  }
};

// ─── Выполнить заказ (Шаг 2: получение данных и отправка покупателю) ───────
const handleSellerDelivery = async (ctx) => {
  const session = ctx.session || {};
  if (session.sellerAction !== 'deliver_order' || !session.deliverOrderId) return false;

  const seller = await findSeller(ctx);
  if (!seller) return false;

  const order = await Order.findOne({
    _id: session.deliverOrderId,
    sellerId: seller._id,
    status: 'pending',
  }).populate('productId').populate('userId');

  if (!order) {
    ctx.session.sellerAction = null;
    ctx.session.deliverOrderId = null;
    await ctx.reply(ctx.t('seller_order_not_found'), {
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('seller_btn_my_orders'), 'seller:orders')]]),
    });
    return true;
  }

  const buyer = order.userId;

  // Если нет покупателя (вдруг удалён), заказ всё равно закроем
  if (buyer) {
    const buyerLang = buyer.language || 'ru';
    const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
    let buyerDeliveryText = i18n.translate(buyerLang, 'buyer_confirmation_title', { name: productName });
    let dataStr = '';
    
    try {
      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback(i18n.translate(buyerLang, 'buyer_confirmation_btn_ok'), `buyer:confirm_order:${order._id}`)],
        [Markup.button.callback(i18n.translate(buyerLang, 'buyer_confirmation_btn_bad'), `buyer:dispute_order:${order._id}`)],
      ]);

      if (ctx.message.text) {
        dataStr = ctx.message.text;
        buyerDeliveryText += i18n.translate(buyerLang, 'seller_buyer_order_data', { data: escapeHtml(dataStr) });
        await notif.sendToUser(buyer.telegramId, buyerDeliveryText, { parse_mode: 'HTML', ...buttons });
      } else if (ctx.message.photo || ctx.message.document) {
        dataStr = ctx.message.photo ? '[Фотография]' : '[Документ]';
        await notif.sendToUser(buyer.telegramId, buyerDeliveryText, { parse_mode: 'HTML' });
        await ctx.telegram.copyMessage(buyer.telegramId, ctx.chat.id, ctx.message.message_id, {
          ...buttons
        });
      } else {
        await ctx.reply(ctx.t('seller_deliver_need_file'));
        return true;
      }
      order.deliveryData = dataStr;
    } catch (err) {
      // Если бот не смог отправить
    }
  }

  order.status = 'awaiting_confirmation';
  order.deliveredAt = new Date();
  order.activationResult = 'Ожидает подтверждения покупателя';
  await order.save();

  // Очищаем сессию
  ctx.session.sellerAction = null;
  ctx.session.deliverOrderId = null;

  const settings = await getSettings();
  const autoConfirmHours = settings.autoConfirmHours || 24;

  const productName2 = order.qty > 1 ? `${escapeHtml(order.productId?.name || 'Товар')} (x${order.qty})` : escapeHtml(order.productId?.name || 'Товар');
  const text = ctx.t('seller_order_awaiting_confirmation_success', {
    name: productName2,
    payout: (order.sellerPayout || 0).toFixed(2),
    hours: autoConfirmHours
  });

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ctx.t('seller_btn_my_orders'), 'seller:orders')],
      [Markup.button.callback(ctx.t('seller_btn_cabinet'), 'seller:cabinet')],
    ]),
  });

  return true;
};

// ─── Настройка кошелька — шаг 1: ввод адреса ─────────────────────────────────
const startWalletSetup = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = 'set_wallet_address';

  await ctx.answerCbQuery().catch(() => {});

  const currentLine = seller.walletAddress
    ? ctx.t('seller_wallet_setup_current', { wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') })
    : '';

  const text = ctx.t('seller_wallet_setup_title', { current: currentLine });

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')]]),
    });
  }
};

// ─── Шаг 2: получили адрес, просим сеть ──────────────────────────────────────
const handleWalletAddressInput = async (ctx) => {
  const session = ctx.session || {};

  if (session.sellerAction === 'set_wallet_address') {
    const address = ctx.message?.text?.trim();
    if (!address || address.length < 10) {
      await ctx.reply(ctx.t('seller_wallet_invalid_address'));
      return true;
    }

    if (ctx.message?.message_id) {
      ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    }

    ctx.session.sellerWalletAddress = address;
    ctx.session.sellerAction = 'set_wallet_network';

    await ctx.reply(ctx.t('seller_wallet_address_accepted'), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('TRC-20', 'seller:wallet:net:TRC-20'),
            Markup.button.callback('BEP-20', 'seller:wallet:net:BEP-20'),
          ],
          [
            Markup.button.callback('APTOS', 'seller:wallet:net:APTOS'),
            Markup.button.callback('SOL', 'seller:wallet:net:SOL'),
          ],
          [Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')],
        ]),
      }
    );
    return true;
  }

  if (session.sellerAction === 'set_wallet_network') {
    const network = ctx.message?.text?.trim();
    if (!network || network.length < 2) {
      await ctx.reply(ctx.t('seller_wallet_invalid_network'));
      return true;
    }

    if (ctx.message?.message_id) {
      ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    }

    return await saveWallet(ctx, session.sellerWalletAddress, network);
  }

  return false;
};

// ─── Быстрый выбор сети кнопкой ──────────────────────────────────────────────
const handleWalletNetworkChoice = async (ctx, network) => {
  const session = ctx.session || {};
  await ctx.answerCbQuery().catch(() => {});

  const address = session.sellerWalletAddress;
  if (!address) {
    await ctx.answerCbQuery(ctx.t('seller_session_expired'), { show_alert: true }).catch(() => {});
    return;
  }

  await saveWallet(ctx, address, network);
};

const saveWallet = async (ctx, address, network) => {
  const seller = await findSeller(ctx);
  if (!seller) return false;

  seller.walletAddress = address;
  seller.walletNetwork = network;
  await seller.save();

  ctx.session.sellerAction = null;
  ctx.session.sellerWalletAddress = null;

  await ctx.reply(
    ctx.t('seller_wallet_saved', { network: escapeHtml(network), wallet: escapeHtml(address) }),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('seller_btn_to_cabinet'), 'seller:cabinet')]]),
    }
  );
  return true;
};

// ─── Вывод средств ───────────────────────────────────────────────────────────
const startWithdraw = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  const minWithdraw = await getMinWithdraw();

  if (!seller.walletAddress) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_first_link_error'), { show_alert: true });
  }
  if (seller.balance < minWithdraw) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_min_error', { min: minWithdraw }), { show_alert: true });
  }

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });
  if (pendingWithdrawal) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_pending_error'), { show_alert: true });
  }

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = 'withdraw_amount';

  await ctx.answerCbQuery().catch(() => {});

  try {
    await ctx.editMessageText(
      ctx.t('seller_withdraw_title', { balance: seller.balance.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—'), min: minWithdraw }),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(ctx.t('seller_btn_withdraw_all', { balance: seller.balance.toFixed(2) }), `seller:withdraw:all`)],
          [Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')],
        ]),
      }
    );
  } catch (_) {
    await ctx.reply(
      ctx.t('seller_withdraw_title_short', { min: minWithdraw }),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(ctx.t('seller_btn_withdraw_all', { balance: seller.balance.toFixed(2) }), `seller:withdraw:all`)],
          [Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')],
        ]),
      }
    );
  }
};

const handleWithdrawAll = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = null;

  await ctx.answerCbQuery().catch(() => {});
  await processWithdrawAmount(ctx, seller, seller.balance);
};

const handleWithdrawAmountInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.sellerAction !== 'withdraw_amount') return false;

  const rawText = ctx.message?.text?.trim() || '';
  const amount = parseFloat(rawText.replace(',', '.'));

  if (ctx.message?.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  const minWithdraw = await getMinWithdraw();

  if (Number.isNaN(amount) || amount <= 0) {
    await ctx.reply(ctx.t('seller_withdraw_invalid_amount', { min: minWithdraw }));
    return true;
  }

  const seller = await findSeller(ctx);
  if (!seller) return false;

  if (amount < minWithdraw) {
    await ctx.reply(ctx.t('seller_withdraw_min_error', { min: minWithdraw }));
    return true;
  }

  if (amount > seller.balance) {
    await ctx.reply(ctx.t('seller_withdraw_insufficient', { balance: seller.balance.toFixed(2) }));
    return true;
  }

  ctx.session.sellerAction = null;
  await processWithdrawAmount(ctx, seller, amount);
  return true;
};

const processWithdrawAmount = async (ctx, seller, amount) => {
  const text = ctx.t('seller_withdraw_confirm_title', { amount: amount.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') });

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(ctx.t('seller_btn_confirm'), `seller:withdraw:confirm:${amount.toFixed(2)}`)],
        [Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(ctx.t('seller_btn_confirm'), `seller:withdraw:confirm:${amount.toFixed(2)}`)],
        [Markup.button.callback(ctx.t('btn_cancel'), 'seller:cabinet')],
      ]),
    });
  }
};

const confirmWithdraw = async (ctx, amountStr) => {
  const amount = parseFloat(amountStr);
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery(ctx.t('seller_no_access'), { show_alert: true });

  const minWithdraw = await getMinWithdraw();

  if (Number.isNaN(amount) || amount < minWithdraw) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_min_error', { min: minWithdraw }), { show_alert: true });
  }

  if (amount > seller.balance) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_insufficient', { balance: seller.balance.toFixed(2) }), { show_alert: true });
  }

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });
  if (pendingWithdrawal) {
    return ctx.answerCbQuery(ctx.t('seller_withdraw_pending_error'), { show_alert: true });
  }

  // Резервируем средства (списываем с баланса)
  seller.balance = parseFloat((seller.balance - amount).toFixed(8));
  await seller.save();

  const withdrawal = new SellerWithdrawal({
    sellerId: seller._id,
    amount,
    walletAddress: seller.walletAddress,
    network: seller.walletNetwork || 'TRC-20',
    status: 'pending',
  });
  await withdrawal.save();

  await notif.notifyAdminSellerWithdrawal(seller, withdrawal);

  await ctx.answerCbQuery(ctx.t('seller_withdraw_created_alert'));

  const text = ctx.t('seller_withdraw_created', { amount: amount.toFixed(2), wallet: escapeHtml(seller.walletAddress), network: escapeHtml(seller.walletNetwork || '—') });

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('seller_btn_to_cabinet'), 'seller:cabinet')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('seller_btn_to_cabinet'), 'seller:cabinet')]]),
    });
  }
};

module.exports = {
  showSellerCabinet,
  showSellerOrders,
  completeSellerOrder,
  startWalletSetup,
  handleWalletNetworkChoice,
  handleWalletAddressInput,
  startWithdraw,
  handleWithdrawAll,
  handleWithdrawAmountInput,
  confirmWithdraw,
  findSeller,
  handleSellerDelivery,
};

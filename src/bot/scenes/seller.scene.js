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
    const text =
      `🚫 <b>Доступ закрыт</b>\n\n` +
      `Вы не зарегистрированы как продавец.\n` +
      `Если вы хотите стать продавцом — обратитесь к администратору.`;
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Главное меню', 'menu:main')]]),
      });
    } catch (_) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Главное меню', 'menu:main')]]),
      });
    }
    return;
  }

  if (!seller.isActive) {
    await ctx.reply('❌ Ваш аккаунт продавца заблокирован. Обратитесь к администратору.').catch(() => {});
    return;
  }

  const minWithdraw = await getMinWithdraw();

  // Считаем активные заказы для этого продавца
  const activeOrders = await Order.countDocuments({ sellerId: seller._id, status: 'pending' });

  const walletLine = seller.walletAddress
    ? `💳 Кошелёк: <code>${escapeHtml(seller.walletAddress)}</code>\n🌐 Сеть: <b>${escapeHtml(seller.walletNetwork || '—')}</b>`
    : `💳 Кошелёк: <i>не привязан</i>`;

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });

  const text =
    `🏪 <b>Кабинет продавца</b>\n\n` +
    `<blockquote>👤 @${escapeHtml(seller.username)}\n` +
    `💰 Баланс: <b>${seller.balance.toFixed(2)} USDT</b>\n` +
    `📈 Всего заработано: <b>${seller.totalEarned.toFixed(2)} USDT</b>\n` +
    `📦 Активных заказов: <b>${activeOrders}</b>\n` +
    `${walletLine}</blockquote>\n\n` +
    `<i>Команды: /seller — кабинет</i>`;

  const buttons = [
    [Markup.button.callback('📦 Мои заказы', 'seller:orders')],
  ];

  if (!seller.walletAddress) {
    buttons.push([Markup.button.callback('💳 Привязать кошелёк', 'seller:wallet:setup')]);
  } else {
    buttons.push([Markup.button.callback('💳 Изменить кошелёк', 'seller:wallet:setup')]);
  }

  if (seller.balance >= minWithdraw && seller.walletAddress && !pendingWithdrawal) {
    buttons.push([Markup.button.callback(`💸 Вывести средства (мин. ${minWithdraw} USDT)`, 'seller:withdraw:start')]);
  } else if (pendingWithdrawal) {
    buttons.push([Markup.button.callback('⏳ Заявка на вывод ожидает', 'seller:noop')]);
  } else if (!seller.walletAddress) {
    buttons.push([Markup.button.callback('⚠️ Сначала привяжите кошелёк', 'seller:noop')]);
  } else {
    buttons.push([Markup.button.callback(`🔒 Вывод от ${minWithdraw} USDT (есть ${seller.balance.toFixed(2)})`, 'seller:noop')]);
  }

  buttons.push([Markup.button.callback('⬅️ Главное меню', 'menu:main')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

// ─── Заказы продавца ─────────────────────────────────────────────────────────
const showSellerOrders = async (ctx, filter = 'active') => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

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
    const emptyText = filter === 'active' ? '📭 Активных заказов нет.' : '📭 Истории заказов нет.';
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📦 Активные', 'seller:orders:active'),
          Markup.button.callback('📋 История', 'seller:orders:history'),
        ],
        [Markup.button.callback('⬅️ Кабинет', 'seller:cabinet')],
      ]),
    };
    try {
      await ctx.editMessageText(`🗂 <b>Мои заказы</b>\n\n${emptyText}`, opts);
    } catch (_) {
      await ctx.reply(`🗂 <b>Мои заказы</b>\n\n${emptyText}`, opts);
    }
    return;
  }

  let text = `🗂 <b>Мои заказы</b> (${filter === 'active' ? 'активные' : 'история'}):\n\n`;
  const buttons = [];

  for (const order of orders) {
    const product = order.productId;
    const date = new Date(order.createdAt).toLocaleDateString('ru-RU');
    const statusIcon = order.status === 'pending' ? '⏳' : order.status === 'completed' ? '✅' : '❌';
    text += `${statusIcon} ${escapeHtml(product?.name || 'Товар')} | ${order.sellerPayout?.toFixed(2) || '0.00'} USDT | ${date}\n`;

    if (order.status === 'pending') {
      buttons.push([
        Markup.button.callback(
          `✅ Выполнил — ${escapeHtml((product?.name || 'Заказ').substring(0, 22))}`,
          `seller:order:complete:${order._id}`
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback('📦 Активные', 'seller:orders:active'),
    Markup.button.callback('📋 История', 'seller:orders:history'),
  ]);
  buttons.push([Markup.button.callback('⬅️ Кабинет', 'seller:cabinet')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

// ─── Выполнить заказ ─────────────────────────────────────────────────────────
const completeSellerOrder = async (ctx, orderId) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

  const order = await Order.findOne({
    _id: orderId,
    sellerId: seller._id,
    status: 'pending',
  }).populate('productId').populate('userId');

  if (!order) {
    return ctx.answerCbQuery('❌ Заказ не найден или уже закрыт', { show_alert: true });
  }

  order.status = 'completed';
  order.confirmedAt = new Date();
  order.activationResult = 'Выполнено продавцом';
  await order.save();

  const buyer = order.userId;
  if (buyer) {
    await notif.notifyUserOrderCompleted(buyer, order, order.productId, 'Ваш заказ выполнен продавцом!').catch(() => {});
  }

  // Перечитываем актуальный баланс
  const freshSeller = await Seller.findById(seller._id);

  await ctx.answerCbQuery('✅ Заказ закрыт!');

  const text =
    `✅ <b>Заказ выполнен!</b>\n\n` +
    `📦 Товар: ${escapeHtml(order.productId?.name || 'Товар')}\n` +
    `💰 Доход: <b>+${(order.sellerPayout || 0).toFixed(2)} USDT</b>\n\n` +
    `Ваш текущий баланс: <b>${(freshSeller?.balance || seller.balance).toFixed(2)} USDT</b>`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 К заказам', 'seller:orders')],
        [Markup.button.callback('🏪 Кабинет', 'seller:cabinet')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏪 Кабинет', 'seller:cabinet')]]),
    });
  }
};

// ─── Настройка кошелька — шаг 1: ввод адреса ─────────────────────────────────
const startWalletSetup = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = 'set_wallet_address';

  await ctx.answerCbQuery().catch(() => {});

  const currentLine = seller.walletAddress
    ? `\n\nТекущий адрес: <code>${escapeHtml(seller.walletAddress)}</code> (${escapeHtml(seller.walletNetwork || '—')})`
    : '';

  const text =
    `💳 <b>Привязка кошелька</b>${currentLine}\n\n` +
    `Введите ваш <b>USDT адрес</b> (любая сеть — TRC-20, BEP-20, APTOS и др.):`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'seller:cabinet')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'seller:cabinet')]]),
    });
  }
};

// ─── Шаг 2: получили адрес, просим сеть ──────────────────────────────────────
const handleWalletAddressInput = async (ctx) => {
  const session = ctx.session || {};

  if (session.sellerAction === 'set_wallet_address') {
    const address = ctx.message?.text?.trim();
    if (!address || address.length < 10) {
      await ctx.reply('❌ Некорректный адрес. Введите ваш USDT адрес:');
      return true;
    }

    if (ctx.message?.message_id) {
      ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    }

    ctx.session.sellerWalletAddress = address;
    ctx.session.sellerAction = 'set_wallet_network';

    await ctx.reply(
      `📬 Адрес принят!\n\nТеперь введите <b>название сети</b>:\n\nПримеры: <code>TRC-20</code>, <code>BEP-20</code>, <code>APTOS</code>, <code>SOL</code>, <code>ERC-20</code>`,
      {
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
          [Markup.button.callback('❌ Отмена', 'seller:cabinet')],
        ]),
      }
    );
    return true;
  }

  if (session.sellerAction === 'set_wallet_network') {
    const network = ctx.message?.text?.trim();
    if (!network || network.length < 2) {
      await ctx.reply('❌ Введите название сети:');
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
    await ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true }).catch(() => {});
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
    `✅ <b>Кошелёк привязан!</b>\n\n` +
    `🌐 Сеть: <b>${escapeHtml(network)}</b>\n` +
    `💳 Адрес: <code>${escapeHtml(address)}</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏪 В кабинет', 'seller:cabinet')]]),
    }
  );
  return true;
};

// ─── Вывод средств ───────────────────────────────────────────────────────────
const startWithdraw = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

  const minWithdraw = await getMinWithdraw();

  if (!seller.walletAddress) {
    return ctx.answerCbQuery('❌ Сначала привяжите кошелёк', { show_alert: true });
  }
  if (seller.balance < minWithdraw) {
    return ctx.answerCbQuery(`❌ Минимум ${minWithdraw} USDT для вывода`, { show_alert: true });
  }

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });
  if (pendingWithdrawal) {
    return ctx.answerCbQuery('⏳ У вас уже есть ожидающая заявка', { show_alert: true });
  }

  ctx.session = ctx.session || {};
  ctx.session.sellerAction = 'withdraw_amount';

  await ctx.answerCbQuery().catch(() => {});

  try {
    await ctx.editMessageText(
      `💸 <b>Вывод средств</b>\n\n` +
      `💰 Доступно: <b>${seller.balance.toFixed(2)} USDT</b>\n` +
      `💳 Кошелёк: <code>${escapeHtml(seller.walletAddress)}</code>\n` +
      `🌐 Сеть: <b>${escapeHtml(seller.walletNetwork || '—')}</b>\n\n` +
      `Введите сумму для вывода (мин. ${minWithdraw} USDT):`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`💸 Вывести всё (${seller.balance.toFixed(2)} USDT)`, `seller:withdraw:all`)],
          [Markup.button.callback('❌ Отмена', 'seller:cabinet')],
        ]),
      }
    );
  } catch (_) {
    await ctx.reply(
      `💸 <b>Вывод средств</b>\n\nВведите сумму (мин. ${minWithdraw} USDT):`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`💸 Вывести всё (${seller.balance.toFixed(2)} USDT)`, `seller:withdraw:all`)],
          [Markup.button.callback('❌ Отмена', 'seller:cabinet')],
        ]),
      }
    );
  }
};

const handleWithdrawAll = async (ctx) => {
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

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
    await ctx.reply(`❌ Введите корректную сумму (например: ${minWithdraw}):`);
    return true;
  }

  const seller = await findSeller(ctx);
  if (!seller) return false;

  if (amount < minWithdraw) {
    await ctx.reply(`❌ Минимальная сумма вывода — ${minWithdraw} USDT`);
    return true;
  }

  if (amount > seller.balance) {
    await ctx.reply(`❌ Недостаточно средств. Доступно: ${seller.balance.toFixed(2)} USDT`);
    return true;
  }

  ctx.session.sellerAction = null;
  await processWithdrawAmount(ctx, seller, amount);
  return true;
};

const processWithdrawAmount = async (ctx, seller, amount) => {
  const text =
    `💸 <b>Подтверждение вывода</b>\n\n` +
    `<blockquote>💰 Сумма: <b>${amount.toFixed(2)} USDT</b>\n` +
    `💳 Кошелёк: <code>${escapeHtml(seller.walletAddress)}</code>\n` +
    `🌐 Сеть: <b>${escapeHtml(seller.walletNetwork || '—')}</b></blockquote>\n\n` +
    `Подтвердите заявку на вывод.`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить', `seller:withdraw:confirm:${amount.toFixed(2)}`)],
        [Markup.button.callback('❌ Отмена', 'seller:cabinet')],
      ]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить', `seller:withdraw:confirm:${amount.toFixed(2)}`)],
        [Markup.button.callback('❌ Отмена', 'seller:cabinet')],
      ]),
    });
  }
};

const confirmWithdraw = async (ctx, amountStr) => {
  const amount = parseFloat(amountStr);
  const seller = await findSeller(ctx);
  if (!seller) return ctx.answerCbQuery('❌ Нет доступа', { show_alert: true });

  const minWithdraw = await getMinWithdraw();

  if (Number.isNaN(amount) || amount < minWithdraw) {
    return ctx.answerCbQuery(`❌ Минимум ${minWithdraw} USDT`, { show_alert: true });
  }

  if (amount > seller.balance) {
    return ctx.answerCbQuery('❌ Недостаточно средств', { show_alert: true });
  }

  const pendingWithdrawal = await SellerWithdrawal.findOne({ sellerId: seller._id, status: 'pending' });
  if (pendingWithdrawal) {
    return ctx.answerCbQuery('⏳ У вас уже есть ожидающая заявка', { show_alert: true });
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

  await ctx.answerCbQuery('✅ Заявка создана!');

  const text =
    `✅ <b>Заявка на вывод создана!</b>\n\n` +
    `💰 Сумма: <b>${amount.toFixed(2)} USDT</b>\n` +
    `💳 Кошелёк: <code>${escapeHtml(seller.walletAddress)}</code>\n` +
    `🌐 Сеть: <b>${escapeHtml(seller.walletNetwork || '—')}</b>\n\n` +
    `⏳ Администратор обработает заявку в ближайшее время.`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏪 В кабинет', 'seller:cabinet')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🏪 В кабинет', 'seller:cabinet')]]),
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
};

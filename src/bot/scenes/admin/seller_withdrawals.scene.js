/**
 * seller_withdrawals.scene.js
 * Раздел в админ-панели: управление заявками продавцов на вывод
 * Аналог payments.scene.js но для продавцов
 */

const { Markup } = require('telegraf');
const Seller = require('../../../models/Seller');
const SellerWithdrawal = require('../../../models/SellerWithdrawal');
const notif = require('../../../services/notification.service');
const { escapeHtml } = require('../../utils/ui');

const NETWORK_LABELS = {
  trc20: '🔴 TRC-20 (Tron)',
  bep20: '🟡 BEP-20 (BSC)',
};

// ─── Список заявок на вывод ───────────────────────────────────────────────────
const showWithdrawalsList = async (ctx) => {
  const withdrawals = await SellerWithdrawal.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(30)
    .populate('sellerId');

  const allCount = await SellerWithdrawal.countDocuments();
  const pendingCount = withdrawals.length;

  if (!withdrawals.length) {
    const text =
      `💸 <b>Заявки продавцов на вывод</b>\n\n` +
      `📭 Нет новых заявок на вывод.\n\n` +
      `<blockquote>Всего заявок за всё время: ${allCount}</blockquote>`;
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 История выплат', 'admin:sellers:withdrawals:history')],
        [Markup.button.callback('👤 Все продавцы', 'admin:sellers:list')],
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    return;
  }

  let text = `💸 <b>Заявки продавцов на вывод</b> (${pendingCount} ожидают)\n\n`;
  const buttons = [];

  for (const w of withdrawals) {
    const seller = w.sellerId;
    const date = new Date(w.createdAt).toLocaleDateString('ru-RU');
    const network = NETWORK_LABELS[w.network] || w.network;
    const username = seller?.username || '?';

    text += `👤 @${escapeHtml(username)} | 💰 ${w.amount.toFixed(2)} USDT | ${network} | ${date}\n`;
    buttons.push([
      Markup.button.callback(
        `@${username} — ${w.amount.toFixed(2)} USDT`,
        `admin:sellers:withdrawal:${w._id}`
      ),
    ]);
  }

  buttons.push([Markup.button.callback('📋 История выплат', 'admin:sellers:withdrawals:history')]);
  buttons.push([Markup.button.callback('👤 Все продавцы', 'admin:sellers:list')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
};

// ─── Детальная карточка заявки ────────────────────────────────────────────────
const showWithdrawalDetail = async (ctx, withdrawalId) => {
  const withdrawal = await SellerWithdrawal.findById(withdrawalId).populate('sellerId');
  if (!withdrawal) return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });

  const seller = withdrawal.sellerId;
  const network = NETWORK_LABELS[withdrawal.network] || withdrawal.network;
  const statusMap = {
    pending: '⏳ Ожидает выплаты',
    completed: '✅ Выплачено',
    rejected: '❌ Отклонено',
  };

  const text =
    `💸 <b>Заявка на вывод</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Продавец:</b> @${escapeHtml(seller?.username || '?')}\n` +
    `💰 <b>Сумма:</b> <b>${withdrawal.amount.toFixed(2)} USDT</b>\n` +
    `💳 <b>Кошелёк:</b>\n<code>${escapeHtml(withdrawal.walletAddress)}</code>\n` +
    `🌐 <b>Сеть:</b> ${network}\n` +
    `📅 <b>Дата:</b> ${new Date(withdrawal.createdAt).toLocaleString('ru-RU')}\n` +
    `🔘 <b>Статус:</b> ${statusMap[withdrawal.status] || withdrawal.status}\n\n` +
    `<blockquote>💡 Переведите средства вручную на указанный адрес, затем нажмите «Подтвердить выплату».</blockquote>`;

  const buttons = [];

  if (withdrawal.status === 'pending') {
    buttons.push([
      Markup.button.callback('✅ Подтвердить выплату', `admin:sellers:withdrawal:confirm:${withdrawalId}`),
      Markup.button.callback('❌ Отклонить', `admin:sellers:withdrawal:reject:${withdrawalId}`),
    ]);
    if (seller?.telegramId) {
      buttons.push([Markup.button.url(`✉️ Написать @${seller.username || seller.telegramId}`, `tg://user?id=${seller.telegramId}`)]);
    }
  }

  buttons.push([Markup.button.callback('⬅️ К заявкам', 'admin:sellers:withdrawals')]);

  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

// ─── Подтвердить выплату ─────────────────────────────────────────────────────
const confirmWithdrawal = async (ctx, withdrawalId) => {
  const withdrawal = await SellerWithdrawal.findOneAndUpdate(
    { _id: withdrawalId, status: 'pending' },
    {
      $set: {
        status: 'completed',
        processedAt: new Date(),
      },
    },
    { new: true }
  ).populate('sellerId');

  if (!withdrawal) {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  const seller = withdrawal.sellerId;

  // Уведомляем продавца
  await notif.notifySellerWithdrawalResult(seller, withdrawal, 'confirmed');

  await ctx.answerCbQuery('✅ Выплата подтверждена!');

  const network = NETWORK_LABELS[withdrawal.network] || withdrawal.network;
  const text =
    `✅ <b>Выплата подтверждена</b>\n\n` +
    `👤 Продавец: @${escapeHtml(seller?.username || '?')}\n` +
    `💰 Выплачено: <b>${withdrawal.amount.toFixed(2)} USDT</b>\n` +
    `🌐 Сеть: ${network}\n` +
    `💳 Кошелёк: <code>${escapeHtml(withdrawal.walletAddress)}</code>`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('💸 К заявкам', 'admin:sellers:withdrawals')]]),
    });
  } catch (_) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('💸 К заявкам', 'admin:sellers:withdrawals')]]),
    });
  }
};

// ─── Отклонить заявку ────────────────────────────────────────────────────────
const rejectWithdrawal = async (ctx, withdrawalId) => {
  const withdrawal = await SellerWithdrawal.findById(withdrawalId).populate('sellerId');
  if (!withdrawal || withdrawal.status !== 'pending') {
    return ctx.answerCbQuery('⚠️ Уже обработано', { show_alert: true });
  }

  // Возвращаем средства продавцу
  const seller = withdrawal.sellerId;
  if (seller) {
    seller.balance = parseFloat((seller.balance + withdrawal.amount).toFixed(8));
    await seller.save();
  }

  withdrawal.status = 'rejected';
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  // Уведомляем продавца
  await notif.notifySellerWithdrawalResult(seller, withdrawal, 'rejected');

  await ctx.answerCbQuery('❌ Заявка отклонена, средства возвращены');
  await showWithdrawalsList(ctx);
};

// ─── Список всех продавцов ────────────────────────────────────────────────────
const showSellersList = async (ctx) => {
  const sellers = await Seller.find().sort({ createdAt: -1 }).limit(50);

  if (!sellers.length) {
    const text = `👥 <b>Продавцы</b>\n\n📭 Продавцов пока нет.`;
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить продавца', 'admin:sellers:add')],
        [Markup.button.callback('⬅️ Назад', 'admin:main')]
      ]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    return;
  }

  let text = `👥 <b>Продавцы</b> (${sellers.length}):\n\n`;
  const buttons = [];

  for (const seller of sellers) {
    const status = seller.isActive ? '✅' : '🔴';
    text += `${status} @${escapeHtml(seller.username)} — 💰 ${seller.balance.toFixed(2)} USDT (заработал: ${seller.totalEarned.toFixed(2)})\n`;
    buttons.push([
      Markup.button.callback(`${status} @${seller.username}`, `admin:sellers:view:${seller._id}`),
    ]);
  }

  buttons.push([Markup.button.callback('➕ Добавить продавца', 'admin:sellers:add')]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
};

// ─── Добавление продавца вручную ───────────────────────────────────────────────
const startAddSeller = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'add_seller';

  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `➕ <b>Добавить продавца</b>\n\n` +
    `Введите @username будущего продавца (без @):\n` +
    `<i>Когда пользователь зайдёт в бот, он автоматически будет привязан к этому аккаунту продавца.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:sellers:list')]]),
    }
  );
};

const handleAddSellerInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'add_seller') return false;

  const username = (ctx.message?.text || '').trim().replace(/^@/, '');
  if (!username || username.length < 2) {
    await ctx.reply('❌ Некорректный username. Введите без @:');
    return true;
  }

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  let seller = await Seller.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
  if (seller) {
    ctx.session.adminAction = null;
    await ctx.reply(`⚠️ Продавец @${seller.username} уже существует!`, {
      ...Markup.inlineKeyboard([[Markup.button.callback('К списку продавцов', 'admin:sellers:list')]]),
    });
    return true;
  }

  seller = new Seller({ username: username.toLowerCase(), displayName: username });
  await seller.save();

  const User = require('../../../models/User');
  const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
  if (user) {
    seller.telegramId = user.telegramId;
    await seller.save();
    await notif.notifySellerWelcome(seller);
  }

  ctx.session.adminAction = null;
  await ctx.reply(`✅ Продавец @${seller.username} успешно добавлен!`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('👤 Профиль', `admin:sellers:view:${seller._id}`)]]),
  });
  return true;
};

// ─── Профиль продавца (в адмике) ─────────────────────────────────────────────
const showSellerProfile = async (ctx, sellerId) => {
  const seller = await Seller.findById(sellerId);
  if (!seller) return ctx.answerCbQuery('❌ Продавец не найден', { show_alert: true });

  const activeOrders = await (require('../../../models/Order')).countDocuments({
    sellerId: seller._id,
    status: 'pending',
  });
  const completedOrders = await (require('../../../models/Order')).countDocuments({
    sellerId: seller._id,
    status: 'completed',
  });
  const pendingWithdrawals = await SellerWithdrawal.countDocuments({
    sellerId: seller._id,
    status: 'pending',
  });

  const network = NETWORK_LABELS[seller.walletNetwork] || seller.walletNetwork;
  const walletLine = seller.walletAddress
    ? `💳 Кошелёк: <code>${escapeHtml(seller.walletAddress)}</code> (${network})`
    : `💳 Кошелёк: <i>не привязан</i>`;

  const text =
    `👤 <b>Продавец</b> @${escapeHtml(seller.username)}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔘 Статус: ${seller.isActive ? '✅ Активен' : '🔴 Заблокирован'}\n` +
    `💰 Баланс: <b>${seller.balance.toFixed(2)} USDT</b>\n` +
    `📈 Всего заработано: <b>${seller.totalEarned.toFixed(2)} USDT</b>\n` +
    `📦 Активных заказов: ${activeOrders}\n` +
    `✅ Выполненных заказов: ${completedOrders}\n` +
    `💸 Ожидающих выплат: ${pendingWithdrawals}\n` +
    `${walletLine}\n` +
    `📅 Добавлен: ${new Date(seller.createdAt).toLocaleDateString('ru-RU')}`;

  const buttons = [
    [
      Markup.button.callback('💰 Изменить баланс', `admin:sellers:balance:${sellerId}`),
      Markup.button.callback('🗑 Удалить продавца', `admin:sellers:delete:${sellerId}`),
    ],
    [
      seller.isActive
        ? Markup.button.callback('🔴 Заблокировать', `admin:sellers:toggle:${sellerId}`)
        : Markup.button.callback('✅ Разблокировать', `admin:sellers:toggle:${sellerId}`),
    ],
    [Markup.button.callback('⬅️ К списку', 'admin:sellers:list')],
  ];

  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

// ─── Блок/разблок продавца ───────────────────────────────────────────────────
const toggleSeller = async (ctx, sellerId) => {
  const seller = await Seller.findById(sellerId);
  if (!seller) return ctx.answerCbQuery('❌ Продавец не найден', { show_alert: true });

  seller.isActive = !seller.isActive;
  await seller.save();

  await ctx.answerCbQuery(seller.isActive ? '✅ Разблокирован' : '🔴 Заблокирован');
  await showSellerProfile(ctx, sellerId);
};

// ─── Изменение баланса продавца ──────────────────────────────────────────────
const startEditSellerBalance = async (ctx, sellerId) => {
  const seller = await Seller.findById(sellerId);
  if (!seller) return ctx.answerCbQuery('❌ Продавец не найден', { show_alert: true });

  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'edit_seller_balance';
  ctx.session.editSellerId = sellerId;

  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `💰 <b>Изменение баланса</b>\n\n` +
    `Продавец: @${escapeHtml(seller.username)}\n` +
    `Текущий баланс: <b>${seller.balance.toFixed(2)} USDT</b>\n\n` +
    `Введите сумму для <b>добавления</b> (например: <code>10</code>) или <b>списания</b> (например: <code>-5</code>):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:sellers:view:${sellerId}`)]]),
    }
  );
};

const handleEditSellerBalanceInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'edit_seller_balance' || !session.editSellerId) return false;

  const rawText = ctx.message?.text?.trim() || '';
  const amount = parseFloat(rawText.replace(',', '.'));

  if (Number.isNaN(amount)) {
    await ctx.reply('❌ Некорректная сумма. Введите число (например, 10 или -5):');
    return true;
  }

  const seller = await Seller.findById(session.editSellerId);
  if (!seller) {
    ctx.session.adminAction = null;
    await ctx.reply('❌ Продавец не найден.');
    return true;
  }

  seller.balance = parseFloat((seller.balance + amount).toFixed(8));
  if (seller.balance < 0) seller.balance = 0;
  
  if (amount > 0) {
    seller.totalEarned = parseFloat((seller.totalEarned + amount).toFixed(8));
  }
  
  await seller.save();

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  ctx.session.adminAction = null;
  ctx.session.editSellerId = null;

  await ctx.reply(`✅ Баланс продавца @${seller.username} успешно изменён!\nНовый баланс: ${seller.balance.toFixed(2)} USDT`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('👤 Профиль', `admin:sellers:view:${seller._id}`)]])
  });

  return true;
};

// ─── Удаление продавца ───────────────────────────────────────────────────────
const deleteSeller = async (ctx, sellerId) => {
  const seller = await Seller.findById(sellerId);
  if (!seller) return ctx.answerCbQuery('❌ Продавец не найден', { show_alert: true });

  await Seller.deleteOne({ _id: sellerId });
  await ctx.answerCbQuery('✅ Продавец удалён', { show_alert: true });
  await showSellersList(ctx, 1);
};

// ─── История выплат ───────────────────────────────────────────────────────────
const showWithdrawalsHistory = async (ctx) => {
  const withdrawals = await SellerWithdrawal.find({ status: { $in: ['completed', 'rejected'] } })
    .sort({ processedAt: -1 })
    .limit(30)
    .populate('sellerId');

  if (!withdrawals.length) {
    const text = `📋 <b>История выплат</b>\n\n📭 Нет завершённых заявок.`;
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заявкам', 'admin:sellers:withdrawals')]]),
    };
    try {
      await ctx.editMessageText(text, opts);
    } catch (_) {
      await ctx.reply(text, opts).catch(() => {});
    }
    return;
  }

  let text = `📋 <b>История выплат</b> (последние 30):\n\n`;
  for (const w of withdrawals) {
    const seller = w.sellerId;
    const date = new Date(w.processedAt || w.createdAt).toLocaleDateString('ru-RU');
    const icon = w.status === 'completed' ? '✅' : '❌';
    text += `${icon} @${escapeHtml(seller?.username || '?')} — ${w.amount.toFixed(2)} USDT | ${date}\n`;
  }

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заявкам', 'admin:sellers:withdrawals')]]),
  };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
};

module.exports = {
  showWithdrawalsList,
  showWithdrawalDetail,
  confirmWithdrawal,
  rejectWithdrawal,
  showSellersList,
  startAddSeller,
  handleAddSellerInput,
  showSellerProfile,
  toggleSeller,
  showWithdrawalsHistory,
  startEditSellerBalance,
  handleEditSellerBalanceInput,
  deleteSeller,
};

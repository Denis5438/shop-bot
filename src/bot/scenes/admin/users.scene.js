const { Markup } = require('telegraf');
const User = require('../../../models/User');
const Order = require('../../../models/Order');
const Transaction = require('../../../models/Transaction');
const { toRub } = require('../../../services/currency.service');
const mongoose = require('mongoose');
const { escapeHtml } = require('../../utils/ui');
const i18n = require('../../middlewares/i18n');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PAGE_SIZE = 12;

// ─── Список всех пользователей с пагинацией ─────────────────────────────────
const showAllUsers = async (ctx, page = 1) => {
  await ctx.answerCbQuery().catch(() => {});

  const total = await User.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const users = await User.find()
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE);

  // Быстрая статистика
  const banned = await User.countDocuments({ isBanned: true });
  const admins = await User.countDocuments({ role: 'admin' });

  let text =
    `👥 <b>Все пользователи</b> (${total} чел., стр. ${safePage}/${totalPages})

` +
    `<blockquote>🚫 Забанено: ${banned} | 🔧 Админов: ${admins}</blockquote>

`;

  const buttons = [];

  for (const user of users) {
    const statusIcon = user.isBanned ? '🚫' : user.role === 'admin' ? '🔧' : '👤';
    const name = escapeHtml(
      (user.firstName || '') + (user.username ? ` (@${user.username})` : ` [${user.telegramId}]`)
    ).substring(0, 28);
    buttons.push([
      Markup.button.callback(`${statusIcon} ${name}`, `admin:user:view:${user._id}`),
    ]);
  }

  // Пагинация
  const navRow = [];
  if (safePage > 1) navRow.push(Markup.button.callback('⬅️', `admin:users:page:${safePage - 1}`));
  if (safePage < totalPages) navRow.push(Markup.button.callback('➡️', `admin:users:page:${safePage + 1}`));
  if (navRow.length) buttons.push(navRow);

  buttons.push([
    Markup.button.callback('🔍 Поиск', 'admin:search'),
    Markup.button.callback('⬅️ Назад', 'admin:main'),
  ]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts).catch(() => {});
  }
};

// Глобальный поиск
const showGlobalSearch = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'search_global';

  try {
    await ctx.editMessageText(
      `🔍 <b>Глобальный поиск</b>\n\n` +
      `Отправьте что-нибудь из этого:\n` +
      `• <code>ID заказа</code> (например: 65f3...)\n` +
      `• <code>@username</code> пользователя\n` +
      `• <code>Telegram ID</code> пользователя`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:main')]]),
      }
    );
  } catch (_) {
    await ctx.reply('🔍 Введите ID заказа, Telegram ID или @username:', Markup.inlineKeyboard([[Markup.button.callback('⬅️', 'admin:main')]]));
  }
};

// Обработка поиска
const handleGlobalSearch = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'search_global') return false;

  ctx.session.adminAction = null;
  const query = ctx.message.text.trim().replace('@', '');

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  // 1. Поиск по ID заказа (24 символа MongoDB ObjectId)
  if (mongoose.Types.ObjectId.isValid(query)) {
    const order = await Order.findById(query);
    if (order) {
      const ordersScene = require('./orders.scene');
      await ordersScene.showOrderDetail(ctx, order._id);
      return true;
    }
  }

  let user = null;

  // Попытка по telegramId
  const asNumber = parseInt(query);
  if (!isNaN(asNumber)) {
    user = await User.findOne({ telegramId: asNumber });
  }

  // Попытка по username
  if (!user) {
    user = await User.findOne({ username: { $regex: new RegExp(`^${escapeRegExp(query)}$`, 'i') } });
  }

  if (!user) {
    await ctx.reply('❌ Ничего не найдено по этому запросу.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Искать снова', 'admin:search')]]),
    });
    return true;
  }

  await showUserProfile(ctx, user._id.toString());
  return true;
};

// Профиль пользователя для админа.
// Вызывается из двух контекстов:
//   1) callback-кнопка (admin:user:view:..., admin:user:ban, ...) — есть ctx.callbackQuery.
//   2) текстовый поиск (handleGlobalSearch) — ctx.callbackQuery отсутствует.
// В случае (2) вызов answerCbQuery() синхронно бросает TypeError (до того как
// вернётся Promise), поэтому обычный .catch() не помогает — нужен guard.
const answerCbSafe = (ctx, text, opts) => {
  if (!ctx.callbackQuery) return Promise.resolve();
  return ctx.answerCbQuery(text, opts).catch(() => {});
};

const showUserProfile = async (ctx, userId) => {
  const user = await User.findById(userId);
  if (!user) return answerCbSafe(ctx, '❌ Пользователь не найден', { show_alert: true });

  const ordersCount = await Order.countDocuments({ userId: user._id });
  const referralsCount = await User.countDocuments({ referredBy: user._id });

  const text =
    `👤 <b>Пользователь</b>\n\n` +
    `🆔 TG ID: <code>${escapeHtml(user.telegramId)}</code>\n` +
    `📛 Имя: ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName || '')}\n` +
    `👤 Username: @${escapeHtml(user.username || 'нет')}\n` +
    `🌐 Язык: ${escapeHtml(user.language)}\n` +
    `🔘 Роль: ${escapeHtml(user.role)}\n` +
    `🚫 Бан: ${user.isBanned ? 'Да' : 'Нет'}\n\n` +
    `💰 Баланс: ${user.balance.toFixed(2)} USDT (~${toRub(user.balance)} ₽)\n` +
    `📦 Заказов: ${ordersCount}\n` +
    `💸 Потрачено: ${user.totalSpent.toFixed(2)} USDT\n` +
    `👥 Рефералов: ${referralsCount}\n` +
    `📅 Регистрация: ${new Date(user.createdAt).toLocaleDateString('ru-RU')}`;

  const buttons = [
    [Markup.button.callback('💰 Изменить баланс', `admin:user:balance:${user._id}`)],
    [
      user.isBanned
        ? Markup.button.callback('✅ Разбанить', `admin:user:unban:${user._id}`)
        : Markup.button.callback('🚫 Забанить', `admin:user:ban:${user._id}`),
      user.role === 'admin'
        ? Markup.button.callback('👤 Снять права', `admin:user:demote:${user._id}`)
        : Markup.button.callback('🔧 Сделать админом', `admin:user:promote:${user._id}`),
    ],
    [Markup.button.callback('🕹 Перехватить управление', `admin:takeover:start:${user._id}`)],
    [Markup.button.callback('📋 История транзакций', `admin:user:txs:${user._id}`)],
    [Markup.button.callback('📨 Написать', `admin:msg:user:${user.telegramId}`)],
    [Markup.button.callback('⬅️ К пользователям', 'admin:users')],
  ];

  // editMessageText сработает только если это callback-ctx; для text-ctx
  // (поиск по username/ID) отправляем новое сообщение.
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
  await answerCbSafe(ctx);
};

// Изменение баланса
const startChangeBalance = async (ctx, userId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'change_balance';
  ctx.session.targetUserId = userId;

  await ctx.reply(
    `💰 Введите сумму для изменения баланса:\n` +
    `Положительное (<code>+5</code>) — пополнение\n` +
    `Отрицательное (<code>-3</code>) — списание`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:user:view:${userId}`)]]),
    }
  );
};

const handleBalanceChange = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'change_balance') return false;

  const amount = parseFloat(ctx.message.text.replace(',', '.'));
  if (isNaN(amount)) {
    await ctx.reply('❌ Неверное число. Попробуйте: +5 или -3');
    return true;
  }

  const user = await User.findById(session.targetUserId);
  if (!user) { ctx.session.adminAction = null; return true; }

  user.balance = parseFloat((user.balance + amount).toFixed(8));
  if (user.balance < 0) user.balance = 0;
  await user.save();

  await new Transaction({
    userId: user._id,
    type: amount > 0 ? 'manual_credit' : 'manual_debit',
    amount,
    description: `Ручное изменение баланса администратором`,
  }).save();

  ctx.session.adminAction = null;
  ctx.session.targetUserId = null;

  await ctx.reply(
    `✅ Баланс пользователя <code>${escapeHtml(user.telegramId)}</code> изменён на ${amount > 0 ? '+' : ''}${amount} USDT\n` +
    `Новый баланс: ${user.balance.toFixed(2)} USDT`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('👤 К пользователю', `admin:user:view:${user._id}`)]]),
    }
  );
  return true;
};

// Бан / разбан / повышение / понижение
const toggleBan = async (ctx, userId) => {
  const user = await User.findById(userId);
  if (!user) return ctx.answerCbQuery('❌ Не найден', { show_alert: true });
  user.isBanned = !user.isBanned;
  await user.save();
  await showUserProfile(ctx, userId);
};

const toggleRole = async (ctx, userId) => {
  const user = await User.findById(userId);
  if (!user) return ctx.answerCbQuery('❌ Не найден', { show_alert: true });
  user.role = user.role === 'admin' ? 'user' : 'admin';
  await user.save();
  await showUserProfile(ctx, userId);
};

// История транзакций пользователя
const showUserTransactions = async (ctx, userId) => {
  const user = await User.findById(userId);
  const txs = await Transaction.find({ userId }).sort({ createdAt: -1 }).limit(15);

  const typeEmoji = {
    topup: '💳', purchase: '🛒', refund: '🔙',
    referral_bonus: '⭐', manual_credit: '➕', manual_debit: '➖',
  };

  let text = `📋 <b>Транзакции @${escapeHtml(user?.username || user?.telegramId || '?')}</b>\n\n`;
  for (const tx of txs) {
    const sign = tx.amount > 0 ? '+' : '';
    const date = new Date(tx.createdAt).toLocaleDateString('ru-RU');
    text += `${typeEmoji[tx.type] || '💱'} ${sign}${tx.amount.toFixed(2)} USDT | ${date}\n`;
    if (tx.description) text += `   <i>${escapeHtml(tx.description)}</i>\n`;
  }

  if (txs.length === 0) text += '📭 Транзакций нет';

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin:user:view:${userId}`)]]),
    });
  } catch (err) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `admin:user:view:${userId}`)]]),
    });
  }
};

// Режим перехвата
const startTakeover = async (ctx, userId) => {
  const targetUser = await User.findById(userId);
  if (!targetUser) return ctx.answerCbQuery('❌ Не найден', { show_alert: true });
  
  targetUser.takeoverBy = ctx.from.id;
  targetUser.takeoverAt = new Date();
  await targetUser.save();

  // Уведомляем юзера, что поддержка на связи
  try {
    await ctx.telegram.sendMessage(
      targetUser.telegramId,
      i18n.translate(targetUser.language || 'ru', 'support_hello'),
      { parse_mode: 'HTML' }
    );
  } catch (_) {}

  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'takeover_chat';
  ctx.session.takeoverUserId = targetUser.telegramId;
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `🕹 <b>Вы перехватили чат!</b>\n\n` +
    `Теперь сообщения от лица <code>@${escapeHtml(targetUser.username || targetUser.telegramId)}</code> будут форвардиться вам.\n` +
    `Всё, что вы напишете текстом, улетит ему от имени бота.\n\n` +
    `Нажмите кнопку ниже, чтобы вернуть бота в автомат.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🛑 Отпустить чат', `admin:takeover:stop:${targetUser._id}`)]])
    }
  );
};

const stopTakeover = async (ctx, userId) => {
  const targetUser = await User.findById(userId);
  if (targetUser) {
    targetUser.takeoverBy = null;
    targetUser.takeoverAt = null;
    await targetUser.save();
  }
  ctx.session.adminAction = null;
  ctx.session.takeoverUserId = null;
  
  await ctx.answerCbQuery();
  await ctx.reply(`🛑 <b>Сеанс перехвата завершен.</b> Бот снова обслуживает @${escapeHtml(targetUser?.username || targetUser?.telegramId || '?')} в автоматическом режиме.`, { parse_mode: 'HTML' });
};

module.exports = {
  showAllUsers,
  showGlobalSearch,
  handleGlobalSearch,
  showUserProfile,
  startChangeBalance,
  handleBalanceChange,
  toggleBan,
  toggleRole,
  showUserTransactions,
  startTakeover,
  stopTakeover,
};

const { Markup } = require('telegraf');
const User = require('../../../models/User');
const Order = require('../../../models/Order');
const Transaction = require('../../../models/Transaction');
const Seller = require('../../../models/Seller');
const mongoose = require('mongoose');
const { escapeHtml, formatDateTimeMSK, formatDateMSK, fmtUSDT, safeEdit } = require('../../utils/ui');
const i18n = require('../../middlewares/i18n');
const logger = require('../../../config/logger');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PAGE_SIZE = 12;

// ─── Список всех пользователей с пагинацией ─────────────────────────────────
const showAllUsers = async (ctx, page = 1) => {
  await ctx.answerCbQuery().catch(() => {});

  // Счётчики параллельно, список - только нужные поля без гидрации
  const [total, banned, admins] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isBanned: true }),
    User.countDocuments({ role: 'admin' }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const users = await User.find()
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select('telegramId username firstName isBanned role')
    .lean();

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

  buttons.push([Markup.button.callback('📢 Массовая рассылка всем', 'admin:custom_broadcast:start')]);
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
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:users')]]),
      }
    );
  } catch (_) {
    await ctx.reply('🔍 Введите ID заказа, Telegram ID или @username:', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'admin:users')]]));
  }
};

// Обработка поиска
const handleGlobalSearch = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'search_global') return false;

  ctx.session.adminAction = null;
  const rawText = ctx.message.text.trim();
  const query = rawText.replace('@', '').trim();

  if (ctx.message && ctx.message.message_id) {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  // 1. Поиск по 24-символьному MongoDB ObjectId (Заказ, Заявка на пополнение или Пользователь)
  if (mongoose.Types.ObjectId.isValid(query)) {
    // 1.1 Заказ
    const order = await Order.findById(query);
    if (order) {
      const ordersScene = require('./orders.scene');
      await ordersScene.showOrderDetail(ctx, order._id);
      return true;
    }

    // 1.2 Заявка на пополнение
    const TopupRequest = require('../../../models/TopupRequest');
    const topup = await TopupRequest.findById(query);
    if (topup) {
      const paymentsScene = require('./payments.scene');
      await paymentsScene.showPaymentDetail(ctx, topup._id);
      return true;
    }

    // 1.3 Пользователь по _id
    const userById = await User.findById(query);
    if (userById) {
      await showUserProfile(ctx, userById._id.toString());
      return true;
    }
  }

  let user = null;

  // 2. Попытка по telegramId (число)
  const asNumber = parseInt(query, 10);
  if (!isNaN(asNumber)) {
    user = await User.findOne({ telegramId: asNumber });
  }

  // 3. Попытка по username
  if (!user) {
    user = await User.findOne({ username: { $regex: new RegExp(`^${escapeRegExp(query)}$`, 'i') } });
  }

  // 4. Попытка поиска заявки на пополнение по TXID / Bybit UID
  if (!user) {
    const TopupRequest = require('../../../models/TopupRequest');
    const topupByProof = await TopupRequest.findOne({ proofText: { $regex: escapeRegExp(query), $options: 'i' } });
    if (topupByProof) {
      const paymentsScene = require('./payments.scene');
      await paymentsScene.showPaymentDetail(ctx, topupByProof._id);
      return true;
    }
  }

  if (!user) {
    await ctx.reply('❌ Ничего не найдено по этому запросу (проверьте ID, @username или номер заказа).', {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔍 Искать снова', 'admin:search'),
          Markup.button.callback('👥 К пользователям', 'admin:users'),
        ],
      ]),
    });
    return true;
  }

  await showUserProfile(ctx, user._id.toString());
  return true;
};

// Профиль пользователя для админа.
// Вызывается из двух контекстов:
//   1) callback-кнопка (admin:user:view:..., admin:user:ban, ...) - есть ctx.callbackQuery.
//   2) текстовый поиск (handleGlobalSearch) - ctx.callbackQuery отсутствует.
// В случае (2) вызов answerCbQuery() синхронно бросает TypeError (до того как
// вернётся Promise), поэтому обычный .catch() не помогает - нужен guard.
const answerCbSafe = (ctx, text, opts) => {
  if (!ctx.callbackQuery) return Promise.resolve();
  return ctx.answerCbQuery(text, opts).catch(() => {});
};

const showUserProfile = async (ctx, userId) => {
  try {
    const user = await User.findById(userId).lean();
    if (!user) return answerCbSafe(ctx, '❌ Пользователь не найден', { show_alert: true });

    let ordersCount = 0;
    let referralsCount = 0;
    let isSeller = false;

    try {
      ordersCount = await Order.countDocuments({ userId: user._id });
    } catch (_) {}
    try {
      referralsCount = await User.countDocuments({ referredBy: user._id });
    } catch (_) {}
    try {
      isSeller = (await Seller.exists({ telegramId: user.telegramId, isActive: true })) != null;
    } catch (_) {}

    const tosDateStr = user.acceptedToSAt ? formatDateTimeMSK(user.acceptedToSAt) : null;
    const tosLine = user.acceptedToS
      ? `📜 Оферта (ToS): ✅ <b>Принята</b> (${tosDateStr || 'Да'})\n`
      : `📜 Оферта (ToS): 🔴 <b>Не принята</b>\n`;

    const tosLegalProof = user.acceptedToS && tosDateStr
      ? `\n⚖️ <i>Юр. выписка: Пользователь ID ${user.telegramId} ${tosDateStr} нажал кнопку согласия с Офертой.</i>\n`
      : '';

    const cleanUsername = user.username ? String(user.username).replace(/^@+/, '').trim() : '';
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Пользователь';
    
    // Безопасные ссылки (без лишних спецсимволов и пробелов)
    const nameDisplay = cleanUsername
      ? `<a href="https://t.me/${encodeURIComponent(cleanUsername)}">${escapeHtml(fullName)}</a>`
      : `<a href="tg://user?id=${user.telegramId}">${escapeHtml(fullName)}</a>`;
    const usernameDisplay = cleanUsername
      ? `<a href="https://t.me/${encodeURIComponent(cleanUsername)}">@${escapeHtml(cleanUsername)}</a>`
      : '<i>нет</i>';

    const userBalance = typeof user.balance === 'number' ? user.balance : (parseFloat(user.balance) || 0);
    const userSpent = typeof user.totalSpent === 'number' ? user.totalSpent : (parseFloat(user.totalSpent) || 0);
    const regDate = user.createdAt ? formatDateMSK(user.createdAt) : 'Неизвестно';

    const text =
      `👤 <b>Пользователь</b>\n\n` +
      `🆔 TG ID: <code>${user.telegramId}</code>\n` +
      `📛 Имя: ${nameDisplay}\n` +
      `👤 Username: ${usernameDisplay}\n` +
      `🌐 Язык: ${escapeHtml(user.language || 'ru')}\n` +
      `🔘 Роль: ${escapeHtml(user.role || 'user')}\n` +
      `🚫 Бан: ${user.isBanned ? 'Да' : 'Нет'}\n` +
      tosLine +
      tosLegalProof + '\n' +
      `💰 Баланс: ${fmtUSDT(userBalance)}\n` +
      `📦 Заказов: ${ordersCount}\n` +
      `💸 Потрачено: ${userSpent.toFixed(2)} USDT\n` +
      `👥 Рефералов: ${referralsCount}\n` +
      `📅 Регистрация: ${regDate}`;

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
      [
        isSeller
          ? Markup.button.callback('👔 Снять селлера', `admin:user:seller_toggle:${user._id}`)
          : Markup.button.callback('👔 Сделать селлером', `admin:user:seller_toggle:${user._id}`),
      ],
      [Markup.button.callback('🕹 Перехватить управление', `admin:takeover:start:${user._id}`)],
      [Markup.button.callback('🛡 Управление гарантией', `admin:user:warranty:${user._id}`)],
      [Markup.button.callback('📋 История транзакций', `admin:user:txs:${user._id}`)],
    ];

    if (cleanUsername) {
      buttons.push([Markup.button.url(`👤 Открыть @${cleanUsername} в Telegram`, `https://t.me/${encodeURIComponent(cleanUsername)}`)]);
    }

    buttons.push([Markup.button.callback('📨 Написать в боте', `admin:msg:user:${user.telegramId}`)]);
    buttons.push([Markup.button.callback('⬅️ К пользователям', 'admin:users')]);

    const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) };
    await safeEdit(ctx, text, opts);
  } catch (err) {
    logger.error(`Error in showUserProfile: ${err.message}`, { stack: err.stack });
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('❌ Ошибка при открытии профиля', { show_alert: true }).catch(() => {});
    }
  }
};

// Изменение баланса
const startChangeBalance = async (ctx, userId) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'change_balance';
  ctx.session.targetUserId = userId;

  await ctx.reply(
    `💰 Введите сумму для изменения баланса:\n` +
    `Положительное (<code>+5</code>) - пополнение\n` +
    `Отрицательное (<code>-3</code>) - списание`,
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

  // Атомарный $inc + защита от ухода в минус условием в фильтре
  let user;
  if (amount < 0) {
    user = await User.findOneAndUpdate(
      { _id: session.targetUserId, balance: { $gte: -amount } },
      { $inc: { balance: amount } },
      { new: true }
    );
    if (!user) {
      // Не хватает баланса для списания - обнуляем (прежнее поведение "не ниже 0")
      user = await User.findOneAndUpdate(
        { _id: session.targetUserId },
        { $set: { balance: 0 } },
        { new: true }
      );
    }
  } else {
    user = await User.findOneAndUpdate(
      { _id: session.targetUserId },
      { $inc: { balance: amount } },
      { new: true }
    );
  }
  if (!user) { ctx.session.adminAction = null; return true; }

  // Пользователь мог быть закэширован middleware - сбрасываем
  const { invalidateUserCache } = require('../../middlewares/user');
  invalidateUserCache(user.telegramId);

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
  // Сброс кэша middleware, чтобы бан/разбан применился мгновенно
  require('../../middlewares/user').invalidateUserCache(user.telegramId);
  await showUserProfile(ctx, userId);
};

const toggleRole = async (ctx, userId) => {
  const user = await User.findById(userId);
  if (!user) return ctx.answerCbQuery('❌ Не найден', { show_alert: true });
  user.role = user.role === 'admin' ? 'user' : 'admin';
  await user.save();
  // Сброс кэша middleware, чтобы смена роли применилась мгновенно
  require('../../middlewares/user').invalidateUserCache(user.telegramId);
  await showUserProfile(ctx, userId);
};

const toggleSeller = async (ctx, userId) => {
  const user = await User.findById(userId);
  if (!user) return ctx.answerCbQuery('❌ Не найден', { show_alert: true });
  // Флаг isSeller закэширован в middleware - сбрасываем ПОСЛЕ изменения
  // (иначе апдейт юзера в промежутке снова закэширует старое значение)
  const invalidateAfter = () => require('../../middlewares/user').invalidateUserCache(user.telegramId);

  let seller = await Seller.findOne({ telegramId: user.telegramId });
  if (seller) {
    seller.isActive = !seller.isActive;
    await seller.save();
    invalidateAfter();
    await ctx.answerCbQuery(seller.isActive ? '✅ Назначен продавцом!' : '❌ Права продавца сняты');
  } else {
    // Пытаемся создать нового селлера
    let username = user.username || String(user.telegramId);
    let existingSeller = await Seller.findOne({ username: { $regex: new RegExp(`^${escapeRegExp(username)}$`, 'i') } });
    if (existingSeller && existingSeller.telegramId && existingSeller.telegramId !== user.telegramId) {
      username = `id${user.telegramId}`; // username занят
    } else if (existingSeller && !existingSeller.telegramId) {
      existingSeller.telegramId = user.telegramId;
      existingSeller.isActive = true;
      existingSeller.displayName = user.firstName || username;
      await existingSeller.save();
      invalidateAfter();
      await ctx.answerCbQuery('✅ Назначен продавцом!');
      await showUserProfile(ctx, userId);
      return;
    }

    seller = new Seller({ telegramId: user.telegramId, username, displayName: user.firstName || username, isActive: true });
    await seller.save();
    invalidateAfter();
    await ctx.answerCbQuery('✅ Назначен продавцом!');
  }
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
  // Перехват-интерцептор читает takeoverBy из кэша middleware - сбрасываем,
  // иначе до 30 сек сообщения пользователя не форвардятся админу
  require('../../middlewares/user').invalidateUserCache(targetUser.telegramId);

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
    // Сброс кэша - иначе до 30 сек бот продолжает «глотать» сообщения юзера
    require('../../middlewares/user').invalidateUserCache(targetUser.telegramId);
  }
  ctx.session.adminAction = null;
  ctx.session.takeoverUserId = null;
  
  await ctx.answerCbQuery();
  await ctx.reply(`🛑 <b>Сеанс перехвата завершен.</b> Бот снова обслуживает @${escapeHtml(targetUser?.username || targetUser?.telegramId || '?')} в автоматическом режиме.`, { parse_mode: 'HTML' });
};

const startCustomBroadcast = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.adminAction = 'custom_broadcast_input';
  await ctx.reply(
    `📢 <b>Массовая рассылка всем пользователям</b>\n\n` +
    `Отправьте любое сообщение для рассылки (текст, фото с подписью, видео или файл):`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:users')]]),
    }
  );
};

const handleCustomBroadcastInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'custom_broadcast_input') return false;

  let mediaType = null;
  let mediaId = null;

  if (ctx.message.photo && ctx.message.photo.length > 0) {
    mediaType = 'photo';
    mediaId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (ctx.message.video) {
    mediaType = 'video';
    mediaId = ctx.message.video.file_id;
  } else if (ctx.message.document) {
    mediaType = 'document';
    mediaId = ctx.message.document.file_id;
  }

  const text = ctx.message.caption || ctx.message.text || '';
  if (!text && !mediaId) {
    await ctx.reply('❌ Пожалуйста, отправьте текст или медиафайл.');
    return true;
  }

  session.adminAction = null;
  session.broadcastPayload = { mediaType, mediaId, text, includeToS: false };

  await ctx.reply(
    `❓ <b>Добавить к рассылке интерактивную кнопку согласия с Офертой?</b>\n\n` +
    `• <b>Добавить кнопку:</b> Под вашим сообщением появится кнопка <code>[☑️ Я ознакомлен и принимаю условия Оферты]</code>. При клике покупателя в БД зафиксируется согласие с точными датой и временем.\n` +
    `• <b>Без кнопки:</b> Сообщение уйдёт как обычное информационное пуш-уведомление.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📜 Добавить кнопку Оферты', 'admin:custom_broadcast:tos_yes')],
        [Markup.button.callback('📢 Обычная рассылка (без кнопки)', 'admin:custom_broadcast:tos_no')],
        [Markup.button.callback('❌ Отмена', 'admin:users')],
      ]),
    }
  );

  return true;
};

const showCustomBroadcastPreview = async (ctx, includeToS) => {
  const session = ctx.session || {};
  const payload = session.broadcastPayload;
  if (!payload) return ctx.answerCbQuery('❌ Сессия рассылки истекла', { show_alert: true });

  payload.includeToS = includeToS;
  await ctx.answerCbQuery();

  const totalUsers = await User.countDocuments({ isBanned: false });

  const inlineButtons = [];
  if (includeToS) {
    inlineButtons.push([Markup.button.callback('☑️ Я ознакомлен и принимаю условия Оферты', 'shop:noop')]);
  }
  inlineButtons.push([Markup.button.callback(`🚀 Запустить рассылку (${totalUsers} чел.)`, 'admin:custom_broadcast:confirm')]);
  inlineButtons.push([Markup.button.callback('❌ Отмена', 'admin:users')]);

  const opts = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(inlineButtons),
  };

  const previewPrefix = `👁 <b>Предпросмотр вашей рассылки (${includeToS ? 'с кнопкой Оферты' : 'обычная'}):</b>\n\n`;

  if (payload.mediaType === 'photo') {
    await ctx.replyWithPhoto(payload.mediaId, { caption: previewPrefix + payload.text, ...opts });
  } else if (payload.mediaType === 'video') {
    await ctx.replyWithVideo(payload.mediaId, { caption: previewPrefix + payload.text, ...opts });
  } else if (payload.mediaType === 'document') {
    await ctx.replyWithDocument(payload.mediaId, { caption: previewPrefix + payload.text, ...opts });
  } else {
    await ctx.reply(previewPrefix + payload.text, opts);
  }
};

const executeCustomBroadcast = async (ctx) => {
  const session = ctx.session || {};
  const payload = session.broadcastPayload;
  if (!payload) return ctx.answerCbQuery('❌ Сессия рассылки истекла', { show_alert: true });

  session.broadcastPayload = null;
  await ctx.answerCbQuery('🚀 Запускаю рассылку...');
  await ctx.reply('⏳ <b>Идёт процесс рассылки...</b> Бот уведомит вас по завершении.', { parse_mode: 'HTML' });

  // Курсор + lean: не грузим всю коллекцию пользователей в память разом
  const users = User.find({ isBanned: false }).select('telegramId language').lean().cursor();
  let sent = 0;
  let failed = 0;

  for await (const u of users) {
    try {
      const userLang = u.language || 'ru';
      const buttonText = userLang === 'en' ? '☑️ I accept the Terms & Offer' : '☑️ Я ознакомлен и принимаю условия Оферты';

      const keyboard = payload.includeToS
        ? Markup.inlineKeyboard([[Markup.button.callback(buttonText, 'tos:accept_broadcast')]])
        : null;

      const opts = { parse_mode: 'HTML', caption: payload.text, ...keyboard };

      if (payload.mediaType === 'photo') {
        await ctx.telegram.sendPhoto(u.telegramId, payload.mediaId, opts);
      } else if (payload.mediaType === 'video') {
        await ctx.telegram.sendVideo(u.telegramId, payload.mediaId, opts);
      } else if (payload.mediaType === 'document') {
        await ctx.telegram.sendDocument(u.telegramId, payload.mediaId, opts);
      } else {
        await ctx.telegram.sendMessage(u.telegramId, payload.text, { parse_mode: 'HTML', ...keyboard });
      }
      sent++;
    } catch (_) {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  await ctx.reply(
    `✅ <b>Массовая рассылка завершена!</b>\n\n` +
    `📨 Успешно доставлено: <b>${sent}</b>\n` +
    `❌ Ошибок (заблокировали бота): <b>${failed}</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К пользователям', 'admin:users')]]),
    }
  );
};

const ORDERS_PER_PAGE = 4;

const showUserWarranties = async (ctx, userId, page = 1) => {
  const user = await User.findById(userId);
  if (!user) return answerCbSafe(ctx, '❌ Пользователь не найден', { show_alert: true });

  const totalOrders = await Order.countDocuments({ userId: user._id });
  const totalPages = Math.max(1, Math.ceil(totalOrders / ORDERS_PER_PAGE));
  const safePage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);

  const orders = await Order.find({ userId: user._id })
    .populate('productId', 'name icon')
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * ORDERS_PER_PAGE)
    .limit(ORDERS_PER_PAGE)
    .lean();

  let text = `🛡 <b>Управление гарантией пользователя</b>\n` +
    `👤 <b>Пользователь:</b> @${escapeHtml(user.username || user.telegramId)}\n` +
    `📦 Всего заказов: <b>${totalOrders}</b> (Стр. ${safePage}/${totalPages})\n\n`;

  const buttons = [];

  if (orders.length === 0) {
    text += `<i>У пользователя нет заказов.</i>`;
  } else {
    for (const ord of orders) {
      const pName = ord.productId?.name || 'Товар';
      const pIcon = ord.productId?.icon || '📦';
      const wDays = ord.warrantyDays ?? 0;
      const dateStr = formatDateMSK(ord.createdAt);

      text += `${pIcon} <b>${escapeHtml(pName)}</b> (${dateStr})\n` +
        `🛡 Гарантия: <b>${wDays} дн.</b>\n\n`;

      buttons.push([
        Markup.button.callback('➖ -1', `admin:user:warr_add:${ord._id}:-1:${safePage}`),
        Markup.button.callback('➕ +1', `admin:user:warr_add:${ord._id}:1:${safePage}`),
        Markup.button.callback('➕ +7', `admin:user:warr_add:${ord._id}:7:${safePage}`),
        Markup.button.callback('➕ +30', `admin:user:warr_add:${ord._id}:30:${safePage}`),
        Markup.button.callback('❌ Снять', `admin:user:warr_reset:${ord._id}:${safePage}`),
      ]);
    }
  }

  // Навигация по страницам заказов
  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback('⬅️ Назад', `admin:user:warranty:${userId}:${safePage - 1}`));
  }
  if (totalPages > 1) {
    navRow.push(Markup.button.callback(`${safePage}/${totalPages}`, 'admin:noop'));
  }
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback('Вперёд ➡️', `admin:user:warranty:${userId}:${safePage + 1}`));
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  buttons.push([Markup.button.callback('⬅️ В профиль пользователя', `admin:user:view:${userId}`)]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.reply(text, opts);
  }
};

const execUserWarrantyAdd = async (ctx, orderId, days, page = 1) => {
  const delta = parseInt(days, 10);
  const order = await Order.findById(orderId);
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  const newDays = Math.max(0, (order.warrantyDays ?? 0) + delta);
  order.warrantyDays = newDays;
  await order.save();

  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  await ctx.answerCbQuery(`✅ Гарантия: ${sign} дн. (Итого: ${newDays} дн.)!`, { show_alert: true }).catch(() => {});
  if (order.userId) {
    await showUserWarranties(ctx, order.userId.toString(), page);
  }
};

const execUserWarrantyReset = async (ctx, orderId, page = 1) => {
  const order = await Order.findByIdAndUpdate(
    orderId,
    { $set: { warrantyDays: 0 } },
    { new: true }
  );
  await ctx.answerCbQuery('✅ Гарантия аннулирована (0 дн.)!', { show_alert: true }).catch(() => {});
  if (order?.userId) {
    await showUserWarranties(ctx, order.userId.toString(), page);
  }
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
  toggleSeller,
  showUserTransactions,
  startTakeover,
  stopTakeover,
  startCustomBroadcast,
  handleCustomBroadcastInput,
  showCustomBroadcastPreview,
  executeCustomBroadcast,
  showUserWarranties,
  execUserWarrantyAdd,
  execUserWarrantyReset,
};

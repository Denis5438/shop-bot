const logger = require('../config/logger');
const { ADMIN_IDS } = require('../config');
const { toRub } = require('./currency.service');
const { getProviderLabel, resolveOrderProvider, resolveProductProvider } = require('./provider.service');
const { Markup } = require('telegraf');
const { escapeHtml } = require('../bot/utils/ui');
const User = require('../models/User');
const digest = require('./notification-digest.service');
const i18n = require('../bot/middlewares/i18n');

let botInstance = null;

const h = (value, fallback = '') => escapeHtml(value ?? fallback);

const setBot = (bot) => { botInstance = bot; };

// ─── Уведомление продавцу о назначении ───────────────────────────────────────
const notifySellerWelcome = async (seller) => {
  if (!botInstance || !seller?.telegramId) return;
  try {
    await botInstance.telegram.sendMessage(
      seller.telegramId,
      `🎉 <b>Вы стали продавцом!</b>\n\n` +
      `Используйте команду /seller для доступа к вашему кабинету.\n\n` +
      `<blockquote>В кабинете вы можете:\n` +
      `💳 Привязать USDT кошелёк\n` +
      `📦 Видеть ваши заказы\n` +
      `💸 Запрашивать вывод средств</blockquote>\n\n` +
      `Минимальная сумма вывода устанавливается администратором.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🏪 Открыть кабинет', callback_data: 'seller:cabinet' }]],
        },
      }
    );
  } catch (err) {
    logger.warn(`❌ Не удалось отправить welcome продавцу ${seller.telegramId}: ${err.message}`);
  }
};

const sendToAdmins = async (message, extra = {}) => {
  if (!botInstance) return;
  for (const adminId of ADMIN_IDS) {
    try {
      await botInstance.telegram.sendMessage(adminId, message, { parse_mode: 'HTML', ...extra });
    } catch (err) {
      logger.warn(`❌ Не удалось отправить сообщение админу ${adminId}: ${err.message}`);
    }
  }
};

const sendToUser = async (telegramId, message, extra = {}) => {
  if (!botInstance) return;
  try {
    await botInstance.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    logger.warn(`❌ Не удалось отправить сообщение пользователю ${telegramId}: ${err.message}`);
  }
};

// Новый заказ — уведомление администраторам
const notifyAdminNewOrder = async (order, user, product) => {
  const providerLabel = getProviderLabel(resolveOrderProvider(order, product));
  // Краткая строка для digest (если включён — уходит в буфер, а не сразу).
  const digestLine = `@${user.username || user.telegramId} — ${product?.name || 'Товар'} (${order.price} USDT)`;
  if (digest.queue('NEW_ORDER', digestLine)) return;

  const msg =
    `🛒 <b>Новый заказ!</b>\n\n` +
    `📋 ID: <code>${order._id}</code>\n` +
    `👤 Пользователь: ${h(user.firstName)} (@${h(user.username || 'нет')}) | <code>${h(user.telegramId)}</code>\n` +
    `📦 Товар: ${product?.icon || '📦'} ${h(product?.name, 'Товар')}\n` +
    `🧩 Поставщик: ${h(providerLabel)}\n` +
    `💰 Сумма: ${order.price} USDT (~${toRub(order.price)} ₽)\n` +
    `📅 Дата: ${new Date().toLocaleString('ru-RU')}`;

  await sendToAdmins(msg);
};

// Токен получен — уведомление администраторам
const notifyAdminTokenReceived = async (order, user, product) => {
  const digestLine = `@${user.username || user.telegramId} — ${product?.name || 'Товар'} (заказ ${String(order._id).slice(-6)})`;
  if (digest.queue('TOKEN_RECEIVED', digestLine)) return;

  const msg =
    `🔑 <b>Получен токен для активации!</b>\n\n` +
    `📋 ID: <code>${order._id}</code>\n` +
    `👤 Пользователь: ${h(user.firstName)} (@${h(user.username || 'нет')}) | <code>${h(user.telegramId)}</code>\n` +
    `📦 Товар: ${product?.icon || '📦'} ${h(product?.name, 'Товар')}\n` +
    `💰 Сумма: ${order.price} USDT\n\n` +
    `✅ Зайдите в <b>/admin → 📋 Заказы</b> для подтверждения`;

  await sendToAdmins(msg);
};

// Запрос на пополнение — уведомление администраторам
const notifyAdminTopupRequest = async (request, user, method = 'unknown', network = null, amounts = null) => {
  const methodLabels = {
    card:    '🏦 Карта Idbank (Т-Банк / Сбербанк)',
    bybit:   '📊 Bybit (USDT)',
    unknown: '❓ Неизвестно',
  };

  const networkLabels = {
    trc20: '🔴 TRC-20 (Tron)',
    bep20: '🟡 BEP-20 (BSC)',
  };

  // Дайджест: сворачиваем «обычные» pending-заявки в сводку. Подтверждённые
  // (status=confirmed) уходят сразу — это деньги уже на балансе, админу важно
  // увидеть их в реальном времени.
  if (request?.status === 'pending') {
    const amountStr = amounts
      ? `${amounts.amountUSDT.toFixed(2)} USDT (~${amounts.amountRUB.toFixed(0)} ₽)`
      : (request.amount ? `${request.amount.toFixed(2)} USDT` : '? USDT');
    const digestLine = `@${user.username || user.telegramId} — ${amountStr} · ${methodLabels[method] || method}` +
      (network ? ` · ${networkLabels[network] || network}` : '');
    if (digest.queue('NEW_TOPUP', digestLine)) return;
  }

  // Строка с суммой
  let amountLine = '';
  if (amounts) {
    const isCard = method === 'card';
    if (isCard) {
      // Для карты основная сумма в рублях
      amountLine =
        `💵 <b>Сумма:</b> ${amounts.amountRUB.toFixed(0)} ₽ (= ${amounts.amountUSDT.toFixed(2)} USDT)\n` +
        `💱 <b>Курс:</b> 1 USDT = ${amounts.rate.toFixed(2)} ₽ <i>(open.er-api.com)</i>\n`;
    } else {
      // Для Bybit основная сумма в USDT
      amountLine =
        `💵 <b>Сумма:</b> ${amounts.amountUSDT.toFixed(2)} USDT (~${amounts.amountRUB.toFixed(0)} ₽)\n` +
        `💱 <b>Курс:</b> 1 USDT = ${amounts.rate.toFixed(2)} ₽ <i>(open.er-api.com)</i>\n`;
    }
  }

  const statusText = request.status === 'confirmed' 
    ? `✅ <b>Бот уже пополнил баланс по TXID автоматически.</b>`
    : `✅ Зайдите в <b>/admin → 💳 Платежи</b> для подтверждения`;

  const msg =
    `💳 <b>Новая заявка на пополнение!</b>\n\n` +
    `👤 <b>Пользователь:</b> ${h(user.firstName)} (@${h(user.username || 'нет')})\n` +
    `🆔 <b>ID:</b> <code>${h(user.telegramId)}</code>\n` +
    `💳 <b>Способ:</b> ${h(methodLabels[method] || method)}\n` +
    (network ? `🌐 <b>Сеть:</b> ${h(networkLabels[network] || network)}\n` : '') +
    amountLine +
    `📅 <b>Дата:</b> ${new Date().toLocaleString('ru-RU')}\n\n` +
    statusText;

  await sendToAdmins(msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `✉️ Написать @${user.username || user.telegramId}`, url: `tg://user?id=${user.telegramId}` }],
      ],
    },
  });

  // Если есть скриншот — шлём фото отдельно
  if (request.proofFileId && botInstance) {
    const proofCaption =
      `📎 Чек от ${user.firstName} (@${user.username || user.telegramId})\n` +
      `Метод: ${methodLabels[method] || method}` +
      (network ? ` · ${networkLabels[network] || network}` : '') +
      (amounts ? `\n💵 ${amounts.amountUSDT.toFixed(2)} USDT (~${amounts.amountRUB.toFixed(0)} ₽)` : '');

    for (const adminId of ADMIN_IDS) {
      try {
        await botInstance.telegram.sendPhoto(adminId, request.proofFileId, {
          caption: proofCaption,
        });
      } catch (err) {
        logger.warn(`Не удалось отправить фото чека админу ${adminId}: ${err.message}`);
      }
    }
  }
};

// Заказ выполнен — уведомление пользователю
const notifyUserOrderCompleted = async (user, order, product, result) => {
  const productId = product?._id || order.productId;
  const msg =
    `🎉 <b>Ваш заказ выполнен!</b>\n\n` +
    `📦 Товар: ${product?.icon || '📦'} ${h(product?.name, 'Товар')}\n` +
    `📋 Заказ: <code>${order._id}</code>\n\n` +
    `✅ ${h(result || 'Активация выполнена успешно!')}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Купить ещё', `shop:product:${productId}`)],
    [Markup.button.callback('⬅️ В главное меню', 'menu:main')],
  ]);

  await sendToUser(user.telegramId, msg, keyboard);
};

// Заказ отменён — уведомление пользователю
const notifyUserOrderCancelled = async (user, order, product, reason) => {
  const msg =
    `❌ <b>Заказ отменён</b>\n\n` +
    `📦 Товар: ${product?.icon || '📦'} ${h(product?.name, 'Товар')}\n` +
    `📋 Заказ: <code>${order._id}</code>\n` +
    `💬 Причина: ${h(reason || 'не указана')}\n\n` +
    `💰 Средства возвращены: +${order.price} USDT`;

  await sendToUser(user.telegramId, msg);
};

// Баланс пополнен — уведомление пользователю
const notifyUserTopupConfirmed = async (user, amount) => {
  const fmt = parseFloat(amount).toFixed(2);
  const msg =
    `✅ <b>Баланс пополнен!</b>\n\n` +
    `💰 Зачислено: <b>+${fmt} USDT</b> (~${toRub(amount)} ₽)\n` +
    `💳 Текущий баланс: <b>${user.balance.toFixed(2)} USDT</b>`;

  await sendToUser(user.telegramId, msg);
};

// Заявка на пополнение отклонена
const notifyUserTopupRejected = async (user, amount, reason) => {
  const fmt = amount > 0 ? `${parseFloat(amount).toFixed(2)} USDT` : 'не указана';
  const msg =
    `❌ <b>Заявка на пополнение отклонена</b>\n\n` +
    `💰 Сумма: ${fmt}\n` +
    `💬 Причина: ${h(reason || 'не указана')}\n\n` +
    `Если вопросы — обращайтесь в поддержку.`;

  await sendToUser(user.telegramId, msg);
};

// Предупреждение об окончании ключей
const notifyAdminLowStock = async (product, remaining) => {
  const providerLabel = getProviderLabel(resolveProductProvider(product));
  const digestLine = `${product?.name || 'Товар'} — осталось ${remaining} шт.`;
  if (digest.queue('LOW_STOCK', digestLine)) return;

  const msg =
    `⚠️ <b>Заканчиваются ключи!</b>\n\n` +
    `📦 Товар: ${product?.icon || '📦'} ${h(product?.name, 'Товар')}\n` +
    `🧩 Поставщик: ${h(providerLabel)}\n` +
    `🔑 Осталось: ${remaining} шт.\n\n` +
    `Добавьте ключи в /admin → 🔑 Ключи`;

  await sendToAdmins(msg);
};

// ─── Сегментация пользователей (№16) ─────────────────────────────────────────
/**
 * Строит MongoDB-фильтр для выбранного сегмента пользователей.
 * Возвращает объект query + описание для админского UI.
 */
const buildSegmentQuery = async (segment) => {
  const base = { isBanned: false };

  if (segment === 'all' || !segment) {
    return { query: base, label: 'Все активные' };
  }

  if (segment === 'vip') {
    return { query: { ...base, totalSpent: { $gte: 50 } }, label: 'VIP (потратили 50+ USDT)' };
  }

  if (segment === 'new') {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return {
      query: { ...base, createdAt: { $gte: sevenDaysAgo } },
      label: 'Новички (зарегистрированы < 7 дней)',
    };
  }

  if (segment === 'no_purchases') {
    return {
      query: { ...base, totalSpent: 0 },
      label: 'Ещё не покупали (totalSpent = 0)',
    };
  }

  if (segment === 'active' || segment === 'inactive') {
    // Нужен список userId с completed-заказами за последние 30 дней.
    const Order = require('../models/Order');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeUserIds = await Order.distinct('userId', {
      status: 'completed',
      confirmedAt: { $gte: thirtyDaysAgo },
    });

    if (segment === 'active') {
      return {
        query: { ...base, _id: { $in: activeUserIds } },
        label: 'Активные (покупали за 30 дней)',
      };
    }
    // inactive: были покупки когда-то, но не за 30 дней
    return {
      query: { ...base, totalSpent: { $gt: 0 }, _id: { $nin: activeUserIds } },
      label: 'Уснувшие (покупали, но не за 30 дней)',
    };
  }

  return { query: base, label: 'Все активные' };
};

/**
 * Возвращает количество пользователей в сегменте (для preview перед отправкой).
 */
const countSegment = async (segment) => {
  const { query } = await buildSegmentQuery(segment);
  return User.countDocuments(query);
};

const SEGMENTS = [
  { key: 'all',          icon: '👥' },
  { key: 'vip',          icon: '💎' },
  { key: 'active',       icon: '🔥' },
  { key: 'inactive',     icon: '😴' },
  { key: 'new',          icon: '🌱' },
  { key: 'no_purchases', icon: '🆕' },
];

// ─── Рассылка нового товара пользователям (опционально — сегменту) ───────────
const broadcastNewProduct = async (product, stock, segment = 'all') => {
  if (!botInstance) return { sent: 0, failed: 0 };

  const stockLine = stock === '∞' || stock === null
    ? `♾️ Без ограничений`
    : stock > 0
      ? `🗄 В наличии: <b>${stock} шт.</b>`
      : `🔜 <b>Скоро в наличии</b>`;

  const text =
    `🆕 <b>Новый товар в магазине!</b>\n\n` +
    `${h(product.icon || '📦')} <b>${h(product.name)}</b>\n\n` +
    `${product.description ? `📝 ${h(product.description)}\n\n` : ''}` +
    `💰 Цена: <b>${product.price} USDT</b> (~${toRub(product.price)} ₽)\n` +
    `${stockLine}\n\n` +
    `👇 Нажмите чтобы купить:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `${product.icon} Купить — ${product.price} USDT`, callback_data: `menu:shop` }],
    ],
  };

  const { query } = await buildSegmentQuery(segment);

  let sent = 0;
  let failed = 0;

  // Пагинация по 100 пользователей — не грузим всех в память
  let skip = 0;
  const batchSize = 100;
  let batch;
  do {
    batch = await User.find(query)
      .select('telegramId')
      .lean()
      .skip(skip)
      .limit(batchSize);

    for (const user of batch) {
      try {
        await botInstance.telegram.sendMessage(user.telegramId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        sent++;
      } catch (_) {
        failed++;
      }
      // Пауза 50мс между отправками — не превышаем лимит Telegram (30 msg/sec)
      await new Promise(r => setTimeout(r, 50));
    }
    skip += batchSize;
  } while (batch.length === batchSize);

  return { sent, failed };
};

// ─── Уведомление продавцу о новом заказе ─────────────────────────────────────
const notifySellerNewOrder = async (seller, order, product, buyer) => {
  if (!botInstance || !seller?.telegramId) return;

  const sellerUser = await User.findOne({ telegramId: seller.telegramId });
  const sellerLang = sellerUser?.language || 'ru';

  const buyerTag = buyer?.username ? `@${h(buyer.username)}` : `ID ${h(buyer?.telegramId)}`;

  const msg = i18n.translate(sellerLang, 'seller_new_order_title', {
    icon: h(product?.icon || '📦'),
    productName: h(product?.name, 'Товар'),
    orderId: order._id,
    buyerTag,
    payout: order.sellerPayout.toFixed(2)
  });

  const keyboard = {
    inline_keyboard: [
      [{ text: i18n.translate(sellerLang, 'seller_new_order_btn_complete'), callback_data: `seller:order:complete:${order._id}` }],
    ],
  };

  try {
    await botInstance.telegram.sendMessage(seller.telegramId, msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err) {
    logger.warn(`❌ Не удалось уведомить продавца ${seller.telegramId}: ${err.message}`);
  }
};

// ─── Уведомление продавцу о результате заявки на вывод ───────────────────────
const notifySellerWithdrawalResult = async (seller, withdrawal, result) => {
  if (!botInstance || !seller?.telegramId) return;

  const NETWORK_LABELS = { trc20: 'TRC-20 (Tron)', bep20: 'BEP-20 (BSC)' };
  const networkLabel = NETWORK_LABELS[withdrawal.network] || withdrawal.network;

  let msg;
  if (result === 'confirmed') {
    msg =
      `✅ <b>Выплата подтверждена!</b>\n\n` +
      `💰 Сумма: <b>${withdrawal.amount.toFixed(2)} USDT</b>\n` +
      `🌐 Сеть: ${networkLabel}\n` +
      `💳 Кошелёк: <code>${h(withdrawal.walletAddress)}</code>\n\n` +
      `Средства отправлены на ваш кошелёк.`;
  } else {
    msg =
      `❌ <b>Заявка на вывод отклонена</b>\n\n` +
      `💰 Сумма: ${withdrawal.amount.toFixed(2)} USDT\n\n` +
      `Средства возвращены на ваш баланс. Обратитесь к администратору.`;
  }

  try {
    await botInstance.telegram.sendMessage(seller.telegramId, msg, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn(`❌ Не удалось уведомить продавца ${seller.telegramId}: ${err.message}`);
  }
};

// ─── Уведомление всех администраторов о заявке продавца на вывод ─────────────
const notifyAdminSellerWithdrawal = async (seller, withdrawal) => {
  if (!botInstance) return;

  const NETWORK_LABELS = { trc20: '🔴 TRC-20 (Tron)', bep20: '🟡 BEP-20 (BSC)' };
  const networkLabel = NETWORK_LABELS[withdrawal.network] || withdrawal.network;

  const msg =
    `💸 <b>Запрос на вывод от продавца!</b>\n\n` +
    `👤 Продавец: @${h(seller?.username || '?')}\n` +
    `💰 Сумма: <b>${withdrawal.amount.toFixed(2)} USDT</b>\n` +
    `🌐 Сеть: ${networkLabel}\n` +
    `💳 Кошелёк:\n<code>${h(withdrawal.walletAddress)}</code>\n` +
    `📅 Дата: ${new Date().toLocaleString('ru-RU')}\n\n` +
    `✅ Зайдите в <b>/admin → 💸 Продавцы</b> для подтверждения`;

  await sendToAdmins(msg);
};

module.exports = {
  setBot,
  sendToAdmins,
  sendToUser,
  notifyAdminNewOrder,
  notifyAdminTokenReceived,
  notifyAdminTopupRequest,
  notifyUserOrderCompleted,
  notifyUserOrderCancelled,
  notifyUserTopupConfirmed,
  notifyUserTopupRejected,
  notifyAdminLowStock,
  broadcastNewProduct,
  // Seller-система
  notifySellerNewOrder,
  notifySellerWithdrawalResult,
  notifyAdminSellerWithdrawal,
  notifySellerWelcome,
  // №16 Сегментация
  buildSegmentQuery,
  countSegment,
  SEGMENTS,
};

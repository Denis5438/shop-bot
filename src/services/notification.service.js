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
    const sellerUser = await User.findOne({ telegramId: seller.telegramId }).select('language').lean();
    const lang = sellerUser?.language || 'ru';
    await botInstance.telegram.sendMessage(
      seller.telegramId,
      i18n.translate(lang, 'seller_welcome'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: i18n.translate(lang, 'seller_welcome_btn'), callback_data: 'seller:cabinet' }]],
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

// Дедуп алертов об ошибках: при массовом сбое (например, недоступна БД) каждый
// упавший апдейт слал бы отдельное сообщение каждому админу - это и спам, и
// самоусиление (упираемся в лимит Telegram → новые ошибки). Схлопываем
// одинаковые сообщения в окне и добавляем счётчик повторов.
const _alertWindowMs = 5 * 60 * 1000;
const _alertSeen = new Map(); // ключ сообщения → { count, firstAt, timer }

const sendAdminAlertThrottled = (message, extra = {}) => {
  const key = String(message).slice(0, 200);
  const now = Date.now();
  const existing = _alertSeen.get(key);

  if (existing && now - existing.firstAt < _alertWindowMs) {
    existing.count += 1; // повтор в окне - просто считаем, не шлём
    return;
  }

  // Первое появление (или окно истекло): шлём сразу
  _alertSeen.set(key, { count: 1, firstAt: now });
  sendToAdmins(message, extra).catch(() => {});

  // По истечении окна: если были повторы - шлём сводку и очищаем
  const timer = setTimeout(() => {
    const entry = _alertSeen.get(key);
    _alertSeen.delete(key);
    if (entry && entry.count > 1) {
      sendToAdmins(`🔁 Повтор предыдущей ошибки ×${entry.count} за последние 5 мин:\n${message}`.slice(0, 3500), extra).catch(() => {});
    }
  }, _alertWindowMs);
  if (typeof timer.unref === 'function') timer.unref();
};

// Новый заказ - мгновенное уведомление администраторам
const notifyAdminNewOrder = async (order, user, product) => {
  const providerLabel = getProviderLabel(resolveOrderProvider(order, product));
  const qtyLine = order.qty > 1 ? `📊 Количество: <b>${order.qty} шт.</b>\n` : '';

  const cost = (order.costPrice || product?.costPrice || 0) * (order.qty || 1);
  const profit = Math.max(0, parseFloat((order.price - cost).toFixed(2)));
  const profitStr = profit > 0 ? `\n💵 <b>Ваша чистая прибыль: +${profit.toFixed(2)} USDT</b> 🚀` : '';

  let deliveryStr = '';
  if (order.status === 'pending' && order.notes) {
    deliveryStr = `\n\n❌ <b>Ошибка при выдаче:</b>\n<i>${escapeHtml(String(order.notes))}</i>\n⚠️ Заказ ждёт вашей ручной выдачи!`;
  } else if (order.deliveryData) {
    deliveryStr = `\n\n🔑 <b>Выдано клиенту:</b>\n<code>${escapeHtml(String(order.deliveryData))}</code>\n`;
  }

  const mskTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

  const msg =
    `🛒 <b>Новая покупка в магазине!</b>\n\n` +
    `📋 Заказ: <code>#${order._id}</code>\n` +
    `👤 Покупатель: <b>${h(user.firstName)}</b> (@${h(user.username || 'нет')}) | <code>${h(user.telegramId)}</code>\n` +
    `📦 Товар: ${product?.icon || '📦'} <b>${h(product?.name, 'Товар')}</b>\n` +
    qtyLine +
    `🧩 Источник: <b>${h(providerLabel)}</b>\n` +
    `💰 Оплачено клиентом: <b>${order.price} USDT</b> (~${toRub(order.price)} ₽)\n` +
    `💸 Себестоимость: ${cost.toFixed(2)} USDT` +
    profitStr +
    deliveryStr +
    `\n📅 Дата (МСК): ${mskTime}`;

  const adminButtons = [];
  if (user?.username) {
    adminButtons.push([{ text: `✉️ Написать @${user.username}`, url: `https://t.me/${user.username}` }]);
  }

  await sendToAdmins(msg, adminButtons.length ? { reply_markup: { inline_keyboard: adminButtons } } : {});
};

// Токен получен - уведомление администраторам
const notifyAdminTokenReceived = async (order, user, product) => {
  const digestLine = `@${user.username || user.telegramId} - ${product?.name || 'Товар'} (заказ ${String(order._id).slice(-6)})`;
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

// Запрос на пополнение - уведомление администраторам
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
  // (status=confirmed) уходят сразу - это деньги уже на балансе, админу важно
  // увидеть их в реальном времени.
  if (request?.status === 'pending') {
    const amountStr = amounts
      ? `${amounts.amountUSDT.toFixed(2)} USDT (~${amounts.amountRUB.toFixed(0)} ₽)`
      : (request.amount ? `${request.amount.toFixed(2)} USDT` : '? USDT');
    const digestLine = `@${user.username || user.telegramId} - ${amountStr} · ${methodLabels[method] || method}` +
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

  const adminTopupButtons = [];
  if (user?.username) {
    adminTopupButtons.push([{ text: `✉️ Написать @${user.username}`, url: `https://t.me/${user.username}` }]);
  }

  await sendToAdmins(msg, adminTopupButtons.length ? { reply_markup: { inline_keyboard: adminTopupButtons } } : {});

  // Если есть скриншот - шлём фото отдельно
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

// Заказ выполнен - уведомление пользователю
const notifyUserOrderCompleted = async (user, order, product, result) => {
  const productId = product?._id || order.productId;
  const lang = user?.language || 'ru';
  const msg = i18n.translate(lang, 'order_completed', {
    name: h(product?.name, 'Товар'),
    orderId: order._id,
    result: h(result || 'Активация выполнена успешно!')
  });

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(i18n.translate(lang, 'btn_buy') + ' 🔄', `shop:product:${productId}`)],
    [Markup.button.callback(i18n.translate(lang, 'btn_back'), 'menu:main')],
  ]);

  await sendToUser(user.telegramId, msg, keyboard);
};

// Заказ отменён - уведомление пользователю
const notifyUserOrderCancelled = async (user, order, product, reason) => {
  const lang = user?.language || 'ru';
  const msg = i18n.translate(lang, 'order_cancelled', {
    name: h(product?.name, 'Товар'),
    orderId: order._id,
    reason: h(reason || 'не указана'),
    price: order.price
  });

  await sendToUser(user.telegramId, msg);
};

// Баланс пополнен - уведомление пользователю
const notifyUserTopupConfirmed = async (user, amount) => {
  const fmt = parseFloat(amount).toFixed(2);
  const lang = user?.language || 'ru';
  const msg = i18n.translate(lang, 'topup_confirmed', {
    amount: fmt,
    amountRub: toRub(amount),
    balance: user.balance.toFixed(2)
  });

  await sendToUser(user.telegramId, msg);
};

// Заявка на пополнение отклонена
const notifyUserTopupRejected = async (user, amount, reason) => {
  const lang = user?.language || 'ru';
  const msg = i18n.translate(lang, 'topup_rejected', {
    reason: h(reason || 'не указана')
  });

  await sendToUser(user.telegramId, msg);
};

// Предупреждение об окончании ключей
const notifyAdminLowStock = async (product, remaining) => {
  const providerLabel = getProviderLabel(resolveProductProvider(product));
  const digestLine = `${product?.name || 'Товар'} - осталось ${remaining} шт.`;
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

// ─── Рассылка нового товара пользователям (опционально - сегменту) ───────────
const broadcastNewProduct = async (product, stock, segment = 'all') => {
  if (!botInstance) return { sent: 0, failed: 0 };

  const { query } = await buildSegmentQuery(segment);

  let sent = 0;
  let failed = 0;
  const cursor = User.find(query)
    .select('telegramId language')
    .lean()
    .cursor();

  for await (const user of cursor) {
      const lang = user.language || 'ru';
      const stockLine = stock === '∞' || stock === null
        ? i18n.translate(lang, 'broadcast_stock_unlimited')
        : stock > 0
          ? i18n.translate(lang, 'broadcast_stock_count', { count: stock })
          : i18n.translate(lang, 'broadcast_stock_soon');

      const text = i18n.translate(lang, 'broadcast_new_product', {
        icon: h(product.icon || '📦'),
        name: h(product.name),
        description: product.description ? `📝 ${h(product.description)}` : '',
        price: product.price,
        priceRub: toRub(product.price),
        stockLine
      });

      const keyboard = {
        inline_keyboard: [
          [{ text: i18n.translate(lang, 'broadcast_btn_buy', { icon: product.icon || '📦', price: product.price }), callback_data: `menu:shop` }],
        ],
      };

      try {
        await botInstance.telegram.sendMessage(user.telegramId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        sent++;
      } catch (_) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 50));
    }

  return { sent, failed };
};

// ─── Уведомление продавцу о новом заказе ─────────────────────────────────────
const notifySellerNewOrder = async (seller, order, product, buyer) => {
  if (!botInstance || !seller?.telegramId) return;

  const sellerUser = await User.findOne({ telegramId: seller.telegramId }).select('language').lean();
  const sellerLang = sellerUser?.language || 'ru';

  const buyerTag = buyer?.username ? `@${h(buyer.username)}` : `ID ${h(buyer?.telegramId)}`;

  const productName = order.qty > 1 ? `${h(product?.name, 'Товар')} (x${order.qty})` : h(product?.name, 'Товар');

  let msg = i18n.translate(sellerLang, 'seller_new_order_title', {
    icon: h(product?.icon || '📦'),
    productName: productName,
    orderId: order._id,
    buyerTag,
    payout: order.sellerPayout.toFixed(2)
  });

  const keyboard = {};
  if (order.status !== 'completed') {
    keyboard.reply_markup = {
      inline_keyboard: [
        [{ text: i18n.translate(sellerLang, 'seller_new_order_btn_complete'), callback_data: `seller:order:complete:${order._id}` }],
      ],
    };
  } else {
    msg += `\n\n<i>${sellerLang === 'en' ? '✅ Product issued automatically.' : '✅ Товар выдан автоматически.'}</i>`;
  }

  try {
    await botInstance.telegram.sendMessage(seller.telegramId, msg, {
      parse_mode: 'HTML',
      ...keyboard,
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
  
  const sellerUser = await User.findOne({ telegramId: seller.telegramId }).select('language').lean();
  const lang = sellerUser?.language || 'ru';

  let msg;
  if (result === 'confirmed') {
    msg = i18n.translate(lang, 'seller_withdrawal_confirmed', {
      amount: withdrawal.amount.toFixed(2),
      network: networkLabel,
      wallet: h(withdrawal.walletAddress)
    });
  } else {
    msg = i18n.translate(lang, 'seller_withdrawal_rejected', {
      amount: withdrawal.amount.toFixed(2)
    });
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

const notifyWaitlist = async (product) => {
  const Waitlist = require('../models/Waitlist');
  if (!botInstance) return;

  // .lean() + проекция: нужен только telegramId подписчиков
  const usersWaiting = await Waitlist.find({ productId: product._id })
    .populate('userId', 'telegramId')
    .lean();
  if (!usersWaiting.length) return;

  for (const wait of usersWaiting) {
    if (wait.userId && wait.userId.telegramId) {
      try {
        await botInstance.telegram.sendMessage(
          wait.userId.telegramId,
          `🎉 <b>Отличные новости!</b>\n\nТовар ${product.icon || '📦'} <b>${product.name}</b> снова в наличии!\n\nУспейте приобрести, пока не разобрали!`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🛒 Перейти к товару', callback_data: `shop:product:${product._id}` }]],
            },
          }
        );
      } catch (e) {}
      // Троттлинг ~40 мс между сообщениями (как в других рассылках) - иначе
      // на популярном товаре упираемся в лимит Telegram 30 msg/sec
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // Автовыдача предзаказов
  await fulfillPreorders(product);

  // Remove them from waitlist since they've been notified
  await Waitlist.deleteMany({ productId: product._id });
};

const fulfillPreorders = async (product) => {
  if (!botInstance || !product) return;

  const Order = require('../models/Order');
  const Key = require('../models/Key');
  const { buildKeyQueryForProduct } = require('./provider.service');
  const { formatDigitalItem, escapeHtml } = require('../bot/utils/ui');

  const pendingPreorders = await Order.find({
    productId: product._id,
    status: 'preorder_pending',
  }).sort({ createdAt: 1 }).populate('userId');

  if (!pendingPreorders.length) return;

  for (const preorder of pendingPreorders) {
    if (!preorder.userId || !preorder.userId.telegramId) continue;

    if (product.type === 'manual') {
      const orderQty = preorder.qty || 1;
      if (product.manualStock !== -1) {
        const Product = require('../models/Product');
        const stockRes = await Product.updateOne(
          { _id: product._id, manualStock: { $gte: orderQty } },
          { $inc: { manualStock: -orderQty } }
        );
        if (!stockRes.modifiedCount) break;
      }

      const claimedPreorder = await Order.findOneAndUpdate(
        { _id: preorder._id, status: 'preorder_pending' },
        { $set: { status: 'pending' } },
        { new: true }
      );
      if (!claimedPreorder) continue;

      const Waitlist = require('../models/Waitlist');
      await Waitlist.findOneAndDelete({ userId: preorder.userId._id, productId: product._id }).catch(() => {});

      try {
        const userLang = preorder.userId.language || 'ru';
        const msgText = userLang === 'en'
          ? `🎉 <b>Your Pre-order #${preorder._id} is now being processed!</b>\n\n` +
            `📦 <b>Product:</b> ${escapeHtml(product.nameEn || product.name)}\n\n` +
            `<i>Operator will deliver the goods shortly!</i>`
          : `🎉 <b>Ваш предзаказ #${preorder._id} передан на выдачу!</b>\n\n` +
            `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n\n` +
            `<i>Оператор скоро передаст вам данные.</i>`;

        await botInstance.telegram.sendMessage(preorder.userId.telegramId, msgText, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '📋 Мои заказы', callback_data: `profile:order:detail:${preorder._id}` }]],
          },
        });
      } catch (e) {
        logger.warn(`❌ Не удалось отправить уведомление о ручном предзаказе: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }

    // Атомарный захват свободного ключа (isUsed:false в фильтре) - как при
    // обычной покупке. И ВАЖНО: поле называется usedByOrder, а не orderId -
    // раньше присвоение key.orderId молча отбрасывалось Mongoose (strict mode),
    // ключ оставался без привязки к заказу и мог быть продан повторно при откатах.
    const key = await Key.findOneAndUpdate(
      buildKeyQueryForProduct(product, { isUsed: false }),
      { $set: { isUsed: true, usedAt: new Date(), usedByOrder: preorder._id } },
      { new: true }
    );

    if (!key) {
      break;
    }

    // Атомарный захват предзаказа: если он параллельно отменён пользователем
    // (деньги возвращены) - НЕ выдаём товар, освобождаем ключ обратно.
    const claimedPreorder = await Order.findOneAndUpdate(
      { _id: preorder._id, status: 'preorder_pending' },
      { $set: { status: 'completed', keyId: key._id, deliveryData: key.value, confirmedAt: new Date() } },
      { new: true }
    );
    if (!claimedPreorder) {
      await Key.updateOne(
        { _id: key._id },
        { $set: { isUsed: false, usedAt: null, usedByOrder: null } }
      ).catch(() => {});
      continue;
    }

    const Waitlist = require('../models/Waitlist');
    await Waitlist.findOneAndDelete({ userId: preorder.userId._id, productId: product._id }).catch(() => {});

    try {
      const userLang = preorder.userId.language || 'ru';
      const formattedItem = formatDigitalItem(key.value, userLang);
      const msgText = userLang === 'en'
        ? `🎉 <b>Your Pre-order #${preorder._id} has been fulfilled!</b>\n\n` +
          `📦 <b>Product:</b> ${escapeHtml(product.nameEn || product.name)}\n\n` +
          `🔑 <b>Your access data:</b>\n${formattedItem}\n\n` +
          `<i>Thank you for your order!</i>`
        : `🎉 <b>Ваш предзаказ #${preorder._id} выполнен!</b>\n\n` +
          `📦 <b>Товар:</b> ${escapeHtml(product.name)}\n\n` +
          `🔑 <b>Ваши данные для доступа:</b>\n${formattedItem}\n\n` +
          `<i>Спасибо за заказ!</i>`;

      await botInstance.telegram.sendMessage(preorder.userId.telegramId, msgText, {
        parse_mode: 'HTML',
        reply_markup: {
          // Роут ожидает profile:order:detail:<id> - без ":detail" кнопка мёртвая
          inline_keyboard: [[{ text: '📋 Мои заказы', callback_data: `profile:order:detail:${preorder._id}` }]],
        },
      });
    } catch (e) {
      logger.warn(`❌ Не удалось отправить предзаказанный товар пользователю ${preorder.userId.telegramId}: ${e.message}`);
    }
    // Троттлинг между выдачами предзаказов (защита от лимита Telegram при
    // массовом пополнении склада)
    await new Promise((r) => setTimeout(r, 40));
  }
};

const sendMediaToAdmins = async (mediaType, mediaId, caption, extra = {}) => {
  if (!botInstance) return;
  const opts = { parse_mode: 'HTML', caption, ...extra };
  for (const adminId of ADMIN_IDS) {
    try {
      if (mediaType === 'photo') {
        await botInstance.telegram.sendPhoto(adminId, mediaId, opts);
      } else if (mediaType === 'video') {
        await botInstance.telegram.sendVideo(adminId, mediaId, opts);
      } else if (mediaType === 'document') {
        await botInstance.telegram.sendDocument(adminId, mediaId, opts);
      } else {
        await botInstance.telegram.sendMessage(adminId, caption, opts);
      }
    } catch (err) {
      logger.warn(`❌ Не удалось отправить медиа админу ${adminId}: ${err.message}`);
    }
  }
};

const notifyWarrantyClaim = async (order, user, product, reason, mediaId = null, mediaType = null) => {
  if (!botInstance) return;

  const buyerUsername = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName);
  const text =
    `🛡 <b>Заявка на замену по гарантии!</b>\n\n` +
    `📦 <b>Товар:</b> ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.name || 'Товар')}\n` +
    `👤 <b>Покупатель:</b> ${buyerUsername} (ID: <code>${user.telegramId}</code>)\n` +
    `📋 <b>Заказ:</b> <code>${order._id}</code>\n\n` +
    `💬 <b>Описание проблемы:</b>\n<i>${escapeHtml(reason)}</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Посмотреть в админке', `admin:warranty:view:${order._id}`)],
    [Markup.button.callback('✅ Одобрить (Автовыдача)', `admin:warranty:approve:${order._id}`)],
    [Markup.button.callback('❌ Отклонить', `admin:warranty:reject:${order._id}`)],
  ]);

  if (mediaId && mediaType) {
    await sendMediaToAdmins(mediaType, mediaId, text, keyboard);
  } else {
    await sendToAdmins(text, keyboard);
  }

  if (product?.sellerId) {
    const Seller = require('../models/Seller');
    const seller = await Seller.findById(product.sellerId);
    if (seller && seller.telegramId) {
      const opts = { parse_mode: 'HTML', caption: text, ...keyboard };
      try {
        if (mediaType === 'photo') {
          await botInstance.telegram.sendPhoto(seller.telegramId, mediaId, opts);
        } else if (mediaType === 'video') {
          await botInstance.telegram.sendVideo(seller.telegramId, mediaId, opts);
        } else if (mediaType === 'document') {
          await botInstance.telegram.sendDocument(seller.telegramId, mediaId, opts);
        } else {
          await sendToUser(seller.telegramId, text, keyboard);
        }
      } catch (_) {}
    }
  }
};

module.exports = {
  setBot,
  sendToAdmins,
  sendAdminAlertThrottled,
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
  notifyWaitlist,
  notifyWarrantyClaim,
  fulfillPreorders,
  // №16 Сегментация
  buildSegmentQuery,
  countSegment,
  SEGMENTS,
};

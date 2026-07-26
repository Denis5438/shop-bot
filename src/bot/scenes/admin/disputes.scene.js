const { Markup } = require('telegraf');
const Order = require('../../../models/Order');
const Seller = require('../../../models/Seller');
const User = require('../../../models/User');
const notif = require('../../../services/notification.service');
const { escapeHtml } = require('../../utils/ui');

const PAGE_SIZE = 10;

const listDisputes = async (ctx, page = 1) => {
  const skip = (page - 1) * PAGE_SIZE;
  const filter = { status: 'disputed' };

  const [total, disputes] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .sort({ disputeOpenedAt: 1, createdAt: 1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .populate('userId', 'username telegramId')
      .populate('sellerId', 'username telegramId')
      .lean(),
  ]);

  if (!disputes.length) {
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]),
    };
    const txt = '⚠️ <b>Споры отсутствуют</b>\n\nВсе заказы идут гладко!';
    try {
      await ctx.editMessageText(txt, opts);
    } catch (_) {
      await ctx.reply(txt, opts);
    }
    return;
  }

  let text = `⚠️ <b>Споры (страница ${page})</b>\n\n`;
  const buttons = [];

  for (const o of disputes) {
    const buyerStr = o.userId?.username ? `@${o.userId.username}` : o.userId?.telegramId;
    const sellerStr = o.sellerId?.username ? `@${o.sellerId.username}` : (o.sellerId ? 'Без имени' : '?');
    text += `🔸 Заказ <code>${o._id}</code>\n`;
    text += `Покупатель: ${buyerStr} | Продавец: ${sellerStr}\n\n`;

    buttons.push([Markup.button.callback(`🔍 Заказ ${o._id}`, `admin:disputes:view:${o._id}`)]);
  }

  const pagination = [];
  if (page > 1) pagination.push(Markup.button.callback('⬅️ Назад', `admin:disputes:page:${page - 1}`));
  if (skip + PAGE_SIZE < total) pagination.push(Markup.button.callback('Вперёд ➡️', `admin:disputes:page:${page + 1}`));
  if (pagination.length) buttons.push(pagination);

  buttons.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

const viewDispute = async (ctx, orderId) => {
  const order = await Order.findById(orderId)
    .populate('productId')
    .populate('userId')
    .populate('sellerId');

  if (!order || order.status !== 'disputed') {
    return ctx.answerCbQuery('Спор не найден или уже закрыт', { show_alert: true });
  }

  const b = order.userId;
  const s = order.sellerId;

  const bLink = b ? (b.username ? `@${b.username}` : `<a href="tg://user?id=${b.telegramId}">Покупатель</a>`) : 'Удалён';
  const sLink = s ? (s.username ? `@${s.username}` : `<a href="tg://user?id=${s.telegramId}">Продавец</a>`) : 'Удалён';

  const productName = order.qty > 1 ? `${escapeHtml(order.productId?.name || '?')} (x${order.qty})` : escapeHtml(order.productId?.name || '?');
  const text =
    `⚠️ <b>Спор по заказу <code>${order._id}</code></b>\n\n` +
    `📦 Товар: <b>${productName}</b>\n` +
    `💰 Оплата: <b>${order.price} USDT</b> (Продавцу: <b>${order.sellerPayout} USDT</b>)\n\n` +
    `👤 Покупатель: ${bLink}\n` +
    `🏪 Продавец: ${sLink}\n\n` +
    `📄 <b>Что отправил продавец:</b>\n<code>${escapeHtml(order.deliveryData || 'Ничего/Файл')}</code>\n\n` +
    `<b>Выберите решение:</b>`;

  const buttons = [
    [Markup.button.callback('🔙 Вернуть деньги покупателю', `admin:disputes:refund:${order._id}`)],
    [Markup.button.callback('💸 Перевести деньги продавцу', `admin:disputes:pay:${order._id}`)],
    [Markup.button.callback('⬅️ К списку споров', 'admin:disputes:list')],
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

const resolveRefundBuyer = async (ctx, orderId) => {
  // Атомарный захват спора: условие status:'disputed' прямо в фильтре.
  // Раньше два клика (или два админа) проходили проверку оба → двойной возврат.
  // Захват и возврат - в одной транзакции.
  const { withTransaction } = require('../../../services/transactionHelper.service');
  const User = require('../../../models/User');
  let order = null;
  await withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'disputed' },
      {
        $set: {
          status: 'cancelled',
          disputeStatus: 'resolved',
          activationResult: 'Спор: возврат средств покупателю',
        },
      },
      { new: true, ...sessionOpt }
    ).populate('userId').populate('sellerId');
    if (!order) return;

    // Return money to buyer
    if (order.userId) {
      await User.updateOne({ _id: order.userId._id }, { $inc: { balance: order.price } }, sessionOpt);
    }
  });
  if (!order) return ctx.answerCbQuery('Спор не найден или уже обработан', { show_alert: true });

  if (order.userId) {
    // Сброс кэша middleware - возврат должен быть виден пользователю сразу
    require('../../middlewares/user').invalidateUserCache(order.userId.telegramId);
    await notif.sendToUser(order.userId.telegramId, `✅ <b>Спор решён в вашу пользу!</b>\nДеньги (${order.price} USDT) возвращены на ваш баланс.`).catch(()=>null);
  }

  // Notify seller
  if (order.sellerId) {
    await notif.sendToUser(order.sellerId.telegramId, `❌ <b>Спор закрыт не в вашу пользу.</b>\nЗаказ отменён, средства возвращены покупателю.`).catch(()=>null);
  }

  await ctx.answerCbQuery('✅ Деньги возвращены покупателю');
  await listDisputes(ctx, 1);
};

const resolvePaySeller = async (ctx, orderId) => {
  // Атомарный захват спора (см. resolveRefundBuyer): двойной клик раньше
  // приводил к двойной выплате продавцу. Захват и выплата - в одной транзакции.
  const { withTransaction } = require('../../../services/transactionHelper.service');
  const Seller = require('../../../models/Seller');
  let order = null;
  await withTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'disputed' },
      {
        $set: {
          status: 'completed',
          confirmedAt: new Date(),
          disputeStatus: 'resolved',
          activationResult: 'Спор: выплата продавцу',
        },
      },
      { new: true, ...sessionOpt }
    ).populate('userId').populate('sellerId');
    if (!order) return;

    if (order.sellerId && order.sellerPayout > 0) {
      // $inc вместо read-modify-write: параллельные начисления не теряются
      await Seller.updateOne(
        { _id: order.sellerId._id },
        { $inc: { balance: order.sellerPayout, totalEarned: order.sellerPayout } },
        sessionOpt
      );
      await Order.updateOne({ _id: order._id }, { $set: { sellerPaidAt: new Date() } }, sessionOpt);
    }
  });
  if (!order) return ctx.answerCbQuery('Спор не найден или уже обработан', { show_alert: true });

  // Заказ стал completed - проверяем реферальный бонус покупателя
  const { grantReferralBonusForFirstCompletedOrder } = require('../../../services/referral.service');
  grantReferralBonusForFirstCompletedOrder(order.userId?._id || order.userId).catch(() => {});

  const seller = order.sellerId;

  // Notify seller
  if (seller) {
    await notif.sendToUser(seller.telegramId, `✅ <b>Спор решён в вашу пользу!</b>\nВы получили <b>${order.sellerPayout} USDT</b> за заказ.`).catch(()=>null);
  }

  // Notify buyer
  if (order.userId) {
    await notif.sendToUser(order.userId.telegramId, `❌ <b>Спор закрыт не в вашу пользу.</b>\nАдминистратор признал товар валидным. Деньги переведены продавцу.`).catch(()=>null);
  }

  await ctx.answerCbQuery('✅ Деньги переведены продавцу');
  await listDisputes(ctx, 1);
};

// ─────────────────── ГАРАНТИЙНЫЕ ЗАМЕНЫ ───────────────────
const listWarrantyClaims = async (ctx, page = 1) => {
  const skip = (page - 1) * PAGE_SIZE;
  const filter = { replacementStatus: 'pending' };

  const [total, claims] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(PAGE_SIZE)
      .populate('userId', 'username telegramId')
      .populate('productId', 'name icon')
      .lean(),
  ]);

  if (!claims.length) {
    const opts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В панель', 'admin:main')]]),
    };
    const txt = '🛡 <b>Заявки на замену отсутствуют</b>\n\nВсе заказы работают без проблем!';
    try {
      await ctx.editMessageText(txt, opts);
    } catch (_) {
      await ctx.reply(txt, opts);
    }
    return;
  }

  let text = `🛡 <b>Заявки на замену по гарантии (${page}/${Math.ceil(total / PAGE_SIZE)})</b>\n\n`;
  const buttons = [];

  for (const o of claims) {
    const buyerStr = o.userId?.username ? `@${o.userId.username}` : (o.userId?.telegramId || '?');
    const pName = escapeHtml(o.productId?.name || 'Товар');
    text += `🔹 Заказ <code>${o._id}</code>\n`;
    text += `   📦 ${pName} | Покупатель: ${buyerStr}\n\n`;

    buttons.push([Markup.button.callback(`🔍 Заказ ${o._id.toString().slice(-6)}`, `admin:warranty:view:${o._id}`)]);
  }

  const pagination = [];
  if (page > 1) pagination.push(Markup.button.callback('⬅️ Назад', `admin:warranties:page:${page - 1}`));
  if (skip + PAGE_SIZE < total) pagination.push(Markup.button.callback('Вперёд ➡️', `admin:warranties:page:${page + 1}`));
  if (pagination.length) buttons.push(pagination);

  buttons.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);

  const opts = { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) };
  try {
    await ctx.editMessageText(text, opts);
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

const viewWarrantyClaim = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId').populate('productId').populate('keyId');
  if (!order) return ctx.answerCbQuery('Заявка не найдена', { show_alert: true });

  const buyerStr = order.userId?.username ? `@${order.userId.username}` : order.userId?.telegramId;
  const pName = escapeHtml(order.productId?.name || 'Товар');
  const reason = escapeHtml(order.replacementReason || 'Не указана');

  const text =
    `🛡 <b>Заявка на замену по гарантии</b>\n\n` +
    `📋 <b>Заказ:</b> <code>${order._id}</code>\n` +
    `📦 <b>Товар:</b> ${pName}\n` +
    `👤 <b>Покупатель:</b> ${buyerStr}\n` +
    `💰 <b>Сумма:</b> ${order.price} USDT\n\n` +
    `💬 <b>Описание проблемы от покупателя:</b>\n<i>${reason}</i>`;

  const buttons = [
    [Markup.button.callback('✅ Одобрить (Автовыдача)', `admin:warranty:approve:${order._id}`)],
    [Markup.button.callback('✍️ Выдать замену вручную', `admin:warranty:manual_start:${order._id}`)],
    [Markup.button.callback('❌ Отклонить замену', `admin:warranty:reject:${order._id}`)],
    [Markup.button.callback('⬅️ К списку замен', 'admin:warranties:list')],
  ];

  const opts = { parse_mode: 'HTML', caption: text, ...Markup.inlineKeyboard(buttons) };
  try {
    if (order.replacementMediaId && order.replacementMediaType) {
      if (order.replacementMediaType === 'photo') {
        await ctx.replyWithPhoto(order.replacementMediaId, opts);
      } else if (order.replacementMediaType === 'video') {
        await ctx.replyWithVideo(order.replacementMediaId, opts);
      } else if (order.replacementMediaType === 'document') {
        await ctx.replyWithDocument(order.replacementMediaId, opts);
      } else {
        await ctx.editMessageText(text, opts);
      }
    } else {
      await ctx.editMessageText(text, opts);
    }
  } catch (_) {
    await ctx.reply(text, opts);
  }
};

const approveWarrantyClaim = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('productId').populate('userId');
  if (!order || order.replacementStatus !== 'pending') {
    return ctx.answerCbQuery('❌ Заявка не найдена или уже обработана', { show_alert: true });
  }

  const Key = require('../../../models/Key');
  const { buildKeyQueryForProduct } = require('../../../services/provider.service');
  const { formatDigitalItem } = require('../../utils/ui');

  const product = order.productId;
  const availableKey = await Key.findOne(buildKeyQueryForProduct(product, { isUsed: false }));

  if (availableKey) {
    availableKey.isUsed = true;
    availableKey.usedAt = new Date();
    availableKey.usedByOrder = order._id;
    await availableKey.save();

    order.replacementStatus = 'approved';
    order.replacedKeyId = availableKey._id;
    order.replacedAt = new Date();
    await order.save();

    if (order.userId) {
      const userLang = order.userId.language || 'ru';
      const itemFormatted = formatDigitalItem(availableKey.value, userLang);
      const msgText =
        `✅ <b>Ваша заявка на замену по гарантии одобрена!</b>\n\n` +
        `📦 <b>Товар:</b> ${escapeHtml(product?.name || 'Товар')}\n\n` +
        `📦 <b>Ваш новый аккаунт / ключ:</b>\n${itemFormatted}`;

      await notif.sendToUser(order.userId.telegramId, msgText).catch(() => {});
    }

    await ctx.answerCbQuery('✅ Заявка одобрена! Новый товар выдан авто-выдачей.');
  } else {
    ctx.session.adminAction = 'manual_warranty_replace';
    ctx.session.warrantyOrderId = order._id.toString();

    await ctx.reply(
      `⚠️ <b>В базе нет свободных авто-товаров для «${escapeHtml(product?.name)}»!</b>\n\n` +
      `Отправьте новую строку с данными аккаунта (например: <code>login:pass:2fa</code> или ссылку) в ответе на это сообщение для ручной выдачи:`,
      { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
    return;
  }

  await listWarrantyClaims(ctx, 1);
};

const rejectWarrantyClaim = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId');
  if (!order || order.replacementStatus !== 'pending') {
    return ctx.answerCbQuery('❌ Заявка не найдена', { show_alert: true });
  }

  order.replacementStatus = 'rejected';
  order.replacementRejectReason = 'Не подтверждено модератором';
  await order.save();

  if (order.userId) {
    await notif.sendToUser(
      order.userId.telegramId,
      `❌ <b>Заявка на замену по гарантии отклонена.</b>\nАдминистратор/модератор проверил заявку и отклонил запрос.`
    ).catch(() => {});
  }

  await ctx.answerCbQuery('❌ Заявка отклонена');
  await listWarrantyClaims(ctx, 1);
};

const handleManualWarrantyReplaceInput = async (ctx) => {
  const session = ctx.session || {};
  if (session.adminAction !== 'manual_warranty_replace' || !session.warrantyOrderId) return false;

  const orderId = session.warrantyOrderId;
  const order = await Order.findById(orderId).populate('productId').populate('userId');

  if (!order) {
    session.adminAction = null;
    session.warrantyOrderId = null;
    await ctx.reply('❌ Заказ не найден.');
    return true;
  }

  const newValue = ctx.message.text.trim();
  const { formatDigitalItem } = require('../../utils/ui');

  order.replacementStatus = 'approved';
  order.deliveryData = newValue;
  order.replacedAt = new Date();
  await order.save();

  session.adminAction = null;
  session.warrantyOrderId = null;

  if (order.userId) {
    const userLang = order.userId.language || 'ru';
    const itemFormatted = formatDigitalItem(newValue, userLang);
    const msgText =
      `✅ <b>Ваша заявка на замену по гарантии одобрена!</b>\n\n` +
      `📦 <b>Товар:</b> ${escapeHtml(order.productId?.name || 'Товар')}\n\n` +
      `📦 <b>Ваш новый аккаунт / данные:</b>\n${itemFormatted}`;

    await notif.sendToUser(order.userId.telegramId, msgText).catch(() => {});
  }

  await ctx.reply(`✅ <b>Замена по заказу #${order._id} успешно отправлена покупателю!</b>`, { parse_mode: 'HTML' });
  return true;
};

module.exports = {
  listDisputes,
  viewDispute,
  resolveRefundBuyer,
  resolvePaySeller,
  listWarrantyClaims,
  viewWarrantyClaim,
  approveWarrantyClaim,
  rejectWarrantyClaim,
  handleManualWarrantyReplaceInput,
};

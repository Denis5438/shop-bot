const { Markup } = require('telegraf');
const Order = require('../../../models/Order');
const User = require('../../../models/User');
const Key = require('../../../models/Key');
const Transaction = require('../../../models/Transaction');
const activationService = require('../../../services/activation.service');
const notif = require('../../../services/notification.service');
const { toRub } = require('../../../services/currency.service');
const { grantReferralBonusForFirstCompletedOrder } = require('../../../services/referral.service');
const { withTransaction } = require('../../../services/transactionHelper.service');
const {
  buildKeyQueryForProduct,
  getProviderLabel,
  resolveOrderProvider,
} = require('../../../services/provider.service');
const { ORDER_STATUS_LABELS: STATUS_LABELS } = require('../../constants/ux');

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const notifyManualCompletion = async (user, order, product) => {
  if (product?.type === 'key' && order.keyId) {
    const key = await Key.findById(order.keyId);

    if (key?.value) {
      await notif.sendToUser(
        user.telegramId,
        `🎉 <b>Ваш заказ выполнен</b>\n\n` +
        `📦 Товар: ${escapeHtml(product.icon || '📦')} ${escapeHtml(product.name || 'Товар')}\n` +
        `📋 Заказ: <code>${order._id}</code>\n\n` +
        `🔑 <b>Ваш ключ:</b>\n<pre>${escapeHtml(key.value)}</pre>`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Купить ещё', `shop:product:${product._id || order.productId}`)],
          [Markup.button.callback('⬅️ В главное меню', 'menu:main')],
        ])
      );
      return;
    }
  }

  await notif.notifyUserOrderCompleted(user, order, product, 'Выполнено вручную оператором');
};

const showOrdersList = async (ctx, filter = 'active', page = 1) => {
  let query = {};
  let title = '';

  if (filter === 'active') {
    query = { status: { $in: ['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'] } };
    title = '📋 Активные заказы';
  } else if (filter === 'completed') {
    query = { status: 'completed' };
    title = '✅ Выполненные заказы';
  } else if (filter === 'cancelled') {
    query = { status: { $in: ['cancelled', 'failed'] } };
    title = '❌ Отменённые и ошибочные';
  } else {
    title = '📋 Все заказы';
  }

  const perPage = 10;
  const total = await Order.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);

  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * perPage)
    .limit(perPage)
    .populate('userId')
    .populate('productId');

  if (!orders.length) {
    return ctx.editMessageText(`${title}\n\n📭 Заказов нет`, {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🟡 Активные', 'admin:orders:active'),
          Markup.button.callback('✅ Выполненные', 'admin:orders:completed'),
        ],
        [
          Markup.button.callback('❌ Отменённые', 'admin:orders:cancelled'),
          Markup.button.callback('📋 Все', 'admin:orders:all'),
        ],
        [Markup.button.callback('⬅️ Назад', 'admin:main')],
      ]),
    });
  }

  let text = `${title} (${total})\nСтр. ${safePage} из ${totalPages}\n\n`;
  const buttons = [];

  for (const order of orders) {
    const user = order.userId;
    const product = order.productId;
    const date = new Date(order.createdAt).toLocaleDateString('ru-RU');
    text += `${STATUS_LABELS[order.status]} | ${escapeHtml(product?.name || '?')}\n`;
    text += `👤 @${escapeHtml(user?.username || user?.telegramId || '?')} | ${order.price} USDT | ${date}\n`;
    buttons.push([
      Markup.button.callback(`📋 ${product?.name?.substring(0, 20) || '?'} — ${STATUS_LABELS[order.status]}`, `admin:order:${order._id}`),
    ]);
  }

  if (totalPages > 1) {
    const navButtons = [];
    if (safePage > 1) navButtons.push(Markup.button.callback('⬅️ Пред.', `admin:orders:${filter}:${safePage - 1}`));
    navButtons.push(Markup.button.callback(`${safePage}/${totalPages}`, 'admin:noop'));
    if (safePage < totalPages) navButtons.push(Markup.button.callback('След. ➡️', `admin:orders:${filter}:${safePage + 1}`));
    buttons.push(navButtons);
  }

  buttons.push([
    Markup.button.callback('🟡 Активные', 'admin:orders:active:1'),
    Markup.button.callback('✅ Выполненные', 'admin:orders:completed:1'),
  ]);
  buttons.push([
    Markup.button.callback('❌ Отменённые', 'admin:orders:cancelled:1'),
    Markup.button.callback('📋 Все', 'admin:orders:all:1'),
  ]);
  buttons.push([Markup.button.callback('⬅️ Назад', 'admin:main')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (_) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
};

const showOrderDetail = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  const user = order.userId;
  const product = order.productId;
  const providerLabel = getProviderLabel(resolveOrderProvider(order, product));

  let text =
    `📋 <b>Заказ ${orderId}</b>\n\n` +
    `👤 Покупатель: ${escapeHtml(user?.firstName || 'нет')} (@${escapeHtml(user?.username || 'нет')}) | <code>${escapeHtml(user?.telegramId || '')}</code>\n` +
    `📦 Товар: ${escapeHtml(product?.icon || '📦')} ${escapeHtml(product?.name || 'Товар')}\n` +
    `🧩 Поставщик: ${escapeHtml(providerLabel)}\n` +
    `💰 Сумма: ${order.price} USDT (~${toRub(order.price)} ₽)\n` +
    `💸 Закупка: ${order.costPrice || 0} USDT\n` +
    `📊 Прибыль: ${(order.price - (order.costPrice || 0)).toFixed(2)} USDT\n` +
    `🔘 Статус: ${STATUS_LABELS[order.status]}\n` +
    `📅 Дата: ${new Date(order.createdAt).toLocaleString('ru-RU')}\n`;

  if (order.tokenRaw) {
    text += `\n🔑 <b>Токен пользователя:</b>\n<code>${escapeHtml(order.tokenRaw.substring(0, 200))}${order.tokenRaw.length > 200 ? '...' : ''}</code>\n`;
  }

  if (order.notes) {
    text += `\n💬 Заметки: ${escapeHtml(order.notes)}`;
  }

  if (order.status === 'retry') {
    text += `\n🔄 <b>Повторная попытка:</b> ${order.retryCount}/3`;
    if (order.nextRetryAt) {
      text += ` (следующая: ${new Date(order.nextRetryAt).toLocaleString('ru-RU')})`;
    }
  }

  const buttons = [];

  if (order.status === 'awaiting_confirmation' && product?.type === 'gpt_activation') {
    buttons.push([Markup.button.callback('✅ Подтвердить и активировать', `admin:order:activate:${orderId}`)]);
  }

  if (['pending', 'activating', 'retry'].includes(order.status)) {
    buttons.push([Markup.button.callback('✅ Выполнить вручную', `admin:order:complete:${orderId}`)]);
  }

  if (['pending', 'awaiting_token', 'awaiting_confirmation', 'activating', 'retry'].includes(order.status)) {
    buttons.push([Markup.button.callback('❌ Отменить и вернуть', `admin:order:cancel:${orderId}`)]);
  }

  buttons.push([
    Markup.button.callback('📨 Написать покупателю', `admin:msg:user:${user?.telegramId}`),
    Markup.button.callback('🔄 Обновить', `admin:order:${orderId}`),
  ]);
  buttons.push([Markup.button.callback('⬅️ К заказам', 'admin:orders:active')]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    await ctx.answerCbQuery().catch(() => {});
  } catch (err) {
    if (err.description?.includes('message is not modified')) {
      await ctx.answerCbQuery('✅ Статус актуален').catch(() => {});
    } else {
      throw err;
    }
  }
};

const confirmAndActivate = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('productId').populate('userId');
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  const provider = resolveOrderProvider(order, order.productId);

  // Атомарно «займём» заказ: статус awaiting_confirmation -> activating.
  // Если два админа кликнут одновременно — один получит null и получит alert,
  // вместо того чтобы оба зарезервировали по ключу.
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, status: 'awaiting_confirmation' },
    {
      $set: {
        status: 'activating',
        provider,
        adminId: ctx.user._id,
        confirmedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) {
    return ctx.answerCbQuery('⚠️ Заказ уже обработан другим администратором', { show_alert: true });
  }

  const key = await Key.findOneAndUpdate(
    buildKeyQueryForProduct(order.productId, { isUsed: false }),
    { isUsed: true, usedAt: new Date(), usedByOrder: claimed._id },
    { new: true }
  );

  if (!key) {
    // Откатываем статус — иначе заказ застрянет в activating без ключа.
    await Order.updateOne(
      { _id: claimed._id, status: 'activating' },
      { $set: { status: 'awaiting_confirmation', adminId: null, confirmedAt: null } }
    );
    return ctx.answerCbQuery('❌ Нет свободных ключей', { show_alert: true });
  }

  claimed.keyId = key._id;
  await claimed.save();
  // Возвращаем «обновлённый» order для дальнейших шагов с populate-данными
  order.status = claimed.status;
  order.keyId = claimed.keyId;
  order.provider = provider;
  order.adminId = claimed.adminId;
  order.confirmedAt = claimed.confirmedAt;

  await ctx.answerCbQuery('⚙️ Запускаю активацию...');
  await ctx.editMessageText(
    `⚙️ <b>Активация запущена...</b>\n📋 Заказ: <code>${orderId}</code>\n💪 Ожидайте результат...`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  try {
    const step1 = await activationService.startActivation(provider, key.value);

    if (!step1.success) {
      order.status = 'failed';
      order.activationResult = step1.message;
      await order.save();

      key.isUsed = false;
      key.usedAt = null;
      key.usedByOrder = null;
      await key.save();

      const user = await User.findById(order.userId);
      if (user) {
        user.balance = parseFloat((user.balance + order.price).toFixed(8));
        await user.save();

        await new Transaction({
          userId: user._id,
          type: 'refund',
          amount: order.price,
          orderId: order._id,
          description: 'Автовозврат: ошибка шага 1 активации',
        }).save();

        await notif.notifyUserOrderCancelled(user, order, order.productId, `Ошибка: ${step1.message}`);
      }

      const safeErr = escapeHtml(step1.message);
      await ctx.telegram.editMessageText(
        ctx.from.id,
        ctx.callbackQuery.message.message_id,
        null,
        `❌ <b>Ошибка шага 1 активации</b>\n${safeErr}\n\n💰 Средства возвращены пользователю.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заказам', 'admin:orders:active')]]) }
      ).catch(() => {});
      return;
    }

    const step2 = await activationService.finishActivation(provider, step1.order_id, order.tokenRaw);

    if (step2.success) {
      order.status = 'completed';
      order.provider = provider;
      order.apiOrderId = step1.order_id;
      order.activationResult = `api_order_id: ${step1.order_id}`;
      await order.save();

      const user = await User.findById(order.userId);
      if (user) {
        await notif.notifyUserOrderCompleted(user, order, order.productId, 'Активация завершена успешно');
        await grantReferralBonusForFirstCompletedOrder(user._id);
      }

      await ctx.telegram.editMessageText(
        ctx.from.id,
        ctx.callbackQuery.message.message_id,
        null,
        `✅ <b>Заказ <code>${orderId}</code> выполнен</b>\n\nАктивация завершена успешно. API order: <code>${step1.order_id}</code>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заказам', 'admin:orders:active')]]) }
      ).catch(() => {});
      return;
    }

    order.status = 'failed';
    order.activationResult = step2.message;
    await order.save();

    key.isUsed = false;
    key.usedAt = null;
    key.usedByOrder = null;
    await key.save();

    const user = await User.findById(order.userId);
    if (user) {
      user.balance = parseFloat((user.balance + order.price).toFixed(8));
      await user.save();

      await new Transaction({
        userId: user._id,
        type: 'refund',
        amount: order.price,
        orderId: order._id,
        description: 'Автовозврат: ошибка шага 2 активации',
      }).save();

      await notif.notifyUserOrderCancelled(user, order, order.productId, `Ошибка: ${step2.message}`);
    }

    const safeErr = escapeHtml(step2.message);
    await ctx.telegram.editMessageText(
      ctx.from.id,
      ctx.callbackQuery.message.message_id,
      null,
      `❌ <b>Ошибка шага 2 активации</b>\n${safeErr}\n\n💰 Средства возвращены пользователю.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заказам', 'admin:orders:active')]]) }
    ).catch(() => {});
  } catch (err) {
    key.isUsed = false;
    key.usedAt = null;
    key.usedByOrder = null;
    await key.save();

    const freshOrder = await Order.findById(orderId);
    if (freshOrder && !['completed', 'cancelled'].includes(freshOrder.status)) {
      freshOrder.status = 'failed';
      freshOrder.activationResult = `Критическая ошибка: ${err.message}`;
      await freshOrder.save();

      const user = await User.findById(freshOrder.userId);
      if (user) {
        user.balance = parseFloat((user.balance + freshOrder.price).toFixed(8));
        await user.save();

        await new Transaction({
          userId: user._id,
          type: 'refund',
          amount: freshOrder.price,
          orderId: freshOrder._id,
          description: 'Автовозврат: критическая ошибка',
        }).save();

        await notif.notifyUserOrderCancelled(user, freshOrder, order.productId, 'Ошибка активации');
      }
    }

    await ctx.telegram.editMessageText(
      ctx.from.id,
      ctx.callbackQuery.message.message_id,
      null,
      `❌ <b>Критическая ошибка активации</b>\n💰 Средства возвращены пользователю.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К заказам', 'admin:orders:active')]]) }
    ).catch(() => {});
  }
};

const completeOrderManually = async (ctx, orderId) => {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  if (['completed', 'cancelled', 'failed'].includes(order.status)) {
    return ctx.answerCbQuery('⚠️ Заказ уже закрыт', { show_alert: true });
  }

  order.status = 'completed';
  order.provider = resolveOrderProvider(order, order.productId);
  order.adminId = ctx.user._id;
  order.confirmedAt = new Date();
  order.activationResult = 'Выполнено вручную оператором';
  order.nextRetryAt = null;
  await order.save();

  const user = await User.findById(order.userId);
  if (user) {
    await notifyManualCompletion(user, order, order.productId);
    await grantReferralBonusForFirstCompletedOrder(user._id);
  }

  await showOrderDetail(ctx, orderId);
};

const cancelOrder = async (ctx, orderId) => {
  const preview = await Order.findById(orderId).populate('userId').populate('productId');
  if (!preview) return ctx.answerCbQuery('❌ Заказ не найден', { show_alert: true });

  if (['completed', 'cancelled', 'failed'].includes(preview.status)) {
    return ctx.answerCbQuery('⚠️ Заказ уже закрыт', { show_alert: true });
  }

  let cancelledOrder = null;
  let refundedUser = null;
  const cachedProduct = preview.productId;

  try {
    await withTransaction(async (session) => {
      const sessionOptions = session ? { session } : undefined;

      cancelledOrder = await Order.findOneAndUpdate(
        { _id: orderId, status: { $nin: ['completed', 'cancelled', 'failed'] } },
        {
          $set: {
            status: 'cancelled',
            adminId: ctx.user._id,
            nextRetryAt: null,
          },
        },
        { new: true, ...(sessionOptions || {}) }
      );

      if (!cancelledOrder) return;

      const user = await User.findById(cancelledOrder.userId, null, sessionOptions);
      if (!user) {
        throw new Error('CANCEL_USER_NOT_FOUND');
      }

      user.balance = parseFloat((user.balance + cancelledOrder.price).toFixed(8));
      await user.save(sessionOptions);
      refundedUser = user;

      await new Transaction({
        userId: user._id,
        type: 'refund',
        amount: cancelledOrder.price,
        orderId: cancelledOrder._id,
        description: 'Возврат: заказ отменён администратором',
      }).save(sessionOptions);

      if (cancelledOrder.keyId) {
        await Key.updateOne(
          { _id: cancelledOrder.keyId },
          { $set: { isUsed: false, usedByOrder: null, usedAt: null } },
          sessionOptions
        );
      }
    });
  } catch (err) {
    if (err.message === 'CANCEL_USER_NOT_FOUND') {
      return ctx.answerCbQuery('❌ Пользователь не найден (откат)', { show_alert: true });
    }
    throw err;
  }

  if (!cancelledOrder) {
    return ctx.answerCbQuery('⚠️ Заказ уже закрыт', { show_alert: true });
  }

  if (refundedUser) {
    await notif.notifyUserOrderCancelled(refundedUser, cancelledOrder, cachedProduct, 'Отменено администратором');
  }

  await showOrderDetail(ctx, orderId);
};

module.exports = {
  showOrdersList,
  showOrderDetail,
  confirmAndActivate,
  completeOrderManually,
  cancelOrder,
};

/**
 * Текстовый/медиа роутер: маршрутизация пользовательского ввода по session-state.
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const categoriesScene = require('../scenes/admin/categories.scene');
const disputesScene = require('../scenes/admin/disputes.scene');
const keysScene = require('../scenes/admin/keys.scene');
const notif = require('../../services/notification.service');
const paymentsScene = require('../scenes/admin/payments.scene');
const productsScene = require('../scenes/admin/products.scene');
const sellerScene = require('../scenes/seller.scene');
const sellerWithdrawalsScene = require('../scenes/admin/seller_withdrawals.scene');
const settingsScene = require('../scenes/admin/settings.scene');
const reqChannelsScene = require('../scenes/admin/req_channels.scene');
const topupScene = require('../scenes/topup.scene');
const usersScene = require('../scenes/admin/users.scene');
const { Markup } = require('telegraf');
const { escapeHtml } = require('../utils/ui');

module.exports = (bot) => {
  bot.on(['text', 'photo', 'video', 'document'], async (ctx, next) => {
    const session = ctx.session || {};

    // Бесплатная проверка токена (№6): пользователь прислал токен без оплаты.
    if (session.tokenCheck && session.tokenCheck.productId) {
      const { validateChatgptToken, formatCheckReport } = require('../../services/token-check.service');
      const t = ctx.t || ((k) => k);
      const productId = session.tokenCheck.productId;
      // Сбрасываем флаг СРАЗУ, чтобы повторные сообщения не триггерили проверку.
      ctx.session.tokenCheck = null;

      const result = validateChatgptToken(ctx.message.text);
      const report = formatCheckReport(result);

      const buttons = [];
      if (result.ok) {
        buttons.push([Markup.button.callback(t('token_check_place_order'), `shop:buy:${productId}`)]);
      } else {
        buttons.push([Markup.button.callback(t('token_check_try_another'), `shop:check_token:${productId}`)]);
      }
      buttons.push([Markup.button.callback(t('token_check_back_to_product'), `shop:product:${productId}`)]);

      await ctx.reply(report, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons),
      });

      // Удаляем сообщение с токеном, чтобы он не висел в истории чата.
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }
      return;
    }

    // Обработка отправки сообщения пользователю (от админа)
    if (session.adminAction === 'send_message' && ctx.user.role === 'admin') {
      const targetId = session.targetTelegramId;
      ctx.session.adminAction = null;
      ctx.session.targetTelegramId = null;
      await notif.sendToUser(targetId, `📨 Сообщение от администратора:\n\n${escapeHtml(ctx.message.text)}`);
      await ctx.reply('✅ Сообщение отправлено.');
      return;
    }

    // Подтверждение суммы пополнения (админ)
    if (session.adminAction === 'confirm_topup' && ctx.user.role === 'admin') {
      if (await paymentsScene.finalizeTopup(ctx, ctx.message.text)) return;
    }

    // Админские текстовые обработчики: защита в глубину - роль перепроверяется
    // здесь, а не только в месте установки session.adminAction. Иначе любой
    // будущий код, положивший adminAction в сессию обычного юзера, открыл бы
    // редактирование чужих балансов.
    const isAdminUser = ctx.user?.role === 'admin';

    // Редактирование настроек (admin)
    if (isAdminUser && await settingsScene.handleSettingsInput(ctx)) return;

    // Поиск (admin)
    if (isAdminUser && await usersScene.handleGlobalSearch(ctx)) return;

    // Массовая рассылка (admin)
    if (isAdminUser && await usersScene.handleCustomBroadcastInput(ctx)) return;

    // Изменение баланса (admin)
    if (isAdminUser && await usersScene.handleBalanceChange(ctx)) return;

    // Управление категориями (admin)
    if (isAdminUser && await categoriesScene.handleCategoryInput(ctx)) return;

    // Ручная замена по гарантии (admin)
    if (isAdminUser && await disputesScene.handleManualWarrantyReplaceInput(ctx)) return;

    // Прием заявления на замену по гарантии (user)
    if (session.userAction === 'warranty_claim' && session.claimOrderId) {
      const Order = require('../../models/Order');
      const Product = require('../../models/Product');
      const order = await Order.findById(session.claimOrderId);
      if (order && order.userId.toString() === ctx.user._id.toString()) {
        let mediaType = null;
        let mediaFileId = null;

        if (ctx.message.photo && ctx.message.photo.length > 0) {
          mediaType = 'photo';
          mediaFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.video) {
          mediaType = 'video';
          mediaFileId = ctx.message.video.file_id;
        } else if (ctx.message.document) {
          mediaType = 'document';
          mediaFileId = ctx.message.document.file_id;
        }

        const textReason = ctx.message.caption || ctx.message.text || (mediaType ? `[Прикреплён медиафайл: ${mediaType}]` : 'Заявка на замену');
        order.replacementStatus = 'pending';
        order.replacementReason = textReason;
        order.replacementMediaId = mediaFileId;
        order.replacementMediaType = mediaType;
        await order.save();

        const product = await Product.findById(order.productId);
        await notif.notifyWarrantyClaim(order, ctx.user, product, textReason, mediaFileId, mediaType);

        session.userAction = null;
        session.claimOrderId = null;

        await ctx.reply('✅ <b>Заявка на замену успешно отправлена!</b>\nМодераторы/продавец проверит её в ближайшее время.', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('📋 К деталям заказа', `profile:order:detail:${order._id}`)]]),
        });
        return;
      }
    }

    // Добавление товара (admin) - включает назначение продавца
    if (isAdminUser && await productsScene.handleProductInput(ctx)) return;

    // Настройки Обязательной подписки на каналы (admin)
    if (isAdminUser && await reqChannelsScene.handleReqChannelInput(ctx)) return;

    // Добавление ключей (admin)
    if (isAdminUser && await keysScene.handleKeysInput(ctx)) return;

    // Seller: привязка кошелька (адрес)
    if (await sellerScene.handleWalletAddressInput(ctx)) return;

    // Добавление продавца (admin)
    if (isAdminUser && await sellerWithdrawalsScene.handleAddSellerInput(ctx)) return;

    // Изменение баланса продавца (admin)
    if (isAdminUser && await sellerWithdrawalsScene.handleEditSellerBalanceInput(ctx)) return;

    // Seller: доставка заказа (текст)
    if (await sellerScene.handleSellerDelivery(ctx)) return;

    // Seller: ввод суммы вывода
    if (await sellerScene.handleWithdrawAmountInput(ctx)) return;

    // Сумма пополнения (пользователь вводит число)
    if (await topupScene.handleAmountInput(ctx)) return;

    // Хэш транзакции текстом (пополнение)
    if (await topupScene.handleTopupProof(ctx)) return;

    return next();
  });

  // Фото/документ: подтверждение оплаты, файлы ключей или данные от продавца
  bot.on(['photo', 'document'], async (ctx, next) => {
    // Сначала проверяем документ = txt-файл с ключами (админ)
    if (ctx.user?.role === 'admin' && ctx.message?.document && await keysScene.handleKeysInput(ctx)) return;
    // Доставка заказа продавцом (если он прислал файл или фото)
    if (await sellerScene.handleSellerDelivery(ctx)) return;
    // Потом остальное (фото-чек пополнения)
    if (await topupScene.handleTopupProof(ctx)) return;
    return next();
  });
};

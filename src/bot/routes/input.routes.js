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

    // ─── АКТИВАЦИЯ ПРОМОКОДА ПОЛЬЗОВАТЕЛЕМ ───
    if (session.userAction === 'enter_promo') {
      const promoService = require('../../services/promo.service');
      const userText = ctx.message?.text || '';
      const targetMsgId = session.promoMsgId;

      // Удаляем текстовое сообщение пользователя, чтобы не замусоривать чат
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const res = await promoService.activatePromoCode(ctx.user, userText);

      if (!res.success) {
        const text = `${res.reason}\n\n` +
          `🎟 <b>Активация промокода</b>\n` +
          `Введите корректный промокод в ответном сообщении:`;

        const cancelCallback = session.promoReturnTo === 'checkout' && session.promoCheckoutProductId
          ? `shop:buy:${session.promoCheckoutProductId}:${session.promoCheckoutPage || 1}:${session.promoCheckoutQty || 1}`
          : 'menu:profile';

        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', cancelCallback)]]);

        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
            return;
          } catch (_) {}
        }

        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        if (sent?.message_id) ctx.session.promoMsgId = sent.message_id;
        return;
      }

      ctx.session.userAction = null;
      const isFromCheckout = session.promoReturnTo === 'checkout';
      const checkoutProductId = session.promoCheckoutProductId;
      const checkoutPage = session.promoCheckoutPage || 1;
      const checkoutQty = session.promoCheckoutQty || 1;

      if (res.type === 'balance') {
        const text = `🎁 <b>Промокод <code>${res.code}</code> успешно активирован!</b>\n\n` +
          `💰 Вам зачислено: <b>+${res.bonusAmount.toFixed(2)} USDT</b> на баланс!\n` +
          `💳 Ваш текущий баланс: <b>${res.newBalance.toFixed(2)} USDT</b>`;

        const buttons = [];
        if (isFromCheckout && checkoutProductId) {
          buttons.push([Markup.button.callback('⬅️ К оформлению заказа', `shop:buy:${checkoutProductId}:${checkoutPage}:${checkoutQty}`)]);
        }
        buttons.push([Markup.button.callback('👤 В профиль', 'menu:profile')]);

        const keyboard = Markup.inlineKeyboard(buttons);

        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
            return;
          } catch (_) {}
        }

        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        if (sent?.message_id) ctx.session.promoMsgId = sent.message_id;
        return;
      } else {
        ctx.session.activePromo = res;
        const valStr = res.type === 'percent' ? `-${res.value}%` : `-${res.value} USDT`;
        const text = `🎉 <b>Промокод <code>${res.code}</code> успешно активирован!</b>\n\n` +
          `🏷 Ваша скидка: <b>${valStr}</b> при покупке товара!\n` +
          `Скидка автоматически применится при следующем заказе.`;

        const isFromCart = session.promoReturnTo === 'cart';
        session.promoReturnTo = null;

        const buttons = [];
        if (isFromCheckout && checkoutProductId) {
          buttons.push([Markup.button.callback('🛍 Продолжить покупку со скидкой', `shop:buy:${checkoutProductId}:${checkoutPage}:${checkoutQty}`)]);
        } else if (isFromCart) {
          buttons.push([Markup.button.callback('🛒 Вернуться в корзину', 'menu:cart')]);
        } else {
          buttons.push([Markup.button.callback('🛍 В магазин', 'menu:shop')]);
        }
        buttons.push([Markup.button.callback('👤 В профиль', 'menu:profile')]);

        const keyboard = Markup.inlineKeyboard(buttons);

        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
            return;
          } catch (_) {}
        }

        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        if (sent?.message_id) ctx.session.promoMsgId = sent.message_id;
        return;
      }
    }

    // ─── ВВОД ТОЧНОГО КОЛИЧЕСТВА ТОВАРА ПОЛЬЗОВАТЕЛЕМ ───
    if (session.userAction === 'enter_shop_quantity') {
      const userText = (ctx.message?.text || '').trim();
      const targetMsgId = session.qtyCustomMsgId;
      const productId = session.qtyCustomProductId;
      const page = session.qtyCustomPage || 1;
      const maxStock = session.qtyCustomMaxStock || 99999;

      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      let parsedQty = parseInt(userText, 10);
      if (isNaN(parsedQty) || parsedQty < 1) {
        const text =
          `⚠️ <b>Некорректное число!</b>\n\n` +
          `Пожалуйста, отправьте только число (например: <code>5</code> или <code>15</code>):\n` +
          `<i>(Максимум: ${maxStock} шт.)</i>`;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `shop:qty:${productId}:${page}:1`)]]);
        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
            return;
          } catch (_) {}
        }
        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
        if (sent?.message_id) ctx.session.qtyCustomMsgId = sent.message_id;
        return;
      }

      if (parsedQty > maxStock) {
        parsedQty = maxStock;
      }

      session.userAction = null;
      const shopScene = require('../scenes/shop.scene');
      await shopScene.showQuantitySelect(ctx, productId, page, parsedQty);
      return;
    }

    // ─── СОЗДАНИЕ ПРОМОКОДА АДМИНОМ ───
    if (session.userAction === 'promo_create_code' && ctx.user.role === 'admin') {
      const code = ctx.message.text.trim().toUpperCase();
      session.newPromo.code = code;
      session.userAction = null;
      const targetMsgId = session.wizardMsgId;

      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const text = `🎟 <b>Создание промокода:</b> <code>${code}</code>\n\n` +
        `Шаг 2 из 4: Выберите тип промокода:`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('💳 На баланс', 'admin:promo:type:balance'),
          Markup.button.callback('📉 Скидка в %', 'admin:promo:type:percent'),
        ],
        [
          Markup.button.callback('💰 Скидка в USDT', 'admin:promo:type:fixed'),
        ],
        [Markup.button.callback('❌ Отмена', 'admin:promos')],
      ]);

      if (targetMsgId) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
          return;
        } catch (_) {}
      }

      const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      if (sent?.message_id) session.wizardMsgId = sent.message_id;
      return;
    }

    if (session.userAction === 'promo_create_value' && ctx.user.role === 'admin') {
      const targetMsgId = session.wizardMsgId;
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const val = parseFloat(ctx.message.text.replace(',', '.'));
      if (isNaN(val) || val <= 0) {
        const errText = '❌ Введите корректное число больше 0:';
        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, errText, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:promos')]]),
            });
            return;
          } catch (_) {}
        }
        return ctx.reply(errText);
      }

      session.newPromo.value = val;
      session.userAction = 'promo_create_max';

      const text = `🎟 <b>Создание промокода</b>\n\n` +
        `Шаг 4 из 4: Напишите макс. число активаций всего (например <code>100</code> или <code>-1</code> для безлимита):`;

      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:promos')]]);

      if (targetMsgId) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
          return;
        } catch (_) {}
      }

      const sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      if (sent?.message_id) session.wizardMsgId = sent.message_id;
      return;
    }

    if (session.userAction === 'promo_create_max' && ctx.user.role === 'admin') {
      const targetMsgId = session.wizardMsgId;
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const max = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(max)) {
        const errText = '❌ Введите число (например 100 или -1):';
        if (targetMsgId) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, errText, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:promos')]]),
            });
            return;
          } catch (_) {}
        }
        return ctx.reply(errText);
      }

      const PromoCode = require('../../models/PromoCode');
      const promosScene = require('../scenes/admin/promos.scene');

      await PromoCode.create({
        ...session.newPromo,
        maxActivations: max,
        currentActivations: 0,
        maxPerUser: 1,
        isActive: true,
      });

      session.userAction = null;
      session.newPromo = null;
      session.wizardMsgId = null;

      return promosScene.showPromosMain(ctx);
    }

    // ─── МАССОВОЕ НАЧИСЛЕНИЕ БАЛАНСА ───
    if (session.adminAction === 'bulk_give_balance' && ctx.user.role === 'admin') {
      const targetMsgId = session.wizardMsgId;
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const amount = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ Введите корректную сумму больше 0 (например: 1.5):');
      }

      session.adminAction = null;
      session.wizardMsgId = null;
      const bulkService = require('../../services/bulkOperations.service');
      const count = await bulkService.grantBalanceToAll(amount);

      const text = `✅ Баланс <b>+${amount.toFixed(2)} USDT</b> успешно начислен <b>${count}</b> пользователям!`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⚡ В меню массовых операций', 'admin:bulk')]]);

      if (targetMsgId) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
          return;
        } catch (_) {}
      }

      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
      return;
    }

    // ─── ВВОД API-КЛЮЧА ПОСТАВЩИКА ───
    if (session.adminAction === 'supplier_set_key' && ctx.user.role === 'admin') {
      const targetMsgId = session.wizardMsgId;
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const supplierId = session.targetSupplierId;
      const keyStr = ctx.message.text.trim();
      session.adminAction = null;
      session.targetSupplierId = null;
      session.wizardMsgId = null;

      const supplierManager = require('../../services/supplierManager.service');
      const updated = await supplierManager.saveSupplierKey(supplierId, keyStr);

      const text = `✅ API-ключ для <b>${escapeHtml(updated.title)}</b> успешно сохранен!\nТекущий баланс: <b>${updated.cachedBalance.toFixed(2)} USDT</b>`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔌 К поставщику', `admin:supplier:view:${supplierId}`)]]);

      if (targetMsgId) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, targetMsgId, null, text, { parse_mode: 'HTML', ...keyboard });
          return;
        } catch (_) {}
      }

      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...keyboard,
      });
      return;
    }

    // ─── ВВОД НАЦЕНКИ % ПОСТАВЩИКА ───
    if (session.adminAction === 'supplier_set_margin' && ctx.user.role === 'admin') {
      const targetMsgId = session.wizardMsgId;
      if (ctx.message?.message_id) {
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }

      const supplierId = session.targetSupplierId;
      const marginVal = parseFloat(ctx.message.text.trim().replace(',', '.'));
      if (isNaN(marginVal) || marginVal < 0) {
        return ctx.reply('❌ Введите корректный процент (например: 30):');
      }

      session.adminAction = null;
      session.targetSupplierId = null;

      const SupplierConfig = require('../../models/SupplierConfig');
      const liveSync = require('../../services/supplierLiveSync.service');

      await SupplierConfig.findOneAndUpdate(
        { supplierId },
        {
          $set: {
            marginPercent: marginVal,
            smartPricingEnabled: false,
          },
        },
        { new: true, upsert: true }
      );

      const syncRes = await liveSync.syncSupplierStock(supplierId).catch(() => ({}));
      const updatedInfo = syncRes?.success ? ` (Пересчитано товаров: ${syncRes.updatedCount})` : '';

      await ctx.reply(`✅ Фиксированная наценка <b>+${marginVal}%</b> успешно установлена!${updatedInfo}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔌 К поставщику', `admin:supplier:view:${supplierId}`)]]),
      });
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

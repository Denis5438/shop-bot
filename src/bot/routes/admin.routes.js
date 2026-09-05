/**
 * Админ-маршруты (admin:*, adm:ps:p).
 * Вынесено из src/bot/index.js БЕЗ изменения логики (код перенесён дословно,
 * скорректированы только пути require).
 */

const Key = require('../../models/Key');
const adminScene = require('../scenes/admin/admin.scene');
const disputesScene = require('../scenes/admin/disputes.scene');
const keysScene = require('../scenes/admin/keys.scene');
const notif = require('../../services/notification.service');
const ordersScene = require('../scenes/admin/orders.scene');
const paymentsScene = require('../scenes/admin/payments.scene');
const productsScene = require('../scenes/admin/products.scene');
const sellerWithdrawalsScene = require('../scenes/admin/seller_withdrawals.scene');
const settingsScene = require('../scenes/admin/settings.scene');
const reqChannelsScene = require('../scenes/admin/req_channels.scene');
const promosScene = require('../scenes/admin/promos.scene');
const bulkScene = require('../scenes/admin/bulk.scene');
const suppliersScene = require('../scenes/admin/suppliers.scene');
const statsScene = require('../scenes/admin/stats.scene');
const usersScene = require('../scenes/admin/users.scene');
const { Markup } = require('telegraf');
const { adminMiddleware } = require('../middlewares/auth');
const { buildKeyQueryForProduct } = require('../../services/provider.service');
const { escapeHtml } = require('../utils/ui');

module.exports = (bot) => {
  // ─────────────────── ADMIN - ГЛАВНОЕ МЕНЮ ───────────────────
  bot.action('admin:main', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await adminScene.showAdminMain(ctx);
  });

  // ─── ADMIN: Промокоды ───
  bot.action('admin:promos', adminMiddleware, async (ctx) => {
    await promosScene.showPromosMain(ctx);
  });

  // ─── ADMIN: Внешние Поставщики (API) ───
  bot.action('admin:suppliers', adminMiddleware, async (ctx) => {
    await suppliersScene.showSuppliersMain(ctx);
  });

  bot.action(/^admin:supplier:view:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.showSupplierDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:key:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.startSetApiKey(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:margin_menu:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.showMarginMenu(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:margin_simple:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.startSetMargin(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:preset:(.+):(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.applySmartPreset(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^admin:supplier:margin:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.showMarginMenu(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:import:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.execImportCatalog(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:refresh:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.execRefreshBalance(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:sync:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.execSyncStock(ctx, ctx.match[1]);
  });

  bot.action(/^admin:supplier:toggle_current:(.+)$/, adminMiddleware, async (ctx) => {
    await suppliersScene.toggleCurrentOnly(ctx, ctx.match[1]);
  });

  bot.action('admin:promos', adminMiddleware, async (ctx) => {
    await promosScene.showPromosMain(ctx);
  });

  bot.action('admin:promo:create', adminMiddleware, async (ctx) => {
    await promosScene.startCreatePromo(ctx);
  });

  bot.action(/^admin:promo:view:(.+)$/, adminMiddleware, async (ctx) => {
    await promosScene.showPromoDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:promo:post:(.+)$/, adminMiddleware, async (ctx) => {
    await promosScene.generateChannelPost(ctx, ctx.match[1]);
  });

  bot.action(/^admin:promo:toggle:(.+)$/, adminMiddleware, async (ctx) => {
    await promosScene.togglePromoStatus(ctx, ctx.match[1]);
  });

  bot.action(/^admin:promo:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await promosScene.deletePromo(ctx, ctx.match[1]);
  });

  bot.action(/^admin:promo:quick_code:(.+)$/, adminMiddleware, async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.newPromo = ctx.session.newPromo || {};
    ctx.session.newPromo.code = ctx.match[1].toUpperCase();
    ctx.session.userAction = null;

    const text = `🎟 <b>Создание промокода:</b> <code>${ctx.session.newPromo.code}</code>\n\n` +
      `<b>Шаг 2 из 4:</b> Выберите тип промокода:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💳 На баланс (+USDT)', 'admin:promo:type:balance'),
        Markup.button.callback('📉 Скидка в % (-%)', 'admin:promo:type:percent'),
      ],
      [
        Markup.button.callback('💰 Скидка в USDT (-$)', 'admin:promo:type:fixed'),
      ],
      [Markup.button.callback('❌ Отмена', 'admin:promos')],
    ]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action(/^admin:promo:type:(balance|percent|fixed)$/, adminMiddleware, async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.newPromo = ctx.session.newPromo || {};
    ctx.session.newPromo.type = ctx.match[1];
    ctx.session.userAction = 'promo_create_value';

    const typeLabel = ctx.match[1] === 'balance' ? 'USDT на баланс' : ctx.match[1] === 'percent' ? '% скидки' : 'USDT скидки';
    const text = `🎟 <b>Создание промокода</b>\n\n` +
      `Тип: <b>${typeLabel}</b>\n\n` +
      `<b>Шаг 3 из 4:</b> Введите значение (например: <code>10</code> для ${typeLabel}):`;

    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:promos')]]) }).catch(() => {});
  });

  // ─── ADMIN: Массовые операции ───
  bot.action(['admin:bulk', 'admin:bulk:main'], adminMiddleware, async (ctx) => {
    await bulkScene.showBulkMain(ctx);
  });

  bot.action('admin:bulk:reset_bal_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showResetBalanceConfirm(ctx);
  });

  bot.action('admin:bulk:reset_bal_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execResetBalances(ctx);
  });

  bot.action('admin:bulk:give_bal_prompt', adminMiddleware, async (ctx) => {
    await bulkScene.promptGiveBalance(ctx);
  });

  bot.action('admin:bulk:warranty_menu', adminMiddleware, async (ctx) => {
    await bulkScene.showBulkWarrantyMenu(ctx);
  });

  bot.action(/^admin:bulk:warr_add:(\d+)$/, adminMiddleware, async (ctx) => {
    await bulkScene.execAddWarranty(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action('admin:bulk:warr_reset_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execResetWarranty(ctx);
  });

  bot.action('admin:bulk:reset_logistics_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showResetLogisticsConfirm(ctx);
  });
  bot.action('admin:bulk:reset_logistics_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execResetLogistics(ctx);
  });

  bot.action('admin:bulk:reset_products_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showResetProductsConfirm(ctx);
  });
  bot.action('admin:bulk:reset_products_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execResetProducts(ctx);
  });

  bot.action('admin:bulk:reset_categories_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showResetCategoriesConfirm(ctx);
  });
  bot.action('admin:bulk:reset_categories_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execResetCategories(ctx);
  });

  bot.action('admin:bulk:hide_products_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showHideProductsConfirm(ctx);
  });
  bot.action('admin:bulk:hide_products_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execHideProducts(ctx);
  });

  bot.action('admin:bulk:hide_categories_confirm', adminMiddleware, async (ctx) => {
    await bulkScene.showHideCategoriesConfirm(ctx);
  });
  bot.action('admin:bulk:hide_categories_exec', adminMiddleware, async (ctx) => {
    await bulkScene.execHideCategories(ctx);
  });

  // ─── ADMIN: Управление гарантией конкретного пользователя ───
  bot.action(/^admin:user:warranty:([^:]+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const userId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await usersScene.showUserWarranties(ctx, userId, page);
  });

  bot.action(/^admin:user:warr_add:([^:]+):(-?\d+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const orderId = ctx.match[1];
    const days = parseInt(ctx.match[2], 10);
    const page = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    await usersScene.execUserWarrantyAdd(ctx, orderId, days, page);
  });

  bot.action(/^admin:user:warr_reset:([^:]+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const orderId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await usersScene.execUserWarrantyReset(ctx, orderId, page);
  });

  // ─── ADMIN: Товары ───
  bot.action(/^admin:products(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const page = ctx.match[1] ? parseInt(ctx.match[1], 10) : 1;
    await productsScene.showProductsList(ctx, page);
  });

  bot.action('admin:product:search', adminMiddleware, async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'product_search';
    await ctx.reply('🔍 Введите название или часть названия товара для поиска:\n\n<i>(Например: Netflix, Kling, ChatGPT)</i>', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:products')]]),
    });
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action('admin:product:add', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await productsScene.startAddProduct(ctx);
  });

  bot.action(/^admin:product:edit:(.+?)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await productsScene.showProductEdit(ctx, productId, page);
  });

  bot.action(/^admin:product:toggle:(.+?)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    await productsScene.toggleProduct(ctx, ctx.match[1]);
  });

  bot.action(/^adm:p_orig:([^:]+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    await productsScene.toggleProductOrigin(ctx, productId, page);
  });

  bot.action(/^admin:product:field:category:(.+?)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'edit_product_field';
    ctx.session.productId = productId;
    ctx.session.productPage = page;
    ctx.session.field = 'category';

    const Category = require('../../models/Category');
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 });
    const buttons = categories.map(cat => [
      Markup.button.callback(`${cat.icon} ${cat.name}`, `adm:p_cat:${cat._id}:${productId}`)
    ]);
    buttons.push([Markup.button.callback('Без категории', `adm:p_cat:none:${productId}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}:${page}`)]);

    const { safeEdit } = require('../utils/ui');
    await safeEdit(ctx, 'Выберите новую категорию:', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    });
  });

  bot.action(/^adm:p_cat:([^:]+):([^:]+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery('✅ Категория обновлена!').catch(() => {});
    const catId = ctx.match[1] === 'none' ? null : ctx.match[1];
    const productId = ctx.match[2];
    const Product = require('../../models/Product');
    await Product.updateOne({ _id: productId }, { $set: { categoryId: catId } });
    if (ctx.session) {
      ctx.session.adminAction = null;
      ctx.session.productId = null;
      ctx.session.field = null;
      ctx.session.productPage = null;
    }
    await productsScene.showProductEdit(ctx, productId);
  });

  bot.action(/^admin:product:field:(\w+):(.+?)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const field = ctx.match[1];
    if (field === 'category') return;
    const productId = ctx.match[2];
    const page = ctx.match[3] ? parseInt(ctx.match[3], 10) : 1;
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'edit_product_field';
    ctx.session.field = field;
    ctx.session.productId = productId;
    ctx.session.productPage = page;

    const fieldLabels = {
      price: '💰 новую Цену Продажи в USDT (например: 5.50)',
      costPrice: '💸 новую Закупочную Цену в USDT (например: 2.00)',
      name: '📦 новое Название товара',
      description: '📝 Описание товара на русском',
      descriptionEn: '📝 Описание товара на английском',
      warrantyDays: '🛡 Срок гарантии в днях (например: 30)',
      subscriptionDays: '⏳ Срок подписки / действия в днях (например: 30 для 1 мес, 365 для года, 0 если бессрочно)',
    };

    const promptText = fieldLabels[field] || `новое значение для поля <b>${field}</b>`;
    await ctx.reply(`Введите ${promptText}:`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}:${page}`)]]),
    });
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action(/^admin:product:set_stock:(.+?)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    const productId = ctx.match[1];
    const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 1;
    ctx.session = ctx.session || {};
    ctx.session.adminAction = 'set_manual_stock';
    ctx.session.productId = productId;
    ctx.session.productPage = page;
    await ctx.reply(`Введите количество товара в наличии (цифрой).\n\nНапишите <b>-1</b>, если хотите сделать остаток бесконечным (∞):`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}:${page}`)]]),
    });
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action(/^admin:product:delete_confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.confirmDeleteProduct(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.deleteProduct(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:clone:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.cloneProduct(ctx, ctx.match[1]);
  });

  // Рассылка нового товара - сначала экран выбора сегмента (№16).
  bot.action(/^admin:product:broadcast:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    const Product = require('../../models/Product');
    const product = await Product.findById(productId);
    if (!product) return ctx.reply('❌ Товар не найден');

    // Собираем количество пользователей в каждом сегменте параллельно
    const counts = await Promise.all(
      notif.SEGMENTS.map((s) => notif.countSegment(s.key))
    );

    const SEGMENT_LABELS = {
      all:          'Все активные',
      vip:          'VIP (50+ USDT)',
      active:       'Активные (30 дней)',
      inactive:     'Уснувшие (30+ дней без покупок)',
      new:          'Новички (< 7 дней)',
      no_purchases: 'Без покупок',
    };

    const rows = notif.SEGMENTS.map((s, i) => [
      Markup.button.callback(
        `${s.icon} ${SEGMENT_LABELS[s.key]} - ${counts[i]}`,
        `admin:p_broadcast:${productId}:${s.key}`
      ),
    ]);
    rows.push([Markup.button.callback('❌ Отмена', `admin:product:edit:${productId}`)]);

    const text =
      `📢 <b>Рассылка товара</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n\n` +
      `<blockquote>Выберите сегмент получателей. Число рядом - это сколько людей в сегменте.</blockquote>`;

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    } catch (_) {
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    }
  });

  // ─── ADMIN: Обязательная подписка (Каналы) ───
  bot.action('admin:req_channels', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await reqChannelsScene.showReqChannelsMain(ctx);
  });

  bot.action('admin:req_channels:toggle', adminMiddleware, async (ctx) => {
    await reqChannelsScene.toggleReqChannels(ctx);
  });

  bot.action('admin:req_channels:add', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await reqChannelsScene.startAddChannel(ctx);
  });

  bot.action(/^admin:req_channels:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await reqChannelsScene.deleteReqChannel(ctx, ctx.match[1]);
  });

  bot.action('admin:req_channels:stats', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await reqChannelsScene.showReqChannelsStats(ctx);
  });

  // Запуск рассылки на конкретный сегмент (после выбора в предыдущем хэндлере).
  bot.action(/^admin:p_broadcast:([a-f0-9]{24}):(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery('📢 Запускаю рассылку...');
    await ctx.editMessageReplyMarkup(null).catch(() => {});

    const productId = ctx.match[1];
    const segment = ctx.match[2];
    const Product = require('../../models/Product');
    const Key = require('../../models/Key');

    const product = await Product.findById(productId);
    if (!product) return ctx.reply('❌ Товар не найден');

    const autoKeys = await Key.countDocuments(buildKeyQueryForProduct(product, { isUsed: false }));
    const stock = autoKeys > 0
      ? autoKeys
      : (product.type === 'manual' ? (product.manualStock === -1 ? '∞' : product.manualStock) : 0);

    const { label } = await notif.buildSegmentQuery(segment);
    const totalInSegment = await notif.countSegment(segment);

    await ctx.editMessageText(
      `📢 <b>Рассылка запущена...</b>\n\n` +
      `${escapeHtml(product.icon || '📦')} <b>${escapeHtml(product.name)}</b>\n\n` +
      `🎯 Сегмент: <b>${escapeHtml(label)}</b>\n` +
      `👥 Получателей: <b>${totalInSegment}</b>\n\n` +
      `<blockquote>⏳ Примерно ${Math.ceil((totalInSegment * 50) / 1000)} сек на отправку.\nПодождите...</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    const { sent, failed } = await notif.broadcastNewProduct(product, stock, segment);

    await ctx.reply(
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `🎯 Сегмент: <b>${label}</b>\n` +
      `📤 Отправлено: <b>${sent}</b>\n` +
      `❌ Ошибок: <b>${failed}</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⬅️ К товару', `admin:product:edit:${productId}`),
            Markup.button.callback('📦 К товарам', 'admin:products'),
          ],
        ]),
      }
    );
  });

  // (удалён недостижимый дубль admin:product:field - Telegraf всегда матчил
  // первую регистрацию этого же regex выше)

  bot.action(/^admin:product:type:(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    if (!ctx.session.newProduct) {
      await ctx.answerCbQuery('⚠️ Сессия устарела', { show_alert: true }).catch(() => {});
      return;
    }
    const type = ctx.match[1];
    ctx.session.newProduct.type = type;
    // Поставщик выбирается автоматически в handleProductInput - шаг выбора убран
    await productsScene.askNameForNewProduct(ctx, type);
  });

  // ─── ADMIN: Ключи ───
  bot.action('admin:keys', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await keysScene.showKeysList(ctx);
  });

  bot.action(/^admin:keys:add:(.+)$/, adminMiddleware, async (ctx) => {
    await keysScene.startAddKeys(ctx, ctx.match[1]);
  });

  bot.action(/^admin:keys:clear:(.+)$/, adminMiddleware, async (ctx) => {
    await keysScene.clearUsedKeys(ctx, ctx.match[1]);
  });

  bot.action('admin:noop', adminMiddleware, (ctx) => ctx.answerCbQuery());

  // ─── ADMIN: Заказы ───
  bot.action('admin:orders', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await ordersScene.showOrdersList(ctx, 'active');
  });

  bot.action(/^admin:orders:([a-zA-Z0-9_]+)(?::(\d+))?$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await ordersScene.showOrdersList(ctx, ctx.match[1], parseInt(ctx.match[2] || 1));
  });

  bot.action(/^admin:order:(.{24})$/, adminMiddleware, async (ctx) => {
    await ordersScene.showOrderDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:activate:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.confirmAndActivate(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:retry_api:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.retryApiOrder(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:complete:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.completeOrderManually(ctx, ctx.match[1]);
  });

  bot.action(/^admin:order:cancel:(.+)$/, adminMiddleware, async (ctx) => {
    await ordersScene.cancelOrder(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Пользователи ───
  bot.action('admin:users', adminMiddleware, async (ctx) => {
    // Показываем список всех пользователей
    await usersScene.showAllUsers(ctx, 1);
  });

  // Пагинация списка пользователей
  bot.action(/^admin:users:page:(\d+)$/, adminMiddleware, async (ctx) => {
    await usersScene.showAllUsers(ctx, parseInt(ctx.match[1]));
  });

  // Глобальный поиск (отдельная кнопка)
  bot.action('admin:search', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.showGlobalSearch(ctx);
  });

  // Массовая рассылка из меню пользователей
  bot.action('admin:custom_broadcast:start', adminMiddleware, async (ctx) => {
    await usersScene.startCustomBroadcast(ctx);
  });
  bot.action('admin:custom_broadcast:tos_yes', adminMiddleware, async (ctx) => {
    await usersScene.showCustomBroadcastPreview(ctx, true);
  });
  bot.action('admin:custom_broadcast:tos_no', adminMiddleware, async (ctx) => {
    await usersScene.showCustomBroadcastPreview(ctx, false);
  });
  bot.action('admin:custom_broadcast:confirm', adminMiddleware, async (ctx) => {
    await usersScene.executeCustomBroadcast(ctx);
  });

  bot.action(/^admin:user:view:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.showUserProfile(ctx, ctx.match[1]);
  });

  bot.action(/^admin:user:balance:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.startChangeBalance(ctx, ctx.match[1]);
  });

  bot.action(/^admin:user:(ban|unban):(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.toggleBan(ctx, ctx.match[2]);
  });

  bot.action(/^admin:user:(promote|demote):(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.toggleRole(ctx, ctx.match[2]);
  });
  bot.action(/^admin:user:seller_toggle:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.toggleSeller(ctx, ctx.match[1]);
  });

  bot.action(/^admin:user:txs:(.+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await usersScene.showUserTransactions(ctx, ctx.match[1]);
  });

  bot.action(/^admin:takeover:start:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.startTakeover(ctx, ctx.match[1]);
  });

  bot.action(/^admin:takeover:stop:(.+)$/, adminMiddleware, async (ctx) => {
    await usersScene.stopTakeover(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Платежи ───
  bot.action('admin:payments', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await paymentsScene.showPaymentsList(ctx);
  });

  bot.action(/^admin:payment:(.{24})$/, adminMiddleware, async (ctx) => {
    await paymentsScene.showPaymentDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.confirmPayment(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:approve:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.approvePayment(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:edit_amount:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.editPaymentAmount(ctx, ctx.match[1]);
  });

  bot.action(/^admin:payment:reject:(.+)$/, adminMiddleware, async (ctx) => {
    await paymentsScene.rejectPayment(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Продавцы ───
  bot.action('admin:sellers:withdrawals', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showWithdrawalsList(ctx);
  });

  bot.action('admin:sellers:withdrawals:history', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showWithdrawalsHistory(ctx);
  });

  bot.action(/^admin:sellers:withdrawal:(.{24})$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.showWithdrawalDetail(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:withdrawal:confirm:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.confirmWithdrawal(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:withdrawal:reject:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.rejectWithdrawal(ctx, ctx.match[1]);
  });

  bot.action('admin:sellers:list', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await sellerWithdrawalsScene.showSellersList(ctx);
  });

  bot.action('admin:sellers:add', adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.startAddSeller(ctx);
  });

  bot.action(/^admin:sellers:view:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.showSellerProfile(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:toggle:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.toggleSeller(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:balance:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.startEditSellerBalance(ctx, ctx.match[1]);
  });

  bot.action(/^admin:sellers:delete:(.+)$/, adminMiddleware, async (ctx) => {
    await sellerWithdrawalsScene.deleteSeller(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Назначение продавца на товар ───
  bot.action(/^admin:product:seller:(.{24})$/, adminMiddleware, async (ctx) => {
    await productsScene.askSellerForProduct(ctx, ctx.match[1]);
  });

  bot.action(/^adm:ps:p:(.+):(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.pickSellerForProduct(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action(/^admin:product:seller:manual:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.askManualSellerInput(ctx, ctx.match[1]);
  });

  bot.action(/^admin:product:seller:remove:(.+)$/, adminMiddleware, async (ctx) => {
    await productsScene.removeSellerFromProduct(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Споры (Disputes) ────────────────────────────────────────────────
  bot.action(/^admin:disputes:list$/, adminMiddleware, async (ctx) => {
    await disputesScene.listDisputes(ctx, 1);
  });
  bot.action(/^admin:disputes:page:(\d+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.listDisputes(ctx, parseInt(ctx.match[1]));
  });
  bot.action(/^admin:disputes:view:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.viewDispute(ctx, ctx.match[1]);
  });
  bot.action(/^admin:disputes:refund:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.resolveRefundBuyer(ctx, ctx.match[1]);
  });
  bot.action(/^admin:disputes:pay:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.resolvePaySeller(ctx, ctx.match[1]);
  });

  // ─── ADMIN: Замены по гарантии ───
  bot.action('admin:warranties:list', adminMiddleware, async (ctx) => {
    await disputesScene.listWarrantyClaims(ctx, 1);
  });
  bot.action(/^admin:warranties:page:(\d+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.listWarrantyClaims(ctx, parseInt(ctx.match[1], 10));
  });
  bot.action(/^admin:warranty:view:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.viewWarrantyClaim(ctx, ctx.match[1]);
  });
  bot.action(/^admin:warranty:approve:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.approveWarrantyClaim(ctx, ctx.match[1]);
  });
  bot.action(/^admin:warranty:reject:(.+)$/, adminMiddleware, async (ctx) => {
    await disputesScene.rejectWarrantyClaim(ctx, ctx.match[1]);
  });
  bot.action(/^admin:warranty:manual_start:(.+)$/, adminMiddleware, async (ctx) => {
    ctx.session.adminAction = 'manual_warranty_replace';
    const warrantyId = ctx.match[1];
    ctx.session.warrantyOrderId = warrantyId;
    await ctx.reply('Отправьте новые данные (например: <code>login:pass:2fa</code> или ссылку) для этого заказа:', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', `admin:warranty:view:${warrantyId}`)]]),
    });
  });

  // ─── ADMIN: Статистика ───
  bot.action('admin:stats', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showStats(ctx);
  });

  bot.action('admin:chart', adminMiddleware, async (ctx) => {
    await statsScene.showSalesChart(ctx);
  });

  // ─── ADMIN: Логистика ───
  bot.action('admin:logistics', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showLogistics(ctx, 'month', 'USDT');
  });

  bot.action(/^admin:logistics:(\w+):(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await statsScene.showLogistics(ctx, ctx.match[1], ctx.match[2]);
  });

  // ─── ADMIN: Настройки ───
  bot.action('admin:settings', adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await settingsScene.showSettings(ctx);
  });

  bot.action('admin:settings:toggle_maintenance', adminMiddleware, async (ctx) => {
    await settingsScene.toggleMaintenance(ctx);
  });

  bot.action('admin:settings:toggle_smart_pricing', adminMiddleware, async (ctx) => {
    await settingsScene.toggleSmartPricing(ctx);
  });

  bot.action('admin:settings:toggle_markdown', adminMiddleware, async (ctx) => {
    await settingsScene.toggleMarkdown(ctx);
  });

  bot.action('admin:settings:toggle_digest', adminMiddleware, async (ctx) => {
    await settingsScene.toggleDigest(ctx);
  });

  bot.action('admin:settings:toggle_platega', adminMiddleware, async (ctx) => {
    await settingsScene.togglePlatega(ctx);
  });
  bot.action('admin:settings:toggle_card', adminMiddleware, async (ctx) => {
    await settingsScene.toggleCard(ctx);
  });
  bot.action('admin:settings:toggle_bybit', adminMiddleware, async (ctx) => {
    await settingsScene.toggleBybit(ctx);
  });
  bot.action('admin:settings:toggle_clean_chat', adminMiddleware, async (ctx) => {
    await settingsScene.toggleCleanChat(ctx);
  });

  bot.action(/^admin:settings:edit:(\w+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    await settingsScene.startEditSetting(ctx, ctx.match[1]);
  });

  bot.action('admin:settings:refresh_rate', adminMiddleware, async (ctx) => {
    await settingsScene.refreshRate(ctx);
  });
  bot.action('admin:settings:reset_tos', adminMiddleware, async (ctx) => {
    await settingsScene.resetAllUserToS(ctx);
  });

  // ─── ADMIN: Написать пользователю ───
  bot.action(/^admin:msg:user:(\d+)$/, adminMiddleware, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminAction = 'send_message';
    const targetTgId = parseInt(ctx.match[1], 10);
    ctx.session.targetTelegramId = targetTgId;
    const User = require('../../models/User');
    const targetUser = await User.findOne({ telegramId: targetTgId });
    const backCallback = targetUser ? `admin:user:view:${targetUser._id}` : 'admin:users';
    await ctx.reply(`📨 Введите сообщение для пользователя <code>${ctx.match[1]}</code>:`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', backCallback)]]),
    });
  });
};

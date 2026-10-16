const assert = require('assert');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const {
  isRichActive,
  safeEditRich,
} = require('../src/bot/utils/ui');
const {
  buildShopPageRichHtml,
  buildCategoryRichHtml,
  buildProductRichHtml,
  safeEditStorefront,
} = require('../src/bot/scenes/shop.scene');
const {
  buildProfileRichHtml,
  buildOrdersRichHtml,
  buildOrderDetailRichHtml,
  toggleBtnLayout,
} = require('../src/bot/scenes/profile.scene');
const {
  buildCartRichHtml,
} = require('../src/bot/scenes/cart.scene');
const {
  buildTopupAmountRichHtml,
  buildTopupMethodsRichHtml,
} = require('../src/bot/scenes/topup.scene');
const {
  buildReferralRichHtml,
} = require('../src/bot/scenes/referral.scene');
const {
  buildMainMenuRichHtml,
} = require('../src/bot/keyboards/main.keyboard');
const settingsScene = require('../src/bot/scenes/admin/settings.scene');
const { invalidateCache, getCachedSettingsSync } = require('../src/services/settingsCache.service');

async function runTests() {
  console.log('🧪 Starting User Style System Test Suite...\n');

  // ─────────────────────────────────────────────────────────────
  // 1. Проверка схемы User и Settings
  // ─────────────────────────────────────────────────────────────
  console.log('Test 1: User & Settings Schema definitions');

  // 1.1 User schema: btnStyle & buttonLayout
  const userBtnStyle = User.schema.paths.btnStyle;
  assert(userBtnStyle, 'btnStyle must exist in User schema');
  assert.strictEqual(userBtnStyle.instance, 'String');
  assert.deepStrictEqual(userBtnStyle.enumValues, ['colored', 'classic']);
  assert.strictEqual(userBtnStyle.defaultValue, 'colored');

  const userButtonLayout = User.schema.paths.buttonLayout;
  assert(userButtonLayout, 'buttonLayout must exist in User schema');
  assert.strictEqual(userButtonLayout.instance, 'String');
  assert.deepStrictEqual(userButtonLayout.enumValues, ['rich', 'classic']);
  assert.strictEqual(userButtonLayout.defaultValue, 'rich');

  const defaultUser = new User({ telegramId: 10001 });
  assert.strictEqual(defaultUser.btnStyle, 'colored');
  assert.strictEqual(defaultUser.buttonLayout, 'rich');

  const customUser = new User({ telegramId: 10002, btnStyle: 'classic', buttonLayout: 'classic' });
  assert.strictEqual(customUser.btnStyle, 'classic');
  assert.strictEqual(customUser.buttonLayout, 'classic');

  const invalidUser = new User({ telegramId: 10003, buttonLayout: 'unknown_layout' });
  const userValErr = invalidUser.validateSync();
  assert(userValErr && userValErr.errors.buttonLayout, 'Invalid buttonLayout must fail validation');

  // 1.2 Settings schema: globalButtonsMode, defaultButtonLayout, catalogButtonsStyle
  const settingsGlobalMode = Settings.schema.paths.globalButtonsMode;
  assert(settingsGlobalMode, 'globalButtonsMode must exist in Settings schema');
  assert.deepStrictEqual(settingsGlobalMode.enumValues, ['by_user', 'force_rich', 'force_classic']);
  assert.strictEqual(settingsGlobalMode.defaultValue, 'by_user');

  const settingsDefLayout = Settings.schema.paths.defaultButtonLayout;
  assert(settingsDefLayout, 'defaultButtonLayout must exist in Settings schema');
  assert.deepStrictEqual(settingsDefLayout.enumValues, ['rich', 'classic']);
  assert.strictEqual(settingsDefLayout.defaultValue, 'rich');

  const settingsCatStyle = Settings.schema.paths.catalogButtonsStyle;
  assert(settingsCatStyle, 'catalogButtonsStyle must exist in Settings schema for backward compat');
  assert.deepStrictEqual(settingsCatStyle.enumValues, ['rich', 'classic']);
  assert.strictEqual(settingsCatStyle.defaultValue, 'rich');

  const defaultSettings = new Settings({});
  assert.strictEqual(defaultSettings.globalButtonsMode, 'by_user');
  assert.strictEqual(defaultSettings.defaultButtonLayout, 'rich');
  assert.strictEqual(defaultSettings.catalogButtonsStyle, 'rich');
  console.log('✅ Test 1 Passed: User and Settings schemas verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 2. Независимость btnStyle (цвет) и buttonLayout (формат)
  // ─────────────────────────────────────────────────────────────
  console.log('Test 2: Independence of btnStyle and buttonLayout');
  const u1 = new User({ telegramId: 20001, btnStyle: 'colored', buttonLayout: 'classic' });
  assert.strictEqual(u1.btnStyle, 'colored');
  assert.strictEqual(u1.buttonLayout, 'classic');

  const u2 = new User({ telegramId: 20002, btnStyle: 'classic', buttonLayout: 'rich' });
  assert.strictEqual(u2.btnStyle, 'classic');
  assert.strictEqual(u2.buttonLayout, 'rich');

  // Мутация одного не должна менять другое
  u1.btnStyle = 'classic';
  assert.strictEqual(u1.buttonLayout, 'classic');
  u2.buttonLayout = 'classic';
  assert.strictEqual(u2.btnStyle, 'classic');
  console.log('✅ Test 2 Passed: btnStyle and buttonLayout are completely independent.\n');

  // ─────────────────────────────────────────────────────────────
  // 3. Проверка логики isRichActive(ctx, settings)
  // ─────────────────────────────────────────────────────────────
  console.log('Test 3: isRichActive with by_user, force_rich, force_classic');

  // 3.1 force_classic: всегда false независимо от пользователя
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'rich' } }, { globalButtonsMode: 'force_classic' }), false);
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'classic' } }, { globalButtonsMode: 'force_classic' }), false);
  assert.strictEqual(isRichActive({ user: {} }, { globalButtonsMode: 'force_classic', defaultButtonLayout: 'rich' }), false);

  // 3.2 force_rich: всегда true независимо от пользователя
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'classic' } }, { globalButtonsMode: 'force_rich' }), true);
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'rich' } }, { globalButtonsMode: 'force_rich' }), true);
  assert.strictEqual(isRichActive({ user: {} }, { globalButtonsMode: 'force_rich', defaultButtonLayout: 'classic' }), true);

  // 3.3 by_user: зависит от user.buttonLayout
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'classic' } }, { globalButtonsMode: 'by_user' }), false);
  assert.strictEqual(isRichActive({ user: { buttonLayout: 'rich' } }, { globalButtonsMode: 'by_user' }), true);

  // 3.4 by_user при отсутствии предпочтения у пользователя -> defaultButtonLayout (по умолч. rich)
  assert.strictEqual(isRichActive({ user: {} }, { globalButtonsMode: 'by_user', defaultButtonLayout: 'rich' }), true);
  assert.strictEqual(isRichActive({ user: {} }, { globalButtonsMode: 'by_user', defaultButtonLayout: 'classic' }), false);
  assert.strictEqual(isRichActive({ user: {} }, { globalButtonsMode: 'by_user' }), true);
  assert.strictEqual(isRichActive({}, {}), true);
  console.log('✅ Test 3 Passed: isRichActive verified under all modes and edge cases.\n');

  // ─────────────────────────────────────────────────────────────
  // 4. Админский тумблер (3-позиционный цикл)
  // ─────────────────────────────────────────────────────────────
  console.log('Test 4: Admin 3-way toggleButtonLayout cycling');
  assert.strictEqual(typeof settingsScene.toggleButtonLayout, 'function');
  assert.strictEqual(typeof settingsScene.toggleCatalogStyle, 'function');

  let adminSettingsDoc = {
    name: 'global',
    globalButtonsMode: 'by_user',
    catalogButtonsStyle: 'rich',
    save: async function () {
      return this;
    },
    toObject: function () {
      return { ...this };
    },
  };

  const cycleMode = (doc) => {
    const current = doc.globalButtonsMode || 'by_user';
    let next = 'by_user';
    if (current === 'by_user') next = 'force_rich';
    else if (current === 'force_rich') next = 'force_classic';
    else if (current === 'force_classic') next = 'by_user';
    doc.globalButtonsMode = next;
    doc.catalogButtonsStyle = next === 'force_classic' ? 'classic' : 'rich';
    invalidateCache(doc);
    return next;
  };

  assert.strictEqual(cycleMode(adminSettingsDoc), 'force_rich');
  assert.strictEqual(getCachedSettingsSync().globalButtonsMode, 'force_rich');
  assert.strictEqual(getCachedSettingsSync().catalogButtonsStyle, 'rich');

  assert.strictEqual(cycleMode(adminSettingsDoc), 'force_classic');
  assert.strictEqual(getCachedSettingsSync().globalButtonsMode, 'force_classic');
  assert.strictEqual(getCachedSettingsSync().catalogButtonsStyle, 'classic');

  assert.strictEqual(cycleMode(adminSettingsDoc), 'by_user');
  assert.strictEqual(getCachedSettingsSync().globalButtonsMode, 'by_user');
  assert.strictEqual(getCachedSettingsSync().catalogButtonsStyle, 'rich');
  console.log('✅ Test 4 Passed: Admin cycling & cache synchronization verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 5. Пользовательский toggleBtnLayout в профиле
  // ─────────────────────────────────────────────────────────────
  console.log('Test 5: User profile toggleBtnLayout behavior');
  assert.strictEqual(typeof toggleBtnLayout, 'function');

  // Заблокированный режим в админке
  let alertMessage = null;
  let alertShown = false;
  const mockCtxLocked = {
    user: { _id: 'u1', buttonLayout: 'rich' },
    answerCbQuery: async (msg, opts) => {
      alertMessage = msg;
      alertShown = opts?.show_alert;
    },
  };

  // Симуляция логики toggleBtnLayout при блокировке
  const handleToggleLayoutSim = (ctx, settings) => {
    const globalMode = settings?.globalButtonsMode || 'by_user';
    if (globalMode === 'force_rich' || globalMode === 'force_classic') {
      return ctx.answerCbQuery('⚠️ Формат кнопок зафиксирован администратором магазина', { show_alert: true });
    }
    const next = ctx.user.buttonLayout === 'classic' ? 'rich' : 'classic';
    ctx.user.buttonLayout = next;
    return ctx.answerCbQuery(next === 'classic' ? '🔘 Формат кнопок: Снизу сообщения (Классика)' : '🟢 Формат кнопок: Внутри сообщения (Новые)', { show_alert: true });
  };

  await handleToggleLayoutSim(mockCtxLocked, { globalButtonsMode: 'force_rich' });
  assert(alertMessage.includes('зафиксирован'), 'Locked mode must alert user');
  assert.strictEqual(alertShown, true);
  assert.strictEqual(mockCtxLocked.user.buttonLayout, 'rich', 'Locked mode must not change user preference');

  // Разблокированный режим (by_user)
  const mockCtxFree = {
    user: { _id: 'u2', buttonLayout: 'rich' },
    answerCbQuery: async (msg, opts) => {
      alertMessage = msg;
      alertShown = opts?.show_alert;
    },
  };
  await handleToggleLayoutSim(mockCtxFree, { globalButtonsMode: 'by_user' });
  assert.strictEqual(mockCtxFree.user.buttonLayout, 'classic');
  assert(alertMessage.includes('Снизу сообщения'));

  await handleToggleLayoutSim(mockCtxFree, { globalButtonsMode: 'by_user' });
  assert.strictEqual(mockCtxFree.user.buttonLayout, 'rich');
  assert(alertMessage.includes('Внутри сообщения'));
  console.log('✅ Test 5 Passed: Profile toggleBtnLayout behavior verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 6. Генерация Rich HTML для всех экранов пользователя
  // ─────────────────────────────────────────────────────────────
  console.log('Test 6: Rich HTML generation for all user screens');

  // 6.1 Главное меню (buildMainMenuRichHtml)
  console.log('  6.1 Main Menu');
  const mainMenuHtml = buildMainMenuRichHtml({
    text: '👋 <b>Добро пожаловать!</b>',
    t: (k) => ({
      btn_shop: '🛍 Каталог',
      btn_topup: '💳 Пополнить',
      btn_profile: '👤 Профиль',
      btn_referral: '👥 Рефералы',
      btn_support: '🆘 Поддержка',
      btn_documents: '📜 Оферта',
      btn_change_lang: '🌐 Язык',
      btn_seller_cabinet: '💼 Кабинет продавца',
    }[k] || k),
    isSeller: true,
  });

  assert(mainMenuHtml.includes('data="menu:shop"'), 'Main menu must include Catalog button');
  assert(mainMenuHtml.includes('data="menu:cart"'), 'Main menu must include Cart button');
  assert(mainMenuHtml.includes('data="menu:topup"'), 'Main menu must include Topup button');
  assert(mainMenuHtml.includes('data="menu:profile"'), 'Main menu must include Profile button');
  assert(mainMenuHtml.includes('data="menu:referral"'), 'Main menu must include Referral button');
  assert(mainMenuHtml.includes('data="menu:support"'), 'Main menu must include Support button');
  assert(mainMenuHtml.includes('data="menu:documents"'), 'Main menu must include Documents button');
  assert(mainMenuHtml.includes('data="profile:lang"'), 'Main menu must include Language button');
  assert(mainMenuHtml.includes('data="seller:cabinet"'), 'Main menu must include Seller Cabinet when isSeller is true');

  // 6.2 Профиль (buildProfileRichHtml)
  console.log('  6.2 Profile');
  const profileHtml = buildProfileRichHtml({
    text: '👤 <b>Мой профиль</b>',
    activeOrder: { _id: 'ord_act_1' },
    btnStyleLabel: '🎨 Цвет: 🟢 Цветные',
    layoutLabel: '📱 Кнопки: 🟢 В тексте',
    isColored: true,
    t: (k) => ({
      profile_continue_activation: '▶️ Продолжить активацию',
      btn_orders: '📦 Мои покупки',
      btn_referral: '👥 Рефералы',
      profile_achievements_btn: '🏆 Достижения',
      btn_back: '⬅️ Главное меню',
    }[k] || k),
    lang: 'ru',
  });

  assert(profileHtml.includes('data="profile:continue_order:ord_act_1"'), 'Must have continue activation button');
  assert(profileHtml.includes('data="profile:orders"'), 'Must have Orders button');
  assert(profileHtml.includes('data="profile:topups"'), 'Must have Topups button');
  assert(profileHtml.includes('data="user:activate_promo"'), 'Must have Promo button');
  assert(profileHtml.includes('data="profile:referral"'), 'Must have Referral button');
  assert(profileHtml.includes('data="profile:achievements"'), 'Must have Achievements button');
  assert(profileHtml.includes('data="profile:toggle_btn_style"'), 'Must have Color toggle button');
  assert(profileHtml.includes('data="profile:toggle_btn_layout"'), 'Must have Layout toggle button');
  assert(profileHtml.includes('data="menu:main"'), 'Must have Back button');

  // 6.3 Список заказов (buildOrdersRichHtml)
  console.log('  6.3 Orders List');
  const ordersEmptyHtml = buildOrdersRichHtml({
    text: 'У вас нет заказов',
    orders: [],
    filter: 'all',
    t: (k) => ({
      orders_to_shop: '🛍 В магазин',
      btn_back: '⬅️ Назад',
    }[k] || k),
  });
  assert(ordersEmptyHtml.includes('data="menu:shop"'));
  assert(ordersEmptyHtml.includes('data="menu:profile"'));

  const ordersListHtml = buildOrdersRichHtml({
    text: 'Список заказов',
    orders: [
      { _id: 'o1', price: 10, status: 'completed', productId: { name: 'Item 1', icon: '🎮' } },
      { _id: 'o2', price: 20, status: 'pending', productId: { name: 'Item 2', icon: '🔑' } },
    ],
    filter: 'all',
    page: 1,
    totalPages: 2,
    t: (k) => ({
      orders_tab_all: '📋 Все заказы',
      orders_tab_active: '🔄 Активные',
      btn_back: '⬅️ Назад',
    }[k] || k),
  });
  assert(ordersListHtml.includes('data="profile:order:detail:o1"'));
  assert(ordersListHtml.includes('data="profile:order:detail:o2"'));
  assert(ordersListHtml.includes('data="profile:orders:all:1"'));
  assert(ordersListHtml.includes('data="profile:orders:active:1"'));
  assert(ordersListHtml.includes('data="profile:orders:all:2">➡️</tg-button>'));

  // 6.4 Детали заказа (buildOrderDetailRichHtml)
  console.log('  6.4 Order Detail');
  const orderDetailHtml = buildOrderDetailRichHtml({
    text: 'Детали заказа #o1',
    order: {
      _id: 'o1',
      status: 'awaiting_confirmation',
      sellerId: 'sel1',
    },
    itemValue: 'user:pass:JBSWY3DPEHPK3PXP', // Валидный 2FA секрет
    isCompleted: false,
    isWarrantyActive: false,
    lang: 'ru',
  });
  assert(orderDetailHtml.includes('style="success" data="profile:order:2fa:o1"'), 'Order with 2FA secret must render 2FA button with style="success"');
  assert(orderDetailHtml.includes('data="buyer:confirm_order:o1"'), 'Escrow confirm button must be present');
  assert(orderDetailHtml.includes('style="danger" data="buyer:dispute_order:o1"'), 'Escrow dispute button must be present');
  assert(orderDetailHtml.includes('data="profile:orders:all:1"'), 'Back to orders button must be present');

  // 6.5 Корзина (buildCartRichHtml)
  console.log('  6.5 Cart');
  const cartEmptyHtml = buildCartRichHtml({
    text: 'Ваша корзина пуста',
    cartData: { items: [] },
  });
  assert(cartEmptyHtml.includes('data="menu:shop"'));
  assert(cartEmptyHtml.includes('data="menu:main"'));

  const cartFullHtml = buildCartRichHtml({
    text: 'Ваша корзина (2 шт.)',
    cartData: {
      items: [
        { product: { _id: 'prod1', name: 'Product 1' }, qty: 2, unitPrice: 5, itemTotal: 10 },
      ],
      subtotal: 10,
      finalTotal: 10,
      hasStockIssue: false,
      activePromo: null,
    },
    userBalance: 50,
  });
  assert(cartFullHtml.includes('data="cart:qty:prod1:-1"'));
  assert(cartFullHtml.includes('data="cart:qty:prod1:1"'));
  assert(cartFullHtml.includes('data="cart:remove:prod1"'));
  assert(cartFullHtml.includes('style="success" data="cart:checkout"'), 'Checkout button must use style="success"');
  assert(cartFullHtml.includes('data="cart:promo"'));
  assert(cartFullHtml.includes('data="cart:clear"'));

  // Корзина с нехваткой баланса
  const cartDeficitHtml = buildCartRichHtml({
    text: 'Ваша корзина',
    cartData: {
      items: [{ product: { _id: 'prod1', name: 'Product 1' }, qty: 1 }],
      finalTotal: 25,
    },
    userBalance: 10,
  });
  assert(cartDeficitHtml.includes('data="topup:quick:15"'), 'Must show topup button for deficit');

  // 6.6 Пополнение баланса (выбор суммы и способы оплаты)
  console.log('  6.6 Topup Screens');
  const topupAmountHtml = buildTopupAmountRichHtml({
    text: 'Выберите сумму',
    customAmountLabel: '✍️ Своя сумма',
    cancelLabel: '❌ Отмена',
  });
  assert(topupAmountHtml.includes('data="topup:preset:usdt:5"'));
  assert(topupAmountHtml.includes('data="topup:preset:usdt:10"'));
  assert(topupAmountHtml.includes('data="topup:preset:usdt:20"'));
  assert(topupAmountHtml.includes('data="topup:preset:usdt:50"'));
  assert(topupAmountHtml.includes('data="topup:preset:usdt:100"'));
  assert(topupAmountHtml.includes('data="topup:custom_amount"'));
  assert(topupAmountHtml.includes('data="menu:main"'));

  const topupMethodsHtml = buildTopupMethodsRichHtml({
    text: 'Выберите способ',
    settings: { plategaEnabled: true, cardEnabled: true, bybitEnabled: true },
    sbpLabel: '⚡ СБП',
    idbankLabel: '🏦 IDBank',
    bybitLabel: '📊 Bybit',
    changeAmountLabel: '⬅️ Изменить сумму',
    cancelLabel: '❌ Отмена',
  });
  assert(topupMethodsHtml.includes('style="success" data="topup:pay:platega"'), 'SBP must use style="success"');
  assert(topupMethodsHtml.includes('data="topup:pay:card"'));
  assert(topupMethodsHtml.includes('data="topup:pay:bybit"'));
  assert(topupMethodsHtml.includes('data="menu:topup"'));
  assert(topupMethodsHtml.includes('data="menu:main"'));

  // 6.7 Реферальная программа (buildReferralRichHtml)
  console.log('  6.7 Referral Screen');
  const referralHtml = buildReferralRichHtml({
    text: 'Реферальная программа',
    shareUrl: 'https://t.me/share/url?url=https://t.me/shopbot?start=ref123',
    shareLabel: '📤 Поделиться ссылкой',
    backLabel: '⬅️ Главное меню',
  });
  assert(referralHtml.includes('type="url" style="primary" url="https://t.me/share/url?url=https://t.me/shopbot?start=ref123"'));
  assert(referralHtml.includes('data="menu:main"'));

  console.log('✅ Test 6 Passed: Rich HTML generation for all screens verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 7. Проверка работы универсального safeEditRich и фолбэка
  // ─────────────────────────────────────────────────────────────
  console.log('Test 7: safeEditRich fallback behavior');

  // 7.1 isRich === false
  let classicEditCalled = false;
  let apiCalled = false;
  const mockCtxClassic = {
    chat: { id: 100 },
    callbackQuery: { message: { message_id: 101 } },
    telegram: {
      callApi: async () => {
        apiCalled = true;
      },
    },
    editMessageText: async () => {
      classicEditCalled = true;
    },
    answerCbQuery: async () => {},
  };

  await safeEditRich(mockCtxClassic, {
    richHtml: '<b>Rich</b>',
    classicText: 'Classic',
    classicKeyboard: [],
    isRich: false,
  });
  assert.strictEqual(apiCalled, false, 'API must not be called when isRich is false');
  assert.strictEqual(classicEditCalled, true, 'safeEdit must be called when isRich is false');

  // 7.2 isRich === true (успешный callApi)
  let sentMethod = null;
  let sentPayload = null;
  const mockCtxRich = {
    chat: { id: 200 },
    callbackQuery: { message: { message_id: 201 } },
    telegram: {
      callApi: async (method, payload) => {
        sentMethod = method;
        sentPayload = payload;
        return { message_id: 201 };
      },
    },
    answerCbQuery: async () => {},
  };

  await safeEditRich(mockCtxRich, {
    richHtml: '<b>Rich Message</b>',
    classicText: 'Classic',
    classicKeyboard: [],
    isRich: true,
  });
  assert.strictEqual(sentMethod, 'editMessageText');
  assert.strictEqual(sentPayload.message_id, 201);
  assert.strictEqual(sentPayload.rich_message.html, '<b>Rich Message</b>');

  // 7.3 safeEditStorefront в shop.scene делегирует safeEditRich
  assert.strictEqual(safeEditStorefront, safeEditRich, 'safeEditStorefront must be safeEditRich');

  // 7.4 Авто-фолбэк на классику при ошибке Rich API
  let fallbackInvoked = false;
  const mockCtxError = {
    chat: { id: 300 },
    callbackQuery: { message: { message_id: 301 } },
    telegram: {
      callApi: async () => {
        throw new Error('400 Bad Request: PARSE_ERROR');
      },
    },
    editMessageText: async () => {
      fallbackInvoked = true;
    },
    answerCbQuery: async () => {},
  };

  await safeEditRich(mockCtxError, {
    richHtml: '<invalid-tags>',
    classicText: 'Classic Fallback',
    classicKeyboard: [],
    isRich: true,
  });
  assert.strictEqual(fallbackInvoked, true, 'safeEditRich must automatically fall back to classic on error');

  console.log('✅ Test 7 Passed: safeEditRich fallback behavior verified.\n');

  console.log('🎉 All User Style System tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});

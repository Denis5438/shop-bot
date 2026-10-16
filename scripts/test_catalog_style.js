const assert = require('assert');
const Settings = require('../src/models/Settings');
const {
  buildShopPageRichHtml,
  buildCategoryRichHtml,
  buildProductRichHtml,
  safeEditStorefront,
} = require('../src/bot/scenes/shop.scene');
const settingsScene = require('../src/bot/scenes/admin/settings.scene');
const { invalidateCache, getCachedSettingsSync } = require('../src/services/settingsCache.service');

async function runTests() {
  console.log('🧪 Starting Catalog Buttons Style Test Suite...\n');

  // ─────────────────────────────────────────────────────────────
  // 1. Проверка схемы Settings
  // ─────────────────────────────────────────────────────────────
  console.log('Test 1: Schema definition & default value in Settings');
  const path = Settings.schema.paths.catalogButtonsStyle;
  assert(path, 'catalogButtonsStyle path must exist in Settings schema');
  assert.strictEqual(path.instance, 'String', 'catalogButtonsStyle must be a String');
  assert.deepStrictEqual(path.enumValues, ['rich', 'classic'], 'catalogButtonsStyle enum must be ["rich", "classic"]');
  assert.strictEqual(path.defaultValue, 'rich', 'Default value must be "rich"');

  const defaultDoc = new Settings({});
  assert.strictEqual(defaultDoc.catalogButtonsStyle, 'rich', 'New Settings instance must default to "rich"');

  const classicDoc = new Settings({ catalogButtonsStyle: 'classic' });
  assert.strictEqual(classicDoc.catalogButtonsStyle, 'classic', 'Must allow setting "classic"');

  const invalidDoc = new Settings({ catalogButtonsStyle: 'invalid_style' });
  const validationErr = invalidDoc.validateSync();
  assert(validationErr && validationErr.errors.catalogButtonsStyle, 'Invalid enum value must trigger validation error');
  console.log('✅ Test 1 Passed: Settings schema verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 2. Переключение тумблера 'rich' <-> 'classic'
  // ─────────────────────────────────────────────────────────────
  console.log('Test 2: Toggle switch "rich" <-> "classic"');
  let currentStyle = 'rich';
  const mockSettingsDoc = {
    name: 'global',
    catalogButtonsStyle: currentStyle,
    save: async function () {
      currentStyle = this.catalogButtonsStyle;
      return this;
    },
    toObject: function () {
      return { ...this };
    },
  };

  // Симулируем логику переключения
  const toggleStyle = (doc) => {
    doc.catalogButtonsStyle = doc.catalogButtonsStyle === 'classic' ? 'rich' : 'classic';
    invalidateCache(doc);
    return doc.catalogButtonsStyle;
  };

  assert.strictEqual(toggleStyle(mockSettingsDoc), 'classic', 'Toggling from "rich" should give "classic"');
  assert.strictEqual(getCachedSettingsSync().catalogButtonsStyle, 'classic', 'Cache should be invalidated and updated to "classic"');

  assert.strictEqual(toggleStyle(mockSettingsDoc), 'rich', 'Toggling from "classic" should give "rich"');
  assert.strictEqual(getCachedSettingsSync().catalogButtonsStyle, 'rich', 'Cache should be invalidated and updated to "rich"');

  // Проверяем наличие toggleCatalogStyle в settingsScene
  assert.strictEqual(typeof settingsScene.toggleCatalogStyle, 'function', 'settingsScene must export toggleCatalogStyle function');
  console.log('✅ Test 2 Passed: Toggle logic & cache invalidation verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 3. Генерация корректного HTML для <tg-button-row> и <tg-button>
  // ─────────────────────────────────────────────────────────────
  console.log('Test 3: HTML generation for categories and product cards');

  // 3.1 Главное меню каталога (showShopPage)
  console.log('  3.1 Shop Page (Categories)');
  const mockInStock = [
    { _id: 'cat1', name: 'VPN & Proxy', icon: '🛡' },
    { _id: 'cat2', name: 'Subscriptions', icon: '🎬' },
    { _id: 'cat3', name: 'AI Services', icon: '🤖' },
    { _id: 'cat4', name: 'Games', icon: '🎮' },
  ];
  const mockOutOfStock = [
    { _id: 'cat5', name: 'Archive <Old>', icon: '📁' },
  ];

  const shopHtmlCollapsed = buildShopPageRichHtml({
    text: '🛍 <b>Каталог товаров</b>',
    inStockCats: mockInStock,
    outOfStockCats: mockOutOfStock,
    isCollapsed: true,
  });

  assert(shopHtmlCollapsed.includes('<tg-button-row align="left">'), 'Shop page must include <tg-button-row align="left">');
  assert(shopHtmlCollapsed.includes('<tg-button type="callback_data" style="primary" data="shop:category:cat1:1">'), 'In-stock category must have primary callback button');
  assert(shopHtmlCollapsed.includes('data="shop:category:cat3:1"'), 'Category 3 must be in first row');
  assert(shopHtmlCollapsed.includes('data="shop:category:cat4:1"'), 'Category 4 must wrap to second row');
  assert(shopHtmlCollapsed.includes('data="shop:toggle_out_main"'), 'Out of stock collapsible toggle must be present');
  assert(!shopHtmlCollapsed.includes('data="shop:category:cat5:1"'), 'Collapsed out-of-stock category must not be visible when collapsed');
  assert(shopHtmlCollapsed.includes('data="shop:search"'), 'Search button must be present');
  assert(shopHtmlCollapsed.includes('data="menu:main"'), 'Back button must be present');

  // Развернутое состояние
  const shopHtmlExpanded = buildShopPageRichHtml({
    text: '🛍 <b>Каталог товаров</b>',
    inStockCats: mockInStock,
    outOfStockCats: mockOutOfStock,
    isCollapsed: false,
  });
  assert(shopHtmlExpanded.includes('data="shop:category:cat5:1"'), 'Expanded out-of-stock category must be visible');
  assert(shopHtmlExpanded.includes('Archive &lt;Old&gt;'), 'HTML special characters must be escaped');
  assert(shopHtmlExpanded.includes('style="danger"'), 'Out of stock categories must use danger style');

  // 3.2 Список товаров в категории (showCategory)
  console.log('  3.2 Category Products List');
  const mockProductItems = [
    { label: '📦 ChatGPT Plus · $20 · 📦 5 pcs', hasStock: true, callbackData: 'shop:product:p1:1' },
    { label: '📦 Netflix 4K · $5 · 📦 0 pcs', hasStock: false, callbackData: 'shop:product:p2:1' },
  ];
  const categoryHtml = buildCategoryRichHtml({
    text: '📁 <b>AI Services</b>\nВыберите товар:',
    productItems: mockProductItems,
    outOfStockToggle: { label: '⏳ Скрыть отсутствующие ▲', callbackData: 'shop:toggle_out:cat3:1' },
    safePage: 1,
    totalPages: 2,
    categoryId: 'cat3',
    lang: 'ru',
  });

  assert(categoryHtml.includes('<tg-button-row align="left">'), 'Products must be in rows');
  assert(categoryHtml.includes('style="success" data="shop:product:p1:1"'), 'In-stock product must have success style');
  assert(categoryHtml.includes('style="danger" data="shop:product:p2:1"'), 'Out-of-stock product must have danger style');
  assert(categoryHtml.includes('<tg-button-row align="center">'), 'Pagination must use centered align');
  assert(categoryHtml.includes('data="shop:category:cat3:2">➡️</tg-button>'), 'Next page button must exist');
  assert(categoryHtml.includes('data="shop:noop">1/2</tg-button>'), 'Page indicator button must exist');
  assert(categoryHtml.includes('data="shop:main"'), 'Back to categories button must exist');

  // 3.3 Карточка товара (showProduct)
  console.log('  3.3 Product Card');
  const mockProduct = {
    _id: 'p1',
    name: 'Telegram Premium',
    type: 'key',
    price: 15,
  };

  const productHtmlInStock = buildProductRichHtml({
    text: '💳 <b>Баланс:</b> 100 USDT\n\n⭐ <b>Telegram Premium</b>',
    product: mockProduct,
    productId: 'p1',
    fromPage: 1,
    safePage: 1,
    outOfStock: false,
    cartCount: 2,
    promoBtnLabel: '🎟 Ввести промокод',
    isFlashSale: true,
    backAction: 'shop:category:cat1:1',
    lang: 'ru',
  });

  assert(productHtmlInStock.includes('style="success" data="shop:qty:p1:1:1"'), '⚡ Buy button must have style="success"');
  assert(productHtmlInStock.includes('style="primary" data="cart:add:p1"'), '🛒 Add to cart button must have style="primary"');
  assert(productHtmlInStock.includes('data="menu:cart">🛍 Перейти в корзину (2 шт.)'), 'Cart button must be present when cartCount > 0');
  assert(productHtmlInStock.includes('style="primary" data="shop:promo_prompt:p1:1:1"'), 'Promo button must be present');
  assert(productHtmlInStock.includes('data="shop:product:p1:1">🔄 Обновить</tg-button>'), 'Refresh button must be present on flash sale');
  assert(productHtmlInStock.includes('style="link" data="shop:category:cat1:1"'), 'Back button must have style="link"');

  // Товар не в наличии
  const productHtmlOutOfStock = buildProductRichHtml({
    text: 'Out of stock product',
    product: mockProduct,
    productId: 'p1',
    fromPage: 1,
    safePage: 1,
    outOfStock: true,
    cartCount: 0,
    promoBtnLabel: '🎟 Promo',
    isFlashSale: false,
    backAction: 'shop:main',
    lang: 'en',
  });

  assert(productHtmlOutOfStock.includes('data="shop:notify:p1"'), 'Notify button must be present when out of stock');
  assert(productHtmlOutOfStock.includes('data="shop:preorder_qty:p1:1:1"'), 'Preorder button must be present when out of stock');
  assert(!productHtmlOutOfStock.includes('data="cart:add:p1"'), 'Cart add button must NOT be present when out of stock');
  console.log('✅ Test 3 Passed: Rich HTML generation for all screens verified.\n');

  // ─────────────────────────────────────────────────────────────
  // 4. Проверка фолбэка на классический стиль при classic и ошибках
  // ─────────────────────────────────────────────────────────────
  console.log('Test 4: Fallback behavior to classic style');

  // 4.1 Режим 'classic'
  let safeEditCalled = false;
  let callApiCalled = false;

  const mockCtxClassic = {
    chat: { id: 12345 },
    callbackQuery: { message: { message_id: 999 } },
    telegram: {
      callApi: async () => {
        callApiCalled = true;
      },
    },
    editMessageText: async () => {
      safeEditCalled = true;
    },
    answerCbQuery: async () => {},
  };

  await safeEditStorefront(mockCtxClassic, {
    richHtml: '<b>Rich</b>',
    classicText: 'Classic Text',
    classicKeyboard: [[{ text: 'Classic Btn', callback_data: 'cb' }]],
    isRich: false,
  });

  assert.strictEqual(callApiCalled, false, 'callApi must NOT be called in classic mode');
  assert.strictEqual(safeEditCalled, true, 'safeEdit (editMessageText) must be called in classic mode');

  // 4.2 Режим 'rich' с успешным callApi
  let richCallApiMethod = null;
  let richCallApiPayload = null;
  let answerCbCalled = false;

  const mockCtxRichSuccess = {
    chat: { id: 12345 },
    callbackQuery: { message: { message_id: 888 } },
    telegram: {
      callApi: async (method, payload) => {
        richCallApiMethod = method;
        richCallApiPayload = payload;
        return { message_id: 888 };
      },
    },
    answerCbQuery: async () => {
      answerCbCalled = true;
    },
  };

  await safeEditStorefront(mockCtxRichSuccess, {
    richHtml: '<tg-button-row><tg-button type="callback_data" data="x">X</tg-button></tg-button-row>',
    classicText: 'Classic Text',
    classicKeyboard: [],
    isRich: true,
  });

  assert.strictEqual(richCallApiMethod, 'editMessageText', 'Must call editMessageText for callbackQuery');
  assert.strictEqual(richCallApiPayload.message_id, 888, 'Must pass correct message_id');
  assert(richCallApiPayload.rich_message && richCallApiPayload.rich_message.html, 'Must pass rich_message.html');
  assert.strictEqual(answerCbCalled, true, 'Must answer callback query on success');

  // 4.3 Режим 'rich' с ошибкой Telegram (авто-фолбэк на классику)
  let fallbackSafeEditCalled = false;
  const mockCtxRichError = {
    chat: { id: 12345 },
    callbackQuery: { message: { message_id: 777 } },
    telegram: {
      callApi: async () => {
        throw new Error('400: Bad Request: TAG_INVALID');
      },
    },
    editMessageText: async () => {
      fallbackSafeEditCalled = true;
    },
    answerCbQuery: async () => {},
  };

  await safeEditStorefront(mockCtxRichError, {
    richHtml: '<invalid-tag>',
    classicText: 'Fallback Classic Text',
    classicKeyboard: [[{ text: 'Fallback Btn', callback_data: 'fb' }]],
    isRich: true,
  });

  assert.strictEqual(fallbackSafeEditCalled, true, 'Must automatically fall back to classic safeEdit on Telegram error');

  // 4.4 Режим 'rich' для нового сообщения (без callbackQuery)
  let sendRichMethod = null;
  let sendRichPayload = null;
  const mockCtxNewMessage = {
    chat: { id: 54321 },
    from: { id: 54321 },
    telegram: {
      callApi: async (method, payload) => {
        sendRichMethod = method;
        sendRichPayload = payload;
        return { message_id: 111 };
      },
    },
  };

  await safeEditStorefront(mockCtxNewMessage, {
    richHtml: '<b>New Rich Message</b>',
    classicText: 'New Classic Text',
    classicKeyboard: [],
    isRich: true,
  });

  assert.strictEqual(sendRichMethod, 'sendRichMessage', 'Must call sendRichMessage for new messages');
  assert.strictEqual(sendRichPayload.chat_id, 54321, 'Must send to correct chat_id');

  // 4.5 Режим 'rich' с callbackQuery без message_id (должен вызвать sendRichMessage и answerCbQuery)
  let sendRichWithCbAnswered = false;
  const mockCtxCbNoMsgId = {
    chat: { id: 54321 },
    callbackQuery: { id: 'cb_query_1' },
    telegram: {
      callApi: async () => ({ message_id: 222 }),
    },
    answerCbQuery: async () => {
      sendRichWithCbAnswered = true;
    },
  };

  await safeEditStorefront(mockCtxCbNoMsgId, {
    richHtml: '<b>New Rich Message with Cb</b>',
    classicText: 'New Classic Text',
    classicKeyboard: [],
    isRich: true,
  });

  assert.strictEqual(sendRichWithCbAnswered, true, 'Must answer callback query even when sendRichMessage is used');

  console.log('✅ Test 4 Passed: Fallback & rich sending behavior verified.\n');

  console.log('🎉 All catalog button style tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});

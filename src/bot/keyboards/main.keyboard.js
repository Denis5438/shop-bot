const { Markup } = require('telegraf');

// Главное меню пользователя
const mainKeyboard = (t, isSeller = false) => {
  const cartLabel = t ? (t('btn_change_lang') === 'Language' ? '🛒 Cart' : '🛒 Корзина') : '🛒 Корзина';
  const buttons = [
    [
      Markup.button.callback(t('btn_shop'), 'menu:shop'),
      Markup.button.callback(cartLabel, 'menu:cart'),
    ],
    [
      Markup.button.callback(t('btn_topup'), 'menu:topup'),
      Markup.button.callback(t('btn_profile'), 'menu:profile'),
    ],
    [
      Markup.button.callback(t('btn_referral'), 'menu:referral'),
      Markup.button.callback(t('btn_support'), 'menu:support'),
    ],
    [
      Markup.button.callback(t('btn_documents'), 'menu:documents'),
      Markup.button.callback(t('btn_change_lang'), 'profile:lang'),
    ],
  ];

  if (isSeller) {
    buttons.push([Markup.button.callback(t('btn_seller_cabinet'), 'seller:cabinet')]);
  }

  return Markup.inlineKeyboard(buttons);
};

// Кнопка "Назад в главное меню"
const backToMainKeyboard = (t) =>
  Markup.inlineKeyboard([[Markup.button.callback(t('btn_back'), 'menu:main')]]);

// Кнопка выбора языка
const languageKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🇷🇺 Русский', 'lang:ru'),
      Markup.button.callback('🇬🇧 English', 'lang:en'),
    ],
  ]);

// Подтверждение / Отмена
const confirmKeyboard = (t, confirmCb, cancelCb) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(t('btn_confirm'), confirmCb),
      Markup.button.callback(t('btn_cancel'), cancelCb),
    ],
  ]);

// Кнопки пополнения – топап + назад
const topupKeyboard = (t) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('btn_topup'), 'menu:topup')],
    [Markup.button.callback(t('btn_back'), 'menu:main')],
  ]);

const { escapeHtml, toRichHtmlText } = require('../utils/ui');

/**
 * Генерация Rich HTML для главного меню
 */
const buildMainMenuRichHtml = ({
  text,
  t = (k) => k,
  isSeller = false,
  lang = 'ru',
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  const cartLabel = t ? (t('btn_change_lang') === 'Language' || lang === 'en' ? '🛒 Cart' : '🛒 Корзина') : '🛒 Корзина';

  // Ряд 1: Каталог, Корзина
  richHtml += `<tg-button-row align="left">` +
    `<tg-button type="callback_data" style="primary" data="menu:shop">${escapeHtml(t('btn_shop'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:cart">${escapeHtml(cartLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 2: Пополнить баланс, Профиль
  richHtml += `<tg-button-row align="left">` +
    `<tg-button type="callback_data" style="primary" data="menu:topup">${escapeHtml(t('btn_topup'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:profile">${escapeHtml(t('btn_profile'))}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 3: Рефералы, Поддержка
  richHtml += `<tg-button-row align="left">` +
    `<tg-button type="callback_data" style="primary" data="menu:referral">${escapeHtml(t('btn_referral'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:support">${escapeHtml(t('btn_support'))}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 4: Документы, Язык
  richHtml += `<tg-button-row align="left">` +
    `<tg-button type="callback_data" style="link" data="menu:documents">${escapeHtml(t('btn_documents'))}</tg-button>` +
    `<tg-button type="callback_data" style="link" data="profile:lang">${escapeHtml(t('btn_change_lang'))}</tg-button>` +
    `</tg-button-row>`;

  // Ряд 5: Кабинет продавца (при наличии роли продавца)
  if (isSeller) {
    richHtml += `\n<tg-button-row align="left">` +
      `<tg-button type="callback_data" style="primary" data="seller:cabinet">${escapeHtml(t('btn_seller_cabinet'))}</tg-button>` +
      `</tg-button-row>`;
  }

  return richHtml.trim();
};

module.exports = {
  mainKeyboard,
  buildMainMenuRichHtml,
  backToMainKeyboard,
  languageKeyboard,
  confirmKeyboard,
  topupKeyboard,
};

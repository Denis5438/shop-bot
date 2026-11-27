const { Markup } = require('telegraf');

const SUPPORT_ROLES = ['support', 'moderator', 'admin', 'superadmin'];

const resolveLabel = (t, key, fallback) => {
  const translated = t ? t(key) : key;
  return translated && translated !== key ? translated : fallback;
};

const parseRoleFlags = (isSellerOrOpts, extra) => {
  let isSeller = false;
  let isSupport = false;
  let isModerator = false;

  if (isSellerOrOpts && typeof isSellerOrOpts === 'object') {
    isSeller = Boolean(isSellerOrOpts.isSeller);
    const role = isSellerOrOpts.role;
    isSupport = Boolean(isSellerOrOpts.isSupport) || SUPPORT_ROLES.includes(role);
    isModerator = Boolean(isSellerOrOpts.isModerator) || role === 'moderator';
  } else {
    isSeller = Boolean(isSellerOrOpts);
    if (extra && typeof extra === 'object') {
      const role = extra.role;
      isSupport = Boolean(extra.isSupport) || SUPPORT_ROLES.includes(role);
      isModerator = Boolean(extra.isModerator) || role === 'moderator';
    }
  }

  return { isSeller, isSupport, isModerator };
};

// Главное меню пользователя
const mainKeyboard = (t, isSellerOrOpts = false, extra = null) => {
  const { isSeller, isSupport, isModerator } = parseRoleFlags(isSellerOrOpts, extra);
  const isEn = t ? t('btn_change_lang') === 'Language' : false;
  const cartLabel = isEn ? '🛒 Cart' : '🛒 Корзина';
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
    [
      Markup.button.callback(isEn ? '🔐 Website Login Code' : '🔐 Код для входа на сайт', 'menu:webauth_code'),
    ],
  ];

  if (isSeller) {
    buttons.push([Markup.button.callback(t('btn_seller_cabinet'), 'seller:cabinet')]);
  }

  if (isSupport) {
    const supportLabel = resolveLabel(t, 'btn_support_panel', isEn ? '🎧 Support Panel' : '🎧 Панель саппорта');
    buttons.push([Markup.button.callback(supportLabel, 'sp:home')]);
  }

  if (isModerator) {
    const modLabel = resolveLabel(t, 'btn_mod_panel', isEn ? '🛡 Moderator Panel' : '🛡 Панель модератора');
    buttons.push([Markup.button.callback(modLabel, 'adm_sup:hub')]);
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
  isSupport = false,
  isModerator = false,
  role = null,
  lang = 'ru',
}) => {
  let richHtml = `${toRichHtmlText(text)}<br><br>`;

  const isEn = t ? (t('btn_change_lang') === 'Language' || lang === 'en') : lang === 'en';
  const cartLabel = isEn ? '🛒 Cart' : '🛒 Корзина';
  const showSupport = Boolean(isSupport) || SUPPORT_ROLES.includes(role);
  const showModerator = Boolean(isModerator) || role === 'moderator';

  // Ряд 1: Каталог, Корзина
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="primary" data="menu:shop">${escapeHtml(t('btn_shop'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:cart">${escapeHtml(cartLabel)}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 2: Пополнить баланс, Профиль
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="primary" data="menu:topup">${escapeHtml(t('btn_topup'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:profile">${escapeHtml(t('btn_profile'))}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 3: Рефералы, Поддержка
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="primary" data="menu:referral">${escapeHtml(t('btn_referral'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="menu:support">${escapeHtml(t('btn_support'))}</tg-button>` +
    `</tg-button-row>\n`;

  // Ряд 4: Документы, Язык
  richHtml += `<tg-button-row align="center">` +
    `<tg-button type="callback_data" style="primary" data="menu:documents">${escapeHtml(t('btn_documents'))}</tg-button>` +
    `<tg-button type="callback_data" style="primary" data="profile:lang">${escapeHtml(t('btn_change_lang'))}</tg-button>` +
    `</tg-button-row>`;

  // Ряд 5: Кабинет продавца (при наличии роли продавца)
  if (isSeller) {
    richHtml += `\n<tg-button-row align="center">` +
      `<tg-button type="callback_data" style="primary" data="seller:cabinet">${escapeHtml(t('btn_seller_cabinet'))}</tg-button>` +
      `</tg-button-row>`;
  }

  // Ряд 6: Панель саппорта (support, moderator, admin, superadmin)
  if (showSupport) {
    const supportLabel = resolveLabel(t, 'btn_support_panel', isEn ? '🎧 Support Panel' : '🎧 Панель саппорта');
    richHtml += `\n<tg-button-row align="center">` +
      `<tg-button type="callback_data" style="primary" data="sp:home">${escapeHtml(supportLabel)}</tg-button>` +
      `</tg-button-row>`;
  }

  // Ряд 7: Панель модератора
  if (showModerator) {
    const modLabel = resolveLabel(t, 'btn_mod_panel', isEn ? '🛡 Moderator Panel' : '🛡 Панель модератора');
    richHtml += `\n<tg-button-row align="center">` +
      `<tg-button type="callback_data" style="primary" data="adm_sup:hub">${escapeHtml(modLabel)}</tg-button>` +
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

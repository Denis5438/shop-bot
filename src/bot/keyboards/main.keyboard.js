const { Markup } = require('telegraf');

// Главное меню пользователя
const mainKeyboard = (t) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t('btn_shop'), 'menu:shop')],
    [
      Markup.button.callback(t('btn_topup'), 'menu:topup'),
      Markup.button.callback(t('btn_profile'), 'menu:profile'),
    ],
    [
      Markup.button.callback(t('btn_support'), 'menu:support'),
      Markup.button.callback(t('btn_about'), 'menu:about'),
    ],
    [
      Markup.button.callback(t('btn_referral'), 'menu:referral')
    ],
  ]);

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

module.exports = { mainKeyboard, backToMainKeyboard, languageKeyboard, confirmKeyboard, topupKeyboard };

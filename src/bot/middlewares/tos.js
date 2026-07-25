const { Markup } = require('telegraf');

const PRIVACY_URL = 'https://telegra.ph/Politika-konfidencialnosti-04-01-26';
const AGREEMENT_URL = 'https://telegra.ph/DOGOVOR-PUBLICHNOJ-OFERTY-07-24-2';

/**
 * Клавиатура ToS-гейта (показывается до принятия условий).
 */
const tosGateKeyboard = (t) => Markup.inlineKeyboard([
  [Markup.button.url(t('tos_privacy'), PRIVACY_URL)],
  [Markup.button.url(t('tos_agreement'), AGREEMENT_URL)],
  [Markup.button.callback(t('tos_accept'), 'tos:accept')],
  [Markup.button.callback(t('tos_decline'), 'tos:decline')],
]);

/**
 * Текст экрана ToS-гейта.
 */
const tosGateText = (t) =>
  `${t('tos_welcome_title')}\n\n${t('tos_intro')}`;

/**
 * Middleware, блокирующий любые действия пользователя пока он не принял ToS.
 *
 * Логика:
 *   - Если ctx.user отсутствует (не от пользователя - channel post и т.п.) - пропускаем.
 *   - Админы освобождены от гейта.
 *   - Команда /start всегда проходит (там показываем ToS-экран).
 *   - Колбэки tos:accept / tos:decline проходят.
 *   - Если acceptedToS === false - отправляем в /start и блокируем дальше.
 */
const tosMiddleware = async (ctx, next) => {
  const user = ctx.user;
  if (!user) return next();
  if (user.acceptedToS) return next();

  // /start - пропускаем, чтобы bot.start обработал и показал гейт.
  const text = ctx.message?.text;
  if (typeof text === 'string' && /^\/start(\b|@|\s|$)/i.test(text)) {
    return next();
  }

  // tos:accept / tos:decline / lang:ru / lang:en - разрешаем прохождение.
  const cbData = ctx.callbackQuery?.data;
  if (typeof cbData === 'string' && (cbData.startsWith('tos:') || cbData.startsWith('lang:'))) {
    return next();
  }

  // Всё остальное блокируем.
  const t = ctx.t || ((k) => k);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(t('tos_required'), { show_alert: true }).catch(() => {});
    return;
  }

  await ctx.reply(t('tos_required')).catch(() => {});
};

module.exports = {
  tosMiddleware,
  tosGateKeyboard,
  tosGateText,
  PRIVACY_URL,
  AGREEMENT_URL,
};

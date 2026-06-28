const ru = require('../../locales/ru.json');
const en = require('../../locales/en.json');

const locales = { ru, en };

// Функция форматирования строки с плейсхолдерами {key}
function format(str, params = {}) {
  return str.replace(/\{(\w+)\}/g, (_, key) => {
    return params[key] !== undefined ? params[key] : `{${key}}`;
  });
}

// Middleware: добавляет ctx.t() для перевода
const i18nMiddleware = (ctx, next) => {
  const lang = ctx.user?.language || 'ru';
  const locale = locales[lang] || locales['ru'];

  ctx.t = (key, params = {}) => {
    const str = locale[key] || ru[key] || key;
    return format(str, params);
  };

  return next();
};

const translate = (lang, key, params = {}) => {
  const locale = locales[lang] || locales['ru'];
  const str = locale[key] || ru[key] || key;
  return format(str, params);
};

i18nMiddleware.translate = translate;
module.exports = i18nMiddleware;

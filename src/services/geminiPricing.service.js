/**
 * geminiPricing.service.js
 * Интеллектуальный расчет розничных цен через Google Gemini AI
 * Отталкивается от официальной розничной цены (officialPrice) и себестоимости поставщика (costPrice)
 */

const axios = require('axios');
const logger = require('../config/logger');
const { getSettings } = require('./settingsCache.service');

// Внутренний кэш оценок (ключ: "name|costPrice" -> результат, TTL 24ч)
const priceCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// База известных официальных цен на популярные цифровые товары (USD)
const KNOWN_OFFICIAL_PRICES = [
  { pattern: /chatgpt\s*plus/i, official: 20.0, category: 'AI / Нейросети' },
  { pattern: /chatgpt\s*team/i, official: 30.0, category: 'AI / Нейросети' },
  { pattern: /claude.*pro/i, official: 20.0, category: 'AI / Нейросети' },
  { pattern: /claude.*(max|team|x20|x5)/i, official: 200.0, category: 'AI / Нейросети' },
  { pattern: /midjourney.*standard/i, official: 30.0, category: 'AI / Дизайн' },
  { pattern: /midjourney.*basic/i, official: 10.0, category: 'AI / Дизайн' },
  { pattern: /midjourney.*pro/i, official: 60.0, category: 'AI / Дизайн' },
  { pattern: /telegram\s*premium.*(12|год|year)/i, official: 32.0, category: 'Мессенджеры' },
  { pattern: /telegram\s*premium.*(6|мес)/i, official: 18.0, category: 'Мессенджеры' },
  { pattern: /telegram\s*premium.*(3|мес)/i, official: 10.0, category: 'Мессенджеры' },
  { pattern: /telegram\s*premium/i, official: 3.99, category: 'Мессенджеры' },
  { pattern: /spotify.*(12|год|year)/i, official: 120.0, category: 'Музыка' },
  { pattern: /spotify/i, official: 10.99, category: 'Музыка' },
  { pattern: /discord\s*nitro\s*(full|classic|12|год)/i, official: 99.99, category: 'Игры' },
  { pattern: /discord\s*nitro/i, official: 9.99, category: 'Игры' },
  { pattern: /youtube\s*premium/i, official: 13.99, category: 'Видео' },
  { pattern: /netflix.*premium/i, official: 22.99, category: 'Видео' },
  { pattern: /netflix/i, official: 15.49, category: 'Видео' },
  { pattern: /canva\s*pro/i, official: 12.99, category: 'Дизайн' },
  { pattern: /duolingo\s*plus|super/i, official: 12.99, category: 'Обучение' },
];

const mongoose = require('mongoose');

/**
 * Получение активного ключа Gemini (из БД настроек или process.env)
 */
const getGeminiApiKey = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      const settings = await getSettings();
      if (settings?.geminiApiKey && settings.geminiApiKey.trim().length > 5) {
        return settings.geminiApiKey.trim();
      }
    }
  } catch (_) {}
  return process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';
};

/**
 * Психологическое округление розничной цены (.99 / .49)
 */
const roundToPsychological = (price) => {
  const num = parseFloat(price);
  if (isNaN(num) || num <= 0) return 0.5;

  if (num < 1.0) {
    return Math.round(num * 100) / 100;
  }

  const integerPart = Math.floor(num);
  const decimalPart = num - integerPart;

  if (Math.round(decimalPart * 100) <= 50) {
    return Number((integerPart + 0.49).toFixed(2));
  }
  return Number((integerPart + 0.99).toFixed(2));
};

/**
 * Определение известной официальной цены по названию товара
 */
const matchKnownOfficialPrice = (productName) => {
  if (!productName) return null;
  for (const item of KNOWN_OFFICIAL_PRICES) {
    if (item.pattern.test(productName)) {
      return { official: item.official, category: item.category };
    }
  }
  return null;
};

/**
 * Локальный умный эвристический расчёт (Fallback без вызова Gemini API)
 * Отталкивается от оптовой цены поставщика с процентной наценкой,
 * гарантией минимальной прибыли и жестким потолком на дорогие товары.
 */
const calculateFallbackPrice = (name, costPrice, config = {}) => {
  const cost = parseFloat(costPrice) || 0;
  if (cost <= 0) {
    return {
      name,
      costPrice: cost,
      officialPrice: 0,
      recommendedPrice: 0.5,
      profit: 0.5,
      discountPercent: 0,
      reasoning: 'Базовый товар с минимальной ценой 0.5 USDT.',
      source: 'heuristic',
    };
  }

  const markupPercent = typeof config.geminiMarkupPercent === 'number'
    ? config.geminiMarkupPercent
    : (typeof config.marginPercent === 'number' ? config.marginPercent : 25);
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number'
    ? config.geminiMaxMarkupUsd
    : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number'
    ? config.geminiMinProfitUsd
    : 1.0;

  const known = matchKnownOfficialPrice(name);
  let officialPrice = known ? known.official : 0;
  const isKnownOfficial = Boolean(officialPrice);

  // 1. Базовая наценка от оптовой себестоимости поставщика
  let markup = cost * (markupPercent / 100);

  // 2. Гарантируем минимальную чистую прибыль магазина
  if (markup < minProfit) {
    markup = minProfit;
  }

  // 3. Защита: наценка не должна превышать установленный потолок maxMarkup
  if (markup > maxMarkup) {
    markup = maxMarkup;
  }

  let recommended = cost + markup;

  // 4. Если официальная цена известна, цена магазина не должна быть выше или равна официальной
  if (isKnownOfficial && officialPrice > cost && recommended >= officialPrice) {
    recommended = Math.max(cost + minProfit, officialPrice - 0.5);
  }

  // 5. Психологическое округление розничной цены (.99 / .49)
  recommended = roundToPsychological(recommended);

  // Гарантируем минимальную прибыль после округления
  if (recommended < cost + minProfit) {
    recommended = roundToPsychological(cost + minProfit);
  }

  // Повторная проверка потолка наценки после округления
  if (recommended - cost > maxMarkup + 0.99) {
    recommended = roundToPsychological(cost + maxMarkup);
  }

  // Финальный жесткий предохранитель: если официальная цена известна, цена магазина ОБЯЗАТЕЛЬНО строго ниже официальной
  if (isKnownOfficial && officialPrice > cost && recommended >= officialPrice) {
    recommended = roundToPsychological(officialPrice - 0.5);
    if (recommended >= officialPrice) {
      recommended = Number((officialPrice - 0.01).toFixed(2));
    }
  }

  // Если официальная цена неизвестна, оцениваем ориентировочную для витрины со скидкой
  if (!isKnownOfficial || !officialPrice) {
    officialPrice = roundToPsychological(Math.max(recommended * 1.30, cost * 1.35));
  }

  const profit = Number((recommended - cost).toFixed(2));
  let discountPercent = 0;
  if (officialPrice > recommended) {
    discountPercent = Math.round(((officialPrice - recommended) / officialPrice) * 100);
  }

  let reasoning = '';
  if (isKnownOfficial && discountPercent > 0) {
    reasoning = `Оптовая цена $${cost}, наценка +${markupPercent}%. Официальная цена производителя: $${officialPrice}. Скидка для клиента ${discountPercent}%, чистая прибыль +$${profit}.`;
  } else if (cost >= 50) {
    reasoning = `Премиум-товар ($${cost}). Применен строгий потолок комиссии +$${profit} ($${recommended}) без завышения цен.`;
  } else {
    reasoning = `Оптовая цена $${cost}. Розничная цена $${recommended} (наценка +${markupPercent}%, чистая прибыль +$${profit}).`;
  }

  return {
    name,
    costPrice: cost,
    officialPrice: Number(officialPrice.toFixed(2)),
    recommendedPrice: recommended,
    profit,
    discountPercent,
    reasoning,
    source: 'heuristic',
  };
};

/**
 * Запрос к Gemini API для пакета товаров с учетом гибких настроек
 */
const queryGeminiApi = async (items, apiKey, config = {}) => {
  const markupPercent = typeof config.geminiMarkupPercent === 'number'
    ? config.geminiMarkupPercent
    : 25;
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number'
    ? config.geminiMaxMarkupUsd
    : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number'
    ? config.geminiMinProfitUsd
    : 1.0;

  // Используем Gemini 2.0 Flash (или 1.5 Flash)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const prompt =
    `Ты финансовый аналитик Telegram-магазина цифровых товаров. ` +
    `Для каждого товара из списка определи его реальную официальную цену на сайте производителя в USD (officialPrice) ` +
    `и рассчитай конкурентную цену продажи в магазине в USD (recommendedPrice), исходя из оптовой цены поставщика (costPrice).\n\n` +
    `СТРОГИЕ ПРАВИЛА ЦЕНООБРАЗОВАНИЯ:\n` +
    `1. Базовая розничная цена рассчитывается ОТ ОПТОВОЙ ЦЕНЫ с наценкой около +${markupPercent}% (costPrice * ${(1 + markupPercent / 100).toFixed(2)}). Например, если оптовая цена $7.39, цена в магазине должна быть около $${(7.39 * (1 + markupPercent / 100)).toFixed(2)} USD!\n` +
    `2. ЖЕСТКИЙ ПОТОЛОК НАЦЕНКИ: максимальная прибыль магазина НЕ ДОЛЖНА превышать +${maxMarkup} USD к оптовой цене даже на очень дорогие товары (Claude Max $200, годовые подписки и т.д.)! Категорически запрещено завышать цены!\n` +
    `3. Минимальная чистая прибыль магазина: не менее +${minProfit} USD к costPrice.\n` +
    `4. Психологические окончания: используй окончания цен .99 или .49.\n` +
    `5. СТРОГО НЕ ВЫШЕ ОФИЦИАЛЬНОЙ ЦЕНЫ: если officialPrice > costPrice, цена продажи recommendedPrice ОБЯЗАТЕЛЬНО должна быть строго меньше officialPrice (покупатель должен видеть выгоду и скидку!).\n\n` +
    `Товары для оценки (JSON):\n` +
    JSON.stringify(items.map((it, idx) => ({ id: idx, name: it.name, costPrice: it.costPrice }))) +
    `\n\nВерни СТРОГИЙ JSON массив объектов:\n` +
    `[{"id": 0, "officialPrice": number, "recommendedPrice": number, "profit": number, "discountPercent": number, "reasoning": "краткое объяснение на русском"}]`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });

  const candidates = response.data?.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error('Gemini API returned no candidates');
  }

  const rawText = candidates[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Empty text from Gemini');
  }

  const parsed = JSON.parse(rawText.trim());
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from Gemini');
  }

  return parsed;
};

/**
 * Оценка одного товара с учетом параметров конфигурации
 */
const evaluateProduct = async ({ name, costPrice, category = '' }, config = {}) => {
  const cost = parseFloat(costPrice) || 0;
  const markupPercent = typeof config.geminiMarkupPercent === 'number'
    ? config.geminiMarkupPercent
    : (typeof config.marginPercent === 'number' ? config.marginPercent : 25);
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number' ? config.geminiMaxMarkupUsd : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number' ? config.geminiMinProfitUsd : 1.0;

  const cacheKey = `${String(name).toLowerCase().trim()}|${cost.toFixed(2)}|${markupPercent}|${maxMarkup}|${minProfit}`;

  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = await getGeminiApiKey();

  if (apiKey) {
    try {
      const results = await queryGeminiApi([{ name, costPrice: cost }], apiKey, config);
      if (results && results.length > 0) {
        const res = results[0];
        const offPrice = parseFloat(res.officialPrice) || cost;
        let recPrice = parseFloat(res.recommendedPrice) || roundToPsychological(cost + minProfit);

        // Строгая защита от завышения цен или цен ниже себестоимости
        if (recPrice - cost > maxMarkup) {
          recPrice = roundToPsychological(cost + maxMarkup);
        }
        if (recPrice < cost + minProfit) {
          recPrice = roundToPsychological(cost + minProfit);
        }

        // Финальный жесткий предохранитель: цена строго ниже официальной
        if (offPrice > cost && recPrice >= offPrice) {
          recPrice = roundToPsychological(offPrice - 0.5);
          if (recPrice >= offPrice) {
            recPrice = Number((offPrice - 0.01).toFixed(2));
          }
        }

        const profit = Number((recPrice - cost).toFixed(2));
        const discountPercent = offPrice > recPrice ? Math.round(((offPrice - recPrice) / offPrice) * 100) : 0;

        const evaluated = {
          name,
          costPrice: cost,
          officialPrice: Number(offPrice.toFixed(2)),
          recommendedPrice: Number(recPrice.toFixed(2)),
          profit,
          discountPercent,
          reasoning: res.reasoning || 'Рассчитано через Gemini AI.',
          source: 'gemini',
        };

        priceCache.set(cacheKey, { timestamp: Date.now(), data: evaluated });
        return evaluated;
      }
    } catch (err) {
      logger.warn(`Gemini pricing API fallback for "${name}": ${err.message}`);
    }
  }

  // Fallback
  const fallback = calculateFallbackPrice(name, cost, config);
  priceCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
  return fallback;
};

/**
 * Пакетная оценка товаров (для импорта каталогов от Jaha и других поставщиков)
 */
const evaluateBatch = async (items, config = {}) => {
  if (!Array.isArray(items) || items.length === 0) return [];

  const markupPercent = typeof config.geminiMarkupPercent === 'number'
    ? config.geminiMarkupPercent
    : (typeof config.marginPercent === 'number' ? config.marginPercent : 25);
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number' ? config.geminiMaxMarkupUsd : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number' ? config.geminiMinProfitUsd : 1.0;

  const apiKey = await getGeminiApiKey();
  const results = new Array(items.length);
  const toFetch = [];

  // 1. Проверяем кэш
  items.forEach((item, index) => {
    const cost = parseFloat(item.costPrice) || 0;
    const cacheKey = `${String(item.name).toLowerCase().trim()}|${cost.toFixed(2)}|${markupPercent}|${maxMarkup}|${minProfit}`;
    const cached = priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      results[index] = { ...cached.data, originalIndex: index };
    } else {
      toFetch.push({ item, index, cacheKey });
    }
  });

  if (toFetch.length === 0) {
    return results;
  }

  // 2. Если есть ключ Gemini — отправляем порциями до 20 штук
  if (apiKey) {
    const CHUNK_SIZE = 20;
    for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
      const chunk = toFetch.slice(i, i + CHUNK_SIZE);
      try {
        const queryItems = chunk.map((c) => ({
          name: c.item.name,
          costPrice: parseFloat(c.item.costPrice) || 0,
        }));

        const geminiRes = await queryGeminiApi(queryItems, apiKey, config);

        geminiRes.forEach((res) => {
          const matchedChunkItem = chunk[res.id];
          if (matchedChunkItem) {
            const cost = parseFloat(matchedChunkItem.item.costPrice) || 0;
            const offPrice = parseFloat(res.officialPrice) || cost;
            let recPrice = parseFloat(res.recommendedPrice) || roundToPsychological(cost + minProfit);

            // Защита от завышения цен
            if (recPrice - cost > maxMarkup) {
              recPrice = roundToPsychological(cost + maxMarkup);
            }
            if (recPrice < cost + minProfit) {
              recPrice = roundToPsychological(cost + minProfit);
            }

            // Финальный жесткий предохранитель: цена строго ниже официальной
            if (offPrice > cost && recPrice >= offPrice) {
              recPrice = roundToPsychological(offPrice - 0.5);
              if (recPrice >= offPrice) {
                recPrice = Number((offPrice - 0.01).toFixed(2));
              }
            }

            const profit = Number((recPrice - cost).toFixed(2));
            const discountPercent = offPrice > recPrice ? Math.round(((offPrice - recPrice) / offPrice) * 100) : 0;

            const evaluated = {
              name: matchedChunkItem.item.name,
              costPrice: cost,
              officialPrice: Number(offPrice.toFixed(2)),
              recommendedPrice: Number(recPrice.toFixed(2)),
              profit,
              discountPercent,
              reasoning: res.reasoning || 'Рассчитано через Gemini AI.',
              source: 'gemini',
            };

            priceCache.set(matchedChunkItem.cacheKey, { timestamp: Date.now(), data: evaluated });
            results[matchedChunkItem.index] = evaluated;
          }
        });
      } catch (err) {
        logger.warn(`Batch Gemini error for chunk ${i / CHUNK_SIZE}: ${err.message}. Using fallback.`);
      }
    }
  }

  // 3. Для всех оставшихся (или при ошибке API) применяем локальный fallback
  toFetch.forEach(({ item, index, cacheKey }) => {
    if (!results[index]) {
      const cost = parseFloat(item.costPrice) || 0;
      const fallback = calculateFallbackPrice(item.name, cost, config);
      priceCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
      results[index] = fallback;
    }
  });

  return results;
};

/**
 * Получение наглядного предпросмотра цен (для меню настройки Gemini AI в админке)
 */
const getPricingPreview = (config = {}) => {
  const samples = [
    { name: '🤖 ChatGPT Plus (Опт Jaha)', costPrice: 7.39 },
    { name: '🌐 VPN Pro 1 месяц', costPrice: 2.50 },
    { name: '⚡ Claude Max (Опт $200)', costPrice: 200.00 },
  ];
  return samples.map((s) => calculateFallbackPrice(s.name, s.costPrice, config));
};

module.exports = {
  getGeminiApiKey,
  evaluateProduct,
  evaluateBatch,
  roundToPsychological,
  calculateFallbackPrice,
  getPricingPreview,
};

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

  if (decimalPart <= 0.49) {
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
 * С учетом настроек поставщика: целевой скидки от оф. цены и потолка наценки
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

  const targetDiscount = typeof config.geminiTargetDiscountPercent === 'number'
    ? config.geminiTargetDiscountPercent
    : 10;
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number'
    ? config.geminiMaxMarkupUsd
    : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number'
    ? config.geminiMinProfitUsd
    : 1.0;

  const known = matchKnownOfficialPrice(name);
  let officialPrice = known ? known.official : 0;
  const isKnownOfficial = Boolean(officialPrice);

  // Если официальная цена неизвестна, оцениваем ее аккуратно
  if (!officialPrice) {
    officialPrice = cost > 50 ? Number((cost * 1.15).toFixed(2)) : Number((cost * 1.35).toFixed(2));
  }

  let recommended = cost;

  // 1. Если себестоимость меньше официальной цены (например, опт $15 при оф. $20)
  if (officialPrice > cost) {
    // Целевая розничная цена с учетом скидки от официальной
    const targetPrice = officialPrice * (1 - targetDiscount / 100);
    // Розничная цена должна приносить магазину как минимум minProfit
    recommended = Math.max(cost + minProfit, targetPrice);

    // Защита: наценка не должна превышать установленный потолок maxMarkup
    if (recommended - cost > maxMarkup) {
      recommended = cost + maxMarkup;
    }

    // Если официальная цена известна, цена магазина не должна быть выше официальной
    if (isKnownOfficial && recommended >= officialPrice) {
      recommended = Math.max(cost + minProfit, officialPrice - 0.5);
    }
  } else {
    // Себестоимость равна или выше официальной (напр. активации, аккаунты, Claude Max x20 за $200)
    // Строго ограничиваем комиссию потолком maxMarkup (например, не больше $15, а не $260!)
    const fee = Math.min(maxMarkup, Math.max(minProfit, cost * 0.08));
    recommended = cost + fee;
  }

  // Психологическое округление розничной цены (.99 / .49)
  recommended = roundToPsychological(recommended);

  // Гарантируем минимальную прибыль
  if (recommended < cost + minProfit) {
    recommended = roundToPsychological(cost + minProfit);
  }

  // Повторная проверка потолка наценки после округления
  if (recommended - cost > maxMarkup + 0.99) {
    recommended = roundToPsychological(cost + maxMarkup);
  }

  if (!isKnownOfficial && officialPrice <= recommended) {
    officialPrice = roundToPsychological(recommended * 1.25);
  }

  const profit = Number((recommended - cost).toFixed(2));
  let discountPercent = 0;
  if (officialPrice > recommended) {
    discountPercent = Math.round(((officialPrice - recommended) / officialPrice) * 100);
  }

  let reasoning = '';
  if (discountPercent > 0) {
    reasoning = `Официальная цена: $${officialPrice}. Розничная цена $${recommended} дает клиенту скидку ${discountPercent}% и приносит магазину $${profit} чистой прибыли.`;
  } else if (cost >= 50) {
    reasoning = `Премиум-товар ($${cost}). Применена ограниченная сервисная комиссия +$${profit} ($${recommended}) без завышения цен.`;
  } else {
    reasoning = `Оптовая цена $${cost}. Розничная цена $${recommended} (наценка +$${profit}, чистая прибыль $${profit}).`;
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
  const targetDiscount = typeof config.geminiTargetDiscountPercent === 'number' ? config.geminiTargetDiscountPercent : 10;
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number' ? config.geminiMaxMarkupUsd : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number' ? config.geminiMinProfitUsd : 1.0;

  // Используем Gemini 2.0 Flash (или 1.5 Flash)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const prompt =
    `Ты финансовый аналитик Telegram-магазина цифровых товаров. ` +
    `Для каждого товара из списка определи его реальную официальную цену на сайте производителя в USD (officialPrice) ` +
    `и рассчитай привлекательную, конкурентную цену продажи в магазине в USD (recommendedPrice), исходя из себестоимости (costPrice).\n\n` +
    `СТРОГИЕ ПРАВИЛА ЦЕНООБРАЗОВАНИЯ:\n` +
    `1. Целевая скидка для покупателя от официальной цены: около ${targetDiscount}% (если официальная цена $20, розничная должна быть около $${(20 * (1 - targetDiscount / 100)).toFixed(2)}).\n` +
    `2. ЖЕСТКИЙ ПОТОЛОК НАЦЕНКИ: максимальная прибыль магазина НЕ ДОЛЖНА превышать +${maxMarkup} USD к оптовой цене даже на очень дорогие товары (Claude Max $200, годовые подписки и т.д.)! Категорически запрещено завышать цены!\n` +
    `3. Минимальная чистая прибыль магазина: не менее +${minProfit} USD к costPrice.\n` +
    `4. Психологические окончания: используй окончания цен .99 или .49.\n\n` +
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
  const targetDiscount = typeof config.geminiTargetDiscountPercent === 'number' ? config.geminiTargetDiscountPercent : 10;
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number' ? config.geminiMaxMarkupUsd : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number' ? config.geminiMinProfitUsd : 1.0;

  const cacheKey = `${String(name).toLowerCase().trim()}|${cost.toFixed(2)}|${targetDiscount}|${maxMarkup}|${minProfit}`;

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

  const targetDiscount = typeof config.geminiTargetDiscountPercent === 'number' ? config.geminiTargetDiscountPercent : 10;
  const maxMarkup = typeof config.geminiMaxMarkupUsd === 'number' ? config.geminiMaxMarkupUsd : 15;
  const minProfit = typeof config.geminiMinProfitUsd === 'number' ? config.geminiMinProfitUsd : 1.0;

  const apiKey = await getGeminiApiKey();
  const results = new Array(items.length);
  const toFetch = [];

  // 1. Проверяем кэш
  items.forEach((item, index) => {
    const cost = parseFloat(item.costPrice) || 0;
    const cacheKey = `${String(item.name).toLowerCase().trim()}|${cost.toFixed(2)}|${targetDiscount}|${maxMarkup}|${minProfit}`;
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
    { name: '🌐 VPN Pro 1 месяц', costPrice: 2.50 },
    { name: '🤖 ChatGPT Plus 1 месяц', costPrice: 15.00 },
    { name: '⚡ Claude Max x20 Accounts', costPrice: 200.00 },
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

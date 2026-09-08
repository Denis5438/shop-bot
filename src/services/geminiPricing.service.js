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
 */
const calculateFallbackPrice = (name, costPrice) => {
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

  const known = matchKnownOfficialPrice(name);
  let officialPrice = known ? known.official : 0;
  const isKnownOfficial = Boolean(officialPrice);

  // Если официальная цена неизвестна, оцениваем ее примерно
  if (!officialPrice) {
    officialPrice = cost > 50 ? Number((cost * 1.15).toFixed(2)) : Number((cost * 1.5).toFixed(2));
  }

  let recommended = cost;

  // 1. Если себестоимость меньше официальной цены (например, опт $15 при оф. $20)
  if (officialPrice > cost) {
    const marginRoom = officialPrice - cost;

    if (cost < 5) {
      // Мелкие товары: фиксированная прибавка или +50%
      const markup = Math.max(0.8, cost * 0.5);
      recommended = roundToPsychological(cost + markup);
      if (isKnownOfficial && recommended >= officialPrice) {
        recommended = roundToPsychological(officialPrice - 0.5);
      }
    } else if (cost < 30) {
      // Средние подписки (ChatGPT $15): делаем привлекательную цену ниже оф. сайта (например $17.99)
      // Берем ~60% от ценового зазора в прибыль магазина, а 40% даем в виде скидки покупателю
      const storeProfit = Math.max(1.5, marginRoom * 0.6);
      recommended = roundToPsychological(cost + storeProfit);
      if (recommended >= officialPrice) {
        recommended = roundToPsychological(officialPrice * 0.9);
      }
    } else if (cost < 100) {
      const storeProfit = Math.min(15, Math.max(3, marginRoom * 0.5));
      recommended = roundToPsychological(cost + storeProfit);
      if (recommended >= officialPrice) {
        recommended = roundToPsychological(officialPrice * 0.95);
      }
    } else {
      // Дорогие товары (>100): наценка не более 15-20 USDT
      const fee = Math.min(20, Math.max(10, cost * 0.08));
      recommended = roundToPsychological(cost + fee);
    }
  } else {
    // Себестоимость равна или выше официальной (активации заблокированных сервисов, напр. Claude Max $200)
    if (cost >= 100) {
      // Ограничение: комиссия за оплату не более 15-20 USDT (никаких 260$!)
      const fee = Math.min(20, cost * 0.08);
      recommended = roundToPsychological(cost + fee);
    } else if (cost >= 30) {
      recommended = roundToPsychological(cost + Math.min(10, cost * 0.15));
    } else {
      recommended = roundToPsychological(cost + Math.max(1.5, cost * 0.25));
    }
  }

  // Защита: розничная цена ВСЕГДА строго выше себестоимости минимум на 0.5 USDT
  if (recommended <= cost + 0.4) {
    recommended = roundToPsychological(cost + 0.6);
  }

  if (!isKnownOfficial && officialPrice <= recommended) {
    officialPrice = roundToPsychological(recommended * 1.3);
  }

  const profit = Number((recommended - cost).toFixed(2));
  let discountPercent = 0;
  if (officialPrice > recommended) {
    discountPercent = Math.round(((officialPrice - recommended) / officialPrice) * 100);
  }

  let reasoning = '';
  if (discountPercent > 0) {
    reasoning = `Официальная цена: $${officialPrice}. При опте $${cost} розничная цена $${recommended} дает клиенту скидку ${discountPercent}% от оригинала и приносит магазину $${profit} чистой прибыли.`;
  } else if (cost >= 100) {
    reasoning = `Премиум-товар ($${cost}). Применена умеренная сервисная комиссия +$${profit} ($${recommended}), чтобы не отпугнуть клиентов завышением.`;
  } else {
    reasoning = `Оптовая цена $${cost}. Розничная цена $${recommended} (наценка +${Math.round((profit / cost) * 100)}%, чистая прибыль $${profit}).`;
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
 * Запрос к Gemini API для пакета товаров
 */
const queryGeminiApi = async (items, apiKey) => {
  // Используем Gemini 2.0 Flash (или 1.5 Flash)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const prompt =
    `Ты финансовый аналитик Telegram-магазина цифровых товаров. ` +
    `Для каждого товара из списка определи его реальную официальную цену на сайте производителя в USD (officialPrice) ` +
    `и рассчитай оптимальную цену продажи в магазине в USD (recommendedPrice), исходя из себестоимости (costPrice).\n\n` +
    `Ключевые правила:\n` +
    `1. Если товар — известная подписка (ChatGPT Plus=$20, Claude Pro=$20, Telegram Premium, Spotify, Discord Nitro и т.д.): ` +
    `если costPrice < officialPrice (например опт $15 при оф. $20), цена продажи recommendedPrice ОБЯЗАТЕЛЬНО должна быть ДЕШЕВЛЕ официальной (например $17.49 - $17.99), ` +
    `чтобы покупатель видел реальную скидку от официальных $20, а магазин заработал прибыль.\n` +
    `2. Если товар дорогой (costPrice >= 100, например Claude Max x20 за $200): ` +
    `НЕ делай наценку 30%! Сделай адекватную сервисную комиссию за оплату картой РФ (например +$15..+$20 к опту, итого $215-$219.99), иначе покупатель откажется от покупки.\n` +
    `3. recommendedPrice ВСЕГДА должна быть строго больше costPrice минимум на 0.50 USD.\n` +
    `4. Предпочитай психологические окончания .99 или .49.\n\n` +
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
 * Оценка одного товара
 */
const evaluateProduct = async ({ name, costPrice, category = '' }) => {
  const cost = parseFloat(costPrice) || 0;
  const cacheKey = `${String(name).toLowerCase().trim()}|${cost.toFixed(2)}`;

  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = await getGeminiApiKey();

  if (apiKey) {
    try {
      const results = await queryGeminiApi([{ name, costPrice: cost }], apiKey);
      if (results && results.length > 0) {
        const res = results[0];
        const offPrice = parseFloat(res.officialPrice) || cost;
        let recPrice = parseFloat(res.recommendedPrice) || roundToPsychological(cost + 1);

        // Защита от ошибок API
        if (recPrice <= cost) {
          recPrice = Number((cost + 0.5).toFixed(2));
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
  const fallback = calculateFallbackPrice(name, cost);
  priceCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
  return fallback;
};

/**
 * Пакетная оценка товаров (для импорта каталогов от Jaha и других поставщиков)
 */
const evaluateBatch = async (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];

  const apiKey = await getGeminiApiKey();
  const results = new Array(items.length);
  const toFetch = [];

  // 1. Проверяем кэш
  items.forEach((item, index) => {
    const cost = parseFloat(item.costPrice) || 0;
    const cacheKey = `${String(item.name).toLowerCase().trim()}|${cost.toFixed(2)}`;
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

        const geminiRes = await queryGeminiApi(queryItems, apiKey);

        geminiRes.forEach((res) => {
          const matchedChunkItem = chunk[res.id];
          if (matchedChunkItem) {
            const cost = parseFloat(matchedChunkItem.item.costPrice) || 0;
            const offPrice = parseFloat(res.officialPrice) || cost;
            let recPrice = parseFloat(res.recommendedPrice) || roundToPsychological(cost + 1);

            if (recPrice <= cost) {
              recPrice = Number((cost + 0.5).toFixed(2));
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
      const fallback = calculateFallbackPrice(item.name, cost);
      priceCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
      results[index] = fallback;
    }
  });

  return results;
};

module.exports = {
  getGeminiApiKey,
  evaluateProduct,
  evaluateBatch,
  roundToPsychological,
  calculateFallbackPrice,
};

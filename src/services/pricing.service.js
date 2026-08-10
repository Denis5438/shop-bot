/**
 * Сервис умного ценообразования (Smart Pricing)
 */

const PRESETS = {
  standard: {
    name: '🎯 Стандартный',
    description: 'Оптимальный баланс прибыли и привлекательности цен',
    tiers: [
      { maxPrice: 5, marginPercent: 30, marginFixed: 0 },
      { maxPrice: 30, marginPercent: 20, marginFixed: 0 },
      { maxPrice: 100, marginPercent: 15, marginFixed: 0 },
      { maxPrice: null, marginPercent: 8, marginFixed: 0 },
    ],
  },
  high_profit: {
    name: '💰 Высокая прибыль',
    description: 'Максимизация маржи для премиальных продаж',
    tiers: [
      { maxPrice: 5, marginPercent: 40, marginFixed: 0 },
      { maxPrice: 30, marginPercent: 25, marginFixed: 0 },
      { maxPrice: 100, marginPercent: 20, marginFixed: 0 },
      { maxPrice: null, marginPercent: 12, marginFixed: 0 },
    ],
  },
  minimal: {
    name: '🔥 Демпинг / Минимум',
    description: 'Минимальные наценки для быстрого набора клиентов',
    tiers: [
      { maxPrice: 5, marginPercent: 20, marginFixed: 0 },
      { maxPrice: 30, marginPercent: 12, marginFixed: 0 },
      { maxPrice: 100, marginPercent: 8, marginFixed: 0 },
      { maxPrice: null, marginPercent: 5, marginFixed: 0 },
    ],
  },
};

/**
 * Получение активных уровней наценки для конфигурации поставщика
 */
const getActiveTiers = (supplierConfig) => {
  if (!supplierConfig || !supplierConfig.smartPricingEnabled) return null;
  const presetKey = supplierConfig.smartPricingPreset || 'standard';
  if (presetKey === 'custom' && Array.isArray(supplierConfig.pricingTiers) && supplierConfig.pricingTiers.length > 0) {
    return supplierConfig.pricingTiers;
  }
  return (PRESETS[presetKey] || PRESETS.standard).tiers;
};

/**
 * Расчет розничной цены на основе оптовой себестоимости и настроек поставщика
 * @param {number} wholesaleCost - Оптовая себестоимость в USDT
 * @param {object} supplierConfig - Конфигурация поставщика
 * @returns {number} Розничная цена в USDT
 */
const calculateRetailPrice = (wholesaleCost, supplierConfig) => {
  const cost = parseFloat(wholesaleCost) || 0;
  if (cost <= 0) return 0.5;

  let marginPercent = 30;
  let marginFixed = 0;

  if (supplierConfig && supplierConfig.smartPricingEnabled) {
    const tiers = getActiveTiers(supplierConfig);
    if (tiers && tiers.length > 0) {
      // Ищем подходящую ступень по оптовой цене
      const matchedTier = tiers.find((tier) => tier.maxPrice === null || cost <= tier.maxPrice);
      if (matchedTier) {
        marginPercent = parseFloat(matchedTier.marginPercent) || 0;
        marginFixed = parseFloat(matchedTier.marginFixed) || 0;
      }
    }
  } else if (supplierConfig) {
    marginPercent = parseFloat(supplierConfig.marginPercent) || 30;
    marginFixed = parseFloat(supplierConfig.marginFixed) || 0;
  }

  let retail = cost * (1 + marginPercent / 100) + marginFixed;
  return Math.max(0.5, Math.round(retail * 100) / 100);
};

/**
 * Текстовое описание текущей наценки поставщика для админ-панели
 */
const formatPricingDescription = (supplierConfig) => {
  if (!supplierConfig) return 'Фиксированная (+30%)';

  if (!supplierConfig.smartPricingEnabled) {
    const fixedStr = supplierConfig.marginFixed > 0 ? ` + ${supplierConfig.marginFixed} USDT` : '';
    return `Фиксированная: <b>+${supplierConfig.marginPercent}%</b>${fixedStr}`;
  }

  const presetKey = supplierConfig.smartPricingPreset || 'standard';
  const preset = PRESETS[presetKey] || { name: 'Кастомная' };
  const tiers = getActiveTiers(supplierConfig);

  let str = `⚡ <b>Умная наценка (${preset.name})</b>\n`;
  if (tiers) {
    tiers.forEach((t, i) => {
      const isLast = i === tiers.length - 1;
      const prefix = isLast ? '  └ ' : '  ├ ';
      const range = t.maxPrice === null ? 'от $100+' : (i === 0 ? `до $${t.maxPrice}` : `до $${t.maxPrice}`);
      const fixed = t.marginFixed > 0 ? ` + $${t.marginFixed}` : '';
      str += `${prefix}${range}: <b>+${t.marginPercent}%</b>${fixed}\n`;
    });
  }
  return str.trim();
};

module.exports = {
  PRESETS,
  getActiveTiers,
  calculateRetailPrice,
  formatPricingDescription,
};

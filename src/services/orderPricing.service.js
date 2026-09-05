const { getSettings } = require('./settingsCache.service');
const promoService = require('./promo.service');

/**
 * Calculates the price shown and charged by both the shop and the cart.
 * Keeping this in one service prevents the cart from silently bypassing
 * smart-pricing and markdown rules used by the single-product checkout.
 */
const getEffectivePrice = async (product, stockCount, activePromo = null) => {
  const settings = await getSettings();
  let price = Number(product.price) || 0;

  if (settings?.smartPricing && product.type !== 'manual') {
    const rawStock = Number(stockCount);
    if (!Number.isNaN(rawStock) && rawStock > 0 && rawStock < 10) {
      price = Number((price * 1.2).toFixed(2));
    }
  }

  if (settings?.autoMarkdownEnabled && settings?.autoMarkdownPercent > 0 && settings?.autoMarkdownDays > 0) {
    const lastSaleBase = product.lastSoldAt || product.createdAt;
    const lastSaleAt = lastSaleBase ? new Date(lastSaleBase).getTime() : Date.now();
    const daysSinceLastSale = (Date.now() - lastSaleAt) / (1000 * 60 * 60 * 24);
    const periods = Math.floor(daysSinceLastSale / settings.autoMarkdownDays);

    if (periods > 0) {
      const discountMult = Math.pow(1 - (settings.autoMarkdownPercent / 100), periods);
      const discountedPrice = price * discountMult;
      const costLimit = Number(product.costPrice) || 0;
      price = Number(Math.max(discountedPrice, costLimit).toFixed(2));
    }
  }

  // Flash Sale («Горящие часы»)
  if (
    product?.flashSale?.enabled &&
    product.flashSale.expiresAt &&
    new Date(product.flashSale.expiresAt) > new Date() &&
    product.flashSale.discountPercent > 0
  ) {
    const discount = price * (product.flashSale.discountPercent / 100);
    const costLimit = Number(product.costPrice) || 0;
    price = Number(Math.max(price - discount, costLimit).toFixed(2));
  }

  if (activePromo) {
    const discountRes = promoService.calculateDiscount(activePromo, price, product._id);
    if (discountRes.valid) price = discountRes.finalPrice;
  }

  return Number(price.toFixed(2));
};

module.exports = { getEffectivePrice };

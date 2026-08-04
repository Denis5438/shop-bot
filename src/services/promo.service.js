const PromoCode = require('../models/PromoCode');
const PromoUsage = require('../models/PromoUsage');
const User = require('../models/User');

/**
 * Активация промокода пользователем (для пополнения баланса или привязки скидки)
 */
const activatePromoCode = async (user, codeStr) => {
  if (!codeStr || typeof codeStr !== 'string') {
    return { success: false, reason: '❌ Введите промокод' };
  }

  const cleanCode = codeStr.trim().toUpperCase();
  const promo = await PromoCode.findOne({ code: cleanCode, isActive: true });

  if (!promo) {
    return { success: false, reason: '❌ Промокод не найден или неактивен' };
  }

  // Проверка срока годности
  if (promo.expiresAt && new Date() > new Date(promo.expiresAt)) {
    return { success: false, reason: '❌ Срок действия промокода истёк' };
  }

  // Проверка общих активаций
  if (promo.maxActivations !== -1 && promo.currentActivations >= promo.maxActivations) {
    return { success: false, reason: '❌ Превышен лимит активаций промокода' };
  }

  // Проверка активаций конкретным юзером
  const userUsageCount = await PromoUsage.countDocuments({ promoId: promo._id, userId: user._id });
  if (promo.maxPerUser !== -1 && userUsageCount >= promo.maxPerUser) {
    return { success: false, reason: '❌ Вы уже активировали этот промокод' };
  }

  // Увеличиваем счётчик активаций и сохраняем лог использования в БД для ЛЮБОГО типа промокода
  promo.currentActivations += 1;
  await promo.save();

  await PromoUsage.create({
    promoId: promo._id,
    userId: user._id,
    code: promo.code,
    type: promo.type,
    discountAmount: promo.type === 'balance' ? promo.value : 0,
  });

  // 1. Если это промокод на ПОПОЛНЕНИЕ БАЛАНСА
  if (promo.type === 'balance') {
    const bonusAmount = promo.value;

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $inc: { balance: bonusAmount } },
      { new: true }
    );

    return {
      success: true,
      type: 'balance',
      code: promo.code,
      bonusAmount,
      newBalance: updatedUser.balance,
    };
  }

  // 2. Если это промокод на СКИДКУ (% или фиксированная) - сохраняем в модель юзера для 100% персистентности
  await User.updateOne({ _id: user._id }, { $set: { activePromoCode: promo._id } });

  return {
    success: true,
    type: promo.type,
    code: promo.code,
    promoId: promo._id,
    value: promo.value,
    minOrderAmount: promo.minOrderAmount,
    productId: promo.productId ? promo.productId.toString() : null,
    isActive: true,
  };
};

/**
 * Валидация и расчёт скидки для корзины/заказа
 */
const calculateDiscount = (promo, orderAmount, productId = null) => {
  if (!promo) return { valid: false, reason: '❌ Промокод не найден' };
  if (promo.isActive === false) return { valid: false, reason: '❌ Промокод неактивен' };

  if (promo.minOrderAmount && orderAmount < promo.minOrderAmount) {
    return { valid: false, reason: `❌ Промокод действует только от ${promo.minOrderAmount} USDT` };
  }

  if (promo.productId && String(promo.productId) !== String(productId)) {
    return { valid: false, reason: '❌ Промокод не распространяется на данный товар' };
  }

  let discountAmount = 0;
  if (promo.type === 'percent') {
    discountAmount = Math.min(orderAmount, (orderAmount * promo.value) / 100);
  } else if (promo.type === 'fixed') {
    discountAmount = Math.min(orderAmount, promo.value);
  }

  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalPrice = Math.max(0, Math.round((orderAmount - discountAmount) * 100) / 100);

  return {
    valid: true,
    discountAmount,
    finalPrice,
  };
};

module.exports = {
  activatePromoCode,
  calculateDiscount,
};

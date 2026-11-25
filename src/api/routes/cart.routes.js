const express = require('express');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Product = require('../../models/Product');
const {
  getCart,
  addToCart,
  updateItemQty,
  removeFromCart,
  clearCart,
  getAvailableStock,
} = require('../../services/cart.service');
const promoService = require('../../services/promo.service');
const { authenticateToken } = require('../middlewares/auth.middleware');
const logger = require('../../config/logger');

const router = express.Router();

// Все эндпоинты корзины защищены JWT-аутентификацией
router.use(authenticateToken);

/**
 * 1. Получение текущего состояния корзины
 * GET /api/v1/cart
 */
router.get('/', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    const cartData = await getCart(user);

    // Формируем чистый и безопасный ответ для фронтенда
    const sanitizedItems = cartData.items.map((item) => ({
      productId: item.productId,
      product: {
        id: item.product._id,
        name: item.product.name,
        icon: item.product.icon || '📦',
        type: item.product.type,
        deliveryMethod: item.product.deliveryMethod,
        category: item.product.categoryId
          ? { id: item.product.categoryId._id, name: item.product.categoryId.name, icon: item.product.categoryId.icon }
          : null,
      },
      qty: item.qty,
      unitPrice: item.unitPrice,
      baseTotal: item.baseTotal,
      itemTotal: item.itemTotal,
      availableStock: item.availableStock,
      isAvailable: item.isAvailable,
    }));

    return res.json({
      success: true,
      cart: {
        items: sanitizedItems,
        totalCount: cartData.totalCount,
        subtotal: cartData.subtotal,
        discountAmount: cartData.discountAmount,
        finalTotal: cartData.finalTotal,
        hasStockIssue: cartData.hasStockIssue,
        cartVersion: cartData.cartVersion,
        activePromo: cartData.activePromo
          ? {
              id: cartData.activePromo._id,
              code: cartData.activePromo.code,
              type: cartData.activePromo.type,
              value: cartData.activePromo.value,
              discountAmount: cartData.discountAmount,
            }
          : null,
        userBalance: user.balance,
        canCheckout: !cartData.hasStockIssue && cartData.items.length > 0 && user.balance >= cartData.finalTotal,
      },
    });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка получения корзины: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось загрузить корзину' });
  }
});

/**
 * 2. Добавление товара в корзину
 * POST /api/v1/cart/items
 * Body: { productId: string, qty?: number }
 */
router.post('/items', async (req, res) => {
  try {
    const { productId, qty = 1 } = req.body;

    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID', message: 'Некорректный ID товара' });
    }

    const qtyNum = parseInt(qty, 10);
    if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 100) {
      return res.status(400).json({ success: false, error: 'INVALID_QUANTITY', message: 'Количество должно быть от 1 до 100' });
    }

    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND', message: 'Товар не найден или недоступен' });
    }

    // Проверяем доступный остаток на складе
    const availableStock = await getAvailableStock(product);
    if (availableStock <= 0) {
      return res.status(400).json({ success: false, error: 'OUT_OF_STOCK', message: 'Товара нет в наличии' });
    }

    const user = await User.findById(req.user._id);
    const existingItem = user.cart?.find((it) => it.productId.toString() === productId);
    const totalDesiredQty = (existingItem?.qty || 0) + qtyNum;

    if (totalDesiredQty > availableStock) {
      return res.status(400).json({
        success: false,
        error: 'EXCEEDS_AVAILABLE_STOCK',
        message: `В наличии только ${availableStock} шт.`,
        availableStock,
      });
    }

    const result = await addToCart(req.user._id, productId, qtyNum);

    return res.json({
      success: true,
      message: 'Товар добавлен в корзину',
      totalCount: result.totalCount,
    });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка добавления в корзину: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось добавить товар' });
  }
});

/**
 * 3. Изменение количества товара в корзине
 * PATCH /api/v1/cart/items/:productId
 * Body: { qty: number }
 */
router.patch('/items/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { qty } = req.body;

    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    const qtyNum = parseInt(qty, 10);
    if (!Number.isInteger(qtyNum) || qtyNum < 0 || qtyNum > 100) {
      return res.status(400).json({ success: false, error: 'INVALID_QUANTITY', message: 'Количество должно быть от 0 до 100' });
    }

    const user = await User.findById(req.user._id);
    const existingItem = user.cart?.find((it) => it.productId.toString() === productId);
    if (!existingItem) {
      return res.status(404).json({ success: false, error: 'ITEM_NOT_IN_CART', message: 'Товар не найден в корзине' });
    }

    if (qtyNum === 0) {
      await removeFromCart(req.user._id, productId);
      return res.json({ success: true, message: 'Товар удалён из корзины' });
    }

    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) {
      await removeFromCart(req.user._id, productId);
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_AVAILABLE', message: 'Товар более недоступен' });
    }

    const availableStock = await getAvailableStock(product);
    if (qtyNum > availableStock) {
      return res.status(400).json({
        success: false,
        error: 'EXCEEDS_AVAILABLE_STOCK',
        message: `В наличии только ${availableStock} шт.`,
        availableStock,
      });
    }

    const delta = qtyNum - existingItem.qty;
    if (delta !== 0) {
      await updateItemQty(req.user._id, productId, delta);
    }

    return res.json({ success: true, message: 'Количество обновлено', qty: qtyNum });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка обновления количества: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось обновить количество' });
  }
});

/**
 * 4. Удаление конкретного товара из корзины
 * DELETE /api/v1/cart/items/:productId
 */
router.delete('/items/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    if (!productId || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT_ID' });
    }

    await removeFromCart(req.user._id, productId);
    return res.json({ success: true, message: 'Товар удален из корзины' });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка удаления товара: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * 5. Полная очистка корзины
 * DELETE /api/v1/cart
 */
router.delete('/', async (req, res) => {
  try {
    await clearCart(req.user._id);
    return res.json({ success: true, message: 'Корзина очищена' });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка очистки корзины: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * 6. Применение промокода к корзине
 * POST /api/v1/cart/promo
 * Body: { code: string }
 */
router.post('/promo', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'CODE_REQUIRED', message: 'Укажите промокод' });
    }

    const user = await User.findById(req.user._id);
    const result = await promoService.activatePromoCode(user, code);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'PROMO_INVALID',
        message: result.reason ? result.reason.replace(/^(?:❌|ℹ️)\s*/, '') : 'Промокод недействителен',
      });
    }

    return res.json({
      success: true,
      message: result.text ? result.text.replace(/^(?:✅|ℹ️)\s*/, '') : 'Промокод успешно применён',
    });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка активации промокода: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Внутренняя ошибка проверки промокода' });
  }
});

/**
 * 7. Удаление промокода из корзины
 * DELETE /api/v1/cart/promo
 */
router.delete('/promo', async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $set: { activePromoCode: null } });
    return res.json({ success: true, message: 'Промокод удален' });
  } catch (err) {
    logger.error(`[CartAPI] Ошибка сброса промокода: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

module.exports = { cartRouter: router };

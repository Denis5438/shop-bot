const express = require('express');
const mongoose = require('mongoose');
const Order = require('../../models/Order');
const User = require('../../models/User');
const { checkoutCart } = require('../../services/cart.service');
const settingsCache = require('../../services/settingsCache.service');
const { authenticateToken } = require('../middlewares/auth.middleware');
const logger = require('../../config/logger');

const router = express.Router();

// Все эндпоинты заказов требуют аутентификации
router.use(authenticateToken);

/**
 * 1. Оформление покупки товаров из корзины с баланса
 * POST /api/v1/orders/checkout
 * Body: { cartVersion: number }
 */
router.post('/checkout', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    if (settings?.webMaintenanceMode === true && !['admin', 'superadmin'].includes(req.user?.role)) {
      return res.status(503).json({
        success: false,
        error: 'MAINTENANCE_MODE',
        message: 'Сайт находится на техническом обслуживании. Оформление заказов временно приостановлено.',
      });
    }

    const { cartVersion } = req.body;

    if (typeof cartVersion !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'CART_VERSION_REQUIRED',
        message: 'Требуется указать актуальную версию корзины (cartVersion)',
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, error: 'USER_BANNED', message: 'Аккаунт заблокирован' });
    }

    // Проверка версии корзины для защиты от race condition между параллельными вкладками
    if ((user.cartVersion || 0) !== cartVersion) {
      return res.status(409).json({
        success: false,
        error: 'CART_CHANGED',
        message: 'Корзина была изменена в другой вкладке или окне. Пожалуйста, проверьте состав корзины.',
      });
    }

    // Выполняем чекаут через ACID-транзакционный сервис
    const checkoutResult = await checkoutCart({ user });

    if (!checkoutResult.success) {
      if (checkoutResult.isInsufficientBalance) {
        return res.status(402).json({
          success: false,
          error: 'INSUFFICIENT_BALANCE',
          message: checkoutResult.error,
          diff: checkoutResult.diff,
          totalCost: checkoutResult.totalCost,
          balance: checkoutResult.balance,
        });
      }

      return res.status(400).json({
        success: false,
        error: 'CHECKOUT_FAILED',
        message: checkoutResult.error || 'Не удалось завершить оформление заказа',
      });
    }

    // Получаем обновленный баланс пользователя
    const freshUser = await User.findById(user._id).select('balance');

    return res.json({
      success: true,
      message: 'Заказ успешно оплачен и оформлен',
      totalCost: checkoutResult.totalCost,
      itemsCount: checkoutResult.itemsCount,
      totalQty: checkoutResult.totalQty,
      deliveryReports: checkoutResult.deliveryReports,
      newBalance: freshUser?.balance ?? 0,
    });
  } catch (err) {
    logger.error(`[OrdersAPI] Ошибка чекаута: ${err.message}`, { stack: err.stack });
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Внутренняя ошибка сервера при оформлении заказа',
    });
  }
});

/**
 * 2. Получение списка заказов текущего пользователя с пагинацией
 * GET /api/v1/orders
 */
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId: req.user._id };
    if (status && typeof status === 'string') {
      filter.status = status;
    }

    const [orders, totalCount] = await Promise.all([
      Order.find(filter)
        .populate('productId', 'name icon type deliveryMethod warrantyDays')
        .populate({ path: 'keyId', select: 'value' })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    // Безопасное формирование ответа: скрывать ключ, если заказ не завершён
    const sanitizedOrders = orders.map((o) => {
      const isCompleted = o.status === 'completed';
      return {
        id: o._id,
        status: o.status,
        price: o.price,
        qty: o.qty || 1,
        createdAt: o.createdAt,
        confirmedAt: o.confirmedAt,
        warrantyDays: o.warrantyDays ?? 5,
        subscriptionDays: o.subscriptionDays ?? 30,
        product: o.productId
          ? {
              id: o.productId._id,
              name: o.productId.name,
              icon: o.productId.icon || '📦',
              type: o.productId.type,
              deliveryMethod: o.productId.deliveryMethod,
            }
          : null,
        // Выдаем цифровой ключ только для завершенных заказов
        key: isCompleted ? (o.keyId?.value || o.deliveryData || null) : null,
        deliveryData: isCompleted ? o.deliveryData : null,
      };
    });

    return res.json({
      success: true,
      orders: sanitizedOrders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (err) {
    logger.error(`[OrdersAPI] Ошибка получения списка заказов: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось загрузить заказы' });
  }
});

/**
 * 3. Детальная информация по конкретному заказу
 * GET /api/v1/orders/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID' });
    }

    const order = await Order.findById(id)
      .populate('productId', 'name icon type deliveryMethod description warrantyDays subscriptionDays')
      .populate({ path: 'keyId', select: 'value' })
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }

    // Проверка прав: только владелец заказа или администратор
    const isOwner = order.userId.toString() === req.user._id.toString();
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'У вас нет доступа к этому заказу' });
    }

    const isCompleted = order.status === 'completed';

    return res.json({
      success: true,
      order: {
        id: order._id,
        status: order.status,
        price: order.price,
        qty: order.qty || 1,
        createdAt: order.createdAt,
        confirmedAt: order.confirmedAt,
        deliveredAt: order.deliveredAt,
        warrantyDays: order.warrantyDays ?? 5,
        subscriptionDays: order.subscriptionDays ?? 30,
        replacementStatus: order.replacementStatus || 'none',
        product: order.productId
          ? {
              id: order.productId._id,
              name: order.productId.name,
              icon: order.productId.icon || '📦',
              type: order.productId.type,
              deliveryMethod: order.productId.deliveryMethod,
              description: order.productId.description || '',
            }
          : null,
        // Защита выдачи ключа: только при completed статусе
        key: isCompleted ? (order.keyId?.value || order.deliveryData || null) : null,
        deliveryData: isCompleted ? order.deliveryData : null,
        activationResult: order.activationResult || null,
      },
    });
  } catch (err) {
    logger.error(`[OrdersAPI] Ошибка получения заказа ${req.params.id}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

module.exports = { ordersRouter: router };

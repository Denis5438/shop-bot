const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const { ORDER_TOKEN_ENCRYPTION_KEY } = require('../../config');

const JWT_SECRET = process.env.JWT_SECRET || ORDER_TOKEN_ENCRYPTION_KEY;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Security Error] JWT_SECRET или ORDER_TOKEN_ENCRYPTION_KEY обязательны в production режиме!');
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'shop_bot_jwt_secret_dev_fallback';

/**
 * Middleware для аутентификации JWT-токена из cookie или заголовка Authorization.
 */
const authenticateToken = async (req, res, next) => {
  try {
    let token = null;

    // 1. Проверяем HttpOnly cookie
    if (req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
    }

    // 2. Проверяем заголовок Authorization (для мобильных клиентов или iframes)
    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, error: 'AUTHENTICATION_REQUIRED', message: 'Требуется авторизация' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_EXPIRED', message: 'Сессия истекла или недействительна' });
    }

    const user = await User.findOne({ telegramId: decoded.telegramId });
    if (!user) {
      return res.status(401).json({ success: false, error: 'USER_NOT_FOUND', message: 'Пользователь не найден' });
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, error: 'ACCOUNT_BANNED', message: 'Ваш аккаунт заблокирован' });
    }

    req.user = user;
    req.jwtPayload = decoded;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Опциональная аутентификация: если токен есть, прикрепляет req.user, иначе продолжает как гость.
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token = req.cookies?.auth_token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
        const user = await User.findOne({ telegramId: decoded.telegramId });
        if (user && !user.isBanned) {
          req.user = user;
          req.jwtPayload = decoded;
        }
      } catch (_) {
        // Игнорируем ошибки невалидного токена для опциональной проверки
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

const isSupportOrAbove = (user) => Boolean(
  user && ['support', 'moderator', 'admin', 'superadmin'].includes(user.role)
);

const isModeratorOrAbove = (user) => Boolean(
  user && ['moderator', 'admin', 'superadmin'].includes(user.role)
);

const isAdminOrAbove = (user) => Boolean(
  user && ['admin', 'superadmin'].includes(user.role)
);

/**
 * Middleware для защиты эндпоинтов поддержки (support, moderator, admin, superadmin).
 */
const requireSupport = (req, res, next) => {
  if (!isSupportOrAbove(req.user)) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Недостаточно прав сотрудника поддержки' });
  }
  next();
};

/**
 * Middleware для защиты эндпоинтов модерации (moderator, admin, superadmin).
 */
const requireModerator = (req, res, next) => {
  if (!isModeratorOrAbove(req.user)) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Недостаточно прав модератора' });
  }
  next();
};

/**
 * Middleware для защиты админских эндпоинтов (role: admin или superadmin).
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Недостаточно прав администратора' });
  }
  next();
};

/**
 * Middleware для защиты супер-админских эндпоинтов (role: superadmin).
 */
const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      error: 'SUPERADMIN_REQUIRED',
      message: 'Действие доступно только главному администратору (superadmin)',
    });
  }
  next();
};

/**
 * Генерация подписанного JWT токена на 30 дней.
 */
const signUserToken = (user) => {
  return jwt.sign(
    {
      userId: user._id.toString(),
      telegramId: user.telegramId,
      username: user.username || null,
      role: user.role || 'user',
    },
    EFFECTIVE_JWT_SECRET,
    { expiresIn: '30d' }
  );
};

module.exports = {
  JWT_SECRET: EFFECTIVE_JWT_SECRET,
  authenticateToken,
  optionalAuth,
  isSupportOrAbove,
  isModeratorOrAbove,
  isAdminOrAbove,
  requireSupport,
  requireModerator,
  requireAdmin,
  requireSuperAdmin,
  signUserToken,
};

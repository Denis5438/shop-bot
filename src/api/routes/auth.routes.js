const express = require('express');
const crypto = require('crypto');
const AuthSession = require('../../models/AuthSession');
const User = require('../../models/User');
const { BOT_TOKEN } = require('../../config');
const { authenticateToken, signUserToken } = require('../middlewares/auth.middleware');
const logger = require('../../config/logger');

const router = express.Router();

/**
 * Получение имени бота для формирования deep-link.
 */
let cachedBotUsername = null;
const getBotUsername = async () => {
  if (cachedBotUsername) return cachedBotUsername;
  if (process.env.BOT_USERNAME) {
    cachedBotUsername = process.env.BOT_USERNAME.replace(/^@/, '');
    return cachedBotUsername;
  }
  return 'LachugaShop_bot'; // fallback
};

const setBotUsername = (username) => {
  if (username) cachedBotUsername = username.replace(/^@/, '');
};

/**
 * 1. Инициализация сессии входа (нажатие "Получить код в Telegram").
 * POST /api/v1/auth/session
 */
router.post('/session', async (req, res) => {
  try {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    const session = new AuthSession({
      sessionToken,
      ip,
      userAgent,
      status: 'pending',
    });
    await session.save();

    const botUser = await getBotUsername();
    const deepLink = `https://t.me/${botUser}?start=auth_${sessionToken}`;

    return res.json({
      success: true,
      sessionToken,
      deepLink,
      expiresInSeconds: 600,
    });
  } catch (err) {
    logger.error(`[AuthAPI] Ошибка создания сессии: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Не удалось создать сессию авторизации' });
  }
});

/**
 * 2. Проверка 6-значного кода, введенного на сайте.
 * POST /api/v1/auth/verify
 */
router.post('/verify', async (req, res) => {
  try {
    const { sessionToken, code } = req.body;
    if (!sessionToken || !code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'INVALID_PARAMETERS', message: 'Укажите токен сессии и код' });
    }

    const cleanCode = code.replace(/\s+/g, '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return res.status(400).json({ success: false, error: 'INVALID_CODE_FORMAT', message: 'Код должен состоять ровно из 6 цифр' });
    }

    // Ищем сессию
    const session = await AuthSession.findOne({
      sessionToken,
      status: { $in: ['pending', 'code_issued'] },
    });

    if (!session) {
      return res.status(400).json({ success: false, error: 'SESSION_NOT_FOUND_OR_EXPIRED', message: 'Сессия не найдена или истекла. Запросите код заново.' });
    }

    // Проверяем лимит попыток
    if (session.attempts >= 5) {
      session.status = 'locked';
      await session.save();
      return res.status(429).json({ success: false, error: 'TOO_MANY_ATTEMPTS', message: 'Превышен лимит попыток ввода. Запросите новый код.' });
    }

    // Проверяем срок действия кода (5 минут)
    if (!session.codeExpiresAt || new Date() > session.codeExpiresAt || !session.codeHash) {
      return res.status(400).json({ success: false, error: 'CODE_EXPIRED', message: 'Срок действия кода истёк. Запросите код заново в боте.' });
    }

    // Сверяем хэш через timingSafeEqual
    const candidateHash = crypto.createHash('sha256').update(cleanCode).digest('hex');
    const bufA = Buffer.from(candidateHash, 'hex');
    const bufB = Buffer.from(session.codeHash, 'hex');

    const isValid = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

    if (!isValid) {
      const updated = await AuthSession.findOneAndUpdate(
        { _id: session._id },
        {
          $inc: { attempts: 1 },
          ...(session.attempts + 1 >= 5 ? { $set: { status: 'locked' } } : {}),
        },
        { new: true }
      );
      const attemptsCount = updated?.attempts || (session.attempts + 1);
      const remaining = Math.max(0, 5 - attemptsCount);
      return res.status(400).json({
        success: false,
        error: 'INVALID_CODE',
        message: remaining > 0 ? `Неверный код. Осталось попыток: ${remaining}` : 'Превышен лимит попыток. Запросите код заново.',
      });
    }

    // Код верный! Выполняем CAS перевод в статус verified
    const updatedSession = await AuthSession.findOneAndUpdate(
      { _id: session._id, status: { $in: ['pending', 'code_issued'] } },
      { $set: { status: 'verified', verifiedAt: new Date() } },
      { new: true }
    );

    if (!updatedSession) {
      return res.status(400).json({ success: false, error: 'SESSION_ALREADY_USED', message: 'Сессия уже была использована' });
    }

    // Находим или создаём пользователя
    let user = await User.findOne({ telegramId: session.telegramId });
    if (!user) {
      user = new User({
        telegramId: session.telegramId,
        role: 'user',
      });
      await user.save();
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, error: 'USER_BANNED', message: 'Ваш аккаунт заблокирован' });
    }

    const token = signUserToken(user);

    // Устанавливаем защищенную куку
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000, // 30 дней
    });

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        balance: user.balance,
        role: user.role,
      },
    });
  } catch (err) {
    logger.error(`[AuthAPI] Ошибка подтверждения кода: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Внутренняя ошибка проверки' });
  }
});

/**
 * 3. Polling статуса сессии для мгновенного входа (1-клик в боте).
 * GET /api/v1/auth/check-status?token=<sessionToken>
 */
router.get('/check-status', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ success: false, error: 'TOKEN_REQUIRED' });
    }

    const session = await AuthSession.findOne({ sessionToken: token });
    if (!session) {
      return res.json({ success: false, status: 'not_found' });
    }

    // Если пользователь подтвердил вход кнопкой в боте:
    if (session.status === 'authenticated') {
      // Атомарно переводим в verified
      const updated = await AuthSession.findOneAndUpdate(
        { _id: session._id, status: 'authenticated' },
        { $set: { status: 'verified', verifiedAt: new Date() } },
        { new: true }
      );

      if (updated && session.telegramId) {
        let user = await User.findOne({ telegramId: session.telegramId });
        if (!user) {
          user = new User({ telegramId: session.telegramId, role: 'user' });
          await user.save();
        }

        const jwtToken = signUserToken(user);

        res.cookie('auth_token', jwtToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 30 * 24 * 3600 * 1000,
        });

        return res.json({
          success: true,
          authenticated: true,
          token: jwtToken,
          user: {
            id: user._id,
            telegramId: user.telegramId,
            username: user.username,
            balance: user.balance,
            role: user.role,
          },
        });
      }
    }

    return res.json({
      success: true,
      authenticated: false,
      status: session.status,
    });
  } catch (err) {
    logger.error(`[AuthAPI] Ошибка проверки статуса: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * 4. Авторизация из Telegram Mini App по initData (HMAC-SHA256).
 * POST /api/v1/auth/webapp
 */
router.post('/webapp', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData || !BOT_TOKEN) {
      return res.status(400).json({ success: false, error: 'INIT_DATA_REQUIRED' });
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    if (!hash) {
      return res.status(400).json({ success: false, error: 'HASH_MISSING' });
    }

    // Сортировка ключей
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');

    // Вычисление HMAC с секретным ключом от BOT_TOKEN
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const bufCalculated = Buffer.from(calculatedHash, 'hex');
    const bufReceived = Buffer.from(hash, 'hex');

    if (bufCalculated.length !== bufReceived.length || !crypto.timingSafeEqual(bufCalculated, bufReceived)) {
      return res.status(401).json({ success: false, error: 'HMAC_VERIFICATION_FAILED', message: 'Недействительные данные Telegram' });
    }

    const userDataStr = params.get('user');
    const tgUser = userDataStr ? JSON.parse(userDataStr) : null;
    if (!tgUser || !tgUser.id) {
      return res.status(400).json({ success: false, error: 'USER_DATA_MISSING' });
    }

    let user = await User.findOne({ telegramId: tgUser.id });
    if (!user) {
      user = new User({
        telegramId: tgUser.id,
        username: tgUser.username || null,
        firstName: tgUser.first_name || '',
        role: 'user',
      });
      await user.save();
    } else if (tgUser.username && user.username !== tgUser.username) {
      user.username = tgUser.username;
      await user.save();
    }

    if (user.isBanned) {
      return res.status(403).json({ success: false, error: 'USER_BANNED' });
    }

    const token = signUserToken(user);

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        balance: user.balance,
        role: user.role,
      },
    });
  } catch (err) {
    logger.error(`[AuthAPI] Ошибка WebApp входа: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * 5. Текущий профиль пользователя.
 * GET /api/v1/auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  return res.json({
    success: true,
    user: {
      id: req.user._id,
      telegramId: req.user.telegramId,
      username: req.user.username,
      firstName: req.user.firstName,
      balance: req.user.balance,
      totalSpent: req.user.totalSpent,
      role: req.user.role,
      referralCode: req.user.referralCode,
      createdAt: req.user.createdAt,
    },
  });
});

/**
 * 6. Выход из аккаунта.
 * POST /api/v1/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  return res.json({ success: true, message: 'Успешный выход' });
});

module.exports = {
  authRouter: router,
  setBotUsername,
};

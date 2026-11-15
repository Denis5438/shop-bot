const crypto = require('crypto');
const logger = require('../config/logger');
const Order = require('../models/Order');
const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const Settings = require('../models/Settings');
const { getSettings, getCachedSettingsSync } = require('./settingsCache.service');

/**
 * Сервис достижений (№20).
 *
 * Архитектура:
 *   - Описание ачивок статично в этом файле (см. ACHIEVEMENTS).
 *   - Прогресс пользователя считается on-the-fly из существующих данных
 *     (User.totalSpent, количество completed orders, кол-во активных рефералов с заказами).
 *   - Разблокировка записывается в User.achievements как { code, unlockedAt }.
 *   - Если settings.achievementRewardsEnabled === true:
 *     НЕ начисляет сырой USDT на баланс! Генерирует персональный разовый PromoCode
 *     со скидкой и минимальной суммой заказа (MOV).
 *   - Если settings.achievementRewardsEnabled !== true:
 *     Финансовые награды отключены, ачивки открываются как косметические бейджи.
 */

// ─── Описание всех ачивок ──────────────────────────────────────────────────
/**
 * @typedef {Object} Achievement
 * @property {string} code               Уникальный ID
 * @property {Object|string} title       Название
 * @property {Object|string} description Что нужно сделать
 * @property {string} icon               Эмодзи
 * @property {number} bonus              Всегда 0 (баланс сырыми USDT не пополняется)
 * @property {number} rewardDiscount     Сумма скидки по купону ($)
 * @property {number} minOrderAmount     Минимальная сумма заказа для купона ($)
 * @property {Function} check            async (user, stats) => boolean - условие выполнено
 * @property {Function} progress         async (user, stats) => {current,target} - для прогресс-бара
 */
const ACHIEVEMENTS = [
  {
    code: 'first_purchase',
    title: { ru: 'Первая покупка', en: 'First Purchase' },
    description: { ru: 'Совершите первую успешную покупку', en: 'Make your first successful purchase' },
    icon: '🎉',
    bonus: 0,
    rewardDiscount: 0.50,
    minOrderAmount: 10,
    check: (_user, stats) => stats.completedOrdersCount >= 1,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 1), target: 1 }),
  },
  {
    code: 'five_orders',
    title: { ru: 'Постоянный клиент', en: 'Regular Customer' },
    description: { ru: 'Совершите 5 успешных покупок', en: 'Make 5 successful purchases' },
    icon: '🛍️',
    bonus: 0,
    rewardDiscount: 1.50,
    minOrderAmount: 20,
    check: (_user, stats) => stats.completedOrdersCount >= 5,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 5), target: 5 }),
  },
  {
    code: 'ten_orders',
    title: { ru: 'Опытный покупатель', en: 'Experienced Buyer' },
    description: { ru: 'Совершите 10 успешных покупок', en: 'Make 10 successful purchases' },
    icon: '🏅',
    bonus: 0,
    rewardDiscount: 3.00,
    minOrderAmount: 40,
    check: (_user, stats) => stats.completedOrdersCount >= 10,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 10), target: 10 }),
  },
  {
    code: 'spent_20',
    title: { ru: 'Активный участник', en: 'Active Member' },
    description: { ru: 'Потратьте 20 USDT', en: 'Spend 20 USDT' },
    icon: '💸',
    bonus: 0,
    rewardDiscount: 1.00,
    minOrderAmount: 15,
    check: (user) => (user.totalSpent || 0) >= 20,
    progress: (user) => ({ current: Math.min(user.totalSpent || 0, 20), target: 20 }),
  },
  {
    code: 'spent_50',
    title: { ru: 'VIP-статус', en: 'VIP Status' },
    description: { ru: 'Потратьте 50 USDT', en: 'Spend 50 USDT' },
    icon: '💎',
    bonus: 0,
    rewardDiscount: 2.50,
    minOrderAmount: 35,
    check: (user) => (user.totalSpent || 0) >= 50,
    progress: (user) => ({ current: Math.min(user.totalSpent || 0, 50), target: 50 }),
  },
  {
    code: 'spent_100',
    title: { ru: 'Элита', en: 'Elite' },
    description: { ru: 'Потратьте 100 USDT', en: 'Spend 100 USDT' },
    icon: '👑',
    bonus: 0,
    rewardDiscount: 5.00,
    minOrderAmount: 60,
    check: (user) => (user.totalSpent || 0) >= 100,
    progress: (user) => ({ current: Math.min(user.totalSpent || 0, 100), target: 100 }),
  },
  {
    code: 'first_referral',
    title: { ru: 'Первый приглашённый', en: 'First Referral' },
    description: { ru: 'Пригласите первого друга с покупкой', en: 'Invite your first friend with a purchase' },
    icon: '🎁',
    bonus: 0,
    rewardDiscount: 0.50,
    minOrderAmount: 10,
    check: (_user, stats) => stats.referredCount >= 1,
    progress: (_user, stats) => ({ current: Math.min(stats.referredCount, 1), target: 1 }),
  },
  {
    code: 'five_referrals',
    title: { ru: 'Амбассадор', en: 'Ambassador' },
    description: { ru: 'Пригласите 5 друзей с покупками', en: 'Invite 5 friends with purchases' },
    icon: '🤝',
    bonus: 0,
    rewardDiscount: 2.50,
    minOrderAmount: 30,
    check: (_user, stats) => stats.referredCount >= 5,
    progress: (_user, stats) => ({ current: Math.min(stats.referredCount, 5), target: 5 }),
  },
];

/**
 * Получение настроек магазина: приоритет Settings.findOne({ name: 'global' }),
 * с fallback на getSettings() из кеша.
 */
const getCachedSettings = async () => {
  try {
    if (Settings && typeof Settings.findOne === 'function') {
      const s = await Settings.findOne({ name: 'global' }).lean();
      if (s) return s;
    }
  } catch (_) {}
  try {
    if (typeof getSettings === 'function') {
      const s = await getSettings();
      if (s) return s;
    }
  } catch (_) {}
  return {};
};

/**
 * Собирает статистику пользователя, необходимую для проверки всех ачивок.
 * Защита от реферального абуза: учитываются только приглашённые пользователи,
 * у которых есть хотя бы 1 завершённый заказ (status: 'completed').
 * Пустышки, просто нажавшие /start, не учитываются!
 */
const computeUserStats = async (userId) => {
  const [completedOrdersCount, rawReferredUsers] = await Promise.all([
    Order.countDocuments({ userId, status: 'completed' }),
    typeof User.distinct === 'function'
      ? User.distinct('_id', { referredBy: userId }).catch(() => null)
      : null,
  ]);

  let referredUserIds = Array.isArray(rawReferredUsers) ? rawReferredUsers : null;
  if (!referredUserIds) {
    const users = await User.find({ referredBy: userId }).select('_id').lean();
    referredUserIds = users.map((u) => u._id);
  }

  let referredCount = 0;
  if (referredUserIds && referredUserIds.length > 0) {
    const activeReferred = await Order.distinct('userId', {
      userId: { $in: referredUserIds },
      status: 'completed',
    });
    referredCount = activeReferred ? activeReferred.length : 0;
  }

  return { completedOrdersCount, referredCount };
};

/**
 * Проверяет все ачивки и выдаёт недостающие. Идемпотентная операция.
 *
 * @param {string} userId Mongo _id пользователя
 * @param {Object} opts
 * @param {boolean} [opts.silent] Если true - не шлём уведомления в Telegram.
 * @param {Object} [opts.settings] Переопределение настроек (для тестов).
 * @returns {Promise<Array<{achievement, bonusGranted, rewardGranted, promo, promoCode}>>} Список новых ачивок
 */
const checkAndGrantAchievements = async (userId, opts = {}) => {
  const { silent = false } = opts;

  const user = await User.findById(userId);
  if (!user) return [];

  const settings = opts.settings || await getCachedSettings();
  const achievementRewardsEnabled = settings?.achievementRewardsEnabled === true;

  const stats = await computeUserStats(userId);

  const unlockedCodes = new Set((user.achievements || []).map((a) => a.code));
  const newlyUnlocked = [];

  for (const ach of ACHIEVEMENTS) {
    if (unlockedCodes.has(ach.code)) continue;
    try {
      const ok = await ach.check(user, stats);
      if (ok) {
        const updateDoc = {
          $push: { achievements: { code: ach.code, unlockedAt: new Date() } },
        };
        // ВНИМАНИЕ: баланс пользователя сырыми USDT НИКОГДА не пополняется!
        const updated = await User.findOneAndUpdate(
          { _id: userId, 'achievements.code': { $ne: ach.code } },
          updateDoc,
          { new: true }
        );
        if (updated) {
          let promo = null;
          if (achievementRewardsEnabled && ach.rewardDiscount > 0) {
            try {
              let promoCodeStr = '';
              for (let i = 0; i < 5; i++) {
                const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
                const candidate = `ACH-${ach.code.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${suffix}`;
                const exists = await PromoCode.findOne({ code: candidate });
                if (!exists) {
                  promoCodeStr = candidate;
                  break;
                }
              }
              if (!promoCodeStr) {
                promoCodeStr = `ACH-${ach.code.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${Date.now().toString(36).toUpperCase()}`;
              }

              promo = await PromoCode.create({
                code: promoCodeStr,
                type: 'fixed',
                value: ach.rewardDiscount,
                minOrderAmount: ach.minOrderAmount || 0,
                maxActivations: 1,
                currentActivations: 0,
                maxPerUser: 1,
                isActive: true,
              });
            } catch (pErr) {
              logger.error(`[Achievements] PromoCode creation error for ${ach.code}: ${pErr.message}`);
            }
          }

          newlyUnlocked.push({
            achievement: ach,
            bonusGranted: false, // На баланс не начисляем
            rewardGranted: !!promo,
            promo: promo || null,
            promoCode: promo ? promo.code : null,
          });
          logger.info(`[Achievements] unlock user=${user.telegramId} code=${ach.code} promo=${promo?.code || 'none'}`);
        }
      }
    } catch (err) {
      logger.error(`[Achievements] check error for ${ach.code}: ${err.message}`);
    }
  }

  if (newlyUnlocked.length === 0) return [];

  // Уведомление пользователю - одно сообщение на все новые ачивки.
  if (!silent) {
    try {
      const notif = require('./notification.service');
      const lines = newlyUnlocked.map(({ achievement: a, promoCode }) => {
        const title = typeof a.title === 'object' ? (a.title.ru || a.title.en) : a.title;
        const desc = typeof a.description === 'object' ? (a.description.ru || a.description.en) : a.description;
        let line = `${a.icon} <b>${title}</b> - ${desc}`;
        if (promoCode) {
          const formattedReward = Number(a.rewardDiscount).toFixed(2);
          const formattedMin = Number(a.minOrderAmount).toFixed(0);
          line += `\n   🎁 <b>Купон:</b> <code>${promoCode}</code> (скидка $${formattedReward} от $${formattedMin})`;
        }
        return line;
      });

      const hasCoupons = newlyUnlocked.some((n) => n.promoCode);
      const text =
        `🏆 <b>Новое достижение${newlyUnlocked.length > 1 ? 'я' : ''}!</b>\n\n` +
        lines.join('\n\n') +
        (hasCoupons
          ? `\n\n<blockquote>🎟 <i>Используйте промокод при заказе для получения скидки!</i></blockquote>`
          : '');

      await notif.sendToUser(user.telegramId, text);
    } catch (err) {
      logger.warn(`[Achievements] notify failed: ${err.message}`);
    }
  }

  return newlyUnlocked;
};

/**
 * Возвращает полный список ачивок с информацией о разблокировке и прогрессе
 * для конкретного пользователя. Используется в UI профиля.
 */
const getAllWithProgress = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return [];

  const stats = await computeUserStats(userId);
  const unlockedMap = new Map();
  for (const a of (user.achievements || [])) {
    unlockedMap.set(a.code, a.unlockedAt);
  }

  const result = [];
  for (const ach of ACHIEVEMENTS) {
    const unlockedAt = unlockedMap.get(ach.code) || null;
    let progress = null;
    try {
      progress = await ach.progress(user, stats);
    } catch (_) {
      progress = { current: 0, target: 1 };
    }
    result.push({
      code: ach.code,
      title: ach.title,
      description: ach.description,
      icon: ach.icon,
      bonus: 0,
      rewardDiscount: ach.rewardDiscount,
      minOrderAmount: ach.minOrderAmount,
      unlocked: !!unlockedAt,
      unlockedAt,
      progress,
    });
  }

  return result;
};

/**
 * Хелпер: рендерит список ачивок в HTML для профиля.
 *
 * @param {Array} items Список ачивок с прогрессом
 * @param {string} [lang='ru'] Язык интерфейса
 * @param {Object|boolean} [options={}] Опции отображения или флаг achievementRewardsEnabled
 */
const renderAchievementsText = (items, lang = 'ru', options = {}) => {
  const t = (obj) => (typeof obj === 'object' ? (obj[lang] || obj.ru) : obj);

  let achievementRewardsEnabled = false;
  if (typeof options === 'boolean') {
    achievementRewardsEnabled = options;
  } else if (options && typeof options.achievementRewardsEnabled === 'boolean') {
    achievementRewardsEnabled = options.achievementRewardsEnabled;
  } else {
    try {
      const s = getCachedSettingsSync();
      if (s?.achievementRewardsEnabled === true) {
        achievementRewardsEnabled = true;
      }
    } catch (_) {}
  }

  const emptyTitle = lang === 'en' ? 'Achievements' : 'Достижения';
  if (!items.length) return `🏆 <b>${emptyTitle}</b>\n\n${lang === 'en' ? 'The list is empty.' : 'Список пуст.'}`;

  const unlocked = items.filter((a) => a.unlocked);
  const locked = items.filter((a) => !a.unlocked);

  const titleStr = lang === 'en' ? 'Achievements' : 'Достижения';
  const lines = [`🏆 <b>${titleStr}</b>  ·  ${unlocked.length}/${items.length}\n`];

  if (unlocked.length) {
    lines.push(lang === 'en' ? '<b>Unlocked:</b>' : '<b>Разблокировано:</b>');
    for (const a of unlocked) {
      lines.push(`  ${a.icon} ${t(a.title)}`);
    }
    lines.push('');
  }

  if (locked.length) {
    lines.push(lang === 'en' ? '<b>In progress:</b>' : '<b>В процессе:</b>');
    for (const a of locked) {
      const pct = Math.floor((a.progress.current / a.progress.target) * 100);
      const bar = '▓'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
      lines.push(`  🔒 <b>${t(a.title)}</b> - ${t(a.description)}`);
      lines.push(`     ${bar} ${pct}% (${Math.floor(a.progress.current)}/${a.progress.target})`);
      if (achievementRewardsEnabled) {
        const reward = a.rewardDiscount || a.bonus || 0;
        if (reward > 0) {
          const formattedReward = reward.toFixed(2);
          const formattedMin = a.minOrderAmount || 0;
          if (lang === 'en') {
            lines.push(`     🎁 Reward: coupon $${formattedReward} off orders >= $${formattedMin}`);
          } else {
            lines.push(`     🎁 Награда: купон $${formattedReward} от $${formattedMin}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
};

module.exports = {
  ACHIEVEMENTS,
  getCachedSettings,
  computeUserStats,
  checkAndGrantAchievements,
  getAllWithProgress,
  renderAchievementsText,
};

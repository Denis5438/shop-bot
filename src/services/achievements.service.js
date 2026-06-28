const logger = require('../config/logger');
const Order = require('../models/Order');
const User = require('../models/User');

/**
 * Сервис достижений (№20).
 *
 * Архитектура:
 *   - Описание ачивок статично в этом файле (см. ACHIEVEMENTS).
 *   - Прогресс пользователя считается on-the-fly из существующих данных
 *     (User.totalSpent, количество completed orders, кол-во рефералов).
 *   - Разблокировка записывается в User.achievements как { code, unlockedAt }.
 *   - Бонус (если есть) зачисляется в User.balance и пишется Transaction.
 *
 * Вызов `checkAndGrantAchievements(userId)` после значимых событий
 * (completed order, реферал, пополнение) идемпотентен: уже разблокированные
 * ачивки не перевыдаются.
 */

// ─── Описание всех ачивок ──────────────────────────────────────────────────
/**
 * @typedef {Object} Achievement
 * @property {string} code         Уникальный ID
 * @property {Object|string} title        Название
 * @property {Object|string} description  Что нужно сделать
 * @property {string} icon         Эмодзи
 * @property {number} bonus        USDT на баланс при разблокировке (0 = без бонуса)
 * @property {Function} check      async (user, stats) => boolean — условие выполнено
 * @property {Function} progress   async (user, stats) => {current,target} — для прогресс-бара
 */
const ACHIEVEMENTS = [
  {
    code: 'first_purchase',
    title: { ru: 'Первая покупка', en: 'First Purchase' },
    description: { ru: 'Совершите первую успешную покупку', en: 'Make your first successful purchase' },
    icon: '🎉',
    bonus: 0.2,
    check: (_user, stats) => stats.completedOrdersCount >= 1,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 1), target: 1 }),
  },
  {
    code: 'five_orders',
    title: { ru: 'Постоянный клиент', en: 'Regular Customer' },
    description: { ru: 'Совершите 5 успешных покупок', en: 'Make 5 successful purchases' },
    icon: '🛍️',
    bonus: 0.5,
    check: (_user, stats) => stats.completedOrdersCount >= 5,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 5), target: 5 }),
  },
  {
    code: 'ten_orders',
    title: { ru: 'Опытный покупатель', en: 'Experienced Buyer' },
    description: { ru: 'Совершите 10 успешных покупок', en: 'Make 10 successful purchases' },
    icon: '🏅',
    bonus: 1,
    check: (_user, stats) => stats.completedOrdersCount >= 10,
    progress: (_user, stats) => ({ current: Math.min(stats.completedOrdersCount, 10), target: 10 }),
  },
  {
    code: 'spent_20',
    title: { ru: 'Активный участник', en: 'Active Member' },
    description: { ru: 'Потратьте 20 USDT', en: 'Spend 20 USDT' },
    icon: '💸',
    bonus: 0.5,
    check: (user) => user.totalSpent >= 20,
    progress: (user) => ({ current: Math.min(user.totalSpent, 20), target: 20 }),
  },
  {
    code: 'spent_50',
    title: { ru: 'VIP-статус', en: 'VIP Status' },
    description: { ru: 'Потратьте 50 USDT', en: 'Spend 50 USDT' },
    icon: '💎',
    bonus: 2,
    check: (user) => user.totalSpent >= 50,
    progress: (user) => ({ current: Math.min(user.totalSpent, 50), target: 50 }),
  },
  {
    code: 'spent_100',
    title: { ru: 'Элита', en: 'Elite' },
    description: { ru: 'Потратьте 100 USDT', en: 'Spend 100 USDT' },
    icon: '👑',
    bonus: 5,
    check: (user) => user.totalSpent >= 100,
    progress: (user) => ({ current: Math.min(user.totalSpent, 100), target: 100 }),
  },
  {
    code: 'first_referral',
    title: { ru: 'Первый приглашённый', en: 'First Referral' },
    description: { ru: 'Пригласите первого друга', en: 'Invite your first friend' },
    icon: '🎁',
    bonus: 0.3,
    check: (_user, stats) => stats.referredCount >= 1,
    progress: (_user, stats) => ({ current: Math.min(stats.referredCount, 1), target: 1 }),
  },
  {
    code: 'five_referrals',
    title: 'Амбассадор',
    description: 'Пригласите 5 друзей',
    icon: '🤝',
    bonus: 2,
    check: (_user, stats) => stats.referredCount >= 5,
    progress: (_user, stats) => ({ current: Math.min(stats.referredCount, 5), target: 5 }),
  },
];

/**
 * Собирает статистику пользователя, необходимую для проверки всех ачивок.
 * Одним махом, чтобы не делать 10 запросов по каждой ачивке.
 */
const computeUserStats = async (userId) => {
  const [completedOrdersCount, referredCount] = await Promise.all([
    Order.countDocuments({ userId, status: 'completed' }),
    User.countDocuments({ referredBy: userId }),
  ]);
  return { completedOrdersCount, referredCount };
};

/**
 * Проверяет все ачивки и выдаёт недостающие. Идемпотентная операция.
 *
 * @param {string} userId Mongo _id пользователя
 * @param {Object} opts
 * @param {boolean} [opts.silent] Если true — не шлём уведомления в Telegram.
 *                                 Useful для массовых reconcile-операций.
 * @returns {Promise<Array<{achievement, bonusGranted}>>} Список новых ачивок
 */
const checkAndGrantAchievements = async (userId, opts = {}) => {
  const { silent = false } = opts;

  const user = await User.findById(userId);
  if (!user) return [];

  const stats = await computeUserStats(userId);

  const unlockedCodes = new Set((user.achievements || []).map((a) => a.code));
  const newlyUnlocked = [];

  for (const ach of ACHIEVEMENTS) {
    if (unlockedCodes.has(ach.code)) continue;
    try {
      const ok = await ach.check(user, stats);
      if (ok) {
        user.achievements.push({ code: ach.code, unlockedAt: new Date() });
        if (ach.bonus > 0) {
          user.balance = parseFloat((user.balance + ach.bonus).toFixed(8));
        }
        newlyUnlocked.push({ achievement: ach, bonusGranted: ach.bonus > 0 });
        logger.info(`[Achievements] unlock user=${user.telegramId} code=${ach.code} bonus=${ach.bonus}`);
      }
    } catch (err) {
      logger.error(`[Achievements] check error for ${ach.code}: ${err.message}`);
    }
  }

  if (newlyUnlocked.length === 0) return [];

  await user.save();

  // Пишем transactions для бонусов
  if (newlyUnlocked.some((n) => n.bonusGranted)) {
    const Transaction = require('../models/Transaction');
    for (const { achievement, bonusGranted } of newlyUnlocked) {
      if (!bonusGranted) continue;
      await new Transaction({
        userId: user._id,
        type: 'topup', // используем существующий enum
        amount: achievement.bonus,
        description: `🏆 Ачивка: ${achievement.title}`,
      }).save().catch((err) => logger.error(`[Achievements] tx save failed: ${err.message}`));
    }
  }

  // Уведомление пользователю — одно сообщение на все новые ачивки.
  if (!silent) {
    try {
      const notif = require('./notification.service');
      const lines = newlyUnlocked.map(({ achievement: a, bonusGranted }) =>
        `${a.icon} <b>${a.title}</b> — ${a.description}` +
        (bonusGranted ? `\n   💰 +${a.bonus} USDT на баланс` : '')
      );
      const totalBonus = newlyUnlocked
        .filter((n) => n.bonusGranted)
        .reduce((s, n) => s + n.achievement.bonus, 0);

      const text =
        `🏆 <b>Новое достижение${newlyUnlocked.length > 1 ? 'я' : ''}!</b>\n\n` +
        lines.join('\n\n') +
        (totalBonus > 0 ? `\n\n<blockquote>💰 Всего начислено: <b>+${totalBonus.toFixed(2)} USDT</b></blockquote>` : '');

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
      bonus: ach.bonus,
      unlocked: !!unlockedAt,
      unlockedAt,
      progress,
    });
  }

  return result;
};

/**
 * Хелпер: рендерит список ачивок в HTML для профиля.
 */
const renderAchievementsText = (items, lang = 'ru') => {
  const t = (obj) => (typeof obj === 'object' ? (obj[lang] || obj.ru) : obj);

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
      lines.push(`  🔒 <b>${t(a.title)}</b> — ${t(a.description)}`);
      lines.push(`     ${bar} ${pct}% (${Math.floor(a.progress.current)}/${a.progress.target})`);
      const rewardLabel = lang === 'en' ? 'Reward' : 'Награда';
      if (a.bonus > 0) lines.push(`     💰 ${rewardLabel}: +${a.bonus} USDT`);
    }
  }

  return lines.join('\n');
};

module.exports = {
  ACHIEVEMENTS,
  computeUserStats,
  checkAndGrantAchievements,
  getAllWithProgress,
  renderAchievementsText,
};

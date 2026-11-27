const { Markup } = require('telegraf');
const mongoose = require('mongoose');
const User = require('../../../models/User');
const Order = require('../../../models/Order');
const SupportTicket = require('../../../models/SupportTicket');
const Settings = require('../../../models/Settings');
const supportService = require('../../../services/support.service');
const supportNotify = require('../../../services/supportNotify.service');
const { getSettings, invalidateCache } = require('../../../services/settingsCache.service');
const { isAdminOrAbove, isModeratorOrAbove } = require('../../middlewares/auth');
const { escapeHtml, formatDateTimeMSK, formatDateMSK, safeEdit } = require('../../utils/ui');
const logger = require('../../../config/logger');

const ROLE_LABELS = {
  superadmin: '👑 Владелец',
  admin: '🔧 Администратор',
  moderator: '🛡 Модератор',
  support: '🎧 Саппорт',
  user: '👤 Пользователь',
};

const ROLE_ICONS = {
  superadmin: '👑',
  admin: '🔧',
  moderator: '🛡',
  support: '🎧',
  user: '👤',
};

const ROLE_CODE_MAP = {
  u: 'user',
  s: 'support',
  m: 'moderator',
  a: 'admin',
};

const DEFAULT_QUICK_REPLIES = [
  'Здравствуйте! Уже проверяю ваш вопрос, отвечу в течение нескольких минут.',
  'Уточните, пожалуйста, номер заказа или пришлите скриншот проблемы.',
  'Проблема решена! Проверьте, пожалуйста, и подтвердите, если всё в порядке.',
  'Передаю ваш вопрос старшему специалисту для детальной проверки.',
];

const TOPIC_ICONS = {
  order: '📦',
  payment: '💳',
  product: '🛍',
  general: '💬',
};

const STATUS_ICONS = {
  open: '🟡',
  in_progress: '🔵',
  escalated: '🔺',
  closed: '✅',
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatUserLabel = (user) => {
  if (!user) return 'Неизвестно';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const uname = user.username ? `@${String(user.username).replace(/^@+/, '')}` : '';
  if (name && uname) return `${name} (${uname})`;
  if (uname) return uname;
  if (name) return `${name} [${user.telegramId || ''}]`;
  return `ID ${user.telegramId || user._id || '?'}`;
};

const formatDurationSec = (sec) => {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '—';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m} мин ${rem} сек` : `${m} мин`;
};

const clearStaffAdminSession = (ctx) => {
  if (!ctx.session) return;
  ctx.session.staffAdminAction = null;
};

/**
 * Построение кнопок смены роли с учётом строгой RBAC-иерархии.
 * superadmin -> user | support | moderator | admin (для не-superadmin)
 * admin      -> user | support | moderator (для не-admin/не-superadmin)
 * moderator  -> ТОЛЬКО user <-> support
 */
const buildRoleActionButtons = (actorUser, targetUser) => {
  const actorRole = actorUser?.role;
  const targetRole = targetUser?.role;
  const targetId = String(targetUser._id);

  if (!actorUser || !targetUser || targetRole === 'superadmin') return [];
  if (String(actorUser._id) === targetId) return [];

  const rows = [];

  if (actorRole === 'superadmin') {
    const row = [];
    if (targetRole !== 'support') row.push(Markup.button.callback('🎧 Саппорт', `adm_sup:role:${targetId}:s`));
    if (targetRole !== 'moderator') row.push(Markup.button.callback('🛡 Модератор', `adm_sup:role:${targetId}:m`));
    if (targetRole !== 'admin') row.push(Markup.button.callback('🔧 Админ', `adm_sup:role:${targetId}:a`));
    if (row.length > 0) rows.push(row);
    if (targetRole !== 'user') {
      rows.push([Markup.button.callback('👤 Снять роль (Юзер)', `adm_sup:role:${targetId}:u`)]);
    }
    return rows;
  }

  if (actorRole === 'admin') {
    if (targetRole === 'admin') return [];
    const row = [];
    if (targetRole !== 'support') row.push(Markup.button.callback('🎧 Саппорт', `adm_sup:role:${targetId}:s`));
    if (targetRole !== 'moderator') row.push(Markup.button.callback('🛡 Модератор', `adm_sup:role:${targetId}:m`));
    if (row.length > 0) rows.push(row);
    if (targetRole !== 'user') {
      rows.push([Markup.button.callback('👤 Снять роль (Юзер)', `adm_sup:role:${targetId}:u`)]);
    }
    return rows;
  }

  if (actorRole === 'moderator') {
    if (targetRole === 'user') {
      rows.push([Markup.button.callback('🎧 Назначить саппортом', `adm_sup:role:${targetId}:s`)]);
    } else if (targetRole === 'support') {
      rows.push([Markup.button.callback('👤 Снять роль саппорта', `adm_sup:role:${targetId}:u`)]);
    }
    return rows;
  }

  return [];
};

// ─── 1. Главный хаб настроек и команды саппортов (adm_sup:hub) ──────────────
const showSupportHub = async (ctx) => {
  clearStaffAdminSession(ctx);

  const [counts, inProgressCount, onDutyCount, settings] = await Promise.all([
    supportService.getQueuesCounts(ctx.user._id),
    SupportTicket.countDocuments({ status: 'in_progress' }),
    User.countDocuments({
      role: { $in: ['support', 'moderator'] },
      isBanned: { $ne: true },
      supportOnDuty: { $ne: false },
    }),
    getSettings(),
  ]);

  const waitingCount = counts?.waiting ?? 0;
  const escalatedCount = counts?.escalated ?? 0;
  const totalQuestions = waitingCount + escalatedCount;

  const chatLine = settings?.supportChatId
    ? `💬 Чат: <b>${escapeHtml(settings.supportChatTitle || String(settings.supportChatId))}</b>`
    : '📩 Режим: <b>ЛС дежурным саппортам</b>';

  const text =
    `🎧 <b>Центр саппортов и модерации</b>\n\n` +
    `<blockquote>⏳ Ожидают: <b>${waitingCount}</b>\n` +
    `🔵 В работе: <b>${inProgressCount}</b>\n` +
    `🔺 Эскалированы: <b>${escalatedCount}</b>\n` +
    `🟢 На смене: <b>${onDutyCount}</b>\n` +
    `${chatLine}</blockquote>`;

  const defaultQueueTab = escalatedCount > 0 ? 'esc' : 'waiting';

  const buttons = [
    [Markup.button.callback(`💬 Вопросы саппортов (${totalQuestions})`, `adm_sup:q:${defaultQueueTab}:1`)],
    [Markup.button.callback('👥 Команда и активность', 'adm_sup:team:1')],
    [Markup.button.callback('💬 Чат саппортов', 'adm_sup:chat')],
    [Markup.button.callback('⚙️ Параметры и шаблоны', 'adm_sup:cfg')],
    [Markup.button.callback('⬅️ В панель', 'admin:main')],
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// ─── 2. Очередь всех вопросов и эскалаций (adm_sup:q:<tab>:<page>) ──────────
const showAdminTicketsQueue = async (ctx, tab = 'esc', page = 1) => {
  clearStaffAdminSession(ctx);

  const safeTab = ['all', 'waiting', 'esc', 'closed'].includes(tab) ? tab : 'esc';
  const serviceTab = safeTab === 'esc' ? 'escalated' : safeTab;
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  let [queueRes, counts] = await Promise.all([
    supportService.getQueue({ tab: serviceTab, staffUserId: ctx.user._id, page: safePage, limit: 8 }),
    supportService.getQueuesCounts(ctx.user._id),
  ]);

  let items = queueRes?.items || queueRes?.tickets || [];
  const total = queueRes?.total ?? items.length;
  const totalPages = Math.max(1, queueRes?.totalPages || Math.ceil(total / 8));
  const curPage = Math.min(safePage, totalPages);
  if (safePage > totalPages && total > 0) {
    queueRes = await supportService.getQueue({ tab: serviceTab, staffUserId: ctx.user._id, page: curPage, limit: 8 });
    items = queueRes?.items || queueRes?.tickets || [];
  }

  const tabTitles = {
    esc: '🔺 Эскалированные тикеты',
    waiting: '⏳ Ожидают ответа',
    all: '📋 Все активные обращения',
    closed: '✅ Закрытые обращения',
  };

  let text =
    `${tabTitles[safeTab]} (<b>${total}</b>)\n` +
    `<i>Стр. ${curPage}/${totalPages}. Нажмите на обращение для просмотра и ответа:</i>\n\n`;

  if (items.length === 0) {
    text += '<i>В этой категории пока пусто.</i>';
  } else {
    for (const t of items) {
      const sIcon = STATUS_ICONS[t.status] || '💬';
      const tIcon = TOPIC_ICONS[t.topic] || '💬';
      const prio = t.priority === 'high' ? ' 🔥' : '';
      const topicShort = escapeHtml((t.topicLabel || t.topic || 'Вопрос').slice(0, 28));
      const assignee = t.assignedTo
        ? ` → ${escapeHtml(formatUserLabel(t.assignedTo))}`
        : '';
      text += `${sIcon} <b>#${escapeHtml(t.ticketNumber)}</b>${prio} ${tIcon} ${topicShort}${assignee}\n`;
    }
  }

  const buttons = [
    [
      Markup.button.callback(
        `${safeTab === 'esc' ? '• ' : ''}🔺 Эск. (${counts?.escalated ?? 0})`,
        'adm_sup:q:esc:1'
      ),
      Markup.button.callback(
        `${safeTab === 'waiting' ? '• ' : ''}⏳ Ждут (${counts?.waiting ?? 0})`,
        'adm_sup:q:waiting:1'
      ),
    ],
    [
      Markup.button.callback(
        `${safeTab === 'all' ? '• ' : ''}📋 Все`,
        'adm_sup:q:all:1'
      ),
      Markup.button.callback(
        `${safeTab === 'closed' ? '• ' : ''}✅ Закрытые`,
        'adm_sup:q:closed:1'
      ),
    ],
  ];

  for (const t of items) {
    const sIcon = STATUS_ICONS[t.status] || '💬';
    const label = `${sIcon} #${t.ticketNumber} · ${(t.topicLabel || t.topic || 'Тикет').slice(0, 24)}`;
    buttons.push([Markup.button.callback(label, `sp:v:${t._id}`)]);
  }

  const navRow = [];
  if (curPage > 1) navRow.push(Markup.button.callback('⬅️', `adm_sup:q:${safeTab}:${curPage - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${curPage}/${totalPages}`, 'adm_sup:noop'));
  if (curPage < totalPages) navRow.push(Markup.button.callback('➡️', `adm_sup:q:${safeTab}:${curPage + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([Markup.button.callback('⬅️ В центр саппортов', 'adm_sup:hub')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// ─── 3. Команда и активность (adm_sup:team:<page>) ───────────────────────────
const showTeamList = async (ctx, page = 1) => {
  clearStaffAdminSession(ctx);

  const team = (await supportService.getStaffTeamList()) || [];
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(team.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const slice = team.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const onDuty = team.filter((u) => u.supportOnDuty !== false && !u.isBanned).length;
  let text =
    `👥 <b>Команда поддержки и администраторы</b> (${team.length})\n` +
    `<blockquote>🟢 На смене сейчас: <b>${onDuty}</b></blockquote>\n\n`;

  if (slice.length === 0) {
    text += '<i>Сотрудники не найдены.</i>';
  } else {
    text += '<i>Выберите сотрудника для просмотра статистики и управления ролью:</i>';
  }

  const buttons = [];
  for (const member of slice) {
    const rIcon = ROLE_ICONS[member.role] || '👤';
    const dIcon = member.supportOnDuty !== false ? '🟢' : '🔴';
    const name = formatUserLabel(member).replace(/[\r\n\t]+/g, ' ').slice(0, 26);
    buttons.push([
      Markup.button.callback(`${rIcon}${dIcon} ${name}`, `adm_sup:st:${member._id}:30d`),
    ]);
  }

  const navRow = [];
  if (safePage > 1) navRow.push(Markup.button.callback('⬅️', `adm_sup:team:${safePage - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${safePage}/${totalPages}`, 'adm_sup:noop'));
  if (safePage < totalPages) navRow.push(Markup.button.callback('➡️', `adm_sup:team:${safePage + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    Markup.button.callback('➕ Назначить сотрудника', 'adm_sup:add'),
    Markup.button.callback('📜 Лог ролей', 'adm_sup:log:1'),
  ]);
  buttons.push([Markup.button.callback('⬅️ В центр саппортов', 'adm_sup:hub')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// ─── 4. Статистика сотрудника и управление ролью (adm_sup:st:<id>:<period>) ───
const showStaffStats = async (ctx, targetUserId, period = '30d') => {
  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('❌ Сотрудник не найден', { show_alert: true }).catch(() => {});
    return;
  }

  const validPeriod = ['today', '7d', '30d', 'all'].includes(period) ? period : '30d';
  const [targetUser, stats] = await Promise.all([
    User.findById(targetUserId).lean(),
    supportService.getStaffActivityStats(targetUserId, validPeriod),
  ]);

  if (!targetUser) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('❌ Пользователь не найден', { show_alert: true }).catch(() => {});
    return;
  }

  const periodLabels = {
    today: 'Сегодня',
    '7d': '7 дней',
    '30d': '30 дней',
    all: 'Всё время',
  };

  const roleText = ROLE_LABELS[targetUser.role] || '👤 Пользователь';
  const dutyText = targetUser.supportOnDuty !== false ? '🟢 На смене' : '🔴 Оффлайн';
  const lastActive = stats?.lastActiveAt || targetUser.supportLastActiveAt
    ? formatDateTimeMSK(stats?.lastActiveAt || targetUser.supportLastActiveAt)
    : 'ещё нет активности';
  const ratingStr = stats?.ratedCount > 0 && stats?.avgRating != null
    ? `⭐ ${Number(stats.avgRating).toFixed(2)} (${stats.ratedCount} оц.)`
    : '—';

  const text =
    `📊 <b>Статистика сотрудника</b>\n\n` +
    `👤 <b>${escapeHtml(formatUserLabel(targetUser))}</b>\n` +
    `🆔 TG ID: <code>${targetUser.telegramId}</code>\n` +
    `🔘 Роль: ${roleText}\n` +
    `📡 Смена: ${dutyText}\n` +
    `🕒 Активность: <i>${escapeHtml(lastActive)}</i>\n\n` +
    `<b>Показатели за: ${periodLabels[validPeriod]}</b>\n` +
    `<blockquote>✋ Взято тикетов: <b>${stats?.takenCount ?? 0}</b>\n` +
    `✅ Закрыто тикетов: <b>${stats?.closedCount ?? 0}</b>\n` +
    `💬 Отправлено ответов: <b>${stats?.repliesCount ?? 0}</b>\n` +
    `⏱ Ср. время 1-го ответа: <b>${formatDurationSec(stats?.avgFirstResponseSec)}</b>\n` +
    `⭐ Средний рейтинг: <b>${ratingStr}</b>\n` +
    `🔺 Передано на эскалацию: <b>${stats?.escalatedFromCount ?? 0}</b></blockquote>`;

  const id = String(targetUser._id);
  const periodRow = [
    Markup.button.callback(`${validPeriod === 'today' ? '• ' : ''}Сегодня`, `adm_sup:st:${id}:today`),
    Markup.button.callback(`${validPeriod === '7d' ? '• ' : ''}7д`, `adm_sup:st:${id}:7d`),
    Markup.button.callback(`${validPeriod === '30d' ? '• ' : ''}30д`, `adm_sup:st:${id}:30d`),
    Markup.button.callback(`${validPeriod === 'all' ? '• ' : ''}Всё`, `adm_sup:st:${id}:all`),
  ];

  const roleRows = buildRoleActionButtons(ctx.user, targetUser);
  const buttons = [
    periodRow,
    ...roleRows,
    [Markup.button.callback('⬅️ К команде', 'adm_sup:team:1')],
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// ─── 5. Смена роли сотрудника по строгой RBAC-матрице (adm_sup:role:<id>:<code>) ─
const changeStaffRole = async (ctx, targetUserId, roleCode) => {
  const newRole = ROLE_CODE_MAP[roleCode];
  if (!newRole || !mongoose.Types.ObjectId.isValid(targetUserId)) {
    return ctx.answerCbQuery('❌ Некорректные параметры', { show_alert: true }).catch(() => {});
  }

  // Дополнительный барьер на уровне UI-хендлера: модератор может только user <-> support
  if (ctx.user?.role === 'moderator' && newRole !== 'support' && newRole !== 'user') {
    return ctx.answerCbQuery('🚫 Модератор может назначать или снимать только роль Саппорта', { show_alert: true }).catch(() => {});
  }

  const targetUser = await User.findById(targetUserId);
  if (!targetUser) {
    return ctx.answerCbQuery('❌ Пользователь не найден', { show_alert: true }).catch(() => {});
  }

  const oldRole = targetUser.role;
  const res = await supportService.assignStaffRole({
    actorUser: ctx.user,
    targetUser,
    newRole,
    reason: 'Панель управления саппортами',
  });

  if (!res || !res.ok) {
    const errMsg = res?.error === 'CANNOT_ESCALATE_ROLE'
      ? '🚫 Недостаточно прав для назначения/снятия этой роли'
      : `❌ ${res?.reason || res?.error || 'Не удалось изменить роль'}`;
    return ctx.answerCbQuery(errMsg, { show_alert: true }).catch(() => {});
  }

  if (res.changed !== false) {
    await supportNotify.notifyOwnerRoleChange({
      actorUser: ctx.user,
      targetUser,
      oldRole: res.oldRole || oldRole,
      newRole,
    }).catch((err) => {
      logger.warn(`[support_admin] notifyOwnerRoleChange error: ${err.message}`);
    });

    if (targetUser.telegramId) {
      const roleName = ROLE_LABELS[newRole] || newRole;
      ctx.telegram.sendMessage(
        targetUser.telegramId,
        `🔔 <b>Ваша роль в системе обновлена</b>\n\nТекущая роль: <b>${escapeHtml(roleName)}</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }

  await ctx.answerCbQuery(`✅ Роль изменена: ${ROLE_LABELS[newRole] || newRole}`, { show_alert: true }).catch(() => {});
  await showStaffStats(ctx, targetUserId, '30d');
};

// ─── 6. Назначение нового сотрудника (adm_sup:add) ───────────────────────────
const startAddStaff = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.staffAdminAction = 'add_staff_user';

  const hint = ctx.user?.role === 'moderator'
    ? 'Вы можете назначить или снять роль <b>🎧 Саппорт</b>.'
    : 'После поиска вы сможете выбрать подходящую роль по иерархии доступа.';

  const text =
    `➕ <b>Назначение сотрудника</b>\n\n` +
    `Отправьте <code>@username</code> или числовой <code>Telegram ID</code> пользователя (он должен хотя бы раз запустить бота).\n\n` +
    `<i>${hint}</i>`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:team:1')]]),
  });
};

// ─── 7. Лог изменений ролей (adm_sup:log:<page>) ─────────────────────────────
const showAuditLogs = async (ctx, page = 1) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  let res = await supportService.getStaffAuditLogs(safePage, 10);
  let items = res?.items || res?.logs || [];
  const total = res?.total ?? items.length;
  const totalPages = Math.max(1, res?.totalPages || Math.ceil(total / 10));
  const curPage = Math.min(safePage, totalPages);
  if (safePage > totalPages && total > 0) {
    res = await supportService.getStaffAuditLogs(curPage, 10);
    items = res?.items || res?.logs || [];
  }

  let text = `📜 <b>Лог изменений ролей</b> (стр. ${curPage}/${totalPages})\n\n`;
  if (items.length === 0) {
    text += '<i>Записей пока нет.</i>';
  } else {
    for (const log of items) {
      const targetStr = log.targetUserId
        ? formatUserLabel(log.targetUserId)
        : `ID ${log.targetTelegramId || '?'}`;
      const actorStr = log.actorUserId
        ? formatUserLabel(log.actorUserId)
        : `ID ${log.actorTelegramId || '?'}`;
      const dt = log.createdAt ? formatDateTimeMSK(log.createdAt) : '';
      text +=
        `• <b>${escapeHtml(targetStr)}</b>: ` +
        `${escapeHtml(log.oldRole || '?')} → <b>${escapeHtml(log.newRole || '?')}</b>\n` +
        `  <i>Кто: ${escapeHtml(actorStr)} | ${escapeHtml(dt)}</i>\n`;
    }
  }

  const buttons = [];
  const navRow = [];
  if (curPage > 1) navRow.push(Markup.button.callback('⬅️', `adm_sup:log:${curPage - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${curPage}/${totalPages}`, 'adm_sup:noop'));
  if (curPage < totalPages) navRow.push(Markup.button.callback('➡️', `adm_sup:log:${curPage + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([Markup.button.callback('⬅️ К команде', 'adm_sup:team:1')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

// ─── 8. Чат саппортов (adm_sup:chat) ─────────────────────────────────────────
const showSupportChatSettings = async (ctx) => {
  clearStaffAdminSession(ctx);
  const settings = await getSettings();
  const isAdmin = isAdminOrAbove(ctx.user);

  const statusBlock = settings?.supportChatId
    ? `✅ <b>Чат подключён:</b> ${escapeHtml(settings.supportChatTitle || 'Группа саппортов')}\n🆔 Chat ID: <code>${settings.supportChatId}</code>`
    : `📩 <b>Режим уведомлений в ЛС</b>\nОбщий групповой чат не подключён. Карточки новых тикетов отправляются дежурным саппортам в личные сообщения.`;

  const text =
    `💬 <b>Чат саппортов</b>\n\n` +
    `${statusBlock}\n\n` +
    `<blockquote><b>Как подключить группу:</b>\n` +
    `1. Добавьте бота в Telegram-группу саппортов (дайте право читать и отправлять сообщения).\n` +
    `2. Отправьте в этой группе команду <code>/set_support_chat</code> (от имени администратора).</blockquote>`;

  const buttons = [];
  if (isAdmin) {
    buttons.push([Markup.button.callback('✏️ Ввести ID чата вручную', 'adm_sup:chat_id')]);
    if (settings?.supportChatId) {
      buttons.push([Markup.button.callback('🔌 Отключить чат (перейти на ЛС)', 'adm_sup:chat_off')]);
    }
  }
  buttons.push([Markup.button.callback('⬅️ В центр саппортов', 'adm_sup:hub')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const disableSupportChat = async (ctx) => {
  if (!isAdminOrAbove(ctx.user)) {
    return ctx.answerCbQuery('🚫 Доступно только администратору', { show_alert: true }).catch(() => {});
  }
  const updated = await Settings.findOneAndUpdate(
    { name: 'global' },
    { $set: { supportChatId: null, supportChatTitle: '' } },
    { new: true, upsert: true }
  );
  invalidateCache(updated);
  await ctx.answerCbQuery('✅ Чат отключён, включён режим ЛС', { show_alert: true }).catch(() => {});
  await showSupportChatSettings(ctx);
};

const startSetChatId = async (ctx) => {
  if (!isAdminOrAbove(ctx.user)) {
    return ctx.answerCbQuery('🚫 Доступно только администратору', { show_alert: true }).catch(() => {});
  }
  ctx.session = ctx.session || {};
  ctx.session.staffAdminAction = 'set_support_chat_id';

  const text =
    `✏️ <b>Ручной ввод ID чата саппортов</b>\n\n` +
    `Отправьте числовой ID группы или супергруппы (обычно начинается с <code>-100...</code>, например: <code>-1001234567890</code>):`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:chat')]]),
  });
};

// ─── 9. Параметры SLA и быстрые шаблоны (adm_sup:cfg) ───────────────────────
const showSupportSettings = async (ctx) => {
  clearStaffAdminSession(ctx);
  const settings = await getSettings();
  const isAdmin = isAdminOrAbove(ctx.user);

  const slaMin = settings?.supportSlaMinutes ?? 15;
  const maxOpen = settings?.supportMaxOpenPerUser ?? 3;
  const autoCloseHours = settings?.supportAutoCloseHours ?? 48;
  const quickReplies = Array.isArray(settings?.supportQuickReplies)
    ? settings.supportQuickReplies
    : DEFAULT_QUICK_REPLIES;

  let tplLines = '';
  if (quickReplies.length === 0) {
    tplLines = '<i>Шаблонов пока нет.</i>';
  } else {
    tplLines = quickReplies
      .map((tpl, idx) => `${idx + 1}. ${escapeHtml(String(tpl).slice(0, 120))}`)
      .join('\n');
  }

  const text =
    `⚙️ <b>Параметры поддержки и шаблоны</b>\n\n` +
    `<blockquote>⏱ Напоминание SLA: <b>${slaMin} мин.</b>\n` +
    `🎫 Макс. открытых тикетов на юзера: <b>${maxOpen}</b>\n` +
    `🕒 Авто-закрытие неактивных: <b>${autoCloseHours} ч.</b></blockquote>\n\n` +
    `⚡ <b>Быстрые шаблоны ответов (${quickReplies.length}):</b>\n${tplLines}`;

  const buttons = [];
  if (isAdmin) {
    buttons.push([
      Markup.button.callback(`⏱ SLA (${slaMin}м)`, 'adm_sup:cfg:sla'),
      Markup.button.callback(`🎫 Лимит (${maxOpen})`, 'adm_sup:cfg:max'),
      Markup.button.callback(`🕒 Авто (${autoCloseHours}ч)`, 'adm_sup:cfg:auto'),
    ]);
    buttons.push([
      Markup.button.callback('➕ Добавить шаблон', 'adm_sup:cfg:tpl_add'),
      Markup.button.callback('🔄 Сбросить шаблоны', 'adm_sup:cfg:tpl_reset'),
    ]);
    if (quickReplies.length > 0) {
      for (let i = 0; i < quickReplies.length; i += 2) {
        const row = [Markup.button.callback(`🗑 Удал. #${i + 1}`, `adm_sup:tpl_del:${i}`)];
        if (i + 1 < quickReplies.length) {
          row.push(Markup.button.callback(`🗑 Удал. #${i + 2}`, `adm_sup:tpl_del:${i + 1}`));
        }
        buttons.push(row);
      }
    }
  }
  buttons.push([Markup.button.callback('⬅️ В центр саппортов', 'adm_sup:hub')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const startCfgEdit = async (ctx, field) => {
  if (!isAdminOrAbove(ctx.user)) {
    return ctx.answerCbQuery('🚫 Доступно только администратору', { show_alert: true }).catch(() => {});
  }
  ctx.session = ctx.session || {};

  const prompts = {
    sla: {
      action: 'set_sla_minutes',
      text: '⏱ <b>Время SLA-напоминания (в минутах)</b>\n\nВведите целое число от <code>1</code> до <code>1440</code> (например: <code>15</code>):',
    },
    max: {
      action: 'set_max_open',
      text: '🎫 <b>Лимит открытых тикетов на одного пользователя</b>\n\nВведите целое число от <code>1</code> до <code>20</code> (например: <code>3</code>):',
    },
    auto: {
      action: 'set_auto_close',
      text: '🕒 <b>Авто-закрытие неактивных тикетов (в часах)</b>\n\nВведите целое число от <code>1</code> до <code>720</code> (например: <code>48</code>):',
    },
    tpl_add: {
      action: 'add_quick_reply',
      text: '➕ <b>Новый быстрый шаблон ответа</b>\n\nОтправьте текст шаблона (до 500 символов):',
    },
  };

  if (field === 'tpl_reset') {
    const schemaDefault = Settings.schema?.path('supportQuickReplies')?.defaultValue;
    const defaults = Array.isArray(schemaDefault) && schemaDefault.length > 0
      ? [...schemaDefault]
      : [...DEFAULT_QUICK_REPLIES];
    const updated = await Settings.findOneAndUpdate(
      { name: 'global' },
      { $set: { supportQuickReplies: defaults } },
      { new: true, upsert: true }
    );
    invalidateCache(updated);
    await ctx.answerCbQuery('✅ Шаблоны сброшены по умолчанию', { show_alert: true }).catch(() => {});
    return showSupportSettings(ctx);
  }

  const cfg = prompts[field];
  if (!cfg) return ctx.answerCbQuery('❌ Неизвестный параметр', { show_alert: true }).catch(() => {});

  ctx.session.staffAdminAction = cfg.action;
  await safeEdit(ctx, cfg.text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:cfg')]]),
  });
};

const deleteQuickReply = async (ctx, idx) => {
  if (!isAdminOrAbove(ctx.user)) {
    return ctx.answerCbQuery('🚫 Доступно только администратору', { show_alert: true }).catch(() => {});
  }
  const index = parseInt(idx, 10);
  const settingsDoc = await Settings.findOne({ name: 'global' });
  const list = Array.isArray(settingsDoc?.supportQuickReplies)
    ? [...settingsDoc.supportQuickReplies]
    : [...DEFAULT_QUICK_REPLIES];

  if (Number.isNaN(index) || index < 0 || index >= list.length) {
    return ctx.answerCbQuery('❌ Шаблон не найден', { show_alert: true }).catch(() => {});
  }

  list.splice(index, 1);
  const updated = await Settings.findOneAndUpdate(
    { name: 'global' },
    { $set: { supportQuickReplies: list } },
    { new: true, upsert: true }
  );
  invalidateCache(updated);
  await ctx.answerCbQuery('🗑 Шаблон удалён').catch(() => {});
  await showSupportSettings(ctx);
};

// ─── 10. Безопасный поиск юзера / заказа / тикета для модератора (adm_sup:find) ─
const startModSearch = async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.staffAdminAction = 'mod_find_user_order';

  const text =
    `🔍 <b>Поиск пользователя, заказа или тикета</b>\n\n` +
    `Отправьте:\n` +
    `• Номер тикета (например: <code>SUP-1042</code>)\n` +
    `• <code>@username</code> или <code>Telegram ID</code> пользователя\n` +
    `• <code>ID заказа</code> (24 символа)`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin:main')]]),
  });
};

const renderSafeModUserCard = async (ctx, user) => {
  const [ordersCount, recentTickets, recentOrders] = await Promise.all([
    Order.countDocuments({ userId: user._id }),
    SupportTicket.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5).lean(),
    Order.find({ userId: user._id }).sort({ createdAt: -1 }).limit(3).populate('productId', 'name icon').lean(),
  ]);

  let text =
    `👤 <b>Карточка пользователя</b>\n\n` +
    `🆔 TG ID: <code>${user.telegramId}</code>\n` +
    `📛 Имя: ${escapeHtml(formatUserLabel(user))}\n` +
    `🔘 Роль: ${ROLE_LABELS[user.role] || '👤 Пользователь'}\n` +
    `🚫 Бан: ${user.isBanned ? 'Да' : 'Нет'}\n` +
    `📦 Заказов: <b>${ordersCount}</b>\n` +
    `📅 Регистрация: ${user.createdAt ? formatDateMSK(user.createdAt) : '—'}\n`;

  if (recentOrders.length > 0) {
    text += `\n<b>Последние заказы:</b>\n`;
    for (const o of recentOrders) {
      const pName = escapeHtml(o.productId?.name || 'Товар');
      text += `• <code>${o._id}</code> — ${pName} (${escapeHtml(o.status)})\n`;
    }
  }

  const buttons = [];
  for (const t of recentTickets) {
    const sIcon = STATUS_ICONS[t.status] || '💬';
    buttons.push([
      Markup.button.callback(`${sIcon} #${t.ticketNumber} · ${(t.topicLabel || t.topic || 'Тикет').slice(0, 24)}`, `sp:v:${t._id}`),
    ]);
  }

  const roleRows = buildRoleActionButtons(ctx.user, user);
  buttons.push(...roleRows);
  buttons.push([Markup.button.callback('🔍 Искать ещё', 'adm_sup:find')]);
  buttons.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
};

const showSafeUserCard = async (ctx, userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return ctx.answerCbQuery('❌ Пользователь не найден', { show_alert: true }).catch(() => {});
  }
  const user = await User.findById(userId).lean();
  if (!user) {
    return ctx.answerCbQuery('❌ Пользователь не найден', { show_alert: true }).catch(() => {});
  }
  await renderSafeModUserCard(ctx, user);
};

// ─── 11. Обработка текстовых вводов для админ/модер-панели саппортов ─────────
const handleSupportAdminInput = async (ctx) => {
  if (ctx.chat?.type !== 'private') return false;
  if (!isModeratorOrAbove(ctx.user)) return false;

  const action = ctx.session?.staffAdminAction;
  if (!action) return false;

  const rawText = (ctx.message?.text || '').trim();
  if (!rawText) {
    await ctx.reply('❌ Пожалуйста, отправьте текстовое сообщение.');
    return true;
  }

  // Назначение сотрудника (доступно moderator+)
  if (action === 'add_staff_user') {
    ctx.session.staffAdminAction = null;
    const query = rawText.replace(/^@+/, '').trim();
    let targetUser = null;

    if (mongoose.Types.ObjectId.isValid(query)) {
      targetUser = await User.findById(query).lean();
    }
    if (!targetUser && /^\d+$/.test(query)) {
      targetUser = await User.findOne({ telegramId: parseInt(query, 10) }).lean();
    }
    if (!targetUser && query) {
      targetUser = await User.findOne({ username: { $regex: new RegExp(`^${escapeRegExp(query)}$`, 'i') } }).lean();
    }

    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден в базе. Убедитесь, что он запускал бота.', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Попробовать снова', 'adm_sup:add')],
          [Markup.button.callback('⬅️ К команде', 'adm_sup:team:1')],
        ]),
      });
      return true;
    }

    const roleRows = buildRoleActionButtons(ctx.user, targetUser);
    if (roleRows.length === 0) {
      await ctx.reply(
        `ℹ️ Пользователь <b>${escapeHtml(formatUserLabel(targetUser))}</b> сейчас имеет роль <b>${ROLE_LABELS[targetUser.role] || targetUser.role}</b>.\n` +
        `У вас нет прав для изменения этой роли.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ К команде', 'adm_sup:team:1')]]),
        }
      );
      return true;
    }

    await ctx.reply(
      `👤 Найден пользователь: <b>${escapeHtml(formatUserLabel(targetUser))}</b>\n` +
      `🆔 TG ID: <code>${targetUser.telegramId}</code>\n` +
      `🔘 Текущая роль: <b>${ROLE_LABELS[targetUser.role] || targetUser.role}</b>\n\n` +
      `Выберите действие:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          ...roleRows,
          [Markup.button.callback('⬅️ К команде', 'adm_sup:team:1')],
        ]),
      }
    );
    return true;
  }

  // Безопасный поиск юзера / заказа / тикета для модератора
  if (action === 'mod_find_user_order') {
    ctx.session.staffAdminAction = null;
    const query = rawText.replace(/^[@#]+/, '').trim();

    if (/^SUP-/i.test(query)) {
      const ticket = await SupportTicket.findOne({ ticketNumber: query.toUpperCase() }).lean();
      if (ticket) {
        const supportPanelScene = require('../support_panel.scene');
        await supportPanelScene.showTicketForStaff(ctx, String(ticket._id));
        return true;
      }
    }

    if (mongoose.Types.ObjectId.isValid(query)) {
      const ticketById = await SupportTicket.findById(query).lean();
      if (ticketById) {
        const supportPanelScene = require('../support_panel.scene');
        await supportPanelScene.showTicketForStaff(ctx, String(ticketById._id));
        return true;
      }

      const order = await Order.findById(query).populate('productId', 'name icon').populate('userId', 'telegramId username firstName role').lean();
      if (order) {
        const buyerLabel = order.userId ? formatUserLabel(order.userId) : `ID ${order.telegramId || '?'}`;
        const text =
          `📦 <b>Информация о заказе</b>\n\n` +
          `🆔 ID: <code>${order._id}</code>\n` +
          `🛍 Товар: <b>${escapeHtml(order.productId?.name || 'Товар')}</b>\n` +
          `👤 Покупатель: ${escapeHtml(buyerLabel)}\n` +
          `📌 Статус: <b>${escapeHtml(order.status)}</b>\n` +
          `🛡 Гарантия: <b>${order.warrantyDays ?? 0} дн.</b>\n` +
          `📅 Создан: ${order.createdAt ? formatDateTimeMSK(order.createdAt) : '—'}`;
        const btns = [];
        if (order.userId?._id) {
          const isStaffBuyer = ['support', 'moderator', 'admin', 'superadmin'].includes(order.userId.role);
          btns.push([
            isStaffBuyer
              ? Markup.button.callback('📊 Статистика сотрудника', `adm_sup:st:${order.userId._id}:30d`)
              : Markup.button.callback('👤 Карточка покупателя', `adm_sup:u:${order.userId._id}`),
          ]);
        }
        btns.push([Markup.button.callback('🔍 Искать ещё', 'adm_sup:find')]);
        btns.push([Markup.button.callback('⬅️ В панель', 'admin:main')]);
        await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(btns) });
        return true;
      }

      const userById = await User.findById(query).lean();
      if (userById) {
        await renderSafeModUserCard(ctx, userById);
        return true;
      }
    }

    let user = null;
    if (/^\d+$/.test(query)) {
      user = await User.findOne({ telegramId: parseInt(query, 10) }).lean();
    }
    if (!user && query) {
      user = await User.findOne({ username: { $regex: new RegExp(`^${escapeRegExp(query)}$`, 'i') } }).lean();
    }

    if (user) {
      await renderSafeModUserCard(ctx, user);
      return true;
    }

    await ctx.reply('❌ Ничего не найдено. Проверьте номер тикета (SUP-...), ID заказа, Telegram ID или @username.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Искать снова', 'adm_sup:find')],
        [Markup.button.callback('⬅️ В панель', 'admin:main')],
      ]),
    });
    return true;
  }

  // Настройки чата и SLA доступны СТРОГО admin+
  if (!isAdminOrAbove(ctx.user)) {
    ctx.session.staffAdminAction = null;
    await ctx.reply('🚫 Изменение настроек доступно только администратору.');
    return true;
  }

  if (action === 'set_support_chat_id') {
    const chatId = Number(rawText);
    if (!Number.isInteger(chatId) || chatId >= 0) {
      await ctx.reply('❌ Введите корректный отрицательный числовой ID группы или супергруппы (например: <code>-1001234567890</code>):', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:chat')]]),
      });
      return true;
    }

    let chatInfo;
    try {
      chatInfo = await ctx.telegram.getChat(chatId);
    } catch (err) {
      await ctx.reply(
        `❌ Не удалось получить доступ к чату <code>${chatId}</code> (${escapeHtml(err.message || 'ошибка Telegram')}).\n` +
        `Убедитесь, что бот добавлен в группу и ID указан верно.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:chat')]]),
        }
      );
      return true;
    }

    if (!['group', 'supergroup'].includes(chatInfo?.type)) {
      await ctx.reply('❌ Указанный чат не является группой или супергруппой.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:chat')]]),
      });
      return true;
    }

    const chatTitle = chatInfo.title || `Чат ${chatId}`;
    ctx.session.staffAdminAction = null;
    const updated = await Settings.findOneAndUpdate(
      { name: 'global' },
      { $set: { supportChatId: chatId, supportChatTitle: chatTitle } },
      { new: true, upsert: true }
    );
    invalidateCache(updated);
    await ctx.reply(`✅ Чат саппортов сохранён: <b>${escapeHtml(chatTitle)}</b> (<code>${chatId}</code>)`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('💬 К настройкам чата', 'adm_sup:chat')]]),
    });
    return true;
  }

  if (action === 'set_sla_minutes' || action === 'set_max_open' || action === 'set_auto_close') {
    const limits = {
      set_sla_minutes: { field: 'supportSlaMinutes', min: 1, max: 1440, label: 'SLA (мин.)' },
      set_max_open: { field: 'supportMaxOpenPerUser', min: 1, max: 20, label: 'Лимит открытых тикетов' },
      set_auto_close: { field: 'supportAutoCloseHours', min: 1, max: 720, label: 'Авто-закрытие (ч.)' },
    };
    const spec = limits[action];
    const val = parseInt(rawText, 10);
    if (Number.isNaN(val) || val < spec.min || val > spec.max) {
      await ctx.reply(`❌ Введите целое число от ${spec.min} до ${spec.max}:`, {
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:cfg')]]),
      });
      return true;
    }

    ctx.session.staffAdminAction = null;
    const updated = await Settings.findOneAndUpdate(
      { name: 'global' },
      { $set: { [spec.field]: val } },
      { new: true, upsert: true }
    );
    invalidateCache(updated);
    await ctx.reply(`✅ Параметр «${spec.label}» обновлён: <b>${val}</b>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ К параметрам', 'adm_sup:cfg')]]),
    });
    return true;
  }

  if (action === 'add_quick_reply') {
    if (rawText.length > 500) {
      await ctx.reply('❌ Шаблон слишком длинный (максимум 500 символов). Отправьте более короткий текст:', {
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'adm_sup:cfg')]]),
      });
      return true;
    }

    const settingsDoc = await Settings.findOne({ name: 'global' });
    const list = Array.isArray(settingsDoc?.supportQuickReplies)
      ? [...settingsDoc.supportQuickReplies]
      : [...DEFAULT_QUICK_REPLIES];

    if (list.length >= 10) {
      ctx.session.staffAdminAction = null;
      await ctx.reply('⚠️ Достигнут максимум шаблонов (10). Удалите один из старых.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ К параметрам', 'adm_sup:cfg')]]),
      });
      return true;
    }

    list.push(rawText);
    ctx.session.staffAdminAction = null;
    const updated = await Settings.findOneAndUpdate(
      { name: 'global' },
      { $set: { supportQuickReplies: list } },
      { new: true, upsert: true }
    );
    invalidateCache(updated);
    await ctx.reply('✅ Быстрый шаблон добавлен!', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⚙️ К параметрам', 'adm_sup:cfg')]]),
    });
    return true;
  }

  return false;
};

module.exports = {
  ROLE_LABELS,
  ROLE_ICONS,
  DEFAULT_QUICK_REPLIES,
  buildRoleActionButtons,
  showSupportHub,
  showAdminTicketsQueue,
  showTeamList,
  showStaffStats,
  changeStaffRole,
  startAddStaff,
  showAuditLogs,
  showSupportChatSettings,
  disableSupportChat,
  startSetChatId,
  showSupportSettings,
  startCfgEdit,
  deleteQuickReply,
  startModSearch,
  showSafeUserCard,
  handleSupportAdminInput,
};

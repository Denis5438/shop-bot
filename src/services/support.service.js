const crypto = require('crypto');
const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const SupportMessage = require('../models/SupportMessage');
const StaffAuditLog = require('../models/StaffAuditLog');
const User = require('../models/User');
const Order = require('../models/Order');
const { getSettings } = require('./settingsCache.service');
const { invalidateUserCache } = require('../bot/middlewares/user');
const logger = require('../config/logger');

const STAFF_ROLES = ['support', 'moderator', 'admin', 'superadmin'];
const ROLE_ORDER = { superadmin: 0, admin: 1, moderator: 2, support: 3, user: 4 };

const TOPIC_LABELS = {
  order: '📦 Проблема с заказом',
  payment: '💳 Оплата и пополнение',
  product: '🔑 Товар / активация',
  general: '❓ Общий вопрос',
};

const generateCandidateTicketNumber = (attempt = 0) => {
  if (attempt < 3) {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `SUP-${num}`;
  }
  const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SUP-${hex}`;
};

const generateUniqueTicketNumber = async () => {
  for (let i = 0; i < 8; i++) {
    const candidate = generateCandidateTicketNumber(i);
    const exists = await SupportTicket.exists({ ticketNumber: candidate });
    if (!exists) return candidate;
  }
  return `SUP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
};

const countUserActiveTickets = async (userId) => {
  if (!userId) return 0;
  return SupportTicket.countDocuments({
    userId,
    status: { $in: ['open', 'in_progress', 'escalated'] },
  });
};

const createTicket = async ({
  user,
  topic = 'general',
  topicLabel = null,
  orderId = null,
  text = '',
  mediaType = null,
  mediaFileId = null,
}) => {
  if (!user || !user._id) {
    throw new Error('Пользователь не найден');
  }

  const settings = await getSettings();
  const maxOpen = Number(settings?.supportMaxOpenPerUser) > 0 ? Number(settings.supportMaxOpenPerUser) : 3;
  const activeCount = await countUserActiveTickets(user._id);

  if (activeCount >= maxOpen) {
    const err = new Error(`Достигнут лимит активных обращений (${maxOpen})`);
    err.code = 'TOO_MANY_OPEN_TICKETS';
    err.limit = maxOpen;
    err.activeCount = activeCount;
    throw err;
  }

  const safeTopic = Object.prototype.hasOwnProperty.call(TOPIC_LABELS, topic) ? topic : 'general';
  const resolvedTopicLabel = topicLabel || TOPIC_LABELS[safeTopic] || TOPIC_LABELS.general;
  const validOrderId = orderId && mongoose.Types.ObjectId.isValid(String(orderId)) ? orderId : null;
  const cleanText = String(text || '').trim() || (mediaType ? `[Вложение: ${mediaType}]` : '');
  const now = new Date();

  let ticket = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketNumber = await generateUniqueTicketNumber();
    try {
      ticket = await SupportTicket.create({
        ticketNumber,
        userId: user._id,
        telegramId: user.telegramId,
        topic: safeTopic,
        topicLabel: resolvedTopicLabel,
        orderId: validOrderId,
        status: 'open',
        priority: 'normal',
        assignedTo: null,
        assignedTelegramId: null,
        lastMessageAt: now,
        lastMessageByRole: 'user',
        createdAt: now,
      });
      break;
    } catch (err) {
      if (err?.code === 11000 && attempt < 4) continue;
      throw err;
    }
  }

  const message = await SupportMessage.create({
    ticketId: ticket._id,
    senderId: user._id,
    senderTelegramId: user.telegramId,
    senderRole: 'user',
    text: cleanText,
    mediaType: mediaType || null,
    mediaFileId: mediaFileId || null,
    createdAt: now,
  });

  return { ticket, message };
};

const claimTicket = async ({ ticketId, staffUser }) => {
  if (!ticketId || !staffUser?._id) {
    return { ok: false, ticket: null, reason: 'INVALID_PARAMS' };
  }

  const now = new Date();
  const claimed = await SupportTicket.findOneAndUpdate(
    {
      _id: ticketId,
      status: { $in: ['open', 'escalated'] },
      assignedTo: null,
    },
    {
      $set: {
        status: 'in_progress',
        assignedTo: staffUser._id,
        assignedTelegramId: staffUser.telegramId,
        takenAt: now,
      },
    },
    { new: true }
  );

  if (claimed) {
    await User.updateOne(
      { _id: staffUser._id },
      { $set: { supportLastActiveAt: now } }
    ).catch((err) => logger.warn(`claimTicket supportLastActiveAt update error: ${err.message}`));

    return { ok: true, ticket: claimed, reason: 'CLAIMED' };
  }

  const existing = await SupportTicket.findById(ticketId)
    .populate('assignedTo', 'telegramId username firstName role');

  if (!existing) {
    return { ok: false, ticket: null, reason: 'NOT_FOUND' };
  }
  if (existing.status === 'closed') {
    return { ok: false, ticket: existing, reason: 'ALREADY_CLOSED' };
  }
  const assignedId = existing.assignedTo?._id || existing.assignedTo;
  if (assignedId && String(assignedId) === String(staffUser._id)) {
    return { ok: true, ticket: existing, reason: 'ALREADY_MINE' };
  }

  return { ok: false, ticket: existing, reason: 'ALREADY_TAKEN' };
};

const addReply = async ({
  ticketId,
  senderUser,
  text = '',
  mediaType = null,
  mediaFileId = null,
  asRole = null,
}) => {
  if (!ticketId || !senderUser?._id) {
    return { ok: false, reason: 'INVALID_PARAMS', ticket: null, message: null };
  }

  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) {
    return { ok: false, reason: 'NOT_FOUND', ticket: null, message: null };
  }
  if (ticket.status === 'closed') {
    return { ok: false, reason: 'TICKET_CLOSED', ticket, message: null };
  }

  const isTicketOwner = String(senderUser._id) === String(ticket.userId);
  const isStaffRole = STAFF_ROLES.includes(senderUser.role);
  const effectiveRole = asRole || (isTicketOwner ? 'user' : (isStaffRole ? senderUser.role : 'user'));
  const isStaff = STAFF_ROLES.includes(effectiveRole);

  const now = new Date();
  const cleanText = String(text || '').trim() || (mediaType ? `[Вложение: ${mediaType}]` : '');

  const message = await SupportMessage.create({
    ticketId: ticket._id,
    senderId: senderUser._id,
    senderTelegramId: senderUser.telegramId,
    senderRole: effectiveRole,
    text: cleanText,
    mediaType: mediaType || null,
    mediaFileId: mediaFileId || null,
    createdAt: now,
  });

  if (isStaff) {
    // Атомарно фиксируем первый ответ сотрудника, если его ещё не было
    await SupportTicket.updateOne(
      { _id: ticket._id, firstResponseAt: null },
      { $set: { firstResponseAt: now, firstResponseBy: senderUser._id } }
    );

    // Если тикет ещё ожидал взятия — атомарно переводим в работу на ответившего
    await SupportTicket.updateOne(
      { _id: ticket._id, status: { $in: ['open', 'escalated'] }, assignedTo: null },
      {
        $set: {
          status: 'in_progress',
          assignedTo: senderUser._id,
          assignedTelegramId: senderUser.telegramId,
          takenAt: ticket.takenAt || now,
        },
      }
    );

    await SupportTicket.updateOne(
      { _id: ticket._id },
      { $set: { lastMessageAt: now, lastMessageByRole: effectiveRole } }
    );

    await User.updateOne(
      { _id: senderUser._id },
      { $set: { supportLastActiveAt: now } }
    ).catch(() => {});
  } else {
    await SupportTicket.updateOne(
      { _id: ticket._id },
      { $set: { lastMessageAt: now, lastMessageByRole: 'user' } }
    );
  }

  const updatedTicket = await SupportTicket.findById(ticket._id);
  return { ok: true, ticket: updatedTicket, message };
};

const escalateTicket = async ({ ticketId, staffUser, reason = '' }) => {
  if (!ticketId || !staffUser?._id) {
    return { ok: false, reason: 'INVALID_PARAMS', ticket: null };
  }

  const now = new Date();
  const cleanReason = String(reason || '').trim() || 'Требуется помощь модератора/администратора';

  const ticket = await SupportTicket.findOneAndUpdate(
    { _id: ticketId, status: { $ne: 'closed' } },
    {
      $set: {
        status: 'escalated',
        priority: 'high',
        escalatedAt: now,
        escalatedBy: staffUser._id,
        escalationReason: cleanReason,
        assignedTo: null,
        assignedTelegramId: null,
        lastMessageAt: now,
        lastMessageByRole: 'system',
      },
    },
    { new: true }
  );

  if (!ticket) {
    return { ok: false, reason: 'NOT_FOUND_OR_CLOSED', ticket: null };
  }

  const staffLabel = staffUser.username
    ? `@${staffUser.username}`
    : (staffUser.firstName || String(staffUser.telegramId));

  const message = await SupportMessage.create({
    ticketId: ticket._id,
    senderId: staffUser._id,
    senderTelegramId: staffUser.telegramId,
    senderRole: 'system',
    text: `🔺 Тикет эскалирован сотрудником ${staffLabel}. Причина: ${cleanReason}`,
    createdAt: now,
  });

  await User.updateOne(
    { _id: staffUser._id },
    { $set: { supportLastActiveAt: now } }
  ).catch(() => {});

  return { ok: true, ticket, message };
};

const closeTicket = async ({ ticketId, actorUser = null, reason = 'resolved' }) => {
  if (!ticketId) {
    return { ok: false, reason: 'INVALID_PARAMS', ticket: null };
  }

  const allowedReasons = ['resolved', 'user_closed', 'auto_timeout'];
  const safeReason = allowedReasons.includes(reason) ? reason : 'resolved';
  const now = new Date();

  const ticket = await SupportTicket.findOneAndUpdate(
    { _id: ticketId, status: { $ne: 'closed' } },
    {
      $set: {
        status: 'closed',
        closedAt: now,
        closedBy: actorUser?._id || null,
        closeReason: safeReason,
        lastMessageAt: now,
        lastMessageByRole: 'system',
      },
    },
    { new: true }
  );

  if (!ticket) {
    return { ok: false, reason: 'ALREADY_CLOSED_OR_NOT_FOUND', ticket: null };
  }

  const reasonTextMap = {
    resolved: 'сотрудником поддержки',
    user_closed: 'покупателем',
    auto_timeout: 'автоматически по истечении времени ожидания',
  };

  await SupportMessage.create({
    ticketId: ticket._id,
    senderId: actorUser?._id || null,
    senderTelegramId: actorUser?.telegramId || null,
    senderRole: 'system',
    text: `✅ Обращение закрыто (${reasonTextMap[safeReason]}).`,
    createdAt: now,
  });

  if (actorUser?._id && STAFF_ROLES.includes(actorUser.role)) {
    await User.updateOne(
      { _id: actorUser._id },
      { $set: { supportLastActiveAt: now } }
    ).catch(() => {});
  }

  return { ok: true, ticket };
};

const rateTicket = async ({ ticketId, userId, rating }) => {
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return { ok: false, reason: 'INVALID_RATING', ticket: null };
  }

  const existing = await SupportTicket.findById(ticketId);
  if (!existing) {
    return { ok: false, reason: 'NOT_FOUND', ticket: null };
  }
  if (String(existing.userId) !== String(userId)) {
    return { ok: false, reason: 'FORBIDDEN', ticket: null };
  }
  if (existing.status !== 'closed') {
    return { ok: false, reason: 'NOT_CLOSED', ticket: existing };
  }

  const updated = await SupportTicket.findOneAndUpdate(
    { _id: ticketId, userId, status: 'closed' },
    { $set: { rating: numRating, ratedAt: new Date() } },
    { new: true }
  );

  return { ok: true, ticket: updated };
};

const toggleDuty = async (user) => {
  if (!user?._id) return { ok: false, supportOnDuty: false };

  const currentDuty = user.supportOnDuty !== false;
  const newDuty = !currentDuty;
  const now = new Date();

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { supportOnDuty: newDuty, supportLastActiveAt: now } },
    { new: true }
  );

  user.supportOnDuty = newDuty;
  user.supportLastActiveAt = now;
  invalidateUserCache(user.telegramId);

  return { ok: true, supportOnDuty: newDuty, user: updated || user };
};

const getQueue = async ({ tab = 'waiting', staffUserId = null, page = 1, limit = 8 } = {}) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));
  const skip = (safePage - 1) * safeLimit;

  const normalizedTab = tab === 'esc' ? 'escalated' : tab;
  let query = {};
  let sort = { lastMessageAt: -1 };

  switch (normalizedTab) {
    case 'waiting':
      query = { status: 'open', assignedTo: null };
      sort = { createdAt: 1 };
      break;
    case 'mine':
      query = { status: 'in_progress', assignedTo: staffUserId };
      sort = { lastMessageAt: -1 };
      break;
    case 'escalated':
      query = { status: 'escalated' };
      sort = { escalatedAt: -1, createdAt: 1 };
      break;
    case 'closed':
      query = { status: 'closed' };
      sort = { closedAt: -1, createdAt: -1 };
      break;
    case 'all':
    default:
      query = { status: { $in: ['open', 'in_progress', 'escalated'] } };
      sort = { priority: 1, lastMessageAt: -1 };
      break;
  }

  const [items, total] = await Promise.all([
    SupportTicket.find(query)
      .sort(sort)
      .skip(skip)
      .limit(safeLimit)
      .populate('userId', 'telegramId username firstName')
      .populate('assignedTo', 'telegramId username firstName role')
      .populate({ path: 'orderId', select: 'status price productId', populate: { path: 'productId', select: 'name' } })
      .lean(),
    SupportTicket.countDocuments(query),
  ]);

  return {
    items,
    total,
    page: safePage,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
};

const getQueuesCounts = async (staffUserId = null) => {
  const [waiting, mine, escalated, inProgress, closed, onDutyCount] = await Promise.all([
    SupportTicket.countDocuments({ status: 'open', assignedTo: null }),
    staffUserId
      ? SupportTicket.countDocuments({ status: 'in_progress', assignedTo: staffUserId })
      : Promise.resolve(0),
    SupportTicket.countDocuments({ status: 'escalated' }),
    SupportTicket.countDocuments({ status: 'in_progress' }),
    SupportTicket.countDocuments({ status: 'closed' }),
    User.countDocuments({
      role: { $in: STAFF_ROLES },
      supportOnDuty: { $ne: false },
      isBanned: { $ne: true },
    }),
  ]);

  return {
    waiting,
    mine,
    escalated,
    inProgress,
    closed,
    active: waiting + inProgress + escalated,
    onDutyCount,
  };
};

const getTicketDetail = async (ticketId) => {
  if (!ticketId || !mongoose.Types.ObjectId.isValid(String(ticketId))) {
    return { ticket: null, messages: [], userOrdersCount: 0, lastOrder: null };
  }

  const ticket = await SupportTicket.findById(ticketId)
    .populate('userId', 'telegramId username firstName lastName role createdAt')
    .populate('assignedTo', 'telegramId username firstName role')
    .populate('escalatedBy', 'telegramId username firstName role')
    .populate('closedBy', 'telegramId username firstName role')
    .populate({
      path: 'orderId',
      select: 'status price qty createdAt productId',
      populate: { path: 'productId', select: 'name price' },
    })
    .lean();

  if (!ticket) {
    return { ticket: null, messages: [], userOrdersCount: 0, lastOrder: null };
  }

  const buyerId = ticket.userId?._id || ticket.userId;

  const [messages, userOrdersCount, lastOrder] = await Promise.all([
    SupportMessage.find({ ticketId: ticket._id })
      .sort({ createdAt: 1 })
      .populate('senderId', 'telegramId username firstName role')
      .lean(),
    buyerId ? Order.countDocuments({ userId: buyerId }) : Promise.resolve(0),
    buyerId
      ? Order.findOne({ userId: buyerId })
        .sort({ createdAt: -1 })
        .select('status price qty createdAt productId')
        .populate('productId', 'name price')
        .lean()
      : Promise.resolve(null),
  ]);

  return { ticket, messages, userOrdersCount, lastOrder };
};

const getUserTickets = async (userId, page = 1, limit = 8) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 8));
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    SupportTicket.find({ userId })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate('assignedTo', 'username firstName role')
      .lean(),
    SupportTicket.countDocuments({ userId }),
  ]);

  return {
    items,
    total,
    page: safePage,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
};

const getStaffTeamList = async () => {
  const staff = await User.find({ role: { $in: STAFF_ROLES } })
    .select('telegramId username firstName lastName role supportOnDuty supportLastActiveAt roleChangedAt roleChangedBy isBanned createdAt')
    .lean();

  staff.sort((a, b) => {
    const rankDiff = (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    const dutyDiff = Number(b.supportOnDuty !== false) - Number(a.supportOnDuty !== false);
    if (dutyDiff !== 0) return dutyDiff;
    const aTime = a.supportLastActiveAt ? new Date(a.supportLastActiveAt).getTime() : 0;
    const bTime = b.supportLastActiveAt ? new Date(b.supportLastActiveAt).getTime() : 0;
    return bTime - aTime;
  });

  return staff;
};

const getPeriodStartDate = (period = '30d') => {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (period === '7d') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (period === '30d') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
};

const getStaffActivityStats = async (staffUserId, period = '30d') => {
  if (!staffUserId) {
    return {
      takenCount: 0,
      closedCount: 0,
      repliesCount: 0,
      avgFirstResponseSec: null,
      avgRating: null,
      ratedCount: 0,
      escalatedFromCount: 0,
      lastActiveAt: null,
    };
  }

  const staffObjectId = mongoose.Types.ObjectId.isValid(String(staffUserId))
    ? new mongoose.Types.ObjectId(String(staffUserId))
    : staffUserId;

  const sinceDate = getPeriodStartDate(period);

  const [
    staffUser,
    takenCount,
    closedCount,
    repliesCount,
    firstResponseTickets,
    ratedTickets,
    escalatedFromCount,
  ] = await Promise.all([
    User.findById(staffObjectId).select('supportLastActiveAt').lean(),
    SupportTicket.countDocuments({
      assignedTo: staffObjectId,
      ...(sinceDate ? { takenAt: { $gte: sinceDate } } : {}),
    }),
    SupportTicket.countDocuments({
      closedBy: staffObjectId,
      status: 'closed',
      ...(sinceDate ? { closedAt: { $gte: sinceDate } } : {}),
    }),
    SupportMessage.countDocuments({
      senderId: staffObjectId,
      senderRole: { $in: STAFF_ROLES },
      ...(sinceDate ? { createdAt: { $gte: sinceDate } } : {}),
    }),
    SupportTicket.find({
      firstResponseBy: staffObjectId,
      firstResponseAt: { $ne: null, ...(sinceDate ? { $gte: sinceDate } : {}) },
    })
      .select('createdAt firstResponseAt')
      .lean(),
    SupportTicket.find({
      $or: [{ assignedTo: staffObjectId }, { closedBy: staffObjectId }],
      rating: { $gte: 1, $lte: 5 },
      ...(sinceDate ? { ratedAt: { $gte: sinceDate } } : {}),
    })
      .select('rating')
      .lean(),
    SupportTicket.countDocuments({
      escalatedBy: staffObjectId,
      ...(sinceDate ? { escalatedAt: { $gte: sinceDate } } : {}),
    }),
  ]);

  let avgFirstResponseSec = null;
  if (firstResponseTickets.length > 0) {
    let totalSec = 0;
    for (const t of firstResponseTickets) {
      const diffMs = Math.max(0, new Date(t.firstResponseAt).getTime() - new Date(t.createdAt).getTime());
      totalSec += diffMs / 1000;
    }
    avgFirstResponseSec = Math.round(totalSec / firstResponseTickets.length);
  }

  const ratedCount = ratedTickets.length;
  let avgRating = null;
  if (ratedCount > 0) {
    const sum = ratedTickets.reduce((acc, t) => acc + (Number(t.rating) || 0), 0);
    avgRating = Number((sum / ratedCount).toFixed(2));
  }

  return {
    takenCount,
    closedCount,
    repliesCount,
    avgFirstResponseSec,
    avgRating,
    ratedCount,
    escalatedFromCount,
    lastActiveAt: staffUser?.supportLastActiveAt || null,
  };
};

const assignStaffRole = async ({ actorUser, targetUser, newRole, reason = '' }) => {
  if (!actorUser || !targetUser) {
    return { ok: false, error: 'INVALID_PARAMS' };
  }

  const validAllRoles = ['user', 'support', 'moderator', 'admin', 'superadmin'];
  if (!validAllRoles.includes(newRole)) {
    return { ok: false, error: 'INVALID_ROLE' };
  }

  if (
    String(actorUser._id) === String(targetUser._id) ||
    Number(actorUser.telegramId) === Number(targetUser.telegramId)
  ) {
    return { ok: false, error: 'CANNOT_MODIFY_SELF' };
  }

  const actorRole = actorUser.role || 'user';
  const oldRole = targetUser.role || 'user';

  // Никто не может изменять роль superadmin или назначать superadmin через панель
  if (oldRole === 'superadmin' || newRole === 'superadmin') {
    return { ok: false, error: 'CANNOT_ESCALATE_ROLE' };
  }

  if (actorRole === 'superadmin') {
    if (!['user', 'support', 'moderator', 'admin'].includes(newRole)) {
      return { ok: false, error: 'CANNOT_ESCALATE_ROLE' };
    }
  } else if (actorRole === 'admin') {
    if (oldRole === 'admin' || !['user', 'support', 'moderator'].includes(newRole)) {
      return { ok: false, error: 'CANNOT_ESCALATE_ROLE' };
    }
  } else if (actorRole === 'moderator') {
    // Модератор может ТОЛЬКО переключать user <-> support
    if (!['user', 'support'].includes(oldRole) || !['user', 'support'].includes(newRole)) {
      return { ok: false, error: 'CANNOT_ESCALATE_ROLE' };
    }
  } else {
    return { ok: false, error: 'FORBIDDEN' };
  }

  if (oldRole === newRole) {
    return { ok: true, changed: false, oldRole, newRole, user: targetUser };
  }

  const now = new Date();
  const cleanReason = String(reason || '').trim();
  const updateSet = {
    role: newRole,
    roleChangedAt: now,
    roleChangedBy: actorUser.telegramId,
  };

  if (newRole === 'admin') {
    updateSet.promotedBy = actorUser.telegramId;
  } else if (oldRole === 'admin') {
    updateSet.promotedBy = null;
  }

  if (newRole === 'support' && targetUser.supportOnDuty === undefined) {
    updateSet.supportOnDuty = true;
  }

  const updatedUser = await User.findByIdAndUpdate(
    targetUser._id,
    { $set: updateSet },
    { new: true }
  );

  const auditLog = await StaffAuditLog.create({
    targetUserId: targetUser._id,
    targetTelegramId: targetUser.telegramId,
    actorUserId: actorUser._id,
    actorTelegramId: actorUser.telegramId,
    oldRole,
    newRole,
    reason: cleanReason,
    createdAt: now,
  });

  invalidateUserCache(targetUser.telegramId);

  return {
    ok: true,
    changed: true,
    oldRole,
    newRole,
    user: updatedUser || targetUser,
    auditLog,
  };
};

const getStaffAuditLogs = async (page = 1, limit = 10) => {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const skip = (safePage - 1) * safeLimit;

  const [items, total] = await Promise.all([
    StaffAuditLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate('targetUserId', 'telegramId username firstName')
      .populate('actorUserId', 'telegramId username firstName')
      .lean(),
    StaffAuditLog.countDocuments(),
  ]);

  return {
    items,
    total,
    page: safePage,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
};

module.exports = {
  TOPIC_LABELS,
  createTicket,
  claimTicket,
  addReply,
  escalateTicket,
  closeTicket,
  rateTicket,
  toggleDuty,
  getQueue,
  getQueuesCounts,
  getTicketDetail,
  getUserTickets,
  countUserActiveTickets,
  getStaffTeamList,
  getStaffActivityStats,
  assignStaffRole,
  getStaffAuditLogs,
};

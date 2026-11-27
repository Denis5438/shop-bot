const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const User = require('../../models/User');
const Order = require('../../models/Order');
const Settings = require('../../models/Settings');
const SupportTicket = require('../../models/SupportTicket');
const SupportMessage = require('../../models/SupportMessage');
const supportService = require('../../services/support.service');
const supportNotify = require('../../services/supportNotify.service');
const settingsCache = require('../../services/settingsCache.service');
const notif = require('../../services/notification.service');
const { BOT_TOKEN } = require('../../config');
const {
  authenticateToken,
  isSupportOrAbove,
  isModeratorOrAbove,
  isAdminOrAbove,
  requireSupport,
  requireModerator,
  requireAdmin,
} = require('../middlewares/auth.middleware');
const logger = require('../../config/logger');

const router = express.Router();

router.use(authenticateToken);

const OWNER_URL = 'https://t.me/Tigrano_o';
const MAX_UPLOAD_IMAGE_BYTES = 700 * 1024;
const STAFF_ROLES = new Set(['support', 'moderator', 'admin', 'superadmin']);

const escapeRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const detectImageMagicBytes = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
};

const validateImageBase64 = (rawInput) => {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return { ok: false, error: 'INVALID_IMAGE', message: 'Пустое изображение' };
  }
  const trimmed = rawInput.trim();
  const match = trimmed.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    return {
      ok: false,
      error: 'INVALID_IMAGE',
      message: 'Поддерживаются только изображения PNG, JPEG или WEBP в формате base64',
    };
  }

  let buffer;
  try {
    buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch (_) {
    return { ok: false, error: 'INVALID_IMAGE', message: 'Некорректные данные изображения' };
  }

  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'INVALID_IMAGE', message: 'Пустой файл изображения' };
  }
  if (buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
    return {
      ok: false,
      error: 'INVALID_IMAGE',
      message: 'Размер изображения не должен превышать 700 КБ',
    };
  }

  const detected = detectImageMagicBytes(buffer);
  if (!detected) {
    return {
      ok: false,
      error: 'INVALID_IMAGE',
      message: 'Файл не является корректным изображением PNG, JPEG или WEBP',
    };
  }

  return {
    ok: true,
    buffer,
    mime: detected.mime,
    ext: detected.ext,
    dataUrl: `data:${detected.mime};base64,${buffer.toString('base64')}`,
  };
};

const formatUserBrief = (u, includeTelegramId = false) => {
  if (!u || typeof u !== 'object') return null;
  const out = {
    id: u._id,
    username: u.username || null,
    firstName: u.firstName || '',
    role: u.role || 'user',
  };
  if (includeTelegramId) {
    out.telegramId = u.telegramId ?? null;
  }
  return out;
};

const formatTicket = (t, isStaffView = false) => {
  if (!t) return null;
  const orderObj = t.orderId && typeof t.orderId === 'object' ? t.orderId : null;
  const base = {
    id: t._id,
    ticketNumber: t.ticketNumber,
    topic: t.topic || 'general',
    topicLabel: t.topicLabel || '',
    status: t.status,
    priority: t.priority || 'normal',
    orderId: orderObj
      ? {
          id: orderObj._id,
          status: orderObj.status,
          price: orderObj.price,
          qty: orderObj.qty || 1,
          createdAt: orderObj.createdAt,
          productName: orderObj.productId?.name || null,
        }
      : (t.orderId || null),
    assignedTo: t.assignedTo
      ? (typeof t.assignedTo === 'object' ? formatUserBrief(t.assignedTo, isStaffView) : t.assignedTo)
      : null,
    lastMessageAt: t.lastMessageAt,
    lastMessageByRole: t.lastMessageByRole || 'user',
    closeReason: t.closeReason || null,
    closedAt: t.closedAt || null,
    rating: t.rating ?? null,
    ratedAt: t.ratedAt || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };

  if (isStaffView) {
    base.telegramId = t.telegramId;
    base.assignedTelegramId = t.assignedTelegramId ?? null;
    base.user = t.userId && typeof t.userId === 'object' ? formatUserBrief(t.userId, true) : null;
    base.takenAt = t.takenAt || null;
    base.firstResponseAt = t.firstResponseAt || null;
    base.escalatedAt = t.escalatedAt || null;
    base.escalatedBy = t.escalatedBy && typeof t.escalatedBy === 'object' ? formatUserBrief(t.escalatedBy, true) : (t.escalatedBy || null);
    base.escalationReason = t.escalationReason || null;
    base.closedBy = t.closedBy && typeof t.closedBy === 'object' ? formatUserBrief(t.closedBy, true) : (t.closedBy || null);
  }

  return base;
};

const formatSupportMessage = (m, ticketId, isStaffView = false) => {
  const hasMedia = Boolean(m.mediaFileId || m.mediaDataUrl);
  const tid = String(ticketId || m.ticketId);
  return {
    id: m._id,
    senderRole: m.senderRole,
    sender: m.senderId && typeof m.senderId === 'object'
      ? formatUserBrief(m.senderId, isStaffView)
      : null,
    text: m.text || '',
    mediaType: m.mediaType || null,
    hasMedia,
    mediaUrl: hasMedia ? `/api/v1/support/tickets/${tid}/media/${m._id}` : null,
    createdAt: m.createdAt,
  };
};

const formatStaffUser = (u) => ({
  id: u._id,
  telegramId: u.telegramId,
  username: u.username || null,
  firstName: u.firstName || '',
  lastName: u.lastName || '',
  role: u.role || 'user',
  onDuty: u.supportOnDuty !== false,
  supportOnDuty: u.supportOnDuty !== false,
  supportLastActiveAt: u.supportLastActiveAt || null,
  roleChangedAt: u.roleChangedAt || null,
  roleChangedBy: u.roleChangedBy || null,
  isBanned: Boolean(u.isBanned),
  createdAt: u.createdAt,
});

const formatAuditLog = (log) => ({
  id: log._id,
  targetUser: log.targetUserId && typeof log.targetUserId === 'object'
    ? formatUserBrief(log.targetUserId, true)
    : { telegramId: log.targetTelegramId },
  targetTelegramId: log.targetTelegramId,
  actorUser: log.actorUserId && typeof log.actorUserId === 'object'
    ? formatUserBrief(log.actorUserId, true)
    : { telegramId: log.actorTelegramId },
  actorTelegramId: log.actorTelegramId,
  oldRole: log.oldRole,
  newRole: log.newRole,
  reason: log.reason || '',
  createdAt: log.createdAt,
});

const resolveBotForMedia = () => {
  const running = notif.getBotInstance();
  if (running) return running;
  if (BOT_TOKEN) return new Telegraf(BOT_TOKEN);
  return null;
};

// ─── 1. Клиентские эндпоинты ───────────────────────────────────────────────

/**
 * GET /api/v1/support/meta
 */
router.get('/meta', async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const maxOpen = Number(settings?.supportMaxOpenPerUser) > 0 ? Number(settings.supportMaxOpenPerUser) : 3;

    const [activeCount, unreadCount, recentOrders] = await Promise.all([
      supportService.countUserActiveTickets(req.user._id),
      SupportTicket.countDocuments({
        userId: req.user._id,
        status: { $in: ['open', 'in_progress', 'escalated'] },
        lastMessageByRole: { $in: [...STAFF_ROLES] },
      }),
      Order.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('productId', 'name icon')
        .select('status price qty createdAt productId')
        .lean(),
    ]);

    return res.json({
      success: true,
      ownerUrl: OWNER_URL,
      maxOpen,
      activeCount,
      unreadCount,
      isSupport: isSupportOrAbove(req.user),
      isModerator: isModeratorOrAbove(req.user),
      isAdmin: isAdminOrAbove(req.user),
      recentOrders: recentOrders.map((o) => ({
        id: o._id,
        status: o.status,
        price: o.price,
        qty: o.qty || 1,
        createdAt: o.createdAt,
        productName: o.productId?.name || 'Товар',
        productIcon: o.productId?.icon || '📦',
      })),
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /meta error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/tickets
 */
router.get('/tickets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const data = await supportService.getUserTickets(req.user._id, page, limit);

    return res.json({
      success: true,
      tickets: data.items.map((t) => formatTicket(t, false)),
      total: data.total,
      page: data.page,
      totalPages: data.totalPages,
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /tickets error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/tickets
 */
router.post('/tickets', async (req, res) => {
  try {
    const { topic = 'general', orderId = null, text = '', imageBase64 = null } = req.body || {};
    const cleanText = typeof text === 'string' ? text.trim() : '';

    if (!cleanText && !imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'EMPTY_MESSAGE',
        message: 'Опишите проблему или прикрепите скриншот',
      });
    }
    if (cleanText.length > 4000) {
      return res.status(400).json({
        success: false,
        error: 'TEXT_TOO_LONG',
        message: 'Сообщение слишком длинное (максимум 4000 символов)',
      });
    }

    let parsedImage = null;
    if (imageBase64 !== null && imageBase64 !== undefined && imageBase64 !== '') {
      const imgRes = validateImageBase64(imageBase64);
      if (!imgRes.ok) {
        return res.status(400).json({ success: false, error: imgRes.error, message: imgRes.message });
      }
      parsedImage = imgRes;
    }

    let validOrderId = null;
    if (orderId) {
      if (!mongoose.isValidObjectId(String(orderId))) {
        return res.status(400).json({ success: false, error: 'INVALID_ORDER_ID', message: 'Некорректный ID заказа' });
      }
      const ownedOrder = await Order.exists({ _id: orderId, userId: req.user._id });
      if (!ownedOrder) {
        return res.status(400).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
      }
      validOrderId = orderId;
    }

    const { ticket, message } = await supportService.createTicket({
      user: req.user,
      topic,
      orderId: validOrderId,
      text: cleanText,
      mediaType: parsedImage ? 'photo' : null,
      mediaFileId: null,
    });

    if (parsedImage) {
      await SupportMessage.updateOne(
        { _id: message._id },
        { $set: { mediaDataUrl: parsedImage.dataUrl } }
      );
      message.mediaDataUrl = parsedImage.dataUrl;
    }

    await supportNotify.notifyNewTicket(ticket, req.user, message).catch((err) => {
      logger.warn(`[SupportAPI] notifyNewTicket error: ${err.message}`);
    });

    return res.status(201).json({
      success: true,
      ticket: formatTicket(ticket, false),
      message: formatSupportMessage(message, ticket._id, false),
    });
  } catch (err) {
    if (err?.code === 'TOO_MANY_OPEN_TICKETS') {
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_OPEN_TICKETS',
        message: err.message,
        limit: err.limit,
        activeCount: err.activeCount,
      });
    }
    logger.error(`[SupportAPI] POST /tickets error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/tickets/:id
 */
router.get('/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const detail = await supportService.getTicketDetail(id);
    if (!detail.ticket) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }

    const ownerId = detail.ticket.userId?._id || detail.ticket.userId;
    const isOwner = ownerId && String(ownerId) === String(req.user._id);
    const isStaff = isSupportOrAbove(req.user);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (detail.ticket.status === 'escalated' && !isOwner && !isModeratorOrAbove(req.user)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const visibleMessages = isStaff
      ? detail.messages
      : detail.messages.filter((m) => !(m.senderRole === 'system' && String(m.text || '').startsWith('🔺')));

    return res.json({
      success: true,
      ticket: formatTicket(detail.ticket, isStaff),
      messages: visibleMessages.map((m) => formatSupportMessage(m, id, isStaff)),
      userOrdersCount: detail.userOrdersCount,
      lastOrder: detail.lastOrder
        ? {
            id: detail.lastOrder._id,
            status: detail.lastOrder.status,
            price: detail.lastOrder.price,
            qty: detail.lastOrder.qty || 1,
            createdAt: detail.lastOrder.createdAt,
            productName: detail.lastOrder.productId?.name || null,
          }
        : null,
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /tickets/${req.params.id} error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/tickets/:id/reply
 */
router.post('/tickets/:id/reply', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const existing = await SupportTicket.findById(id).select('userId status').lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (String(existing.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const { text = '', imageBase64 = null } = req.body || {};
    const cleanText = typeof text === 'string' ? text.trim() : '';

    if (!cleanText && !imageBase64) {
      return res.status(400).json({ success: false, error: 'EMPTY_MESSAGE', message: 'Введите сообщение или прикрепите фото' });
    }
    if (cleanText.length > 4000) {
      return res.status(400).json({ success: false, error: 'TEXT_TOO_LONG', message: 'Максимум 4000 символов' });
    }

    let parsedImage = null;
    if (imageBase64 !== null && imageBase64 !== undefined && imageBase64 !== '') {
      const imgRes = validateImageBase64(imageBase64);
      if (!imgRes.ok) {
        return res.status(400).json({ success: false, error: imgRes.error, message: imgRes.message });
      }
      parsedImage = imgRes;
    }

    const replyRes = await supportService.addReply({
      ticketId: id,
      senderUser: req.user,
      text: cleanText,
      mediaType: parsedImage ? 'photo' : null,
      mediaFileId: null,
      asRole: 'user',
    });

    if (!replyRes.ok) {
      if (replyRes.reason === 'TICKET_CLOSED') {
        return res.status(409).json({ success: false, error: 'TICKET_CLOSED', message: 'Обращение уже закрыто' });
      }
      if (replyRes.reason === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
      }
      return res.status(400).json({ success: false, error: replyRes.reason || 'REPLY_FAILED' });
    }

    if (parsedImage) {
      await SupportMessage.updateOne(
        { _id: replyRes.message._id },
        { $set: { mediaDataUrl: parsedImage.dataUrl } }
      );
      replyRes.message.mediaDataUrl = parsedImage.dataUrl;
    }

    await Promise.all([
      supportNotify.notifyStaffBuyerReply(replyRes.ticket, req.user, replyRes.message).catch(() => {}),
      supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {}),
    ]);

    return res.json({
      success: true,
      ticket: formatTicket(replyRes.ticket, false),
      message: formatSupportMessage(replyRes.message, id, false),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /tickets/${req.params.id}/reply error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/tickets/:id/close
 */
router.post('/tickets/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const existing = await SupportTicket.findById(id).select('userId status').lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (String(existing.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const closeRes = await supportService.closeTicket({
      ticketId: id,
      actorUser: req.user,
      reason: 'user_closed',
    });

    if (!closeRes.ok) {
      return res.status(409).json({ success: false, error: 'ALREADY_CLOSED', message: 'Обращение уже закрыто' });
    }

    await supportNotify.syncTicketCardInChats(closeRes.ticket).catch(() => {});

    return res.json({
      success: true,
      ticket: formatTicket(closeRes.ticket, false),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /tickets/${req.params.id}/close error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/tickets/:id/rate
 */
router.post('/tickets/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const { rating } = req.body || {};
    const rateRes = await supportService.rateTicket({
      ticketId: id,
      userId: req.user._id,
      rating,
    });

    if (!rateRes.ok) {
      if (rateRes.reason === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
      if (rateRes.reason === 'FORBIDDEN') return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      if (rateRes.reason === 'NOT_CLOSED') return res.status(409).json({ success: false, error: 'NOT_CLOSED', message: 'Оценить можно только закрытое обращение' });
      return res.status(400).json({ success: false, error: rateRes.reason || 'INVALID_RATING', message: 'Укажите оценку от 1 до 5' });
    }

    await supportNotify.syncTicketCardInChats(rateRes.ticket).catch(() => {});

    return res.json({
      success: true,
      ticket: formatTicket(rateRes.ticket, false),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /tickets/${req.params.id}/rate error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/tickets/:id/media/:msgId
 */
router.get('/tickets/:id/media/:msgId', async (req, res) => {
  try {
    const { id, msgId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(msgId)) {
      return res.status(400).json({ success: false, error: 'INVALID_ID' });
    }

    const [ticket, msg] = await Promise.all([
      SupportTicket.findById(id).select('userId status').lean(),
      SupportMessage.findOne({ _id: msgId, ticketId: id }).lean(),
    ]);

    if (!ticket || !msg) {
      return res.status(404).json({ success: false, error: 'MEDIA_NOT_FOUND' });
    }

    const isOwner = String(ticket.userId) === String(req.user._id);
    if (!isOwner && !isSupportOrAbove(req.user)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (ticket.status === 'escalated' && !isOwner && !isModeratorOrAbove(req.user)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');

    if (msg.mediaDataUrl) {
      const parsed = validateImageBase64(msg.mediaDataUrl);
      if (!parsed.ok) {
        return res.status(400).json({ success: false, error: 'INVALID_IMAGE' });
      }
      res.setHeader('Content-Type', parsed.mime);
      return res.send(parsed.buffer);
    }

    if (msg.mediaFileId) {
      const bot = resolveBotForMedia();
      if (!bot) {
        return res.status(503).json({ success: false, error: 'MEDIA_UNAVAILABLE' });
      }
      const fileLink = await bot.telegram.getFileLink(msg.mediaFileId);
      const fileUrl = fileLink?.href || String(fileLink);
      const tgResp = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxContentLength: 10 * 1024 * 1024,
      });
      const buf = Buffer.from(tgResp.data);
      const detected = detectImageMagicBytes(buf);
      if (!detected) {
        return res.status(415).json({ success: false, error: 'UNSUPPORTED_MEDIA_TYPE' });
      }
      res.setHeader('Content-Type', detected.mime);
      return res.send(buf);
    }

    return res.status(404).json({ success: false, error: 'MEDIA_NOT_FOUND' });
  } catch (err) {
    logger.error(`[SupportAPI] GET /tickets/${req.params.id}/media/${req.params.msgId} error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 2. Эндпоинты сотрудников поддержки (requireSupport) ────────────────────

/**
 * POST /api/v1/support/staff/duty
 */
router.post('/staff/duty', requireSupport, async (req, res) => {
  try {
    const result = await supportService.toggleDuty(req.user);
    return res.json({
      success: true,
      onDuty: result.supportOnDuty,
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /staff/duty error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/staff/queues
 */
router.get('/staff/queues', requireSupport, async (req, res) => {
  try {
    const rawTab = String(req.query.tab || 'waiting').toLowerCase();
    const tab = rawTab === 'esc' ? 'escalated' : rawTab;
    const allowedTabs = ['waiting', 'mine', 'escalated', 'closed', 'all'];
    const safeTab = allowedTabs.includes(tab) ? tab : 'waiting';
    const canViewEscalated = isModeratorOrAbove(req.user);

    if (safeTab === 'escalated' && !canViewEscalated) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Эскалированные обращения доступны модераторам и администраторам',
      });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 12));
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 64) : '';

    const fetchQueue = async () => {
      if (!rawSearch) {
        return supportService.getQueue({ tab: safeTab, staffUserId: req.user._id, page, limit });
      }

      let tabQuery = {};
      let sort = { lastMessageAt: -1 };
      switch (safeTab) {
        case 'waiting':
          tabQuery = { status: 'open', assignedTo: null };
          sort = { createdAt: 1 };
          break;
        case 'mine':
          tabQuery = { status: 'in_progress', assignedTo: req.user._id };
          sort = { lastMessageAt: -1 };
          break;
        case 'escalated':
          tabQuery = { status: 'escalated' };
          sort = { escalatedAt: -1, createdAt: 1 };
          break;
        case 'closed':
          tabQuery = { status: 'closed' };
          sort = { closedAt: -1, createdAt: -1 };
          break;
        case 'all':
        default:
          tabQuery = {
            status: { $in: canViewEscalated ? ['open', 'in_progress', 'escalated'] : ['open', 'in_progress'] },
          };
          sort = { priority: 1, lastMessageAt: -1 };
          break;
      }

      const escaped = escapeRegex(rawSearch);
      const re = new RegExp(escaped, 'i');
      const searchOr = [{ ticketNumber: re }, { topicLabel: re }];
      if (/^\d+$/.test(rawSearch)) {
        searchOr.push({ telegramId: Number(rawSearch) });
      }

      const cleanUserQuery = rawSearch.replace(/^@/, '').trim();
      if (cleanUserQuery) {
        const userRe = new RegExp(escapeRegex(cleanUserQuery), 'i');
        const matchedUsers = await User.find({
          $or: [{ username: userRe }, { firstName: userRe }],
        })
          .select('_id')
          .limit(50)
          .lean()
          .catch(() => []);
        if (Array.isArray(matchedUsers) && matchedUsers.length > 0) {
          searchOr.push({ userId: { $in: matchedUsers.map((u) => u._id) } });
        }
      }

      const andConditions = [tabQuery, { $or: searchOr }];
      if (!canViewEscalated) {
        andConditions.push({ status: { $ne: 'escalated' } });
      }
      const finalQuery = { $and: andConditions };
      const skip = (page - 1) * limit;

      const [items, total] = await Promise.all([
        SupportTicket.find(finalQuery)
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .populate('userId', 'telegramId username firstName')
          .populate('assignedTo', 'telegramId username firstName role')
          .populate({ path: 'orderId', select: 'status price productId', populate: { path: 'productId', select: 'name' } })
          .lean(),
        SupportTicket.countDocuments(finalQuery),
      ]);

      return {
        items,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      };
    };

    const [queueData, counts, settings] = await Promise.all([
      fetchQueue(),
      supportService.getQueuesCounts(req.user._id),
      settingsCache.getSettings(),
    ]);

    const filteredItems = canViewEscalated
      ? queueData.items
      : queueData.items.filter((t) => t.status !== 'escalated');

    const quickReplies = Array.isArray(settings?.supportQuickReplies) ? settings.supportQuickReplies : [];

    return res.json({
      success: true,
      tab: safeTab,
      tickets: filteredItems.map((t) => formatTicket(t, true)),
      counts: {
        ...counts,
        escalated: canViewEscalated ? counts.escalated : 0,
      },
      pagination: {
        page: queueData.page,
        limit,
        total: queueData.total,
        pages: queueData.totalPages,
      },
      onDuty: req.user.supportOnDuty !== false,
      quickReplies,
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /staff/queues error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/staff/quick-replies
 */
router.get('/staff/quick-replies', requireSupport, async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const quickReplies = Array.isArray(settings?.supportQuickReplies) ? settings.supportQuickReplies : [];
    return res.json({ success: true, quickReplies });
  } catch (err) {
    logger.error(`[SupportAPI] GET /staff/quick-replies error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/staff/tickets/:id/take
 */
router.post('/staff/tickets/:id/take', requireSupport, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const pre = await SupportTicket.findById(id).select('status').lean();
    if (!pre) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (pre.status === 'escalated' && !isModeratorOrAbove(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Эскалированный тикет может взять только модератор или администратор',
      });
    }

    const claimRes = await supportService.claimTicket({ ticketId: id, staffUser: req.user });
    if (!claimRes.ok) {
      if (claimRes.reason === 'NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
      }
      if (claimRes.reason === 'ALREADY_CLOSED') {
        return res.status(409).json({ success: false, error: 'ALREADY_CLOSED', message: 'Обращение уже закрыто' });
      }
      if (claimRes.reason === 'ALREADY_TAKEN') {
        return res.status(409).json({
          success: false,
          error: 'ALREADY_TAKEN',
          message: 'Обращение уже взято другим сотрудником',
        });
      }
      return res.status(400).json({ success: false, error: claimRes.reason || 'CLAIM_FAILED' });
    }

    await supportNotify.syncTicketCardInChats(claimRes.ticket).catch(() => {});

    return res.json({
      success: true,
      reason: claimRes.reason,
      ticket: formatTicket(claimRes.ticket, true),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /staff/tickets/${req.params.id}/take error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/staff/tickets/:id/reply
 */
router.post('/staff/tickets/:id/reply', requireSupport, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const existing = await SupportTicket.findById(id).select('status assignedTo').lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (existing.status === 'escalated' && !isModeratorOrAbove(req.user)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (
      existing.assignedTo &&
      String(existing.assignedTo) !== String(req.user._id) &&
      !isModeratorOrAbove(req.user)
    ) {
      return res.status(403).json({
        success: false,
        error: 'TICKET_ASSIGNED_TO_OTHER',
        message: 'Обращение закреплено за другим сотрудником',
      });
    }

    const { text = '', imageBase64 = null } = req.body || {};
    const cleanText = typeof text === 'string' ? text.trim() : '';

    if (!cleanText && !imageBase64) {
      return res.status(400).json({ success: false, error: 'EMPTY_MESSAGE', message: 'Введите ответ или прикрепите фото' });
    }
    if (cleanText.length > 4000) {
      return res.status(400).json({ success: false, error: 'TEXT_TOO_LONG', message: 'Максимум 4000 символов' });
    }

    let parsedImage = null;
    if (imageBase64 !== null && imageBase64 !== undefined && imageBase64 !== '') {
      const imgRes = validateImageBase64(imageBase64);
      if (!imgRes.ok) {
        return res.status(400).json({ success: false, error: imgRes.error, message: imgRes.message });
      }
      parsedImage = imgRes;
    }

    const replyRes = await supportService.addReply({
      ticketId: id,
      senderUser: req.user,
      text: cleanText,
      mediaType: parsedImage ? 'photo' : null,
      mediaFileId: null,
      asRole: req.user.role,
    });

    if (!replyRes.ok) {
      if (replyRes.reason === 'TICKET_CLOSED') {
        return res.status(409).json({ success: false, error: 'TICKET_CLOSED', message: 'Обращение уже закрыто' });
      }
      return res.status(400).json({ success: false, error: replyRes.reason || 'REPLY_FAILED' });
    }

    if (parsedImage) {
      await SupportMessage.updateOne(
        { _id: replyRes.message._id },
        { $set: { mediaDataUrl: parsedImage.dataUrl } }
      );
      replyRes.message.mediaDataUrl = parsedImage.dataUrl;
    }

    await Promise.all([
      supportNotify.notifyBuyerStaffReply(replyRes.ticket, req.user, replyRes.message).catch(() => {}),
      supportNotify.syncTicketCardInChats(replyRes.ticket).catch(() => {}),
    ]);

    return res.json({
      success: true,
      ticket: formatTicket(replyRes.ticket, true),
      message: formatSupportMessage(replyRes.message, id, true),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /staff/tickets/${req.params.id}/reply error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/staff/tickets/:id/escalate
 */
router.post('/staff/tickets/:id/escalate', requireSupport, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const existing = await SupportTicket.findById(id).select('status assignedTo').lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (existing.status === 'closed') {
      return res.status(409).json({ success: false, error: 'TICKET_CLOSED', message: 'Обращение уже закрыто' });
    }
    if (existing.status === 'escalated') {
      return res.status(409).json({ success: false, error: 'ALREADY_ESCALATED', message: 'Обращение уже эскалировано' });
    }
    if (
      existing.assignedTo &&
      String(existing.assignedTo) !== String(req.user._id) &&
      !isModeratorOrAbove(req.user)
    ) {
      return res.status(403).json({
        success: false,
        error: 'TICKET_ASSIGNED_TO_OTHER',
        message: 'Обращение закреплено за другим сотрудником',
      });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const escRes = await supportService.escalateTicket({
      ticketId: id,
      staffUser: req.user,
      reason,
    });

    if (!escRes.ok) {
      return res.status(409).json({ success: false, error: escRes.reason || 'ESCALATE_FAILED' });
    }

    await supportNotify.notifyEscalation(escRes.ticket, req.user, reason).catch(() => {});

    return res.json({
      success: true,
      ticket: formatTicket(escRes.ticket, true),
      message: formatSupportMessage(escRes.message, id, true),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /staff/tickets/${req.params.id}/escalate error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/staff/tickets/:id/close
 */
router.post('/staff/tickets/:id/close', requireSupport, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_TICKET_ID' });
    }

    const existing = await SupportTicket.findById(id).select('status assignedTo').lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: 'TICKET_NOT_FOUND' });
    }
    if (existing.status === 'escalated' && !isModeratorOrAbove(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Эскалированное обращение может закрыть только модератор или администратор',
      });
    }
    if (existing.status === 'open' && !existing.assignedTo && !isModeratorOrAbove(req.user)) {
      return res.status(409).json({
        success: false,
        error: 'TAKE_TICKET_FIRST',
        message: 'Сначала возьмите обращение в работу',
      });
    }
    if (
      existing.assignedTo &&
      String(existing.assignedTo) !== String(req.user._id) &&
      !isModeratorOrAbove(req.user)
    ) {
      return res.status(403).json({
        success: false,
        error: 'TICKET_ASSIGNED_TO_OTHER',
        message: 'Обращение закреплено за другим сотрудником',
      });
    }

    const closeRes = await supportService.closeTicket({
      ticketId: id,
      actorUser: req.user,
      reason: 'resolved',
    });

    if (!closeRes.ok) {
      return res.status(409).json({ success: false, error: 'ALREADY_CLOSED', message: 'Обращение уже закрыто' });
    }

    await Promise.all([
      supportNotify.notifyTicketClosedToBuyer(closeRes.ticket).catch(() => {}),
      supportNotify.syncTicketCardInChats(closeRes.ticket).catch(() => {}),
    ]);

    return res.json({
      success: true,
      ticket: formatTicket(closeRes.ticket, true),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /staff/tickets/${req.params.id}/close error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

// ─── 3. Модерация команды и настройки ───────────────────────────────────────

/**
 * GET /api/v1/support/mod/team
 */
router.get('/mod/team', requireModerator, async (req, res) => {
  try {
    const [staff, counts, audit] = await Promise.all([
      supportService.getStaffTeamList(),
      supportService.getQueuesCounts(req.user._id),
      supportService.getStaffAuditLogs(1, 10),
    ]);

    return res.json({
      success: true,
      team: staff.map(formatStaffUser),
      onDutyCount: counts.onDutyCount,
      auditLogs: audit.items.map(formatAuditLog),
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /mod/team error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/mod/staff/:id/stats
 */
router.get('/mod/staff/:id/stats', requireModerator, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'INVALID_USER_ID' });
    }

    const rawPeriod = String(req.query.period || '30d').toLowerCase();
    const period = ['today', '7d', '30d', 'all'].includes(rawPeriod) ? rawPeriod : '30d';

    const target = await User.findById(id)
      .select('telegramId username firstName lastName role supportOnDuty supportLastActiveAt roleChangedAt roleChangedBy isBanned createdAt')
      .lean();

    if (!target) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    const stats = await supportService.getStaffActivityStats(id, period);

    return res.json({
      success: true,
      period,
      user: formatStaffUser(target),
      stats,
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /mod/staff/${req.params.id}/stats error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/v1/support/mod/staff/role
 */
router.post('/mod/staff/role', requireModerator, async (req, res) => {
  try {
    const { queryOrId, role, reason = '' } = req.body || {};
    const cleanQuery = typeof queryOrId === 'string' || typeof queryOrId === 'number'
      ? String(queryOrId).trim()
      : '';

    if (!cleanQuery) {
      return res.status(400).json({
        success: false,
        error: 'QUERY_REQUIRED',
        message: 'Укажите ID, Telegram ID или @username пользователя',
      });
    }

    let targetUser = null;
    if (mongoose.isValidObjectId(cleanQuery) && /^[0-9a-fA-F]{24}$/.test(cleanQuery)) {
      targetUser = await User.findById(cleanQuery);
    } else if (/^\d+$/.test(cleanQuery)) {
      targetUser = await User.findOne({ telegramId: Number(cleanQuery) });
    } else {
      const cleanUsername = cleanQuery.replace(/^@/, '').trim().slice(0, 64);
      if (!cleanUsername) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_USER_QUERY',
          message: 'Укажите корректный username, Telegram ID или ObjectId пользователя',
        });
      }
      targetUser = await User.findOne({ username: new RegExp(`^${escapeRegex(cleanUsername)}$`, 'i') });
    }

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Пользователь не найден' });
    }

    const assignRes = await supportService.assignStaffRole({
      actorUser: req.user,
      targetUser,
      newRole: role,
      reason: typeof reason === 'string' ? reason.trim().slice(0, 300) : '',
    });

    if (!assignRes.ok) {
      if (assignRes.error === 'CANNOT_ESCALATE_ROLE') {
        return res.status(403).json({
          success: false,
          error: 'CANNOT_ESCALATE_ROLE',
          message: 'Недостаточно прав для назначения этой роли',
        });
      }
      if (assignRes.error === 'FORBIDDEN') {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      return res.status(400).json({
        success: false,
        error: assignRes.error || 'ROLE_UPDATE_FAILED',
        message: assignRes.error === 'CANNOT_MODIFY_SELF' ? 'Нельзя изменить собственную роль' : 'Некорректная роль',
      });
    }

    if (assignRes.changed) {
      await supportNotify.notifyOwnerRoleChange({
        actorUser: req.user,
        targetUser: assignRes.user,
        oldRole: assignRes.oldRole,
        newRole: assignRes.newRole,
        reason: typeof reason === 'string' ? reason.trim() : '',
      }).catch(() => {});
    }

    return res.json({
      success: true,
      changed: Boolean(assignRes.changed),
      oldRole: assignRes.oldRole,
      newRole: assignRes.newRole,
      user: formatStaffUser(assignRes.user),
    });
  } catch (err) {
    logger.error(`[SupportAPI] POST /mod/staff/role error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/mod/audit-logs
 */
router.get('/mod/audit-logs', requireModerator, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 15));
    const data = await supportService.getStaffAuditLogs(page, limit);

    return res.json({
      success: true,
      logs: data.items.map(formatAuditLog),
      total: data.total,
      page: data.page,
      totalPages: data.totalPages,
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /mod/audit-logs error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/v1/support/mod/settings
 */
router.get('/mod/settings', requireModerator, async (req, res) => {
  try {
    const settings = await settingsCache.getSettings();
    const payload = {
      supportChatId: settings?.supportChatId ?? null,
      supportChatTitle: settings?.supportChatTitle || '',
      supportMaxOpenPerUser: settings?.supportMaxOpenPerUser ?? 3,
      supportSlaMinutes: settings?.supportSlaMinutes ?? 15,
      supportAutoCloseHours: settings?.supportAutoCloseHours ?? 48,
      supportQuickReplies: Array.isArray(settings?.supportQuickReplies) ? settings.supportQuickReplies : [],
    };

    return res.json({
      success: true,
      ...payload,
      settings: payload,
      canEditSettings: isAdminOrAbove(req.user),
    });
  } catch (err) {
    logger.error(`[SupportAPI] GET /mod/settings error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

/**
 * PATCH /api/v1/support/admin/settings (строго requireAdmin!)
 */
router.patch('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const {
      supportChatId,
      supportMaxOpenPerUser,
      supportSlaMinutes,
      supportAutoCloseHours,
      supportQuickReplies,
    } = req.body || {};

    let settings = await Settings.findOne({ name: 'global' });
    if (!settings) {
      settings = new Settings({ name: 'global' });
    }

    if (supportChatId !== undefined) {
      if (supportChatId === null || supportChatId === '') {
        settings.supportChatId = null;
        settings.supportChatTitle = '';
      } else {
        const cid = Number(supportChatId);
        if (!Number.isInteger(cid) || cid >= 0) {
          return res.status(400).json({
            success: false,
            error: 'INVALID_CHAT_ID',
            message: 'ID чата группы должен быть отрицательным целым числом (например -1001234567890)',
          });
        }
        const bot = notif.getBotInstance();
        if (bot) {
          try {
            const chat = await bot.telegram.getChat(cid);
            if (!chat || !['group', 'supergroup'].includes(chat.type)) {
              return res.status(400).json({
                success: false,
                error: 'INVALID_SUPPORT_CHAT',
                message: 'Указанный чат не является группой или супергруппой Telegram',
              });
            }
            settings.supportChatTitle = chat.title || '';
          } catch (chatErr) {
            return res.status(400).json({
              success: false,
              error: 'INVALID_SUPPORT_CHAT',
              message: `Бот не имеет доступа к чату ${cid}: ${chatErr.message}`,
            });
          }
        }
        settings.supportChatId = cid;
      }
    }

    if (supportMaxOpenPerUser !== undefined) {
      const val = Number(supportMaxOpenPerUser);
      if (!Number.isInteger(val) || val < 1 || val > 20) {
        return res.status(400).json({ success: false, error: 'INVALID_MAX_OPEN', message: 'Лимит открытых тикетов: от 1 до 20' });
      }
      settings.supportMaxOpenPerUser = val;
    }

    if (supportSlaMinutes !== undefined) {
      const val = Number(supportSlaMinutes);
      if (!Number.isInteger(val) || val < 1 || val > 1440) {
        return res.status(400).json({ success: false, error: 'INVALID_SLA_MINUTES', message: 'SLA должен быть от 1 до 1440 минут' });
      }
      settings.supportSlaMinutes = val;
    }

    if (supportAutoCloseHours !== undefined) {
      const val = Number(supportAutoCloseHours);
      if (!Number.isInteger(val) || val < 1 || val > 720) {
        return res.status(400).json({ success: false, error: 'INVALID_AUTO_CLOSE', message: 'Автозакрытие: от 1 до 720 часов' });
      }
      settings.supportAutoCloseHours = val;
    }

    if (supportQuickReplies !== undefined) {
      if (!Array.isArray(supportQuickReplies) || supportQuickReplies.length > 20) {
        return res.status(400).json({ success: false, error: 'INVALID_QUICK_REPLIES', message: 'Быстрые ответы: массив до 20 шаблонов' });
      }
      const cleaned = supportQuickReplies
        .map((s) => (typeof s === 'string' ? s.trim().slice(0, 500) : ''))
        .filter(Boolean);
      settings.supportQuickReplies = cleaned;
    }

    await settings.save();
    settingsCache.invalidateCache(settings);

    const payload = {
      supportChatId: settings.supportChatId ?? null,
      supportChatTitle: settings.supportChatTitle || '',
      supportMaxOpenPerUser: settings.supportMaxOpenPerUser ?? 3,
      supportSlaMinutes: settings.supportSlaMinutes ?? 15,
      supportAutoCloseHours: settings.supportAutoCloseHours ?? 48,
      supportQuickReplies: Array.isArray(settings.supportQuickReplies) ? settings.supportQuickReplies : [],
    };

    return res.json({
      success: true,
      ...payload,
      settings: payload,
    });
  } catch (err) {
    logger.error(`[SupportAPI] PATCH /admin/settings error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
  }
});

module.exports = { supportRouter: router };

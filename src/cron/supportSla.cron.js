/**
 * Крон контроля SLA тикетов поддержки:
 * - каждые 3 минуты проверяет необработанные тикеты (status: 'open') старше supportSlaMinutes
 *   и шлёт напоминания (не чаще 1 раза в supportSlaMinutes по lastReminderAt);
 * - авто-закрывает тикеты (open / in_progress) с lastMessageAt старше supportAutoCloseHours,
 *   если последний ответил не покупатель или тикет висит в open без ответа.
 */

const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const { getSettings } = require('../services/settingsCache.service');
const supportService = require('../services/support.service');
const supportNotify = require('../services/supportNotify.service');
const logger = require('../config/logger');

const INTERVAL_MS = 3 * 60 * 1000;

const runSupportSlaCheck = async () => {
  if (mongoose.connection.readyState !== 1) return;

  const settings = await getSettings();
  const slaMinutes = Math.max(1, Number(settings?.supportSlaMinutes) || 15);
  const autoCloseHours = Math.max(1, Number(settings?.supportAutoCloseHours) || 48);

  const now = Date.now();
  const slaCutoff = new Date(now - slaMinutes * 60 * 1000);
  const autoCloseCutoff = new Date(now - autoCloseHours * 60 * 60 * 1000);

  // 1. SLA-напоминания по непринятым тикетам
  const overdueTickets = await SupportTicket.find({
    status: 'open',
    assignedTo: null,
    createdAt: { $lt: slaCutoff },
    $or: [
      { lastReminderAt: null },
      { lastReminderAt: { $lt: slaCutoff } },
    ],
  })
    .select('_id')
    .limit(50)
    .lean();

  for (const item of overdueTickets) {
    const claimedReminder = await SupportTicket.findOneAndUpdate(
      {
        _id: item._id,
        status: 'open',
        assignedTo: null,
        $or: [
          { lastReminderAt: null },
          { lastReminderAt: { $lt: slaCutoff } },
        ],
      },
      {
        $set: { lastReminderAt: new Date() },
        $inc: { reminderCount: 1 },
      },
      { new: true }
    );

    if (claimedReminder) {
      await supportNotify.notifySlaReminder(claimedReminder).catch(() => {});
    }
  }

  // 2. Авто-закрытие неактивных тикетов
  const staleTickets = await SupportTicket.find({
    status: { $in: ['open', 'in_progress'] },
    lastMessageAt: { $lt: autoCloseCutoff },
    $or: [
      { lastMessageByRole: { $ne: 'user' } },
      { status: 'open' },
    ],
  })
    .select('_id')
    .limit(100)
    .lean();

  for (const item of staleTickets) {
    const res = await supportService.closeTicket({
      ticketId: item._id,
      actorUser: null,
      reason: 'auto_timeout',
    });

    if (res?.ok && res.ticket) {
      await supportNotify.notifyTicketClosedToBuyer(res.ticket).catch(() => {});
      await supportNotify.syncTicketCardInChats(res.ticket).catch(() => {});
    }
  }
};

/**
 * @param {Telegraf} bot
 * @returns {NodeJS.Timeout} handle интервала (для clearInterval при остановке)
 */
const start = (bot) => {
  if (bot) {
    supportNotify.setBot(bot);
  }

  let running = false;
  const handle = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runSupportSlaCheck();
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        logger.warn('[supportSla.cron] Пропуск итерации: временная ошибка DNS.');
      } else {
        logger.error(`[supportSla.cron] Ошибка проверки SLA тикетов: ${err.message}`);
      }
    } finally {
      running = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = { start, runSupportSlaCheck };

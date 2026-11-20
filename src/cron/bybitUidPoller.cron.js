/**
 * src/cron/bybitUidPoller.cron.js
 *
 * Poller for Bybit UID payments:
 * - Runs every 20 seconds
 * - Automatically marks expired invoices where expiresAt <= now
 * - Finds pending invoices where expiresAt > now and checks them via Bybit API
 */

const mongoose = require('mongoose');
const BybitInvoice = require('../models/BybitInvoice');
const bybitUidPaymentService = require('../services/bybitUidPayment.service');
const logger = require('../config/logger');

const INTERVAL_MS = 20_000; // 20 seconds

let botInstance = null;

const setBot = (bot) => {
  botInstance = bot;
  bybitUidPaymentService.setBot(bot);
};

const poll = async (bot = botInstance) => {
  if (mongoose.connection.readyState !== 1) return;

  const now = new Date();

  // 1. Auto-unlock stuck 'processing' invoices older than 3 minutes
  const stuckThreshold = new Date(Date.now() - 3 * 60 * 1000);
  try {
    const unlockedRes = await BybitInvoice.updateMany(
      {
        status: 'processing',
        $or: [{ lockedAt: { $lte: stuckThreshold } }, { lockedAt: null }],
      },
      { $set: { status: 'pending', lockedAt: null } }
    );
    if (unlockedRes?.modifiedCount > 0) {
      logger.warn(
        `[Bybit UID Poller] Auto-unlocked ${unlockedRes.modifiedCount} stuck processing invoice(s)`
      );
    }
  } catch (err) {
    logger.error(`[Bybit UID Poller] Error unlocking stuck invoices: ${err.message}`);
  }

  // 2. Automatically mark expired invoices where expiresAt <= now
  try {
    const expiredRes = await BybitInvoice.updateMany(
      { status: 'pending', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } }
    );
    if (expiredRes?.modifiedCount > 0) {
      logger.info(
        `[Bybit UID Poller] Marked ${expiredRes.modifiedCount} invoices as expired`
      );
    }
  } catch (err) {
    logger.error(`[Bybit UID Poller] Error expiring invoices: ${err.message}`);
  }

  // 3. Batched fetch of pending invoices: query Bybit API ONCE per 20s cycle
  try {
    const pendingInvoices = await BybitInvoice.find({
      status: 'pending',
      expiresAt: { $gt: now },
    }).sort({ createdAt: 1 });

    if (!pendingInvoices || pendingInvoices.length === 0) return;

    // Fetch transactions from Bybit ONCE for all pending invoices
    const fetchRes = await bybitUidPaymentService.fetchRecentTransfers(50);
    if (!fetchRes.ok) {
      logger.warn(`[Bybit UID Poller] Batch fetch transfers failed: ${fetchRes.error}`);
      return;
    }

    const recentRecords = fetchRes.rows || [];

    for (const invoice of pendingInvoices) {
      // In-memory fast pre-check before database lock
      const hasMatch = recentRecords.some((r) => {
        if (r.coin && String(r.coin).toUpperCase() !== 'USDT') return false;
        if (r.status !== undefined && Number(r.status) !== 2) return false;
        const amountVal = parseFloat(r.amount);
        return !isNaN(amountVal) && Math.abs(amountVal - invoice.exactAmount) < 0.00001;
      });

      if (!hasMatch) {
        continue;
      }

      try {
        const result = await bybitUidPaymentService.checkInvoice(invoice._id, {
          bot: bot || botInstance,
          mockRecords: recentRecords,
        });
        if (result?.success && !result?.alreadyCompleted) {
          logger.info(
            `[Bybit UID Poller] Successfully matched & completed invoice ${invoice.invoiceNumber}`
          );
        }
      } catch (checkErr) {
        logger.error(
          `[Bybit UID Poller] Error checking invoice ${invoice.invoiceNumber}: ${checkErr.message}`
        );
      }
    }
  } catch (err) {
    logger.error(`[Bybit UID Poller] Error polling pending invoices: ${err.message}`);
  }
};

/**
 * Starts the recurring poller.
 * @param {Object} [bot]
 * @returns {NodeJS.Timeout} handle for clearInterval
 */
const start = (bot = null) => {
  if (bot) setBot(bot);

  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await poll(bot || botInstance);
    } catch (err) {
      logger.error(`[Bybit UID Poller] Interval error: ${err.message}`);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);

  return handle;
};

module.exports = {
  start,
  init: start,
  poll,
  setBot,
  INTERVAL_MS,
};

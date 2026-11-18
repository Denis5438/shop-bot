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

  // 1. Automatically mark expired invoices where expiresAt <= now
  try {
    const expiredRes = await BybitInvoice.updateMany(
      { status: 'pending', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } }
    );
    if (expiredRes.modifiedCount > 0) {
      logger.info(
        `[Bybit UID Poller] Marked ${expiredRes.modifiedCount} invoices as expired`
      );
    }
  } catch (err) {
    logger.error(`[Bybit UID Poller] Error expiring invoices: ${err.message}`);
  }

  // 2. Find pending invoices where expiresAt > now and check them
  try {
    const pendingInvoices = await BybitInvoice.find({
      status: 'pending',
      expiresAt: { $gt: now },
    }).sort({ createdAt: 1 });

    if (pendingInvoices.length === 0) return;

    for (const invoice of pendingInvoices) {
      try {
        const result = await bybitUidPaymentService.checkInvoice(invoice._id, {
          bot: bot || botInstance,
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

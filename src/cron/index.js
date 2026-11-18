/**
 * src/cron/index.js
 *
 * Central index of background cron tasks.
 */

const bybitUidPoller = require('./bybitUidPoller.cron');
const staleOrders = require('./staleOrders.cron');
const retryActivation = require('./retryActivation.cron');
const referralReconcile = require('./referralReconcile.cron');
const autoConfirm = require('./autoConfirm');
const supplierCatalogSync = require('./supplierCatalogSync.cron');

module.exports = {
  bybitUidPoller,
  staleOrders,
  retryActivation,
  referralReconcile,
  autoConfirm,
  supplierCatalogSync,
};

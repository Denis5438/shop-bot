/* eslint-disable no-console */
require('dotenv').config();

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config');
const { PREFIX, decryptSecret } = require('../src/services/secretBox.service');

const SETTINGS_SECRET_FIELDS = [
  'cardNumber',
  'cardHolder',
  'bybitApiKey',
  'bybitApiSecret',
  'plategaMerchantId',
  'plategaSecret',
  'geminiApiKey',
];

const SUPPLIER_SECRET_FIELDS = ['apiKey'];

async function runRollback() {
  console.log('[Rollback] Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;

  // 1. Settings
  const settingsColl = db.collection('settings');
  const settingsDocs = await settingsColl.find({}).toArray();
  let rolledBackSettings = 0;

  for (const doc of settingsDocs) {
    const updates = {};
    for (const field of SETTINGS_SECRET_FIELDS) {
      const val = doc[field];
      if (typeof val === 'string' && val.startsWith(PREFIX)) {
        updates[field] = decryptSecret(val);
      }
    }
    if (Object.keys(updates).length > 0) {
      await settingsColl.updateOne({ _id: doc._id }, { $set: updates });
      rolledBackSettings++;
      console.log(`[Rollback] Decrypted ${Object.keys(updates).length} secrets in settings doc ${doc._id}`);
    }
  }

  // 2. SupplierConfigs
  const supplierColl = db.collection('supplierconfigs');
  const supplierDocs = await supplierColl.find({}).toArray();
  let rolledBackSuppliers = 0;

  for (const doc of supplierDocs) {
    const updates = {};
    for (const field of SUPPLIER_SECRET_FIELDS) {
      const val = doc[field];
      if (typeof val === 'string' && val.startsWith(PREFIX)) {
        updates[field] = decryptSecret(val);
      }
    }
    if (Object.keys(updates).length > 0) {
      await supplierColl.updateOne({ _id: doc._id }, { $set: updates });
      rolledBackSuppliers++;
      console.log(`[Rollback] Decrypted ${Object.keys(updates).length} secrets in supplier doc ${doc._id}`);
    }
  }

  console.log(`[Rollback] Completed: ${rolledBackSettings} settings, ${rolledBackSuppliers} supplier configs decrypted.`);
  await mongoose.connection.close();
}

if (require.main === module) {
  runRollback()
    .then(() => {
      console.log('[Rollback] Success.');
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[Rollback] Failed: ${err.message}`, err);
      try {
        await mongoose.connection.close();
      } catch (_) {}
      process.exit(1);
    });
}

module.exports = { runRollback };

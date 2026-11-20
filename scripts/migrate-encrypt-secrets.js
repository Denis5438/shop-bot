/* eslint-disable no-console */
require('dotenv').config();

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config');
const { PREFIX, encryptSecret } = require('../src/services/secretBox.service');

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

async function runMigration() {
  console.log('[Migration] Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;

  // 1. Settings
  const settingsColl = db.collection('settings');
  const settingsDocs = await settingsColl.find({}).toArray();
  let migratedSettings = 0;

  for (const doc of settingsDocs) {
    const updates = {};
    for (const field of SETTINGS_SECRET_FIELDS) {
      const val = doc[field];
      if (typeof val === 'string' && val.trim() !== '' && !val.startsWith(PREFIX)) {
        updates[field] = encryptSecret(val);
      }
    }
    if (Object.keys(updates).length > 0) {
      await settingsColl.updateOne({ _id: doc._id }, { $set: updates });
      migratedSettings++;
      console.log(`[Migration] Encrypted ${Object.keys(updates).length} secrets in settings doc ${doc._id}`);
    }
  }

  // 2. SupplierConfigs
  const supplierColl = db.collection('supplierconfigs');
  const supplierDocs = await supplierColl.find({}).toArray();
  let migratedSuppliers = 0;

  for (const doc of supplierDocs) {
    const updates = {};
    for (const field of SUPPLIER_SECRET_FIELDS) {
      const val = doc[field];
      if (typeof val === 'string' && val.trim() !== '' && !val.startsWith(PREFIX)) {
        updates[field] = encryptSecret(val);
      }
    }
    if (Object.keys(updates).length > 0) {
      await supplierColl.updateOne({ _id: doc._id }, { $set: updates });
      migratedSuppliers++;
      console.log(`[Migration] Encrypted ${Object.keys(updates).length} secrets in supplier doc ${doc._id}`);
    }
  }

  console.log(`[Migration] Completed: ${migratedSettings} settings, ${migratedSuppliers} supplier configs encrypted.`);
  await mongoose.connection.close();
}

if (require.main === module) {
  runMigration()
    .then(() => {
      console.log('[Migration] Success.');
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[Migration] Failed: ${err.message}`, err);
      try {
        await mongoose.connection.close();
      } catch (_) {}
      process.exit(1);
    });
}

module.exports = { runMigration };

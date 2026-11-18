/**
 * scripts/check_bybit_api_live.js
 * Verifies if the Bybit API Key and Secret are active and working with Bybit API v5.
 */

require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

async function testBybitKey() {
  let apiKey = process.env.BYBIT_API_KEY;
  let apiSecret = process.env.BYBIT_API_SECRET;

  // Also try MongoDB Settings if available
  if (process.env.MONGODB_URI) {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
      const Settings = require('../src/models/Settings');
      const settings = await Settings.findOne({ name: 'global' }).lean();
      if (settings?.bybitApiKey) apiKey = settings.bybitApiKey;
      if (settings?.bybitApiSecret) apiSecret = settings.bybitApiSecret;
      await mongoose.disconnect();
    } catch (_) {}
  }

  console.log('--- BYBIT API KEY VERIFICATION ---');
  console.log('API Key:', apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : 'NOT FOUND');
  console.log('API Secret:', apiSecret ? `[PRESENT, length: ${apiSecret.length}]` : 'NOT FOUND');

  if (!apiKey || !apiSecret) {
    console.log('❌ Error: API Key or Secret is missing.');
    return;
  }

  // 1. Test /v5/user/query-api (Checks API Key validity, permissions, IP whitelist)
  console.log('\n[1] Testing /v5/user/query-api (Key info & permissions)...');
  const timestamp1 = Date.now().toString();
  const recvWindow = '5000';
  const qs1 = '';
  const sign1 = crypto
    .createHmac('sha256', apiSecret)
    .update(timestamp1 + apiKey + recvWindow + qs1)
    .digest('hex');

  try {
    const res1 = await axios.get('https://api.bybit.com/v5/user/query-api', {
      headers: {
        'User-Agent': 'shop-bot/1.0',
        Accept: 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp1,
        'X-BAPI-SIGN': sign1,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    console.log('HTTP Status:', res1.status);
    console.log('retCode:', res1.data?.retCode);
    console.log('retMsg:', res1.data?.retMsg);
    if (res1.data?.result) {
      console.log('Account UID (from API):', res1.data.result.userID || res1.data.result.userId);
      console.log('Key Permissions:', JSON.stringify(res1.data.result.permissions || {}));
      console.log('IP Whitelist:', res1.data.result.ips || 'No IP restriction');
    }
  } catch (err) {
    console.log('Error testing query-api:', err.message);
  }

  // 2. Test /v5/asset/deposit/query-internal-record (Used for deposit tracking)
  console.log('\n[2] Testing /v5/asset/deposit/query-internal-record (Deposit tracking)...');
  const timestamp2 = Date.now().toString();
  const qs2 = 'coin=USDT&limit=5';
  const sign2 = crypto
    .createHmac('sha256', apiSecret)
    .update(timestamp2 + apiKey + recvWindow + qs2)
    .digest('hex');

  try {
    const res2 = await axios.get(`https://api.bybit.com/v5/asset/deposit/query-internal-record?${qs2}`, {
      headers: {
        'User-Agent': 'shop-bot/1.0',
        Accept: 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp2,
        'X-BAPI-SIGN': sign2,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    console.log('HTTP Status:', res2.status);
    console.log('retCode:', res2.data?.retCode);
    console.log('retMsg:', res2.data?.retMsg);
    if (res2.data?.retCode === 0) {
      console.log('✅ SUCCESS! Bybit internal records API is fully accessible.');
      const rows = res2.data?.result?.rows || [];
      console.log(`Found ${rows.length} internal transfer record(s) on Bybit.`);
    } else {
      console.log('❌ Bybit error:', res2.data?.retMsg);
    }
  } catch (err) {
    console.log('Error testing deposit records:', err.message);
  }
}

testBybitKey().catch(console.error);

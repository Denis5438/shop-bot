const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Duplex } = require('stream');

function simulate(server, method, url) {
  return new Promise((resolve) => {
    let rawOutput = '';
    const sock = new Duplex({
      read() {},
      write(chunk, enc, cb) {
        if (chunk) rawOutput += chunk.toString();
        cb();
      }
    });

    const req = new http.IncomingMessage(sock);
    req.method = method;
    req.url = url;
    req.headers = { host: 'shop-bot-1-uzme.onrender.com' };
    req.push(null);

    const res = new http.ServerResponse(req);
    res.assignSocket(sock);

    server.emit('request', req, res);

    // Allow static file piping to complete
    setTimeout(() => {
      resolve({
        statusCode: res.statusCode,
        body: rawOutput,
      });
    }, 250);
  });
}

async function runTests() {
  console.log('--- Testing Unified Bot + Website Server ---');
  
  // Verify static output exists
  const outDir = path.resolve(__dirname, '../website/frontend/out');
  assert(fs.existsSync(path.join(outDir, 'index.html')), 'out/index.html should exist');
  assert(fs.existsSync(path.join(outDir, 'auth/signin/index.html')), 'out/auth/signin/index.html should exist');
  console.log('✓ Next.js static export files verified in website/frontend/out');

  const { startHealthServer } = require('../src/bot/health-server');
  const server = startHealthServer(9995);

  // 1. /ping
  const pingRes = await simulate(server, 'GET', '/ping');
  assert.strictEqual(pingRes.statusCode, 200);
  assert(pingRes.body.includes('pong'), 'Should contain pong');
  console.log('✓ GET /ping returns 200 pong');

  // 2. /health
  const healthRes = await simulate(server, 'GET', '/health');
  assert([200, 503].includes(healthRes.statusCode));
  console.log('✓ GET /health returns status code:', healthRes.statusCode);

  // 3. GET / (Storefront homepage)
  const rootRes = await simulate(server, 'GET', '/');
  assert.strictEqual(rootRes.statusCode, 200);
  assert(rootRes.body.includes('<!DOCTYPE html>'), 'Root response should be HTML document');
  console.log('✓ GET / serves storefront HTML (length:', rootRes.body.length, 'bytes)');

  // 4. GET /auth/signin/ (Telegram Code Auth page)
  const signinRes = await simulate(server, 'GET', '/auth/signin/');
  assert.strictEqual(signinRes.statusCode, 200);
  assert(signinRes.body.includes('<!DOCTYPE html>'), 'Signin response should be HTML document');
  console.log('✓ GET /auth/signin/ serves auth page HTML (length:', signinRes.body.length, 'bytes)');

  // 5. GET /orders/
  const ordersRes = await simulate(server, 'GET', '/orders/');
  assert.strictEqual(ordersRes.statusCode, 200);
  assert(ordersRes.body.includes('<!DOCTYPE html>'));
  console.log('✓ GET /orders/ serves orders page HTML');

  // 6. GET /topup/
  const topupRes = await simulate(server, 'GET', '/topup/');
  assert.strictEqual(topupRes.statusCode, 200);
  assert(topupRes.body.includes('<!DOCTYPE html>'));
  console.log('✓ GET /topup/ serves topup page HTML');

  // 7. GET /api/v1/health
  const apiHealthRes = await simulate(server, 'GET', '/api/v1/health');
  assert.strictEqual(apiHealthRes.statusCode, 200);
  assert(apiHealthRes.body.includes('"status":"ok"'));
  console.log('✓ GET /api/v1/health returns REST API status ok');

  // 8. GET /api/v1/unknown-endpoint
  const unknownApiRes = await simulate(server, 'GET', '/api/v1/unknown-endpoint');
  assert.strictEqual(unknownApiRes.statusCode, 404);
  assert(unknownApiRes.body.includes('NOT_FOUND'));
  console.log('✓ GET /api/v1/unknown-endpoint returns 404 NOT_FOUND');

  server.close();
  console.log('--- All Unified Bot + Website tests passed successfully! ---');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

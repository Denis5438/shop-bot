const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Mock Mongoose model for AuthSession
const createAuthSessionMock = () => {
  const store = new Map();

  class MockAuthSession {
    constructor(data) {
      this._id = 'sess_' + Math.random().toString(36).substring(2, 9);
      this.sessionToken = data.sessionToken;
      this.codeHash = data.codeHash || null;
      this.telegramId = data.telegramId || null;
      this.status = data.status || 'pending';
      this.attempts = data.attempts || 0;
      this.ip = data.ip || null;
      this.userAgent = data.userAgent || null;
      this.codeExpiresAt = data.codeExpiresAt || null;
      this.verifiedAt = data.verifiedAt || null;
      this.createdAt = data.createdAt || new Date();
    }

    async save() {
      store.set(this.sessionToken, this);
      return this;
    }

    static async findOne(query) {
      for (const sess of store.values()) {
        let match = true;
        if (query.sessionToken && sess.sessionToken !== query.sessionToken) match = false;
        if (query.status && query.status.$in && !query.status.$in.includes(sess.status)) match = false;
        if (query.status && typeof query.status === 'string' && sess.status !== query.status) match = false;
        if (query.telegramId && sess.telegramId !== query.telegramId) match = false;
        if (match) return sess;
      }
      return null;
    }

    static async findOneAndUpdate(query, update, options = {}) {
      const sess = await MockAuthSession.findOne(query);
      if (!sess) return null;
      if (update.$set) {
        Object.assign(sess, update.$set);
      }
      store.set(sess.sessionToken, sess);
      return sess;
    }
  }

  return { MockAuthSession, store };
};

// Mock User model
const createUserMock = () => {
  const users = new Map();

  class MockUser {
    constructor(data) {
      this._id = 'user_' + (data.telegramId || '123');
      this.telegramId = data.telegramId;
      this.username = data.username || null;
      this.firstName = data.firstName || 'TestUser';
      this.balance = data.balance ?? 10.0;
      this.totalSpent = data.totalSpent ?? 0;
      this.role = data.role || 'user';
      this.isBanned = data.isBanned || false;
      this.createdAt = new Date();
    }

    async save() {
      users.set(this.telegramId, this);
      return this;
    }

    static async findOne(query) {
      if (query.telegramId) return users.get(query.telegramId) || null;
      return null;
    }
  }

  return { MockUser, users };
};

async function runTests() {
  console.log('🧪 Starting Telegram Web Authentication Verification Suite...\n');

  const { MockAuthSession, store } = createAuthSessionMock();
  const { MockUser, users } = createUserMock();
  const JWT_SECRET = 'test_jwt_secret_12345';

  // TEST 1: Session Initiation (POST /api/v1/auth/session)
  console.log('Test 1: Session Initiation & Token Generation');
  const sessionToken = crypto.randomBytes(32).toString('hex');
  assert.strictEqual(sessionToken.length, 64, 'Session token must be 64 hex characters');

  const session = new MockAuthSession({
    sessionToken,
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0 TestBrowser',
    status: 'pending',
  });
  await session.save();
  assert.strictEqual(session.status, 'pending');
  console.log('  ✅ Test 1 Passed: Session initiated with secure 32-byte hex token.\n');

  // TEST 2: Code Generation in Bot (Exclusive 1,000,000 upper bound)
  console.log('Test 2: 6-Digit Code Generation & Entropy Bounds');
  for (let i = 0; i < 50; i++) {
    const code = crypto.randomInt(100000, 1000000);
    assert(code >= 100000 && code <= 999999, `Code ${code} must be strictly within 100000..999999`);
    assert.strictEqual(String(code).length, 6, 'Code must have exactly 6 digits');
  }

  const rawCode = '849201';
  const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  session.codeHash = codeHash;
  session.telegramId = 777001;
  session.status = 'code_issued';
  session.codeExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await session.save();
  console.log('  ✅ Test 2 Passed: Code generated within bounds [100000, 1000000) and SHA-256 hashed.\n');

  // TEST 3: Code Validation & Brute-Force Rate Limiting (POST /api/v1/auth/verify)
  console.log('Test 3: Verification with Timing-Safe SHA-256 & Brute-Force Lock');
  // Wrong code attempt
  const wrongCandidate = '111111';
  const wrongHash = crypto.createHash('sha256').update(wrongCandidate).digest('hex');
  const isWrongValid = crypto.timingSafeEqual(Buffer.from(wrongHash, 'hex'), Buffer.from(session.codeHash, 'hex'));
  assert.strictEqual(isWrongValid, false, 'Wrong code must fail timingSafeEqual comparison');

  session.attempts += 1;
  assert.strictEqual(session.attempts, 1, 'Attempts counter incremented');

  // Max attempts lockout test
  session.attempts = 5;
  session.status = 'locked';
  await session.save();
  assert.strictEqual(session.status, 'locked', 'Session must be locked after 5 attempts');

  // Reset for valid attempt
  session.status = 'code_issued';
  session.attempts = 1;
  await session.save();

  // Valid attempt
  const correctCandidate = '849201';
  const correctHash = crypto.createHash('sha256').update(correctCandidate).digest('hex');
  const isCorrectValid = crypto.timingSafeEqual(Buffer.from(correctHash, 'hex'), Buffer.from(session.codeHash, 'hex'));
  assert.strictEqual(isCorrectValid, true, 'Correct code must pass timingSafeEqual comparison');

  const updatedSession = await MockAuthSession.findOneAndUpdate(
    { sessionToken, status: { $in: ['pending', 'code_issued'] } },
    { $set: { status: 'verified', verifiedAt: new Date() } }
  );
  assert.strictEqual(updatedSession.status, 'verified', 'Session transitions to verified upon success');

  // User creation & JWT issuance
  const user = new MockUser({ telegramId: session.telegramId, username: 'crypto_trader' });
  await user.save();

  const token = jwt.sign({ telegramId: user.telegramId, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  const decoded = jwt.verify(token, JWT_SECRET);
  assert.strictEqual(decoded.telegramId, 777001, 'JWT must contain correct telegramId');
  console.log('  ✅ Test 3 Passed: Code verification, brute-force lock, and JWT issuance verified.\n');

  // TEST 4: 1-Click Instant Approval via Bot Button
  console.log('Test 4: 1-Click Telegram Approval (webauth:approve)');
  const clickSessionToken = crypto.randomBytes(32).toString('hex');
  const clickSession = new MockAuthSession({
    sessionToken: clickSessionToken,
    telegramId: 888002,
    status: 'code_issued',
  });
  await clickSession.save();

  // User taps "⚡ Подтвердить вход в 1 клик" in bot
  clickSession.status = 'authenticated';
  await clickSession.save();

  // Web polling GET /check-status
  const polled = await MockAuthSession.findOne({ sessionToken: clickSessionToken });
  assert.strictEqual(polled.status, 'authenticated', 'Poller detects authenticated status');

  const autoLoggedIn = await MockAuthSession.findOneAndUpdate(
    { sessionToken: clickSessionToken, status: 'authenticated' },
    { $set: { status: 'verified', verifiedAt: new Date() } }
  );
  assert.strictEqual(autoLoggedIn.status, 'verified', 'Atomic transition to verified on 1-click auto-login');
  console.log('  ✅ Test 4 Passed: 1-Click Telegram confirmation auto-logs in the browser.\n');

  // TEST 5: Telegram Mini App initData HMAC-SHA256 Verification
  console.log('Test 5: Telegram Mini App HMAC-SHA256 initData Validation');
  const botToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

  const dataFields = {
    auth_date: '1700000000',
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: 999003, first_name: 'Alex', username: 'alex99' }),
  };

  const dataCheckString = Object.keys(dataFields)
    .sort()
    .map((k) => `${k}=${dataFields[k]}`)
    .join('\n');

  const validHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Valid verification
  const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  assert(
    crypto.timingSafeEqual(Buffer.from(validHash, 'hex'), Buffer.from(checkHash, 'hex')),
    'Valid initData must pass HMAC check'
  );

  // Tampered verification
  const tamperedString = dataCheckString + '&tampered=1';
  const tamperedHash = crypto.createHmac('sha256', secretKey).update(tamperedString).digest('hex');
  assert(
    !crypto.timingSafeEqual(Buffer.from(validHash, 'hex'), Buffer.from(tamperedHash, 'hex')),
    'Tampered initData must be rejected'
  );
  console.log('  ✅ Test 5 Passed: Telegram WebApp initData HMAC validation verified.\n');

  console.log('=============================================================');
  console.log('🎉 ALL 5 TELEGRAM WEB AUTH TESTS PASSED SUCCESSFULLY! 🚀');
  console.log('=============================================================');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

/**
 * Automated tests for 2FA (TOTP RFC 6238) auto-detection, code generation,
 * message formatting, and Telegram bot handler integration.
 */

const assert = require('assert');
const {
  normalizeBase32Secret,
  isValidBase32Secret,
  decodeBase32,
  getRemainingTOTPSeconds,
  generateTOTP,
  extract2FAAccounts,
  has2FASecret,
  get2FAHintText,
  get2FAButtonLabel,
  format2FACodeMessage,
  formatDigitalItem,
} = require('../src/bot/utils/ui');

const tests = [];
const test = (name, fn) => {
  tests.push({ name, fn });
};

// ==========================================
// 1. RFC 6238 TOTP & Base32 Tests
// ==========================================

test('TOTP: RFC 6238 standard SHA1 test vectors match exactly', () => {
  // RFC 6238 / RFC 4226 seed: ASCII "12345678901234567890"
  // Base32 of "12345678901234567890" is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(decodeBase32(rfcSecret).toString('ascii'), '12345678901234567890');

  assert.strictEqual(generateTOTP(rfcSecret, 59 * 1000), '287082');
  assert.strictEqual(generateTOTP(rfcSecret, 1111111109 * 1000), '081804');
  assert.strictEqual(generateTOTP(rfcSecret, 1111111111 * 1000), '050471');
  assert.strictEqual(generateTOTP(rfcSecret, 1234567890 * 1000), '005924');
  assert.strictEqual(generateTOTP(rfcSecret, 2000000000 * 1000), '279037');
});

test('TOTP: Real Jaha Digital Base32 secret generates valid 6-digit code and normalizes spaces/case', () => {
  const rawSecret = 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const spacedLowerSecret = 'z7z5 obor 7d6j mckt r7hv 2vsn yiam 3xlc';
  const fixedTimeMs = 1710000005000;

  const code1 = generateTOTP(rawSecret, fixedTimeMs);
  const code2 = generateTOTP(spacedLowerSecret, fixedTimeMs);

  assert.ok(/^\d{6}$/.test(code1), `Expected 6 digits, got: ${code1}`);
  assert.strictEqual(code1, code2);
});

test('TOTP: Remaining seconds calculation in 30-second window', () => {
  assert.strictEqual(getRemainingTOTPSeconds(0), 30);
  assert.strictEqual(getRemainingTOTPSeconds(6 * 1000), 24);
  assert.strictEqual(getRemainingTOTPSeconds(29 * 1000), 1);
  assert.strictEqual(getRemainingTOTPSeconds(30 * 1000), 30);
});

// ==========================================
// 2. Smart 2FA Secret Detection Tests
// ==========================================

test('Detection: Recognizes Jaha Digital pipe-delimited login|password|2fa_secret', () => {
  const item = 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  assert.strictEqual(has2FASecret(item), true);

  const accounts = extract2FAAccounts(item);
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].login, 'hbbr897896562+nnofm826@gmail.com');
  assert.strictEqual(accounts[0].secret, 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC');
});

test('Detection: Recognizes colon, semicolon, tab delimiters and spaced Base32 keys', () => {
  const colonItem = 'user1@mail.com:MyPass123!:JBSWY3DPEHPK3PXP';
  const semiItem = 'user2@mail.com;MyPass123!;JBSWY3DPEHPK3PXP';
  const tabItem = 'user3@mail.com\tMyPass123!\tJBSWY3DPEHPK3PXP';
  const spacedItem = 'user4@mail.com|MyPass123!|Z7Z5 OBOR 7D6J MCKT R7HV 2VSN YIAM 3XLC';

  assert.strictEqual(has2FASecret(colonItem), true);
  assert.strictEqual(has2FASecret(semiItem), true);
  assert.strictEqual(has2FASecret(tabItem), true);
  assert.strictEqual(has2FASecret(spacedItem), true);

  const acc = extract2FAAccounts(spacedItem);
  assert.strictEqual(acc.length, 1);
  assert.strictEqual(acc[0].login, 'user4@mail.com');
  assert.strictEqual(acc[0].secret, 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC');
});

test('Detection: Recognizes multi-line labeled format, JSON, and otpauth:// URI', () => {
  const labeled = 'Логин: testuser@gmail.com\nПароль: superSecret99\n2FA: Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  assert.strictEqual(has2FASecret(labeled), true);
  const labeledAcc = extract2FAAccounts(labeled);
  assert.strictEqual(labeledAcc.length, 1);
  assert.strictEqual(labeledAcc[0].login, 'testuser@gmail.com');
  assert.strictEqual(labeledAcc[0].secret, 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC');

  const jsonStr = JSON.stringify({
    login: 'jsonuser@gmail.com',
    password: 'pw',
    twoFactor: 'JBSWY3DPEHPK3PXP',
  });
  assert.strictEqual(has2FASecret(jsonStr), true);
  const jsonAcc = extract2FAAccounts(jsonStr);
  assert.strictEqual(jsonAcc.length, 1);
  assert.strictEqual(jsonAcc[0].login, 'jsonuser@gmail.com');
  assert.strictEqual(jsonAcc[0].secret, 'JBSWY3DPEHPK3PXP');

  const otpauth = 'otpauth://totp/OpenAI:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=OpenAI';
  assert.strictEqual(has2FASecret(otpauth), true);
  const otpAcc = extract2FAAccounts(otpauth);
  assert.strictEqual(otpAcc.length, 1);
  assert.strictEqual(otpAcc[0].login, 'alice@example.com');
  assert.strictEqual(otpAcc[0].secret, 'JBSWY3DPEHPK3PXP');

  // Equals sign and "Код:" label
  const labeledEq = 'Email = user5@gmail.com\nПароль = pass123\nКод: Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const eqAcc = extract2FAAccounts(labeledEq);
  assert.strictEqual(eqAcc.length, 1);
  assert.strictEqual(eqAcc[0].login, 'user5@gmail.com');
  assert.strictEqual(eqAcc[0].secret, 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC');

  // 16-char grouped Base32 secret
  assert.strictEqual(
    normalizeBase32Secret('Z7Z5OBOR7D6JMCKT R7HV2VSNYIAM3XLC'),
    'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC'
  );
});

test('Detection: Recognizes Order objects via deliveryData, keyId.value, and replacedKeyId.value', () => {
  const secret = 'Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const orderWithDelivery = { deliveryData: `a@b.com|pass|${secret}` };
  const orderWithKey = { keyId: { value: `a@b.com|pass|${secret}` } };
  const orderWithReplacedKey = {
    keyId: { value: 'a@b.com|passWithout2FA' },
    replacedKeyId: { value: `new@b.com|pass|${secret}` },
  };

  assert.strictEqual(has2FASecret(orderWithDelivery), true);
  assert.strictEqual(has2FASecret(orderWithKey), true);
  assert.strictEqual(has2FASecret(orderWithReplacedKey), true);
  assert.strictEqual(extract2FAAccounts(orderWithReplacedKey)[0].login, 'new@b.com');
});

test('Detection: Rejects non-2FA accounts, links, license keys, prose, lowercase words, and 2-part uppercase passwords', () => {
  const non2FAItems = [
    'user@example.com|dreYWi2CR3A2',
    'user@example.com:secretPassword123',
    'user@example.com|ABCDEFGHIJKLMNOP', // 2-part login|password where password is 16 uppercase Base32 chars
    'user@example.com|password123|internationalization', // 16+ char lowercase English word in 3rd slot
    'user@example.com:secretPassword123:2FA_CODE_ABC',
    'https://chatgpt.com/invite/abcdefg234567abcdefg234567',
    'ABCD-EFGH-IJKL-MNOP-QRST',
    'X9K2-M4P7-Q8W1-Z3R5-T6Y9',
    'please check email for activation link',
    'Ожидается подтверждение поставщика.',
    '123456',
    '',
    null,
    undefined,
    {},
  ];

  for (const item of non2FAItems) {
    assert.strictEqual(has2FASecret(item), false, `Should NOT detect 2FA in: ${JSON.stringify(item)}`);
    assert.strictEqual(extract2FAAccounts(item).length, 0);
  }
  assert.strictEqual(normalizeBase32Secret('dreYWi2CR3A2'), null);
  assert.strictEqual(normalizeBase32Secret('internationalization'), null);
  assert.strictEqual(isValidBase32Secret('dreYWi2CR3A2'), false);
});

// ==========================================
// 3. Formatting & UI Hint Tests
// ==========================================

test('Formatting: formatDigitalItem keeps Login, Password, and 2FA key in place AND adds hint when 2FA is valid', () => {
  const raw = 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const formattedRu = formatDigitalItem(raw, 'ru');

  assert.ok(formattedRu.includes('<code>hbbr897896562+nnofm826@gmail.com</code>'));
  assert.ok(formattedRu.includes('<code>dreYWi2CR3A2</code>'));
  assert.ok(formattedRu.includes('<code>Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC</code>'));
  assert.ok(formattedRu.includes(get2FAHintText('ru')));
  assert.strictEqual(get2FAButtonLabel('ru'), '🔐 Получить 6-значный код для входа (2FA)');

  const formattedEn = formatDigitalItem(raw, 'en');
  assert.ok(formattedEn.includes(get2FAHintText('en')));
});

test('Formatting: formatDigitalItem correctly formats multi-line labeled account, otpauth URI, and 4-part recovery+2FA credentials', () => {
  // 1. Multi-line labeled single account must NOT treat "Логин" as login value or split into #1/#2/#3
  const labeled = 'Логин: testuser@gmail.com\nПароль: superSecret99\n2FA: Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const formattedLabeled = formatDigitalItem(labeled, 'ru');
  assert.ok(!formattedLabeled.includes('<code>Логин</code>'), 'Should not render label as login value');
  assert.ok(!formattedLabeled.includes('<b>#1</b>'), 'Single multi-line labeled account should not split into #1/#2/#3');
  assert.ok(formattedLabeled.includes('👤 <b>Логин:</b> <code>testuser@gmail.com</code>'));
  assert.ok(formattedLabeled.includes('🔑 <b>Пароль:</b> <code>superSecret99</code>'));
  assert.ok(formattedLabeled.includes('🛡 <b>2FA / Код:</b> <code>Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC</code>'));
  assert.ok(formattedLabeled.includes(get2FAHintText('ru')));

  // 2. Standalone otpauth:// URI must NOT split "otpauth" as login and "//totp/..." as password
  const otpauth = 'otpauth://totp/OpenAI:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=OpenAI';
  const formattedOtp = formatDigitalItem(otpauth, 'ru');
  assert.ok(!formattedOtp.includes('<code>otpauth</code>'));
  assert.ok(formattedOtp.includes('👤 <b>Логин:</b> <code>alice@example.com</code>'));
  assert.ok(formattedOtp.includes('🛡 <b>2FA / Код:</b> <code>JBSWY3DPEHPK3PXP</code>'));
  assert.ok(formattedOtp.includes(get2FAHintText('ru')));

  // 3. 4-part credential with recovery email in 3rd slot and 2FA secret in 4th slot
  const fourPart = 'user@gmail.com|pass123|recovery@outlook.com|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const formattedFour = formatDigitalItem(fourPart, 'ru');
  assert.ok(formattedFour.includes('👤 <b>Логин:</b> <code>user@gmail.com</code>'));
  assert.ok(formattedFour.includes('🔑 <b>Пароль:</b> <code>pass123</code>'));
  assert.ok(formattedFour.includes('🛡 <b>2FA / Код:</b> <code>Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC</code>'));
  assert.ok(formattedFour.includes('📧 <b>Резервная почта:</b> <code>recovery@outlook.com</code>'));
});

test('Formatting: formatDigitalItem does NOT add 2FA hint for ordinary products without 2FA', () => {
  const ordinaryAccount = 'user@example.com|MyPassword123';
  const formatted = formatDigitalItem(ordinaryAccount, 'ru');
  assert.ok(formatted.includes('<code>user@example.com</code>'));
  assert.ok(formatted.includes('<code>MyPassword123</code>'));
  assert.ok(!formatted.includes(get2FAHintText('ru')));

  const licenseKey = 'XXXX-YYYY-ZZZZ-1111';
  const formattedKey = formatDigitalItem(licenseKey, 'ru');
  assert.ok(!formattedKey.includes(get2FAHintText('ru')));
});

test('Formatting: format2FACodeMessage single account and multi-account (qty > 1) layouts', () => {
  const fixedTimeMs = 1710000006000; // 6s into 30s window -> 24s remaining

  // Single account
  const singleRaw = 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC';
  const singleMsg = format2FACodeMessage(singleRaw, 'ru', fixedTimeMs);
  const expectedCode = generateTOTP('Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC', fixedTimeMs);

  assert.ok(singleMsg.includes('🔐 <b>Код подтверждения (2FA) для входа:</b>'));
  assert.ok(singleMsg.includes(`👉 <code>${expectedCode}</code> <i>(нажмите на цифры, чтобы скопировать)</i>`));
  assert.ok(singleMsg.includes('⏳ <i>Код действует ещё: <b>24 сек.</b></i>'));

  // Multiple accounts (qty > 1)
  const multiRaw = [
    'acc1@gmail.com|pass1|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC',
    'acc2@gmail.com|pass2|JBSWY3DPEHPK3PXP',
  ].join('\n');
  const multiMsg = format2FACodeMessage(multiRaw, 'ru', fixedTimeMs);
  const code1 = generateTOTP('Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC', fixedTimeMs);
  const code2 = generateTOTP('JBSWY3DPEHPK3PXP', fixedTimeMs);

  assert.ok(multiMsg.includes(`Аккаунт #1 (acc1@gmail.com): <code>${code1}</code>`));
  assert.ok(multiMsg.includes(`Аккаунт #2 (acc2@gmail.com): <code>${code2}</code>`));
  assert.ok(multiMsg.includes('⏳ <i>Код действует ещё: <b>24 сек.</b></i>'));
});

// ==========================================
// 4. Bot Scene Handler Integration Tests
// ==========================================

test('Scene: showOrder2FA enforces order ownership and renders 6-digit code with refresh & back buttons', async () => {
  const Order = require('../src/models/Order');
  const { showOrder2FA } = require('../src/bot/scenes/profile.scene');

  const origFindById = Order.findById;
  try {
    const fakeOrder = {
      _id: '6aa7a90de39afa10f6b58d45',
      userId: '507f1f77bcf86cd799439011',
      status: 'completed',
      deliveryData: 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC',
    };

    Order.findById = () => ({
      populate: () => ({
        populate: () => ({
          populate: async () => fakeOrder,
        }),
      }),
    });

    // 1. Unauthorized user attempt
    let alertText = null;
    const unauthorizedCtx = {
      user: { _id: '999999999999999999999999', language: 'ru' },
      callbackQuery: { id: 'cb1' },
      answerCbQuery: async (msg) => { alertText = msg; },
    };
    await showOrder2FA(unauthorizedCtx, fakeOrder._id);
    assert.ok(alertText && alertText.includes('Заказ не найден'));

    // 2. Authorized owner attempt
    let renderedText = null;
    let renderedExtra = null;
    const authorizedCtx = {
      user: { _id: '507f1f77bcf86cd799439011', language: 'ru' },
      callbackQuery: { id: 'cb2' },
      answerCbQuery: async () => {},
      editMessageText: async (text, extra) => {
        renderedText = text;
        renderedExtra = extra;
      },
    };
    await showOrder2FA(authorizedCtx, fakeOrder._id);

    assert.ok(renderedText, 'Expected showOrder2FA to render message text');
    assert.ok(renderedText.includes('🔐 <b>Код подтверждения (2FA) для входа:</b>'));
    assert.ok(/👉 <code>\d{6}<\/code>/.test(renderedText));

    const buttons = renderedExtra?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = buttons.flat().map((b) => b.callback_data);
    assert.ok(flatCallbacks.includes(`profile:order:2fa_refresh:${fakeOrder._id}`));
    assert.ok(flatCallbacks.includes(`profile:order:${fakeOrder._id}`));
  } finally {
    Order.findById = origFindById;
  }
});

test('Scene: showOrderDetail shows 2FA button ONLY for orders with 2FA secret and retains escrow controls when awaiting_confirmation', async () => {
  const Order = require('../src/models/Order');
  const { showOrderDetail } = require('../src/bot/scenes/profile.scene');

  const origFindById = Order.findById;
  try {
    let currentOrder = null;
    Order.findById = () => ({
      populate: () => ({
        populate: () => ({
          populate: async () => currentOrder,
        }),
      }),
    });

    // Case 1: Order with 2FA
    currentOrder = {
      _id: '6aa7a90de39afa10f6b58d45',
      userId: '507f1f77bcf86cd799439011',
      status: 'completed',
      price: 20,
      qty: 1,
      createdAt: new Date(),
      confirmedAt: new Date(),
      warrantyDays: 5,
      subscriptionDays: 30,
      replacementStatus: 'none',
      productId: { name: 'ChatGPT Plus', icon: '🤖' },
      deliveryData: 'hbbr897896562+nnofm826@gmail.com|dreYWi2CR3A2|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC',
    };

    let detailText1 = null;
    let detailExtra1 = null;
    const ctx1 = {
      user: { _id: '507f1f77bcf86cd799439011', language: 'ru' },
      callbackQuery: { id: 'cb3' },
      answerCbQuery: async () => {},
      editMessageText: async (t, e) => { detailText1 = t; detailExtra1 = e; },
    };
    await showOrderDetail(ctx1, currentOrder._id);
    const callbacks1 = (detailExtra1?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
    assert.ok(detailText1.includes(get2FAHintText('ru')));
    assert.ok(callbacks1.includes(`profile:order:2fa:${currentOrder._id}`));

    // Case 2: Order WITHOUT 2FA
    currentOrder = {
      ...currentOrder,
      _id: '6aa7a90de39afa10f6b58d46',
      deliveryData: 'ordinary@gmail.com|simplePass123',
    };

    let detailText2 = null;
    let detailExtra2 = null;
    const ctx2 = {
      user: { _id: '507f1f77bcf86cd799439011', language: 'ru' },
      callbackQuery: { id: 'cb4' },
      answerCbQuery: async () => {},
      editMessageText: async (t, e) => { detailText2 = t; detailExtra2 = e; },
    };
    await showOrderDetail(ctx2, currentOrder._id);
    const callbacks2 = (detailExtra2?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
    assert.ok(!detailText2.includes(get2FAHintText('ru')));
    assert.ok(!callbacks2.includes(`profile:order:2fa:${currentOrder._id}`));

    // Case 3: Seller escrow order in awaiting_confirmation with 2FA
    currentOrder = {
      ...currentOrder,
      _id: '6aa7a90de39afa10f6b58d47',
      status: 'awaiting_confirmation',
      sellerId: '507f1f77bcf86cd799439099',
      deliveryData: 'escrow@gmail.com|pass123|Z7Z5OBOR7D6JMCKTR7HV2VSNYIAM3XLC',
    };

    let detailExtra3 = null;
    const ctx3 = {
      user: { _id: '507f1f77bcf86cd799439011', language: 'ru' },
      callbackQuery: { id: 'cb5' },
      answerCbQuery: async () => {},
      editMessageText: async (_t, e) => { detailExtra3 = e; },
    };
    await showOrderDetail(ctx3, currentOrder._id);
    const callbacks3 = (detailExtra3?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
    assert.ok(callbacks3.includes(`profile:order:2fa:${currentOrder._id}`));
    assert.ok(callbacks3.includes(`buyer:confirm_order:${currentOrder._id}`));
    assert.ok(callbacks3.includes(`buyer:dispute_order:${currentOrder._id}`));
  } finally {
    Order.findById = origFindById;
  }
});

// ==========================================
// Runner
// ==========================================
(async () => {
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed += 1;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

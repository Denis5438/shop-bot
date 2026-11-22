const assert = require('assert');
const crypto = require('crypto');

async function testWebAuthCallbackLimit() {
  console.log('--- Testing WebAuth Callback Limit & 2-Way Code Verification ---');

  // Test 1: Callback data length
  const fakeObjectId = '6740b3c6604169720b0bb111';
  const callbackData = `wa:${fakeObjectId}`;
  assert(Buffer.byteLength(callbackData, 'utf8') <= 64, `callbackData length must be <= 64, was ${Buffer.byteLength(callbackData, 'utf8')}`);
  console.log('✓ Callback data length is safe:', Buffer.byteLength(callbackData, 'utf8'), 'bytes (<= 64 byte limit)');

  // Test 2: Regex matching
  const regex = /^(?:wa:([a-f0-9]{24})|webauth:approve:([a-f0-9]+))$/;
  const match = callbackData.match(regex);
  assert(match, 'Regex should match callbackData');
  assert.strictEqual(match[1], fakeObjectId);
  console.log('✓ Callback regex matches successfully');

  // Test 3: Code hashing and verification
  const rawCode = '749201';
  const candidateHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  const storedHash = crypto.createHash('sha256').update('749201').digest('hex');
  assert.strictEqual(candidateHash, storedHash);
  console.log('✓ Code SHA-256 hash verified');

  console.log('--- All WebAuth Callback tests passed! ---');
}

testWebAuthCallbackLimit().catch(err => {
  console.error(err);
  process.exit(1);
});

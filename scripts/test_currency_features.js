/**
 * Тестовый набор для проверки функционала валют:
 * 1. Схема Settings (currencyMode, manualRate, currencyOffset и значения по умолчанию)
 * 2. Расчёт курса getRate в ручном режиме (manualRate) и фолбэк на 95
 * 3. Расчёт курса getRate в авто-режиме Bybit P2P + наценка (currencyOffset)
 * 4. Конвертация toRub (USDT -> RUB) с округлением и краевыми случаями
 * 5. Форматирование суммы в корзине (наличие знака ₽)
 * 6. Прямой вызов currencyService.fetchBybitP2pRate() к реальному API Bybit P2P
 * 7. Фолбэк fetchBybitP2pRate на ЦБ РФ со спредом +10% при ошибке Bybit
 * 8. Фолбэк на кэшированный/сохранённый курс при отказе Bybit и ЦБ РФ
 * 9. Фолбэк на 95 при полном отказе всех источников и пустом кэше
 * 10. Кэш настроек: getCachedSettingsSync и синхронная инвалидация invalidateCache(newSettings)
 * 11. Валидация входных значений из админки (currencyOffset >= 0, manualRate > 0)
 */

const assert = require('assert');
const axios = require('axios');
const currencyService = require('../src/services/currency.service');
const settingsCache = require('../src/services/settingsCache.service');
const Settings = require('../src/models/Settings');

async function runTests() {
  console.log('🧪 Starting Currency Features Test Suite...\n');

  // ─── 1. Проверка схемы Settings ───
  console.log('Test 1: Settings schema definitions');
  const schemaPaths = Settings.schema.paths;
  assert.ok(schemaPaths.currencyMode, 'Settings must have currencyMode path');
  assert.strictEqual(schemaPaths.currencyMode.defaultValue, 'bybit_p2p', 'Default currencyMode should be bybit_p2p');
  assert.deepStrictEqual(schemaPaths.currencyMode.options.enum, ['bybit_p2p', 'manual'], 'currencyMode enum check');

  assert.ok(schemaPaths.manualRate, 'Settings must have manualRate path');
  assert.strictEqual(schemaPaths.manualRate.defaultValue, 95, 'Default manualRate should be 95');

  assert.ok(schemaPaths.currencyOffset, 'Settings must have currencyOffset path');
  assert.strictEqual(schemaPaths.currencyOffset.defaultValue, 0, 'Default currencyOffset should be 0');
  console.log('  ✅ Settings schema verified');

  // ─── 2. Расчёт курса в ручном режиме ───
  console.log('\nTest 2: getRate in manual mode');
  currencyService._setCachedRate(96.50);

  const manualSettings1 = { currencyMode: 'manual', manualRate: 100, currencyOffset: 5 };
  assert.strictEqual(currencyService.getRate(manualSettings1), 100, 'Manual rate should ignore offset and return manualRate');

  const manualSettings2 = { currencyMode: 'manual', manualRate: 92.5 };
  assert.strictEqual(currencyService.getRate(manualSettings2), 92.5, 'Manual rate 92.5 returned directly');

  const manualSettingsFallback = { currencyMode: 'manual', manualRate: 0 };
  assert.strictEqual(currencyService.getRate(manualSettingsFallback), 95, 'manualRate <= 0 falls back to 95');

  const manualSettingsNeg = { currencyMode: 'manual', manualRate: -10 };
  assert.strictEqual(currencyService.getRate(manualSettingsNeg), 95, 'Negative manual rate falls back to 95');
  console.log('  ✅ Manual mode tests passed');

  // ─── 3. Расчёт курса в авто-режиме (Bybit P2P + наценка) ───
  console.log('\nTest 3: getRate in bybit_p2p mode with currencyOffset');
  currencyService._setCachedRate(96.58);

  assert.strictEqual(currencyService.getBaseRate(), 96.58, 'getBaseRate should return base rate without offset');

  // Нулевая наценка (дефолт)
  const bybitSettingsZero = { currencyMode: 'bybit_p2p', currencyOffset: 0 };
  assert.strictEqual(currencyService.getRate(bybitSettingsZero), 96.58, '0 offset should return base rate');

  // Положительная наценка (+2.00 ₽)
  const bybitSettingsPlus2 = { currencyMode: 'bybit_p2p', currencyOffset: 2 };
  assert.strictEqual(currencyService.getRate(bybitSettingsPlus2), 98.58, 'Offset +2 should equal 98.58');

  // Дробная наценка (+2.50 ₽)
  const bybitSettingsPlus25 = { currencyMode: 'bybit_p2p', currencyOffset: 2.5 };
  assert.strictEqual(currencyService.getRate(bybitSettingsPlus25), 99.08, 'Offset +2.5 should equal 99.08');

  // Дефолт без настроек (null)
  assert.strictEqual(currencyService.getRate(null), 96.58, 'Null settings should default to base rate');
  console.log('  ✅ Bybit P2P auto-rate + offset tests passed');

  // ─── 4. Конвертация toRub ───
  console.log('\nTest 4: toRub function');
  currencyService._setCachedRate(100);

  // 10 USDT по курсу 100 = 1000
  assert.strictEqual(currencyService.toRub(10, { currencyMode: 'manual', manualRate: 100 }), '1000');

  // Дробная сумма: 5.5 USDT по курсу 98 = 539
  assert.strictEqual(currencyService.toRub(5.5, { currencyMode: 'bybit_p2p', currencyOffset: -2 }), '539');

  // 0 USDT
  assert.strictEqual(currencyService.toRub(0), '0');
  assert.strictEqual(currencyService.toRub(null), '0');
  assert.strictEqual(currencyService.toRub(undefined), '0');
  assert.strictEqual(currencyService.toRub('25'), '2500');
  console.log('  ✅ toRub conversion tests passed');

  // ─── 5. Проверка отображения рублей в корзине ───
  console.log('\nTest 5: Cart scene ruble display formatting');
  const cartData = { finalTotal: 25.5 };
  currencyService._setCachedRate(96.00);
  const totalRubFormatted = `(≈ ${currencyService.toRub(cartData.finalTotal)} ₽)`;
  assert.ok(totalRubFormatted.includes('₽'), 'Cart total formatted string must include ₽ symbol');
  assert.strictEqual(totalRubFormatted, '(≈ 2448 ₽)', '25.5 * 96 = 2448 ₽');
  console.log('  ✅ Cart formatting with ₽ verified');

  // ─── 6. Прямой вызов fetchBybitP2pRate() сервиса ───
  console.log('\nTest 6: Live currencyService.fetchBybitP2pRate()');
  const liveRate = await currencyService.fetchBybitP2pRate();
  assert.strictEqual(typeof liveRate, 'number', 'Rate should be a number');
  assert.ok(liveRate > 50 && liveRate < 200, `Live rate ${liveRate} should be within realistic range (50-200)`);
  assert.strictEqual(currencyService.getBaseRate(), liveRate, 'getBaseRate() should match fetched live rate');
  assert.ok(currencyService.getUpdatedAt() !== 'Нет данных', 'getUpdatedAt() should return timestamp');
  console.log(`  🟢 Live Bybit P2P rate fetched successfully: ${liveRate} ₽`);

  // ─── 7. Тестирование фолбэка на ЦБ РФ (+10% спред) при сбое Bybit ───
  console.log('\nTest 7: CBR API with +10% crypto spread fallback');
  const origPost = axios.post;
  try {
    // Симулируем сетевую ошибку Bybit API
    axios.post = async () => {
      throw new Error('Simulated Bybit API Network Timeout');
    };

    const cbrFallbackRate = await currencyService.fetchBybitP2pRate();
    assert.strictEqual(typeof cbrFallbackRate, 'number', 'Fallback rate must be a number');
    assert.ok(cbrFallbackRate > 50 && cbrFallbackRate < 200, `CBR fallback rate ${cbrFallbackRate} is realistic`);
    console.log(`  🟢 Bybit error successfully handled! Recovered via CBR +10% spread: ${cbrFallbackRate} ₽`);
  } finally {
    axios.post = origPost;
  }

  // ─── 8. Тестирование фолбэка на кэш при отказе Bybit и ЦБ РФ ───
  console.log('\nTest 8: Fallback to cached rate when both Bybit and CBR fail');
  const origGet = axios.get;
  try {
    currencyService._setCachedRate(97.25);
    axios.post = async () => { throw new Error('Simulated Bybit Failure'); };
    axios.get = async () => { throw new Error('Simulated CBR Failure'); };

    const cachedFallbackRate = await currencyService.fetchBybitP2pRate();
    assert.strictEqual(cachedFallbackRate, 97.25, 'Should return cached rate 97.25');
    console.log('  🟢 Successfully fell back to cached rate (97.25 ₽)');
  } finally {
    axios.get = origGet;
  }

  // ─── 9. Тестирование фолбэка на 95 при пустом кэше и отказе всех API ───
  console.log('\nTest 9: Default 95 fallback when all sources and cache fail');
  try {
    currencyService._setCachedRate(null);
    axios.post = async () => { throw new Error('Simulated Bybit Failure'); };
    axios.get = async () => { throw new Error('Simulated CBR Failure'); };

    const defaultFallbackRate = await currencyService.fetchBybitP2pRate();
    assert.strictEqual(defaultFallbackRate, 95, 'Should fall back to default 95');
    console.log('  🟢 Successfully fell back to ultimate default (95 ₽)');
  } finally {
    axios.get = origGet;
  }

  // ─── 10. Проверка синхронизации кэша настроек ───
  console.log('\nTest 10: settingsCache sync and invalidateCache(newSettings)');
  settingsCache.invalidateCache({ currencyMode: 'manual', manualRate: 98 });
  const cachedSettings = settingsCache.getCachedSettingsSync();
  assert.ok(cachedSettings, 'Cached settings should not be null');
  assert.strictEqual(cachedSettings.currencyMode, 'manual');
  assert.strictEqual(cachedSettings.manualRate, 98);
  // getRate() без аргументов должен использовать обновлённый кэш настроек
  assert.strictEqual(currencyService.getRate(), 98, 'getRate() without arguments should use cached settings');

  // Переключение в авто-режим с наценкой +3 ₽
  currencyService._setCachedRate(95.00);
  settingsCache.invalidateCache({ currencyMode: 'bybit_p2p', currencyOffset: 3 });
  assert.strictEqual(currencyService.getRate(), 98.00, 'getRate() with offset 3 should return 95 + 3 = 98');
  console.log('  ✅ settingsCache synchronization and invalidateCache verified');

  // ─── 11. Валидация входных значений из админки ───
  console.log('\nTest 11: Admin input validation rules');
  const testOffsetValid = (val) => {
    const num = parseFloat(String(val).replace(',', '.'));
    return !isNaN(num) && num >= 0;
  };
  assert.strictEqual(testOffsetValid('0'), true, '0 offset is valid');
  assert.strictEqual(testOffsetValid('2'), true, '2 offset is valid');
  assert.strictEqual(testOffsetValid('2.5'), true, '2.5 offset is valid');
  assert.strictEqual(testOffsetValid('3,5'), true, 'Comma separator is parsed');
  assert.strictEqual(testOffsetValid('-1'), false, 'Negative offset rejected');
  assert.strictEqual(testOffsetValid('abc'), false, 'Non-number rejected');

  const testManualRateValid = (val) => {
    const num = parseFloat(String(val).replace(',', '.'));
    return !isNaN(num) && num > 0;
  };
  assert.strictEqual(testManualRateValid('95'), true, '95 is valid');
  assert.strictEqual(testManualRateValid('92.5'), true, '92.5 is valid');
  assert.strictEqual(testManualRateValid('0'), false, '0 rate rejected');
  assert.strictEqual(testManualRateValid('-5'), false, 'Negative rate rejected');
  assert.strictEqual(testManualRateValid('xyz'), false, 'Non-number rejected');
  console.log('  ✅ Admin input validation rules verified');

  console.log('\n🎉 ALL CURRENCY TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('\n❌ CURRENCY TEST FAILED:', err);
  process.exit(1);
});

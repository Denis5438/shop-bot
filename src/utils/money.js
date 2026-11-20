/**
 * src/utils/money.js
 *
 * Precision financial rounding to avoid IEEE 754 floating-point inaccuracies.
 */

/**
 * Rounds a financial number to a given number of decimal places (default 2).
 * Handles edge cases like null, undefined, NaN, and negative numbers safely.
 *
 * @param {number|string} val - The numeric value to round
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {number} The rounded number
 */
const roundMoney = (val, decimals = 2) => {
  if (val === null || val === undefined || val === '') return 0;
  const num = Number(val);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

module.exports = {
  roundMoney,
};

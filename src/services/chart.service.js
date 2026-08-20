let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {}

/**
 * Генерирует векторный SVG-график продаж за 7 дней в тёмной теме.
 */
const generateSalesChartSvg = (labels, data, totalWeek) => {
  const width = 800;
  const height = 440;
  const padding = { top: 75, right: 40, bottom: 65, left: 65 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const numData = data.map((v) => Number(v) || 0);
  const maxVal = Math.max(...numData, 10);
  const roundedMax = Math.ceil(maxVal * 1.15);

  // Сетка и деления Y
  let gridLines = '';
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const yVal = (roundedMax / gridSteps) * i;
    const yPos = padding.top + chartHeight - (i / gridSteps) * chartHeight;
    gridLines += `
      <line x1="${padding.left}" y1="${yPos.toFixed(1)}" x2="${width - padding.right}" y2="${yPos.toFixed(1)}" stroke="#1e293b" stroke-width="1" stroke-dasharray="4 4" />
      <text x="${padding.left - 12}" y="${(yPos + 4).toFixed(1)}" fill="#64748b" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="end">${yVal.toFixed(0)}</text>
    `;
  }

  // Столбцы X
  const stepX = chartWidth / labels.length;
  const barWidth = stepX * 0.52;
  const maxIdxVal = Math.max(...numData);
  let bars = '';

  labels.forEach((label, idx) => {
    const val = numData[idx];
    const barHeight = val > 0 ? Math.max((val / roundedMax) * chartHeight, 6) : 4;
    const x = padding.left + idx * stepX + (stepX - barWidth) / 2;
    const y = padding.top + chartHeight - barHeight;
    const isTop = val === maxIdxVal && val > 0;
    const gradId = isTop ? 'barGradTop' : 'barGrad';

    bars += `
      <g>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="6" fill="url(#${gradId})" />
        <text x="${(x + barWidth / 2).toFixed(1)}" y="${height - padding.bottom + 26}" fill="#94a3b8" font-size="13" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle" font-weight="500">${label}</text>
        ${
          val > 0
            ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" fill="${isTop ? '#4ade80' : '#38bdf8'}" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle" font-weight="bold">${val.toFixed(1)}</text>`
            : ''
        }
      </g>
    `;
  });

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0b0f19" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#0284c7" />
        </linearGradient>
        <linearGradient id="barGradTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4ade80" />
          <stop offset="100%" stop-color="#16a34a" />
        </linearGradient>
      </defs>

      <!-- Флаг-фон -->
      <rect width="${width}" height="${height}" rx="18" fill="url(#bgGrad)" stroke="#1e293b" stroke-width="1.5" />

      <!-- Заголовок -->
      <text x="${padding.left}" y="38" fill="#f8fafc" font-size="17" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="bold">📈 Выручка за последние 7 дней (USDT)</text>

      <!-- Бейдж Итого -->
      <rect x="${width - padding.right - 190}" y="18" width="190" height="32" rx="16" fill="#1e293b" stroke="#334155" stroke-width="1" />
      <text x="${width - padding.right - 95}" y="39" fill="#38bdf8" font-size="13" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="bold" text-anchor="middle">Итого: ${Number(totalWeek).toFixed(2)} USDT</text>

      <!-- Линии сетки и Столбцы -->
      ${gridLines}
      ${bars}
    </svg>
  `.trim();
};

/**
 * Рендерит локальный PNG-буфер графика продаж.
 * Полностью автономно, 0 внешних HTTP-запросов, время генерации < 15 мс.
 */
const renderSalesChartPng = async (labels, data, totalWeek) => {
  const svg = generateSalesChartSvg(labels, data, totalWeek);
  if (sharp) {
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
  throw new Error('Sharp is not installed');
};

module.exports = {
  generateSalesChartSvg,
  renderSalesChartPng,
};

const zlib = require('zlib');
const logger = require('../config/logger');

let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {}

/**
 * Векторный SVG-шаблон графика в тёмной теме
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

      <!-- Фон -->
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
 * Вспомогательный кодировщик PNG без внешних библиотек (на чистом zlib)
 */
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};
const createPngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crcBuf]);
};
const encodeRgbaToPng = (width, height, rgbaBuffer) => {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = createPngChunk('IHDR', ihdrData);

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0;
    rgbaBuffer.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = createPngChunk('IDAT', zlib.deflateSync(scanlines));
  const iend = createPngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
};

/**
 * Генерация высококачественного растрового PNG графика на чистом JS (0 зависимостей)
 */
const renderPureJsChartPng = (labels, data, totalWeek) => {
  const width = 640;
  const height = 340;
  const buf = Buffer.alloc(width * height * 4);

  const setPixel = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
    buf[idx + 3] = a;
  };

  const drawRect = (rx, ry, rw, rh, r, g, b, a = 255) => {
    for (let y = Math.max(0, ry); y < Math.min(height, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(width, rx + rw); x++) {
        setPixel(x, y, r, g, b, a);
      }
    }
  };

  // Фон #0b0f19 -> #0f172a
  for (let y = 0; y < height; y++) {
    const ratio = y / height;
    const r = Math.round(11 + (15 - 11) * ratio);
    const g = Math.round(15 + (23 - 15) * ratio);
    const b = Math.round(25 + (42 - 25) * ratio);
    for (let x = 0; x < width; x++) {
      setPixel(x, y, r, g, b, 255);
    }
  }

  // Верхняя шапка
  drawRect(0, 0, width, 55, 30, 41, 59);

  // Сетка и столбцы
  const padLeft = 50, padRight = 30, padTop = 75, padBottom = 40;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const numData = data.map(Number);
  const maxVal = Math.max(...numData, 10);
  const stepX = chartW / labels.length;
  const barW = Math.round(stepX * 0.55);

  // Базовые линии сетки
  for (let i = 0; i <= 3; i++) {
    const gy = Math.round(padTop + (i / 3) * chartH);
    for (let x = padLeft; x < width - padRight; x += 6) {
      drawRect(x, gy, 3, 1, 51, 65, 85);
    }
  }

  // Столбцы
  const maxIdxVal = Math.max(...numData);
  labels.forEach((_, idx) => {
    const val = numData[idx];
    const barH = val > 0 ? Math.max(Math.round((val / (maxVal * 1.15)) * chartH), 8) : 4;
    const bx = Math.round(padLeft + idx * stepX + (stepX - barW) / 2);
    const by = Math.round(padTop + chartH - barH);
    const isTop = val === maxIdxVal && val > 0;

    const r = isTop ? 74 : 56;
    const g = isTop ? 222 : 189;
    const b = isTop ? 128 : 248;

    drawRect(bx, by, barW, barH, r, g, b);
  });

  return encodeRgbaToPng(width, height, buf);
};

/**
 * Рендерит локальный PNG-буфер графика продаж.
 * 100% автономно, гарантированно возвращает Buffer изображения.
 */
const renderSalesChartPng = async (labels, data, totalWeek) => {
  const svg = generateSalesChartSvg(labels, data, totalWeek);
  if (sharp) {
    try {
      return await sharp(Buffer.from(svg)).png().toBuffer();
    } catch (sharpErr) {
      logger.warn(`[chart.service] Sharp render warning: ${sharpErr.message}, fallback to pure JS`);
    }
  }
  return renderPureJsChartPng(labels, data, totalWeek);
};

module.exports = {
  generateSalesChartSvg,
  renderSalesChartPng,
};

'use client';

import React, { useState, useEffect } from 'react';
import { resolveBrand } from '../lib/brandIcons';

/**
 * Компонент отображения реальной иконки бренда из /icons/brands/ с фолбэком на стилизованный монограмм-бейдж.
 * Никогда не рендерит дефолтный эмодзи "🤖".
 */
export default function BrandIcon({
  name = '',
  categoryName = '',
  brandId = '',
  size = 44,
  rounded = 'xl',
  className = '',
}) {
  const [imgError, setImgError] = useState(false);

  const brand = resolveBrand({ name, categoryName, brandId });

  useEffect(() => {
    setImgError(false);
  }, [brand.src, name, categoryName, brandId]);

  const numericSize = typeof size === 'number' ? size : 44;
  const isCompact = numericSize <= 22;

  const roundedClass =
    rounded === 'full'
      ? 'rounded-full'
      : rounded === '2xl'
      ? 'rounded-2xl'
      : rounded === 'lg'
      ? 'rounded-lg'
      : rounded === 'md'
      ? 'rounded-md'
      : 'rounded-xl';

  const boxStyle = {
    width: `${numericSize}px`,
    height: `${numericSize}px`,
    minWidth: `${numericSize}px`,
    minHeight: `${numericSize}px`,
    backgroundColor: isCompact ? 'transparent' : `${brand.color}14`,
    borderColor: isCompact ? 'transparent' : `${brand.color}38`,
  };

  if (brand.src && !imgError) {
    return (
      <span
        style={boxStyle}
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${
          isCompact ? 'rounded-sm' : `${roundedClass} border p-2`
        } ${className}`}
      >
        <img
          src={brand.src}
          alt={name || categoryName || brand.brandId || 'Brand'}
          onError={() => setImgError(true)}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-contain select-none"
        />
      </span>
    );
  }

  // Стилизованный монограмм-бейдж без эмодзи
  const fontSize = isCompact ? Math.max(8, Math.round(numericSize * 0.48)) : Math.max(11, Math.round(numericSize * 0.34));

  return (
    <span
      style={{
        width: `${numericSize}px`,
        height: `${numericSize}px`,
        minWidth: `${numericSize}px`,
        minHeight: `${numericSize}px`,
        backgroundColor: `${brand.color}22`,
        borderColor: `${brand.color}4A`,
        color: brand.color === '#E2E8F0' ? '#F8FAFC' : brand.color,
        fontSize: `${fontSize}px`,
      }}
      className={`inline-flex shrink-0 items-center justify-center font-bold tracking-tight select-none border ${
        isCompact ? 'rounded-md' : roundedClass
      } ${className}`}
      aria-label={name || categoryName || 'Brand'}
    >
      {isCompact ? brand.monogram.slice(0, 1) : brand.monogram}
    </span>
  );
}

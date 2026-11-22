'use client';

import React from 'react';
import { ShoppingBag, ShieldCheck, Zap } from 'lucide-react';
import { useCart } from '../context/CartContext';

export default function ProductCard({ product, onSelect, rubRate = 92.5 }) {
  const { addToCart, isLoading } = useCart();

  const isAvailable = product.inStock && product.stockCount > 0;
  const priceRub = Math.round(product.effectivePrice * rubRate);

  const handleAdd = async (e) => {
    e.stopPropagation();
    if (!isAvailable) return;
    await addToCart(product.id, 1);
  };

  return (
    <div
      onClick={() => onSelect && onSelect(product)}
      className="group relative flex flex-col justify-between rounded-2xl bg-dark-card border border-dark-border p-5 cursor-pointer glass-card-hover"
    >
      {/* Верхняя строка: Категория и Бейдж скидки / Flash Sale */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-dark-surface px-2.5 py-1 text-[11px] font-medium text-slate-400 border border-dark-border/60">
            <span>{product.category?.icon || '📁'}</span>
            <span>{product.category?.name || 'Товары'}</span>
          </span>

          {product.flashSale?.enabled && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] font-bold text-rose-400 animate-pulse">
              <Zap className="h-3 w-3" />
              -{product.flashSale.discountPercent}%
            </span>
          )}

          {!product.flashSale?.enabled && product.officialDiscountPercent > 0 && (
            <span className="rounded-lg bg-brand/15 border border-brand/30 px-2 py-0.5 text-[11px] font-bold text-brand">
              -{product.officialDiscountPercent}%
            </span>
          )}
        </div>

        {/* Иконка и Название */}
        <div className="flex items-start gap-3 mb-2.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-dark-surface border border-dark-border text-2xl">
            {product.icon || '📦'}
          </span>
          <div>
            <h3 className="font-semibold text-white text-base leading-snug group-hover:text-brand transition-colors line-clamp-1">
              {product.name}
            </h3>
            <p className="text-xs text-slate-400 line-clamp-2 mt-1 leading-relaxed">
              {product.description || 'Лицензионный цифровой товар с моментальной выдачей.'}
            </p>
          </div>
        </div>

        {/* Наличие и Гарантия */}
        <div className="flex items-center gap-3 mt-3 text-[11px]">
          <span className={`inline-flex items-center gap-1 font-medium ${isAvailable ? 'text-emerald-400' : 'text-slate-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${isAvailable ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {isAvailable ? `В наличии ${product.stockCount} шт.` : 'Нет в наличии'}
          </span>

          {product.warrantyDays > 0 && (
            <span className="inline-flex items-center gap-1 text-slate-400">
              <ShieldCheck className="h-3 w-3 text-slate-500" />
              Гарантия {product.warrantyDays} дн.
            </span>
          )}
        </div>
      </div>

      {/* Нижняя часть: Цена и Кнопка */}
      <div className="mt-5 pt-4 border-t border-dark-border/60 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold text-white font-mono tracking-tight">
              {product.effectivePrice} USDT
            </span>
            {product.officialPrice > product.effectivePrice && (
              <span className="text-xs text-slate-500 line-through font-mono">
                {product.officialPrice}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            ≈ {priceRub.toLocaleString('ru-RU')} ₽
          </div>
        </div>

        <button
          onClick={handleAdd}
          disabled={!isAvailable || isLoading}
          className={`flex h-10 items-center gap-2 rounded-xl px-4 text-xs font-semibold transition-all ${
            isAvailable
              ? 'bg-brand text-white shadow-md shadow-brand/20 hover:bg-brand-hover hover:scale-[1.02]'
              : 'bg-dark-surface border border-dark-border text-slate-500 cursor-not-allowed'
          }`}
        >
          <ShoppingBag className="h-3.5 w-3.5" />
          <span>В корзину</span>
        </button>
      </div>
    </div>
  );
}

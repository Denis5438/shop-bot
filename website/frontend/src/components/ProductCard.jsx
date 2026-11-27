'use client';

import React from 'react';
import { ShoppingBag, ShieldCheck, Zap, Sparkles, Clock, Calendar, Plus } from 'lucide-react';
import { useCart } from '../context/CartContext';
import BrandIcon from './BrandIcon';

function resolveDeliveryBadge(product) {
  const isInstant =
    product.type === 'key' ||
    product.deliveryMethod === 'ready_account' ||
    product.provider === 'jaha';

  if (isInstant) {
    return {
      label: 'Автовыдача',
      Icon: Zap,
      classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    };
  }
  if (product.type === 'gpt_activation') {
    return {
      label: 'Активация',
      Icon: Sparkles,
      classes: 'bg-violet-500/10 text-violet-300 border-violet-500/25',
    };
  }
  return {
    label: 'Ручная',
    Icon: Clock,
    classes: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  };
}

export default function ProductCard({
  product,
  onSelect,
  rubRate = 92.5,
  viewMode = 'card',
}) {
  const { addToCart, isLoading } = useCart();

  const isAvailable = Boolean(product.inStock && product.stockCount > 0);
  const effectivePrice = Number(product.effectivePrice ?? product.price ?? 0);
  const officialPrice = Number(product.officialPrice || 0);
  const safeRate = Number(rubRate) > 0 ? Number(rubRate) : 92.5;
  const priceRub = Math.round(effectivePrice * safeRate);

  const delivery = resolveDeliveryBadge(product);
  const DeliveryIcon = delivery.Icon;

  const handleAdd = async (e, openDrawer = true) => {
    e.stopPropagation();
    if (!isAvailable || isLoading) return;
    await addToCart(product.id, 1, { openDrawer });
  };

  if (viewMode === 'row') {
    return (
      <div
        onClick={() => onSelect && onSelect(product)}
        className={`group flex flex-col md:flex-row md:items-center justify-between gap-3.5 rounded-2xl bg-dark-card border border-dark-border p-3.5 sm:px-4 sm:py-3.5 cursor-pointer glass-card-hover ${
          !isAvailable ? 'opacity-70' : ''
        }`}
      >
        {/* Левая часть: иконка, название, бейджи */}
        <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
          <BrandIcon
            size={38}
            name={product.name}
            categoryName={product.category?.name}
            rounded="xl"
          />

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-white text-sm leading-snug group-hover:text-brand transition-colors truncate max-w-full">
                {product.name}
              </h3>

              {product.flashSale?.enabled && (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-rose-500/15 border border-rose-500/30 px-1.5 py-0.5 text-[10px] font-bold text-rose-400">
                  🔥 -{product.flashSale.discountPercent}%
                </span>
              )}
              {!product.flashSale?.enabled && product.officialDiscountPercent > 0 && (
                <span className="shrink-0 whitespace-nowrap rounded-md bg-brand/15 border border-brand/30 px-1.5 py-0.5 text-[10px] font-bold text-brand">
                  -{product.officialDiscountPercent}%
                </span>
              )}
            </div>

            {product.description && (
              <p className="text-[11px] text-slate-400 truncate max-w-2xl">
                {product.description}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-medium ${delivery.classes}`}
              >
                <DeliveryIcon className="h-3 w-3 shrink-0" />
                <span>{delivery.label}</span>
              </span>

              <span
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 font-medium ${
                  isAvailable
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-slate-800/80 text-slate-500'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isAvailable ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                {isAvailable ? `${product.stockCount} шт.` : 'Нет в наличии'}
              </span>

              {product.warrantyDays > 0 && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-dark-surface px-2 py-0.5 text-slate-400 border border-dark-border/60">
                  <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-400/80" />
                  <span>Гарантия {product.warrantyDays}д</span>
                </span>
              )}

              {product.subscriptionDays > 0 && (
                <span className="hidden sm:inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-dark-surface px-2 py-0.5 text-slate-400 border border-dark-border/60">
                  <Calendar className="h-3 w-3 shrink-0 text-sky-400/80" />
                  <span>{product.subscriptionDays}д</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Правая часть: цена и кнопки */}
        <div className="flex items-center justify-between md:justify-end gap-3 sm:gap-4 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-dark-border/50">
          <div className="text-left md:text-right">
            {officialPrice > effectivePrice && (
              <div className="text-[10px] text-slate-500 line-through font-mono tabular-nums whitespace-nowrap leading-tight">
                {officialPrice.toFixed(2)} USDT
              </div>
            )}
            <div className="text-base font-bold text-white font-mono tracking-tight tabular-nums whitespace-nowrap leading-none">
              {effectivePrice.toFixed(2)} <span className="text-[11px] font-semibold text-slate-300">USDT</span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono tabular-nums whitespace-nowrap mt-0.5">
              ≈ {priceRub.toLocaleString('ru-RU')} ₽
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => handleAdd(e, false)}
              disabled={!isAvailable || isLoading}
              className={`flex h-9 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-xl px-3 text-xs font-semibold border transition-all ${
                isAvailable
                  ? 'bg-dark-surface border-dark-border text-slate-200 hover:border-brand/50 hover:text-white active:scale-95'
                  : 'bg-dark-surface border-dark-border text-slate-500 cursor-not-allowed'
              }`}
              title="Добавить в корзину"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="hidden sm:inline">В корзину</span>
            </button>

            <button
              type="button"
              onClick={(e) => handleAdd(e, true)}
              disabled={!isAvailable || isLoading}
              className={`flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 text-xs font-semibold transition-all ${
                isAvailable
                  ? 'bg-brand text-white shadow-md shadow-brand/20 hover:bg-brand-hover active:scale-95'
                  : 'bg-dark-surface border border-dark-border text-slate-500 cursor-not-allowed'
              }`}
            >
              <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
              <span>Купить сейчас</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect && onSelect(product)}
      className={`group relative flex h-full flex-col justify-between rounded-2xl bg-dark-card border border-dark-border p-4 sm:p-5 cursor-pointer glass-card-hover ${
        !isAvailable ? 'opacity-75' : ''
      }`}
    >
      {/* Верхняя часть карточки */}
      <div className="space-y-3">
        {/* Категория и скидка */}
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 max-w-[70%] items-center gap-1.5 rounded-lg bg-dark-surface px-2 py-1 text-[11px] font-medium text-slate-300 border border-dark-border/70">
            <BrandIcon
              size={16}
              name={product.category?.name || product.name}
              categoryName={product.category?.name}
            />
            <span className="truncate">{product.category?.name || 'Товары'}</span>
          </span>

          {product.flashSale?.enabled ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] font-bold text-rose-400">
              <Zap className="h-3 w-3 shrink-0" />
              -{product.flashSale.discountPercent}%
            </span>
          ) : product.officialDiscountPercent > 0 ? (
            <span className="shrink-0 whitespace-nowrap rounded-lg bg-brand/15 border border-brand/30 px-2 py-0.5 text-[11px] font-bold text-brand">
              -{product.officialDiscountPercent}%
            </span>
          ) : null}
        </div>

        {/* Иконка бренда 44x44 и заголовок фиксированной высоты */}
        <div className="flex items-start gap-3">
          <BrandIcon
            size={44}
            name={product.name}
            categoryName={product.category?.name}
            rounded="xl"
          />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-white text-[15px] leading-snug group-hover:text-brand transition-colors line-clamp-2 min-h-[2.6rem]">
              {product.name}
            </h3>
          </div>
        </div>

        {/* Описание фиксированной высоты */}
        <p className="text-xs text-slate-400 line-clamp-2 min-h-[2.25rem] leading-relaxed">
          {product.description || 'Лицензионный цифровой товар с гарантией качества и моментальной обработкой.'}
        </p>

        {/* Бейджи выдачи, наличия и гарантии */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]">
          <span
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-medium ${delivery.classes}`}
          >
            <DeliveryIcon className="h-3 w-3 shrink-0" />
            <span>{delivery.label}</span>
          </span>

          <span
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 font-medium ${
              isAvailable
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-slate-800/80 text-slate-500'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${isAvailable ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {isAvailable ? `${product.stockCount} шт.` : 'Нет в наличии'}
          </span>

          {product.warrantyDays > 0 && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-slate-400 ml-auto">
              <ShieldCheck className="h-3 w-3 shrink-0 text-slate-500" />
              <span>{product.warrantyDays}д</span>
            </span>
          )}
        </div>
      </div>

      {/* Нижний блок: 1-строчная цена и компактная кнопка */}
      <div className="mt-4 pt-3.5 border-t border-dark-border/60 flex items-end justify-between gap-2">
        <div className="min-w-0">
          {officialPrice > effectivePrice && (
            <div className="text-[11px] text-slate-500 line-through font-mono tabular-nums whitespace-nowrap leading-tight mb-0.5">
              {officialPrice.toFixed(2)} USDT
            </div>
          )}
          <div className="text-[17px] font-bold text-white font-mono tracking-tight tabular-nums whitespace-nowrap leading-none">
            {effectivePrice.toFixed(2)} <span className="text-xs font-semibold text-slate-300">USDT</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono tabular-nums whitespace-nowrap mt-1">
            ≈ {priceRub.toLocaleString('ru-RU')} ₽
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => handleAdd(e, true)}
          disabled={!isAvailable || isLoading}
          className={`flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 text-xs font-semibold transition-all ${
            isAvailable
              ? 'bg-brand text-white shadow-md shadow-brand/20 hover:bg-brand-hover active:scale-95'
              : 'bg-dark-surface border border-dark-border text-slate-500 cursor-not-allowed'
          }`}
        >
          <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
          <span>В корзину</span>
        </button>
      </div>
    </div>
  );
}

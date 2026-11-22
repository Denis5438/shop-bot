'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { X, Trash2, ShoppingBag, Plus, Minus, ArrowRight, Tag, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { ordersApi } from '../lib/api';

export default function CartDrawer() {
  const { cart, isOpen, closeCart, updateQuantity, removeFromCart, clearCart, applyPromo, removePromo, refreshCart } = useCart();
  const { user, refreshUser } = useAuth();

  const [promoInput, setPromoInput] = useState('');
  const [promoMessage, setPromoMessage] = useState(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState(null);

  if (!isOpen) return null;

  const handleApplyPromo = async (e) => {
    e.preventDefault();
    if (!promoInput.trim()) return;
    const res = await applyPromo(promoInput.trim());
    setPromoMessage({ success: res.success, text: res.message });
    if (res.success) setPromoInput('');
  };

  const handleCheckout = async () => {
    try {
      setIsCheckingOut(true);
      const res = await ordersApi.checkout(cart.cartVersion);
      if (res.success) {
        setCheckoutResult(res);
        await refreshUser();
        await refreshCart();
      }
    } catch (err) {
      alert(err.message || 'Ошибка оформления заказа');
    } finally {
      setIsCheckingOut(false);
    }
  };

  const balance = user?.balance || 0;
  const isInsufficient = balance < cart.finalTotal;
  const diff = (cart.finalTotal - balance).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Затемнение фона */}
      <div
        onClick={closeCart}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
      />

      {/* Панель корзины */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="w-screen max-w-md border-l border-dark-border bg-dark-bg p-6 shadow-2xl flex flex-col justify-between">
          {/* Верхняя строка */}
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-dark-border">
              <div className="flex items-center gap-2.5 font-bold text-lg text-white">
                <ShoppingBag className="h-5 w-5 text-brand" />
                <span>Корзина ({cart.totalCount})</span>
              </div>
              <button
                onClick={closeCart}
                className="rounded-xl p-2 text-slate-400 hover:text-white hover:bg-dark-surface transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Успешный результат заказа */}
            {checkoutResult ? (
              <div className="py-8 text-center space-y-4">
                <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="h-8 w-8" />
                </div>
                <h3 className="text-xl font-bold text-white">Заказ успешно оплачен!</h3>
                <p className="text-sm text-slate-400">
                  Списано {checkoutResult.totalCost} USDT. Ваши ключи готовы к использованию.
                </p>

                {/* Выданные ключи */}
                <div className="mt-4 space-y-2 text-left">
                  {checkoutResult.deliveryReports?.map((report, idx) => (
                    <div key={idx} className="rounded-xl bg-dark-card border border-dark-border p-3.5 space-y-1.5">
                      <div className="text-xs font-semibold text-slate-300">{report.name}</div>
                      <div className="flex items-center justify-between gap-2 rounded-lg bg-dark-surface p-2 font-mono text-xs text-emerald-400 border border-dark-border">
                        <span className="truncate">{report.data}</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(report.data);
                            alert('Ключ скопирован в буфер обмена!');
                          }}
                          className="shrink-0 text-[11px] text-brand hover:underline font-sans"
                        >
                          Копировать
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-4 flex flex-col gap-2">
                  <Link
                    href="/orders"
                    onClick={closeCart}
                    className="flex h-11 items-center justify-center rounded-xl bg-brand font-semibold text-sm text-white hover:bg-brand-hover transition-all"
                  >
                    Перейти к заказам
                  </Link>
                  <button
                    onClick={() => {
                      setCheckoutResult(null);
                      closeCart();
                    }}
                    className="flex h-11 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-sm text-slate-300 hover:text-white transition-all"
                  >
                    Продолжить покупки
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Список позиций */}
                <div className="mt-4 max-h-[46vh] overflow-y-auto space-y-3 pr-1">
                  {cart.items.length === 0 ? (
                    <div className="py-16 text-center text-slate-500 space-y-3">
                      <span className="text-4xl">🛒</span>
                      <p className="text-sm">В корзине пока ничего нет</p>
                    </div>
                  ) : (
                    cart.items.map((item) => (
                      <div
                        key={item.productId}
                        className="flex items-center justify-between gap-3 rounded-xl bg-dark-card border border-dark-border p-3.5"
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-dark-surface text-xl border border-dark-border">
                            {item.product?.icon || '📦'}
                          </span>
                          <div>
                            <h4 className="font-semibold text-white text-xs line-clamp-1">
                              {item.product?.name}
                            </h4>
                            <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                              {item.unitPrice} USDT / шт.
                            </div>
                          </div>
                        </div>

                        {/* Шаговый переключатель количества */}
                        <div className="flex items-center gap-2">
                          <div className="flex items-center rounded-lg bg-dark-surface border border-dark-border text-xs">
                            <button
                              onClick={() => updateQuantity(item.productId, item.qty - 1)}
                              className="px-2 py-1 text-slate-400 hover:text-white"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <span className="w-5 text-center font-mono font-bold text-white">
                              {item.qty}
                            </span>
                            <button
                              onClick={() => updateQuantity(item.productId, item.qty + 1)}
                              disabled={item.qty >= item.availableStock}
                              className="px-2 py-1 text-slate-400 hover:text-white disabled:opacity-40"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>

                          <button
                            onClick={() => removeFromCart(item.productId)}
                            className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors"
                            title="Удалить"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Промокод */}
                {cart.items.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-dark-border/60">
                    {cart.activePromo ? (
                      <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-400">
                        <span className="flex items-center gap-1.5 font-mono">
                          <Tag className="h-3.5 w-3.5" />
                          {cart.activePromo.code} (-{cart.discountAmount} USDT)
                        </span>
                        <button onClick={removePromo} className="text-slate-400 hover:text-white">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleApplyPromo} className="flex gap-2">
                        <input
                          type="text"
                          value={promoInput}
                          onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                          placeholder="Промокод на скидку"
                          className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs font-mono text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="rounded-xl bg-dark-surface border border-dark-border px-3 py-2 text-xs font-semibold text-slate-300 hover:text-white hover:border-slate-600 transition-all"
                        >
                          Применить
                        </button>
                      </form>
                    )}
                    {promoMessage && (
                      <div className={`mt-1.5 text-[11px] ${promoMessage.success ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {promoMessage.text}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Итоговый блок и Кнопка чекаута */}
          {!checkoutResult && cart.items.length > 0 && (
            <div className="pt-4 border-t border-dark-border space-y-3">
              {/* Расчёт сумм */}
              <div className="space-y-1.5 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Товары:</span>
                  <span className="font-mono text-slate-300">{cart.subtotal.toFixed(2)} USDT</span>
                </div>
                {cart.discountAmount > 0 && (
                  <div className="flex justify-between text-emerald-400">
                    <span>Скидка по промокоду:</span>
                    <span className="font-mono">-{cart.discountAmount.toFixed(2)} USDT</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold text-white pt-2 border-t border-dark-border/40">
                  <span>Итого к оплате:</span>
                  <span className="font-mono text-brand text-lg">{cart.finalTotal.toFixed(2)} USDT</span>
                </div>
              </div>

              {/* Проверка баланса */}
              {isInsufficient ? (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>Недостаточно средств на балансе</span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    На балансе: <span className="font-mono text-white">{balance.toFixed(2)} USDT</span>. 
                    Не хватает: <span className="font-mono text-amber-400 font-bold">{diff} USDT</span>.
                  </p>
                  <Link
                    href="/topup"
                    onClick={closeCart}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-amber-500 text-black font-semibold text-xs hover:bg-amber-400 transition-all"
                  >
                    <span>Пополнить баланс</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : (
                <button
                  onClick={handleCheckout}
                  disabled={isCheckingOut || cart.hasStockIssue}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-white shadow-lg shadow-brand/25 hover:bg-brand-hover hover:scale-[1.01] transition-all disabled:opacity-50"
                >
                  <span>{isCheckingOut ? 'Оформление...' : 'Оплатить заказ с баланса'}</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ShoppingBag, Copy, CheckCircle2, Clock, AlertTriangle, ShieldCheck, ArrowRight } from 'lucide-react';
import { ordersApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

export default function OrdersPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null);

  useEffect(() => {
    if (!isAuthenticated && !authLoading) {
      window.location.href = '/auth/signin';
      return;
    }

    async function loadOrders() {
      try {
        setIsLoading(true);
        const data = await ordersApi.getOrders({ limit: 50 });
        if (data.success) {
          setOrders(data.orders || []);
        }
      } catch (err) {
        console.error('Ошибка загрузки заказов:', err);
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated) {
      loadOrders();
    }
  }, [isAuthenticated, authLoading]);

  const copyToClipboard = (key, orderId) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(orderId);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 text-xs font-semibold text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Выдан
          </span>
        );
      case 'pending':
      case 'activating':
      case 'awaiting_token':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 text-xs font-semibold text-amber-400 animate-pulse">
            <Clock className="h-3.5 w-3.5" />
            Обработка
          </span>
        );
      case 'cancelled':
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 px-2.5 py-1 text-xs font-semibold text-rose-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Отменён
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-lg bg-slate-500/10 px-2.5 py-1 text-xs text-slate-400">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-10 space-y-6">
      {/* Заголовок страницы */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-dark-border">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Мои заказы</h1>
          <p className="text-xs text-slate-400 mt-1">
            Все приобретённые ключи, аккаунты и лицензии доступны здесь в любое время.
          </p>
        </div>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl bg-dark-card border border-dark-border px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white hover:border-slate-600 transition-all"
        >
          <span>В магазин</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Список заказов */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-3xl bg-dark-card border border-dark-border py-20 text-center space-y-4">
          <span className="text-5xl">📦</span>
          <h3 className="text-lg font-bold text-white">У вас пока нет заказов</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Перейдите в каталог, чтобы выбрать нужную подписку или лицензионный ключ.
          </p>
          <div className="pt-2">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-brand/25 hover:bg-brand-hover transition-all"
            >
              <span>Открыть каталог</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const hasKey = order.status === 'completed' && Boolean(order.key || order.deliveryData);
            const keyText = order.key || order.deliveryData;

            return (
              <div
                key={order.id}
                className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4 transition-all hover:border-slate-600"
              >
                {/* Верхняя строка заказа */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-dark-border/60">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-dark-surface border border-dark-border text-2xl">
                      {order.product?.icon || '📦'}
                    </span>
                    <div>
                      <h3 className="font-semibold text-white text-sm">
                        {order.product?.name || 'Цифровой товар'}
                      </h3>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        Заказ #{order.id?.slice(-8)} • {new Date(order.createdAt).toLocaleDateString('ru-RU', {
                          day: 'numeric',
                          month: 'long',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="font-mono font-bold text-white text-sm">
                        {order.price?.toFixed(2)} USDT
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {order.qty || 1} шт.
                      </div>
                    </div>
                    {getStatusBadge(order.status)}
                  </div>
                </div>

                {/* Блок выданного ключа */}
                {hasKey ? (
                  <div className="rounded-xl bg-dark-surface/90 border border-dark-border p-3.5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">Данные доступа / Ключ активации:</span>
                      {order.warrantyDays > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                          <ShieldCheck className="h-3 w-3" />
                          Гарантия {order.warrantyDays} дней
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-lg bg-dark-input border border-dark-border px-3.5 py-2.5 font-mono text-xs text-emerald-400">
                      <span className="truncate select-all">{keyText}</span>
                      <button
                        onClick={() => copyToClipboard(keyText, order.id)}
                        className="flex shrink-0 items-center gap-1.5 rounded-md bg-dark-surface px-2.5 py-1 text-[11px] font-sans text-slate-200 hover:text-white hover:bg-slate-700 transition-all"
                      >
                        <Copy className="h-3 w-3" />
                        <span>{copiedKey === order.id ? 'Скопировано!' : 'Копировать'}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  order.status === 'awaiting_token' && (
                    <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-400">
                      Товар требует активации через Telegram-бота. Пожалуйста, откройте бота для передачи токена аккаунта.
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

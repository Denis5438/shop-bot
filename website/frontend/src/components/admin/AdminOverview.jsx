'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  ShoppingBag,
  Users,
  KeyRound,
  TrendingUp,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Clock,
  Wallet,
  Package,
  ArrowUpRight,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

const PERIODS = [
  { id: 'day', label: 'Сегодня' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Всё время' },
];

export default function AdminOverview({ onNavigate }) {
  const toast = useToast();
  const [period, setPeriod] = useState('month');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(
    async (selectedPeriod) => {
      try {
        setLoading(true);
        const res = await adminApi.getStats(selectedPeriod);
        if (res.success) {
          setStats(res.stats);
        }
      } catch (err) {
        toast.error(err.message || 'Не удалось загрузить статистику');
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    loadStats(period);
  }, [period, loadStats]);

  if (loading && !stats) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-32 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
        ))}
      </div>
    );
  }

  const s = stats || {};
  const log = s.logistics || {};

  const queues = [
    {
      label: 'Активные заказы',
      count: s.pendingOrders || 0,
      color: 'amber',
      tab: 'orders',
      arg: 'active',
      Icon: Clock,
    },
    {
      label: 'Предзаказы',
      count: s.preorderOrders || 0,
      color: 'sky',
      tab: 'orders',
      arg: 'preorder',
      Icon: Package,
    },
    {
      label: 'Споры',
      count: s.disputedOrders || 0,
      color: 'rose',
      tab: 'orders',
      arg: 'disputed',
      Icon: AlertTriangle,
    },
    {
      label: 'Замены по гарантии',
      count: s.pendingWarranties || 0,
      color: 'violet',
      tab: 'orders',
      arg: 'warranty',
      Icon: ShieldAlert,
    },
    {
      label: 'Заявки на пополнение',
      count: s.pendingTopups || 0,
      color: 'emerald',
      tab: 'requests',
      arg: 'topups',
      Icon: Wallet,
    },
    {
      label: 'Выводы продавцов',
      count: s.pendingWithdrawals || 0,
      color: 'orange',
      tab: 'requests',
      arg: 'withdrawals',
      Icon: ArrowUpRight,
    },
  ];

  const queueColorMap = {
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
    sky: 'bg-sky-500/10 border-sky-500/30 text-sky-300',
    rose: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
    violet: 'bg-violet-500/10 border-violet-500/30 text-violet-300',
    emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
    orange: 'bg-orange-500/10 border-orange-500/30 text-orange-300',
  };

  return (
    <div className="space-y-6">
      {/* Заголовок и фильтр периода */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Сводка и логистика</h2>
          <p className="text-xs text-slate-400">
            Курс: <span className="font-mono text-white">1 USDT = {Number(s.currentRateRub || 0).toFixed(2)} ₽</span>
            {s.baseRateRub ? ` (базовый ${Number(s.baseRateRub).toFixed(2)} ₽)` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl bg-dark-card border border-dark-border p-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  period === p.id
                    ? 'bg-brand text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => loadStats(period)}
            disabled={loading}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300 hover:text-white"
            title="Обновить статистику"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Основные KPI-карточки */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-semibold">
            <span>Общая выручка</span>
            <DollarSign className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white">
            {Number(s.totalRevenue || 0).toFixed(2)} <span className="text-xs text-slate-400">USDT</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-dark-border/50">
            <span>Сегодня: <b className="text-emerald-400 font-mono">{Number(s.todayRevenue || 0).toFixed(2)}$</b></span>
            <span>Месяц: <b className="text-white font-mono">{Number(s.monthRevenue || 0).toFixed(2)}$</b></span>
          </div>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-semibold">
            <span>Заказы магазина</span>
            <ShoppingBag className="h-4 w-4 text-brand" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white">
            {s.completedOrders || 0} <span className="text-sm font-normal text-slate-500">/ {s.totalOrders || 0}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-dark-border/50">
            <span>Выполнено</span>
            <span>Активных: <b className="text-amber-400 font-mono">{s.pendingOrders || 0}</b></span>
          </div>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-semibold">
            <span>Пользователи</span>
            <Users className="h-4 w-4 text-sky-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white">
            {s.totalUsers || 0}
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-dark-border/50">
            <span>Новых сегодня: <b className="text-emerald-400 font-mono">+{s.newUsersToday || 0}</b></span>
            <span>Банов: <b className="text-rose-400 font-mono">{s.bannedUsers || 0}</b></span>
          </div>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-semibold">
            <span>Ключи и каталог</span>
            <KeyRound className="h-4 w-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-white">
            {s.keysFree || 0} <span className="text-xs font-normal text-slate-400">свободных</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-dark-border/50">
            <span>Товаров: <b className="text-white font-mono">{s.activeProducts || 0}/{s.totalProducts || 0}</b></span>
            <span>Выдано ключей: <b className="text-slate-300 font-mono">{s.keysUsed || 0}</b></span>
          </div>
        </div>
      </div>

      {/* Логистика за выбранный период */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <TrendingUp className="h-4 w-4 text-brand" />
          <span>Финансовая логистика за период ({PERIODS.find((p) => p.id === period)?.label})</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Выручка</div>
            <div className="mt-1 font-mono text-base font-bold text-white tabular-nums">
              {Number(log.periodRevenue || 0).toFixed(2)}$
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Себестоимость</div>
            <div className="mt-1 font-mono text-base font-bold text-slate-300 tabular-nums">
              {Number(log.periodCost || 0).toFixed(2)}$
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Чистая прибыль</div>
            <div className="mt-1 font-mono text-base font-bold text-emerald-400 tabular-nums">
              {Number(log.periodProfit || 0).toFixed(2)}$
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Пополнения</div>
            <div className="mt-1 font-mono text-base font-bold text-sky-400 tabular-nums">
              {Number(log.periodTopups || 0).toFixed(2)}$
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Возвраты</div>
            <div className="mt-1 font-mono text-base font-bold text-rose-400 tabular-nums">
              {Number(log.periodRefunds || 0).toFixed(2)}$
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Заказов</div>
            <div className="mt-1 font-mono text-base font-bold text-white tabular-nums">
              {log.periodCount || 0}
            </div>
          </div>
          <div className="rounded-xl bg-dark-surface border border-dark-border/70 p-3">
            <div className="text-[11px] text-slate-400">Новых юзеров</div>
            <div className="mt-1 font-mono text-base font-bold text-emerald-400 tabular-nums">
              +{log.newUsersPeriod || 0}
            </div>
          </div>
        </div>
      </div>

      {/* Очереди внимания и Топ товаров */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Бейджи очередей */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <h3 className="text-sm font-bold text-white">Очереди и задачи</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {queues.map((q) => {
              const Icon = q.Icon;
              const hasItems = q.count > 0;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => onNavigate && onNavigate(q.tab, q.arg)}
                  className={`flex items-center justify-between rounded-xl border p-3.5 text-left transition-all hover:scale-[1.01] ${
                    hasItems
                      ? queueColorMap[q.color]
                      : 'bg-dark-surface/50 border-dark-border text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="text-xs font-semibold truncate">{q.label}</span>
                  </div>
                  <span className="rounded-lg bg-dark-bg/70 px-2.5 py-0.5 font-mono text-xs font-bold tabular-nums">
                    {q.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Топ-товары */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <h3 className="text-sm font-bold text-white">Топ товаров за период</h3>
          {!s.recentTopProducts || s.recentTopProducts.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              За выбранный период продаж пока не было
            </div>
          ) : (
            <div className="space-y-2.5">
              {s.recentTopProducts.map((item, idx) => (
                <div
                  key={item.productId || idx}
                  className="flex items-center justify-between gap-3 rounded-xl bg-dark-surface/60 border border-dark-border/70 p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-5 text-center font-mono text-xs font-bold text-slate-500">
                      #{idx + 1}
                    </span>
                    <BrandIcon size={32} name={item.name} rounded="lg" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{item.name}</div>
                      <div className="text-[11px] text-slate-400">
                        Продаж: <span className="font-mono text-slate-200">{item.count}</span> шт.
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-xs font-bold text-emerald-400 tabular-nums">
                    {Number(item.revenue || 0).toFixed(2)} USDT
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

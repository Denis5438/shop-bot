'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, Wallet, ArrowUpRight, Copy, Loader2, Crown } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

export default function AdminRequests({ initialSubTab = 'topups', onUpdated }) {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();

  const [subTab, setSubTab] = useState(initialSubTab); // 'topups' | 'withdrawals'
  const [statusFilter, setStatusFilter] = useState('pending'); // 'pending' | 'all'
  const [topups, setTopups] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    setSubTab(initialSubTab || 'topups');
  }, [initialSubTab]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [tRes, wRes] = await Promise.all([
        adminApi.getTopups({ status: statusFilter, limit: 50 }),
        adminApi.getWithdrawals({ status: statusFilter, limit: 50 }),
      ]);
      if (tRes.success) setTopups(tRes.topups || []);
      if (wRes.success) setWithdrawals(wRes.withdrawals || []);
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить заявки');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAction = async (id, fn, msg) => {
    try {
      setBusyId(id);
      await fn();
      toast.success(msg);
      await loadData();
      if (onUpdated) onUpdated();
    } catch (err) {
      toast.error(err.message || 'Ошибка обработки заявки');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Заявки на пополнение и выводы</h2>
          <p className="text-xs text-slate-400">
            Подтверждение и отклонение пополнений (TopupRequest) и выплат продавцам (SellerWithdrawal)
          </p>
        </div>

        {!isSuperAdmin && (
          <div className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 text-xs text-amber-300">
            <Crown className="h-3.5 w-3.5" />
            <span>Одобрение/отклонение доступно только SuperAdmin</span>
          </div>
        )}
      </div>

      {/* Переключатели */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 rounded-2xl bg-dark-card border border-dark-border p-1.5 text-xs">
          <button
            type="button"
            onClick={() => setSubTab('topups')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 font-semibold ${
              subTab === 'topups' ? 'bg-brand text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Wallet className="h-3.5 w-3.5" />
            <span>Пополнения ({topups.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('withdrawals')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 font-semibold ${
              subTab === 'withdrawals' ? 'bg-brand text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            <span>Выводы продавцов ({withdrawals.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-xl bg-dark-card border border-dark-border p-1 text-xs">
          {[
            { id: 'pending', label: 'Ожидают' },
            { id: 'all', label: 'Все' },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={`rounded-lg px-3 py-1 font-semibold ${
                statusFilter === f.id ? 'bg-dark-surface text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Таблица TopupRequest */}
      {subTab === 'topups' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
                <tr>
                  <th className="p-3.5">Пользователь</th>
                  <th className="p-3.5">Сумма</th>
                  <th className="p-3.5">Метод / TXID</th>
                  <th className="p-3.5">Статус / Дата</th>
                  <th className="p-3.5 text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="p-10 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
                    </td>
                  </tr>
                ) : topups.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-slate-500">
                      Заявки на пополнение отсутствуют
                    </td>
                  </tr>
                ) : (
                  topups.map((t) => (
                    <tr key={t.id} className="hover:bg-dark-surface/40">
                      <td className="p-3.5 whitespace-nowrap">
                        <div className="font-semibold text-white">
                          {t.user?.username ? `@${t.user.username}` : t.user?.firstName || 'Пользователь'}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">TG: {t.user?.telegramId || '—'}</div>
                      </td>
                      <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                        <div className="font-bold text-emerald-400">{Number(t.amount || 0).toFixed(2)} USDT</div>
                        {t.amountRub && <div className="text-[10px] text-slate-400">{t.amountRub} ₽</div>}
                      </td>
                      <td className="p-3.5 max-w-xs">
                        <div className="font-mono text-slate-200">
                          {t.method} {t.network ? `(${t.network})` : ''}
                        </div>
                        {t.txid && (
                          <div className="text-[10px] font-mono text-sky-400 truncate">{t.txid}</div>
                        )}
                        {t.proofText && (
                          <div className="text-[10px] text-slate-400 truncate">{t.proofText}</div>
                        )}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ${
                            t.status === 'confirmed'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : t.status === 'rejected'
                              ? 'bg-rose-500/15 text-rose-400'
                              : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {t.status}
                        </span>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {new Date(t.createdAt).toLocaleString('ru-RU')}
                        </div>
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap">
                        {t.status === 'pending' && (
                          <div className="inline-flex gap-1.5">
                            <button
                              type="button"
                              disabled={!isSuperAdmin || busyId === t.id}
                              onClick={() =>
                                handleAction(
                                  t.id,
                                  () => adminApi.approveTopup(t.id),
                                  'Пополнение одобрено, средства зачислены'
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/35 px-2.5 py-1.5 font-bold text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>Одобрить</span>
                            </button>
                            <button
                              type="button"
                              disabled={!isSuperAdmin || busyId === t.id}
                              onClick={() =>
                                handleAction(
                                  t.id,
                                  () => adminApi.rejectTopup(t.id),
                                  'Заявка отклонена'
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 border border-rose-500/35 px-2.5 py-1.5 font-bold text-rose-400 hover:bg-rose-500/25 disabled:opacity-40"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              <span>Отклонить</span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Таблица SellerWithdrawal */}
      {subTab === 'withdrawals' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
                <tr>
                  <th className="p-3.5">Продавец</th>
                  <th className="p-3.5">Сумма</th>
                  <th className="p-3.5">Сеть / Кошелёк</th>
                  <th className="p-3.5">Статус / Дата</th>
                  <th className="p-3.5 text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border/60">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="p-10 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
                    </td>
                  </tr>
                ) : withdrawals.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-slate-500">
                      Заявки на вывод отсутствуют
                    </td>
                  </tr>
                ) : (
                  withdrawals.map((w) => (
                    <tr key={w.id} className="hover:bg-dark-surface/40">
                      <td className="p-3.5 whitespace-nowrap">
                        <div className="font-semibold text-white">
                          {w.seller?.username ? `@${w.seller.username}` : 'Продавец'}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">TG: {w.seller?.telegramId || '—'}</div>
                      </td>
                      <td className="p-3.5 font-mono font-bold text-amber-300 tabular-nums whitespace-nowrap">
                        {Number(w.amount || 0).toFixed(2)} USDT
                      </td>
                      <td className="p-3.5">
                        <div className="font-semibold text-slate-200">{w.network}</div>
                        <div className="flex items-center gap-1.5 text-[11px] font-mono text-sky-400">
                          <span className="truncate max-w-[220px] select-all">{w.walletAddress}</span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(w.walletAddress || '');
                              toast.success('Адрес скопирован');
                            }}
                            className="text-slate-400 hover:text-white"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ${
                            w.status === 'completed'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : w.status === 'rejected'
                              ? 'bg-rose-500/15 text-rose-400'
                              : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {w.status}
                        </span>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {new Date(w.createdAt).toLocaleString('ru-RU')}
                        </div>
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap">
                        {w.status === 'pending' && (
                          <div className="inline-flex gap-1.5">
                            <button
                              type="button"
                              disabled={!isSuperAdmin || busyId === w.id}
                              onClick={() =>
                                handleAction(
                                  w.id,
                                  () => adminApi.confirmWithdrawal(w.id),
                                  'Выплата продавцу подтверждена'
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/35 px-2.5 py-1.5 font-bold text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>Выплачено</span>
                            </button>
                            <button
                              type="button"
                              disabled={!isSuperAdmin || busyId === w.id}
                              onClick={() =>
                                handleAction(
                                  w.id,
                                  () => adminApi.rejectWithdrawal(w.id),
                                  'Вывод отклонён, средства возвращены продавцу'
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 border border-rose-500/35 px-2.5 py-1.5 font-bold text-rose-400 hover:bg-rose-500/25 disabled:opacity-40"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              <span>Отклонить</span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

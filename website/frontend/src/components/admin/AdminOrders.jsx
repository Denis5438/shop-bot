'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Eye,
  X,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Send,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

const FILTER_TABS = [
  { id: 'all', label: 'Все' },
  { id: 'active', label: 'Активные' },
  { id: 'preorder', label: 'Предзаказы' },
  { id: 'completed', label: 'Выполненные' },
  { id: 'cancelled', label: 'Отменённые' },
  { id: 'disputed', label: 'Споры' },
  { id: 'warranty', label: 'Замены' },
];

export default function AdminOrders({ initialFilter = 'all', onUpdated }) {
  const toast = useToast();

  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);

  // Модалка заказа
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [deliveryInput, setDeliveryInput] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    setFilter(initialFilter || 'all');
    setPage(1);
  }, [initialFilter]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getOrders({
        filter,
        search: debouncedSearch,
        page,
        limit: 25,
      });
      if (res.success) {
        setOrders(res.orders || []);
        setPagination(res.pagination || { page: 1, pages: 1, total: 0 });
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить заказы');
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedSearch, page, toast]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const openOrder = (order) => {
    setSelectedOrder(order);
    setDeliveryInput(order.deliveryData || order.key || '');
    setActionReason('');
  };

  const runOrderAction = async (fn, successMsg) => {
    try {
      setBusyAction(true);
      await fn();
      toast.success(successMsg);
      setSelectedOrder(null);
      await loadOrders();
      if (onUpdated) onUpdated();
    } catch (err) {
      toast.error(err.message || 'Ошибка выполнения операции');
    } finally {
      setBusyAction(false);
    }
  };

  const getStatusBadge = (o) => {
    if (o.status === 'disputed' || o.disputeStatus === 'open') {
      return <span className="rounded-md bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[10px] font-bold text-rose-400">Спор</span>;
    }
    if (o.replacementStatus === 'pending') {
      return <span className="rounded-md bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-[10px] font-bold text-violet-300">Замена</span>;
    }
    if (o.status === 'completed') {
      return <span className="rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400">Выполнен</span>;
    }
    if (o.status === 'cancelled' || o.status === 'failed') {
      return <span className="rounded-md bg-slate-800 border border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-400">Отменён</span>;
    }
    return <span className="rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-300">{o.status}</span>;
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white">Заказы магазина ({pagination.total})</h2>
        <p className="text-xs text-slate-400">
          Обработка активных заказов, ручная выдача, возвраты, споры и гарантийные замены
        </p>
      </div>

      {/* Вкладки статусов и поиск */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-dark-card border border-dark-border p-1.5">
          {FILTER_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setFilter(t.id);
                setPage(1);
              }}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                filter === t.id ? 'bg-brand text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по ID, @username, товару..."
            className="w-full rounded-xl bg-dark-card border border-dark-border py-2.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
          />
        </div>
      </div>

      {/* Таблица заказов */}
      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
              <tr>
                <th className="p-3.5">Заказ</th>
                <th className="p-3.5">Покупатель</th>
                <th className="p-3.5">Товар</th>
                <th className="p-3.5">Сумма / Прибыль</th>
                <th className="p-3.5">Статус</th>
                <th className="p-3.5 text-right">Управление</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border/60">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-500">
                    Заказы не найдены
                  </td>
                </tr>
              ) : (
                orders.map((o) => (
                  <tr key={o.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5 font-mono whitespace-nowrap">
                      <div className="text-white font-bold">#{String(o.id).slice(-8)}</div>
                      <div className="text-[10px] text-slate-500">
                        {new Date(o.createdAt).toLocaleString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      <div className="font-semibold text-slate-200">
                        {o.user?.username ? `@${o.user.username}` : o.user?.firstName || 'Пользователь'}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">
                        ID: {o.user?.telegramId || '—'}
                      </div>
                    </td>
                    <td className="p-3.5">
                      <div className="flex items-center gap-2.5 min-w-[180px]">
                        <BrandIcon size={30} name={o.product?.name || 'Товар'} rounded="lg" />
                        <div className="min-w-0">
                          <div className="font-medium text-white truncate max-w-[220px]">
                            {o.product?.name || 'Товар'}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {o.qty || 1} шт. • {o.provider || o.product?.type || 'local'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                      <div className="font-bold text-white">{Number(o.price || 0).toFixed(2)} $</div>
                      <div className="text-[10px] text-emerald-400">
                        Прибыль: {Number(o.profit ?? (o.price || 0) - (o.costPrice || 0)).toFixed(2)} $
                      </div>
                    </td>
                    <td className="p-3.5 whitespace-nowrap">{getStatusBadge(o)}</td>
                    <td className="p-3.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openOrder(o)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand/50 hover:text-white"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>Открыть</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {pagination.pages > 1 && (
          <div className="flex items-center justify-between border-t border-dark-border px-4 py-3 text-xs">
            <span className="text-slate-400">
              Страница {pagination.page} из {pagination.pages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-dark-surface border border-dark-border text-slate-300 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={page >= pagination.pages}
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-dark-surface border border-dark-border text-slate-300 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Модалка детального управления заказом */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setSelectedOrder(null)}
        >
          <div
            className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-5 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-dark-border">
              <div className="flex items-center gap-3">
                <BrandIcon size={40} name={selectedOrder.product?.name || 'Товар'} />
                <div>
                  <h3 className="text-base font-bold text-white">
                    Заказ #{String(selectedOrder.id).slice(-8)}
                  </h3>
                  <div className="text-slate-400">
                    {selectedOrder.product?.name} • {selectedOrder.qty || 1} шт. •{' '}
                    <b className="text-emerald-400 font-mono">{Number(selectedOrder.price || 0).toFixed(2)} USDT</b>
                  </div>
                </div>
              </div>
              <button type="button" onClick={() => setSelectedOrder(null)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Информация */}
            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-dark-surface/60 border border-dark-border p-3.5">
              <div>
                <span className="text-slate-400 block">Покупатель:</span>
                <span className="font-semibold text-white">
                  {selectedOrder.user?.username ? `@${selectedOrder.user.username}` : selectedOrder.user?.firstName || '—'} (ID {selectedOrder.user?.telegramId})
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Статус заказа:</span>
                <div className="mt-0.5">{getStatusBadge(selectedOrder)}</div>
              </div>
              {selectedOrder.notes && (
                <div className="col-span-2">
                  <span className="text-slate-400 block">Заметки / Данные покупателя:</span>
                  <span className="font-mono text-slate-200 break-all">{selectedOrder.notes}</span>
                </div>
              )}
              {selectedOrder.replacementReason && (
                <div className="col-span-2 rounded-xl bg-violet-500/10 border border-violet-500/25 p-2.5 text-violet-200">
                  <b>Причина запроса замены:</b> {selectedOrder.replacementReason}
                </div>
              )}
            </div>

            {/* Ручное выполнение */}
            {selectedOrder.status !== 'cancelled' && (
              <div className="space-y-2">
                <label className="block font-semibold text-slate-300">
                  Данные выдачи (ключ / аккаунт / результат активации):
                </label>
                <textarea
                  rows={3}
                  value={deliveryInput}
                  onChange={(e) => setDeliveryInput(e.target.value)}
                  placeholder="Введите данные доступа для покупателя..."
                  className="w-full rounded-xl bg-dark-input border border-dark-border p-3 font-mono text-white focus:border-brand focus:outline-none"
                />
                {selectedOrder.status !== 'completed' && (
                  <button
                    type="button"
                    disabled={busyAction || !deliveryInput.trim()}
                    onClick={() =>
                      runOrderAction(
                        () => adminApi.completeOrder(selectedOrder.id, deliveryInput.trim()),
                        'Заказ выполнен вручную и отправлен покупателю'
                      )
                    }
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span>Выполнить вручную и выдать</span>
                  </button>
                )}
              </div>
            )}

            {/* Причина для отмены / гарантии / спора */}
            <div>
              <label className="block font-semibold text-slate-300 mb-1">
                Комментарий / Причина (для отмены, спора или гарантии):
              </label>
              <input
                type="text"
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                placeholder="Необязательно (будет отправлено в уведомлении)"
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
              />
            </div>

            {/* Кнопки споров, гарантии и отмены */}
            <div className="space-y-2.5 pt-2 border-t border-dark-border">
              {selectedOrder.replacementStatus === 'pending' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() =>
                      runOrderAction(
                        () =>
                          adminApi.resolveWarranty(selectedOrder.id, {
                            action: 'approve',
                            deliveryData: deliveryInput.trim() || undefined,
                            reason: actionReason,
                          }),
                        'Замена по гарантии одобрена'
                      )
                    }
                    className="flex items-center justify-center gap-1.5 rounded-xl bg-violet-500/20 border border-violet-500/40 py-2.5 font-bold text-violet-200 hover:bg-violet-500/30 disabled:opacity-50"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    <span>Одобрить замену по гарантии</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() =>
                      runOrderAction(
                        () => adminApi.resolveWarranty(selectedOrder.id, { action: 'reject', reason: actionReason }),
                        'Запрос замены отклонён'
                      )
                    }
                    className="flex items-center justify-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border py-2.5 font-semibold text-slate-300 hover:text-rose-400 disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Отклонить замену</span>
                  </button>
                </div>
              )}

              {(selectedOrder.status === 'disputed' || selectedOrder.disputeStatus === 'open') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() =>
                      runOrderAction(
                        () => adminApi.resolveDispute(selectedOrder.id, { resolution: 'refund_buyer', reason: actionReason }),
                        'Спор решён: возврат покупателю'
                      )
                    }
                    className="flex items-center justify-center gap-1.5 rounded-xl bg-amber-500/20 border border-amber-500/40 py-2.5 font-bold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>Спор: вернуть покупателю</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() =>
                      runOrderAction(
                        () => adminApi.resolveDispute(selectedOrder.id, { resolution: 'pay_seller', reason: actionReason }),
                        'Спор решён: выплата продавцу'
                      )
                    }
                    className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/20 border border-emerald-500/40 py-2.5 font-bold text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>Спор: выплатить продавцу</span>
                  </button>
                </div>
              )}

              {selectedOrder.status !== 'cancelled' && (
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() =>
                    runOrderAction(
                      () => adminApi.cancelOrder(selectedOrder.id, actionReason),
                      'Заказ отменён, средства возвращены на баланс покупателя'
                    )
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-rose-500/15 border border-rose-500/35 py-2.5 font-bold text-rose-400 hover:bg-rose-500/25 disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  <span>Отменить заказ с возвратом средств</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

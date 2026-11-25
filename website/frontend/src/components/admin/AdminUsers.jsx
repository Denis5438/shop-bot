'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  UserCog,
  Ban,
  CheckCircle2,
  Send,
  X,
  Wallet,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Shield,
  Crown,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

const USER_FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'with_balance', label: 'С балансом' },
  { id: 'banned', label: 'Заблокированные' },
  { id: 'admins', label: 'Админы' },
];

export default function AdminUsers() {
  const { user: currentUser, isSuperAdmin } = useAuth();
  const toast = useToast();

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [users, setUsers] = useState([]);
  const [totalBalanceSum, setTotalBalanceSum] = useState(0);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);

  // Детальное окно пользователя
  const [modalOpen, setModalOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [targetUser, setTargetUser] = useState(null);
  const [userStats, setUserStats] = useState({ ordersCount: 0, referralsCount: 0 });
  const [transactions, setTransactions] = useState([]);

  // Управление балансом
  const [balMode, setBalMode] = useState('add'); // 'add' | 'sub' | 'zero'
  const [balAmount, setBalAmount] = useState('10');
  const [balReason, setBalReason] = useState('');
  const [balBusy, setBalBusy] = useState(false);

  // Сообщение в Telegram
  const [tgMessage, setTgMessage] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getUsers({
        filter,
        search: debouncedSearch,
        page,
        limit: 25,
      });
      if (res.success) {
        setUsers(res.users || []);
        setTotalBalanceSum(Number(res.totalBalanceSum || 0));
        setPagination(res.pagination || { page: 1, pages: 1, total: 0 });
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить пользователей');
    } finally {
      setLoading(false);
    }
  }, [filter, debouncedSearch, page, toast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const openUserModal = async (u) => {
    setModalOpen(true);
    setTargetUser(u);
    setBalMode('add');
    setBalAmount('10');
    setBalReason('');
    setTgMessage('');
    setTransactions([]);

    try {
      setDetailLoading(true);
      const res = await adminApi.getUserById(u.id);
      if (res.success) {
        if (res.user) setTargetUser(res.user);
        setUserStats(res.stats || { ordersCount: 0, referralsCount: 0 });
        setTransactions(res.recentTransactions || []);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки карточки пользователя');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleAdjustBalance = async (e) => {
    e.preventDefault();
    if (!targetUser) return;

    const uid = targetUser.id || targetUser._id;
    let payload;
    if (balMode === 'zero') {
      payload = { action: 'zero', reason: balReason.trim() || 'Обнуление баланса администратором' };
    } else {
      const amt = parseFloat(balAmount);
      if (isNaN(amt) || amt <= 0) {
        toast.error('Введите положительную сумму');
        return;
      }
      const delta = balMode === 'add' ? amt : -amt;
      payload = { delta, reason: balReason.trim() || 'Корректировка баланса администратором' };
    }

    try {
      setBalBusy(true);
      await adminApi.adjustUserBalance(uid, payload);
      toast.success('Баланс пользователя обновлён');
      await loadUsers();
      await openUserModal({ ...targetUser, id: uid });
    } catch (err) {
      toast.error(err.message || 'Ошибка изменения баланса');
    } finally {
      setBalBusy(false);
    }
  };

  const handleToggleBan = async () => {
    if (!targetUser) return;
    const uid = targetUser.id || targetUser._id;
    try {
      const nextBan = !targetUser.isBanned;
      await adminApi.updateUser(uid, { isBanned: nextBan });
      toast.success(nextBan ? 'Пользователь заблокирован' : 'Пользователь разблокирован');
      setTargetUser({ ...targetUser, isBanned: nextBan });
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Ошибка изменения блокировки');
    }
  };

  const handleChangeRole = async (newRole) => {
    if (!targetUser || !isSuperAdmin) return;
    const uid = targetUser.id || targetUser._id;
    try {
      await adminApi.updateUser(uid, { role: newRole });
      toast.success(`Роль изменена на ${newRole}`);
      setTargetUser({ ...targetUser, role: newRole });
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Ошибка изменения роли');
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!targetUser || !tgMessage.trim()) return;
    const uid = targetUser.id || targetUser._id;
    try {
      setSendingMsg(true);
      await adminApi.sendMessageToUser(uid, tgMessage.trim());
      toast.success('Сообщение отправлено в Telegram');
      setTgMessage('');
    } catch (err) {
      toast.error(err.message || 'Не удалось отправить сообщение');
    } finally {
      setSendingMsg(false);
    }
  };

  const numAmount = parseFloat(balAmount) || 0;
  const needsSuperAdminForBalance = balMode === 'zero' || numAmount > 100;

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Пользователи ({pagination.total})</h2>
          <p className="text-xs text-slate-400">
            Суммарный баланс на счетах: <b className="text-emerald-400 font-mono">{totalBalanceSum.toFixed(2)} USDT</b>
          </p>
        </div>
      </div>

      {/* Фильтры */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-dark-card border border-dark-border p-1.5">
          {USER_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFilter(f.id);
                setPage(1);
              }}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                filter === f.id ? 'bg-brand text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Telegram ID, @username, имя..."
            className="w-full rounded-xl bg-dark-card border border-dark-border py-2.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
          />
        </div>
      </div>

      {/* Таблица пользователей */}
      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
              <tr>
                <th className="p-3.5">Пользователь</th>
                <th className="p-3.5">Баланс</th>
                <th className="p-3.5">Потрачено</th>
                <th className="p-3.5">Роль</th>
                <th className="p-3.5">Статус</th>
                <th className="p-3.5 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border/60">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-500">
                    Пользователи не найдены
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5">
                      <div className="font-semibold text-white">
                        {u.username ? `@${u.username}` : u.firstName || 'Без имени'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">TG: {u.telegramId}</div>
                    </td>
                    <td className="p-3.5 font-mono font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                      {Number(u.balance || 0).toFixed(2)} USDT
                    </td>
                    <td className="p-3.5 font-mono text-slate-300 tabular-nums whitespace-nowrap">
                      {Number(u.totalSpent || 0).toFixed(2)} USDT
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
                          u.role === 'superadmin'
                            ? 'bg-amber-500/15 text-amber-300'
                            : u.role === 'admin'
                            ? 'bg-sky-500/15 text-sky-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {u.role === 'superadmin' && <Crown className="h-3 w-3" />}
                        {u.role}
                      </span>
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      {u.isBanned ? (
                        <span className="rounded-md bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-400">
                          Забанен
                        </span>
                      ) : (
                        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                          Активен
                        </span>
                      )}
                    </td>
                    <td className="p-3.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openUserModal(u)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand/50 hover:text-white"
                      >
                        <UserCog className="h-3.5 w-3.5" />
                        <span>Управление</span>
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

      {/* Модалка управления пользователем */}
      {modalOpen && targetUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-5 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-dark-border">
              <div>
                <h3 className="text-base font-bold text-white">
                  {targetUser.username ? `@${targetUser.username}` : targetUser.firstName || 'Пользователь'}
                </h3>
                <div className="text-slate-400 font-mono mt-0.5">
                  Telegram ID: {targetUser.telegramId} • Баланс:{' '}
                  <b className="text-emerald-400">{Number(targetUser.balance || 0).toFixed(2)} USDT</b>
                </div>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Сводка */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                <div className="text-slate-400">Потрачено</div>
                <div className="font-mono font-bold text-white mt-0.5">
                  {Number(targetUser.totalSpent || 0).toFixed(2)} $
                </div>
              </div>
              <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                <div className="text-slate-400">Заказов</div>
                <div className="font-mono font-bold text-white mt-0.5">{userStats.ordersCount || 0}</div>
              </div>
              <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                <div className="text-slate-400">Рефералов</div>
                <div className="font-mono font-bold text-white mt-0.5">{userStats.referralsCount || 0}</div>
              </div>
            </div>

            {/* Корректировка баланса */}
            <form onSubmit={handleAdjustBalance} className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-white flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-emerald-400" />
                  <span>Управление балансом</span>
                </span>
                {!isSuperAdmin && (
                  <span className="text-[10px] text-amber-300">
                    Лимит для Admin: до ±100 USDT (свыше и обнуление — SuperAdmin)
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'add', label: '+ Начислить' },
                  { id: 'sub', label: '- Списать' },
                  { id: 'zero', label: 'Обнулить баланс' },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setBalMode(m.id)}
                    className={`rounded-xl px-3 py-1.5 font-semibold border transition-all ${
                      balMode === m.id
                        ? 'bg-brand border-brand text-white'
                        : 'bg-dark-card border-dark-border text-slate-300'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {balMode !== 'zero' && (
                  <div>
                    <label className="block text-slate-400 mb-1">Сумма (USDT)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={balAmount}
                      onChange={(e) => setBalAmount(e.target.value)}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                    />
                  </div>
                )}
                <div className={balMode === 'zero' ? 'sm:col-span-2' : ''}>
                  <label className="block text-slate-400 mb-1">Причина (запишется в аудит Transaction)</label>
                  <input
                    type="text"
                    value={balReason}
                    onChange={(e) => setBalReason(e.target.value)}
                    placeholder="Например: Возврат или бонус"
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={balBusy || (needsSuperAdminForBalance && !isSuperAdmin)}
                className="inline-flex items-center justify-center rounded-xl bg-emerald-500 px-4 py-2 font-bold text-black hover:bg-emerald-400 disabled:opacity-40"
              >
                {balBusy ? 'Выполнение...' : 'Применить операцию баланса'}
              </button>
            </form>

            {/* Бан и Роль */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 space-y-2.5">
                <div className="font-bold text-white">Блокировка аккаунта</div>
                <button
                  type="button"
                  disabled={
                    targetUser.role === 'superadmin' ||
                    String(targetUser.telegramId) === String(currentUser?.telegramId)
                  }
                  onClick={handleToggleBan}
                  className={`flex w-full items-center justify-center gap-2 rounded-xl py-2 font-bold border disabled:opacity-40 ${
                    targetUser.isBanned
                      ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-400'
                      : 'bg-rose-500/15 border-rose-500/35 text-rose-400'
                  }`}
                >
                  {targetUser.isBanned ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Разблокировать</span>
                    </>
                  ) : (
                    <>
                      <Ban className="h-4 w-4" />
                      <span>Заблокировать</span>
                    </>
                  )}
                </button>
              </div>

              <div className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 space-y-2.5">
                <div className="font-bold text-white flex items-center gap-1.5">
                  <Shield className="h-4 w-4 text-sky-400" />
                  <span>Роль (только SuperAdmin)</span>
                </div>
                {isSuperAdmin &&
                targetUser.role !== 'superadmin' &&
                String(targetUser.telegramId) !== String(currentUser?.telegramId) ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleChangeRole('user')}
                      className={`flex-1 rounded-xl py-2 font-bold border ${
                        targetUser.role === 'user'
                          ? 'bg-brand border-brand text-white'
                          : 'bg-dark-card border-dark-border text-slate-300'
                      }`}
                    >
                      User
                    </button>
                    <button
                      type="button"
                      onClick={() => handleChangeRole('admin')}
                      className={`flex-1 rounded-xl py-2 font-bold border ${
                        targetUser.role === 'admin'
                          ? 'bg-sky-500 border-sky-500 text-white'
                          : 'bg-dark-card border-dark-border text-slate-300'
                      }`}
                    >
                      Admin
                    </button>
                  </div>
                ) : (
                  <div className="text-slate-400 py-2">
                    Текущая роль: <b className="text-white uppercase">{targetUser.role}</b>
                  </div>
                )}
              </div>
            </div>

            {/* Отправка сообщения в Telegram */}
            <form onSubmit={handleSendMessage} className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 space-y-3">
              <div className="font-bold text-white">Отправить сообщение пользователю в Telegram</div>
              <textarea
                rows={2}
                value={tgMessage}
                onChange={(e) => setTgMessage(e.target.value)}
                placeholder="Текст уведомления от имени бота..."
                className="w-full rounded-xl bg-dark-input border border-dark-border p-3 text-white focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                disabled={sendingMsg || !tgMessage.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 font-bold text-white hover:bg-brand-hover disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" />
                <span>{sendingMsg ? 'Отправка...' : 'Отправить в Telegram'}</span>
              </button>
            </form>

            {/* Последние транзакции */}
            <div className="space-y-2">
              <div className="font-bold text-white">Последние транзакции</div>
              {detailLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-brand" />
              ) : transactions.length === 0 ? (
                <div className="text-slate-500">Транзакций пока нет</div>
              ) : (
                <div className="max-h-44 overflow-y-auto rounded-xl border border-dark-border divide-y divide-dark-border/60">
                  {transactions.map((tx, idx) => (
                    <div key={tx._id || tx.id || idx} className="flex items-center justify-between px-3 py-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-200 truncate">
                          {tx.description || tx.type}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {tx.type} • {new Date(tx.createdAt).toLocaleString('ru-RU')}
                        </div>
                      </div>
                      <span
                        className={`font-mono font-bold shrink-0 ${
                          Number(tx.amount) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {Number(tx.amount) >= 0 ? '+' : ''}
                        {Number(tx.amount || 0).toFixed(2)} $
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

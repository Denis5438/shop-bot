'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { TicketPercent, Plus, Trash2, X, Dices, Loader2, Power } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';

const INITIAL_FORM = {
  code: '',
  type: 'percent',
  value: '10',
  maxActivations: '-1',
  maxPerUser: '1',
  minOrderAmount: '0',
  productId: '',
  minQuantity: '1',
  discountTarget: 'all',
  audienceCondition: 'all',
  expiresAt: '',
  isActive: true,
};

export default function AdminPromos() {
  const toast = useToast();

  const [promos, setPromos] = useState([]);
  const [totalUsages, setTotalUsages] = useState(0);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);

  const loadPromos = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getPromos();
      if (res.success) {
        setPromos(res.promos || []);
        setTotalUsages(res.totalUsages || 0);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки промокодов');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadPromos();
    adminApi
      .getProducts({ limit: 250 })
      .then((r) => {
        if (r.success) setProducts(r.products || []);
      })
      .catch(() => {});
  }, [loadPromos]);

  const generateRandomCode = () => {
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    setForm((prev) => ({ ...prev, code: `PROMO${rand}` }));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.code.trim()) {
      toast.error('Укажите код промокода');
      return;
    }

    const payload = {
      code: form.code.trim().toUpperCase(),
      type: form.type,
      value: Number(form.value) || 0,
      maxActivations: parseInt(form.maxActivations, 10) || -1,
      maxPerUser: Math.max(1, parseInt(form.maxPerUser, 10) || 1),
      minOrderAmount: Number(form.minOrderAmount) || 0,
      productId: form.productId || null,
      minQuantity: Math.max(1, parseInt(form.minQuantity, 10) || 1),
      discountTarget: form.discountTarget,
      audienceCondition: form.audienceCondition,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      isActive: Boolean(form.isActive),
    };

    try {
      setSaving(true);
      await adminApi.createPromo(payload);
      toast.success(`Промокод ${payload.code} создан`);
      setModalOpen(false);
      setForm(INITIAL_FORM);
      await loadPromos();
    } catch (err) {
      toast.error(err.message || 'Ошибка создания промокода');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (p) => {
    try {
      await adminApi.updatePromo(p.id, { isActive: !p.isActive });
      toast.success(p.isActive ? 'Промокод отключён' : 'Промокод активирован');
      await loadPromos();
    } catch (err) {
      toast.error(err.message || 'Ошибка обновления промокода');
    }
  };

  const handleDelete = async (p) => {
    try {
      await adminApi.deletePromo(p.id);
      toast.success(`Промокод ${p.code} удалён`);
      await loadPromos();
    } catch (err) {
      toast.error(err.message || 'Не удалось удалить промокод');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Промокоды ({promos.length})</h2>
          <p className="text-xs text-slate-400">
            Всего активаций по магазину: <b className="text-white font-mono">{totalUsages}</b>
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setForm(INITIAL_FORM);
            setModalOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-brand/25 hover:bg-brand-hover"
        >
          <Plus className="h-4 w-4" />
          <span>Создать промокод</span>
        </button>
      </div>

      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
              <tr>
                <th className="p-3.5">Код</th>
                <th className="p-3.5">Тип / Номинал</th>
                <th className="p-3.5">Условия</th>
                <th className="p-3.5">Активации</th>
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
              ) : promos.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-500">
                    Промокоды ещё не созданы
                  </td>
                </tr>
              ) : (
                promos.map((p) => (
                  <tr key={p.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5">
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-dark-surface border border-dark-border px-2.5 py-1 font-mono font-bold text-brand">
                        <TicketPercent className="h-3.5 w-3.5" />
                        {p.code}
                      </span>
                    </td>
                    <td className="p-3.5 font-mono whitespace-nowrap">
                      <div className="font-bold text-white">
                        {p.type === 'percent' ? `-${p.value}%` : `${p.value} USDT`}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {p.type === 'balance' ? 'На баланс' : p.type === 'percent' ? 'Скидка %' : 'Фикс. скидка'}
                      </div>
                    </td>
                    <td className="p-3.5 text-slate-300">
                      <div>{p.productName || 'Все товары'}</div>
                      <div className="text-[10px] text-slate-400">
                        {p.discountTarget === 'second_item' && '🎁 1+1 (на 2-й товар) • '}
                        {p.minQuantity > 1 && `От ${p.minQuantity} шт. • `}
                        {p.minOrderAmount > 0 && `От ${p.minOrderAmount}$ • `}
                        {p.audienceCondition === 'first_only' && 'Только 1-й заказ'}
                        {p.audienceCondition === 'repeat_only' && 'Со 2-й покупки'}
                        {p.audienceCondition === 'all' && 'Для всех'}
                      </div>
                    </td>
                    <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                      <span className="text-white font-bold">{p.currentActivations || 0}</span>
                      <span className="text-slate-500">
                        {' / '}
                        {p.maxActivations === -1 ? '∞' : p.maxActivations}
                      </span>
                      {p.expiresAt && (
                        <div className="text-[10px] text-slate-500">
                          до {new Date(p.expiresAt).toLocaleDateString('ru-RU')}
                        </div>
                      )}
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleToggle(p)}
                        className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold border ${
                          p.isActive
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            : 'bg-slate-800 border-slate-700 text-slate-400'
                        }`}
                      >
                        <Power className="h-3 w-3" />
                        <span>{p.isActive ? 'Активен' : 'Выкл'}</span>
                      </button>
                    </td>
                    <td className="p-3.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleDelete(p)}
                        className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-rose-400"
                        title="Удалить"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Модалка создания промокода */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-dark-border">
              <h3 className="text-base font-bold text-white">Новый промокод</h3>
              <button type="button" onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Промокод *</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="SALE2026"
                    className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono font-bold text-white uppercase focus:border-brand focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={generateRandomCode}
                    className="inline-flex items-center gap-1 rounded-xl bg-dark-surface border border-dark-border px-3 py-2 text-slate-300 hover:text-white"
                  >
                    <Dices className="h-4 w-4 text-brand" />
                    <span>Случайный</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Тип промокода</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                  >
                    <option value="percent">Процентная скидка (%)</option>
                    <option value="fixed">Фикс. скидка (USDT)</option>
                    <option value="balance">Пополнение баланса (USDT)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">
                    Номинал ({form.type === 'percent' ? '%' : 'USDT'})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Лимит активаций (-1=∞)</label>
                  <input
                    type="number"
                    value={form.maxActivations}
                    onChange={(e) => setForm({ ...form, maxActivations: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">На 1 юзера</label>
                  <input
                    type="number"
                    min="1"
                    value={form.maxPerUser}
                    onChange={(e) => setForm({ ...form, maxPerUser: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Мин. сумма заказа</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.minOrderAmount}
                    onChange={(e) => setForm({ ...form, minOrderAmount: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Привязка к товару (необязательно)</label>
                <select
                  value={form.productId}
                  onChange={(e) => setForm({ ...form, productId: e.target.value })}
                  className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                >
                  <option value="">🌐 Все товары магазина</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Условие акции</label>
                  <select
                    value={form.discountTarget}
                    onChange={(e) => setForm({ ...form, discountTarget: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                  >
                    <option value="all">Стандартная</option>
                    <option value="second_item">1+1 (на 2-й товар)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Аудитория</label>
                  <select
                    value={form.audienceCondition}
                    onChange={(e) => setForm({ ...form, audienceCondition: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                  >
                    <option value="all">Для всех</option>
                    <option value="first_only">Только 1-й заказ</option>
                    <option value="repeat_only">Со 2-й покупки</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Мин. кол-во (шт)</label>
                  <input
                    type="number"
                    min="1"
                    value={form.minQuantity}
                    onChange={(e) => setForm({ ...form, minQuantity: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Срок действия (необязательно)</label>
                <input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                  className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 text-slate-300"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-brand px-5 py-2 font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {saving ? 'Создание...' : 'Создать'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

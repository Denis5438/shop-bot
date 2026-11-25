'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Edit3, Trash2, Eye, EyeOff, X, Search, Loader2 } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

export default function AdminCategories() {
  const toast = useToast();

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', icon: '📁', sortOrder: '0', isActive: true });
  const [saving, setSaving] = useState(false);

  const loadCategories = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getCategories();
      if (res.success) setCategories(res.categories || []);
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки категорий');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ name: '', icon: '📁', sortOrder: '0', isActive: true });
    setModalOpen(true);
  };

  const openEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      icon: cat.icon || '📁',
      sortOrder: String(cat.sortOrder ?? 0),
      isActive: cat.isActive !== false,
    });
    setModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error('Введите название категории');
      return;
    }

    const payload = {
      name: form.name.trim(),
      icon: form.icon || '📁',
      sortOrder: parseInt(form.sortOrder, 10) || 0,
      isActive: Boolean(form.isActive),
    };

    try {
      setSaving(true);
      if (editingId) {
        await adminApi.updateCategory(editingId, payload);
        toast.success('Категория обновлена');
      } else {
        await adminApi.createCategory(payload);
        toast.success('Категория создана');
      }
      setModalOpen(false);
      await loadCategories();
    } catch (err) {
      toast.error(err.message || 'Ошибка сохранения категории');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (cat) => {
    try {
      await adminApi.updateCategory(cat.id, { isActive: !cat.isActive });
      toast.success(cat.isActive ? 'Категория скрыта' : 'Категория активирована');
      await loadCategories();
    } catch (err) {
      toast.error(err.message || 'Не удалось изменить статус');
    }
  };

  const handleDelete = async (cat) => {
    if (cat.productCount > 0) {
      toast.warning(`В категории «${cat.name}» ещё есть товары (${cat.productCount} шт.)`);
    }
    try {
      await adminApi.deleteCategory(cat.id);
      toast.success('Категория удалена');
      await loadCategories();
    } catch (err) {
      toast.error(err.message || 'Не удалось удалить категорию');
    }
  };

  const filtered = categories.filter((c) =>
    !search.trim() ? true : c.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Категории ({categories.length})</h2>
          <p className="text-xs text-slate-400">Порядок сортировки, иконки брендов и видимость разделов</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-brand/25 hover:bg-brand-hover"
        >
          <Plus className="h-4 w-4" />
          <span>Создать категорию</span>
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Фильтр по названию..."
          className="w-full rounded-xl bg-dark-card border border-dark-border py-2.5 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
        />
      </div>

      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
              <tr>
                <th className="p-3.5">Категория</th>
                <th className="p-3.5">Порядок</th>
                <th className="p-3.5">Товаров</th>
                <th className="p-3.5">Статус</th>
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
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-10 text-center text-slate-500">
                    Категории не найдены
                  </td>
                </tr>
              ) : (
                filtered.map((cat) => (
                  <tr key={cat.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5">
                      <div className="flex items-center gap-3">
                        <BrandIcon size={36} name={cat.name} rounded="lg" />
                        <span className="font-semibold text-white">{cat.name}</span>
                      </div>
                    </td>
                    <td className="p-3.5 font-mono text-slate-300 tabular-nums">{cat.sortOrder ?? 0}</td>
                    <td className="p-3.5 font-mono font-bold text-white tabular-nums">{cat.productCount ?? 0}</td>
                    <td className="p-3.5">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(cat)}
                        className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold border ${
                          cat.isActive
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            : 'bg-slate-800 border-slate-700 text-slate-400'
                        }`}
                      >
                        {cat.isActive ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        <span>{cat.isActive ? 'Активна' : 'Скрыта'}</span>
                      </button>
                    </td>
                    <td className="p-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEdit(cat)}
                          className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-white"
                          title="Редактировать"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(cat)}
                          className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-rose-400"
                          title="Удалить"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Модалка категории */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrandIcon size={36} name={form.name || 'Category'} />
                <h3 className="text-base font-bold text-white">
                  {editingId ? 'Редактировать категорию' : 'Новая категория'}
                </h3>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Название *</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Порядок сортировки</label>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Эмодзи (для бота)</label>
                  <input
                    type="text"
                    value={form.icon}
                    onChange={(e) => setForm({ ...form, icon: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-center text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="rounded border-dark-border bg-dark-input text-brand"
                />
                <span>Показывать категорию на витрине</span>
              </label>

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
                  {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

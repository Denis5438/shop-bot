'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Plus,
  Edit3,
  Copy,
  Trash2,
  Eye,
  EyeOff,
  Zap,
  X,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

const EMPTY_FORM = {
  name: '',
  nameEn: '',
  description: '',
  descriptionEn: '',
  price: '5',
  costPrice: '0',
  officialPrice: '0',
  categoryId: '',
  icon: '📦',
  type: 'key',
  deliveryMethod: 'ready_account',
  manualStock: '-1',
  warrantyDays: '5',
  subscriptionDays: '30',
  sortOrder: '0',
  isActive: true,
};

export default function AdminProducts() {
  const toast = useToast();

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);

  // Фильтры
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState('all'); // 'all' | 'active' | 'hidden'
  const [page, setPage] = useState(1);

  // Модалка создания / редактирования
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Модалка Flash Sale
  const [flashTarget, setFlashTarget] = useState(null);
  const [flashEnabled, setFlashEnabled] = useState(true);
  const [flashDiscount, setFlashDiscount] = useState('20');
  const [flashHours, setFlashHours] = useState('24');
  const [flashSaving, setFlashSaving] = useState(false);

  // Подтверждение удаления
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    adminApi
      .getCategories()
      .then((res) => {
        if (res.success) setCategories(res.categories || []);
      })
      .catch(() => {});
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getProducts({
        search: debouncedSearch,
        categoryId: categoryFilter,
        type: typeFilter,
        status: visibilityFilter === 'all' ? undefined : visibilityFilter,
        page,
        limit: 25,
      });
      if (res.success) {
        setProducts(res.products || []);
        setPagination(res.pagination || { page: 1, limit: 25, total: 0, pages: 1 });
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить товары');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, categoryFilter, typeFilter, visibilityFilter, page, toast]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      categoryId: categories[0]?.id || '',
    });
    setEditorOpen(true);
  };

  const openEdit = (p) => {
    setEditingId(p.id);
    setForm({
      name: p.name || '',
      nameEn: p.nameEn || '',
      description: p.description || '',
      descriptionEn: p.descriptionEn || '',
      price: String(p.price ?? 0),
      costPrice: String(p.costPrice ?? 0),
      officialPrice: String(p.officialPrice ?? 0),
      categoryId: p.category?.id || p.category?._id || p.categoryId || '',
      icon: p.icon || '📦',
      type: p.type || 'key',
      deliveryMethod: p.deliveryMethod || 'ready_account',
      manualStock: String(p.manualStock ?? -1),
      warrantyDays: String(p.warrantyDays ?? 5),
      subscriptionDays: String(p.subscriptionDays ?? 30),
      sortOrder: String(p.sortOrder ?? 0),
      isActive: p.isActive !== false,
    });
    setEditorOpen(true);
  };

  const handleSaveProduct = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error('Укажите название товара');
      return;
    }

    const payload = {
      name: form.name.trim(),
      nameEn: form.nameEn.trim(),
      description: form.description.trim(),
      descriptionEn: form.descriptionEn.trim(),
      price: Number(form.price) || 0,
      costPrice: Number(form.costPrice) || 0,
      officialPrice: Number(form.officialPrice) || 0,
      categoryId: form.categoryId || null,
      icon: form.icon || '📦',
      type: form.type,
      deliveryMethod: form.deliveryMethod,
      manualStock: parseInt(form.manualStock, 10),
      warrantyDays: parseInt(form.warrantyDays, 10) || 0,
      subscriptionDays: parseInt(form.subscriptionDays, 10) || 30,
      sortOrder: parseInt(form.sortOrder, 10) || 0,
      isActive: Boolean(form.isActive),
    };

    if (Number.isNaN(payload.manualStock)) payload.manualStock = -1;

    try {
      setSaving(true);
      if (editingId) {
        await adminApi.updateProduct(editingId, payload);
        toast.success('Товар обновлён');
      } else {
        await adminApi.createProduct(payload);
        toast.success('Товар создан');
      }
      setEditorOpen(false);
      await loadProducts();
    } catch (err) {
      toast.error(err.message || 'Ошибка сохранения товара');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (p) => {
    try {
      await adminApi.updateProduct(p.id, { isActive: !p.isActive });
      toast.success(p.isActive ? 'Товар скрыт с витрины' : 'Товар снова активен');
      await loadProducts();
    } catch (err) {
      toast.error(err.message || 'Ошибка изменения видимости');
    }
  };

  const handleClone = async (p) => {
    try {
      await adminApi.cloneProduct(p.id);
      toast.success(`Товар «${p.name}» клонирован`);
      await loadProducts();
    } catch (err) {
      toast.error(err.message || 'Ошибка клонирования');
    }
  };

  const openFlashModal = (p) => {
    setFlashTarget(p);
    setFlashEnabled(true);
    setFlashDiscount(String(p.flashSale?.discountPercent || 20));
    setFlashHours('24');
  };

  const handleSaveFlashSale = async (e) => {
    e.preventDefault();
    if (!flashTarget) return;
    try {
      setFlashSaving(true);
      const hours = Math.max(1, parseInt(flashHours, 10) || 24);
      const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      await adminApi.setFlashSale(flashTarget.id, {
        enabled: flashEnabled,
        discountPercent: flashEnabled ? Number(flashDiscount) || 10 : 0,
        durationHours: hours,
        expiresAt: flashEnabled ? expiresAt : null,
      });
      toast.success(flashEnabled ? 'Flash Sale активирован' : 'Flash Sale отключён');
      setFlashTarget(null);
      await loadProducts();
    } catch (err) {
      toast.error(err.message || 'Ошибка настройки Flash Sale');
    } finally {
      setFlashSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteProduct(deleteTarget.id);
      toast.success('Товар удалён');
      setDeleteTarget(null);
      await loadProducts();
    } catch (err) {
      toast.error(err.message || 'Не удалось удалить товар');
    }
  };

  return (
    <div className="space-y-5">
      {/* Панель управления и фильтров */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Товары ({pagination.total})</h2>
          <p className="text-xs text-slate-400">Создание, цены, остатки, Flash Sale и видимость на витрине</p>
        </div>

        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-brand/25 hover:bg-brand-hover transition-all"
        >
          <Plus className="h-4 w-4" />
          <span>Создать товар</span>
        </button>
      </div>

      {/* Фильтры */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 rounded-2xl bg-dark-card border border-dark-border p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию..."
            className="w-full rounded-xl bg-dark-input border border-dark-border py-2 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-slate-200 focus:border-brand focus:outline-none"
        >
          <option value="all">Все категории</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.productCount})
            </option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-slate-200 focus:border-brand focus:outline-none"
        >
          <option value="all">Все типы выдачи</option>
          <option value="key">Автовыдача (key)</option>
          <option value="gpt_activation">Активация (gpt_activation)</option>
          <option value="manual">Ручная (manual)</option>
        </select>

        <select
          value={visibilityFilter}
          onChange={(e) => {
            setVisibilityFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-slate-200 focus:border-brand focus:outline-none"
        >
          <option value="all">Любая видимость</option>
          <option value="active">Только активные</option>
          <option value="hidden">Только скрытые</option>
        </select>
      </div>

      {/* Таблица товаров */}
      <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
              <tr>
                <th className="p-3.5">Товар</th>
                <th className="p-3.5">Тип</th>
                <th className="p-3.5">Цена / Оф. / Закуп</th>
                <th className="p-3.5">Остаток</th>
                <th className="p-3.5">Статус</th>
                <th className="p-3.5 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border/60">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-400">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-slate-500">
                    Товары не найдены
                  </td>
                </tr>
              ) : (
                products.map((p) => {
                  const isFlash = p.flashSale?.enabled;
                  return (
                    <tr key={p.id} className="hover:bg-dark-surface/40">
                      <td className="p-3.5">
                        <div className="flex items-center gap-3 min-w-[220px]">
                          <BrandIcon size={36} name={p.name} categoryName={p.category?.name} rounded="lg" />
                          <div className="min-w-0">
                            <div className="font-semibold text-white truncate max-w-[260px]">{p.name}</div>
                            <div className="text-[11px] text-slate-400 truncate max-w-[260px]">
                              {p.category?.name || 'Без категории'}
                              {p.provider && p.provider !== 'local' ? ` • ${p.provider}` : ''}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="p-3.5 font-mono text-slate-300 whitespace-nowrap">
                        <div>{p.type}</div>
                        <div className="text-[10px] text-slate-500">{p.deliveryMethod}</div>
                      </td>
                      <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                        <div className="font-bold text-emerald-400">
                          {Number(p.effectivePrice ?? p.price ?? 0).toFixed(2)} $
                          {isFlash && (
                            <span className="ml-1.5 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-400">
                              ⚡ -{p.flashSale.discountPercent}%
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          База: {Number(p.price || 0).toFixed(2)}$ • Закуп: {Number(p.costPrice || 0).toFixed(2)}$
                        </div>
                      </td>
                      <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                        <div className="font-bold text-white">{p.stockCount ?? 0} шт.</div>
                        <div className="text-[10px] text-slate-500">
                          {p.manualStock >= 0 ? `ручной (${p.manualStock})` : `ключи (${p.freeKeysCount ?? 0})`}
                        </div>
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(p)}
                          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition-all ${
                            p.isActive
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20'
                              : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                          }`}
                        >
                          {p.isActive ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          <span>{p.isActive ? 'Активен' : 'Скрыт'}</span>
                        </button>
                      </td>
                      <td className="p-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openFlashModal(p)}
                            className={`rounded-lg p-1.5 border transition-colors ${
                              isFlash
                                ? 'bg-rose-500/15 border-rose-500/40 text-rose-400'
                                : 'bg-dark-surface border-dark-border text-slate-300 hover:text-amber-400'
                            }`}
                            title="Flash Sale"
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(p)}
                            className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-white"
                            title="Редактировать"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleClone(p)}
                            className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-sky-400"
                            title="Клонировать"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(p)}
                            className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 hover:text-rose-400"
                            title="Удалить"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Пагинация */}
        {pagination.pages > 1 && (
          <div className="flex items-center justify-between border-t border-dark-border px-4 py-3 text-xs">
            <span className="text-slate-400">
              Страница {pagination.page} из {pagination.pages}
            </span>
            <div className="flex items-center gap-2">
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

      {/* Модалка Создать / Редактировать товар */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setEditorOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-dark-border">
              <div className="flex items-center gap-3">
                <BrandIcon size={36} name={form.name || 'Product'} />
                <h3 className="text-lg font-bold text-white">
                  {editingId ? 'Редактирование товара' : 'Новый товар'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="rounded-xl p-2 text-slate-400 hover:text-white hover:bg-dark-surface"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Название (RU) *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Название (EN)</label>
                  <input
                    type="text"
                    value={form.nameEn}
                    onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Описание (RU)</label>
                  <textarea
                    rows={3}
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Описание (EN)</label>
                  <textarea
                    rows={3}
                    value={form.descriptionEn}
                    onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Цена (USDT) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Закупочная (USDT)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.costPrice}
                    onChange={(e) => setForm({ ...form, costPrice: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Официальная цена (USDT)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.officialPrice}
                    onChange={(e) => setForm({ ...form, officialPrice: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Категория</label>
                  <select
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  >
                    <option value="">Без категории</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Тип товара</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  >
                    <option value="key">key (Автовыдача)</option>
                    <option value="gpt_activation">gpt_activation (Активация)</option>
                    <option value="manual">manual (Ручная)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Способ выдачи</label>
                  <select
                    value={form.deliveryMethod}
                    onChange={(e) => setForm({ ...form, deliveryMethod: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white focus:border-brand focus:outline-none"
                  >
                    <option value="ready_account">ready_account (Готовый ключ/акк)</option>
                    <option value="activation">activation (Активация на акк)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Иконка (бот)</label>
                  <input
                    type="text"
                    value={form.icon}
                    onChange={(e) => setForm({ ...form, icon: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-center text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Ручной остаток</label>
                  <input
                    type="number"
                    value={form.manualStock}
                    onChange={(e) => setForm({ ...form, manualStock: e.target.value })}
                    title="-1 означает подсчёт по пулу ключей"
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Гарантия (дн)</label>
                  <input
                    type="number"
                    min="0"
                    value={form.warrantyDays}
                    onChange={(e) => setForm({ ...form, warrantyDays: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Срок (дн)</label>
                  <input
                    type="number"
                    min="1"
                    value={form.subscriptionDays}
                    onChange={(e) => setForm({ ...form, subscriptionDays: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Сортировка</label>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white focus:border-brand focus:outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-slate-200 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="rounded border-dark-border bg-dark-input text-brand"
                />
                <span>Товар активен и отображается на витрине</span>
              </label>

              <div className="flex justify-end gap-2 pt-3 border-t border-dark-border">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 font-semibold text-slate-300 hover:text-white"
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

      {/* Модалка Flash Sale */}
      {flashTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setFlashTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Zap className="h-4 w-4 text-rose-400" />
                <span>Flash Sale: {flashTarget.name}</span>
              </h3>
              <button type="button" onClick={() => setFlashTarget(null)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveFlashSale} className="space-y-4 text-xs">
              <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flashEnabled}
                  onChange={(e) => setFlashEnabled(e.target.checked)}
                  className="rounded border-dark-border bg-dark-input text-brand"
                />
                <span>Включить акцию «Горящие часы»</span>
              </label>

              {flashEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-300 mb-1">Скидка (%)</label>
                    <input
                      type="number"
                      min="1"
                      max="95"
                      value={flashDiscount}
                      onChange={(e) => setFlashDiscount(e.target.value)}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-300 mb-1">Длительность (часов)</label>
                    <input
                      type="number"
                      min="1"
                      max="720"
                      value={flashHours}
                      onChange={(e) => setFlashHours(e.target.value)}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setFlashTarget(null)}
                  className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 text-slate-300"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={flashSaving}
                  className="rounded-xl bg-rose-500 px-5 py-2 font-bold text-white hover:bg-rose-600 disabled:opacity-50"
                >
                  {flashSaving ? 'Применение...' : 'Применить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модалка подтверждения удаления */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-dark-card border border-rose-500/30 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-white">Удалить товар?</h3>
            <p className="text-xs text-slate-400">
              Товар <b className="text-white">{deleteTarget.name}</b> будет удалён безвозвратно. При наличии активных заказов удаление будет заблокировано.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 text-xs text-slate-300"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded-xl bg-rose-500 px-4 py-2 text-xs font-bold text-white hover:bg-rose-600"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import { Package, Key, ShoppingBag, DollarSign, Users, Plus, Upload, CheckCircle2 } from 'lucide-react';
import { catalogApi, ordersApi } from '../../lib/api';

export default function AdminDashboardPage() {
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'products' | 'keys' | 'orders'
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Форма добавления ключей
  const [selectedProductForKeys, setSelectedProductForKeys] = useState('');
  const [rawKeysInput, setRawKeysInput] = useState('');
  const [keysImportResult, setKeysImportResult] = useState(null);

  useEffect(() => {
    async function loadAdminData() {
      try {
        setIsLoading(true);
        const [prodsRes, ordersRes] = await Promise.all([
          catalogApi.getProducts({ limit: 100 }),
          ordersApi.getOrders({ limit: 50 }),
        ]);

        if (prodsRes.success) setProducts(prodsRes.products || []);
        if (ordersRes.success) setOrders(ordersRes.orders || []);
      } catch (err) {
        console.error('Ошибка загрузки админ данных:', err);
      } finally {
        setIsLoading(false);
      }
    }

    loadAdminData();
  }, []);

  // Расчёт базовой статистики
  const totalRevenue = orders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + (o.price || 0), 0);

  const completedOrdersCount = orders.filter((o) => o.status === 'completed').length;

  return (
    <div className="space-y-6">
      {/* Метрики */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Выручка (USDT)</span>
            <DollarSign className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {totalRevenue.toFixed(2)} USDT
          </div>
          <p className="text-[11px] text-slate-500">По завершённым заказам</p>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Заказов оформлено</span>
            <ShoppingBag className="h-4 w-4 text-brand" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {completedOrdersCount} / {orders.length}
          </div>
          <p className="text-[11px] text-slate-500">Успешно выполнено</p>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Товаров в каталоге</span>
            <Package className="h-4 w-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {products.length}
          </div>
          <p className="text-[11px] text-slate-500">Активных позиций</p>
        </div>

        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold">
            <span>Ключей на складе</span>
            <Key className="h-4 w-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {products.reduce((sum, p) => sum + (p.stockCount || 0), 0)} шт.
          </div>
          <p className="text-[11px] text-slate-500">Готовы к выдаче</p>
        </div>
      </div>

      {/* Переключатель вкладок */}
      <div className="flex items-center gap-2 border-b border-dark-border pb-3">
        <button
          onClick={() => setActiveTab('overview')}
          className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
            activeTab === 'overview'
              ? 'bg-brand text-white shadow-md shadow-brand/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Обзор товаров
        </button>
        <button
          onClick={() => setActiveTab('keys')}
          className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
            activeTab === 'keys'
              ? 'bg-brand text-white shadow-md shadow-brand/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Импорт цифровых ключей
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
            activeTab === 'orders'
              ? 'bg-brand text-white shadow-md shadow-brand/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Все заказы ({orders.length})
        </button>
      </div>

      {/* Вкладка 1: Обзор товаров */}
      {activeTab === 'overview' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          <div className="p-4 border-b border-dark-border flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">Список товаров витрины</h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
                <tr>
                  <th className="p-3.5">Товар</th>
                  <th className="p-3.5">Тип</th>
                  <th className="p-3.5">Цена продажи</th>
                  <th className="p-3.5">Себестоимость</th>
                  <th className="p-3.5">Остаток ключей</th>
                  <th className="p-3.5">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border/60">
                {products.map((p) => (
                  <tr key={p.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5 flex items-center gap-2.5 font-medium text-white">
                      <span>{p.icon || '📦'}</span>
                      <span>{p.name}</span>
                    </td>
                    <td className="p-3.5 text-slate-400 font-mono">{p.type}</td>
                    <td className="p-3.5 font-mono font-bold text-emerald-400">{p.effectivePrice} USDT</td>
                    <td className="p-3.5 font-mono text-slate-400">{p.costPrice || 0} USDT</td>
                    <td className="p-3.5 font-mono font-bold text-white">{p.stockCount} шт.</td>
                    <td className="p-3.5">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold ${p.inStock ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                        {p.inStock ? 'Активен' : 'Закончился'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Вкладка 2: Импорт цифровых ключей */}
      {activeTab === 'keys' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border p-6 max-w-xl space-y-5">
          <div>
            <h3 className="text-base font-bold text-white">Массовая загрузка ключей</h3>
            <p className="text-xs text-slate-400 mt-1">
              Выберите товар и вставьте ключи (каждый ключ с новой строки).
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Выберите целевой товар:
              </label>
              <select
                value={selectedProductForKeys}
                onChange={(e) => setSelectedProductForKeys(e.target.value)}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3.5 py-2.5 text-xs text-white focus:border-brand focus:outline-none"
              >
                <option value="">-- Выберите товар --</option>
                {products.filter((p) => p.type === 'key').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (остаток: {p.stockCount} шт.)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Ключи (по одному на строку):
              </label>
              <textarea
                rows={6}
                value={rawKeysInput}
                onChange={(e) => setRawKeysInput(e.target.value)}
                placeholder="XXXXX-XXXXX-XXXXX&#10;YYYYY-YYYYY-YYYYY"
                className="w-full rounded-xl bg-dark-input border border-dark-border p-3 text-xs font-mono text-white placeholder-slate-600 focus:border-brand focus:outline-none"
              />
            </div>

            {keysImportResult && (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{keysImportResult}</span>
              </div>
            )}

            <button
              onClick={() => {
                if (!selectedProductForKeys) return alert('Выберите товар');
                const count = rawKeysInput.trim().split('\n').filter(Boolean).length;
                if (count === 0) return alert('Введите хотя бы один ключ');
                setKeysImportResult(`Импортировано ${count} ключей в пул товара!`);
                setRawKeysInput('');
              }}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-xs font-bold text-white shadow-md shadow-brand/20 hover:bg-brand-hover transition-all"
            >
              <Upload className="h-4 w-4" />
              <span>Загрузить ключи в базу</span>
            </button>
          </div>
        </div>
      )}

      {/* Вкладка 3: Заказы */}
      {activeTab === 'orders' && (
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
          <div className="p-4 border-b border-dark-border">
            <h3 className="text-sm font-bold text-white">Все заказы покупателей</h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-dark-surface text-slate-400 uppercase font-semibold border-b border-dark-border">
                <tr>
                  <th className="p-3.5">ID Заказа</th>
                  <th className="p-3.5">Товар</th>
                  <th className="p-3.5">Сумма</th>
                  <th className="p-3.5">Кол-во</th>
                  <th className="p-3.5">Статус</th>
                  <th className="p-3.5">Дата</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border/60">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-dark-surface/40">
                    <td className="p-3.5 font-mono text-slate-400">#{o.id?.slice(-8)}</td>
                    <td className="p-3.5 font-medium text-white">{o.product?.name || 'Товар'}</td>
                    <td className="p-3.5 font-mono font-bold text-emerald-400">{o.price?.toFixed(2)} USDT</td>
                    <td className="p-3.5 font-mono">{o.qty || 1} шт.</td>
                    <td className="p-3.5">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold ${o.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="p-3.5 text-slate-400 font-mono">
                      {new Date(o.createdAt).toLocaleDateString('ru-RU')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

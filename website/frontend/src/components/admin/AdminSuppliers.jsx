'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Download, Save, Key, PlugZap, Loader2 } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

const PRESETS = [
  { id: 'standard', label: '🎯 Стандарт (30% ➔ 20% ➔ 15% ➔ 8%)' },
  { id: 'high_profit', label: '💰 Макс. прибыль (40% ➔ 25% ➔ 20% ➔ 12%)' },
  { id: 'minimal', label: '🔥 Минимум (20% ➔ 12% ➔ 8% ➔ 5%)' },
  { id: 'gemini_ai', label: '✨ Gemini AI (от оф. цены)' },
];

export default function AdminSuppliers() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();

  const [suppliers, setSuppliers] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyMap, setBusyMap] = useState({});

  const loadSuppliers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getSuppliers();
      if (res.success) {
        const list = res.suppliers || [];
        setSuppliers(list);
        const init = {};
        for (const s of list) {
          init[s.supplierId] = {
            isEnabled: s.isEnabled !== false,
            marginPercent: String(s.marginPercent ?? 30),
            smartPricingEnabled: Boolean(s.smartPricingEnabled),
            smartPricingPreset: s.smartPricingPreset || 'standard',
            currentOnly: s.currentOnly !== false,
            autoImportNewProducts: s.autoImportNewProducts !== false,
            newApiKey: '',
          };
        }
        setDrafts(init);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить поставщиков');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  const setDraftField = (supplierId, key, value) => {
    setDrafts((prev) => ({
      ...prev,
      [supplierId]: {
        ...(prev[supplierId] || {}),
        [key]: value,
      },
    }));
  };

  const withBusy = async (key, fn) => {
    try {
      setBusyMap((prev) => ({ ...prev, [key]: true }));
      await fn();
    } finally {
      setBusyMap((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleSave = (supplierId) =>
    withBusy(`save:${supplierId}`, async () => {
      const d = drafts[supplierId];
      const payload = {
        isEnabled: Boolean(d.isEnabled),
        marginPercent: Number(d.marginPercent) || 0,
        smartPricingEnabled: Boolean(d.smartPricingEnabled),
        smartPricingPreset: d.smartPricingPreset,
        currentOnly: Boolean(d.currentOnly),
        autoImportNewProducts: Boolean(d.autoImportNewProducts),
      };
      if (isSuperAdmin && d.newApiKey && d.newApiKey.trim()) {
        payload.apiKey = d.newApiKey.trim();
      }
      await adminApi.updateSupplier(supplierId, payload);
      toast.success('Настройки поставщика сохранены');
      await loadSuppliers();
    }).catch((err) => toast.error(err.message || 'Ошибка сохранения'));

  const handleRefreshBalance = (supplierId) =>
    withBusy(`refresh:${supplierId}`, async () => {
      const res = await adminApi.refreshSupplier(supplierId);
      toast.success(`Баланс обновлён: ${Number(res.balance ?? 0).toFixed(2)} USDT`);
      await loadSuppliers();
    }).catch((err) => toast.error(err.message || 'Ошибка обновления баланса'));

  const handleSync = (supplierId) =>
    withBusy(`sync:${supplierId}`, async () => {
      const res = await adminApi.syncSupplier(supplierId);
      toast.success(`Синхронизировано! Обновлено товаров: ${res.updatedCount ?? 0}`);
      await loadSuppliers();
    }).catch((err) => toast.error(err.message || 'Ошибка синхронизации'));

  const handleImport = (supplierId) =>
    withBusy(`import:${supplierId}`, async () => {
      const res = await adminApi.importSupplier(supplierId);
      toast.success(
        `Импорт завершён: новых ${res.importedCount ?? 0}, обновлено ${res.updatedCount ?? 0}`
      );
      await loadSuppliers();
    }).catch((err) => toast.error(err.message || 'Ошибка импорта каталога'));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white">Внешние поставщики (Drop-Shipping API)</h2>
        <p className="text-xs text-slate-400">
          Синхронизация остатков, пресеты Smart Pricing, фильтр предзаказов и маскированные API-ключи
        </p>
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
        </div>
      ) : suppliers.length === 0 ? (
        <div className="rounded-2xl bg-dark-card border border-dark-border p-10 text-center text-xs text-slate-500">
          Поставщики не настроены
        </div>
      ) : (
        <div className="space-y-5">
          {suppliers.map((s) => {
            const d = drafts[s.supplierId] || {};
            return (
              <div
                key={s.supplierId}
                className="rounded-2xl bg-dark-card border border-dark-border p-5 sm:p-6 space-y-5 text-xs"
              >
                {/* Шапка поставщика */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-dark-border">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/15 text-brand border border-brand/30">
                      <PlugZap className="h-5 w-5" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-white">{s.title}</h3>
                        <span className="rounded bg-dark-surface px-2 py-0.5 font-mono text-[10px] text-slate-400">
                          {s.supplierId}
                        </span>
                      </div>
                      <div className="text-slate-400 mt-0.5">
                        Ключ:{' '}
                        <span className="font-mono text-slate-200">
                          {s.hasApiKey ? s.apiKeyMask || '••••••••' : 'Не задан'}
                        </span>{' '}
                        • Последняя синхр.:{' '}
                        {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString('ru-RU') : 'никогда'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 text-right">
                      <span className="text-[10px] text-slate-400 block">Баланс поставщика</span>
                      <span className="font-mono text-base font-bold text-emerald-400 tabular-nums">
                        {Number(s.cachedBalance || 0).toFixed(2)} USDT
                      </span>
                    </div>
                  </div>
                </div>

                {/* Быстрые действия */}
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    disabled={busyMap[`refresh:${s.supplierId}`]}
                    onClick={() => handleRefreshBalance(s.supplierId)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3.5 py-2 font-semibold text-slate-200 hover:border-slate-500 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${busyMap[`refresh:${s.supplierId}`] ? 'animate-spin' : ''}`} />
                    <span>Обновить баланс</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyMap[`sync:${s.supplierId}`]}
                    onClick={() => handleSync(s.supplierId)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3.5 py-2 font-semibold text-sky-300 hover:border-sky-500/40 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${busyMap[`sync:${s.supplierId}`] ? 'animate-spin' : ''}`} />
                    <span>Синхронизировать</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyMap[`import:${s.supplierId}`]}
                    onClick={() => handleImport(s.supplierId)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-brand/15 border border-brand/35 px-3.5 py-2 font-bold text-brand hover:bg-brand/25 disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{busyMap[`import:${s.supplierId}`] ? 'Импорт...' : 'Импорт каталога'}</span>
                  </button>
                </div>

                {/* Параметры наценки и фильтров */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                  <div>
                    <label className="block font-semibold text-slate-300 mb-1">Пресет Smart Pricing</label>
                    <select
                      value={d.smartPricingPreset || 'standard'}
                      onChange={(e) => setDraftField(s.supplierId, 'smartPricingPreset', e.target.value)}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white"
                    >
                      {PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-300 mb-1">Фиксированная наценка (%)</label>
                    <input
                      type="number"
                      step="1"
                      value={d.marginPercent ?? '30'}
                      onChange={(e) => setDraftField(s.supplierId, 'marginPercent', e.target.value)}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                      <Key className="h-3.5 w-3.5 text-slate-400" />
                      <span>Новый API-ключ {isSuperAdmin ? '' : '(только SuperAdmin)'}</span>
                    </label>
                    <input
                      type="password"
                      disabled={!isSuperAdmin}
                      value={d.newApiKey || ''}
                      onChange={(e) => setDraftField(s.supplierId, 'newApiKey', e.target.value)}
                      placeholder={s.hasApiKey ? `Текущий: ${s.apiKeyMask}` : 'Введите новый ключ'}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
                    />
                  </div>
                </div>

                {/* Переключатели */}
                <div className="flex flex-wrap gap-5 pt-1">
                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.isEnabled)}
                      onChange={(e) => setDraftField(s.supplierId, 'isEnabled', e.target.checked)}
                      className="rounded border-dark-border bg-dark-input text-brand"
                    />
                    <span>Поставщик включён</span>
                  </label>

                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.smartPricingEnabled)}
                      onChange={(e) => setDraftField(s.supplierId, 'smartPricingEnabled', e.target.checked)}
                      className="rounded border-dark-border bg-dark-input text-brand"
                    />
                    <span>Включить Smart Pricing</span>
                  </label>

                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.currentOnly)}
                      onChange={(e) => setDraftField(s.supplierId, 'currentOnly', e.target.checked)}
                      className="rounded border-dark-border bg-dark-input text-brand"
                    />
                    <span>Только в наличии (currentOnly)</span>
                  </label>

                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(d.autoImportNewProducts)}
                      onChange={(e) => setDraftField(s.supplierId, 'autoImportNewProducts', e.target.checked)}
                      className="rounded border-dark-border bg-dark-input text-brand"
                    />
                    <span>Авто-импорт новинок</span>
                  </label>
                </div>

                <div className="flex justify-end pt-2 border-t border-dark-border/60">
                  <button
                    type="button"
                    disabled={busyMap[`save:${s.supplierId}`]}
                    onClick={() => handleSave(s.supplierId)}
                    className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2 font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>{busyMap[`save:${s.supplierId}`] ? 'Сохранение...' : 'Сохранить настройки'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

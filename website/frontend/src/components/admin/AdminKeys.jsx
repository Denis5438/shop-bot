'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  KeyRound,
  Upload,
  FileText,
  Trash2,
  Search,
  CheckCircle2,
  Loader2,
  Eraser,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

export default function AdminKeys() {
  const toast = useToast();
  const fileInputRef = useRef(null);

  const [summary, setSummary] = useState([]);
  const [summarySearch, setSummarySearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [loadingSummary, setLoadingSummary] = useState(true);

  // Импорт ключей
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // Просмотр ключей выбранного товара
  const [keys, setKeys] = useState([]);
  const [keysFilter, setKeysFilter] = useState('free'); // 'free' | 'used' | 'all'
  const [keysPage, setKeysPage] = useState(1);
  const [keysPagination, setKeysPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loadingKeys, setLoadingKeys] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      setLoadingSummary(true);
      const res = await adminApi.getKeysSummary();
      if (res.success) {
        const list = res.summary || [];
        setSummary(list);
        if (!selectedProductId && list.length > 0) {
          setSelectedProductId(list[0].productId);
        }
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки сводки ключей');
    } finally {
      setLoadingSummary(false);
    }
  }, [selectedProductId, toast]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const loadProductKeys = useCallback(async () => {
    if (!selectedProductId) {
      setKeys([]);
      return;
    }
    try {
      setLoadingKeys(true);
      const res = await adminApi.getProductKeys(selectedProductId, {
        status: keysFilter === 'all' ? undefined : keysFilter,
        page: keysPage,
        limit: 30,
      });
      if (res.success) {
        setKeys(res.keys || []);
        setKeysPagination(res.pagination || { page: 1, pages: 1, total: 0 });
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить ключи товара');
    } finally {
      setLoadingKeys(false);
    }
  }, [selectedProductId, keysFilter, keysPage, toast]);

  useEffect(() => {
    loadProductKeys();
  }, [loadProductKeys]);

  // Чтение .txt файла через FileReader
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Файл слишком большой (максимум 5 МБ)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || '');
      setRawText((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      setFileName(file.name);
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
      toast.success(`Загружено строк из ${file.name}: ${lines}`);
    };
    reader.onerror = () => {
      toast.error('Не удалось прочитать файл');
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleImport = async (e) => {
    e.preventDefault();
    if (!selectedProductId) {
      toast.error('Выберите целевой товар');
      return;
    }
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      toast.error('Введите хотя бы один ключ или загрузите .txt файл');
      return;
    }

    try {
      setImporting(true);
      setImportResult(null);
      const res = await adminApi.importKeys(selectedProductId, lines.join('\n'));
      if (res.success) {
        setImportResult({
          addedCount: res.addedCount ?? lines.length,
          skippedCount: res.skippedCount ?? 0,
        });
        setRawText('');
        setFileName('');
        toast.success(`Добавлено ключей: ${res.addedCount ?? lines.length}`);
        await Promise.all([loadSummary(), loadProductKeys()]);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка импорта ключей');
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteKey = async (keyId) => {
    try {
      await adminApi.deleteKey(keyId);
      toast.success('Ключ удалён');
      await Promise.all([loadSummary(), loadProductKeys()]);
    } catch (err) {
      toast.error(err.message || 'Не удалось удалить ключ');
    }
  };

  const handleClearUsed = async () => {
    if (!selectedProductId) return;
    try {
      const res = await adminApi.clearUsedKeys(selectedProductId);
      toast.success(`Использованные ключи очищены (${res.deletedCount ?? 0} шт.)`);
      await Promise.all([loadSummary(), loadProductKeys()]);
    } catch (err) {
      toast.error(err.message || 'Ошибка очистки использованных ключей');
    }
  };

  const filteredSummary = summary.filter((s) =>
    !summarySearch.trim() ? true : s.name.toLowerCase().includes(summarySearch.toLowerCase().trim())
  );
  const selectedProd = summary.find((s) => String(s.productId) === String(selectedProductId));
  const pendingLineCount = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">Пул цифровых ключей</h2>
        <p className="text-xs text-slate-400">
          Сводка остатков по товарам, массовый импорт построчно или из .txt файла и очистка использованных ключей
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Левая колонка: Сводка по товарам */}
        <div className="lg:col-span-5 rounded-2xl bg-dark-card border border-dark-border p-4 space-y-3 flex flex-col max-h-[720px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={summarySearch}
              onChange={(e) => setSummarySearch(e.target.value)}
              placeholder="Найти товар..."
              className="w-full rounded-xl bg-dark-input border border-dark-border py-2 pl-9 pr-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
            />
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {loadingSummary ? (
              <div className="py-12 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-brand" />
              </div>
            ) : filteredSummary.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">Товары не найдены</div>
            ) : (
              filteredSummary.map((item) => {
                const active = String(item.productId) === String(selectedProductId);
                return (
                  <button
                    key={item.productId}
                    type="button"
                    onClick={() => {
                      setSelectedProductId(item.productId);
                      setKeysPage(1);
                    }}
                    className={`w-full flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all ${
                      active
                        ? 'bg-brand/15 border-brand'
                        : 'bg-dark-surface/50 border-dark-border hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <BrandIcon size={32} name={item.name} rounded="lg" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{item.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {item.type} {item.provider && item.provider !== 'local' ? `• ${item.provider}` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-mono tabular-nums">
                      <div className="text-xs font-bold text-emerald-400">{item.freeCount ?? 0} своб.</div>
                      <div className="text-[10px] text-slate-500">{item.usedCount ?? 0} исп.</div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Правая колонка: Импорт + Список ключей */}
        <div className="lg:col-span-7 space-y-6">
          {/* Форма импорта */}
          <form onSubmit={handleImport} className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <KeyRound className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-bold text-white">
                  Импорт ключей {selectedProd ? `— ${selectedProd.name}` : ''}
                </h3>
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.csv,text/plain"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand/50"
                >
                  <FileText className="h-3.5 w-3.5 text-brand" />
                  <span>Загрузить .txt</span>
                </button>
              </div>
            </div>

            {fileName && (
              <div className="text-[11px] text-sky-400">
                Загружен файл: <span className="font-mono">{fileName}</span>
              </div>
            )}

            <textarea
              rows={5}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Вставьте ключи или аккаунты построчно (1 строка = 1 ключ, до 5000 за раз)"
              className="w-full rounded-xl bg-dark-input border border-dark-border p-3 text-xs font-mono text-white placeholder-slate-600 focus:border-brand focus:outline-none"
            />

            {importResult && (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  Импорт завершён: добавлено <b>{importResult.addedCount}</b>, пропущено дублей/пустых:{' '}
                  <b>{importResult.skippedCount}</b>
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-400 font-mono">
                Строк к загрузке: {pendingLineCount}
              </span>
              <button
                type="submit"
                disabled={importing || !selectedProductId || pendingLineCount === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-brand/20 hover:bg-brand-hover disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{importing ? 'Импорт...' : 'Загрузить ключи'}</span>
              </button>
            </div>
          </form>

          {/* Просмотр и очистка ключей выбранного товара */}
          <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
            <div className="p-4 border-b border-dark-border flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 rounded-xl bg-dark-surface border border-dark-border p-1 text-xs">
                {[
                  { key: 'free', label: 'Свободные' },
                  { key: 'used', label: 'Использованные' },
                  { key: 'all', label: 'Все' },
                ].map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      setKeysFilter(f.key);
                      setKeysPage(1);
                    }}
                    className={`rounded-lg px-3 py-1 font-semibold ${
                      keysFilter === f.key ? 'bg-brand text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleClearUsed}
                disabled={!selectedProductId || !selectedProd?.usedCount}
                className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-rose-400 hover:border-rose-500/40 disabled:opacity-40"
              >
                <Eraser className="h-3.5 w-3.5" />
                <span>Очистить использованные ({selectedProd?.usedCount || 0})</span>
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-dark-border/60">
              {loadingKeys ? (
                <div className="p-10 text-center">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-brand" />
                </div>
              ) : keys.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">Ключи в этой выборке отсутствуют</div>
              ) : (
                keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-slate-200 truncate select-all">{k.value}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {k.isUsed ? (
                          <span className="text-amber-400">
                            Использован {k.usedAt ? new Date(k.usedAt).toLocaleString('ru-RU') : ''}
                          </span>
                        ) : (
                          <span className="text-emerald-400">Свободен</span>
                        )}{' '}
                        • {k.provider || 'local'}
                      </div>
                    </div>

                    {!k.isUsed && (
                      <button
                        type="button"
                        onClick={() => handleDeleteKey(k.id)}
                        className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-dark-surface hover:text-rose-400"
                        title="Удалить свободный ключ"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {keysPagination.pages > 1 && (
              <div className="flex items-center justify-between border-t border-dark-border px-4 py-2.5 text-xs">
                <span className="text-slate-400">
                  Стр. {keysPagination.page} из {keysPagination.pages} (всего {keysPagination.total})
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={keysPage <= 1}
                    onClick={() => setKeysPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg bg-dark-surface border border-dark-border px-2.5 py-1 text-slate-300 disabled:opacity-40"
                  >
                    Назад
                  </button>
                  <button
                    type="button"
                    disabled={keysPage >= keysPagination.pages}
                    onClick={() => setKeysPage((p) => Math.min(keysPagination.pages, p + 1))}
                    className="rounded-lg bg-dark-surface border border-dark-border px-2.5 py-1 text-slate-300 disabled:opacity-40"
                  >
                    Вперёд
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

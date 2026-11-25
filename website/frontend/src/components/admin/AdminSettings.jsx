'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Globe,
  Bot,
  RefreshCw,
  Save,
  Shield,
  Sparkles,
  KeyRound,
  DollarSign,
  Crown,
  Info,
  Loader2,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../BrandIcon';

export default function AdminSettings() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingRate, setRefreshingRate] = useState(false);

  // Данные от сервера
  const [botPayments, setBotPayments] = useState({
    maintenanceMode: false,
    plategaEnabled: true,
    cardEnabled: true,
    bybitEnabled: true,
  });
  const [rateInfo, setRateInfo] = useState({
    baseRateRub: 92.5,
    effectiveRateRub: 92.5,
    updatedAt: null,
  });
  const [secretMasks, setSecretMasks] = useState({});

  // Редактируемое состояние формы
  const [form, setForm] = useState({
    // Раздельные настройки оплаты на САЙТЕ
    webMaintenanceMode: false,
    webBybitUidEnabled: true,
    webPlategaEnabled: true,
    webCryptoTrc20Enabled: true,
    webCryptoBep20Enabled: true,
    webCryptoTonEnabled: true,

    // Курс валют
    currencyMode: 'bybit_p2p',
    manualRate: '95',
    currencyOffset: '0',

    // Smart-цены и уценка
    smartPricing: false,
    smartPricingPreset: 'gemini_ai',
    autoMarkdownEnabled: false,
    autoMarkdownDays: '3',
    autoMarkdownPercent: '5',

    // Лимиты
    minTopup: '1',
    referralBonus: '0.5',
    minSellerWithdraw: '5',
    autoConfirmHours: '24',

    // Реквизиты (открытые адреса)
    topupWallet: '',
    topupNetwork: 'TRC-20 (TRON)',
    bybitUid: '',
    bybitTrc20Address: '',
    bybitBep20Address: '',
    tonAddress: '',

    // Секреты (отправляются ТОЛЬКО если введено новое значение)
    plategaMerchantId: '',
    plategaSecret: '',
    bybitApiKey: '',
    bybitApiSecret: '',
    geminiApiKey: '',
  });

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.getSettings();
      if (res.success && res.settings) {
        const s = res.settings;
        const wp = s.webPayments || {};
        const bp = s.botPayments || {};
        const cur = s.currency || {};
        const pr = s.pricing || {};
        const lim = s.limits || {};
        const ws = s.walletsAndSecrets || {};

        setBotPayments({
          maintenanceMode: Boolean(bp.maintenanceMode),
          plategaEnabled: bp.plategaEnabled !== false,
          cardEnabled: bp.cardEnabled !== false,
          bybitEnabled: bp.bybitEnabled !== false,
        });

        setRateInfo({
          baseRateRub: Number(cur.baseRateRub || 92.5),
          effectiveRateRub: Number(cur.effectiveRateRub || 92.5),
          updatedAt: cur.updatedAt || null,
        });

        setSecretMasks({
          plategaMerchantIdMask: ws.plategaMerchantIdMask || '',
          hasPlategaMerchantId: Boolean(ws.hasPlategaMerchantId),
          plategaSecretMask: ws.plategaSecretMask || '',
          hasPlategaSecret: Boolean(ws.hasPlategaSecret),
          bybitApiKeyMask: ws.bybitApiKeyMask || '',
          hasBybitApiKey: Boolean(ws.hasBybitApiKey),
          bybitApiSecretMask: ws.bybitApiSecretMask || '',
          hasBybitApiSecret: Boolean(ws.hasBybitApiSecret),
          geminiApiKeyMask: ws.geminiApiKeyMask || '',
          hasGeminiKey: Boolean(ws.hasGeminiKey),
        });

        setForm({
          webMaintenanceMode: Boolean(wp.webMaintenanceMode),
          webBybitUidEnabled: wp.webBybitUidEnabled !== false,
          webPlategaEnabled: wp.webPlategaEnabled !== false,
          webCryptoTrc20Enabled: wp.webCryptoTrc20Enabled !== false,
          webCryptoBep20Enabled: wp.webCryptoBep20Enabled !== false,
          webCryptoTonEnabled: wp.webCryptoTonEnabled !== false,

          currencyMode: cur.currencyMode || 'bybit_p2p',
          manualRate: String(cur.manualRate ?? 95),
          currencyOffset: String(cur.currencyOffset ?? 0),

          smartPricing: Boolean(pr.smartPricing),
          smartPricingPreset: pr.smartPricingPreset || 'gemini_ai',
          autoMarkdownEnabled: Boolean(pr.autoMarkdownEnabled),
          autoMarkdownDays: String(pr.autoMarkdownDays ?? 3),
          autoMarkdownPercent: String(pr.autoMarkdownPercent ?? 5),

          minTopup: String(lim.minTopup ?? 1),
          referralBonus: String(lim.referralBonus ?? 0.5),
          minSellerWithdraw: String(lim.minSellerWithdraw ?? 5),
          autoConfirmHours: String(lim.autoConfirmHours ?? 24),

          topupWallet: ws.topupWallet || '',
          topupNetwork: ws.topupNetwork || 'TRC-20 (TRON)',
          bybitUid: ws.bybitUid || '',
          bybitTrc20Address: ws.bybitTrc20Address || '',
          bybitBep20Address: ws.bybitBep20Address || '',
          tonAddress: ws.tonAddress || '',

          plategaMerchantId: '',
          plategaSecret: '',
          bybitApiKey: '',
          bybitApiSecret: '',
          geminiApiKey: '',
        });
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки настроек');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!isSuperAdmin) {
      toast.error('Изменение настроек оплаты и реквизитов доступно только SuperAdmin');
      return;
    }

    const payload = {
      webMaintenanceMode: Boolean(form.webMaintenanceMode),
      webBybitUidEnabled: Boolean(form.webBybitUidEnabled),
      webPlategaEnabled: Boolean(form.webPlategaEnabled),
      webCryptoTrc20Enabled: Boolean(form.webCryptoTrc20Enabled),
      webCryptoBep20Enabled: Boolean(form.webCryptoBep20Enabled),
      webCryptoTonEnabled: Boolean(form.webCryptoTonEnabled),

      currencyMode: form.currencyMode,
      manualRate: Number(form.manualRate) || 95,
      currencyOffset: Number(form.currencyOffset) || 0,

      smartPricing: Boolean(form.smartPricing),
      smartPricingPreset: form.smartPricingPreset,
      autoMarkdownEnabled: Boolean(form.autoMarkdownEnabled),
      autoMarkdownDays: parseInt(form.autoMarkdownDays, 10) || 3,
      autoMarkdownPercent: Number(form.autoMarkdownPercent) || 5,

      minTopup: Number(form.minTopup) || 1,
      referralBonus: Number(form.referralBonus) || 0,
      minSellerWithdraw: Number(form.minSellerWithdraw) || 5,
      autoConfirmHours: parseInt(form.autoConfirmHours, 10) || 24,

      topupWallet: form.topupWallet.trim(),
      topupNetwork: form.topupNetwork.trim(),
      bybitUid: form.bybitUid.trim(),
      bybitTrc20Address: form.bybitTrc20Address.trim(),
      bybitBep20Address: form.bybitBep20Address.trim(),
      tonAddress: form.tonAddress.trim(),
    };

    // Отправляем секреты ТОЛЬКО если пользователь ввёл новое значение (без масок ••••)
    if (form.plategaMerchantId.trim() && !form.plategaMerchantId.includes('••••')) {
      payload.plategaMerchantId = form.plategaMerchantId.trim();
    }
    if (form.plategaSecret.trim() && !form.plategaSecret.includes('••••')) {
      payload.plategaSecret = form.plategaSecret.trim();
    }
    if (form.bybitApiKey.trim() && !form.bybitApiKey.includes('••••')) {
      payload.bybitApiKey = form.bybitApiKey.trim();
    }
    if (form.bybitApiSecret.trim() && !form.bybitApiSecret.includes('••••')) {
      payload.bybitApiSecret = form.bybitApiSecret.trim();
    }
    if (form.geminiApiKey.trim() && !form.geminiApiKey.includes('••••')) {
      payload.geminiApiKey = form.geminiApiKey.trim();
    }

    try {
      setSaving(true);
      await adminApi.updateSettings(payload);
      toast.success('Настройки сохранены и применены');
      await loadSettings();
    } catch (err) {
      toast.error(err.message || 'Ошибка сохранения настроек');
    } finally {
      setSaving(false);
    }
  };

  const handleRefreshRate = async () => {
    try {
      setRefreshingRate(true);
      const res = await adminApi.refreshCurrencyRate();
      toast.success(`Курс обновлён: 1 USDT = ${Number(res.effectiveRateRub || res.rate || 0).toFixed(2)} ₽`);
      await loadSettings();
    } catch (err) {
      toast.error(err.message || 'Не удалось обновить курс');
    } finally {
      setRefreshingRate(false);
    }
  };

  const ToggleSwitch = ({ checked, onChange, disabled, label, desc, brandId }) => (
    <label
      className={`flex items-center justify-between gap-3 rounded-2xl border p-3.5 transition-all cursor-pointer ${
        checked
          ? 'bg-emerald-500/5 border-emerald-500/30'
          : 'bg-dark-surface/50 border-dark-border'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-slate-500'}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {brandId && <BrandIcon brandId={brandId} size={32} rounded="lg" />}
        <div className="min-w-0">
          <div className="text-xs font-bold text-white">{label}</div>
          {desc && <div className="text-[11px] text-slate-400">{desc}</div>}
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-slate-700'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  );

  if (loading) {
    return (
      <div className="py-16 text-center">
        <Loader2 className="h-7 w-7 animate-spin mx-auto text-brand" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6 text-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Настройки магазина и сайта</h2>
          <p className="text-xs text-slate-400">
            Независимое управление платежами сайта, курсом валют, Smart-ценами и секретными ключами
          </p>
        </div>

        {!isSuperAdmin && (
          <div className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 text-amber-300">
            <Crown className="h-3.5 w-3.5" />
            <span>Редактирование доступно только SuperAdmin</span>
          </div>
        )}
      </div>

      {/* 1. Настройки оплаты на САЙТЕ (независимо от Telegram-бота) */}
      <div className="rounded-3xl bg-dark-card border border-brand/35 p-5 sm:p-6 space-y-5 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-dark-border">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/15 text-brand">
              <Globe className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-white">
                Настройки оплаты на САЙТЕ (независимо от Telegram-бота)
              </h3>
              <p className="text-[11px] text-slate-400">
                Управляют только веб-витриной и страницей пополнения /topup
              </p>
            </div>
          </div>
        </div>

        {/* Информационная плашка со статусом бота */}
        <div className="rounded-2xl bg-sky-500/10 border border-sky-500/25 p-4 space-y-2.5">
          <div className="flex items-start gap-2 text-sky-200">
            <Info className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
            <div>
              <span className="font-bold">Раздельные контуры:</span> отключение оплаты в Telegram-боте <b>НЕ отключает</b> оплату на сайте (и наоборот).
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-300 mr-1">
              <Bot className="h-3.5 w-3.5 text-sky-400" />
              Текущий статус Telegram-бота:
            </span>
            {[
              { label: 'Bybit в боте', ok: botPayments.bybitEnabled },
              { label: 'Platega в боте', ok: botPayments.plategaEnabled },
              { label: 'Карта в боте', ok: botPayments.cardEnabled },
              { label: 'Тех. работы бота', ok: !botPayments.maintenanceMode, invert: true },
            ].map((item) => (
              <span
                key={item.label}
                className={`rounded-lg px-2.5 py-0.5 text-[10px] font-bold border ${
                  item.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {item.label}: {item.invert ? (item.ok ? 'Выкл' : 'Вкл') : item.ok ? 'Вкл' : 'Выкл'}
              </span>
            ))}
          </div>
        </div>

        {/* Раздельные тумблеры сайта */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ToggleSwitch
            brandId="bybit"
            label="Bybit UID на сайте"
            desc="webBybitUidEnabled — мгновенный перевод с 4-значным центом"
            checked={form.webBybitUidEnabled}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webBybitUidEnabled: v })}
          />
          <ToggleSwitch
            brandId="sbp"
            label="СБП Platega на сайте"
            desc="webPlategaEnabled — QR-код СБП в рублях"
            checked={form.webPlategaEnabled}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webPlategaEnabled: v })}
          />
          <ToggleSwitch
            brandId="usdt"
            label="USDT TRC-20 на сайте"
            desc="webCryptoTrc20Enabled — прямые переводы в сети Tron"
            checked={form.webCryptoTrc20Enabled}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webCryptoTrc20Enabled: v })}
          />
          <ToggleSwitch
            brandId="bnb"
            label="USDT BEP-20 на сайте"
            desc="webCryptoBep20Enabled — переводы в сети BNB Smart Chain"
            checked={form.webCryptoBep20Enabled}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webCryptoBep20Enabled: v })}
          />
          <ToggleSwitch
            brandId="ton"
            label="TON / USDT (TON) на сайте"
            desc="webCryptoTonEnabled — переводы в сети The Open Network"
            checked={form.webCryptoTonEnabled}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webCryptoTonEnabled: v })}
          />
          <ToggleSwitch
            label="Режим тех. обслуживания САЙТА"
            desc="webMaintenanceMode — блокирует покупки и топап не-админам"
            checked={form.webMaintenanceMode}
            disabled={!isSuperAdmin}
            onChange={(v) => setForm({ ...form, webMaintenanceMode: v })}
          />
        </div>
      </div>

      {/* 2. Курс валют и Smart-Цены */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-emerald-400" />
              <span>Курс USDT / RUB</span>
            </h3>
            <button
              type="button"
              onClick={handleRefreshRate}
              disabled={refreshingRate}
              className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 font-semibold text-slate-200 hover:border-brand/50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingRate ? 'animate-spin' : ''}`} />
              <span>Обновить курс</span>
            </button>
          </div>

          <div className="rounded-xl bg-dark-surface border border-dark-border p-3 flex items-center justify-between">
            <div>
              <span className="text-slate-400 block">Эффективный курс сайта:</span>
              <span className="font-mono text-base font-bold text-emerald-400">
                1 USDT = {rateInfo.effectiveRateRub.toFixed(2)} ₽
              </span>
            </div>
            <div className="text-right text-[11px] text-slate-400">
              <div>База: {rateInfo.baseRateRub.toFixed(2)} ₽</div>
              {rateInfo.updatedAt && (
                <div>Обновлён: {new Date(rateInfo.updatedAt).toLocaleTimeString('ru-RU')}</div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1">Режим курса</label>
              <select
                disabled={!isSuperAdmin}
                value={form.currencyMode}
                onChange={(e) => setForm({ ...form, currencyMode: e.target.value })}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white disabled:opacity-50"
              >
                <option value="bybit_p2p">Авто (Bybit P2P)</option>
                <option value="manual">Ручной курс</option>
              </select>
            </div>
            <div>
              <label className="block font-semibold text-slate-300 mb-1">Ручной курс (₽)</label>
              <input
                type="number"
                step="0.01"
                disabled={!isSuperAdmin || form.currencyMode !== 'manual'}
                value={form.manualRate}
                onChange={(e) => setForm({ ...form, manualRate: e.target.value })}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-300 mb-1">Наценка (₽)</label>
              <input
                type="number"
                step="0.1"
                disabled={!isSuperAdmin}
                value={form.currencyOffset}
                onChange={(e) => setForm({ ...form, currencyOffset: e.target.value })}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        {/* Smart-цены и Умная уценка */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <span>Smart-Цены и Умная уценка</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2 rounded-xl bg-dark-surface border border-dark-border p-3 text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                disabled={!isSuperAdmin}
                checked={form.smartPricing}
                onChange={(e) => setForm({ ...form, smartPricing: e.target.checked })}
                className="rounded border-dark-border bg-dark-input text-brand"
              />
              <span className="font-semibold">Включить Smart-Цены</span>
            </label>

            <div>
              <select
                disabled={!isSuperAdmin}
                value={form.smartPricingPreset}
                onChange={(e) => setForm({ ...form, smartPricingPreset: e.target.value })}
                className="w-full h-full rounded-xl bg-dark-input border border-dark-border px-3 py-2.5 text-white disabled:opacity-50"
              >
                <option value="gemini_ai">Gemini AI</option>
                <option value="standard">Стандарт</option>
                <option value="high_profit">Макс. прибыль</option>
                <option value="minimal">Минимум</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <label className="flex items-center gap-2 rounded-xl bg-dark-surface border border-dark-border p-2.5 text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                disabled={!isSuperAdmin}
                checked={form.autoMarkdownEnabled}
                onChange={(e) => setForm({ ...form, autoMarkdownEnabled: e.target.checked })}
                className="rounded border-dark-border bg-dark-input text-brand"
              />
              <span className="font-semibold">Умная уценка</span>
            </label>

            <div>
              <label className="block text-slate-400 mb-1">Через (дней)</label>
              <input
                type="number"
                min="1"
                disabled={!isSuperAdmin}
                value={form.autoMarkdownDays}
                onChange={(e) => setForm({ ...form, autoMarkdownDays: e.target.value })}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Скидка (%)</label>
              <input
                type="number"
                min="1"
                max="80"
                disabled={!isSuperAdmin}
                value={form.autoMarkdownPercent}
                onChange={(e) => setForm({ ...form, autoMarkdownPercent: e.target.value })}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Лимиты */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Shield className="h-4 w-4 text-sky-400" />
          <span>Лимиты и правила магазина</span>
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-slate-400 mb-1">Мин. пополнение ($)</label>
            <input
              type="number"
              step="0.1"
              disabled={!isSuperAdmin}
              value={form.minTopup}
              onChange={(e) => setForm({ ...form, minTopup: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Реф. бонус ($)</label>
            <input
              type="number"
              step="0.1"
              disabled={!isSuperAdmin}
              value={form.referralBonus}
              onChange={(e) => setForm({ ...form, referralBonus: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Мин. вывод продавца ($)</label>
            <input
              type="number"
              step="0.5"
              disabled={!isSuperAdmin}
              value={form.minSellerWithdraw}
              onChange={(e) => setForm({ ...form, minSellerWithdraw: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Авто-подтверждение (ч)</label>
            <input
              type="number"
              min="1"
              disabled={!isSuperAdmin}
              value={form.autoConfirmHours}
              onChange={(e) => setForm({ ...form, autoConfirmHours: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* 4. Реквизиты и замаскированные ключи */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-amber-400" />
          <span>Реквизиты депозитов и API-секреты (маскированные)</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-slate-400 mb-1">Bybit UID получателя</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.bybitUid}
              onChange={(e) => setForm({ ...form, bybitUid: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Адрес TRC-20 (Bybit TRC20)</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.bybitTrc20Address}
              onChange={(e) => setForm({ ...form, bybitTrc20Address: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Адрес BEP-20 (BSC)</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.bybitBep20Address}
              onChange={(e) => setForm({ ...form, bybitBep20Address: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Адрес TON</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.tonAddress}
              onChange={(e) => setForm({ ...form, tonAddress: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Резервный кошелёк (topupWallet)</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.topupWallet}
              onChange={(e) => setForm({ ...form, topupWallet: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Сеть резервного кошелька</label>
            <input
              type="text"
              disabled={!isSuperAdmin}
              value={form.topupNetwork}
              onChange={(e) => setForm({ ...form, topupNetwork: e.target.value })}
              className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-white disabled:opacity-50"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-dark-border/60">
          <p className="text-[11px] text-slate-400 mb-3">
            Секреты никогда не передаются с сервера в открытом виде. Оставьте поле пустым, чтобы сохранить текущий ключ.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-slate-400 mb-1">Platega Merchant ID</label>
              <input
                type="password"
                disabled={!isSuperAdmin}
                value={form.plategaMerchantId}
                onChange={(e) => setForm({ ...form, plategaMerchantId: e.target.value })}
                placeholder={
                  secretMasks.hasPlategaMerchantId
                    ? `Задан (${secretMasks.plategaMerchantIdMask})`
                    : 'Не задан'
                }
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Platega Secret</label>
              <input
                type="password"
                disabled={!isSuperAdmin}
                value={form.plategaSecret}
                onChange={(e) => setForm({ ...form, plategaSecret: e.target.value })}
                placeholder={
                  secretMasks.hasPlategaSecret
                    ? `Задан (${secretMasks.plategaSecretMask})`
                    : 'Не задан'
                }
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Bybit API Key</label>
              <input
                type="password"
                disabled={!isSuperAdmin}
                value={form.bybitApiKey}
                onChange={(e) => setForm({ ...form, bybitApiKey: e.target.value })}
                placeholder={
                  secretMasks.hasBybitApiKey
                    ? `Задан (${secretMasks.bybitApiKeyMask})`
                    : 'Не задан'
                }
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Bybit API Secret</label>
              <input
                type="password"
                disabled={!isSuperAdmin}
                value={form.bybitApiSecret}
                onChange={(e) => setForm({ ...form, bybitApiSecret: e.target.value })}
                placeholder={
                  secretMasks.hasBybitApiSecret
                    ? `Задан (${secretMasks.bybitApiSecretMask})`
                    : 'Не задан'
                }
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Gemini API Key</label>
              <input
                type="password"
                disabled={!isSuperAdmin}
                value={form.geminiApiKey}
                onChange={(e) => setForm({ ...form, geminiApiKey: e.target.value })}
                placeholder={
                  secretMasks.hasGeminiKey
                    ? `Задан (${secretMasks.geminiApiKeyMask})`
                    : 'Не задан'
                }
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Кнопка сохранения */}
      {isSuperAdmin && (
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-2xl bg-brand px-6 py-3 text-xs font-bold text-white shadow-lg shadow-brand/25 hover:bg-brand-hover transition-all disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            <span>{saving ? 'Сохранение...' : 'Сохранить все настройки'}</span>
          </button>
        </div>
      )}
    </form>
  );
}

'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import {
  Copy,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  QrCode,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { paymentsApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import BrandIcon from '../../components/BrandIcon';

export default function TopupPage() {
  const { user, refreshUser, isAuthenticated, isLoading: authLoading } = useAuth();
  const toast = useToast();

  const [methods, setMethods] = useState([]);
  const [methodsLoaded, setMethodsLoaded] = useState(false);
  const [activeChannel, setActiveChannel] = useState(null); // 'bybit' | 'sbp' | 'crypto' | null
  const [rubRate, setRubRate] = useState(92.5);

  // Bybit UID state
  const [bybitAmount, setBybitAmount] = useState('15');
  const [activeInvoice, setActiveInvoice] = useState(null);
  const [bybitLoading, setBybitLoading] = useState(false);
  const [bybitChecking, setBybitChecking] = useState(false);
  const [bybitStatus, setBybitStatus] = useState('pending');
  const [bybitCopied, setBybitCopied] = useState(null);

  // Platega СБП state
  const [sbpAmountUsdt, setSbpAmountUsdt] = useState('10');
  const [sbpLoading, setSbpLoading] = useState(false);
  const [sbpPayUrl, setSbpPayUrl] = useState(null);

  // Crypto state
  const [cryptoNetwork, setCryptoNetwork] = useState(null); // 'trc20' | 'bep20' | 'ton' | null
  const [wallets, setWallets] = useState({ trc20: '', bep20: '', ton: '' });
  const [txidInput, setTxidInput] = useState('');
  const [txidAmount, setTxidAmount] = useState('50');
  const [cryptoSubmitting, setCryptoSubmitting] = useState(false);
  const [cryptoResult, setCryptoResult] = useState(null);

  const [errorMessage, setErrorMessage] = useState(null);
  const invoicePollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (invoicePollRef.current) clearInterval(invoicePollRef.current);
    };
  }, []);

  // Загрузка строго активных для сайта методов оплаты
  useEffect(() => {
    async function loadPaymentData() {
      try {
        const methodsData = await paymentsApi.getMethods();
        if (methodsData.success) {
          setMethods(methodsData.methods || []);
          if (methodsData.currentRateRub) setRubRate(Number(methodsData.currentRateRub));
        }
        setMethodsLoaded(true);

        if (isAuthenticated) {
          const walletsData = await paymentsApi.getCryptoAddresses().catch(() => null);
          if (walletsData?.success && walletsData.wallets) {
            setWallets(walletsData.wallets);
          }
        }
      } catch (err) {
        console.error('Ошибка загрузки способов оплаты:', err);
        setMethodsLoaded(true);
      }
    }

    loadPaymentData();
  }, [isAuthenticated]);

  const methodMap = useMemo(() => {
    const map = new Map();
    for (const m of methods) {
      map.set(m.id, m);
    }
    return map;
  }, [methods]);

  const hasBybit = methodMap.has('bybit_uid');
  const hasSbp = methodMap.has('platega_sbp');

  const availableCryptoNetworks = useMemo(() => {
    const list = [];
    if (methodMap.has('crypto_usdt_trc20')) {
      list.push({ id: 'trc20', label: 'USDT (TRC-20)', brandId: 'usdt', method: methodMap.get('crypto_usdt_trc20') });
    }
    if (methodMap.has('crypto_usdt_bep20')) {
      list.push({ id: 'bep20', label: 'USDT (BEP-20)', brandId: 'bnb', method: methodMap.get('crypto_usdt_bep20') });
    }
    if (methodMap.has('crypto_ton')) {
      list.push({ id: 'ton', label: 'TON / USDT (TON)', brandId: 'ton', method: methodMap.get('crypto_ton') });
    }
    return list;
  }, [methodMap]);

  const hasCrypto = availableCryptoNetworks.length > 0;

  const availableChannels = useMemo(() => {
    const list = [];
    if (hasBybit) list.push('bybit');
    if (hasSbp) list.push('sbp');
    if (hasCrypto) list.push('crypto');
    return list;
  }, [hasBybit, hasSbp, hasCrypto]);

  // Автоматически выбираем первый доступный канал и первую доступную крипто-сеть
  useEffect(() => {
    if (!methodsLoaded) return;
    if (availableChannels.length === 0) {
      setActiveChannel(null);
    } else if (!activeChannel || !availableChannels.includes(activeChannel)) {
      setActiveChannel(availableChannels[0]);
    }
  }, [methodsLoaded, availableChannels, activeChannel]);

  useEffect(() => {
    if (availableCryptoNetworks.length === 0) {
      setCryptoNetwork(null);
    } else if (!cryptoNetwork || !availableCryptoNetworks.some((n) => n.id === cryptoNetwork)) {
      setCryptoNetwork(availableCryptoNetworks[0].id);
    }
  }, [availableCryptoNetworks, cryptoNetwork]);

  if (!isAuthenticated && !authLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <div className="max-w-md text-center rounded-3xl bg-dark-card border border-dark-border p-8 space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/15 text-brand border border-brand/30">
            <ShieldAlert className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-white">Требуется авторизация</h2>
          <p className="text-xs text-slate-400">
            Войдите через Telegram-бота, чтобы пополнить баланс аккаунта.
          </p>
          <Link
            href="/auth/signin"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-brand px-6 text-xs font-bold text-white hover:bg-brand-hover"
          >
            Войти в аккаунт
          </Link>
        </div>
      </div>
    );
  }

  // 1. Bybit UID: Создание счёта
  const handleCreateBybitInvoice = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    const amountNum = parseFloat(bybitAmount);
    if (isNaN(amountNum) || amountNum < 1.0) {
      const msg = 'Минимальная сумма пополнения Bybit UID — 1.0 USDT';
      setErrorMessage(msg);
      toast.error(msg);
      return;
    }

    try {
      setBybitLoading(true);
      const res = await paymentsApi.createBybitInvoice(amountNum);
      if (res.success && res.invoice) {
        setActiveInvoice(res.invoice);
        setBybitStatus('pending');
        startInvoicePolling(res.invoice.id);
        toast.success('Счёт Bybit UID создан');
      }
    } catch (err) {
      const msg = err.message || 'Ошибка создания счёта Bybit';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setBybitLoading(false);
    }
  };

  const startInvoicePolling = (invoiceId) => {
    if (invoicePollRef.current) clearInterval(invoicePollRef.current);

    invoicePollRef.current = setInterval(async () => {
      try {
        const res = await paymentsApi.getBybitStatus(invoiceId);
        if (res.success && res.status) {
          setBybitStatus(res.status);
          if (res.status === 'completed') {
            clearInterval(invoicePollRef.current);
            toast.success('Перевод Bybit UID зачислен!');
            await refreshUser();
          } else if (res.status === 'cancelled' || res.isExpired) {
            clearInterval(invoicePollRef.current);
          }
        }
      } catch (_) {}
    }, 3000);
  };

  const handleCheckBybitManual = async () => {
    if (!activeInvoice) return;
    try {
      setBybitChecking(true);
      const res = await paymentsApi.checkBybitInvoiceManual(activeInvoice.id);
      if (res.status === 'completed') {
        setBybitStatus('completed');
        if (invoicePollRef.current) clearInterval(invoicePollRef.current);
        toast.success('Перевод подтверждён и зачислен!');
        await refreshUser();
      } else {
        toast.info('Перевод пока не найден. Обычно зачисление занимает 20–60 секунд.');
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка проверки перевода');
    } finally {
      setBybitChecking(false);
    }
  };

  const handleCancelBybit = async () => {
    if (!activeInvoice) return;
    try {
      await paymentsApi.cancelBybitInvoice(activeInvoice.id);
      if (invoicePollRef.current) clearInterval(invoicePollRef.current);
      setActiveInvoice(null);
      setBybitStatus('cancelled');
      toast.info('Счёт Bybit отменён');
    } catch (err) {
      toast.error(err.message || 'Не удалось отменить счёт');
    }
  };

  // 2. Platega СБП
  const handleCreatePlatega = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    const amountNum = parseFloat(sbpAmountUsdt);
    if (isNaN(amountNum) || amountNum < 1.0) {
      const msg = 'Минимальная сумма пополнения — 1.0 USDT';
      setErrorMessage(msg);
      toast.error(msg);
      return;
    }

    try {
      setSbpLoading(true);
      const res = await paymentsApi.createPlategaPayment(amountNum);
      if (res.success && res.payUrl) {
        setSbpPayUrl(res.payUrl);
        toast.success('Платёжная ссылка СБП сформирована');
        window.open(res.payUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      const msg = err.message || 'Ошибка генерации СБП платежа';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setSbpLoading(false);
    }
  };

  // 3. Crypto TXID
  const handleCryptoSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    setCryptoResult(null);

    if (!cryptoNetwork) {
      toast.error('Нет доступной криптосети');
      return;
    }

    const amountNum = parseFloat(txidAmount);
    if (isNaN(amountNum) || amountNum < 1.0) {
      const msg = 'Укажите корректную сумму перевода (от 1.0 USDT)';
      setErrorMessage(msg);
      toast.error(msg);
      return;
    }

    if (!txidInput.trim()) {
      const msg = 'Укажите хеш транзакции (txid)';
      setErrorMessage(msg);
      toast.error(msg);
      return;
    }

    try {
      setCryptoSubmitting(true);
      const res = await paymentsApi.submitCryptoTxid(cryptoNetwork, amountNum, txidInput.trim());
      if (res.success) {
        setCryptoResult({ success: true, message: res.message });
        setTxidInput('');
        toast.success('Транзакция отправлена на проверку');
      }
    } catch (err) {
      const msg = err.message || 'Ошибка проверки транзакции';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setCryptoSubmitting(false);
    }
  };

  const copyText = (text, field) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setBybitCopied(field);
    toast.success('Скопировано в буфер обмена');
    setTimeout(() => setBybitCopied(null), 2000);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      {/* Шапка */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-dark-border">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Пополнение баланса</h1>
          <p className="text-xs text-slate-400 mt-1">
            Средства зачисляются на ваш счёт и могут быть использованы для мгновенной покупки любых товаров.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-2xl bg-dark-card border border-dark-border px-4 py-2.5">
          <span className="text-xs text-slate-400">Текущий баланс:</span>
          <span className="font-mono text-base font-bold text-emerald-400 tabular-nums">
            {user?.balance?.toFixed(2) || '0.00'} USDT
          </span>
        </div>
      </div>

      {/* Если ни один метод не включён для сайта */}
      {methodsLoaded && availableChannels.length === 0 ? (
        <div className="rounded-3xl bg-dark-card border border-dark-border p-10 text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-amber-400 mx-auto" />
          <h3 className="text-lg font-bold text-white">Методы оплаты временно отключены</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            В данный момент администратор отключил способы пополнения для веб-сайта. Пожалуйста, попробуйте позже.
          </p>
        </div>
      ) : (
        <>
          {/* Вкладки только активных методов оплаты */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {hasBybit && (
              <button
                type="button"
                onClick={() => {
                  setActiveChannel('bybit');
                  setErrorMessage(null);
                }}
                className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
                  activeChannel === 'bybit'
                    ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
                    : 'bg-dark-card border-dark-border hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between mb-2.5">
                  <BrandIcon brandId="bybit" size={34} rounded="lg" />
                  <span className="rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-bold px-2 py-0.5 border border-emerald-500/30">
                    0% комиссия
                  </span>
                </div>
                <span className="font-bold text-sm text-white">Bybit UID</span>
                <span className="text-xs text-slate-400 mt-1">
                  Внутренний перевод. Зачисление 20 секунд.
                </span>
              </button>
            )}

            {hasSbp && (
              <button
                type="button"
                onClick={() => {
                  setActiveChannel('sbp');
                  setErrorMessage(null);
                }}
                className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
                  activeChannel === 'sbp'
                    ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
                    : 'bg-dark-card border-dark-border hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between mb-2.5">
                  <BrandIcon brandId="sbp" size={34} rounded="lg" />
                  <span className="rounded-full bg-brand/15 text-brand text-[10px] font-bold px-2 py-0.5 border border-brand/30">
                    СБП Рубли
                  </span>
                </div>
                <span className="font-bold text-sm text-white">QR-код СБП</span>
                <span className="text-xs text-slate-400 mt-1">
                  Оплата в рублях по курсу 1 USDT = {rubRate.toFixed(2)} ₽.
                </span>
              </button>
            )}

            {hasCrypto && (
              <button
                type="button"
                onClick={() => {
                  setActiveChannel('crypto');
                  setErrorMessage(null);
                }}
                className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
                  activeChannel === 'crypto'
                    ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
                    : 'bg-dark-card border-dark-border hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between mb-2.5">
                  <BrandIcon brandId="usdt" size={34} rounded="lg" />
                  <span className="rounded-full bg-blue-500/15 text-blue-400 text-[10px] font-bold px-2 py-0.5 border border-blue-500/30">
                    Прямой блокчейн
                  </span>
                </div>
                <span className="font-bold text-sm text-white">Криптовалюта</span>
                <span className="text-xs text-slate-400 mt-1">
                  {availableCryptoNetworks.map((n) => n.id.toUpperCase()).join(', ')}
                </span>
              </button>
            )}
          </div>

          {errorMessage && (
            <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3.5 text-xs text-rose-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* ─── 1. Bybit UID ───────────────────────────────────────────── */}
          {activeChannel === 'bybit' && hasBybit && (
            <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
              {!activeInvoice ? (
                <form onSubmit={handleCreateBybitInvoice} className="space-y-5 max-w-md">
                  <div className="flex items-start gap-3">
                    <BrandIcon brandId="bybit" size={40} />
                    <div>
                      <h3 className="text-base font-bold text-white">Пополнение через Bybit UID</h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Система сгенерирует уникальную сумму с центами (например, 15.0037 USDT) для 100% автоматического зачисления перевода.
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2">
                      Сумма пополнения (USDT):
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {['10', '25', '50', '100'].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setBybitAmount(val)}
                          className={`rounded-xl px-3.5 py-1.5 text-xs font-mono font-bold transition-all ${
                            bybitAmount === val
                              ? 'bg-brand text-white shadow-md shadow-brand/20'
                              : 'bg-dark-surface border border-dark-border text-slate-300 hover:text-white'
                          }`}
                        >
                          {val} USDT
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      value={bybitAmount}
                      onChange={(e) => setBybitAmount(e.target.value)}
                      placeholder="Минимум 1.0 USDT"
                      className="mt-3 w-full rounded-xl bg-dark-input border border-dark-border px-4 py-3 text-sm font-mono text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={bybitLoading}
                    className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-lg shadow-brand/25 hover:bg-brand-hover transition-all disabled:opacity-50"
                  >
                    <span>{bybitLoading ? 'Генерация счёта...' : 'Создать счёт на оплату'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>
              ) : (
                <div className="space-y-6 max-w-lg">
                  {bybitStatus === 'completed' ? (
                    <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/30 p-6 text-center space-y-3">
                      <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto" />
                      <h3 className="text-lg font-bold text-white">Перевод успешно зачислен!</h3>
                      <p className="text-xs text-slate-300">
                        Баланс обновлён. Вы можете вернуться в каталог и оформить заказ.
                      </p>
                      <Link
                        href="/"
                        className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-500 px-6 text-xs font-bold text-black hover:bg-emerald-400"
                      >
                        Перейти в каталог
                      </Link>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between pb-3 border-b border-dark-border">
                        <div className="flex items-center gap-2.5">
                          <BrandIcon brandId="bybit" size={32} rounded="lg" />
                          <div>
                            <h3 className="text-base font-bold text-white">Счёт Bybit UID</h3>
                            <div className="text-[11px] text-slate-400 font-mono">
                              № {activeInvoice.invoiceNumber}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 text-xs font-semibold text-amber-400">
                          <Clock className="h-3.5 w-3.5" />
                          <span>Ожидаем перевод</span>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="rounded-2xl bg-dark-surface p-4 border border-dark-border space-y-1">
                          <span className="text-[11px] uppercase font-semibold text-slate-400">
                            Точная сумма перевода (USDT):
                          </span>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-2xl font-bold font-mono text-brand select-all tabular-nums">
                              {activeInvoice.exactAmount} USDT
                            </span>
                            <button
                              type="button"
                              onClick={() => copyText(String(activeInvoice.exactAmount), 'amount')}
                              className="flex items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-200 hover:text-white"
                            >
                              <Copy className="h-3.5 w-3.5" />
                              <span>{bybitCopied === 'amount' ? 'Скопировано!' : 'Копировать'}</span>
                            </button>
                          </div>
                          <p className="text-[11px] text-amber-400 font-medium pt-1">
                            Переведите ровно эту сумму с центами! Не округляйте, иначе платёж не сопоставится автоматически.
                          </p>
                        </div>

                        <div className="rounded-2xl bg-dark-surface p-4 border border-dark-border space-y-1">
                          <span className="text-[11px] uppercase font-semibold text-slate-400">
                            UID Получателя (Bybit):
                          </span>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xl font-bold font-mono text-white select-all">
                              {activeInvoice.adminUid}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyText(activeInvoice.adminUid, 'uid')}
                              className="flex items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-200 hover:text-white"
                            >
                              <Copy className="h-3.5 w-3.5" />
                              <span>{bybitCopied === 'uid' ? 'Скопировано!' : 'Копировать'}</span>
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl bg-dark-input border border-dark-border p-3.5 text-xs text-slate-300 space-y-1 leading-relaxed">
                        <div className="font-bold text-white">Как перевести в приложении Bybit:</div>
                        <div>1. Откройте Bybit ➔ Активы ➔ Вывод ➔ Внутренний перевод.</div>
                        <div>2. Выберите тип перевода: <b className="text-white">UID</b>.</div>
                        <div>3. Вставьте UID получателя и укажите точную сумму.</div>
                        <div>4. Подтвердите перевод. Зачисление произойдёт автоматически.</div>
                      </div>

                      <div className="flex flex-col sm:flex-row items-center gap-3 pt-1">
                        <button
                          type="button"
                          onClick={handleCheckBybitManual}
                          disabled={bybitChecking}
                          className="flex-1 w-full h-11 flex items-center justify-center gap-2 rounded-xl bg-brand text-xs font-bold text-white hover:bg-brand-hover transition-all disabled:opacity-50"
                        >
                          <RefreshCw className={`h-4 w-4 ${bybitChecking ? 'animate-spin' : ''}`} />
                          <span>{bybitChecking ? 'Проверка...' : 'Проверить перевод'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelBybit}
                          className="flex-1 w-full h-11 rounded-xl bg-dark-surface border border-dark-border text-xs font-semibold text-slate-400 hover:text-rose-400 hover:border-rose-500/40 transition-all"
                        >
                          Отменить счёт
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── 2. Platega СБП ─────────────────────────────────────────── */}
          {activeChannel === 'sbp' && hasSbp && (
            <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
              <form onSubmit={handleCreatePlatega} className="space-y-5 max-w-md">
                <div className="flex items-start gap-3">
                  <BrandIcon brandId="sbp" size={40} />
                  <div>
                    <h3 className="text-base font-bold text-white">Оплата через СБП (Рубли)</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Генерация QR-кода Системы быстрых платежей. Оплата в 1 клик через любые банки РФ.
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-2">
                    Сумма (USDT):
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={sbpAmountUsdt}
                    onChange={(e) => setSbpAmountUsdt(e.target.value)}
                    className="w-full rounded-xl bg-dark-input border border-dark-border px-4 py-3 text-sm font-mono text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                  />
                  <div className="mt-2 text-xs text-emerald-400 font-mono tabular-nums">
                    К оплате в рублях: ≈ {Math.round((parseFloat(sbpAmountUsdt) || 0) * rubRate).toLocaleString('ru-RU')} ₽
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={sbpLoading}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-lg shadow-brand/25 hover:bg-brand-hover transition-all disabled:opacity-50"
                >
                  <QrCode className="h-4 w-4" />
                  <span>{sbpLoading ? 'Генерация QR-кода...' : 'Оплатить по QR-коду СБП'}</span>
                </button>

                {sbpPayUrl && (
                  <a
                    href={sbpPayUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border text-xs font-semibold text-brand hover:border-brand/50"
                  >
                    Открыть ссылку оплаты СБП повторно
                  </a>
                )}
              </form>
            </div>
          )}

          {/* ─── 3. Криптовалюта ────────────────────────────────────────── */}
          {activeChannel === 'crypto' && hasCrypto && cryptoNetwork && (
            <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
              <div className="space-y-4 max-w-lg">
                <div className="flex items-start gap-3">
                  <BrandIcon brandId="usdt" size={40} />
                  <div>
                    <h3 className="text-base font-bold text-white">Прямой перевод криптовалюты</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Переведите средства на официальный адрес депозита, затем отправьте хеш транзакции (txid) для зачисления.
                    </p>
                  </div>
                </div>

                {/* Только активные крипто-сети */}
                <div className="flex flex-wrap gap-2">
                  {availableCryptoNetworks.map((net) => (
                    <button
                      key={net.id}
                      type="button"
                      onClick={() => setCryptoNetwork(net.id)}
                      className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                        cryptoNetwork === net.id
                          ? 'bg-brand text-white shadow-md shadow-brand/20'
                          : 'bg-dark-surface border border-dark-border text-slate-300 hover:text-white'
                      }`}
                    >
                      <BrandIcon brandId={net.brandId} size={18} />
                      <span>{net.label}</span>
                    </button>
                  ))}
                </div>

                <div className="rounded-2xl bg-dark-surface p-4 border border-dark-border space-y-2">
                  <span className="text-[11px] uppercase font-semibold text-slate-400">
                    Адрес депозита в сети {cryptoNetwork.toUpperCase()}:
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-emerald-400 break-all select-all">
                      {wallets[cryptoNetwork] || 'Адрес не настроен'}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyText(wallets[cryptoNetwork], 'wallet')}
                      disabled={!wallets[cryptoNetwork]}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-2.5 py-1.5 text-xs text-slate-200 hover:text-white disabled:opacity-40"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{bybitCopied === 'wallet' ? 'OK!' : 'Копия'}</span>
                    </button>
                  </div>
                </div>

                <form onSubmit={handleCryptoSubmit} className="space-y-4 pt-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Сумма перевода (USDT):
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={txidAmount}
                      onChange={(e) => setTxidAmount(e.target.value)}
                      placeholder="Например: 50"
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3.5 py-2.5 text-xs font-mono text-white placeholder-slate-600 focus:border-brand focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Хеш транзакции (txid):
                    </label>
                    <input
                      type="text"
                      value={txidInput}
                      onChange={(e) => setTxidInput(e.target.value)}
                      placeholder="Вставьте txid транзакции из кошелька"
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3.5 py-2.5 text-xs font-mono text-white placeholder-slate-600 focus:border-brand focus:outline-none"
                    />
                  </div>

                  {cryptoResult && (
                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-400">
                      {cryptoResult.message}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={cryptoSubmitting}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-md shadow-brand/20 hover:bg-brand-hover transition-all disabled:opacity-50"
                  >
                    <span>{cryptoSubmitting ? 'Отправка...' : 'Отправить на проверку'}</span>
                  </button>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

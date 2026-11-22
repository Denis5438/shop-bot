'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Copy, Clock, CheckCircle2, AlertCircle, ArrowRight, ShieldCheck, Zap, QrCode, RefreshCw } from 'lucide-react';
import { paymentsApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';

export default function TopupPage() {
  const { user, refreshUser, isAuthenticated, isLoading: authLoading } = useAuth();

  const [activeChannel, setActiveChannel] = useState('bybit'); // 'bybit' | 'sbp' | 'crypto'
  const [methods, setMethods] = useState([]);
  const [rubRate, setRubRate] = useState(92.5);

  // Bybit UID state
  const [bybitAmount, setBybitAmount] = useState('15');
  const [activeInvoice, setActiveInvoice] = useState(null);
  const [bybitLoading, setBybitLoading] = useState(false);
  const [bybitStatus, setBybitStatus] = useState('pending');
  const [bybitCopied, setBybitCopied] = useState(null);

  // Platega СБП state
  const [sbpAmountUsdt, setSbpAmountUsdt] = useState('10');
  const [sbpLoading, setSbpLoading] = useState(false);
  const [sbpPayUrl, setSbpPayUrl] = useState(null);

  // Crypto state
  const [cryptoNetwork, setCryptoNetwork] = useState('trc20'); // 'trc20' | 'bep20' | 'ton'
  const [wallets, setWallets] = useState({ trc20: '', bep20: '', ton: '' });
  const [txidInput, setTxidInput] = useState('');
  const [txidAmount, setTxidAmount] = useState('50');
  const [cryptoSubmitting, setCryptoSubmitting] = useState(false);
  const [cryptoResult, setCryptoResult] = useState(null);

  const [errorMessage, setErrorMessage] = useState(null);
  const invoicePollRef = useRef(null);

  // Очистка таймеров опроса
  useEffect(() => {
    return () => {
      if (invoicePollRef.current) clearInterval(invoicePollRef.current);
    };
  }, []);

  // Загрузка доступных методов и реквизитов
  useEffect(() => {
    async function loadPaymentData() {
      try {
        const methodsData = await paymentsApi.getMethods();
        if (methodsData.success) {
          setMethods(methodsData.methods || []);
          if (methodsData.currentRateRub) setRubRate(methodsData.currentRateRub);
        }

        if (isAuthenticated) {
          const walletsData = await paymentsApi.getCryptoAddresses();
          if (walletsData.success && walletsData.wallets) {
            setWallets(walletsData.wallets);
          }
        }
      } catch (err) {
        console.error('Ошибка загрузки способов оплаты:', err);
      }
    }

    loadPaymentData();
  }, [isAuthenticated]);

  if (!isAuthenticated && !authLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <div className="max-w-md text-center rounded-3xl bg-dark-card border border-dark-border p-8 space-y-4">
          <span className="text-4xl">🔐</span>
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
      setErrorMessage('Минимальная сумма пополнения Bybit UID — 1.0 USDT');
      return;
    }

    try {
      setBybitLoading(true);
      const res = await paymentsApi.createBybitInvoice(amountNum);
      if (res.success && res.invoice) {
        setActiveInvoice(res.invoice);
        setBybitStatus('pending');
        startInvoicePolling(res.invoice.id);
      }
    } catch (err) {
      setErrorMessage(err.message || 'Ошибка создания счёта Bybit');
    } finally {
      setBybitLoading(false);
    }
  };

  // Фоновый опрос счёта Bybit (каждые 3 сек)
  const startInvoicePolling = (invoiceId) => {
    if (invoicePollRef.current) clearInterval(invoicePollRef.current);

    invoicePollRef.current = setInterval(async () => {
      try {
        const res = await paymentsApi.getBybitStatus(invoiceId);
        if (res.success && res.status) {
          setBybitStatus(res.status);
          if (res.status === 'completed') {
            clearInterval(invoicePollRef.current);
            await refreshUser();
          } else if (res.status === 'cancelled' || res.isExpired) {
            clearInterval(invoicePollRef.current);
          }
        }
      } catch (_) {}
    }, 3000);
  };

  // Отмена счёта Bybit
  const handleCancelBybit = async () => {
    if (!activeInvoice) return;
    try {
      await paymentsApi.cancelBybitInvoice(activeInvoice.id);
      if (invoicePollRef.current) clearInterval(invoicePollRef.current);
      setActiveInvoice(null);
      setBybitStatus('cancelled');
    } catch (err) {
      alert(err.message || 'Не удалось отменить счёт');
    }
  };

  // 2. Platega СБП: Создание ссылки
  const handleCreatePlatega = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    const amountNum = parseFloat(sbpAmountUsdt);
    if (isNaN(amountNum) || amountNum < 1.0) {
      setErrorMessage('Минимальная сумма пополнения — 1.0 USDT');
      return;
    }

    try {
      setSbpLoading(true);
      const res = await paymentsApi.createPlategaPayment(amountNum);
      if (res.success && res.payUrl) {
        setSbpPayUrl(res.payUrl);
        window.open(res.payUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setErrorMessage(err.message || 'Ошибка генерации СБП платежа');
    } finally {
      setSbpLoading(false);
    }
  };

  // 3. Crypto: Отправка TXID
  const handleCryptoSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage(null);
    setCryptoResult(null);

    const amountNum = parseFloat(txidAmount);
    if (isNaN(amountNum) || amountNum < 1.0) {
      setErrorMessage('Укажите корректную сумму перевода');
      return;
    }

    if (!txidInput.trim()) {
      setErrorMessage('Укажите хеш транзакции (txid)');
      return;
    }

    try {
      setCryptoSubmitting(true);
      const res = await paymentsApi.submitCryptoTxid(cryptoNetwork, amountNum, txidInput.trim());
      if (res.success) {
        setCryptoResult({ success: true, message: res.message });
        setTxidInput('');
      }
    } catch (err) {
      setErrorMessage(err.message || 'Ошибка проверки транзакции');
    } finally {
      setCryptoSubmitting(false);
    }
  };

  const copyText = (text, field) => {
    navigator.clipboard.writeText(text);
    setBybitCopied(field);
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
          <span className="font-mono text-base font-bold text-emerald-400">
            {user?.balance?.toFixed(2) || '0.00'} USDT
          </span>
        </div>
      </div>

      {/* Выбор платёжного канала */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          onClick={() => { setActiveChannel('bybit'); setErrorMessage(null); }}
          className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
            activeChannel === 'bybit'
              ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
              : 'bg-dark-card border-dark-border hover:border-slate-600'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xl">📊</span>
            <span className="rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-bold px-2 py-0.5 border border-emerald-500/30">
              0% комиссия
            </span>
          </div>
          <span className="font-bold text-sm text-white">Bybit UID</span>
          <span className="text-xs text-slate-400 mt-1">
            Внутренний перевод. Зачисление 20 секунд.
          </span>
        </button>

        <button
          onClick={() => { setActiveChannel('sbp'); setErrorMessage(null); }}
          className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
            activeChannel === 'sbp'
              ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
              : 'bg-dark-card border-dark-border hover:border-slate-600'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xl">💳</span>
            <span className="rounded-full bg-brand/15 text-brand text-[10px] font-bold px-2 py-0.5 border border-brand/30">
              СБП Рубли
            </span>
          </div>
          <span className="font-bold text-sm text-white">QR-код СБП</span>
          <span className="text-xs text-slate-400 mt-1">
            Оплата в рублях по курсу 1 USDT = {rubRate} ₽.
          </span>
        </button>

        <button
          onClick={() => { setActiveChannel('crypto'); setErrorMessage(null); }}
          className={`flex flex-col p-4 rounded-2xl text-left border transition-all ${
            activeChannel === 'crypto'
              ? 'bg-brand/10 border-brand shadow-lg shadow-brand/10'
              : 'bg-dark-card border-dark-border hover:border-slate-600'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xl">💎</span>
            <span className="rounded-full bg-blue-500/15 text-blue-400 text-[10px] font-bold px-2 py-0.5 border border-blue-500/30">
              Прямой блокчейн
            </span>
          </div>
          <span className="font-bold text-sm text-white">Криптовалюта</span>
          <span className="text-xs text-slate-400 mt-1">
            USDT (TRC-20, BEP-20) и TON.
          </span>
        </button>
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3.5 text-xs text-rose-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* ─── 1. Форма Bybit UID ────────────────────────────────────────── */}
      {activeChannel === 'bybit' && (
        <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
          {!activeInvoice ? (
            <form onSubmit={handleCreateBybitInvoice} className="space-y-5 max-w-md">
              <div>
                <h3 className="text-base font-bold text-white">Пополнение через Bybit UID</h3>
                <p className="text-xs text-slate-400 mt-1">
                  Система сгенерирует уникальную сумму с центами (например, 15.0037 USDT) для 100% автоматического зачисления перевода за 20 секунд.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  Сумма пополнения (USDT):
                </label>
                <div className="flex gap-2">
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
            /* Активный счёт Bybit */
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
                    <div>
                      <h3 className="text-base font-bold text-white">Счёт Bybit UID</h3>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        № {activeInvoice.invoiceNumber}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 text-xs font-semibold text-amber-400 animate-pulse">
                      <Clock className="h-3.5 w-3.5" />
                      <span>Ожидаем перевод</span>
                    </div>
                  </div>

                  {/* Реквизиты перевода */}
                  <div className="space-y-3">
                    <div className="rounded-2xl bg-dark-surface p-4 border border-dark-border space-y-1">
                      <span className="text-[11px] uppercase font-semibold text-slate-400">
                        Точная сумма перевода (USDT):
                      </span>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-2xl font-bold font-mono text-brand select-all">
                          {activeInvoice.exactAmount} USDT
                        </span>
                        <button
                          onClick={() => copyText(String(activeInvoice.exactAmount), 'amount')}
                          className="flex items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-200 hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          <span>{bybitCopied === 'amount' ? 'Скопировано!' : 'Копировать'}</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-amber-400 font-medium pt-1">
                        ⚠️ Переведите ровно эту сумму с центами! Не округляйте, иначе платёж не сопоставится автоматически.
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
                          onClick={() => copyText(activeInvoice.adminUid, 'uid')}
                          className="flex items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-200 hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          <span>{bybitCopied === 'uid' ? 'Скопировано!' : 'Копировать'}</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Инструкция */}
                  <div className="rounded-xl bg-dark-input border border-dark-border p-3.5 text-xs text-slate-300 space-y-1 leading-relaxed">
                    <div className="font-bold text-white">Как перевести в приложении Bybit:</div>
                    <div>1. Откройте Bybit ➔ Активы ➔ Вывод ➔ Внутренний перевод.</div>
                    <div>2. Выберите тип перевода: <b className="text-white">UID</b>.</div>
                    <div>3. Вставьте UID получателя и укажите точную сумму.</div>
                    <div>4. Подтвердите перевод. Зачисление произойдёт автоматически.</div>
                  </div>

                  <div className="flex items-center gap-3 pt-2">
                    <button
                      onClick={handleCancelBybit}
                      className="flex-1 h-11 rounded-xl bg-dark-surface border border-dark-border text-xs font-semibold text-slate-400 hover:text-rose-400 hover:border-rose-500/40 transition-all"
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

      {/* ─── 2. Форма Platega СБП ──────────────────────────────────────── */}
      {activeChannel === 'sbp' && (
        <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
          <form onSubmit={handleCreatePlatega} className="space-y-5 max-w-md">
            <div>
              <h3 className="text-base font-bold text-white">Оплата через СБП (Рубли)</h3>
              <p className="text-xs text-slate-400 mt-1">
                Генерация QR-кода Системы быстрых платежей. Оплата в 1 клик через Сбербанк, Тинькофф, ВТБ, Альфа и любые банки РФ.
              </p>
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
              <div className="mt-2 text-xs text-emerald-400 font-mono">
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
          </form>
        </div>
      )}

      {/* ─── 3. Форма Криптовалюты ─────────────────────────────────────── */}
      {activeChannel === 'crypto' && (
        <div className="rounded-3xl bg-dark-card border border-dark-border p-6 sm:p-8 space-y-6">
          <div className="space-y-4 max-w-lg">
            <div>
              <h3 className="text-base font-bold text-white">Прямой перевод криптовалюты</h3>
              <p className="text-xs text-slate-400 mt-1">
                Переведите средства на официальный адрес депозита, затем отправьте хеш транзакции (txid) для зачисления.
              </p>
            </div>

            {/* Выбор сети */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCryptoNetwork('trc20')}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                  cryptoNetwork === 'trc20'
                    ? 'bg-brand text-white shadow-md shadow-brand/20'
                    : 'bg-dark-surface border border-dark-border text-slate-400 hover:text-white'
                }`}
              >
                USDT (TRC-20)
              </button>
              <button
                type="button"
                onClick={() => setCryptoNetwork('bep20')}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                  cryptoNetwork === 'bep20'
                    ? 'bg-brand text-white shadow-md shadow-brand/20'
                    : 'bg-dark-surface border border-dark-border text-slate-400 hover:text-white'
                }`}
              >
                USDT (BEP-20)
              </button>
              <button
                type="button"
                onClick={() => setCryptoNetwork('ton')}
                className={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                  cryptoNetwork === 'ton'
                    ? 'bg-brand text-white shadow-md shadow-brand/20'
                    : 'bg-dark-surface border border-dark-border text-slate-400 hover:text-white'
                }`}
              >
                TON / USDT (TON)
              </button>
            </div>

            {/* Адрес для депозита */}
            <div className="rounded-2xl bg-dark-surface p-4 border border-dark-border space-y-2">
              <span className="text-[11px] uppercase font-semibold text-slate-400">
                Адрес депозита в сети {cryptoNetwork.toUpperCase()}:
              </span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-emerald-400 break-all select-all">
                  {wallets[cryptoNetwork] || 'Адрес загружается...'}
                </span>
                <button
                  type="button"
                  onClick={() => copyText(wallets[cryptoNetwork], 'wallet')}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-dark-card border border-dark-border px-2.5 py-1.5 text-xs text-slate-200 hover:text-white"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>{bybitCopied === 'wallet' ? 'OK!' : 'Копия'}</span>
                </button>
              </div>
            </div>

            {/* Отправка TXID */}
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
    </div>
  );
}

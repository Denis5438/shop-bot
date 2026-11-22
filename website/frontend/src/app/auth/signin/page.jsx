'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Send, ArrowRight, ShieldCheck, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { authApi } from '../../../lib/api';
import { useAuth } from '../../../context/AuthContext';

export default function SignInPage() {
  const router = useRouter();
  const { setAuthenticatedUser, isAuthenticated } = useAuth();

  const [activeTab, setActiveTab] = useState('login'); // 'login' | 'register'
  const [sessionToken, setSessionToken] = useState(null);
  const [botUsername, setBotUsername] = useState('testantiscam1bot');
  const [deepLink, setDeepLink] = useState(null);
  const [code, setCode] = useState('');
  const [isRequestingSession, setIsRequestingSession] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [pollStatus, setPollStatus] = useState('idle'); // 'idle' | 'polling' | 'authenticated'

  // Email form state (дизайн из скриншота)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  const pollIntervalRef = useRef(null);

  // Если уже авторизован — редирект в каталог или заказы
  useEffect(() => {
    if (isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, router]);

  // Очистка интервала polling при размонтировании (Требование Claude #4)
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // 1. Нажатие "Получить код в Telegram"
  const handleGetTelegramCode = async () => {
    try {
      setIsRequestingSession(true);
      setErrorMessage(null);

      const data = await authApi.getSession();
      if (!data.success || !data.sessionToken) {
        throw new Error(data.message || 'Не удалось создать сессию');
      }

      setSessionToken(data.sessionToken);
      if (data.botUsername) setBotUsername(data.botUsername);
      setDeepLink(data.deepLink);

      // Открываем бота в новой вкладке
      try {
        window.open(data.deepLink, '_blank', 'noopener,noreferrer');
      } catch (_) {}

      // Запускаем фоновый опрос статуса (интервал 2.5 сек)
      startPolling(data.sessionToken);
    } catch (err) {
      setErrorMessage(err.message || 'Ошибка подключения к боту');
    } finally {
      setIsRequestingSession(false);
    }
  };

  // 2. Фоновый опрос для 1-клик входа (если юзер нажал "Подтвердить" в боте)
  const startPolling = (token) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    setPollStatus('polling');
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await authApi.checkStatus(token);
        if (res.authenticated && res.user) {
          clearInterval(pollIntervalRef.current);
          setPollStatus('authenticated');
          setSuccessMessage('Вход подтверждён в Telegram!');
          setAuthenticatedUser(res.user);

          setTimeout(() => {
            router.push('/');
          }, 1000);
        }
      } catch (_) {
        // Ошибки сети при опросе игнорируем
      }
    }, 2500);
  };

  // 3. Подтверждение ручного ввода 6-значного кода
  const handleVerifyCode = async (e) => {
    e.preventDefault();
    if (!sessionToken) {
      setErrorMessage('Сначала нажмите "Получить код в Telegram"');
      return;
    }

    const clean = code.replace(/\s+/g, '').trim();
    if (clean.length !== 6 || !/^\d{6}$/.test(clean)) {
      setErrorMessage('Код должен состоять ровно из 6 цифр');
      return;
    }

    try {
      setIsVerifying(true);
      setErrorMessage(null);

      const res = await authApi.verifyCode(sessionToken, clean);
      if (res.success && res.user) {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setAuthenticatedUser(res.user);
        setSuccessMessage('Успешный вход!');

        setTimeout(() => {
          router.push('/');
        }, 800);
      }
    } catch (err) {
      setErrorMessage(err.message || 'Неверный код или превышен лимит попыток');
    } finally {
      setIsVerifying(false);
    }
  };

  // Форматирование ввода кода "123 456"
  const handleCodeChange = (e) => {
    let raw = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (raw.length > 3) {
      raw = `${raw.slice(0, 3)} ${raw.slice(3)}`;
    }
    setCode(raw);
  };

  return (
    <div className="flex min-h-[82vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Заголовок */}
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Войдите, чтобы открыть свои заказы.
          </h1>

          {/* Табы [Вход] [Регистрация] как на скриншоте */}
          <div className="inline-flex rounded-full bg-dark-card border border-dark-border p-1 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('login')}
              className={`rounded-full px-5 py-1.5 transition-all ${
                activeTab === 'login'
                  ? 'bg-dark-surface text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Вход
            </button>
            <button
              onClick={() => setActiveTab('register')}
              className={`rounded-full px-5 py-1.5 transition-all ${
                activeTab === 'register'
                  ? 'bg-dark-surface text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Регистрация
            </button>
          </div>
        </div>

        {/* Главная карточка авторизации */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-6">
          {/* Блок Telegram-входа по коду */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-white text-base">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#2AABEE] text-white text-xs">
                  <Send className="h-3.5 w-3.5 fill-current" />
                </span>
                <span>Telegram</span>
              </div>
              <span className="text-[11px] font-medium text-slate-400">вход по коду</span>
            </div>

            {/* Шаг 1: Получение кода */}
            <div className="space-y-2">
              <div className="text-xs text-slate-300">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white text-[10px] font-bold mr-1.5">
                  1
                </span>
                Откройте @{botUsername} — бот пришлёт 6 цифр.
              </div>

              {deepLink ? (
                <a
                  href={deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-lg shadow-brand/25 hover:bg-brand-hover hover:scale-[1.01] transition-all"
                >
                  <Send className="h-3.5 w-3.5 fill-current" />
                  <span>Открыть @{botUsername} в Telegram</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={handleGetTelegramCode}
                  disabled={isRequestingSession}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-lg shadow-brand/25 hover:bg-brand-hover hover:scale-[1.01] transition-all disabled:opacity-50"
                >
                  {isRequestingSession ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <span>Получить код в Telegram</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Шаг 2: Ввод полученного кода */}
            <form onSubmit={handleVerifyCode} className="space-y-2">
              <div className="text-xs text-slate-300">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand text-white text-[10px] font-bold mr-1.5">
                  2
                </span>
                Введи код из сообщения
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={code}
                  onChange={handleCodeChange}
                  placeholder="123 456"
                  disabled={!sessionToken || isVerifying}
                  className="flex-1 rounded-xl bg-dark-input border border-dark-border px-4 py-2.5 text-center font-mono text-base font-bold text-white tracking-widest placeholder-slate-600 focus:border-brand focus:outline-none disabled:opacity-40"
                />
                <button
                  type="submit"
                  disabled={!sessionToken || code.replace(/\s+/g, '').length !== 6 || isVerifying}
                  className="flex h-11 items-center justify-center rounded-xl bg-brand px-6 text-xs font-bold text-white shadow-md shadow-brand/20 hover:bg-brand-hover disabled:opacity-40 transition-all"
                >
                  {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Войти'}
                </button>
              </div>

              <p className="text-[11px] text-slate-500 pt-1">
                Код живёт 5 минут. Можно также отправить команду <code className="text-brand font-mono font-bold">/code</code> прямо в боте.
              </p>

              {pollStatus === 'polling' && (
                <div className="flex items-center gap-2 rounded-lg bg-dark-surface p-2 text-[11px] text-slate-300 border border-dark-border">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
                  <span>Ожидаем подтверждения в боте (или введите код выше)...</span>
                </div>
              )}
            </form>
          </div>

          {/* Сообщения об ошибке / успехе */}
          {errorMessage && (
            <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-xs text-rose-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Разделитель "или по почте" как на скриншоте */}
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-dark-border" />
            </div>
            <span className="relative bg-dark-card px-3 text-[11px] uppercase tracking-wider text-slate-500">
              или по почте
            </span>
          </div>

          {/* Email / Password fallback форма (как на скриншоте) */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              alert('Авторизация по почте доступна после привязки email в Telegram боте.');
            }}
            className="space-y-3"
          >
            <div>
              <label className="block text-[11px] uppercase font-semibold text-slate-400 mb-1">
                Почта
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@mail.ru"
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:border-brand focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] uppercase font-semibold text-slate-400 mb-1">
                Пароль
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between text-xs pt-1">
              <label className="flex items-center gap-2 text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="rounded border-dark-border bg-dark-input text-brand focus:ring-0"
                />
                <span>Запомнить</span>
              </label>

              <button
                type="button"
                onClick={() => alert('Для восстановления пароля откройте Telegram бот.')}
                className="text-slate-400 hover:text-white transition-colors"
              >
                Забыл пароль?
              </button>
            </div>

            <button
              type="submit"
              className="flex h-11 w-full items-center justify-center rounded-xl bg-brand font-bold text-xs text-white shadow-md shadow-brand/20 hover:bg-brand-hover transition-all"
            >
              Войти
            </button>
          </form>
        </div>

        {/* Безопасность */}
        <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          <span>Защищено Cloudflare WAF и сквозным 256-bit шифрованием</span>
        </div>
      </div>
    </div>
  );
}

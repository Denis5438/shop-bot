'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

const ToastContext = createContext(null);

const TYPE_STYLES = {
  success: {
    container: 'border-emerald-500/35 bg-[#0F1A1D]/95 shadow-emerald-950/50',
    iconWrap: 'bg-emerald-500/15 text-emerald-400',
    Icon: CheckCircle2,
  },
  error: {
    container: 'border-rose-500/35 bg-[#1B1118]/95 shadow-rose-950/50',
    iconWrap: 'bg-rose-500/15 text-rose-400',
    Icon: AlertCircle,
  },
  warning: {
    container: 'border-amber-500/35 bg-[#1B1710]/95 shadow-amber-950/50',
    iconWrap: 'bg-amber-500/15 text-amber-400',
    Icon: AlertTriangle,
  },
  info: {
    container: 'border-blue-500/35 bg-[#101726]/95 shadow-blue-950/50',
    iconWrap: 'bg-blue-500/15 text-blue-400',
    Icon: Info,
  },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message, type = 'info', duration = 4200) => {
      if (!message) return null;
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const normalizedType = TYPE_STYLES[type] ? type : 'info';

      setToasts((prev) => [...prev.slice(-4), { id, message: String(message), type: normalizedType }]);

      if (duration > 0) {
        const timer = setTimeout(() => {
          removeToast(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [removeToast]
  );

  const api = useMemo(
    () => ({
      show,
      toast: show,
      success: (msg, duration) => show(msg, 'success', duration),
      error: (msg, duration) => show(msg, 'error', duration),
      warning: (msg, duration) => show(msg, 'warning', duration),
      info: (msg, duration) => show(msg, 'info', duration),
      removeToast,
    }),
    [show, removeToast]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* Контейнер всплывающих уведомлений в правом нижнем углу */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-24 right-5 z-[100] flex w-[calc(100vw-2.5rem)] max-w-sm flex-col gap-2.5"
      >
        {toasts.map((item) => {
          const style = TYPE_STYLES[item.type] || TYPE_STYLES.info;
          const IconComponent = style.Icon;

          return (
            <div
              key={item.id}
              role="status"
              className={`pointer-events-auto animate-toast-in flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md ${style.container}`}
            >
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${style.iconWrap}`}>
                <IconComponent className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-xs font-medium leading-relaxed text-slate-100 break-words">
                {item.message}
              </div>
              <button
                type="button"
                onClick={() => removeToast(item.id)}
                className="mt-0.5 shrink-0 rounded-lg p-1 text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
                aria-label="Закрыть уведомление"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

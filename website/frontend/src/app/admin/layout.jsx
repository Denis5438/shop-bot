'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shield, ArrowLeft, Loader2, Crown } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function AdminLayout({ children }) {
  const router = useRouter();
  const { user, isAdmin, isSuperAdmin, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) {
      router.replace('/');
    }
  }, [user, isAdmin, isLoading, router]);

  if (isLoading || !isAdmin) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
      {/* Шапка админ-панели */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-5 border-b border-dark-border">
        <div className="flex items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand/15 text-brand border border-brand/30 shadow-lg shadow-brand/10">
            <Shield className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-white tracking-tight">Панель управления</h1>
              <span
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                  isSuperAdmin
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                }`}
              >
                {isSuperAdmin && <Crown className="h-3 w-3" />}
                {isSuperAdmin ? 'SuperAdmin' : 'Admin'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Управление витриной, ключами, заказами, пользователями, поставщиками и платежами сайта
            </p>
          </div>
        </div>

        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl bg-dark-card border border-dark-border px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white hover:border-slate-500 transition-all"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>На витрину</span>
        </Link>
      </div>

      <div>{children}</div>
    </div>
  );
}

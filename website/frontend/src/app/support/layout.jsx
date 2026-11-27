'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Headphones, ArrowLeft, Loader2, Crown, Shield, Wrench } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const STAFF_ROLES = ['support', 'moderator', 'admin', 'superadmin'];

const ROLE_META = {
  superadmin: {
    label: 'SuperAdmin',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    Icon: Crown,
  },
  admin: {
    label: 'Admin',
    cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    Icon: Wrench,
  },
  moderator: {
    label: 'Модератор',
    cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    Icon: Shield,
  },
  support: {
    label: 'Саппорт',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    Icon: Headphones,
  },
};

export default function SupportLayout({ children }) {
  const router = useRouter();
  const auth = useAuth();
  const { user, isLoading } = auth;
  const isSupport = auth.isSupport ?? STAFF_ROLES.includes(user?.role);

  useEffect(() => {
    if (!isLoading && (!user || !isSupport)) {
      router.replace('/');
    }
  }, [user, isSupport, isLoading, router]);

  if (isLoading || !isSupport) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  const roleInfo = ROLE_META[user?.role] || ROLE_META.support;
  const RoleIcon = roleInfo.Icon;

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-5 border-b border-dark-border">
        <div className="flex items-center gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand/15 text-brand border border-brand/30 shadow-lg shadow-brand/10">
            <Headphones className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-white tracking-tight">Панель поддержки</h1>
              <span
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${roleInfo.cls}`}
              >
                <RoleIcon className="h-3 w-3" />
                {roleInfo.label}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Обращения покупателей TIG MARKET, эскалации и управление сменой
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

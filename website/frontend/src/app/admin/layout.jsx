'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shield, Package, Key, ShoppingCart, Users, ArrowLeft, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export default function AdminLayout({ children }) {
  const router = useRouter();
  const { user, isAdmin, isLoading } = useAuth();

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
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Шапка админ-панели */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-dark-border">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/15 text-brand border border-brand/30">
            <Shield className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Панель управления магазином</h1>
            <p className="text-xs text-slate-400">Управление товарами, ключами, заказами и пользователями</p>
          </div>
        </div>

        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl bg-dark-card border border-dark-border px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Вернуться на витрину</span>
        </Link>
      </div>

      <div>{children}</div>
    </div>
  );
}

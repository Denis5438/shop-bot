'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ShoppingBag, User, LogOut, Shield, Plus, Menu, X, Zap, Send } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';

export default function Header() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const { cart, toggleCart } = useCart();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-dark-border bg-dark-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Логотип и навигация */}
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 font-bold text-xl text-white tracking-wide shrink-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-brand to-orange-400 text-white shadow-lg shadow-brand/25">
              <Zap className="h-5 w-5 fill-current" />
            </span>
            <span className="bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
              ShopBot
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            <Link href="/" className="hover:text-white transition-colors">
              Каталог
            </Link>
            <Link href="/topup" className="hover:text-white transition-colors">
              Пополнить баланс
            </Link>
            <Link href="/orders" className="hover:text-white transition-colors">
              Мои заказы
            </Link>
            {isAdmin && (
              <Link
                href="/admin"
                className="flex items-center gap-1.5 rounded-lg bg-brand/10 border border-brand/25 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/20 transition-colors"
              >
                <Shield className="h-3.5 w-3.5" />
                <span>Админ-панель</span>
              </Link>
            )}
          </nav>
        </div>

        {/* Правая панель */}
        <div className="flex items-center gap-2.5 sm:gap-3">
          {isAuthenticated ? (
            <>
              <Link
                href="/topup"
                className="hidden sm:flex items-center gap-2 rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand/40 transition-all"
                title="Пополнить баланс"
              >
                <span className="text-slate-400">Баланс:</span>
                <span className="text-emerald-400 font-mono text-sm tabular-nums whitespace-nowrap">
                  {Number(user.balance || 0).toFixed(2)} USDT
                </span>
                <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-brand/20 text-brand">
                  <Plus className="h-3 w-3" />
                </span>
              </Link>

              <button
                type="button"
                onClick={toggleCart}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-200 hover:border-brand/50 hover:text-white transition-all"
                aria-label="Корзина"
              >
                <ShoppingBag className="h-5 w-5" />
                {cart.totalCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold text-white shadow-md shadow-brand/40 tabular-nums">
                    {cart.totalCount}
                  </span>
                )}
              </button>

              <div className="flex items-center gap-2">
                <Link
                  href="/orders"
                  className="flex items-center gap-2 rounded-xl bg-dark-card border border-dark-border px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-600 transition-all"
                >
                  <User className="h-4 w-4 text-brand" />
                  <span className="hidden sm:inline font-mono">
                    {user.username ? `@${user.username}` : user.telegramId}
                  </span>
                </Link>

                <button
                  type="button"
                  onClick={logout}
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-400 hover:text-rose-400 hover:border-rose-500/40 transition-all"
                  title="Выйти"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : (
            <Link
              href="/auth/signin"
              className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-brand/25 hover:bg-brand-hover transition-all whitespace-nowrap"
            >
              <Send className="h-3.5 w-3.5 fill-current" />
              <span>Войти через Telegram</span>
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden flex h-10 w-10 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300"
            aria-label="Меню"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden border-b border-dark-border bg-dark-bg px-4 py-4 space-y-3">
          {isAuthenticated && (
            <div className="flex items-center justify-between rounded-xl bg-dark-card border border-dark-border px-3 py-2 text-xs">
              <span className="text-slate-400">Баланс:</span>
              <span className="font-mono font-bold text-emerald-400 tabular-nums">
                {Number(user?.balance || 0).toFixed(2)} USDT
              </span>
            </div>
          )}
          <Link
            href="/"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-sm font-medium text-slate-300 hover:text-white"
          >
            Каталог товаров
          </Link>
          <Link
            href="/topup"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-sm font-medium text-slate-300 hover:text-white"
          >
            Пополнить баланс
          </Link>
          <Link
            href="/orders"
            onClick={() => setMobileMenuOpen(false)}
            className="block text-sm font-medium text-slate-300 hover:text-white"
          >
            Мои заказы
          </Link>
          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setMobileMenuOpen(false)}
              className="block text-sm font-semibold text-brand hover:text-brand-hover"
            >
              Админ-панель
            </Link>
          )}
        </div>
      )}
    </header>
  );
}

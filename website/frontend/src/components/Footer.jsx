import React from 'react';
import Link from 'next/link';
import { ShieldCheck, Zap, Lock } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="mt-20 border-t border-dark-border bg-dark-bg/60 py-12 text-slate-400 text-xs">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Бренд */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-bold text-white text-base">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white">
                <Zap className="h-4 w-4 fill-current" />
              </span>
              TIG MARKET Web Platform
            </div>
            <p className="text-slate-400 leading-relaxed">
              Независимая цифровая витрина с моментальной выдачей лицензий и аккаунтов.
              Безопасные платежи в USDT и СБП без ограничений.
            </p>
          </div>

          {/* Навигация */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Навигация</h4>
            <ul className="space-y-2">
              <li>
                <Link href="/" className="hover:text-white transition-colors">
                  Каталог товаров
                </Link>
              </li>
              <li>
                <Link href="/topup" className="hover:text-white transition-colors">
                  Пополнение баланса
                </Link>
              </li>
              <li>
                <Link href="/orders" className="hover:text-white transition-colors">
                  История заказов
                </Link>
              </li>
              <li>
                <Link href="/auth/signin" className="hover:text-white transition-colors">
                  Вход через Telegram
                </Link>
              </li>
            </ul>
          </div>

          {/* Платёжные каналы */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Платёжные каналы</h4>
            <ul className="space-y-2">
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Bybit UID (0% комиссии)
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                СБП QR-код (Рубли)
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                USDT TRC20 / BEP20
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                TON & Telegram WebApp
              </li>
            </ul>
          </div>

          {/* Безопасность */}
          <div>
            <h4 className="font-semibold text-white mb-3 text-sm">Гарантия & Безопасность</h4>
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-slate-300">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <span>Защита сделок и гарантия замены</span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <Zap className="h-4 w-4 text-brand" />
                <span>Мгновенная выдача за 1 секунду</span>
              </div>
              <div className="flex items-center gap-2 text-slate-300">
                <Lock className="h-4 w-4 text-blue-400" />
                <span>Cloudflare DDoS & SSL защита</span>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-dark-border/60 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-slate-500">
          <p>© {new Date().getFullYear()} TIG MARKET. Все права защищены. Работает независимо от правил мессенджеров.</p>
          <div className="flex items-center gap-4">
            <span>Безопасный вход через 6-значный код</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard,
  Package,
  FolderTree,
  KeyRound,
  ShoppingCart,
  Users,
  TicketPercent,
  PlugZap,
  Wallet,
  Layers,
  Settings,
} from 'lucide-react';
import { adminApi } from '../../lib/api';
import AdminOverview from '../../components/admin/AdminOverview';
import AdminProducts from '../../components/admin/AdminProducts';
import AdminCategories from '../../components/admin/AdminCategories';
import AdminKeys from '../../components/admin/AdminKeys';
import AdminOrders from '../../components/admin/AdminOrders';
import AdminUsers from '../../components/admin/AdminUsers';
import AdminPromos from '../../components/admin/AdminPromos';
import AdminSuppliers from '../../components/admin/AdminSuppliers';
import AdminRequests from '../../components/admin/AdminRequests';
import AdminBulk from '../../components/admin/AdminBulk';
import AdminSettings from '../../components/admin/AdminSettings';

const TABS = [
  { id: 'overview', label: 'Обзор', Icon: LayoutDashboard },
  { id: 'products', label: 'Товары', Icon: Package },
  { id: 'categories', label: 'Категории', Icon: FolderTree },
  { id: 'keys', label: 'Ключи', Icon: KeyRound },
  { id: 'orders', label: 'Заказы', Icon: ShoppingCart },
  { id: 'users', label: 'Пользователи', Icon: Users },
  { id: 'promos', label: 'Промокоды', Icon: TicketPercent },
  { id: 'suppliers', label: 'Поставщики', Icon: PlugZap },
  { id: 'requests', label: 'Заявки и выводы', Icon: Wallet },
  { id: 'bulk', label: 'Массовые', Icon: Layers },
  { id: 'settings', label: 'Настройки', Icon: Settings },
];

export default function AdminDashboardPage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [ordersInitialFilter, setOrdersInitialFilter] = useState('all');
  const [requestsInitialTab, setRequestsInitialTab] = useState('topups');
  const [badges, setBadges] = useState({
    orders: 0,
    requests: 0,
  });

  const refreshBadges = useCallback(async () => {
    try {
      const res = await adminApi.getStats('month');
      if (res?.success && res.stats) {
        const s = res.stats;
        setBadges({
          orders: (s.pendingOrders || 0) + (s.disputedOrders || 0) + (s.pendingWarranties || 0),
          requests: (s.pendingTopups || 0) + (s.pendingWithdrawals || 0),
        });
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshBadges();
  }, [refreshBadges]);

  const handleNavigate = (tabId, option = null) => {
    if (tabId === 'orders' && option) {
      setOrdersInitialFilter(option);
    }
    if (tabId === 'requests' && option) {
      setRequestsInitialTab(option);
    }
    setActiveTab(tabId);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Боковое меню на десктопе / Горизонтальные вкладки на мобильных */}
      <aside className="lg:w-60 shrink-0">
        <nav className="flex lg:flex-col gap-1.5 overflow-x-auto no-scrollbar pb-2 lg:pb-0 lg:sticky lg:top-24 rounded-2xl lg:bg-dark-card lg:border lg:border-dark-border lg:p-2.5">
          {TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            const badgeCount = id === 'orders' ? badges.orders : id === 'requests' ? badges.requests : 0;

            return (
              <button
                key={id}
                type="button"
                onClick={() => handleNavigate(id)}
                className={`flex shrink-0 items-center justify-between gap-2.5 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition-all ${
                  active
                    ? 'bg-brand text-white shadow-md shadow-brand/25'
                    : 'bg-dark-card lg:bg-transparent border border-dark-border lg:border-transparent text-slate-300 hover:bg-dark-surface hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                </span>
                {badgeCount > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                      active ? 'bg-white/20 text-white' : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Контент активного раздела */}
      <section className="min-w-0 flex-1">
        {activeTab === 'overview' && <AdminOverview onNavigate={handleNavigate} />}
        {activeTab === 'products' && <AdminProducts />}
        {activeTab === 'categories' && <AdminCategories />}
        {activeTab === 'keys' && <AdminKeys />}
        {activeTab === 'orders' && (
          <AdminOrders initialFilter={ordersInitialFilter} onUpdated={refreshBadges} />
        )}
        {activeTab === 'users' && <AdminUsers />}
        {activeTab === 'promos' && <AdminPromos />}
        {activeTab === 'suppliers' && <AdminSuppliers />}
        {activeTab === 'requests' && (
          <AdminRequests initialSubTab={requestsInitialTab} onUpdated={refreshBadges} />
        )}
        {activeTab === 'bulk' && <AdminBulk />}
        {activeTab === 'settings' && <AdminSettings />}
      </section>
    </div>
  );
}

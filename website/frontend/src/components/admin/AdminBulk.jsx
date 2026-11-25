'use client';

import React, { useState } from 'react';
import { Eye, EyeOff, ShieldAlert, Wallet, AlertTriangle, X, Crown } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

export default function AdminBulk() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();

  const [warrantyDays, setWarrantyDays] = useState('5');
  const [grantAmount, setGrantAmount] = useState('1');
  const [confirmModal, setConfirmModal] = useState(null);
  const [executing, setExecuting] = useState(false);

  const openConfirm = (opConfig) => {
    setConfirmModal(opConfig);
  };

  const executeOperation = async () => {
    if (!confirmModal) return;
    try {
      setExecuting(true);
      const res = await adminApi.runBulk({
        action: confirmModal.operation,
        confirm: true,
        ...(confirmModal.extra || {}),
      });
      toast.success(res.message || `Операция выполнена (затронуто записей: ${res.affectedCount ?? 0})`);
      setConfirmModal(null);
    } catch (err) {
      toast.error(err.message || 'Ошибка выполнения массовой операции');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Массовые операции</h2>
        <p className="text-xs text-slate-400">
          Безопасное пакетное управление каталогом, гарантией и балансами пользователей с подтверждением
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Видимость товаров и категорий */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <h3 className="text-sm font-bold text-white">Видимость каталога</h3>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() =>
                openConfirm({
                  operation: 'hide_products',
                  title: 'Скрыть все товары?',
                  description: 'Все товары станут неактивными (isActive: false) на витрине и в боте.',
                  danger: true,
                })
              }
              className="flex items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border py-2.5 font-semibold text-slate-200 hover:border-amber-500/50"
            >
              <EyeOff className="h-4 w-4 text-amber-400" />
              <span>Скрыть все товары</span>
            </button>

            <button
              type="button"
              onClick={() =>
                openConfirm({
                  operation: 'show_products',
                  title: 'Показать все товары?',
                  description: 'Все товары станут активными (isActive: true).',
                })
              }
              className="flex items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border py-2.5 font-semibold text-slate-200 hover:border-emerald-500/50"
            >
              <Eye className="h-4 w-4 text-emerald-400" />
              <span>Показать все товары</span>
            </button>

            <button
              type="button"
              onClick={() =>
                openConfirm({
                  operation: 'hide_categories',
                  title: 'Скрыть все категории?',
                  description: 'Все категории будут скрыты с витрины.',
                  danger: true,
                })
              }
              className="flex items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border py-2.5 font-semibold text-slate-200 hover:border-amber-500/50"
            >
              <EyeOff className="h-4 w-4 text-amber-400" />
              <span>Скрыть категории</span>
            </button>

            <button
              type="button"
              onClick={() =>
                openConfirm({
                  operation: 'show_categories',
                  title: 'Показать все категории?',
                  description: 'Все категории станут активными на витрине.',
                })
              }
              className="flex items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border py-2.5 font-semibold text-slate-200 hover:border-emerald-500/50"
            >
              <Eye className="h-4 w-4 text-emerald-400" />
              <span>Показать категории</span>
            </button>
          </div>
        </div>

        {/* Гарантия заказов */}
        <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-sky-400" />
            <span>Массовое управление гарантией</span>
          </h3>

          <div className="flex items-end gap-2.5">
            <div className="flex-1">
              <label className="block text-slate-400 mb-1">Добавить дней гарантии ко всем заказам:</label>
              <input
                type="number"
                min="1"
                value={warrantyDays}
                onChange={(e) => setWarrantyDays(e.target.value)}
                className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const days = parseInt(warrantyDays, 10) || 0;
                if (days <= 0) return toast.error('Укажите положительное число дней');
                openConfirm({
                  operation: 'add_warranty',
                  title: `Добавить +${days} дн. гарантии?`,
                  description: `Срок гарантии всех заказов в базе будет увеличен на ${days} дней.`,
                  extra: { days },
                });
              }}
              className="rounded-xl bg-sky-500 px-4 py-2 font-bold text-white hover:bg-sky-600"
            >
              Добавить
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              openConfirm({
                operation: 'reset_warranty',
                title: 'Обнулить гарантию всех заказов?',
                description: 'У всех заказов значение warrantyDays станет равно 0.',
                danger: true,
              })
            }
            className="w-full rounded-xl bg-rose-500/10 border border-rose-500/30 py-2 font-bold text-rose-400 hover:bg-rose-500/20"
          >
            Обнулить гарантию у всех заказов
          </button>
        </div>

        {/* Балансы пользователей (SuperAdmin only) */}
        <div className="md:col-span-2 rounded-2xl bg-dark-card border border-amber-500/30 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Wallet className="h-4 w-4 text-amber-400" />
              <span>Массовые операции с балансами пользователей</span>
            </h3>
            <span className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 text-[10px] font-bold text-amber-300">
              <Crown className="h-3 w-3" />
              Только SuperAdmin
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div className="flex items-end gap-2.5">
              <div className="flex-1">
                <label className="block text-slate-400 mb-1">Начислить бонус всем активным пользователям (USDT):</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  disabled={!isSuperAdmin}
                  value={grantAmount}
                  onChange={(e) => setGrantAmount(e.target.value)}
                  className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 font-mono text-white disabled:opacity-40"
                />
              </div>
              <button
                type="button"
                disabled={!isSuperAdmin}
                onClick={() => {
                  const amount = parseFloat(grantAmount);
                  if (isNaN(amount) || amount <= 0) return toast.error('Укажите положительную сумму');
                  openConfirm({
                    operation: 'grant_balance',
                    title: `Начислить +${amount} USDT всем пользователям?`,
                    description: `Каждому незаблокированному пользователю будет начислено ${amount} USDT с записью в Transaction.`,
                    extra: { amount },
                    danger: true,
                  });
                }}
                className="rounded-xl bg-emerald-500 px-4 py-2 font-bold text-black hover:bg-emerald-400 disabled:opacity-40"
              >
                Начислить всем
              </button>
            </div>

            <button
              type="button"
              disabled={!isSuperAdmin}
              onClick={() =>
                openConfirm({
                  operation: 'reset_balances',
                  title: 'ОБНУЛИТЬ балансы ВСЕХ пользователей?',
                  description: 'Необратимая операция! Все положительные балансы пользователей станут равны 0.00 USDT.',
                  danger: true,
                })
              }
              className="rounded-xl bg-rose-500/15 border border-rose-500/40 py-2 font-bold text-rose-400 hover:bg-rose-500/25 disabled:opacity-40"
            >
              Обнулить все балансы до 0.00 USDT
            </button>
          </div>
        </div>
      </div>

      {/* Модальное окно подтверждения */}
      {confirmModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => !executing && setConfirmModal(null)}
        >
          <div
            className={`w-full max-w-md rounded-3xl bg-dark-card border p-6 shadow-2xl space-y-4 ${
              confirmModal.danger ? 'border-rose-500/40' : 'border-dark-border'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className={`h-5 w-5 ${confirmModal.danger ? 'text-rose-400' : 'text-amber-400'}`} />
                <h3 className="text-base font-bold text-white">{confirmModal.title}</h3>
              </div>
              <button
                type="button"
                disabled={executing}
                onClick={() => setConfirmModal(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">{confirmModal.description}</p>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={executing}
                onClick={() => setConfirmModal(null)}
                className="rounded-xl bg-dark-surface border border-dark-border px-4 py-2 text-xs font-semibold text-slate-300"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={executing}
                onClick={executeOperation}
                className={`rounded-xl px-5 py-2 text-xs font-bold text-white disabled:opacity-50 ${
                  confirmModal.danger ? 'bg-rose-500 hover:bg-rose-600' : 'bg-brand hover:bg-brand-hover'
                }`}
              >
                {executing ? 'Выполнение...' : 'Подтвердить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

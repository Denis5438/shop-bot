'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Zap,
  Sparkles,
  X,
  Grid,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ShoppingBag,
  ArrowRight,
  Clock,
  Check,
  Calendar,
} from 'lucide-react';
import { catalogApi } from '../lib/api';
import ProductCard from '../components/ProductCard';
import BrandIcon from '../components/BrandIcon';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const PAGE_LIMIT = 24;

export default function StorefrontPage() {
  const { addToCart } = useCart();
  const { isAdmin } = useAuth();

  // Мета-данные магазина (живой курс и режим обслуживания)
  const [rubRate, setRubRate] = useState(92.5);
  const [webMaintenanceMode, setWebMaintenanceMode] = useState(false);

  // Категории и модальное окно всех категорий
  const [categories, setCategories] = useState([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [categoriesModalOpen, setCategoriesModalOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');

  // Фильтры, поиск и пагинация товаров
  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_LIMIT, total: 0, pages: 1 });
  const [currentPage, setCurrentPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [productType, setProductType] = useState('all'); // 'all' | 'key' | 'gpt_activation' | 'manual'
  const [sortBy, setSortBy] = useState('sortOrder');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Модальное окно товара
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [modalQty, setModalQty] = useState(1);
  const [isModalBusy, setIsModalBusy] = useState(false);

  // Debounce поиска
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Первичная загрузка мета-данных и категорий
  useEffect(() => {
    async function loadMetaAndCategories() {
      try {
        const [metaRes, catsRes] = await Promise.all([
          catalogApi.getMeta().catch(() => null),
          catalogApi.getCategories().catch(() => null),
        ]);

        if (metaRes?.success) {
          if (metaRes.currentRateRub) setRubRate(Number(metaRes.currentRateRub));
          setWebMaintenanceMode(Boolean(metaRes.webMaintenanceMode));
        }

        if (catsRes?.success) {
          setCategories(catsRes.categories || []);
          setTotalProducts(catsRes.totalProducts || 0);
        }
      } catch (err) {
        console.error('Ошибка загрузки мета-данных:', err);
      }
    }

    loadMetaAndCategories();
  }, []);

  // Загрузка товаров с серверной фильтрацией и пагинацией
  useEffect(() => {
    let cancelled = false;

    async function loadProducts() {
      try {
        setIsLoading(true);
        const res = await catalogApi.getProducts({
          categoryId: selectedCategory,
          search: debouncedSearch,
          type: productType,
          inStock: inStockOnly,
          sort: sortBy,
          page: currentPage,
          limit: PAGE_LIMIT,
        });

        if (!cancelled && res.success) {
          setProducts(res.products || []);
          if (res.pagination) {
            setPagination(res.pagination);
          } else {
            const count = (res.products || []).length;
            setPagination({ page: 1, limit: PAGE_LIMIT, total: count, pages: 1 });
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Ошибка загрузки товаров:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadProducts();
    return () => {
      cancelled = true;
    };
  }, [selectedCategory, debouncedSearch, productType, inStockOnly, sortBy, currentPage]);

  // Топ-12 категорий (плюс активная категория, если она за пределами топ-12)
  const topCategories = useMemo(() => categories.slice(0, 12), [categories]);
  const selectedCatObj = useMemo(
    () => categories.find((c) => String(c.id) === String(selectedCategory)) || null,
    [categories, selectedCategory]
  );
  const selectedIsOutsideTop =
    selectedCatObj && !topCategories.some((c) => String(c.id) === String(selectedCatObj.id));

  const filteredModalCategories = useMemo(() => {
    const q = categorySearch.toLowerCase().trim();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, categorySearch]);

  const handleSelectCategory = (catId) => {
    setSelectedCategory(catId);
    setCurrentPage(1);
  };

  const handleOpenProduct = (product) => {
    setSelectedProduct(product);
    setModalQty(1);
  };

  const handleModalAction = async (openDrawer) => {
    if (!selectedProduct) return;
    setIsModalBusy(true);
    const ok = await addToCart(selectedProduct.id, modalQty, { openDrawer });
    setIsModalBusy(false);
    if (ok) {
      setSelectedProduct(null);
    }
  };

  // Номера страниц для пагинации
  const pageNumbers = useMemo(() => {
    const total = Math.max(1, pagination.pages || 1);
    const curr = currentPage;
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const items = [1];
    if (curr > 3) items.push('...');
    const start = Math.max(2, curr - 1);
    const end = Math.min(total - 1, curr + 1);
    for (let i = start; i <= end; i += 1) {
      items.push(i);
    }
    if (curr < total - 2) items.push('...');
    items.push(total);
    return items;
  }, [pagination.pages, currentPage]);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">
      {/* Баннер технического обслуживания */}
      {webMaintenanceMode && !isAdmin && (
        <div className="flex items-start sm:items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs sm:text-sm text-amber-200 shadow-lg">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5 sm:mt-0" />
          <div>
            <span className="font-bold text-amber-300">Ведутся технические работы.</span>{' '}
            <span>Оформление заказов и пополнение баланса на сайте временно приостановлены. Каталог доступен в режиме просмотра.</span>
          </div>
        </div>
      )}

      {webMaintenanceMode && isAdmin && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <span>Режим обслуживания на сайте включён (вы видите витрину как администратор).</span>
          </div>
          <a href="/admin" className="font-semibold underline hover:text-white">
            Настройки
          </a>
        </div>
      )}

      {/* 1. Hero баннер */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-dark-card via-dark-surface to-dark-card border border-dark-border p-6 sm:p-8 md:p-10 shadow-2xl">
        <div className="relative z-10 max-w-2xl space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand/15 border border-brand/30 px-3 py-1 text-xs font-semibold text-brand">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Автоматическая выдача за 1 секунду • Курс 1 USDT = {rubRate.toFixed(2)} ₽</span>
          </div>

          <h1 className="text-2xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight leading-tight">
            Цифровые товары, подписки и ключи
          </h1>

          <p className="text-slate-400 text-sm sm:text-base leading-relaxed">
            Мгновенная доставка лицензий и AI-подписок. Прямая оплата через Bybit UID (0%), СБП и криптовалюту без посредников.
          </p>

          {/* Поиск */}
          <div className="pt-1 flex items-center gap-2 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Поиск по 285+ товарам (ChatGPT, Claude, Spotify, VPN)..."
                className="w-full rounded-2xl bg-dark-bg/90 border border-dark-border py-3 pl-10 pr-9 text-sm text-white placeholder-slate-500 focus:border-brand focus:outline-none shadow-inner"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  aria-label="Очистить поиск"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="absolute -right-10 -bottom-10 h-72 w-72 rounded-full bg-brand/10 blur-3xl pointer-events-none" />
      </div>

      {/* 2. Топ-12 Категорий + Кнопка "Все категории" */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleSelectCategory('all')}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
              selectedCategory === 'all'
                ? 'bg-brand text-white shadow-lg shadow-brand/25'
                : 'bg-dark-card border border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
            }`}
          >
            <Grid className="h-3.5 w-3.5" />
            <span>Все товары</span>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${
                selectedCategory === 'all' ? 'bg-white/20 text-white' : 'bg-dark-surface text-slate-400'
              }`}
            >
              {totalProducts}
            </span>
          </button>

          {selectedIsOutsideTop && selectedCatObj && (
            <button
              type="button"
              onClick={() => handleSelectCategory(selectedCatObj.id)}
              className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold bg-brand text-white shadow-lg shadow-brand/25 transition-all"
            >
              <BrandIcon size={16} name={selectedCatObj.name} />
              <span>{selectedCatObj.name}</span>
              <span className="rounded-md px-1.5 py-0.5 text-[10px] tabular-nums bg-white/20 text-white">
                {selectedCatObj.productCount}
              </span>
            </button>
          )}

          {topCategories.map((cat) => {
            const active = String(selectedCategory) === String(cat.id);
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleSelectCategory(cat.id)}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                  active
                    ? 'bg-brand text-white shadow-lg shadow-brand/25'
                    : 'bg-dark-card border border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
                }`}
              >
                <BrandIcon size={16} name={cat.name} />
                <span className="max-w-[140px] truncate">{cat.name}</span>
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-dark-surface text-slate-400'
                  }`}
                >
                  {cat.productCount}
                </span>
              </button>
            );
          })}

          {categories.length > 12 && (
            <button
              type="button"
              onClick={() => {
                setCategorySearch('');
                setCategoriesModalOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-dark-surface border border-brand/35 px-3.5 py-2 text-xs font-bold text-brand hover:bg-brand/10 transition-all"
            >
              <Grid className="h-3.5 w-3.5" />
              <span>Все категории ({categories.length})</span>
            </button>
          )}
        </div>

        {/* Панель фильтров и сортировки */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-dark-border/50 text-xs">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <span className="text-slate-400 font-medium">
              Найдено: <span className="text-white font-bold tabular-nums">{pagination.total || products.length}</span>
            </span>

            <label className="flex items-center gap-2 text-slate-300 cursor-pointer hover:text-white transition-colors select-none">
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(e) => {
                  setInStockOnly(e.target.checked);
                  setCurrentPage(1);
                }}
                className="h-3.5 w-3.5 rounded border-dark-border bg-dark-input text-brand focus:ring-0"
              />
              <span>Только в наличии</span>
            </label>

            {/* Фильтр по типу выдачи */}
            <div className="flex items-center gap-1 rounded-xl bg-dark-card border border-dark-border p-1">
              {[
                { key: 'all', label: 'Все' },
                { key: 'key', label: 'Автовыдача' },
                { key: 'gpt_activation', label: 'Активация' },
                { key: 'manual', label: 'Ручная' },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setProductType(item.key);
                    setCurrentPage(1);
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all ${
                    productType === item.key
                      ? 'bg-dark-surface text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value);
                setCurrentPage(1);
              }}
              className="rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-200 focus:border-brand focus:outline-none"
            >
              <option value="sortOrder">По умолчанию</option>
              <option value="price_asc">Сначала дешевле</option>
              <option value="price_desc">Сначала дороже</option>
              <option value="newest">Новинки</option>
              <option value="popular">Популярные</option>
            </select>
          </div>
        </div>
      </div>

      {/* 3. Сетка товаров */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-64 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-3xl bg-dark-card border border-dark-border py-20 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-dark-surface border border-dark-border text-slate-400">
            <Search className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-bold text-white">Товары не найдены</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Попробуйте изменить поисковый запрос, сбросить фильтры или выбрать другую категорию.
          </p>
          {(selectedCategory !== 'all' || searchInput || inStockOnly || productType !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setSelectedCategory('all');
                setSearchInput('');
                setDebouncedSearch('');
                setInStockOnly(false);
                setProductType('all');
                setCurrentPage(1);
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                rubRate={rubRate}
                onSelect={handleOpenProduct}
              />
            ))}
          </div>

          {/* Пагинация по всем товарам */}
          {pagination.pages > 1 && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-4">
              <button
                type="button"
                onClick={() => {
                  setCurrentPage((p) => Math.max(1, p - 1));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                disabled={currentPage <= 1}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 transition-all"
                aria-label="Предыдущая страница"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              {pageNumbers.map((item, idx) =>
                item === '...' ? (
                  <span key={`dots-${idx}`} className="px-2 text-xs text-slate-500">
                    ...
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setCurrentPage(item);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className={`flex h-9 min-w-[36px] items-center justify-center rounded-xl px-2.5 text-xs font-bold tabular-nums transition-all ${
                      currentPage === item
                        ? 'bg-brand text-white shadow-md shadow-brand/25'
                        : 'bg-dark-card border border-dark-border text-slate-300 hover:border-slate-500 hover:text-white'
                    }`}
                  >
                    {item}
                  </button>
                )
              )}

              <button
                type="button"
                onClick={() => {
                  setCurrentPage((p) => Math.min(pagination.pages, p + 1));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                disabled={currentPage >= pagination.pages}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 transition-all"
                aria-label="Следующая страница"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </>
      )}

      {/* 4. Модальное окно «Все категории» */}
      {categoriesModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setCategoriesModalOpen(false)}
        >
          <div
            className="relative flex max-h-[82vh] w-full max-w-3xl flex-col rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-dark-border">
              <div>
                <h2 className="text-lg font-bold text-white">Все категории ({categories.length})</h2>
                <p className="text-xs text-slate-400">Выберите нужный сервис или бренд</p>
              </div>
              <button
                type="button"
                onClick={() => setCategoriesModalOpen(false)}
                className="rounded-xl p-2 text-slate-400 hover:text-white hover:bg-dark-surface"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative my-4">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="text"
                autoFocus
                value={categorySearch}
                onChange={(e) => setCategorySearch(e.target.value)}
                placeholder="Поиск по категориям..."
                className="w-full rounded-xl bg-dark-input border border-dark-border py-2.5 pl-10 pr-4 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pr-1">
              <button
                type="button"
                onClick={() => {
                  handleSelectCategory('all');
                  setCategoriesModalOpen(false);
                }}
                className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-left text-xs transition-all ${
                  selectedCategory === 'all'
                    ? 'bg-brand/15 border-brand text-white'
                    : 'bg-dark-surface/60 border-dark-border text-slate-200 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/20 text-brand">
                    <Grid className="h-4 w-4" />
                  </span>
                  <span className="font-semibold truncate">Все товары</span>
                </div>
                <span className="shrink-0 rounded-md bg-dark-bg px-2 py-0.5 text-[10px] font-bold text-slate-400 tabular-nums">
                  {totalProducts}
                </span>
              </button>

              {filteredModalCategories.map((cat) => {
                const active = String(selectedCategory) === String(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      handleSelectCategory(cat.id);
                      setCategoriesModalOpen(false);
                    }}
                    className={`flex items-center justify-between gap-2 rounded-xl border p-3 text-left text-xs transition-all ${
                      active
                        ? 'bg-brand/15 border-brand text-white'
                        : 'bg-dark-surface/60 border-dark-border text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <BrandIcon size={28} name={cat.name} rounded="lg" />
                      <span className="font-semibold truncate">{cat.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="rounded-md bg-dark-bg px-2 py-0.5 text-[10px] font-bold text-slate-400 tabular-nums">
                        {cat.productCount}
                      </span>
                      {active && <Check className="h-3.5 w-3.5 text-brand" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 5. Модальное окно детального просмотра товара */}
      {selectedProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setSelectedProduct(null)}
        >
          <div
            className="relative w-full max-w-lg rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSelectedProduct(null)}
              className="absolute right-5 top-5 rounded-xl p-2 text-slate-400 hover:text-white hover:bg-dark-surface"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Заголовок */}
            <div className="flex items-start gap-4 pr-8">
              <BrandIcon
                size={56}
                name={selectedProduct.name}
                categoryName={selectedProduct.category?.name}
                rounded="2xl"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-dark-surface px-2.5 py-0.5 text-[11px] font-semibold text-slate-300 border border-dark-border">
                    <BrandIcon size={14} name={selectedProduct.category?.name || selectedProduct.name} />
                    <span>{selectedProduct.category?.name || 'Товары'}</span>
                  </span>
                  {selectedProduct.flashSale?.enabled && (
                    <span className="rounded-lg bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] font-bold text-rose-400">
                      Flash -{selectedProduct.flashSale.discountPercent}%
                    </span>
                  )}
                </div>
                <h2 className="text-lg sm:text-xl font-bold text-white leading-snug">
                  {selectedProduct.name}
                </h2>
              </div>
            </div>

            {/* Описание */}
            <div className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 text-xs text-slate-300 leading-relaxed max-h-44 overflow-y-auto whitespace-pre-wrap">
              {selectedProduct.description || 'Лицензионный цифровой товар с гарантией качества и быстрой выдачей.'}
            </div>

            {/* Характеристики */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <div className="flex items-center gap-2 rounded-xl bg-dark-surface p-2.5 border border-dark-border text-slate-300">
                <Zap className="h-4 w-4 shrink-0 text-brand" />
                <span className="truncate">
                  {selectedProduct.type === 'key'
                    ? 'Автовыдача'
                    : selectedProduct.type === 'gpt_activation'
                    ? 'Активация'
                    : 'Ручная выдача'}
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-dark-surface p-2.5 border border-dark-border text-slate-300">
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="truncate">Гарантия {selectedProduct.warrantyDays ?? 5} дн.</span>
              </div>
              <div className="col-span-2 sm:col-span-1 flex items-center gap-2 rounded-xl bg-dark-surface p-2.5 border border-dark-border text-slate-300">
                <Calendar className="h-4 w-4 shrink-0 text-sky-400" />
                <span className="truncate">Срок {selectedProduct.subscriptionDays ?? 30} дн.</span>
              </div>
            </div>

            {/* Цена и выбор количества */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-1 border-t border-dark-border/60">
              <div>
                <span className="text-[11px] text-slate-400 block">
                  Итого к оплате ({selectedProduct.inStock ? `в наличии ${selectedProduct.stockCount} шт.` : 'нет в наличии'}):
                </span>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-bold text-white font-mono tabular-nums whitespace-nowrap">
                    {(Number(selectedProduct.effectivePrice || 0) * modalQty).toFixed(2)} USDT
                  </span>
                  {selectedProduct.officialPrice > selectedProduct.effectivePrice && (
                    <span className="text-xs text-slate-500 line-through font-mono tabular-nums">
                      {(Number(selectedProduct.officialPrice) * modalQty).toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  ≈ {Math.round(Number(selectedProduct.effectivePrice || 0) * modalQty * rubRate).toLocaleString('ru-RU')} ₽
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <span className="text-xs text-slate-400">Кол-во:</span>
                <div className="flex items-center rounded-xl bg-dark-surface border border-dark-border text-sm">
                  <button
                    type="button"
                    onClick={() => setModalQty((q) => Math.max(1, q - 1))}
                    disabled={modalQty <= 1}
                    className="px-3 py-1.5 text-slate-300 hover:text-white disabled:opacity-40"
                  >
                    -
                  </button>
                  <span className="w-8 text-center font-bold font-mono tabular-nums text-white">
                    {modalQty}
                  </span>
                  <button
                    type="button"
                    onClick={() => setModalQty((q) => Math.min(Math.max(1, selectedProduct.stockCount), q + 1))}
                    disabled={!selectedProduct.inStock || modalQty >= selectedProduct.stockCount}
                    className="px-3 py-1.5 text-slate-300 hover:text-white disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Кнопки действий */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => handleModalAction(false)}
                disabled={!selectedProduct.inStock || isModalBusy}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border font-bold text-xs text-white hover:border-slate-500 transition-all disabled:opacity-50"
              >
                <ShoppingBag className="h-4 w-4 text-brand" />
                <span>{isModalBusy ? 'Добавление...' : 'Добавить в корзину'}</span>
              </button>

              <button
                type="button"
                onClick={() => handleModalAction(true)}
                disabled={!selectedProduct.inStock || isModalBusy}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-brand font-bold text-xs text-white shadow-lg shadow-brand/30 hover:bg-brand-hover transition-all disabled:opacity-50"
              >
                <span>Купить сейчас</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

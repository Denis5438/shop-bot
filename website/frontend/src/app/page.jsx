'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Search, SlidersHorizontal, ShieldCheck, Zap, Sparkles, X, CheckCircle2 } from 'lucide-react';
import { catalogApi } from '../lib/api';
import ProductCard from '../components/ProductCard';
import { useCart } from '../context/CartContext';

export default function StorefrontPage() {
  const { addToCart } = useCart();

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('sortOrder');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Модальное окно просмотра товара
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [modalQty, setModalQty] = useState(1);
  const [isAddingFromModal, setIsAddingFromModal] = useState(false);

  // Загрузка категорий и товаров
  useEffect(() => {
    async function loadData() {
      try {
        setIsLoading(true);
        const [catsRes, prodsRes] = await Promise.all([
          catalogApi.getCategories(),
          catalogApi.getProducts({ limit: 100 }),
        ]);

        if (catsRes.success) {
          setCategories(catsRes.categories || []);
          setTotalProducts(catsRes.totalProducts || 0);
        }

        if (prodsRes.success) {
          setProducts(prodsRes.products || []);
        }
      } catch (err) {
        console.error('Ошибка загрузки витрины:', err);
      } finally {
        setIsLoading(false);
      }
    }

    loadData();
  }, []);

  // Фильтрация и сортировка товаров на клиенте для мгновенного отклика
  const filteredProducts = useMemo(() => {
    let result = [...products];

    // Фильтр по категории
    if (selectedCategory !== 'all') {
      result = result.filter(
        (p) => p.category?.id?.toString() === selectedCategory.toString()
      );
    }

    // Текстовый поиск
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.nameEn?.toLowerCase().includes(q)
      );
    }

    // Только в наличии
    if (inStockOnly) {
      result = result.filter((p) => p.inStock && p.stockCount > 0);
    }

    // Сортировка
    if (sortBy === 'price_asc') {
      result.sort((a, b) => a.effectivePrice - b.effectivePrice);
    } else if (sortBy === 'price_desc') {
      result.sort((a, b) => b.effectivePrice - a.effectivePrice);
    } else if (sortBy === 'newest') {
      result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return result;
  }, [products, selectedCategory, searchQuery, inStockOnly, sortBy]);

  const handleOpenProduct = (product) => {
    setSelectedProduct(product);
    setModalQty(1);
  };

  const handleModalAdd = async () => {
    if (!selectedProduct) return;
    setIsAddingFromModal(true);
    await addToCart(selectedProduct.id, modalQty);
    setIsAddingFromModal(false);
    setSelectedProduct(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* 1. Hero баннер */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-dark-card via-dark-surface to-dark-card border border-dark-border p-8 md:p-12 shadow-2xl">
        <div className="relative z-10 max-w-2xl space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand/15 border border-brand/30 px-3 py-1 text-xs font-semibold text-brand">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Автоматическая выдача за 1 секунду</span>
          </div>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-white tracking-tight leading-tight">
            Цифровые товары, аккаунты и ключи
          </h1>

          <p className="text-slate-400 text-sm sm:text-base leading-relaxed">
            Мгновенная доставка лицензий без ожидания. Прямая оплата через Bybit UID (0%), СБП и криптовалюту без блокировок.
          </p>

          {/* Строка поиска */}
          <div className="pt-2 flex items-center gap-2 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск товара или подписки..."
                className="w-full rounded-2xl bg-dark-bg/90 border border-dark-border py-3 pl-10 pr-4 text-sm text-white placeholder-slate-500 focus:border-brand focus:outline-none shadow-inner"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Фоновый декор */}
        <div className="absolute -right-10 -bottom-10 h-72 w-72 rounded-full bg-brand/10 blur-3xl pointer-events-none" />
      </div>

      {/* 2. Категории (горизонтальная прокрутка табов) */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {/* Таб Все товары */}
          <button
            onClick={() => setSelectedCategory('all')}
            className={`flex shrink-0 items-center gap-2 rounded-2xl px-5 py-2.5 text-xs font-bold transition-all ${
              selectedCategory === 'all'
                ? 'bg-brand text-white shadow-lg shadow-brand/25 scale-[1.02]'
                : 'bg-dark-card border border-dark-border text-slate-400 hover:text-white hover:border-slate-600'
            }`}
          >
            <span>📁</span>
            <span>Все товары</span>
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${selectedCategory === 'all' ? 'bg-white/20 text-white' : 'bg-dark-surface text-slate-400'}`}>
              {totalProducts}
            </span>
          </button>

          {/* Категории из БД */}
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`flex shrink-0 items-center gap-2 rounded-2xl px-5 py-2.5 text-xs font-bold transition-all ${
                selectedCategory === cat.id
                  ? 'bg-brand text-white shadow-lg shadow-brand/25 scale-[1.02]'
                  : 'bg-dark-card border border-dark-border text-slate-400 hover:text-white hover:border-slate-600'
              }`}
            >
              <span>{cat.icon || '📦'}</span>
              <span>{cat.name}</span>
              <span className={`rounded-full px-1.5 py-0.2 text-[10px] ${selectedCategory === cat.id ? 'bg-white/20 text-white' : 'bg-dark-surface text-slate-400'}`}>
                {cat.productCount}
              </span>
            </button>
          ))}
        </div>

        {/* Панель фильтров и сортировки */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-dark-border/40 text-xs">
          <div className="flex items-center gap-4">
            <span className="text-slate-500 font-medium">
              Найдено: <span className="text-white font-bold">{filteredProducts.length}</span>
            </span>

            <label className="flex items-center gap-2 text-slate-400 cursor-pointer hover:text-white transition-colors">
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(e) => setInStockOnly(e.target.checked)}
                className="rounded border-dark-border bg-dark-input text-brand focus:ring-0"
              />
              <span>Только в наличии</span>
            </label>
          </div>

          {/* Выбор сортировки */}
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs text-slate-300 focus:border-brand focus:outline-none"
            >
              <option value="sortOrder">По умолчанию</option>
              <option value="price_asc">Сначала дешевле</option>
              <option value="price_desc">Сначала дороже</option>
              <option value="newest">Новинки</option>
            </select>
          </div>
        </div>
      </div>

      {/* 3. Сетка карточек товаров */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="h-64 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
          ))}
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="py-24 text-center space-y-4">
          <span className="text-5xl">🔍</span>
          <h3 className="text-xl font-bold text-white">Товары не найдены</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto">
            Попробуйте изменить поисковый запрос или выбрать другую категорию.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredProducts.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onSelect={handleOpenProduct}
            />
          ))}
        </div>
      )}

      {/* 4. Модальное окно просмотра товара */}
      {selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="relative w-full max-w-lg rounded-3xl bg-dark-card border border-dark-border p-6 shadow-2xl space-y-6">
            <button
              onClick={() => setSelectedProduct(null)}
              className="absolute right-5 top-5 rounded-xl p-2 text-slate-400 hover:text-white hover:bg-dark-surface"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Заголовок */}
            <div className="flex items-start gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-dark-surface border border-dark-border text-3xl">
                {selectedProduct.icon || '📦'}
              </span>
              <div>
                <span className="inline-block rounded-lg bg-dark-surface px-2.5 py-1 text-[11px] font-semibold text-slate-400 mb-1 border border-dark-border">
                  {selectedProduct.category?.name || 'Товары'}
                </span>
                <h2 className="text-xl font-bold text-white leading-snug">
                  {selectedProduct.name}
                </h2>
              </div>
            </div>

            {/* Описание */}
            <div className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 text-xs text-slate-300 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
              {selectedProduct.description || 'Лицензионный цифровой товар с гарантией качества.'}
            </div>

            {/* Преимущества товара */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="flex items-center gap-2 rounded-xl bg-dark-surface p-3 border border-dark-border text-slate-300">
                <Zap className="h-4 w-4 text-brand" />
                <span>Моментальная выдача</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-dark-surface p-3 border border-dark-border text-slate-300">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <span>Гарантия {selectedProduct.warrantyDays} дн.</span>
              </div>
            </div>

            {/* Выбор количества и Цена */}
            <div className="flex items-center justify-between pt-2">
              <div>
                <span className="text-xs text-slate-400 block">Стоимость:</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white font-mono">
                    {(selectedProduct.effectivePrice * modalQty).toFixed(2)} USDT
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    ≈ {Math.round(selectedProduct.effectivePrice * modalQty * 92.5).toLocaleString('ru-RU')} ₽
                  </span>
                </div>
              </div>

              {/* Количество */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">Кол-во:</span>
                <div className="flex items-center rounded-xl bg-dark-surface border border-dark-border text-sm">
                  <button
                    onClick={() => setModalQty(Math.max(1, modalQty - 1))}
                    className="px-3 py-1.5 text-slate-400 hover:text-white"
                  >
                    -
                  </button>
                  <span className="w-8 text-center font-bold font-mono text-white">
                    {modalQty}
                  </span>
                  <button
                    onClick={() => setModalQty(Math.min(selectedProduct.stockCount, modalQty + 1))}
                    disabled={modalQty >= selectedProduct.stockCount}
                    className="px-3 py-1.5 text-slate-400 hover:text-white disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Кнопка добавления в корзину */}
            <button
              onClick={handleModalAdd}
              disabled={!selectedProduct.inStock || isAddingFromModal}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand font-bold text-sm text-white shadow-lg shadow-brand/30 hover:bg-brand-hover hover:scale-[1.01] transition-all disabled:opacity-50"
            >
              <span>{isAddingFromModal ? 'Добавление...' : 'Добавить в корзину'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

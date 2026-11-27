'use client';

import React, { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
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
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  ShoppingBag,
  ArrowRight,
  ArrowLeft,
  LayoutGrid,
  List,
  Flame,
  Calendar,
  PackageOpen,
} from 'lucide-react';
import { catalogApi } from '../lib/api';
import ProductCard from '../components/ProductCard';
import BrandIcon from '../components/BrandIcon';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const PAGE_LIMIT = 24;
const GROUP_FETCH_LIMIT = 200;

const CLUSTERS = [
  { id: 'all', label: 'Все сервисы' },
  { id: 'ai_chat', label: 'ИИ и Чат-боты' },
  { id: 'api', label: 'API-ключи' },
  { id: 'design_video', label: 'Дизайн и Видео' },
  { id: 'office_dev', label: 'Офис и Разработка' },
  { id: 'music_vpn_other', label: 'Музыка, VPN и Прочее' },
];

function getCategoryCluster(categoryName = '') {
  const name = String(categoryName || '').trim();
  if (!name) return 'music_vpn_other';

  if (/\bapi\b|api[-\s]?ключ|openrouter/i.test(name)) {
    return 'api';
  }
  if (
    /chatgpt|gpt|openai|claude|grok|gemini|deepseek|qwen|kimi|perplexity|copilot|manus|genspark|minimax|wispr|granola|нейросет|\bии\b|чат[-\s]?бот/i.test(
      name
    )
  ) {
    return 'ai_chat';
  }
  if (
    /midjourney|kling|runway|suno|heygen|higgsfield|leonardo|krea|gamma|openart|dreamina|seedance|veo|akool|muse|elser|cuty|magica|pippit|framer|adobe|canva|capcut|figma|freepik|autodesk|davinci|picsart|alight|meitu|wink|xingtu|дизайн|видео|фото/i.test(
      name
    )
  ) {
    return 'design_video';
  }
  if (
    /office|microsoft|windows|google\s*one|icloud|apple|github|jetbrains|cursor|replit|bolt|lovable|kiro|n8n|notion|zoom|grammarly|quillbot|ilovepdf|gpmlogin|linkedin|duolingo|coursera|udemy|kahoot|quizlet|scribd|turnitin|офис|разработ|обучен/i.test(
      name
    )
  ) {
    return 'office_dev';
  }
  return 'music_vpn_other';
}

function getGroupSubFilters(categoryName = '') {
  const name = String(categoryName || '').trim();
  if (!name) return [];

  if (/\bapi\b|api[-\s]?ключ/i.test(name)) {
    return [
      { key: 'all', label: 'Все' },
      { key: 'grok', label: 'Grok', pattern: /grok/i },
      { key: 'claude', label: 'Claude', pattern: /claude/i },
      { key: 'deepseek', label: 'DeepSeek', pattern: /deepseek/i },
      { key: 'qwen', label: 'Qwen', pattern: /qwen/i },
      { key: 'kimi', label: 'Kimi', pattern: /kimi/i },
      { key: 'cursor', label: 'Cursor', pattern: /cursor/i },
      { key: 'codex', label: 'Codex', pattern: /codex/i },
    ];
  }
  if (/chatgpt|openai|\bgpt\b/i.test(name)) {
    return [
      { key: 'all', label: 'Все' },
      { key: 'go', label: 'Go', pattern: /\bgo\b/i },
      { key: 'plus', label: 'Plus', pattern: /\bplus\b/i },
      { key: 'pro', label: 'Pro', pattern: /\bpro\b/i },
      { key: 'codex', label: 'Codex', pattern: /codex/i },
    ];
  }
  if (/spotify/i.test(name)) {
    return [
      { key: 'all', label: 'Все' },
      { key: 'individual', label: 'Individual', pattern: /individual|индивидуал/i },
      { key: 'duo', label: 'Duo', pattern: /\bduo\b|дуо/i },
      { key: 'family', label: 'Family', pattern: /family|семейн/i },
    ];
  }
  if (/google\s*one/i.test(name)) {
    return [
      { key: 'all', label: 'Все' },
      { key: '1_3m', label: '1–3 мес.', pattern: /\b[123]\s*(?:мес|month|m\b)/i },
      { key: '6_12m', label: '6–12 мес.', pattern: /\b(?:6|12)\s*(?:мес|month|m\b)|1\s*(?:год|year)/i },
      { key: 'family', label: 'Family', pattern: /family|семейн/i },
    ];
  }
  if (/office|microsoft\s*365/i.test(name)) {
    return [
      { key: 'all', label: 'Все' },
      { key: 'o365', label: 'Office 365', pattern: /365/i },
      { key: 'keys', label: 'Ключи', pattern: /ключ|key|ltsc|2021|2019|2024|pro\s*plus/i },
    ];
  }
  return [];
}

function StorefrontSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="h-56 rounded-3xl bg-dark-card border border-dark-border animate-pulse" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-52 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function StorefrontContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlCategory = searchParams.get('category') || 'all';

  const { addToCart } = useCart();
  const { isAdmin } = useAuth();

  // Мета-данные магазина
  const [rubRate, setRubRate] = useState(92.5);
  const [webMaintenanceMode, setWebMaintenanceMode] = useState(false);

  // Категории-группы
  const [categories, setCategories] = useState([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);

  // Навигация и кластеры
  const [selectedCategory, setSelectedCategory] = useState(urlCategory);
  const [activeCluster, setActiveCluster] = useState('all');
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [showOutOfStockGroups, setShowOutOfStockGroups] = useState(false);

  // Внутри группы (Экран 2)
  const [groupViewMode, setGroupViewMode] = useState('list'); // 'list' | 'grid'
  const [subFilter, setSubFilter] = useState('all');
  const [showOutOfStockInGroup, setShowOutOfStockInGroup] = useState(false);

  // Фильтры, поиск и пагинация товаров
  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_LIMIT, total: 0, pages: 1 });
  const [currentPage, setCurrentPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [instantOnly, setInstantOnly] = useState(false);
  const [flashOnly, setFlashOnly] = useState(false);
  const [minPriceInput, setMinPriceInput] = useState('');
  const [maxPriceInput, setMaxPriceInput] = useState('');
  const [debouncedMinPrice, setDebouncedMinPrice] = useState('');
  const [debouncedMaxPrice, setDebouncedMaxPrice] = useState('');
  const [sortBy, setSortBy] = useState(urlCategory !== 'all' ? 'price_asc' : 'sortOrder');
  const [isLoading, setIsLoading] = useState(false);

  // Модальное окно товара
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [modalQty, setModalQty] = useState(1);
  const [isModalBusy, setIsModalBusy] = useState(false);

  // Синхронизация URL ?category=<id> и кнопки Назад/Вперёд
  useEffect(() => {
    setSelectedCategory(urlCategory);
    setSubFilter('all');
    setCurrentPage(1);
    setShowOutOfStockInGroup(false);
    setShowAllProducts(false);
    setSortBy(urlCategory !== 'all' ? 'price_asc' : 'sortOrder');
  }, [urlCategory]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const cat = params.get('category') || 'all';
      setSelectedCategory(cat);
      setSubFilter('all');
      setCurrentPage(1);
      setShowOutOfStockInGroup(false);
      setSortBy(cat !== 'all' ? 'price_asc' : 'sortOrder');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Debounce поиска
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Debounce диапазона цен
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedMinPrice(minPriceInput.trim());
      setDebouncedMaxPrice(maxPriceInput.trim());
      setCurrentPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [minPriceInput, maxPriceInput]);

  // Первичная загрузка мета-данных и групп-категорий
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
      } finally {
        setCategoriesLoaded(true);
      }
    }

    loadMetaAndCategories();
  }, []);

  const isGroupDetailView = selectedCategory !== 'all';
  const hasActiveFilters = Boolean(
    debouncedSearch ||
      inStockOnly ||
      instantOnly ||
      flashOnly ||
      debouncedMinPrice ||
      debouncedMaxPrice
  );
  const isHybridProductView = !isGroupDetailView && (hasActiveFilters || showAllProducts);
  const isGroupedHomeView = !isGroupDetailView && !isHybridProductView;

  useEffect(() => {
    if (!isGroupedHomeView && sortBy === 'name_asc') {
      setSortBy('sortOrder');
    }
  }, [isGroupedHomeView, sortBy]);

  // Загрузка товаров только когда открыта группа или активен поиск/фильтр/режим всех товаров
  useEffect(() => {
    if (isGroupedHomeView) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function loadProducts() {
      try {
        setIsLoading(true);
        const res = await catalogApi.getProducts({
          categoryId: selectedCategory,
          search: debouncedSearch,
          inStock: inStockOnly,
          instantOnly,
          flashOnly,
          minPrice: debouncedMinPrice || undefined,
          maxPrice: debouncedMaxPrice || undefined,
          sort: sortBy,
          page: isGroupDetailView ? 1 : currentPage,
          limit: isGroupDetailView ? GROUP_FETCH_LIMIT : PAGE_LIMIT,
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
  }, [
    isGroupedHomeView,
    isGroupDetailView,
    selectedCategory,
    debouncedSearch,
    inStockOnly,
    instantOnly,
    flashOnly,
    debouncedMinPrice,
    debouncedMaxPrice,
    sortBy,
    currentPage,
  ]);

  const handleSelectCategory = useCallback(
    (catId) => {
      const target = catId || 'all';
      setSelectedCategory(target);
      setSubFilter('all');
      setCurrentPage(1);
      setShowOutOfStockInGroup(false);
      setShowAllProducts(false);
      if (target !== 'all') {
        setSearchInput('');
        setDebouncedSearch('');
      }
      setSortBy(target !== 'all' ? 'price_asc' : 'sortOrder');

      const base = pathname || '/';
      if (target === 'all') {
        router.push(base, { scroll: false });
      } else {
        router.push(`${base}?category=${encodeURIComponent(target)}`, { scroll: false });
      }
    },
    [pathname, router]
  );

  const handleResetFilters = useCallback(() => {
    setSearchInput('');
    setDebouncedSearch('');
    setInStockOnly(false);
    setInstantOnly(false);
    setFlashOnly(false);
    setMinPriceInput('');
    setMaxPriceInput('');
    setDebouncedMinPrice('');
    setDebouncedMaxPrice('');
    setShowAllProducts(false);
    setSubFilter('all');
    setCurrentPage(1);
    if (isGroupDetailView) {
      handleSelectCategory('all');
    } else {
      setSortBy('sortOrder');
    }
  }, [isGroupDetailView, handleSelectCategory]);

  // Скрываем полностью пустые категории (productCount === 0)
  const visibleCategories = useMemo(
    () => categories.filter((c) => Number(c.productCount || 0) > 0),
    [categories]
  );

  // Подсчёт групп в каждом кластере
  const clusterCounts = useMemo(() => {
    const counts = { all: visibleCategories.length };
    for (const cl of CLUSTERS) {
      if (cl.id !== 'all') counts[cl.id] = 0;
    }
    for (const cat of visibleCategories) {
      const clId = getCategoryCluster(cat.name);
      counts[clId] = (counts[clId] || 0) + 1;
    }
    return counts;
  }, [visibleCategories]);

  // Категории в активном кластере (Экран 1) с учётом сортировки
  const clusterCategories = useMemo(() => {
    const base =
      activeCluster === 'all'
        ? visibleCategories
        : visibleCategories.filter((c) => getCategoryCluster(c.name) === activeCluster);

    if (sortBy === 'price_asc') {
      return [...base].sort((a, b) => (a.minPrice ?? Infinity) - (b.minPrice ?? Infinity));
    }
    if (sortBy === 'price_desc') {
      return [...base].sort((a, b) => (b.minPrice ?? -1) - (a.minPrice ?? -1));
    }
    if (sortBy === 'popular') {
      return [...base].sort((a, b) => Number(b.popularScore || 0) - Number(a.popularScore || 0));
    }
    if (sortBy === 'name_asc') {
      return [...base].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
    }
    return base;
  }, [visibleCategories, activeCluster, sortBy]);

  const inStockGroups = useMemo(
    () =>
      clusterCategories.filter((c) => {
        const stock = c.inStockCount !== undefined ? Number(c.inStockCount) : Number(c.productCount || 0);
        return stock > 0;
      }),
    [clusterCategories]
  );

  const outOfStockGroups = useMemo(
    () =>
      clusterCategories.filter((c) => {
        const stock = c.inStockCount !== undefined ? Number(c.inStockCount) : Number(c.productCount || 0);
        return stock === 0;
      }),
    [clusterCategories]
  );

  // Активная категория (Экран 2)
  const selectedCatObj = useMemo(
    () => categories.find((c) => String(c.id) === String(selectedCategory)) || null,
    [categories, selectedCategory]
  );

  // Подходящие группы для гибридного поиска
  const matchingGroups = useMemo(() => {
    if (!debouncedSearch) return [];
    const q = debouncedSearch.toLowerCase();
    return visibleCategories
      .filter((cat) => {
        const nameMatch = cat.name?.toLowerCase().includes(q);
        const titleMatch =
          Array.isArray(cat.previewTitles) &&
          cat.previewTitles.some((t) => String(t).toLowerCase().includes(q));
        return nameMatch || titleMatch;
      })
      .slice(0, 8);
  }, [visibleCategories, debouncedSearch]);

  // Автоматические под-фильтры для Экран 2 (показываем только те, где есть >= 1 товар)
  const availableSubFilters = useMemo(() => {
    if (!isGroupDetailView || !selectedCatObj) return [];
    const rules = getGroupSubFilters(selectedCatObj.name);
    if (rules.length === 0) return [];
    const matching = rules.filter((r) => {
      if (r.key === 'all') return true;
      return products.some((p) => r.pattern.test(`${p.name || ''} ${p.description || ''}`));
    });
    return matching.length > 1 ? matching : [];
  }, [isGroupDetailView, selectedCatObj, products]);

  // Товары внутри группы после под-фильтра
  const groupProducts = useMemo(() => {
    if (!isGroupDetailView) return products;
    if (subFilter === 'all') return products;
    const rule = availableSubFilters.find((r) => r.key === subFilter);
    if (!rule || !rule.pattern) return products;
    return products.filter((p) => rule.pattern.test(`${p.name || ''} ${p.description || ''}`));
  }, [isGroupDetailView, products, subFilter, availableSubFilters]);

  const groupInStockProducts = useMemo(
    () => groupProducts.filter((p) => p.inStock && p.stockCount > 0),
    [groupProducts]
  );

  const groupOutOfStockProducts = useMemo(
    () => groupProducts.filter((p) => !p.inStock || p.stockCount <= 0),
    [groupProducts]
  );

  // Диапазон цен для шапки Экран 2
  const groupPriceStats = useMemo(() => {
    const source = groupInStockProducts.length > 0 ? groupInStockProducts : groupProducts;
    if (source.length === 0) {
      return {
        min: selectedCatObj?.minPrice ?? null,
        max: selectedCatObj?.maxPrice ?? null,
      };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const p of source) {
      const val = Number(p.effectivePrice ?? p.price ?? 0);
      if (val < min) min = val;
      if (val > max) max = val;
    }
    return {
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
    };
  }, [groupInStockProducts, groupProducts, selectedCatObj]);

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

  const renderGroupCard = (cat, muted = false) => {
    const inStockCount = cat.inStockCount !== undefined ? Number(cat.inStockCount) : Number(cat.productCount || 0);
    const totalCount = Number(cat.productCount || 0);
    const minPrice = cat.minPrice !== null && cat.minPrice !== undefined ? Number(cat.minPrice) : null;
    const minRub = minPrice !== null ? Math.round(minPrice * rubRate) : null;
    const previews = Array.isArray(cat.previewTitles) ? cat.previewTitles.slice(0, 3) : [];

    return (
      <button
        key={cat.id}
        type="button"
        onClick={() => handleSelectCategory(cat.id)}
        className={`group text-left flex h-full flex-col justify-between rounded-2xl bg-dark-card border border-dark-border p-4 sm:p-5 glass-card-hover ${
          muted ? 'opacity-65 hover:opacity-100' : ''
        }`}
      >
        <div className="space-y-3 w-full">
          {/* Верх: иконка 44 + название + бейджи */}
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-start gap-3 min-w-0">
              <BrandIcon size={44} name={cat.name} rounded="xl" />
              <div className="min-w-0">
                <h3 className="font-bold text-white text-[15px] leading-snug group-hover:text-brand transition-colors line-clamp-2">
                  {cat.name}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="tabular-nums">
                    {inStockCount > 0 ? `${inStockCount} из ${totalCount} в наличии` : `${totalCount} тарифов`}
                  </span>
                </div>
              </div>
            </div>

            {cat.hasFlashSale && (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[10px] font-bold text-rose-400">
                🔥 Flash Sale
              </span>
            )}
          </div>

          {/* Превью до 3 тарифов */}
          {previews.length > 0 && (
            <div className="space-y-1 pt-1">
              {previews.map((title, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1.5 text-[11px] text-slate-300 truncate rounded-lg bg-dark-surface/70 border border-dark-border/50 px-2.5 py-1"
                >
                  <span className="h-1 w-1 rounded-full bg-brand shrink-0" />
                  <span className="truncate">{title}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Низ: цена от и стрелка */}
        <div className="mt-4 pt-3 border-t border-dark-border/60 flex items-center justify-between gap-2 w-full">
          <div className="min-w-0">
            {minPrice !== null ? (
              <>
                <div className="text-sm font-bold text-white font-mono tabular-nums whitespace-nowrap">
                  от {minPrice.toFixed(2)} <span className="text-xs font-semibold text-slate-300">USDT</span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono tabular-nums whitespace-nowrap">
                  (~{minRub.toLocaleString('ru-RU')} ₽)
                </div>
              </>
            ) : (
              <div className="text-xs font-medium text-slate-400">Посмотреть тарифы</div>
            )}
          </div>

          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-dark-surface border border-dark-border text-slate-300 group-hover:bg-brand group-hover:border-brand group-hover:text-white transition-all">
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
      {/* Баннеры технического обслуживания */}
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

      {/* 1. Hero баннер (показываем компактно на главном экране или скрываем лишнее в детальной группе) */}
      {!isGroupDetailView && (
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-dark-card via-dark-surface to-dark-card border border-dark-border p-6 sm:p-8 shadow-2xl">
          <div className="relative z-10 max-w-2xl space-y-3.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-brand/15 border border-brand/30 px-3 py-1 text-xs font-semibold text-brand">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Автоматическая выдача за 1 секунду • Курс 1 USDT = {rubRate.toFixed(2)} ₽</span>
            </div>

            <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
              Цифровые товары, подписки и ключи
            </h1>

            <p className="text-slate-400 text-sm sm:text-base leading-relaxed">
              Мгновенная доставка лицензий и AI-подписок. Прямая оплата через Bybit UID (0%), СБП и криптовалюту без посредников.
            </p>

            {/* Поиск */}
            <div className="pt-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 max-w-xl">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={`Поиск по ${totalProducts || '285+'} товарам (ChatGPT, Claude, Spotify, API)...`}
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

              <button
                type="button"
                onClick={() => {
                  setShowAllProducts((prev) => !prev);
                  setCurrentPage(1);
                }}
                className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-xs font-bold border transition-all whitespace-nowrap ${
                  showAllProducts
                    ? 'bg-brand border-brand text-white shadow-lg shadow-brand/25'
                    : 'bg-dark-bg/80 border-dark-border text-slate-200 hover:border-brand/50 hover:text-white'
                }`}
              >
                <Grid className="h-4 w-4" />
                <span>{showAllProducts ? 'Показать сервисы' : `Все товары (${totalProducts})`}</span>
              </button>
            </div>
          </div>

          <div className="absolute -right-10 -bottom-10 h-72 w-72 rounded-full bg-brand/10 blur-3xl pointer-events-none" />
        </div>
      )}

      {/* 2. Панель полезных фильтров (общая для главного экрана, гибридного поиска и группы) */}
      <div className="space-y-3 rounded-2xl bg-dark-card/70 border border-dark-border p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Внутри группы также показываем быстрый поиск по тарифам */}
            {isGroupDetailView && (
              <div className="relative w-full sm:w-56">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Поиск в группе..."
                  className="w-full rounded-xl bg-dark-bg border border-dark-border py-1.5 pl-8 pr-7 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                setInStockOnly((v) => !v);
                setCurrentPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-all ${
                inStockOnly
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-dark-surface border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${inStockOnly ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              <span>Только в наличии</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setInstantOnly((v) => !v);
                setCurrentPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-all ${
                instantOnly
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-dark-surface border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
              }`}
            >
              <Zap className="h-3.5 w-3.5 text-emerald-400" />
              <span>⚡ Быстрая выдача</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setFlashOnly((v) => !v);
                setCurrentPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-all ${
                flashOnly
                  ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                  : 'bg-dark-surface border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
              }`}
            >
              <Flame className="h-3.5 w-3.5 text-rose-400" />
              <span>🔥 Со скидкой</span>
            </button>

            {/* Бюджет от / до $ */}
            <div className="flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-2.5 py-1 text-xs">
              <span className="text-slate-400 text-[11px]">Бюджет $:</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={minPriceInput}
                onChange={(e) => setMinPriceInput(e.target.value)}
                placeholder="от"
                className="w-14 bg-transparent text-white placeholder-slate-500 focus:outline-none font-mono tabular-nums text-xs"
              />
              <span className="text-slate-600">—</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={maxPriceInput}
                onChange={(e) => setMaxPriceInput(e.target.value)}
                placeholder="до"
                className="w-14 bg-transparent text-white placeholder-slate-500 focus:outline-none font-mono tabular-nums text-xs"
              />
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setDebouncedSearch('');
                  setInStockOnly(false);
                  setInstantOnly(false);
                  setFlashOnly(false);
                  setMinPriceInput('');
                  setMaxPriceInput('');
                  setDebouncedMinPrice('');
                  setDebouncedMaxPrice('');
                  setCurrentPage(1);
                }}
                className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-400 hover:text-white hover:bg-dark-surface transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                <span>Сбросить</span>
              </button>
            )}
          </div>

          {/* Сортировка и переключатель вида */}
          <div className="flex items-center gap-2 ml-auto">
            {(isGroupDetailView || isHybridProductView) && (
              <div className="flex items-center rounded-xl bg-dark-surface border border-dark-border p-0.5">
                <button
                  type="button"
                  onClick={() => setGroupViewMode('list')}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all ${
                    groupViewMode === 'list'
                      ? 'bg-brand text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="Список тарифов"
                >
                  <List className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Список тарифов</span>
                </button>
                <button
                  type="button"
                  onClick={() => setGroupViewMode('grid')}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all ${
                    groupViewMode === 'grid'
                      ? 'bg-brand text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title="Карточки"
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Карточки</span>
                </button>
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  setCurrentPage(1);
                }}
                className="rounded-xl bg-dark-surface border border-dark-border px-2.5 py-1.5 text-xs text-slate-200 focus:border-brand focus:outline-none"
              >
                {isGroupedHomeView ? (
                  <>
                    <option value="sortOrder">По умолчанию</option>
                    <option value="price_asc">Сначала дешевле (от $)</option>
                    <option value="price_desc">Сначала дороже (от $)</option>
                    <option value="popular">Популярные</option>
                    <option value="name_asc">По алфавиту А–Я</option>
                  </>
                ) : (
                  <>
                    <option value="sortOrder">По умолчанию</option>
                    <option value="price_asc">Сначала дешевле</option>
                    <option value="price_desc">Сначала дороже</option>
                    <option value="newest">Новинки</option>
                    <option value="popular">Популярные</option>
                  </>
                )}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* ЭКРАН 1: ГРУППИРОВАННАЯ ВИТРИНА СЕРВИСОВ (ГЛАВНЫЙ)             */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {isGroupedHomeView && (
        <div className="space-y-6">
          {/* Верхние кластеры */}
          <div className="flex flex-wrap items-center gap-2">
            {CLUSTERS.map((cl) => {
              const count = clusterCounts[cl.id] || 0;
              if (cl.id !== 'all' && count === 0) return null;
              const active = activeCluster === cl.id;
              return (
                <button
                  key={cl.id}
                  type="button"
                  onClick={() => setActiveCluster(cl.id)}
                  className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
                    active
                      ? 'bg-brand text-white shadow-lg shadow-brand/25'
                      : 'bg-dark-card border border-dark-border text-slate-300 hover:text-white hover:border-slate-600'
                  }`}
                >
                  <span>{cl.label}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${
                      active ? 'bg-white/20 text-white' : 'bg-dark-surface text-slate-400'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Сетка карточек-групп */}
          {!categoriesLoaded ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-56 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
              ))}
            </div>
          ) : inStockGroups.length === 0 && outOfStockGroups.length === 0 ? (
            <div className="rounded-3xl bg-dark-card border border-dark-border py-16 text-center space-y-3">
              <PackageOpen className="mx-auto h-10 w-10 text-slate-500" />
              <h3 className="text-base font-bold text-white">В этом разделе пока нет активных сервисов</h3>
              {activeCluster !== 'all' && (
                <button
                  type="button"
                  onClick={() => setActiveCluster('all')}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
                >
                  Показать все сервисы
                </button>
              )}
            </div>
          ) : (
            <>
              {inStockGroups.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
                  {inStockGroups.map((cat) => renderGroupCard(cat, false))}
                </div>
              )}

              {/* Временно раскупившиеся группы в спойлере */}
              {outOfStockGroups.length > 0 && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setShowOutOfStockGroups((v) => !v)}
                    className="flex w-full items-center justify-between rounded-2xl bg-dark-card/70 border border-dark-border px-4 py-3 text-xs font-semibold text-slate-300 hover:border-slate-600 hover:text-white transition-all"
                  >
                    <span>Нет в наличии / Предзаказ ({outOfStockGroups.length})</span>
                    {showOutOfStockGroups ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    )}
                  </button>

                  {showOutOfStockGroups && (
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
                      {outOfStockGroups.map((cat) => renderGroupCard(cat, true))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* ЭКРАН 2: ВНУТРИ ГРУППЫ (/?category=<id>)                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {isGroupDetailView && categoriesLoaded && !selectedCatObj ? (
        <div className="rounded-3xl bg-dark-card border border-dark-border py-16 px-4 text-center space-y-4">
          <PackageOpen className="mx-auto h-10 w-10 text-slate-500" />
          <h2 className="text-lg font-bold text-white">Категория не найдена</h2>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Возможно, эта категория была удалена или временно отключена.
          </p>
          <button
            type="button"
            onClick={() => handleSelectCategory('all')}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Все сервисы</span>
          </button>
        </div>
      ) : isGroupDetailView && (
        <div className="space-y-5">
          {/* Хлебные крошки и шапка бренда */}
          <div className="rounded-3xl bg-gradient-to-r from-dark-card via-dark-surface to-dark-card border border-dark-border p-5 sm:p-6 shadow-xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <button
                  type="button"
                  onClick={() => handleSelectCategory('all')}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-dark-bg border border-dark-border px-3 py-1.5 font-semibold text-slate-200 hover:border-brand/50 hover:text-white transition-all"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Все сервисы</span>
                </button>
                <span>/</span>
                <span>
                  {CLUSTERS.find((c) => c.id === getCategoryCluster(selectedCatObj?.name))?.label || 'Сервисы'}
                </span>
                <span>/</span>
                <span className="text-white font-semibold">{selectedCatObj?.name || 'Группа'}</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <BrandIcon size={56} name={selectedCatObj?.name || 'Service'} rounded="2xl" />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-xl sm:text-2xl font-extrabold text-white">
                      {selectedCatObj?.name || 'Загрузка категории...'}
                    </h1>
                    {selectedCatObj?.hasFlashSale && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 border border-rose-500/30 px-2.5 py-0.5 text-[11px] font-bold text-rose-400">
                        🔥 Flash Sale
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                    <span>
                      Тарифов: <strong className="text-white tabular-nums">{groupProducts.length}</strong>
                    </span>
                    <span>•</span>
                    <span>
                      В наличии: <strong className="text-emerald-400 tabular-nums">{groupInStockProducts.length}</strong>
                    </span>
                    {groupPriceStats.min !== null && (
                      <>
                        <span>•</span>
                        <span className="font-mono tabular-nums">
                          {groupPriceStats.min === groupPriceStats.max
                            ? `${groupPriceStats.min.toFixed(2)} USDT (~${Math.round(groupPriceStats.min * rubRate).toLocaleString('ru-RU')} ₽)`
                            : `от ${groupPriceStats.min.toFixed(2)} до ${groupPriceStats.max.toFixed(2)} USDT`}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Автоматические под-фильтры для крупных групп */}
            {availableSubFilters.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-dark-border/60">
                {availableSubFilters.map((sf) => {
                  const active = subFilter === sf.key;
                  return (
                    <button
                      key={sf.key}
                      type="button"
                      onClick={() => setSubFilter(sf.key)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                        active
                          ? 'bg-brand text-white shadow-md shadow-brand/25'
                          : 'bg-dark-bg/80 border border-dark-border text-slate-300 hover:text-white hover:border-slate-500'
                      }`}
                    >
                      {sf.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Товары внутри группы */}
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-20 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
              ))}
            </div>
          ) : groupProducts.length === 0 ? (
            <div className="rounded-3xl bg-dark-card border border-dark-border py-16 text-center space-y-3">
              <Search className="mx-auto h-8 w-8 text-slate-500" />
              <h3 className="text-base font-bold text-white">Подходящих тарифов не найдено</h3>
              <button
                type="button"
                onClick={() => {
                  setSubFilter('all');
                  setSearchInput('');
                  setDebouncedSearch('');
                  setInStockOnly(false);
                  setInstantOnly(false);
                  setFlashOnly(false);
                  setMinPriceInput('');
                  setMaxPriceInput('');
                  setDebouncedMinPrice('');
                  setDebouncedMaxPrice('');
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
              >
                Сбросить фильтры группы
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {groupInStockProducts.length > 0 && (
                groupViewMode === 'list' ? (
                  <div className="space-y-2.5">
                    {groupInStockProducts.map((product) => (
                      <ProductCard
                        key={product.id}
                        product={product}
                        rubRate={rubRate}
                        viewMode="row"
                        onSelect={handleOpenProduct}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
                    {groupInStockProducts.map((product) => (
                      <ProductCard
                        key={product.id}
                        product={product}
                        rubRate={rubRate}
                        viewMode="card"
                        onSelect={handleOpenProduct}
                      />
                    ))}
                  </div>
                )
              )}

              {/* Закончившиеся товары в группе — в нижний спойлер */}
              {groupOutOfStockProducts.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowOutOfStockInGroup((v) => !v)}
                    className="flex w-full items-center justify-between rounded-2xl bg-dark-card/70 border border-dark-border px-4 py-3 text-xs font-semibold text-slate-300 hover:border-slate-600 hover:text-white transition-all"
                  >
                    <span>Нет в наличии ({groupOutOfStockProducts.length})</span>
                    {showOutOfStockInGroup ? (
                      <ChevronUp className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    )}
                  </button>

                  {showOutOfStockInGroup && (
                    <div className="mt-3">
                      {groupViewMode === 'list' ? (
                        <div className="space-y-2.5">
                          {groupOutOfStockProducts.map((product) => (
                            <ProductCard
                              key={product.id}
                              product={product}
                              rubRate={rubRate}
                              viewMode="row"
                              onSelect={handleOpenProduct}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
                          {groupOutOfStockProducts.map((product) => (
                            <ProductCard
                              key={product.id}
                              product={product}
                              rubRate={rubRate}
                              viewMode="card"
                              onSelect={handleOpenProduct}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* ЭКРАН 3: ГИБРИДНЫЙ ПОИСК И ФИЛЬТРЫ / ВСЕ ТОВАРЫ                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {isHybridProductView && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1.5 rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand/50 hover:text-white transition-all"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>К группам</span>
              </button>
              <span className="text-xs text-slate-400">
                Найдено товаров:{' '}
                <strong className="text-white tabular-nums">{pagination.total ?? products.length}</strong>
              </span>
            </div>
          </div>

          {/* Найденные подходящие группы при поиске */}
          {matchingGroups.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Подходящие сервисы ({matchingGroups.length})
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {matchingGroups.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleSelectCategory(cat.id)}
                    className="flex items-center justify-between gap-2.5 rounded-2xl bg-dark-card border border-dark-border p-3 text-left hover:border-brand/50 transition-all"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <BrandIcon size={32} name={cat.name} rounded="lg" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-white truncate">{cat.name}</div>
                        <div className="text-[10px] text-slate-400 tabular-nums">
                          {cat.inStockCount ?? cat.productCount} в наличии
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Список / сетка найденных товаров */}
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-64 rounded-2xl bg-dark-card border border-dark-border animate-pulse" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="rounded-3xl bg-dark-card border border-dark-border py-16 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-dark-surface border border-dark-border text-slate-400">
                <Search className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Товары не найдены</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                Попробуйте изменить поисковый запрос или сбросить активные фильтры.
              </p>
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
              >
                Вернуться к группам
              </button>
            </div>
          ) : (
            <>
              {groupViewMode === 'list' ? (
                <div className="space-y-2.5">
                  {products.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      rubRate={rubRate}
                      viewMode="row"
                      onSelect={handleOpenProduct}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
                  {products.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      rubRate={rubRate}
                      viewMode="card"
                      onSelect={handleOpenProduct}
                    />
                  ))}
                </div>
              )}

              {/* Пагинация */}
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
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* МОДАЛЬНОЕ ОКНО ДЕТАЛЬНОГО ПРОСМОТРА ТОВАРА                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
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

            <div className="rounded-2xl bg-dark-surface/60 border border-dark-border p-4 text-xs text-slate-300 leading-relaxed max-h-44 overflow-y-auto whitespace-pre-wrap">
              {selectedProduct.description || 'Лицензионный цифровой товар с гарантией качества и быстрой выдачей.'}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <div className="flex items-center gap-2 rounded-xl bg-dark-surface p-2.5 border border-dark-border text-slate-300">
                <Zap className="h-4 w-4 shrink-0 text-brand" />
                <span className="truncate">
                  {selectedProduct.type === 'key' ||
                  selectedProduct.deliveryMethod === 'ready_account' ||
                  selectedProduct.provider === 'jaha'
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

export default function StorefrontPage() {
  return (
    <Suspense fallback={<StorefrontSkeleton />}>
      <StorefrontContent />
    </Suspense>
  );
}

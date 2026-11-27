'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Headphones,
  MessageCircle,
  X,
  Plus,
  ArrowLeft,
  Send,
  ImagePlus,
  CheckCircle2,
  Star,
  ExternalLink,
  Loader2,
  Package,
  Maximize2,
  Clock,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { supportApi } from '../lib/api';

const OWNER_FALLBACK_URL = 'https://t.me/Tigrano_o';
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_COMPRESSED_BYTES = 580 * 1024; // <= 600KB (укладывается в 1MB JSON и 700KB backend limit)

const TOPICS = [
  { id: 'order', label: 'Заказ', emoji: '📦' },
  { id: 'payment', label: 'Оплата', emoji: '💳' },
  { id: 'product', label: 'Товар', emoji: '🔑' },
  { id: 'general', label: 'Общий', emoji: '❓' },
];

const STATUS_BADGE = {
  open: { label: 'Ожидает', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  in_progress: { label: 'В работе', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  escalated: { label: 'Передан ст. спец.', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  closed: { label: 'Закрыт', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
};

function estimateDataUrlBytes(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return dataUrl.length;
  const b64 = dataUrl.slice(commaIdx + 1);
  return Math.ceil((b64.length * 3) / 4);
}

async function compressImageToDataUrl(file) {
  if (!file) throw new Error('Файл не выбран');
  const mime = (file.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
    throw new Error('Поддерживаются только PNG, JPEG или WEBP изображения');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      el.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas не поддерживается');

    const maxDims = [1400, 1080, 820, 640];
    const qualities = [0.85, 0.72, 0.58, 0.45];

    for (const maxDim of maxDims) {
      const ratio = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      if (mime === 'image/png' && maxDim === 1400) {
        const pngUrl = canvas.toDataURL('image/png');
        if (estimateDataUrlBytes(pngUrl) <= MAX_COMPRESSED_BYTES) {
          return pngUrl;
        }
      }

      const targetMime = mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
      for (const q of qualities) {
        const out = canvas.toDataURL(targetMime, q);
        if (estimateDataUrlBytes(out) <= MAX_COMPRESSED_BYTES) {
          return out;
        }
      }
    }

    throw new Error('Изображение слишком тяжёлое даже после сжатия (макс. 600KB)');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function SupportWidget() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'new' | 'chat'

  const [meta, setMeta] = useState({
    ownerUrl: OWNER_FALLBACK_URL,
    maxOpen: 3,
    activeCount: 0,
    unreadCount: 0,
    recentOrders: [],
  });

  const [tickets, setTickets] = useState([]);
  const [loadingList, setLoadingList] = useState(false);

  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [ticketDetail, setTicketDetail] = useState(null);
  const [loadingTicket, setLoadingTicket] = useState(false);

  // Новый вопрос
  const [topic, setTopic] = useState('general');
  const [orderId, setOrderId] = useState('');
  const [newText, setNewText] = useState('');
  const [newImage, setNewImage] = useState(null);
  const [newImageName, setNewImageName] = useState('');
  const [creating, setCreating] = useState(false);

  // Ответ в чате
  const [replyText, setReplyText] = useState('');
  const [replyImage, setReplyImage] = useState(null);
  const [replyImageName, setReplyImageName] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [hoverStar, setHoverStar] = useState(0);

  // Просмотр фото
  const [lightboxUrl, setLightboxUrl] = useState(null);

  const messagesEndRef = useRef(null);
  const newFileRef = useRef(null);
  const replyFileRef = useRef(null);

  const fetchMeta = useCallback(async () => {
    if (!isAuthenticated || typeof supportApi?.getMeta !== 'function') return;
    try {
      const res = await supportApi.getMeta();
      if (res?.success) {
        setMeta({
          ownerUrl: res.ownerUrl || OWNER_FALLBACK_URL,
          maxOpen: res.maxOpen || 3,
          activeCount: Number(res.activeCount || 0),
          unreadCount: Number(res.unreadCount || 0),
          recentOrders: Array.isArray(res.recentOrders) ? res.recentOrders : [],
        });
      }
    } catch (_) {}
  }, [isAuthenticated]);

  const fetchTickets = useCallback(
    async (silent = false) => {
      if (!isAuthenticated || typeof supportApi?.getTickets !== 'function') return;
      try {
        if (!silent) setLoadingList(true);
        const res = await supportApi.getTickets({ page: 1, limit: 20 });
        if (res?.success) {
          setTickets(res.tickets || res.items || []);
        }
      } catch (err) {
        if (!silent) toast.error(err.message || 'Не удалось загрузить обращения');
      } finally {
        if (!silent) setLoadingList(false);
      }
    },
    [isAuthenticated, toast]
  );

  const fetchTicketDetail = useCallback(
    async (tid, silent = false) => {
      if (!tid || !isAuthenticated || typeof supportApi?.getTicket !== 'function') return;
      try {
        if (!silent) setLoadingTicket(true);
        const res = await supportApi.getTicket(tid);
        if (res?.success && res.ticket) {
          setTicketDetail({
            ticket: res.ticket,
            messages: res.messages || [],
          });
        }
      } catch (err) {
        if (!silent) toast.error(err.message || 'Не удалось загрузить диалог');
      } finally {
        if (!silent) setLoadingTicket(false);
      }
    },
    [isAuthenticated, toast]
  );

  useEffect(() => {
    if (isAuthenticated) {
      fetchMeta();
    }
  }, [isAuthenticated, fetchMeta]);

  useEffect(() => {
    if (!open || !isAuthenticated) return;
    fetchMeta();
    if (view === 'list') {
      fetchTickets();
    } else if (view === 'chat' && selectedTicketId) {
      fetchTicketDetail(selectedTicketId);
    }
  }, [open, isAuthenticated, view, selectedTicketId, fetchMeta, fetchTickets, fetchTicketDetail]);

  // Авто-обновление диалога каждые 4.5 сек пока окно открыто и выбран тикет
  useEffect(() => {
    if (!open || !isAuthenticated || view !== 'chat' || !selectedTicketId) return undefined;
    const timer = setInterval(() => {
      fetchTicketDetail(selectedTicketId, true);
    }, 4500);
    return () => clearInterval(timer);
  }, [open, isAuthenticated, view, selectedTicketId, fetchTicketDetail]);

  useEffect(() => {
    if (view === 'chat' && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [view, ticketDetail?.messages?.length]);

  const handleImagePick = async (e, target) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImageToDataUrl(file);
      if (target === 'new') {
        setNewImage(compressed);
        setNewImageName(file.name);
      } else {
        setReplyImage(compressed);
        setReplyImageName(file.name);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка обработки фото');
    }
  };

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    if (!newText.trim() && !newImage) {
      toast.error('Опишите вопрос или прикрепите скриншот');
      return;
    }
    try {
      setCreating(true);
      const res = await supportApi.createTicket({
        topic,
        orderId: orderId || null,
        text: newText.trim(),
        imageBase64: newImage || null,
      });
      if (res?.success && res.ticket) {
        toast.success(`Обращение #${res.ticket.ticketNumber} создано`);
        setNewText('');
        setNewImage(null);
        setNewImageName('');
        setOrderId('');
        const tid = res.ticket._id || res.ticket.id;
        setSelectedTicketId(tid);
        setView('chat');
        fetchMeta();
        fetchTickets(true);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось создать обращение');
    } finally {
      setCreating(false);
    }
  };

  const handleSendReply = async (e) => {
    e.preventDefault();
    if (!selectedTicketId) return;
    if (!replyText.trim() && !replyImage) {
      toast.error('Введите сообщение или прикрепите фото');
      return;
    }
    try {
      setSendingReply(true);
      const res = await supportApi.replyTicket(selectedTicketId, {
        text: replyText.trim(),
        imageBase64: replyImage || null,
      });
      if (res?.success) {
        setReplyText('');
        setReplyImage(null);
        setReplyImageName('');
        await fetchTicketDetail(selectedTicketId, true);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось отправить сообщение');
      await fetchTicketDetail(selectedTicketId, true);
    } finally {
      setSendingReply(false);
    }
  };

  const handleCloseTicket = async () => {
    if (!selectedTicketId) return;
    try {
      setClosing(true);
      const res = await supportApi.closeTicket(selectedTicketId);
      if (res?.success) {
        toast.success('Обращение закрыто');
        await fetchTicketDetail(selectedTicketId, true);
        fetchMeta();
        fetchTickets(true);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка закрытия обращения');
    } finally {
      setClosing(false);
    }
  };

  const handleRate = async (stars) => {
    if (!selectedTicketId || ratingBusy) return;
    try {
      setRatingBusy(true);
      const res = await supportApi.rateTicket(selectedTicketId, stars);
      if (res?.success) {
        toast.success(`Спасибо за оценку ${stars} ⭐`);
        await fetchTicketDetail(selectedTicketId, true);
        fetchTickets(true);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось сохранить оценку');
    } finally {
      setRatingBusy(false);
    }
  };

  const badgeCount = isAuthenticated ? (meta.unreadCount > 0 ? meta.unreadCount : meta.activeCount) : 0;
  const activeTicket = ticketDetail?.ticket || null;
  const messages = ticketDetail?.messages || [];

  const getMediaSrc = (msg) => {
    if (msg?.mediaUrl) return msg.mediaUrl;
    const tid = activeTicket?._id || activeTicket?.id || selectedTicketId;
    const mid = msg?._id || msg?.id;
    if (msg?.hasMedia && tid && mid && typeof supportApi?.getMediaUrl === 'function') {
      return supportApi.getMediaUrl(tid, mid);
    }
    return null;
  };

  return (
    <>
      {/* Плавающая круглая кнопка техподдержки */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Техподдержка TIG MARKET"
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-[0_0_24px_rgba(255,87,34,0.45)] hover:bg-brand-hover hover:scale-105 active:scale-95 transition-all border border-white/15"
      >
        {open ? <X className="h-6 w-6" /> : <Headphones className="h-6 w-6" />}
        {!open && badgeCount > 0 && (
          <span className="absolute -top-1 -right-1 flex min-w-[20px] h-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-extrabold text-black ring-2 ring-dark-bg tabular-nums">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {/* Всплывающее окно чата */}
      {open && (
        <div className="fixed bottom-[84px] right-4 sm:right-5 z-50 flex w-[calc(100vw-2rem)] sm:w-[400px] max-h-[min(600px,calc(100vh-7rem))] flex-col overflow-hidden rounded-3xl bg-dark-card border border-dark-border shadow-2xl shadow-black/70">
          {/* Шапка */}
          <div className="flex items-center justify-between gap-2 bg-dark-surface/90 border-b border-dark-border px-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              {isAuthenticated && view === 'chat' && (
                <button
                  type="button"
                  onClick={() => {
                    setView('list');
                    setSelectedTicketId(null);
                    setTicketDetail(null);
                  }}
                  className="rounded-lg p-1.5 text-slate-300 hover:bg-white/5 hover:text-white"
                  aria-label="К списку обращений"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/20 text-brand">
                <MessageCircle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">Поддержка TIG MARKET</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {isAuthenticated ? 'Онлайн-чат и синхронизация с ботом' : 'Помощь с заказами и оплатой'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <a
                href={meta.ownerUrl || OWNER_FALLBACK_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Написать владельцу"
                className="inline-flex items-center gap-1 rounded-xl bg-dark-card border border-dark-border px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-brand/50 hover:text-white transition-colors"
              >
                <span>👤</span>
                <span className="hidden sm:inline">Владелец</span>
                <ExternalLink className="h-3 w-3 text-slate-400" />
              </a>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
                aria-label="Закрыть чат"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Тело */}
          {authLoading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
            </div>
          ) : !isAuthenticated ? (
            <div className="p-5 space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/15 text-brand">
                <Headphones className="h-6 w-6" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-bold text-white">Добро пожаловать в поддержку TIG MARKET</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Войдите через Telegram, чтобы создавать обращения по заказам, прикреплять скриншоты и получать ответы
                  саппорта на сайте и в боте.
                </p>
              </div>
              <div className="flex flex-col gap-2.5 pt-1">
                <Link
                  href="/auth/signin"
                  onClick={() => setOpen(false)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white hover:bg-brand-hover transition-all btn-primary-glow"
                >
                  Войти через Telegram
                </Link>
                <a
                  href={OWNER_FALLBACK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-dark-surface border border-dark-border px-4 py-2.5 text-xs font-semibold text-slate-200 hover:border-slate-500 hover:text-white transition-all"
                >
                  <span>👤 Написать владельцу</span>
                  <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
                </a>
              </div>
            </div>
          ) : (
            <>
              {/* Навигация: Мои обращения / Новый вопрос */}
              {view !== 'chat' && (
                <div className="flex items-center gap-2 border-b border-dark-border bg-dark-bg/40 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => setView('list')}
                    className={`flex-1 rounded-xl py-1.5 text-xs font-semibold transition-all ${
                      view === 'list'
                        ? 'bg-brand text-white'
                        : 'bg-dark-surface text-slate-300 hover:text-white'
                    }`}
                  >
                    Мои обращения ({tickets.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('new')}
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold transition-all ${
                      view === 'new'
                        ? 'bg-brand text-white'
                        : 'bg-dark-surface text-slate-300 hover:text-white'
                    }`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Новый вопрос</span>
                  </button>
                </div>
              )}

              {/* Вкладка 1: Список обращений */}
              {view === 'list' && (
                <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5 max-h-[420px]">
                  <div className="flex items-center justify-between px-1 text-[11px] text-slate-400">
                    <span>
                      Активных: <b className="text-white">{meta.activeCount}</b> / {meta.maxOpen}
                    </span>
                    <a
                      href={meta.ownerUrl || OWNER_FALLBACK_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline"
                    >
                      👤 Написать владельцу
                    </a>
                  </div>

                  {loadingList ? (
                    <div className="py-12 flex justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-brand" />
                    </div>
                  ) : tickets.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-dark-border p-6 text-center space-y-3">
                      <p className="text-xs text-slate-400">У вас пока нет обращений в поддержку.</p>
                      <button
                        type="button"
                        onClick={() => setView('new')}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Задать вопрос</span>
                      </button>
                    </div>
                  ) : (
                    tickets.map((t) => {
                      const st = STATUS_BADGE[t.status] || STATUS_BADGE.open;
                      const tid = t._id || t.id;
                      return (
                        <button
                          key={tid}
                          type="button"
                          onClick={() => {
                            setSelectedTicketId(tid);
                            setView('chat');
                          }}
                          className="w-full text-left rounded-2xl bg-dark-surface/70 border border-dark-border p-3 hover:border-brand/50 transition-all space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-white font-mono">#{t.ticketNumber}</span>
                            <span className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>
                              {st.label}
                            </span>
                          </div>
                          <div className="text-xs text-slate-200 truncate">
                            {t.topicLabel || t.topic || 'Обращение'}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-400">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleString('ru-RU') : ''}
                            </span>
                            {t.rating ? (
                              <span className="text-amber-300 font-semibold">{'⭐'.repeat(t.rating)}</span>
                            ) : null}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}

              {/* Вкладка 2: Форма нового вопроса */}
              {view === 'new' && (
                <form onSubmit={handleCreateTicket} className="flex-1 overflow-y-auto p-4 space-y-3.5 max-h-[450px]">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">Тема обращения</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {TOPICS.map((tp) => (
                        <button
                          key={tp.id}
                          type="button"
                          onClick={() => setTopic(tp.id)}
                          className={`rounded-xl border px-2.5 py-2 text-xs font-semibold text-left transition-all ${
                            topic === tp.id
                              ? 'bg-brand/15 border-brand text-white'
                              : 'bg-dark-surface border-dark-border text-slate-300 hover:border-slate-500'
                          }`}
                        >
                          {tp.emoji} {tp.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {meta.recentOrders?.length > 0 && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5">
                        Выбрать заказ в 1 клик {topic === 'order' ? '(рекомендуется)' : '(необязательно)'}
                      </label>
                      <div className="flex flex-col gap-1.5 max-h-28 overflow-y-auto">
                        {meta.recentOrders.map((ord) => {
                          const oid = ord._id || ord.id;
                          const selected = String(orderId) === String(oid);
                          const title = ord.productName || ord.productId?.name || `Заказ #${String(oid).slice(-6)}`;
                          return (
                            <button
                              key={oid}
                              type="button"
                              onClick={() => setOrderId(selected ? '' : oid)}
                              className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] text-left transition-all ${
                                selected
                                  ? 'bg-brand/15 border-brand text-white'
                                  : 'bg-dark-surface/60 border-dark-border text-slate-300 hover:border-slate-500'
                              }`}
                            >
                              <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                                <Package className="h-3.5 w-3.5 shrink-0 text-brand" />
                                <span className="truncate">{title}</span>
                              </span>
                              <span className="font-mono text-emerald-400 shrink-0">
                                {Number(ord.price || 0).toFixed(2)}$
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">Сообщение</label>
                    <textarea
                      rows={3}
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                      placeholder="Опишите проблему или вопрос..."
                      className="w-full rounded-xl bg-dark-input border border-dark-border p-3 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                    />
                  </div>

                  <div className="space-y-2">
                    <input
                      ref={newFileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => handleImagePick(e, 'new')}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => newFileRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-dark-surface border border-dark-border px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-slate-500"
                      >
                        <ImagePlus className="h-3.5 w-3.5 text-brand" />
                        <span>Прикрепить фото</span>
                      </button>
                      {newImage && (
                        <button
                          type="button"
                          onClick={() => {
                            setNewImage(null);
                            setNewImageName('');
                          }}
                          className="text-[11px] text-rose-400 hover:underline truncate max-w-[170px]"
                        >
                          ✕ {newImageName || 'Убрать фото'}
                        </button>
                      )}
                    </div>
                    {newImage && (
                      <img
                        src={newImage}
                        alt="Предпросмотр"
                        className="h-20 w-auto rounded-xl border border-dark-border object-cover"
                      />
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={creating}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-xs font-bold text-white hover:bg-brand-hover disabled:opacity-50 btn-primary-glow"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    <span>{creating ? 'Отправка...' : 'Отправить обращение'}</span>
                  </button>
                </form>
              )}

              {/* Вкладка 3: Диалог тикета */}
              {view === 'chat' && (
                <div className="flex flex-1 flex-col min-h-[340px] max-h-[470px]">
                  {loadingTicket && !activeTicket ? (
                    <div className="flex flex-1 items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-brand" />
                    </div>
                  ) : !activeTicket ? (
                    <div className="flex flex-1 items-center justify-center p-4 text-xs text-slate-400">
                      Обращение не найдено
                    </div>
                  ) : (
                    <>
                      {/* Инфо-полоска тикета */}
                      <div className="flex items-center justify-between gap-2 border-b border-dark-border bg-dark-bg/50 px-3.5 py-2 text-[11px]">
                        <div className="min-w-0">
                          <span className="font-mono font-bold text-white">#{activeTicket.ticketNumber}</span>
                          <span className="text-slate-400 ml-2 truncate">
                            {activeTicket.topicLabel || activeTicket.topic}
                          </span>
                        </div>
                        <span
                          className={`shrink-0 rounded-lg border px-2 py-0.5 text-[10px] font-bold ${
                            (STATUS_BADGE[activeTicket.status] || STATUS_BADGE.open).cls
                          }`}
                        >
                          {(STATUS_BADGE[activeTicket.status] || STATUS_BADGE.open).label}
                        </span>
                      </div>

                      {/* История сообщений */}
                      <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                        {messages.map((m, idx) => {
                          const mid = m._id || m.id || idx;
                          const mediaSrc = getMediaSrc(m);

                          if (m.senderRole === 'system') {
                            return (
                              <div key={mid} className="text-center">
                                <span className="inline-block rounded-xl bg-dark-surface/80 border border-dark-border px-3 py-1 text-[10px] text-slate-400">
                                  {m.text}
                                </span>
                              </div>
                            );
                          }

                          const isUser = m.senderRole === 'user';
                          return (
                            <div key={mid} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                              <div className="text-[10px] text-slate-500 mb-0.5 px-1">
                                {isUser ? 'Вы' : 'Поддержка'} •{' '}
                                {m.createdAt ? new Date(m.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}
                              </div>
                              <div
                                className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                                  isUser
                                    ? 'bg-brand text-white rounded-br-sm'
                                    : 'bg-dark-surface border border-dark-border text-slate-100 rounded-bl-sm'
                                }`}
                              >
                                {mediaSrc && (
                                  <button
                                    type="button"
                                    onClick={() => setLightboxUrl(mediaSrc)}
                                    className="group relative mb-1.5 block overflow-hidden rounded-xl border border-white/10"
                                  >
                                    <img
                                      src={mediaSrc}
                                      alt="Вложение"
                                      className="max-h-40 w-auto object-contain"
                                    />
                                    <span className="absolute bottom-1 right-1 rounded-md bg-black/60 p-1 text-white opacity-80 group-hover:opacity-100">
                                      <Maximize2 className="h-3 w-3" />
                                    </span>
                                  </button>
                                )}
                                {m.text}
                              </div>
                            </div>
                          );
                        })}
                        <div ref={messagesEndRef} />
                      </div>

                      {/* Нижняя панель: ответ или оценка */}
                      {activeTicket.status !== 'closed' ? (
                        <form onSubmit={handleSendReply} className="border-t border-dark-border bg-dark-surface/50 p-3 space-y-2">
                          {replyImage && (
                            <div className="flex items-center justify-between rounded-xl bg-dark-card border border-dark-border px-2.5 py-1.5 text-[11px]">
                              <span className="truncate text-slate-300">📎 {replyImageName || 'Скриншот'}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setReplyImage(null);
                                  setReplyImageName('');
                                }}
                                className="text-rose-400 hover:underline ml-2"
                              >
                                Убрать
                              </button>
                            </div>
                          )}
                          <div className="flex items-end gap-1.5">
                            <input
                              ref={replyFileRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => handleImagePick(e, 'reply')}
                            />
                            <button
                              type="button"
                              onClick={() => replyFileRef.current?.click()}
                              title="Прикрепить фото"
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300 hover:text-white"
                            >
                              <ImagePlus className="h-4 w-4" />
                            </button>
                            <textarea
                              rows={1}
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder="Написать ответ..."
                              className="flex-1 resize-none rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                            />
                            <button
                              type="submit"
                              disabled={sendingReply}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                              aria-label="Отправить"
                            >
                              {sendingReply ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            </button>
                          </div>
                          <div className="flex justify-end">
                            <button
                              type="button"
                              disabled={closing}
                              onClick={handleCloseTicket}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span>{closing ? 'Закрытие...' : '✅ Вопрос решён'}</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="border-t border-dark-border bg-dark-surface/60 p-3 text-center space-y-2">
                          <div className="text-[11px] font-semibold text-slate-300">
                            {activeTicket.rating
                              ? `Ваша оценка: ${activeTicket.rating} из 5 ⭐`
                              : 'Обращение закрыто. Оцените работу поддержки:'}
                          </div>
                          <div className="flex items-center justify-center gap-1.5">
                            {[1, 2, 3, 4, 5].map((star) => {
                              const filled = activeTicket.rating
                                ? star <= activeTicket.rating
                                : star <= hoverStar;
                              return (
                                <button
                                  key={star}
                                  type="button"
                                  disabled={Boolean(activeTicket.rating) || ratingBusy}
                                  onMouseEnter={() => setHoverStar(star)}
                                  onMouseLeave={() => setHoverStar(0)}
                                  onClick={() => handleRate(star)}
                                  className="p-1 transition-transform hover:scale-110 disabled:hover:scale-100"
                                  aria-label={`Оценка ${star}`}
                                >
                                  <Star
                                    className={`h-5 w-5 ${
                                      filled ? 'fill-amber-400 text-amber-400' : 'text-slate-600'
                                    }`}
                                  />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Модальное увеличение фото */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 rounded-full bg-dark-card border border-dark-border p-2 text-white hover:bg-dark-surface"
            aria-label="Закрыть фото"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightboxUrl}
            alt="Увеличенное изображение"
            className="max-h-[88vh] max-w-[92vw] rounded-2xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

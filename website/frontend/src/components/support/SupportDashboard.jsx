'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Headphones,
  Users,
  Settings,
  RefreshCw,
  Hand,
  Send,
  ImagePlus,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Star,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  X,
  Plus,
  Trash2,
  Save,
  UserPlus,
  MessageSquare,
  Package,
  ShieldAlert,
  Zap,
  Unlink,
  Search,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { supportApi } from '../../lib/api';

const STAFF_ROLES = ['support', 'moderator', 'admin', 'superadmin'];
const MOD_ROLES = ['moderator', 'admin', 'superadmin'];
const ADMIN_ROLES = ['admin', 'superadmin'];

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_COMPRESSED_BYTES = 580 * 1024;

const STATUS_META = {
  open: { label: 'Ожидает', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  in_progress: { label: 'В работе', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  escalated: { label: 'Эскалация', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  closed: { label: 'Закрыт', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
};

const ROLE_LABELS = {
  superadmin: { label: '👑 SuperAdmin', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  admin: { label: '🔧 Admin', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  moderator: { label: '🛡 Модератор', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  support: { label: '🎧 Саппорт', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  user: { label: '👤 User', cls: 'bg-slate-800 text-slate-400 border-slate-700' },
};

const PERIODS = [
  { id: 'today', label: 'Сегодня' },
  { id: '7d', label: '7д' },
  { id: '30d', label: '30д' },
  { id: 'all', label: 'Всё время' },
];

function estimateDataUrlBytes(dataUrl) {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return dataUrl.length;
  return Math.ceil(((dataUrl.length - idx - 1) * 3) / 4);
}

async function compressImageFile(file) {
  if (!file) throw new Error('Файл не выбран');
  const mime = (file.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
    throw new Error('Разрешены только PNG, JPEG или WEBP');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось загрузить изображение'));
      el.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas недоступен');

    for (const maxDim of [1400, 1080, 820, 640]) {
      const ratio = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      if (mime === 'image/png' && maxDim === 1400) {
        const pngUrl = canvas.toDataURL('image/png');
        if (estimateDataUrlBytes(pngUrl) <= MAX_COMPRESSED_BYTES) return pngUrl;
      }
      const targetMime = mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
      for (const q of [0.85, 0.72, 0.58, 0.45]) {
        const out = canvas.toDataURL(targetMime, q);
        if (estimateDataUrlBytes(out) <= MAX_COMPRESSED_BYTES) return out;
      }
    }
    throw new Error('Размер изображения превышает 600KB после сжатия');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function formatDurationSec(sec) {
  if (sec === null || sec === undefined) return '—';
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}м ${rem}с` : `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}

function formatPerson(u, fallbackTgId = null) {
  if (!u && fallbackTgId == null) return 'Неизвестно';
  if (typeof u === 'object' && u !== null) {
    if (u.username) return `@${u.username}`;
    if (u.firstName) return u.firstName;
    if (u.telegramId != null) return `ID ${u.telegramId}`;
  }
  return fallbackTgId != null ? `ID ${fallbackTgId}` : 'Пользователь';
}

export default function SupportDashboard({ mode = 'standalone' }) {
  const auth = useAuth();
  const toast = useToast();
  const { user } = auth;

  const isSupport = auth.isSupport ?? STAFF_ROLES.includes(user?.role);
  const isModerator = auth.isModerator ?? MOD_ROLES.includes(user?.role);
  const isAdmin = auth.isAdmin ?? ADMIN_ROLES.includes(user?.role);
  const isSuperAdmin = auth.isSuperAdmin ?? user?.role === 'superadmin';

  const [mainTab, setMainTab] = useState('tickets'); // 'tickets' | 'team' | 'settings'
  const [lightboxUrl, setLightboxUrl] = useState(null);

  // ─── Вкладка 1: Тикеты ────────────────────────────────────────────
  const [onDuty, setOnDuty] = useState(user?.supportOnDuty !== false);
  const [dutyBusy, setDutyBusy] = useState(false);
  const [queueTab, setQueueTab] = useState('waiting');
  const [queuePage, setQueuePage] = useState(1);
  const [queueSearch, setQueueSearch] = useState('');
  const [debouncedQueueSearch, setDebouncedQueueSearch] = useState('');
  const [queueData, setQueueData] = useState({
    tickets: [],
    counts: { waiting: 0, mine: 0, escalated: 0, inProgress: 0, active: 0, closed: 0, onDutyCount: 0 },
    pagination: { page: 1, totalPages: 1, total: 0 },
  });
  const [quickReplies, setQuickReplies] = useState([]);
  const [loadingQueue, setLoadingQueue] = useState(true);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [replyImage, setReplyImage] = useState(null);
  const [replyImageName, setReplyImageName] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState('');

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  // ─── Вкладка 2: Команда и активность ──────────────────────────────
  const [team, setTeam] = useState([]);
  const [onDutyCount, setOnDutyCount] = useState(0);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState(null);
  const [statsPeriod, setStatsPeriod] = useState('30d');
  const [staffStats, setStaffStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);

  const [assignQuery, setAssignQuery] = useState('');
  const [assignRoleTarget, setAssignRoleTarget] = useState('support');
  const [assignReason, setAssignReason] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);

  const [auditLogs, setAuditLogs] = useState([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);

  // ─── Вкладка 3: Настройки и чат ───────────────────────────────────
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [canEditSettings, setCanEditSettings] = useState(false);
  const [supportSettings, setSupportSettings] = useState({
    supportChatId: '',
    supportChatTitle: '',
    supportSlaMinutes: '15',
    supportMaxOpenPerUser: '3',
    supportAutoCloseHours: '48',
    supportQuickReplies: [],
  });
  const [newQuickReply, setNewQuickReply] = useState('');

  // ─── Загрузка очередей и деталей ──────────────────────────────────
  useEffect(() => {
    const trimmed = queueSearch.trim();
    if (!trimmed) {
      setDebouncedQueueSearch('');
      setQueuePage(1);
      return undefined;
    }
    const timer = setTimeout(() => {
      setDebouncedQueueSearch(trimmed);
      setQueuePage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [queueSearch]);

  const loadQueues = useCallback(
    async (silent = false) => {
      if (!isSupport) return;
      try {
        if (!silent) setLoadingQueue(true);
        const res = await supportApi.getQueues({
          tab: queueTab,
          page: queuePage,
          ...(debouncedQueueSearch ? { search: debouncedQueueSearch } : {}),
        });
        if (res?.success) {
          const ticketsList = res.tickets || res.items || [];
          const pagRaw = res.pagination || {};
          const pag = {
            page: pagRaw.page || res.page || queuePage,
            totalPages: pagRaw.pages ?? pagRaw.totalPages ?? res.totalPages ?? 1,
            total: pagRaw.total ?? res.total ?? ticketsList.length,
          };
          setQueueData({
            tickets: ticketsList,
            counts: res.counts || { waiting: 0, mine: 0, escalated: 0, closed: 0, onDutyCount: 0 },
            pagination: pag,
          });
          if (res.onDuty !== undefined) setOnDuty(Boolean(res.onDuty));
          if (Array.isArray(res.quickReplies)) setQuickReplies(res.quickReplies);
        }
      } catch (err) {
        if (!silent) toast.error(err.message || 'Ошибка загрузки очереди');
      } finally {
        if (!silent) setLoadingQueue(false);
      }
    },
    [isSupport, queueTab, queuePage, debouncedQueueSearch, toast]
  );

  const loadTicketDetail = useCallback(
    async (tid, silent = false) => {
      if (!tid || !isSupport) return;
      try {
        if (!silent) setLoadingDetail(true);
        const res = await supportApi.getTicket(tid);
        if (res?.success && res.ticket) {
          setDetail({
            ticket: res.ticket,
            messages: res.messages || [],
            userOrdersCount: Number(res.userOrdersCount || 0),
            lastOrder: res.lastOrder || null,
          });
        }
      } catch (err) {
        if (!silent) toast.error(err.message || 'Не удалось загрузить тикет');
      } finally {
        if (!silent) setLoadingDetail(false);
      }
    },
    [isSupport, toast]
  );

  useEffect(() => {
    if (mainTab === 'tickets' && isSupport) {
      loadQueues();
    }
  }, [mainTab, isSupport, loadQueues]);

  useEffect(() => {
    if (mainTab === 'tickets' && selectedId) {
      setEscalateOpen(false);
      setEscalateReason('');
      loadTicketDetail(selectedId);
    }
  }, [mainTab, selectedId, loadTicketDetail]);

  // Авто-polling каждые 5 секунд для тикетов
  useEffect(() => {
    if (mainTab !== 'tickets' || !isSupport) return undefined;
    const timer = setInterval(() => {
      loadQueues(true);
      if (selectedId) loadTicketDetail(selectedId, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [mainTab, isSupport, selectedId, loadQueues, loadTicketDetail]);

  useEffect(() => {
    if (detail?.messages?.length && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail?.messages?.length]);

  // ─── Загрузка команды и аудита ────────────────────────────────────
  const loadTeamAndLogs = useCallback(async () => {
    if (!isModerator) return;
    try {
      setLoadingTeam(true);
      const [teamRes, logsRes] = await Promise.all([
        supportApi.getTeam(),
        supportApi.getAuditLogs({ page: auditPage }),
      ]);
      if (teamRes?.success) {
        const list = teamRes.team || teamRes.staff || [];
        setTeam(list);
        setOnDutyCount(Number(teamRes.onDutyCount ?? list.filter((m) => m.supportOnDuty !== false).length));
        if (!selectedStaffId && list.length > 0) {
          setSelectedStaffId(list[0]._id || list[0].id);
        }
      }
      if (logsRes?.success) {
        setAuditLogs(logsRes.items || logsRes.logs || []);
        setAuditTotalPages(logsRes.totalPages || logsRes.pagination?.totalPages || 1);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки команды');
    } finally {
      setLoadingTeam(false);
    }
  }, [isModerator, auditPage, selectedStaffId, toast]);

  const loadSelectedStaffStats = useCallback(async () => {
    if (!isModerator || !selectedStaffId) return;
    try {
      setLoadingStats(true);
      const res = await supportApi.getStaffStats(selectedStaffId, statsPeriod);
      if (res?.success) {
        setStaffStats(res.stats || res);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки статистики');
    } finally {
      setLoadingStats(false);
    }
  }, [isModerator, selectedStaffId, statsPeriod, toast]);

  useEffect(() => {
    if (mainTab === 'team' && isModerator) {
      loadTeamAndLogs();
    }
  }, [mainTab, isModerator, loadTeamAndLogs]);

  useEffect(() => {
    if (mainTab === 'team' && isModerator && selectedStaffId) {
      loadSelectedStaffStats();
    }
  }, [mainTab, isModerator, selectedStaffId, statsPeriod, loadSelectedStaffStats]);

  // ─── Загрузка настроек ────────────────────────────────────────────
  const loadSupportSettings = useCallback(async () => {
    if (!isModerator) return;
    try {
      setSettingsLoading(true);
      const res = await supportApi.getSupportSettings();
      if (res?.success) {
        const s = res.settings || res;
        setCanEditSettings(Boolean(res.canEditSettings ?? s.canEditSettings ?? isAdmin));
        setSupportSettings({
          supportChatId: s.supportChatId != null ? String(s.supportChatId) : '',
          supportChatTitle: s.supportChatTitle || '',
          supportSlaMinutes: String(s.supportSlaMinutes ?? 15),
          supportMaxOpenPerUser: String(s.supportMaxOpenPerUser ?? 3),
          supportAutoCloseHours: String(s.supportAutoCloseHours ?? 48),
          supportQuickReplies: Array.isArray(s.supportQuickReplies) ? s.supportQuickReplies : [],
        });
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка загрузки настроек саппорта');
    } finally {
      setSettingsLoading(false);
    }
  }, [isModerator, isAdmin, toast]);

  useEffect(() => {
    if (mainTab === 'settings' && isModerator) {
      loadSupportSettings();
    }
  }, [mainTab, isModerator, loadSupportSettings]);

  // ─── Действия по тикетам ──────────────────────────────────────────
  const handleToggleDuty = async () => {
    try {
      setDutyBusy(true);
      const res = await supportApi.toggleDuty();
      if (res?.success) {
        const next = Boolean(res.onDuty ?? res.supportOnDuty);
        setOnDuty(next);
        toast.success(next ? 'Вы вышли на смену 🟢' : 'Вы перешли в оффлайн 🔴');
        loadQueues(true);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось сменить статус смены');
    } finally {
      setDutyBusy(false);
    }
  };

  const handleTakeTicket = async () => {
    if (!selectedId) return;
    try {
      setActionBusy(true);
      const res = await supportApi.takeTicket(selectedId);
      if (res?.success) {
        toast.success('Тикет взят в работу');
        await Promise.all([loadQueues(true), loadTicketDetail(selectedId, true)]);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось взять тикет');
      loadQueues(true);
    } finally {
      setActionBusy(false);
    }
  };

  const handlePickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setReplyImage(compressed);
      setReplyImageName(file.name);
    } catch (err) {
      toast.error(err.message || 'Ошибка изображения');
    }
  };

  const handleStaffReply = async (e, overrideText = null) => {
    if (e) e.preventDefault();
    if (!selectedId) return;
    const textToSend = (overrideText !== null ? overrideText : replyText).trim();
    const imageToSend = overrideText !== null ? null : replyImage;
    if (!textToSend && !imageToSend) {
      toast.error('Введите текст ответа или прикрепите фото');
      return;
    }
    try {
      setActionBusy(true);
      const res = await supportApi.staffReply(selectedId, {
        text: textToSend,
        imageBase64: imageToSend || null,
      });
      if (res?.success) {
        if (overrideText === null) {
          setReplyText('');
          setReplyImage(null);
          setReplyImageName('');
        }
        toast.success('Ответ отправлен');
        await Promise.all([loadQueues(true), loadTicketDetail(selectedId, true)]);
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось отправить ответ');
    } finally {
      setActionBusy(false);
    }
  };

  const handleEscalate = async (e) => {
    e.preventDefault();
    if (!selectedId) return;
    try {
      setActionBusy(true);
      const res = await supportApi.staffEscalate(
        selectedId,
        escalateReason.trim() || 'Требуется помощь модератора/администратора'
      );
      if (res?.success) {
        toast.success('Тикет эскалирован модераторам/админам');
        setEscalateOpen(false);
        setEscalateReason('');
        await Promise.all([loadQueues(true), loadTicketDetail(selectedId, true)]);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка эскалации');
    } finally {
      setActionBusy(false);
    }
  };

  const handleStaffClose = async () => {
    if (!selectedId) return;
    try {
      setActionBusy(true);
      const res = await supportApi.staffClose(selectedId);
      if (res?.success) {
        toast.success('Обращение закрыто');
        await Promise.all([loadQueues(true), loadTicketDetail(selectedId, true)]);
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка закрытия тикета');
    } finally {
      setActionBusy(false);
    }
  };

  // ─── Управление ролями команды ────────────────────────────────────
  const allowedRoleTargets = isSuperAdmin
    ? [
        { id: 'support', label: '🎧 Саппорт' },
        { id: 'moderator', label: '🛡 Модератор' },
        { id: 'admin', label: '🔧 Admin' },
        { id: 'user', label: '👤 Снять до User' },
      ]
    : isAdmin
    ? [
        { id: 'support', label: '🎧 Саппорт' },
        { id: 'moderator', label: '🛡 Модератор' },
        { id: 'user', label: '👤 Снять до User' },
      ]
    : [
        { id: 'support', label: '🎧 Назначить Саппортом' },
        { id: 'user', label: '👤 Снять до User' },
      ];

  const canModifyMember = (member) => {
    if (!member || String(member._id || member.id) === String(user?._id || user?.id)) return false;
    if (member.role === 'superadmin') return false;
    if (isSuperAdmin) return true;
    if (isAdmin) return ['user', 'support', 'moderator'].includes(member.role);
    if (isModerator) return ['user', 'support'].includes(member.role);
    return false;
  };

  const handleAssignRole = async (e, explicitQuery = null, explicitRole = null) => {
    if (e) e.preventDefault();
    const queryOrId = (explicitQuery ?? assignQuery).trim();
    const role = explicitRole ?? assignRoleTarget;
    if (!queryOrId) {
      toast.error('Укажите @username или Telegram ID');
      return;
    }
    try {
      setAssignBusy(true);
      const res = await supportApi.assignRole({
        queryOrId,
        role,
        reason: assignReason.trim(),
      });
      if (res?.success) {
        toast.success(`Роль обновлена на ${role}`);
        if (!explicitQuery) {
          setAssignQuery('');
          setAssignReason('');
        }
        await loadTeamAndLogs();
      }
    } catch (err) {
      toast.error(err.message || 'Не удалось изменить роль');
    } finally {
      setAssignBusy(false);
    }
  };

  // ─── Сохранение настроек ──────────────────────────────────────────
  const handleSaveSettings = async (e, overrideChatId = undefined) => {
    if (e) e.preventDefault();
    if (!isAdmin) return;

    const rawChat = overrideChatId !== undefined ? overrideChatId : supportSettings.supportChatId.trim();
    let parsedChatId = null;
    if (rawChat !== '' && rawChat !== null) {
      const n = Number(rawChat);
      if (!Number.isInteger(n) || n >= 0) {
        toast.error('Chat ID группы должен быть отрицательным числом (например, -1001234567890)');
        return;
      }
      parsedChatId = n;
    }

    try {
      setSettingsSaving(true);
      const res = await supportApi.updateSupportSettings({
        supportChatId: parsedChatId,
        supportSlaMinutes: Math.max(1, parseInt(supportSettings.supportSlaMinutes, 10) || 15),
        supportMaxOpenPerUser: Math.max(1, parseInt(supportSettings.supportMaxOpenPerUser, 10) || 3),
        supportAutoCloseHours: Math.max(1, parseInt(supportSettings.supportAutoCloseHours, 10) || 48),
        supportQuickReplies: supportSettings.supportQuickReplies.filter((q) => q.trim().length > 0),
      });
      if (res?.success) {
        toast.success(overrideChatId === null ? 'Чат саппортов отключён' : 'Настройки поддержки сохранены');
        await loadSupportSettings();
      }
    } catch (err) {
      toast.error(err.message || 'Ошибка сохранения настроек');
    } finally {
      setSettingsSaving(false);
    }
  };

  if (!isSupport) {
    return (
      <div className="rounded-2xl bg-dark-card border border-dark-border p-8 text-center text-sm text-slate-400">
        Доступ разрешён только сотрудникам поддержки.
      </div>
    );
  }

  const activeTicket = detail?.ticket || null;
  const messages = detail?.messages || [];
  const counts = queueData.counts || {};

  const activeCount =
    counts.active ?? (counts.waiting || 0) + (counts.inProgress || 0) + (counts.escalated || 0);

  const queueTabs = [
    { id: 'waiting', label: 'Ожидают', count: counts.waiting || 0 },
    { id: 'mine', label: 'Мои в работе', count: counts.mine || 0 },
    ...(isModerator
      ? [
          { id: 'escalated', label: 'Эскалация', count: counts.escalated || 0 },
          { id: 'all', label: 'Все активные', count: activeCount },
        ]
      : []),
    { id: 'closed', label: 'Закрытые', count: counts.closed || 0 },
  ];

  const getMediaSrc = (m) => {
    if (m?.mediaUrl) return m.mediaUrl;
    const tid = activeTicket?._id || activeTicket?.id || selectedId;
    const mid = m?._id || m?.id;
    if (m?.hasMedia && tid && mid) return supportApi.getMediaUrl(tid, mid);
    return null;
  };

  return (
    <div className="space-y-5">
      {/* Верхняя панель вкладок + статус смены */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-dark-card border border-dark-border p-1.5">
          <button
            type="button"
            onClick={() => setMainTab('tickets')}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
              mainTab === 'tickets' ? 'bg-brand text-white' : 'text-slate-300 hover:text-white'
            }`}
          >
            <Headphones className="h-3.5 w-3.5" />
            <span>Тикеты</span>
            {(counts.waiting || 0) + (isModerator ? counts.escalated || 0 : 0) > 0 && (
              <span className="rounded-full bg-black/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {(counts.waiting || 0) + (isModerator ? counts.escalated || 0 : 0)}
              </span>
            )}
          </button>

          {isModerator && (
            <button
              type="button"
              onClick={() => setMainTab('team')}
              className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                mainTab === 'team' ? 'bg-brand text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              <span>Команда и активность</span>
            </button>
          )}

          {isModerator && (
            <button
              type="button"
              onClick={() => setMainTab('settings')}
              className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                mainTab === 'settings' ? 'bg-brand text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Настройки и чат</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {mode === 'admin_embedded' && (
            <span className="hidden xl:inline-flex items-center rounded-xl bg-dark-card border border-dark-border px-3 py-2 text-[11px] text-slate-400">
              На смене сейчас: <b className="ml-1 text-emerald-400">{counts.onDutyCount ?? 0}</b>
            </span>
          )}
          <button
            type="button"
            disabled={dutyBusy}
            onClick={handleToggleDuty}
            className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-bold transition-all ${
              onDuty
                ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-rose-500/15 border-rose-500/35 text-rose-300 hover:bg-rose-500/25'
            }`}
          >
            <span>{onDuty ? '🟢 На смене' : '🔴 Оффлайн'}</span>
          </button>
        </div>
      </div>

      {/* ═══════════════ ВКЛАДКА 1: ТИКЕТЫ ═══════════════ */}
      {mainTab === 'tickets' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {queueTabs.map((qt) => (
                <button
                  key={qt.id}
                  type="button"
                  onClick={() => {
                    setQueueTab(qt.id);
                    setQueuePage(1);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                    queueTab === qt.id
                      ? 'bg-brand/15 border-brand text-white'
                      : 'bg-dark-card border-dark-border text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <span>{qt.label}</span>
                  <span className="rounded-md bg-dark-surface px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                    {qt.count}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-60">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                <input
                  type="text"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  placeholder="#SUP-..., @username или TG ID"
                  className="w-full rounded-xl bg-dark-card border border-dark-border py-1.5 pl-8 pr-7 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                />
                {queueSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setQueueSearch('');
                      setDebouncedQueueSearch('');
                      setQueuePage(1);
                    }}
                    aria-label="Очистить поиск"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  loadQueues();
                  if (selectedId) loadTicketDetail(selectedId);
                }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Обновить</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Список очереди */}
            <div className="lg:col-span-5 rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
              {loadingQueue ? (
                <div className="p-10 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : queueData.tickets.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">В этой очереди пока пусто</div>
              ) : (
                <div className="divide-y divide-dark-border/60 max-h-[620px] overflow-y-auto">
                  {queueData.tickets.map((t) => {
                    const tid = t._id || t.id;
                    const active = String(selectedId) === String(tid);
                    const st = STATUS_META[t.status] || STATUS_META.open;
                    return (
                      <button
                        key={tid}
                        type="button"
                        onClick={() => setSelectedId(tid)}
                        className={`w-full text-left p-3.5 transition-colors space-y-1.5 ${
                          active ? 'bg-brand/10 border-l-2 border-l-brand' : 'hover:bg-dark-surface/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold text-white">#{t.ticketNumber}</span>
                          <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>
                            {st.label}
                          </span>
                        </div>
                        <div className="text-xs font-medium text-slate-200 truncate">
                          {t.topicLabel || t.topic}
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span className="truncate">{formatPerson(t.user || t.userId, t.telegramId)}</span>
                          <span className="shrink-0 inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {t.lastMessageAt
                              ? new Date(t.lastMessageAt).toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : ''}
                          </span>
                        </div>
                        {t.assignedTo && (
                          <div className="text-[10px] text-sky-400 truncate">
                            Исполнитель: {formatPerson(t.assignedTo, t.assignedTelegramId)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {queueData.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-dark-border px-3.5 py-2.5 text-xs">
                  <span className="text-slate-400">
                    Стр. {queueData.pagination.page} / {queueData.pagination.totalPages}
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={queuePage <= 1}
                      onClick={() => setQueuePage((p) => Math.max(1, p - 1))}
                      className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={queuePage >= queueData.pagination.totalPages}
                      onClick={() => setQueuePage((p) => p + 1)}
                      className="rounded-lg bg-dark-surface border border-dark-border p-1.5 text-slate-300 disabled:opacity-40"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Карточка тикета и диалог */}
            <div className="lg:col-span-7 rounded-2xl bg-dark-card border border-dark-border overflow-hidden">
              {!selectedId ? (
                <div className="p-12 text-center text-xs text-slate-500">
                  Выберите обращение слева, чтобы просмотреть диалог и ответить покупателю.
                </div>
              ) : loadingDetail && !activeTicket ? (
                <div className="p-12 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : !activeTicket ? (
                <div className="p-12 text-center text-xs text-slate-500">Тикет не найден</div>
              ) : (
                <div className="flex flex-col">
                  {/* Информация о клиенте и заказе (строго без балансов) */}
                  <div className="border-b border-dark-border bg-dark-surface/60 p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold text-white">
                            #{activeTicket.ticketNumber}
                          </span>
                          <span
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${
                              (STATUS_META[activeTicket.status] || STATUS_META.open).cls
                            }`}
                          >
                            {(STATUS_META[activeTicket.status] || STATUS_META.open).label}
                          </span>
                        </div>
                        <div className="text-xs text-slate-300 mt-0.5">
                          {activeTicket.topicLabel || activeTicket.topic}
                        </div>
                      </div>

                      <div className="text-right text-[11px] text-slate-400">
                        <div>
                          Покупатель:{' '}
                          <b className="text-white">
                            {formatPerson(activeTicket.user || activeTicket.userId, activeTicket.telegramId)}
                          </b>
                        </div>
                        <div className="font-mono">TG ID: {activeTicket.telegramId}</div>
                        <div>Заказов у клиента: {detail.userOrdersCount}</div>
                      </div>
                    </div>

                    {(activeTicket.orderId || detail.lastOrder) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        {activeTicket.orderId && (
                          <div className="rounded-xl bg-dark-card border border-dark-border px-3 py-2 flex items-center gap-2">
                            <Package className="h-4 w-4 text-brand shrink-0" />
                            <div className="min-w-0">
                              <div className="text-slate-400">Привязанный заказ</div>
                              <div className="text-white font-semibold truncate">
                                {activeTicket.orderId.productName || activeTicket.orderId.productId?.name || 'Товар'} •{' '}
                                {Number(activeTicket.orderId.price || 0).toFixed(2)} $ ({activeTicket.orderId.status})
                              </div>
                            </div>
                          </div>
                        )}
                        {detail.lastOrder && (
                          <div className="rounded-xl bg-dark-card border border-dark-border px-3 py-2 flex items-center gap-2">
                            <Package className="h-4 w-4 text-slate-400 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-slate-400">Последний заказ</div>
                              <div className="text-slate-200 truncate">
                                {detail.lastOrder.productName || detail.lastOrder.productId?.name || 'Товар'} •{' '}
                                {Number(detail.lastOrder.price || 0).toFixed(2)} $ ({detail.lastOrder.status})
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Действия */}
                    {activeTicket.status !== 'closed' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {(!activeTicket.assignedTo ||
                          activeTicket.status === 'open' ||
                          (activeTicket.status === 'escalated' && isModerator)) && (
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={handleTakeTicket}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                          >
                            <Hand className="h-3.5 w-3.5" />
                            <span>✋ Взять в работу</span>
                          </button>
                        )}

                        {activeTicket.status !== 'escalated' && (
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => setEscalateOpen((v) => !v)}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500/15 border border-rose-500/35 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            <span>🔺 Передать модератору/админу</span>
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={handleStaffClose}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/35 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>✅ Закрыть</span>
                        </button>
                      </div>
                    )}

                    {escalateOpen && activeTicket.status !== 'closed' && (
                      <form onSubmit={handleEscalate} className="flex flex-col sm:flex-row gap-2 pt-1">
                        <input
                          type="text"
                          value={escalateReason}
                          onChange={(e) => setEscalateReason(e.target.value)}
                          placeholder="Причина эскалации (необязательно)..."
                          className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-1.5 text-xs text-white focus:border-rose-400 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={actionBusy}
                          className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                        >
                          Передать
                        </button>
                      </form>
                    )}
                  </div>

                  {/* Сообщения */}
                  <div className="p-4 space-y-3 max-h-[380px] overflow-y-auto bg-dark-bg/30">
                    {messages.map((m, idx) => {
                      const mid = m._id || m.id || idx;
                      const mediaSrc = getMediaSrc(m);

                      if (m.senderRole === 'system') {
                        return (
                          <div key={mid} className="text-center">
                            <span className="inline-block rounded-xl bg-dark-surface border border-dark-border px-3 py-1 text-[11px] text-slate-400">
                              {m.text}
                            </span>
                          </div>
                        );
                      }

                      const isBuyer = m.senderRole === 'user';
                      return (
                        <div key={mid} className={`flex flex-col ${isBuyer ? 'items-start' : 'items-end'}`}>
                          <div className="text-[10px] text-slate-500 mb-0.5 px-1">
                            {isBuyer
                              ? `Клиент (${formatPerson(m.sender || m.senderId, m.senderTelegramId)})`
                              : `${formatPerson(m.sender || m.senderId, m.senderTelegramId)} (${m.senderRole})`}{' '}
                            •{' '}
                            {m.createdAt
                              ? new Date(m.createdAt).toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : ''}
                          </div>
                          <div
                            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                              isBuyer
                                ? 'bg-dark-surface border border-dark-border text-slate-100 rounded-bl-sm'
                                : 'bg-brand text-white rounded-br-sm'
                            }`}
                          >
                            {mediaSrc && (
                              <button
                                type="button"
                                onClick={() => setLightboxUrl(mediaSrc)}
                                className="group relative mb-1.5 block overflow-hidden rounded-xl border border-white/10"
                              >
                                <img src={mediaSrc} alt="Вложение" className="max-h-44 w-auto object-contain" />
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

                  {/* Форма ответа + быстрые шаблоны */}
                  {activeTicket.status !== 'closed' ? (
                    <form onSubmit={(e) => handleStaffReply(e)} className="border-t border-dark-border p-4 space-y-3 bg-dark-surface/40">
                      {quickReplies.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            Быстрые шаблоны (клик — вставить, ⚡ — отправить сразу)
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {quickReplies.map((tpl, idx) => (
                              <div
                                key={idx}
                                className="inline-flex items-center rounded-xl bg-dark-card border border-dark-border overflow-hidden text-[11px]"
                              >
                                <button
                                  type="button"
                                  onClick={() => setReplyText(tpl)}
                                  title={tpl}
                                  className="px-2.5 py-1 text-slate-200 hover:text-white hover:bg-dark-surface max-w-[220px] truncate"
                                >
                                  {tpl}
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusy}
                                  onClick={() => handleStaffReply(null, tpl)}
                                  title="Отправить шаблон в 1 клик"
                                  className="border-l border-dark-border px-2 py-1 text-brand hover:bg-brand/15"
                                >
                                  <Zap className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {replyImage && (
                        <div className="flex items-center justify-between rounded-xl bg-dark-card border border-dark-border px-3 py-1.5 text-xs">
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

                      <div className="flex items-end gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={handlePickImage}
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          title="Прикрепить фото"
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-dark-card border border-dark-border text-slate-300 hover:text-white"
                        >
                          <ImagePlus className="h-4 w-4" />
                        </button>
                        <textarea
                          rows={2}
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="Ответ покупателю (синхронизируется с Telegram-ботом)..."
                          className="flex-1 rounded-xl bg-dark-input border border-dark-border p-2.5 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={actionBusy}
                          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand px-4 text-xs font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                        >
                          {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          <span className="hidden sm:inline">Отправить</span>
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="border-t border-dark-border bg-dark-surface/40 p-3 text-center text-xs text-slate-400">
                      Тикет закрыт{activeTicket.rating ? ` • Оценка клиента: ${activeTicket.rating} ⭐` : ''}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ ВКЛАДКА 2: КОМАНДА И АКТИВНОСТЬ ═══════════════ */}
      {mainTab === 'team' && isModerator && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Состав команды */}
            <div className="lg:col-span-6 rounded-2xl bg-dark-card border border-dark-border p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">Команда поддержки ({team.length})</h3>
                  <p className="text-[11px] text-slate-400">
                    На смене сейчас: <b className="text-emerald-400">{onDutyCount}</b>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadTeamAndLogs}
                  className="rounded-xl bg-dark-surface border border-dark-border p-2 text-slate-300 hover:text-white"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              {loadingTeam ? (
                <div className="py-10 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : (
                <div className="space-y-2 max-h-[380px] overflow-y-auto">
                  {team.map((m) => {
                    const mid = m._id || m.id;
                    const selected = String(selectedStaffId) === String(mid);
                    const rb = ROLE_LABELS[m.role] || ROLE_LABELS.user;
                    const duty = m.supportOnDuty !== false;
                    return (
                      <div
                        key={mid}
                        onClick={() => setSelectedStaffId(mid)}
                        className={`cursor-pointer rounded-xl border p-3 flex items-center justify-between gap-2 transition-all ${
                          selected
                            ? 'bg-brand/10 border-brand'
                            : 'bg-dark-surface/60 border-dark-border hover:border-slate-500'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span>{duty ? '🟢' : '🔴'}</span>
                            <span className="text-xs font-bold text-white truncate">
                              {formatPerson(m, m.telegramId)}
                            </span>
                            <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${rb.cls}`}>
                              {rb.label}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                            TG: {m.telegramId}
                            {m.supportLastActiveAt
                              ? ` • Активен: ${new Date(m.supportLastActiveAt).toLocaleString('ru-RU')}`
                              : ''}
                          </div>
                        </div>

                        {canModifyMember(m) && (
                          <button
                            type="button"
                            disabled={assignBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAssignRole(null, String(m.telegramId), 'user');
                            }}
                            className="shrink-0 rounded-lg bg-rose-500/15 border border-rose-500/30 px-2.5 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/25"
                          >
                            Снять
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Статистика выбранного сотрудника + назначение */}
            <div className="lg:col-span-6 space-y-5">
              <div className="rounded-2xl bg-dark-card border border-dark-border p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-white">Активность сотрудника</h3>
                  <div className="flex items-center gap-1 rounded-xl bg-dark-surface p-1">
                    {PERIODS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setStatsPeriod(p.id)}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${
                          statsPeriod === p.id ? 'bg-brand text-white' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {loadingStats ? (
                  <div className="py-8 flex justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-brand" />
                  </div>
                ) : !staffStats ? (
                  <div className="py-6 text-center text-xs text-slate-500">Выберите сотрудника слева</div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Взято тикетов</div>
                      <div className="text-lg font-extrabold text-white mt-0.5 tabular-nums">
                        {staffStats.takenCount ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Закрыто</div>
                      <div className="text-lg font-extrabold text-emerald-400 mt-0.5 tabular-nums">
                        {staffStats.closedCount ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Ответов</div>
                      <div className="text-lg font-extrabold text-sky-400 mt-0.5 tabular-nums">
                        {staffStats.repliesCount ?? 0}
                      </div>
                    </div>
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Среднее время ответа</div>
                      <div className="text-base font-bold text-white mt-0.5">
                        {formatDurationSec(staffStats.avgFirstResponseSec)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Средний рейтинг</div>
                      <div className="text-base font-bold text-amber-300 mt-0.5 flex items-center gap-1">
                        <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                        <span>
                          {staffStats.avgRating != null ? `${staffStats.avgRating} (${staffStats.ratedCount || 0})` : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="rounded-xl bg-dark-surface border border-dark-border p-3">
                      <div className="text-slate-400 text-[11px]">Эскалаций</div>
                      <div className="text-lg font-extrabold text-rose-300 mt-0.5 tabular-nums">
                        {staffStats.escalatedFromCount ?? 0}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Назначение / снятие роли */}
              <form onSubmit={(e) => handleAssignRole(e)} className="rounded-2xl bg-dark-card border border-dark-border p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <UserPlus className="h-4 w-4 text-brand" />
                  <span>Назначить или снять сотрудника</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={assignQuery}
                    onChange={(e) => setAssignQuery(e.target.value)}
                    placeholder="@username или Telegram ID"
                    className="rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                  />
                  <input
                    type="text"
                    value={assignReason}
                    onChange={(e) => setAssignReason(e.target.value)}
                    placeholder="Причина (в аудит-лог)"
                    className="rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-brand focus:outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {allowedRoleTargets.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setAssignRoleTarget(opt.id)}
                      className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                        assignRoleTarget === opt.id
                          ? 'bg-brand border-brand text-white'
                          : 'bg-dark-surface border-dark-border text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="submit"
                  disabled={assignBusy}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {assignBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                  <span>Применить роль</span>
                </button>
              </form>
            </div>
          </div>

          {/* Аудит-лог назначений */}
          <div className="rounded-2xl bg-dark-card border border-dark-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Журнал назначений (StaffAuditLog)</h3>
              {auditTotalPages > 1 && (
                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    disabled={auditPage <= 1}
                    onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                    className="rounded-lg bg-dark-surface border border-dark-border p-1 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-slate-400">
                    {auditPage} / {auditTotalPages}
                  </span>
                  <button
                    type="button"
                    disabled={auditPage >= auditTotalPages}
                    onClick={() => setAuditPage((p) => p + 1)}
                    className="rounded-lg bg-dark-surface border border-dark-border p-1 disabled:opacity-40"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {auditLogs.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">Записей пока нет</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-dark-surface text-slate-400 uppercase text-[10px]">
                    <tr>
                      <th className="p-2.5">Дата</th>
                      <th className="p-2.5">Кто изменил</th>
                      <th className="p-2.5">Кому</th>
                      <th className="p-2.5">Роль</th>
                      <th className="p-2.5">Причина</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-border/60">
                    {auditLogs.map((log, i) => (
                      <tr key={log._id || i}>
                        <td className="p-2.5 text-slate-400 whitespace-nowrap">
                          {log.createdAt ? new Date(log.createdAt).toLocaleString('ru-RU') : ''}
                        </td>
                        <td className="p-2.5 text-slate-200">
                          {formatPerson(log.actorUser || log.actorUserId, log.actorTelegramId)}
                        </td>
                        <td className="p-2.5 text-white font-semibold">
                          {formatPerson(log.targetUser || log.targetUserId, log.targetTelegramId)}
                        </td>
                        <td className="p-2.5 whitespace-nowrap">
                          <span className="text-slate-400">{log.oldRole}</span>
                          <span className="mx-1.5 text-slate-600">→</span>
                          <span className="font-bold text-brand">{log.newRole}</span>
                        </td>
                        <td className="p-2.5 text-slate-300">{log.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════ ВКЛАДКА 3: НАСТРОЙКИ И ЧАТ ═══════════════ */}
      {mainTab === 'settings' && isModerator && (
        <div className="space-y-5">
          {!canEditSettings && (
            <div className="flex items-center gap-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-xs text-amber-200">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                Режим только для чтения. Изменять Telegram-чат саппортов, SLA и быстрые шаблоны могут только
                администраторы.
              </span>
            </div>
          )}

          {settingsLoading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
            </div>
          ) : (
            <form onSubmit={(e) => handleSaveSettings(e)} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Подключение чата и SLA */}
              <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <MessageSquare className="h-4 w-4 text-brand" />
                  <span>Telegram-чат саппортов и лимиты</span>
                </div>

                <div className="rounded-xl bg-dark-surface/70 border border-dark-border p-3.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-400">Статус чата:</span>
                    {supportSettings.supportChatId ? (
                      <span className="font-bold text-emerald-400">
                        Подключён ({supportSettings.supportChatTitle || supportSettings.supportChatId})
                      </span>
                    ) : (
                      <span className="text-amber-300 font-semibold">Не подключён</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Вы можете привязать группу прямо из Telegram командой <code className="text-white">/set_support_chat</code>{' '}
                    или указать отрицательный Chat ID группы (например <code className="text-white">-1001234567890</code>).
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Telegram Chat ID (&lt; 0)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      disabled={!canEditSettings}
                      value={supportSettings.supportChatId}
                      onChange={(e) => setSupportSettings((s) => ({ ...s, supportChatId: e.target.value }))}
                      placeholder="-100..."
                      className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs font-mono text-white disabled:opacity-60 focus:border-brand focus:outline-none"
                    />
                    {canEditSettings && supportSettings.supportChatId && (
                      <button
                        type="button"
                        disabled={settingsSaving}
                        onClick={() => handleSaveSettings(null, null)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-rose-500/15 border border-rose-500/35 px-3 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/25"
                      >
                        <Unlink className="h-3.5 w-3.5" />
                        <span>Отключить чат</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">SLA (минут)</label>
                    <input
                      type="number"
                      min="1"
                      disabled={!canEditSettings}
                      value={supportSettings.supportSlaMinutes}
                      onChange={(e) => setSupportSettings((s) => ({ ...s, supportSlaMinutes: e.target.value }))}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs font-mono text-white disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Макс. открытых / юзер</label>
                    <input
                      type="number"
                      min="1"
                      disabled={!canEditSettings}
                      value={supportSettings.supportMaxOpenPerUser}
                      onChange={(e) => setSupportSettings((s) => ({ ...s, supportMaxOpenPerUser: e.target.value }))}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs font-mono text-white disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Автозакрытие (ч)</label>
                    <input
                      type="number"
                      min="1"
                      disabled={!canEditSettings}
                      value={supportSettings.supportAutoCloseHours}
                      onChange={(e) => setSupportSettings((s) => ({ ...s, supportAutoCloseHours: e.target.value }))}
                      className="w-full rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs font-mono text-white disabled:opacity-60"
                    />
                  </div>
                </div>

                {canEditSettings && (
                  <button
                    type="submit"
                    disabled={settingsSaving}
                    className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    {settingsSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    <span>Сохранить настройки</span>
                  </button>
                )}
              </div>

              {/* Быстрые шаблоны */}
              <div className="rounded-2xl bg-dark-card border border-dark-border p-5 space-y-4">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <Zap className="h-4 w-4 text-brand" />
                  <span>Быстрые шаблоны ответов</span>
                </div>

                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {supportSettings.supportQuickReplies.map((tpl, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        disabled={!canEditSettings}
                        value={tpl}
                        onChange={(e) => {
                          const next = [...supportSettings.supportQuickReplies];
                          next[idx] = e.target.value;
                          setSupportSettings((s) => ({ ...s, supportQuickReplies: next }));
                        }}
                        className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-white disabled:opacity-60"
                      />
                      {canEditSettings && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = supportSettings.supportQuickReplies.filter((_, i) => i !== idx);
                            setSupportSettings((s) => ({ ...s, supportQuickReplies: next }));
                          }}
                          className="rounded-xl bg-rose-500/15 border border-rose-500/30 p-2 text-rose-300 hover:bg-rose-500/25"
                          aria-label="Удалить шаблон"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {canEditSettings && (
                  <div className="flex gap-2 pt-1">
                    <input
                      type="text"
                      value={newQuickReply}
                      onChange={(e) => setNewQuickReply(e.target.value)}
                      placeholder="Добавить новый быстрый ответ..."
                      className="flex-1 rounded-xl bg-dark-input border border-dark-border px-3 py-2 text-xs text-white placeholder-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const val = newQuickReply.trim();
                        if (!val) return;
                        setSupportSettings((s) => ({
                          ...s,
                          supportQuickReplies: [...s.supportQuickReplies, val],
                        }));
                        setNewQuickReply('');
                      }}
                      className="inline-flex items-center gap-1 rounded-xl bg-dark-surface border border-dark-border px-3 py-2 text-xs font-semibold text-white hover:border-brand"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Добавить</span>
                    </button>
                  </div>
                )}
              </div>
            </form>
          )}
        </div>
      )}

      {/* Увеличение фото */}
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
            alt="Вложение"
            className="max-h-[88vh] max-w-[92vw] rounded-2xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

import manifest from './brandIconsManifest.json';

/**
 * Карта метаданных и цветов брендов для иконок и монограмм-бейджей.
 */
export const BRAND_COLORS = {
  openai: '#10A37F',
  claude: '#D97757',
  grok: '#E2E8F0',
  gemini: '#4E86F7',
  deepseek: '#4D6BFE',
  qwen: '#6366F1',
  kimi: '#38BDF8',
  minimax: '#F43F5E',
  perplexity: '#20B2AA',
  copilot: '#A78BFA',
  openrouter: '#818CF8',
  elevenlabs: '#F8FAFC',
  cursor: '#E2E8F0',
  kling: '#10B981',
  runway: '#E2E8F0',
  suno: '#F59E0B',
  heygen: '#6366F1',
  higgsfield: '#EC4899',
  leonardo: '#A855F7',
  krea: '#3B82F6',
  gamma: '#8B5CF6',
  genspark: '#06B6D4',
  manus: '#E2E8F0',
  lovable: '#EC4899',
  bolt: '#38BDF8',
  replit: '#F26207',
  n8n: '#EA4B71',
  openart: '#F97316',
  dreamina: '#22D3EE',
  seedance: '#3B82F6',
  veo: '#4E86F7',
  kiro: '#8B5CF6',
  akool: '#6366F1',
  museai: '#A855F7',
  elser: '#EC4899',
  cutyai: '#F43F5E',
  magica: '#8B5CF6',
  tryclico: '#14B8A6',
  wispr: '#38BDF8',
  granola: '#84CC16',
  pippit: '#22D3EE',
  framer: '#0055FF',
  adobe: '#FF0000',
  canva: '#00C4CC',
  capcut: '#F8FAFC',
  figma: '#F24E1E',
  freepik: '#1273EB',
  autodesk: '#0696D7',
  davinci: '#FF5A5F',
  picsart: '#C209C1',
  alightmotion: '#00D4FF',
  meitu: '#FF4D8D',
  wink: '#EC4899',
  xingtu: '#FB7185',
  github: '#E2E8F0',
  jetbrains: '#FE315D',
  notion: '#E2E8F0',
  windows: '#0078D4',
  office365: '#EA3E23',
  zoom: '#0B5CFF',
  googleone: '#4285F4',
  apple: '#E2E8F0',
  icloud: '#3693F3',
  grammarly: '#15C39A',
  quillbot: '#499557',
  ilovepdf: '#E5322D',
  gpmlogin: '#10B981',
  linkedin: '#0A66C2',
  spotify: '#1DB954',
  netflix: '#E50914',
  youtube: '#FF0000',
  discord: '#5865F2',
  x: '#E2E8F0',
  amazonprime: '#00A8E1',
  crunchyroll: '#F47521',
  duolingo: '#58CC02',
  coursera: '#0056D2',
  udemy: '#A435F0',
  kahoot: '#8B5CF6',
  quizlet: '#4255FF',
  scribd: '#1E7B85',
  turnitin: '#3B82F6',
  steam: '#66C0F4',
  roblox: '#E2E8F0',
  exitlag: '#EF4444',
  nordvpn: '#4687FF',
  expressvpn: '#DA3940',
  protonvpn: '#6D4AFF',
  vpn: '#EA7E20',
  bybit: '#F7A600',
  usdt: '#26A17B',
  bnb: '#F0B90B',
  ton: '#0098EA',
  sbp: '#10B981',
};

/**
 * Правила сопоставления брендов.
 * Порядок критичен: специфичные сервисы идут раньше общих платформ (напр. copilot до github, icloud до apple, nordvpn до vpn).
 */
const BRAND_RULES = [
  // AI & LLM
  { id: 'copilot', patterns: [/\bcopilot\b/i, /github\s*copilot/i] },
  { id: 'openai', patterns: [/chatgpt/i, /chat\s*gpt/i, /\bopenai\b/i, /\bgpt[\s\-_]*(?:4|5|4o|o1|o3|plus|pro|team|go|api)?\b/i, /\bsora\b/i, /\bdall[\s-]*e\b/i] },
  { id: 'claude', patterns: [/claude/i, /anthropic/i] },
  { id: 'grok', patterns: [/\bgrok\b/i, /supergrok/i, /\bx\.?ai\b/i] },
  { id: 'veo', patterns: [/\bveo\s*\d*\b/i] },
  { id: 'gemini', patterns: [/gemini/i, /google\s*ai/i, /\bbard\b/i, /ai\s*studio/i] },
  { id: 'deepseek', patterns: [/deep\s*seek/i] },
  { id: 'qwen', patterns: [/\bqwen\b/i] },
  { id: 'kimi', patterns: [/\bkimi\b/i, /moonshot/i] },
  { id: 'minimax', patterns: [/minimax/i, /hailuo/i] },
  { id: 'perplexity', patterns: [/perplexity/i] },
  { id: 'openrouter', patterns: [/open\s*router/i] },
  { id: 'elevenlabs', patterns: [/eleven\s*labs/i, /11\s*labs/i] },
  { id: 'cursor', patterns: [/\bcursor\b/i] },
  { id: 'kling', patterns: [/\bkling\b/i] },
  { id: 'runway', patterns: [/\brunway\b/i, /runwayml/i] },
  { id: 'suno', patterns: [/\bsuno\b/i] },
  { id: 'heygen', patterns: [/hey\s*gen/i] },
  { id: 'higgsfield', patterns: [/higgsfield/i, /\bhiggs\b/i] },
  { id: 'leonardo', patterns: [/leonardo/i] },
  { id: 'krea', patterns: [/\bkrea\b/i] },
  { id: 'gamma', patterns: [/\bgamma\b/i] },
  { id: 'genspark', patterns: [/genspark/i] },
  { id: 'manus', patterns: [/\bmanus\b/i] },
  { id: 'lovable', patterns: [/lovable/i] },
  { id: 'bolt', patterns: [/\bbolt(?:\.new)?\b/i] },
  { id: 'replit', patterns: [/replit/i] },
  { id: 'n8n', patterns: [/\bn8n\b/i] },
  { id: 'openart', patterns: [/openart/i] },
  { id: 'dreamina', patterns: [/dreamina/i] },
  { id: 'seedance', patterns: [/seedance/i] },
  { id: 'kiro', patterns: [/\bkiro\b/i] },
  { id: 'akool', patterns: [/akool/i] },
  { id: 'museai', patterns: [/muse\s*\.?\s*ai/i, /museai/i] },
  { id: 'elser', patterns: [/\belser\b/i] },
  { id: 'cutyai', patterns: [/cuty\s*\.?\s*ai/i, /cutyai/i] },
  { id: 'magica', patterns: [/magica/i] },
  { id: 'tryclico', patterns: [/tryclico/i, /\bclico\b/i] },
  { id: 'wispr', patterns: [/wispr/i] },
  { id: 'granola', patterns: [/granola/i] },
  { id: 'pippit', patterns: [/pippit/i] },
  { id: 'framer', patterns: [/framer/i] },

  // Creative, Design & Video
  { id: 'adobe', patterns: [/adobe/i, /photoshop/i, /illustrator/i, /premiere/i, /after\s*effects/i, /creative\s*cloud/i, /lightroom/i] },
  { id: 'canva', patterns: [/canva/i] },
  { id: 'capcut', patterns: [/cap\s*cut/i] },
  { id: 'figma', patterns: [/figma/i] },
  { id: 'freepik', patterns: [/freepik/i] },
  { id: 'autodesk', patterns: [/autodesk/i, /autocad/i, /3ds\s*max/i, /revit/i] },
  { id: 'davinci', patterns: [/da\s*vinci/i, /davinci/i, /blackmagic/i] },
  { id: 'picsart', patterns: [/picsart/i] },
  { id: 'alightmotion', patterns: [/alight\s*motion/i] },
  { id: 'meitu', patterns: [/meitu/i] },
  { id: 'wink', patterns: [/\bwink\b/i] },
  { id: 'xingtu', patterns: [/xingtu/i] },

  // Dev, OS, Office & Productivity
  { id: 'github', patterns: [/github/i] },
  { id: 'jetbrains', patterns: [/jetbrains/i, /intellij/i, /pycharm/i, /webstorm/i, /phpstorm/i, /goland/i, /\brider\b/i, /\bclion\b/i] },
  { id: 'notion', patterns: [/notion/i] },
  { id: 'windows', patterns: [/windows/i, /\bwin\s*(?:10|11)\b/i] },
  { id: 'office365', patterns: [/office\s*365/i, /office365/i, /microsoft\s*365/i, /ms\s*office/i, /microsoft\s*office/i] },
  { id: 'zoom', patterns: [/\bzoom\b/i] },
  { id: 'googleone', patterns: [/google\s*one/i, /googleone/i, /google\s*drive/i, /google\s*workspace/i] },
  { id: 'icloud', patterns: [/icloud/i] },
  { id: 'apple', patterns: [/\bapple\b/i, /app\s*store/i, /itunes/i, /\bios\b/i] },
  { id: 'grammarly', patterns: [/grammarly/i] },
  { id: 'quillbot', patterns: [/quillbot/i] },
  { id: 'ilovepdf', patterns: [/i\s*love\s*pdf/i, /ilovepdf/i] },
  { id: 'gpmlogin', patterns: [/gpm\s*login/i, /gpmlogin/i] },
  { id: 'linkedin', patterns: [/linkedin/i] },

  // Streaming, Music, Education & Social
  { id: 'spotify', patterns: [/spotify/i] },
  { id: 'netflix', patterns: [/netflix/i] },
  { id: 'youtube', patterns: [/youtube/i, /\byt\s*premium\b/i] },
  { id: 'discord', patterns: [/discord/i, /\bnitro\b/i] },
  { id: 'amazonprime', patterns: [/amazon\s*prime/i, /prime\s*video/i, /primevideo/i] },
  { id: 'crunchyroll', patterns: [/crunchyroll/i] },
  { id: 'duolingo', patterns: [/duolingo/i] },
  { id: 'coursera', patterns: [/coursera/i] },
  { id: 'udemy', patterns: [/udemy/i] },
  { id: 'kahoot', patterns: [/kahoot/i] },
  { id: 'quizlet', patterns: [/quizlet/i] },
  { id: 'scribd', patterns: [/scribd/i] },
  { id: 'turnitin', patterns: [/turnitin/i] },

  // Gaming & VPN (специфичные VPN раньше общего vpn)
  { id: 'steam', patterns: [/\bsteam\b/i] },
  { id: 'roblox', patterns: [/roblox/i, /robux/i] },
  { id: 'exitlag', patterns: [/exit\s*lag/i] },
  { id: 'nordvpn', patterns: [/nord\s*vpn/i] },
  { id: 'expressvpn', patterns: [/express\s*vpn/i] },
  { id: 'protonvpn', patterns: [/proton\s*vpn/i, /\bproton\b/i] },
  { id: 'vpn', patterns: [/\bvpn\b/i, /outline/i, /wireguard/i, /\bvless\b/i, /hiddify/i, /amnezia/i, /surfshark/i, /mullvad/i, /cyberghost/i, /windscribe/i, /adguard/i, /hidemy/i, /planet\s*vpn/i, /\bwarp\+?\b/i] },

  // Crypto & Payments
  { id: 'bybit', patterns: [/bybit/i] },
  { id: 'usdt', patterns: [/\busdt\b/i, /tether/i, /trc[\s-]*20/i, /bep[\s-]*20/i] },
  { id: 'bnb', patterns: [/\bbnb\b/i, /\bbsc\b/i, /binance/i] },
  { id: 'ton', patterns: [/\bton\b/i, /toncoin/i] },
  { id: 'sbp', patterns: [/\bsbp\b/i, /сбп/i, /platega/i] },

  // X (строго по границе слова или X Premium / Twitter)
  { id: 'x', patterns: [/twitter/i, /\bx\s+premium\b/i, /\bx\.com\b/i, /\bx\s+blue\b/i, /^x$/i] },
];

const FALLBACK_PALETTE = [
  '#FF5722',
  '#3B82F6',
  '#10B981',
  '#8B5CF6',
  '#F59E0B',
  '#06B6D4',
  '#EC4899',
  '#6366F1',
];

function hashColor(text) {
  const str = String(text || 'brand');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

function matchTextToBrandId(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  if (!clean) return null;

  for (const rule of BRAND_RULES) {
    for (const regex of rule.patterns) {
      if (regex.test(clean)) {
        return rule.id;
      }
    }
  }
  return null;
}

export function getMonogram(text) {
  const clean = String(text || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .trim();
  if (!clean) return 'S';

  const words = clean.split(/[\s\-_/|·]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Определяет иконку бренда: сначала по name (или явному brandId), затем по categoryName.
 * Возвращает { brandId, src, color, monogram }.
 */
export function resolveBrand({ name = '', categoryName = '', brandId = '' } = {}) {
  let resolvedId = null;

  if (brandId && (manifest[brandId] || BRAND_COLORS[brandId])) {
    resolvedId = brandId;
  }

  if (!resolvedId && name) {
    resolvedId = matchTextToBrandId(name);
  }

  if (!resolvedId && categoryName) {
    resolvedId = matchTextToBrandId(categoryName);
  }

  const src = resolvedId ? manifest[resolvedId] || null : null;
  const color = resolvedId ? BRAND_COLORS[resolvedId] || hashColor(resolvedId) : hashColor(name || categoryName);
  const monogram = getMonogram(name || categoryName || resolvedId || 'Shop');

  return {
    brandId: resolvedId,
    src,
    color,
    monogram,
  };
}

export function getAvailableBrandIds() {
  return Object.keys(manifest);
}

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OUT_DIR = path.resolve(__dirname, '../website/frontend/public/icons/brands');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Brand targets: simpleIcon (slug/color), lobehub (name), domain (for high-res favicon)
const BRANDS = [
  // AI & LLM
  { id: 'openai', simple: 'openai/10A37F', lobehub: 'openai', domain: 'openai.com' },
  { id: 'claude', simple: 'anthropic/D97757', lobehub: 'claude-color', domain: 'claude.ai' },
  { id: 'grok', simple: 'x/FFFFFF', lobehub: 'grok', domain: 'grok.com' },
  { id: 'gemini', simple: 'googlegemini/4E86F7', lobehub: 'gemini-color', domain: 'gemini.google.com' },
  { id: 'deepseek', lobehub: 'deepseek-color', domain: 'deepseek.com' },
  { id: 'qwen', lobehub: 'qwen-color', domain: 'qwen.ai' },
  { id: 'kimi', lobehub: 'kimi-color', domain: 'kimi.com' },
  { id: 'minimax', lobehub: 'minimax-color', domain: 'minimax.io' },
  { id: 'perplexity', simple: 'perplexity/20B2AA', lobehub: 'perplexity-color', domain: 'perplexity.ai' },
  { id: 'copilot', simple: 'githubcopilot/FFFFFF', lobehub: 'copilot-color', domain: 'github.com' },
  { id: 'openrouter', lobehub: 'openrouter', domain: 'openrouter.ai' },

  // AI Video, Audio, Image, Code, Productivity
  { id: 'elevenlabs', simple: 'elevenlabs/FFFFFF', domain: 'elevenlabs.io' },
  { id: 'cursor', simple: 'cursor/FFFFFF', lobehub: 'cursor', domain: 'cursor.com' },
  { id: 'kling', lobehub: 'kling-color', domain: 'klingai.com' },
  { id: 'runway', lobehub: 'runway', domain: 'runwayml.com' },
  { id: 'suno', simple: 'suno/FFFFFF', lobehub: 'suno', domain: 'suno.com' },
  { id: 'heygen', domain: 'heygen.com' },
  { id: 'higgsfield', domain: 'higgsfield.ai' },
  { id: 'leonardo', domain: 'leonardo.ai' },
  { id: 'krea', domain: 'krea.ai' },
  { id: 'gamma', domain: 'gamma.app' },
  { id: 'genspark', domain: 'genspark.ai' },
  { id: 'manus', lobehub: 'manus', domain: 'manus.im' },
  { id: 'lovable', lobehub: 'lovable-color', domain: 'lovable.dev' },
  { id: 'bolt', domain: 'bolt.new' },
  { id: 'replit', simple: 'replit/F26207', domain: 'replit.com' },
  { id: 'n8n', simple: 'n8n/EA4B71', domain: 'n8n.io' },
  { id: 'openart', domain: 'openart.ai' },
  { id: 'dreamina', domain: 'dreamina.capcut.com' },
  { id: 'seedance', domain: 'seed.bytedance.com' },
  { id: 'veo', lobehub: 'gemini-color', domain: 'deepmind.google' },
  { id: 'kiro', domain: 'kiro.dev' },
  { id: 'akool', domain: 'akool.com' },
  { id: 'museai', domain: 'muse.ai' },
  { id: 'elser', domain: 'elser.ai' },
  { id: 'cutyai', domain: 'cuty.ai' },
  { id: 'magica', domain: 'magica.ai' },
  { id: 'tryclico', domain: 'clico.ai' },
  { id: 'wispr', domain: 'wisprflow.ai' },
  { id: 'granola', domain: 'granola.ai' },
  { id: 'pippit', domain: 'pippit.capcut.com' },
  { id: 'framer', simple: 'framer/0055FF', domain: 'framer.com' },

  // Creative, Design & Video
  { id: 'adobe', simple: 'adobe/FF0000', domain: 'adobe.com' },
  { id: 'canva', simple: 'canva/00C4CC', domain: 'canva.com' },
  { id: 'capcut', domain: 'capcut.com' },
  { id: 'figma', simple: 'figma/F24E1E', domain: 'figma.com' },
  { id: 'freepik', simple: 'freepik/1273EB', domain: 'freepik.com' },
  { id: 'autodesk', simple: 'autodesk/FFFFFF', domain: 'autodesk.com' },
  { id: 'davinci', simple: 'davinciresolve/FF5A5F', domain: 'blackmagicdesign.com' },
  { id: 'picsart', simple: 'picsart/C209C1', domain: 'picsart.com' },
  { id: 'alightmotion', domain: 'alightmotion.com' },
  { id: 'meitu', domain: 'meitu.com' },
  { id: 'wink', domain: 'wink.meitu.com' },
  { id: 'xingtu', domain: 'xingtu.cn' },

  // Dev, OS, Office & Productivity
  { id: 'github', simple: 'github/FFFFFF', domain: 'github.com' },
  { id: 'jetbrains', simple: 'jetbrains/FFFFFF', domain: 'jetbrains.com' },
  { id: 'notion', simple: 'notion/FFFFFF', domain: 'notion.so' },
  { id: 'windows', simple: 'windows/0078D4', domain: 'microsoft.com' },
  { id: 'office365', simple: 'microsoftoffice/EA3E23', domain: 'office.com' },
  { id: 'zoom', simple: 'zoom/0B5CFF', domain: 'zoom.us' },
  { id: 'googleone', simple: 'google/4285F4', domain: 'one.google.com' },
  { id: 'apple', simple: 'apple/FFFFFF', domain: 'apple.com' },
  { id: 'icloud', simple: 'icloud/3693F3', domain: 'icloud.com' },
  { id: 'grammarly', simple: 'grammarly/15C39A', domain: 'grammarly.com' },
  { id: 'quillbot', domain: 'quillbot.com' },
  { id: 'ilovepdf', domain: 'ilovepdf.com' },
  { id: 'gpmlogin', domain: 'gpmloginapp.com' },
  { id: 'linkedin', simple: 'linkedin/0A66C2', domain: 'linkedin.com' },

  // Streaming, Music, Education & Social
  { id: 'spotify', simple: 'spotify/1DB954', domain: 'spotify.com' },
  { id: 'netflix', simple: 'netflix/E50914', domain: 'netflix.com' },
  { id: 'youtube', simple: 'youtube/FF0000', domain: 'youtube.com' },
  { id: 'discord', simple: 'discord/5865F2', domain: 'discord.com' },
  { id: 'x', simple: 'x/FFFFFF', domain: 'x.com' },
  { id: 'amazonprime', simple: 'primevideo/00A8E1', domain: 'primevideo.com' },
  { id: 'crunchyroll', simple: 'crunchyroll/F47521', domain: 'crunchyroll.com' },
  { id: 'duolingo', simple: 'duolingo/58CC02', domain: 'duolingo.com' },
  { id: 'coursera', simple: 'coursera/0056D2', domain: 'coursera.org' },
  { id: 'udemy', simple: 'udemy/A435F0', domain: 'udemy.com' },
  { id: 'kahoot', simple: 'kahoot/46178F', domain: 'kahoot.com' },
  { id: 'quizlet', simple: 'quizlet/4255FF', domain: 'quizlet.com' },
  { id: 'scribd', simple: 'scribd/1E7B85', domain: 'scribd.com' },
  { id: 'turnitin', domain: 'turnitin.com' },

  // Gaming & VPN
  { id: 'steam', simple: 'steam/FFFFFF', domain: 'steampowered.com' },
  { id: 'roblox', simple: 'roblox/FFFFFF', domain: 'roblox.com' },
  { id: 'exitlag', domain: 'exitlag.com' },
  { id: 'nordvpn', simple: 'nordvpn/4687FF', domain: 'nordvpn.com' },
  { id: 'expressvpn', simple: 'expressvpn/DA3940', domain: 'expressvpn.com' },
  { id: 'protonvpn', simple: 'protonvpn/6D4AFF', domain: 'protonvpn.com' },
  { id: 'vpn', simple: 'openvpn/EA7E20', domain: 'nordvpn.com' },

  // Crypto / Payments
  { id: 'bybit', domain: 'bybit.com' },
  { id: 'usdt', simple: 'tether/26A17B', domain: 'tether.to' },
  { id: 'bnb', simple: 'bnbchain/F0B90B', domain: 'bnbchain.org' },
  { id: 'ton', simple: 'ton/0098EA', domain: 'ton.org' },
  { id: 'sbp', domain: 'sbp.nspk.ru' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function tryDownload(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 8000,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    validateStatus: (s) => s === 200,
  });
  const buf = Buffer.from(res.data);
  if (buf.length < 120) return null;
  const headStr = buf.slice(0, 64).toString('utf8').trim();
  const isSvg = headStr.includes('<svg') || headStr.startsWith('<?xml');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.slice(8, 12).toString('ascii') === 'WEBP';
  const isIco = buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00;
  if (isSvg) return { buf, ext: 'svg' };
  if (isPng) return { buf, ext: 'png' };
  if (isWebp) return { buf, ext: 'webp' };
  if (isIco) return { buf, ext: 'ico' };
  return null;
}

const SVG_COLOR_OVERRIDES = {
  openai: '#10A37F',
  grok: '#FFFFFF',
  cursor: '#FFFFFF',
  openrouter: '#818CF8',
  runway: '#FFFFFF',
  suno: '#FFFFFF',
  manus: '#FFFFFF',
};

const sanitizeSvgBuffer = (id, buf) => {
  let str = buf.toString('utf8');
  if (str.includes('currentColor')) {
    const hex = SVG_COLOR_OVERRIDES[id] || '#FFFFFF';
    str = str.replace(/currentColor/g, hex);
  }
  str = str.replace(/height="1em"/g, 'height="64"').replace(/width="1em"/g, 'width="64"');
  return Buffer.from(str, 'utf8');
};

async function fetchOne(brand) {
  const urls = [];
  if (brand.lobehub) {
    urls.push(`https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${brand.lobehub}.svg`);
    urls.push(`https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest/dark/${brand.lobehub}.png`);
  }
  if (brand.simple) {
    urls.push(`https://cdn.simpleicons.org/${brand.simple}`);
  }
  if (brand.domain) {
    urls.push(`https://www.google.com/s2/favicons?domain=${brand.domain}&sz=128`);
    urls.push(`https://icons.duckduckgo.com/ip3/${brand.domain}.ico`);
  }

  for (const url of urls) {
    try {
      const hit = await tryDownload(url);
      if (hit) {
        // Remove stale extensions for same id
        for (const ext of ['svg', 'png', 'webp', 'ico']) {
          const oldPath = path.join(OUT_DIR, `${brand.id}.${ext}`);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        const finalBuf = hit.ext === 'svg' ? sanitizeSvgBuffer(brand.id, hit.buf) : hit.buf;
        const outPath = path.join(OUT_DIR, `${brand.id}.${hit.ext}`);
        fs.writeFileSync(outPath, finalBuf);
        return { id: brand.id, ok: true, ext: hit.ext, size: finalBuf.length };
      }
    } catch (_) {}
  }
  return { id: brand.id, ok: false };
}

(async () => {
  const manifest = {};
  const concurrency = 8;
  for (let i = 0; i < BRANDS.length; i += concurrency) {
    const batch = BRANDS.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fetchOne));
    for (const r of results) {
      if (r.ok) {
        manifest[r.id] = `/icons/brands/${r.id}.${r.ext}`;
        console.log(`✓ ${r.id}.${r.ext} (${r.size}B)`);
      } else {
        console.log(`✗ ${r.id} (will use clean lettermark badge)`);
      }
    }
  }
  const manifestPath = path.resolve(__dirname, '../website/frontend/src/lib/brandIconsManifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nDownloaded ${Object.keys(manifest).length}/${BRANDS.length} real brand icons.`);
})();

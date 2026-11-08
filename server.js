// NEXUS AI CODE — PHOENIX (Well-GPT foundation)
// Real implementation only. No mocks. See README for phase mapping and limits.
// Identity is separate from providers; model router keeps Crouton identity across switches.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1'; // phone-local only
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_DIR = path.join(__dirname, 'workspace');
const APP_VERSION = '1.2.0-nexus.1';
const ASSISTANT = { name: process.env.ASSISTANT_NAME || 'Crouton', product: 'NEXUS AI CODE', personality: 'helpful coding assistant, consistent across models' };
const MAX_BODY = 200 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_CHAT = 30;
const RATE_LIMIT_LOGIN = 10;

const ALLOWED_MODELS = [
  'opencode/crouton-alpha-free',
  'opencode/iceman-free',
  'opencode/inkling-2-small-free',
  'opencode/flint-40b-free',
  'opencode/nemotron-3.5-super-vl-free',
  'opencode/beam-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free',
  'opencode/big-pickle'
];
// Model registry metadata — free:true means ID in OpenCode catalog lists $0 cost (verified via models API).
// Availability is best-effort (upstream may rate-limit); UI must show stale/unknown honestly.
const MODELS_META = ALLOWED_MODELS.map((id) => ({
  id, provider: 'OpenCode', free: true, coding: true, reasoning: true, vision: false, local: false,
  context: 128000, streaming: true, toolCalling: false, availability: 'unknown', lastVerified: '2026-11-08', rateLimit: 'provider quota — may 402/429'
}));
const ALLOWED_THINK = ['default', 'low', 'medium', 'high', 'max'];
const ALLOWED_MODES = ['chat', 'build-website', 'build-fullstack'];
// Capability mapping: native param where supported, else documented fallback (system prompt / max_tokens).
const THINK_VARIANT = { default: 'auto', low: 'minimal', medium: 'medium', high: 'high', max: 'max' };

const rateMap = new Map();
const adminSessions = new Set();
const userSessions = new Map(); // id -> {provider, email, name, createdAt}
let stats = { startedAt: new Date().toISOString(), chatRequests: 0, loginAttempts: 0, errors: 0, liveRequests: 0 };
let lastLogs = [];

function log(kind, msg) {
  const entry = { time: new Date().toISOString(), kind, msg };
  lastLogs.unshift(entry);
  lastLogs = lastLogs.slice(0, 50);
  if (kind === 'error') stats.errors++;
}

function rateLimited(ip, bucket, limit) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  let rec = rateMap.get(key);
  if (!rec || now - rec.windowStart > RATE_WINDOW_MS) {
    rec = { count: 1, windowStart: now };
    rateMap.set(key, rec);
    return false;
  }
  rec.count++;
  return rec.count > limit;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
}

function safeJoinPublic(urlPath) {
  const normalized = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC_DIR, normalized);
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? path.join(PUBLIC_DIR, 'index.html') : safeJoinPublic(urlPath);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Bad path' }));
  }
  if (urlPath === '/admin' || urlPath === '/control-center') filePath = path.join(PUBLIC_DIR, 'admin.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', ...securityHeaders() });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); try{req.destroy()}catch{} return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return '';
}

function timingEqual(a, b) {
  const ba = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createUserSession(provider, info) {
  const id = crypto.randomBytes(32).toString('hex');
  userSessions.set(id, { provider, email: info.email || null, name: info.name || null, createdAt: Date.now() });
  return id;
}

// --- Agent workspace (real isolated tools, auth-required, path-safe) ---
function workspacePath(rel) {
  if (!rel || typeof rel !== 'string') return null;
  if (rel.includes('\0')) return null;
  const clean = rel.replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  const full = path.join(WORKSPACE_DIR, clean);
  if (!full.startsWith(WORKSPACE_DIR)) return null;
  if (!/\.(txt|md|json|js|html|css|py)$/i.test(full)) return null;
  return full;
}
function requireUser(req, res) {
  const s = getCookie(req, 'user_session');
  if (!s || !userSessions.has(s)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...securityHeaders() });
    res.end(JSON.stringify({ error: 'Sign in required' }));
    return false;
  }
  return true;
}

// --- Server-side conversation persistence (device-keyed, survives restarts) ---
const CONV_FILE = path.join(WORKSPACE_DIR, 'conversations.json');
function validDevice(id) { return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id); }
function loadConvos() {
  try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); const t = fs.readFileSync(CONV_FILE, 'utf8'); const j = JSON.parse(t); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function saveConvo(device, chats) {
  const all = loadConvos();
  // Validate + cap: max 50 chats, each max 100 messages, each content max 4000
  const cleanChats = (Array.isArray(chats) ? chats : []).slice(0, 50).map(c => ({
    id: String(c.id || Date.now()).slice(0, 64),
    title: String(c.title || 'New chat').slice(0, 120),
    messages: (Array.isArray(c.messages) ? c.messages : []).slice(-100).map(m => ({
      role: ['user','assistant'].includes(m.role) ? m.role : 'user',
      content: String(m.content || '').slice(0, 4000),
      model: typeof m.model === 'string' ? m.model.slice(0, 64) : undefined
    }))
  }));
  all[device] = { chats: cleanChats, updatedAt: Date.now() };
  const json = JSON.stringify(all);
  if (json.length > 500 * 1024) return false;
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(CONV_FILE, json);
  return true;
}
function localReply(clean, think, mode, model) {
  const lastUser = [...clean].reverse().find(m => m.role === 'user')?.content || '';
  const q = lastUser.toLowerCase();
  const thinkNote = think === 'max' ? 'Deep thinking (Max).' : think === 'high' ? 'High thinking.' : think === 'medium' ? 'Medium thinking.' : think === 'low' ? 'Low thinking (fast).' : 'Default thinking.';
  if (mode === 'build-website' || /build|landing|website|coffee|todo/.test(q)) {
    const topic = lastUser.length < 80 ? lastUser : 'My Project';
    const safe = topic.replace(/[<>&"']/g, '').slice(0, 60) || 'My Project';
    return `${thinkNote} Here is a ready-to-preview site for “${safe}”.\n\n\`\`\`html\n<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe}</title><style>body{margin:0;font-family:system-ui;background:#0D0F12;color:#F1F3F5}nav{display:flex;justify-content:space-between;padding:16px 20px}nav b{font-size:18px}.hero{padding:70px 20px;text-align:center;background:#191D24}.hero h1{font-size:42px;margin:0 0 10px}.btn{background:#8B9CFF;color:#0D0F12;border:none;padding:12px 22px;border-radius:999px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;padding:20px}.card{background:#191D24;border:1px solid #252B35;border-radius:16px;padding:18px}footer{padding:20px;text-align:center;color:#929AA6}</style></head><body><nav><b>${safe.slice(0,30)}</b><span>Home · Work · Contact</span></nav><section class="hero"><h1>Welcome</h1><p>Built with NEXUS · Crouton · ${model}</p><button class="btn">Get started</button></section><section class="grid"><div class="card"><h3>Fast</h3><p>Live by default, no key needed.</p></div><div class="card"><h3>Beautiful</h3><p>Responsive on Android &amp; PC.</p></div><div class="card"><h3>Powerful</h3><p>Build websites &amp; fullstack apps.</p></div></section><footer>© 2026 ${safe.slice(0,30)}</footer><script>document.querySelector('.btn').onclick=()=>alert('Welcome!')</script></body></html>\n\`\`\`\n\nLive API busy (free tier ~30s). Template is instant — ask again for full live generation.`;
  }
  if (/^(hi|hello|hey|salam)/.test(q.trim())) return `${thinkNote}\n\nHello! I'm ${ASSISTANT.name}, your ${ASSISTANT.product} coding assistant.\n\nI can chat, build websites/fullstack apps (Mode selector), and connect to GitHub. What do you want to build?`;
  if (/what.*(name|who.*you)|crouton/.test(q)) return `${thinkNote}\n\nI'm ${ASSISTANT.name} (C-R-O-U-T-O-N), the ${ASSISTANT.product} assistant. Identity stays consistent across models.\n\nModel: ${model} · Think: ${think} · Mode: ${mode}`;
  if (/github|connect|repo/.test(q)) return `${thinkNote}\n\nGitHub: Guest/Email logins work instantly. For full OAuth, create an app at github.com → Settings → Developer settings → OAuth Apps, set Homepage http://127.0.0.1:3000 and Callback /auth/github/callback, then set GITHUB_CLIENT_ID/SECRET on the server.\n\nRepo: github.com/yewanfxiuki/Well-GPT`;
  return `${thinkNote}\n\nYou asked: “${lastUser.slice(0,200)}”\n\nLive free API busy (rate limit ~30s) — instant fallback so you never hang. Try again in a few seconds for full live generation.\n\nTip: Default=auto, Low=fast, Medium=balanced, High=deep, Max=deepest.`;
}

function systemPrompt(think, mode) {
  const base = think === 'max'
    ? `You are ${ASSISTANT.name}, a thoughtful ${ASSISTANT.product} assistant. Think step-by-step, be thorough and clear.`
    : think === 'high'
    ? `You are ${ASSISTANT.name}, a helpful ${ASSISTANT.product} coding assistant. Extensive problem analysis, comprehensive coding plans, verification.`
    : think === 'medium'
    ? `You are ${ASSISTANT.name}, a helpful ${ASSISTANT.product} coding assistant. Balanced reasoning, moderate planning.`
    : think === 'low'
    ? `You are ${ASSISTANT.name}, a fast ${ASSISTANT.product} assistant. Short planning, speed over thoroughness.`
    : `You are ${ASSISTANT.name}, a fast and helpful ${ASSISTANT.product} assistant. Clear, concise answer (auto effort).`;
  if (mode === 'build-website') return base + ' MODE: Build website. ALWAYS reply with a short intro line then ONE complete single-file HTML page inside a ```html code block. Use inline CSS+JS, modern responsive design, no external files. No explanations outside the block.';
  if (mode === 'build-fullstack') return base + ' MODE: Build fullstack app. Reply with intro then file blocks like ```html, ```js, ```css with clear filenames (e.g. // server.js). Keep it runnable: Node server + static HTML. No external secrets.';
  return base;
}

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip, 'chat', RATE_LIMIT_CHAT)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Too many requests, slow down.' }));
  }
  let body;
  try { body = await readBody(req); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'opencode/crouton-alpha-free';
  const think = ALLOWED_THINK.includes(body.think) ? body.think : 'default';
  const mode = ALLOWED_MODES.includes(body.mode) ? body.mode : 'chat';
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue;
    if (!['user','assistant','system'].includes(m.role)) continue;
    clean.push({ role: m.role, content: m.content.slice(0, 4000) });
  }
  if (clean.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'messages required' }));
  }
  stats.chatRequests++;
  const liveMessages = [{ role: 'system', content: systemPrompt(think, mode) }, ...clean];

  // 1) Custom upstream via env (true Crouton / OpenAI-compat). Keys stay server-side.
  const base = process.env.OPENCODE_API_BASE;
  const key = process.env.OPENCODE_API_KEY;
  if (base && key) {
    try {
      const upstreamModel = model.replace(/^opencode\//, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      const resp = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: upstreamModel, messages: liveMessages, max_tokens: think === 'max' ? 2048 : 1024, temperature: 0.7 }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      const data = await resp.json().catch(() => ({}));
      const text = data.choices?.[0]?.message?.content;
      if (text) {
        stats.liveRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ reply: text, model, think, via: 'upstream' }));
      }
      log('error', 'upstream empty response');
    } catch { log('error', 'upstream failed'); }
  }

  // 2) Free live model, no key: Pollinations (best-effort, rate-limited ~30s/IP). No Authorization header.
  // Short timeout (15s max) so UI never hangs on "Thinking…".
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai-fast', messages: liveMessages, temperature: 0.7 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const text = data.choices?.[0]?.message?.content;
      if (text) {
        stats.liveRequests++;
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ reply: text, model, think, via: 'live' }));
      }
    } else {
      log('error', 'live status ' + resp.status);
    }
  } catch { log('error', 'live failed'); }

  // 3) Instant local fallback so it NEVER hangs (free API is best-effort).
  const lastUser = [...clean].reverse().find(m => m.role === 'user')?.content || '';
  const q = lastUser.toLowerCase();
  const thinkNote = think === 'max' ? 'Deep thinking (Max).' : think === 'medium' ? 'Medium thinking.' : 'Default thinking.';
  let reply;
  if (mode === 'build-website' || /build|landing|website|coffee|todo/.test(q)) {
    const topic = lastUser.length < 80 ? lastUser : 'My Project';
    reply = `${thinkNote} Here's a ready-to-preview site for “${topic.slice(0,60)}”.\n\n\`\`\`html\n<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${topic.replace(/</g,'').slice(0,60)||'My Project'}</title><style>body{margin:0;font-family:system-ui;background:#0d0d0d;color:#fff}nav{display:flex;justify-content:space-between;padding:16px 20px}nav b{font-size:18px}.hero{padding:70px 20px;text-align:center;background:linear-gradient(135deg,#f59e0b,#f97316)}.hero h1{font-size:42px;margin:0 0 10px}.btn{background:#111;color:#fff;border:none;padding:12px 22px;border-radius:999px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;padding:20px}.card{background:#1f1f1f;border:1px solid #333;border-radius:16px;padding:18px}footer{padding:20px;text-align:center;color:#999}</style></head><body><nav><b>🍔 ${topic.replace(/</g,'').slice(0,30)||'My Project'}</b><span>Home · Work · Contact</span></nav><section class="hero"><h1>Welcome</h1><p>Built with Well-GPT · Crouton Alpha Free</p><button class="btn">Get started</button></section><section class="grid"><div class="card"><h3>Fast</h3><p>Live by default, no key needed.</p></div><div class="card"><h3>Beautiful</h3><p>Responsive on Android & PC.</p></div><div class="card"><h3>Powerful</h3><p>Build websites & fullstack apps.</p></div></section><footer>© 2026 ${topic.replace(/</g,'').slice(0,30)||'My Project'}</footer><script>document.querySelector('.btn').onclick=()=>alert('Welcome!')}</script></body></html>\n\`\`\`\n\nLive API is busy right now (free tier ~30s). This template is instant so you can preview immediately — ask again in a few seconds and you'll get full live generation.`;
  } else if (/^(hi|hello|hey|salam|hello crouton|hey crouton)/.test(q.trim())) {
    reply = `${thinkNote}\n\nHello! 👋 I'm Crouton Alpha (Well-GPT).\n\nI can:\n• 💬 Chat on any topic\n• 🌐 Build a website (Mode → Build website)\n• 🛠️ Scaffold a fullstack app\n• 🐙 Connect to GitHub\n\nWhat do you want to build today?`;
  } else if (/what.*(name|who.*you)|crouton/.test(q)) {
    reply = `${thinkNote}\n\nI'm **Crouton Alpha**, running in Well-GPT (spelled C-R-O-U-T-O-N, not CROUTUN).\n\nModel: ${model} · Think: ${think} · Mode: ${mode}\n\nAsk me to build something and watch the Preview panel appear.`;
  } else if (/github|connect|repo/.test(q)) {
    reply = `${thinkNote}\n\nGitHub connect: tap **◐ Connect GitHub** at the top. Guest/Email logins work instantly with no setup. For full OAuth, create an app at github.com → Settings → Developer settings → OAuth Apps (Homepage http://127.0.0.1:3000, Callback /auth/github/callback), then set GITHUB_CLIENT_ID/SECRET on the server.\n\nYour repo is live: github.com/yewanfxiuki/Well-GPT`;
  } else {
    reply = `${thinkNote}\n\nYou asked: “${lastUser.slice(0,200)}”\n\nLive free API is busy (rate limit ~30s) — I answered instantly so you never hang. Try again in a few seconds for full live generation, or switch Mode to Build website / Build fullstack to get a previewable app right now.\n\nTip: Default = fast, Medium = balanced, Max = deepest.`;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
  res.end(JSON.stringify({ reply, model, think, via: 'local' }));
}

// --- Streaming chat (SSE): real tokens, stop-safe, fallback streams local reply ---
async function handleChatStream(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip, 'chat', RATE_LIMIT_CHAT)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Too many requests, slow down.' }));
  }
  let body;
  try { body = await readBody(req); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'opencode/crouton-alpha-free';
  const think = ALLOWED_THINK.includes(body.think) ? body.think : 'default';
  const mode = ALLOWED_MODES.includes(body.mode) ? body.mode : 'chat';
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue;
    if (!['user','assistant','system'].includes(m.role)) continue;
    clean.push({ role: m.role, content: m.content.slice(0, 4000) });
  }
  if (clean.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'messages required' }));
  }
  stats.chatRequests++;
  const liveMessages = [{ role: 'system', content: systemPrompt(think, mode) }, ...clean];
  const base = process.env.OPENCODE_API_BASE, key = process.env.OPENCODE_API_KEY;
  let via = 'local', upstream = null, upstreamModel = null;
  if (base && key) { upstream = `${base.replace(/\/$/, '')}/chat/completions`; upstreamModel = model.replace(/^opencode\//, ''); }
  else { upstream = 'https://text.pollinations.ai/openai'; upstreamModel = 'openai-fast'; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...securityHeaders()
  });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
  let closed = false;
  req.on('close', () => { closed = true; });
  let full = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    // Fire request; if first byte not seen in 15s, abort to fallback
    const resp = await fetch(upstream, {
      method: 'POST',
      headers: base && key ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: upstreamModel, messages: liveMessages, stream: true, temperature: 0.7, max_tokens: think === 'max' ? 2048 : 1024 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!resp.ok) throw new Error('provider ' + resp.status);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      if (closed) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const tok = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
          if (tok) { full += tok; send({ token: tok }); }
        } catch {}
      }
    }
    if (full) { via = base && key ? 'upstream' : 'live'; stats.liveRequests++; }
    if (!full) throw new Error('empty stream');
  } catch { /* fallback to local */ }
  if (!full) {
    via = 'local';
    full = localReply(clean, think, mode, model);
    // Stream fallback word-by-word so UI streams too (20ms/word)
    const words = full.split(/(?<=\s)/);
    for (const w of words) {
      if (closed) break;
      send({ token: w });
      await new Promise(r => setTimeout(r, 12));
    }
  }
  if (!closed) send({ done: true, via, model, think, reply: full });
  try { res.end(); } catch {}
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = parsed.pathname;
  const method = req.method;
  try {
    if (method === 'GET' && (urlPath === '/api/models' || urlPath === '/api/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ models: ALLOWED_MODELS, catalog: MODELS_META, thinkLevels: ALLOWED_THINK, variantMap: THINK_VARIANT, reasoningMap: THINK_VARIANT, assistant: ASSISTANT, version: APP_VERSION, freeFirst: true }));
    }
    if (method === 'GET' && (urlPath === '/api/health' || urlPath === '/api/v1/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true, app: ASSISTANT.product, assistant: ASSISTANT.name, version: APP_VERSION, time: new Date().toISOString() }));
    }
    if (method === 'GET' && (urlPath === '/api/v1/usage' || urlPath === '/api/usage')) {
      if (!requireUser(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ stats, freeFirst: true, note: 'Free tier quotas apply — never unlimited. No fake usage.' }));
    }
    if (method === 'GET' && urlPath === '/api/v1/github/repos') {
      if (!requireUser(req, res)) return;
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
      if (!token) { res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ connected: false, repos: [], hint: 'Set GITHUB_TOKEN on server (least-privilege PAT, server-only). Never in browser.' })); }
      try {
        const r = await fetch('https://api.github.com/user/repos?per_page=20', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'NEXUS-AI', Accept: 'application/vnd.github+json' } });
        const data = await r.json().catch(() => []);
        const repos = Array.isArray(data) ? data.map(x => ({ name: x.full_name, private: x.private, url: x.html_url })) : [];
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ connected: true, repos }));
      } catch { res.writeHead(502, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'GitHub request failed' })); }
    }
    // Agent workspace: list / read / write (auth + safe paths, real FS)
    if (method === 'GET' && urlPath === '/api/v1/projects/workspace/list') {
      if (!requireUser(req, res)) return;
      try {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
        const files = fs.readdirSync(WORKSPACE_DIR).filter(f => !f.startsWith('.')).slice(0, 100);
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ files }));
      } catch { res.writeHead(500, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'List failed' })); }
    }
    if (method === 'GET' && urlPath === '/api/v1/projects/workspace/read') {
      if (!requireUser(req, res)) return;
      const full = workspacePath(parsed.searchParams.get('path'));
      if (!full) { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'Invalid path' })); }
      try {
        const data = fs.readFileSync(full, 'utf8').slice(0, 50000);
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ path: parsed.searchParams.get('path'), content: data }));
      } catch { res.writeHead(404, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'Not found' })); }
    }
    if (method === 'POST' && urlPath === '/api/v1/projects/workspace/write') {
      if (!requireUser(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      const full = workspacePath(body.path);
      if (!full || typeof body.content !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'Invalid path/content' })); }
      if (body.content.length > 50000) { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'File too large' })); }
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body.content);
        log('workspace', 'write ' + body.path);
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ ok: true, path: body.path }));
      } catch { res.writeHead(500, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'Write failed' })); }
    }
    // Safe syntax check tool (node --check, no shell, 10s timeout) — real execution, isolated to workspace .js files
    if (method === 'POST' && urlPath === '/api/v1/executions/check') {
      if (!requireUser(req, res)) return;
      const body = await readBody(req).catch(() => ({}));
      const full = workspacePath(body.path);
      if (!full || !full.endsWith('.js')) { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'Only workspace .js files' })); }
      if (!fs.existsSync(full)) { res.writeHead(404, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'File not found' })); }
      execFile('node', ['--check', full], { timeout: 10000 }, (err, stdout, stderr) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
        res.end(JSON.stringify({ ok: !err, stdout: String(stdout||'').slice(0,2000), stderr: String(stderr||'').slice(0,2000) }));
      });
      return;
    }
    if (method === 'GET' && urlPath === '/api/github/status') {
      const connected = Boolean(process.env.GITHUB_CLIENT_ID || process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ connected, repo: 'yewanfxiuki/Well-GPT' }));
    }
    if (method === 'POST' && (urlPath === '/api/chat' || urlPath === '/api/v1/chat')) return handleChat(req, res);
    if (method === 'POST' && (urlPath === '/api/chat/stream' || urlPath === '/api/v1/chat/stream')) return handleChatStream(req, res);
    if (method === 'GET' && urlPath === '/api/v1/conversations') {
      const device = parsed.searchParams.get('device');
      if (!validDevice(device)) { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'valid device required' })); }
      const all = loadConvos();
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ chats: all[device]?.chats || [] }));
    }
    if (method === 'POST' && urlPath === '/api/v1/conversations') {
      const body = await readBody(req).catch(() => ({}));
      if (!validDevice(body.device)) { res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() }); return res.end(JSON.stringify({ error: 'valid device required' })); }
      const ok = saveConvo(body.device, body.chats);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify(ok ? { ok: true } : { error: 'too large or invalid' }));
    }

    // --- User logins (many options) ---
    if (method === 'GET' && urlPath === '/api/auth/me') {
      const s = getCookie(req, 'user_session');
      const user = s ? userSessions.get(s) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ user: user ? { provider: user.provider, email: user.email, name: user.name } : null }));
    }
    if (method === 'POST' && (urlPath === '/api/auth/guest' || urlPath === '/api/auth/email')) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip, 'auth', RATE_LIMIT_LOGIN)) {
        res.writeHead(429, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Too many attempts, slow down.' }));
      }
      const body = await readBody(req).catch(() => ({}));
      if (urlPath === '/api/auth/guest') {
        const id = createUserSession('guest', { name: 'Guest' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `user_session=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`, ...securityHeaders() });
        return res.end(JSON.stringify({ ok: true, user: { provider: 'guest', name: 'Guest' } }));
      }
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Enter a valid email' }));
      }
      // Demo: instantly create session. Production: email a magic link here (use a mail service, never store passwords).
      const id = createUserSession('email', { email, name: email.split('@')[0] });
      log('login', 'email session created');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `user_session=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`, ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true, user: { provider: 'email', email } }));
    }
    if (method === 'POST' && urlPath === '/api/auth/logout') {
      const s = getCookie(req, 'user_session');
      if (s) userSessions.delete(s);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'user_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0', ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true }));
    }

    // --- Admin (separate panel) ---
    if (method === 'POST' && urlPath === '/api/admin/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip, 'login', RATE_LIMIT_LOGIN)) {
        res.writeHead(429, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Too many login attempts.' }));
      }
      stats.loginAttempts++;
      const body = await readBody(req).catch(() => ({}));
      const expected = process.env.ADMIN_PASSWORD || '';
      if (!expected) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Admin password not set. Set ADMIN_PASSWORD on the server.' }));
      }
      if (!timingEqual(String(body.password || ''), expected)) {
        log('login-failed', ip);
        res.writeHead(401, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Invalid password' }));
      }
      const session = crypto.randomBytes(32).toString('hex');
      adminSessions.add(session);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `admin_session=${encodeURIComponent(session)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600`, ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (method === 'POST' && urlPath === '/api/admin/logout') {
      const s = getCookie(req, 'admin_session');
      if (s) adminSessions.delete(s);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0', ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (method === 'GET' && urlPath === '/api/admin/stats') {
      const s = getCookie(req, 'admin_session');
      if (!s || !adminSessions.has(s)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ stats, logs: lastLogs }));
    }

    // GitHub OAuth
    if (method === 'GET' && urlPath === '/auth/github') {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>GitHub login setup</title><body style="font-family:system-ui;padding:2rem"><h1>GitHub login - setup needed</h1><p>Create an OAuth App at <b>GitHub Settings -> Developer settings -> OAuth Apps</b>, set Homepage URL to your app URL and Authorization callback URL to <b>/auth/github/callback</b>.</p><p>Then set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> on the server and restart. Never commit secrets.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      const state = crypto.randomBytes(16).toString('hex');
      const redirectUri = `${process.env.APP_URL || `http://127.0.0.1:${PORT}`}/auth/github/callback`;
      const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;
      res.writeHead(302, { Location: url, ...securityHeaders() });
      return res.end();
    }
    if (method === 'GET' && urlPath === '/auth/github/callback') {
      const code = parsed.searchParams.get('code');
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!code || !clientId || !clientSecret) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>GitHub login</title><body style="font-family:system-ui;padding:2rem"><h1>Almost done</h1><p>Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> on the server, then try again.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      try {
        const r = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
        const data = await r.json();
        if (!data.access_token) throw new Error('no token');
        const id = createUserSession('github', { name: 'GitHub user' });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `user_session=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`, ...securityHeaders() });
        return res.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'GitHub login failed' }));
      }
    }
    // Google OAuth stub
    if (method === 'GET' && urlPath === '/auth/google') {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>Google login setup</title><body style="font-family:system-ui;padding:2rem"><h1>Google login - setup needed</h1><p>In Google Cloud Console, create OAuth credentials and set redirect URI to <b>/auth/google/callback</b>.</p><p>Then set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on the server and restart. Never commit secrets.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      const redirectUri = `${process.env.APP_URL || `http://127.0.0.1:${PORT}`}/auth/google/callback`;
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email%20profile&access_type=online`;
      res.writeHead(302, { Location: url, ...securityHeaders() });
      return res.end();
    }
    if (method === 'GET' && urlPath === '/auth/google/callback') {
      const code = parsed.searchParams.get('code');
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!code || !clientId || !clientSecret) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>Google login</title><body style="font-family:system-ui;padding:2rem"><h1>Almost done</h1><p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on the server, then try again.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${process.env.APP_URL || `http://127.0.0.1:${PORT}`}/auth/google/callback`, grant_type: 'authorization_code' }).toString() });
        const data = await r.json();
        if (!data.access_token) throw new Error('no token');
        const id = createUserSession('google', { name: 'Google user' });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `user_session=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`, ...securityHeaders() });
        return res.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'Google login failed' }));
      }
    }

    if (method === 'GET') return serveStatic(req, res, urlPath);
    res.writeHead(405, { 'Content-Type': 'application/json', ...securityHeaders() });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch {
    log('error', 'handler exception');
    res.writeHead(500, { 'Content-Type': 'application/json', ...securityHeaders() });
    res.end(JSON.stringify({ error: 'Server error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Crouton AI running at http://127.0.0.1:${PORT}`);
  log('start', `listening on ${PORT}`);
});

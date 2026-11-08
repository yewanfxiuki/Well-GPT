// Crouton AI - Secure full-stack server (zero dependencies, Node built-ins only)
// - Security headers, rate limiting, input validation, size limits
// - Live model: custom upstream (env) -> Pollinations free (no key) -> demo fallback
// - Separate admin panel + user logins: Guest, Email, GitHub OAuth, Google OAuth stub
// - No tokens exposed to browser; all upstream calls server-side only

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1'; // phone-local only
const PUBLIC_DIR = path.join(__dirname, 'public');
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
const ALLOWED_THINK = ['default', 'medium', 'max'];
const THINK_VARIANT = { default: 'medium', medium: 'high', max: 'max' };

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
  if (urlPath === '/admin') filePath = path.join(PUBLIC_DIR, 'admin.html');
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

// Think-level system prompts for live model
function systemPrompt(think) {
  if (think === 'max') return 'You are Crouton Alpha, a thoughtful AI. Think step-by-step, be thorough and clear.';
  if (think === 'medium') return 'You are Crouton Alpha, a helpful AI. Give a careful, balanced, well-reasoned answer.';
  return 'You are Crouton Alpha, a fast and helpful AI. Give a clear, concise answer.';
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
  const liveMessages = [{ role: 'system', content: systemPrompt(think) }, ...clean];

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
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 40000);
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

  // 3) Demo fallback so the app never errors
  const lastUser = [...clean].reverse().find(m => m.role === 'user')?.content || '';
  const thinkNote = think === 'max' ? 'Deep thinking (Max).' : think === 'medium' ? 'Medium thinking.' : 'Default thinking.';
  const demoReply = `${thinkNote}\n\nYou asked: "${lastUser.slice(0, 500)}"\n\nLive free API is busy (rate limit ~30s). Try again in a few seconds.\n\nTo use true ${model}: set OPENCODE_API_BASE + OPENCODE_API_KEY on the server (never in browser code) and restart.`;
  res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
  res.end(JSON.stringify({ reply: demoReply, model, think, via: 'demo' }));
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = parsed.pathname;
  const method = req.method;
  try {
    if (method === 'GET' && urlPath === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ ok: true, app: 'Crouton AI', time: new Date().toISOString() }));
    }
    if (method === 'GET' && urlPath === '/api/models') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ models: ALLOWED_MODELS, thinkLevels: ALLOWED_THINK, variantMap: THINK_VARIANT }));
    }
    if (method === 'POST' && urlPath === '/api/chat') return handleChat(req, res);

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

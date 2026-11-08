// Crouton AI - Secure full-stack server (zero dependencies, Node built-ins only)
// - Security headers, rate limiting, input validation, size limits
// - Separate admin panel, httpOnly session cookie, timing-safe password check
// - GitHub OAuth stub (add your own Client ID/Secret via env, never in code)
// - No API tokens exposed to browser; upstream calls are server-side only

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1'; // phone-local only, never 0.0.0.0 unless you ask
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 200 * 1024; // 200KB
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_CHAT = 40;
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
// Map UI think level -> provider variant hint
const THINK_VARIANT = { default: 'medium', medium: 'high', max: 'max' };

const rateMap = new Map(); // ip -> {count, windowStart}
const adminSessions = new Set();
let stats = { startedAt: new Date().toISOString(), chatRequests: 0, loginAttempts: 0, errors: 0 };
let lastLogs = [];

function log(kind, msg) {
  const entry = { time: new Date().toISOString(), kind, msg };
  lastLogs.unshift(entry);
  lastLogs = lastLogs.slice(0, 50);
  if (kind === 'error') stats.errors++;
  // Never log prompts or passwords
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
  if (urlPath === '/admin.js' ) filePath = path.join(PUBLIC_DIR, 'admin.js');

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
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
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

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip, 'chat', RATE_LIMIT_CHAT)) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Too many requests, slow down.' }));
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'Invalid request body' }));
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'opencode/crouton-alpha-free';
  const think = ALLOWED_THINK.includes(body.think) ? body.think : 'default';

  // Validation: roles + content length
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue;
    if (!['user', 'assistant', 'system'].includes(m.role)) continue;
    clean.push({ role: m.role, content: m.content.slice(0, 4000) });
  }
  if (clean.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
    return res.end(JSON.stringify({ error: 'messages required' }));
  }

  stats.chatRequests++;

  // Server-side upstream (OpenAI-compatible). Keys stay here, never sent to browser.
  const base = process.env.OPENCODE_API_BASE; // e.g. https://opencode.ai/api or your proxy
  const key = process.env.OPENCODE_API_KEY;
  if (base && key) {
    try {
      const upstreamModel = model.replace(/^opencode\//, '');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      const resp = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: upstreamModel, messages: clean, max_tokens: think === 'max' ? 2048 : 1024, temperature: 0.7 }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await resp.json().catch(() => ({}));
      const text = data.choices?.[0]?.message?.content || 'No response from model.';
      res.writeHead(200, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ reply: text, model, think, via: 'upstream' }));
    } catch (e) {
      log('error', 'upstream failed');
      res.writeHead(502, { 'Content-Type': 'application/json', ...securityHeaders() });
      return res.end(JSON.stringify({ error: 'Model service error. Try again.' }));
    }
  }

  // Demo mode (no token needed): helpful local responder so the app runs with zero errors
  const lastUser = [...clean].reverse().find(m => m.role === 'user')?.content || '';
  const thinkNote = think === 'max' ? 'Deep thinking (Max) — considering multiple angles.' : think === 'medium' ? 'Medium thinking — balanced reasoning.' : 'Default thinking — fast and balanced.';
  const demoReply = `${thinkNote}\n\nYou asked: "${lastUser.slice(0, 500)}"\n\nDemo mode is on (no token needed). To get live replies from ${model}:\n1. Set OPENCODE_API_BASE and OPENCODE_API_KEY in your server environment (never in browser code).\n2. Restart the server.\n3. Chat again — replies will come from the model.\n\nYour app, UI, server and admin panel are running securely. Check the Admin panel for health stats.`;
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
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `admin_session=${encodeURIComponent(session)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600`,
        ...securityHeaders()
      });
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

    // GitHub OAuth stub - real flow, secrets via env only
    if (method === 'GET' && urlPath === '/auth/github') {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>GitHub login setup</title><body style="font-family:system-ui;padding:2rem"><h1>GitHub login - setup needed</h1><p>Create an OAuth App at <b>GitHub Settings -> Developer settings -> OAuth Apps</b>, set Homepage URL to your app URL and Authorization callback URL to <b>/auth/github/callback</b>.</p><p>Then set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> on the server and restart. Never commit secrets to GitHub.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      const state = crypto.randomBytes(16).toString('hex');
      const redirectUri = `${process.env.APP_URL || `http://127.0.0.1:${PORT}`}/auth/github/callback`;
      const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;
      res.writeHead(302, { Location: url, ...securityHeaders() });
      return res.end();
    }
    if (method === 'GET' && urlPath === '/auth/github/callback') {
      // Exchange code server-side if secrets are set; otherwise show friendly help
      const code = parsed.searchParams.get('code');
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!code || !clientId || !clientSecret) {
        res.writeHead(200, { 'Content-Type': 'text/html', ...securityHeaders() });
        return res.end(`<!doctype html><title>GitHub login</title><body style="font-family:system-ui;padding:2rem"><h1>Almost done</h1><p>Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> on the server, then try again.</p><p><a href="/">Back to chat</a></p></body>`);
      }
      // Minimal exchange (no user data stored here - extend with signed session as needed)
      try {
        const r = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
        });
        const data = await r.json();
        if (!data.access_token) throw new Error('no token');
        // TODO: verify user, create your own session. Token is not logged or stored in this demo.
        res.writeHead(302, { Location: '/', ...securityHeaders() });
        return res.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...securityHeaders() });
        return res.end(JSON.stringify({ error: 'GitHub login failed' }));
      }
    }

    if (method === 'GET') return serveStatic(req, res, urlPath);

    res.writeHead(405, { 'Content-Type': 'application/json', ...securityHeaders() });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (e) {
    log('error', 'handler exception');
    res.writeHead(500, { 'Content-Type': 'application/json', ...securityHeaders() });
    res.end(JSON.stringify({ error: 'Server error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Crouton AI running at http://127.0.0.1:${PORT}`);
  log('start', `listening on ${PORT}`);
});

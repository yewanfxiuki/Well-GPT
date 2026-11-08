// NEXUS E2E — starts server on ephemeral port, tests real HTTP endpoints
// Run: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
let proc, cookie = '';

async function waitUp() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/api/v1/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  proc = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'test-admin' }, stdio: 'ignore' });
  await waitUp();
});
test.after(() => { try { proc.kill(); } catch {} });

test('health, models, streaming, persistence, workspace', async () => {
  const h = await (await fetch(`${BASE}/api/v1/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.app, 'NEXUS AI CODE');

  const m = await (await fetch(`${BASE}/api/v1/models`)).json();
  assert.ok(m.models.includes('opencode/crouton-alpha-free'));
  assert.ok(m.catalog.length >= 10);

  const s = await fetch(`${BASE}/api/v1/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/crouton-alpha-free', think: 'low', mode: 'chat', messages: [{ role: 'user', content: 'Reply with exactly: OK' }] })
  });
  assert.equal(s.status, 200);
  const text = await s.text();
  assert.ok(text.includes('data:'), 'SSE frames present');
  assert.ok(text.includes('"done":true'), 'stream completes');

  const g = await fetch(`${BASE}/api/auth/guest`, { method: 'POST' });
  cookie = (g.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(g.ok);

  const w = await fetch(`${BASE}/api/v1/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'e2e-test-1234', chats: [{ id: 'c1', title: 't', messages: [{ role: 'user', content: 'hi' }] }] }) });
  assert.ok(w.ok);
  const rd = await (await fetch(`${BASE}/api/v1/conversations?device=e2e-test-1234`)).json();
  assert.equal(rd.chats[0].id, 'c1');

  const list = await (await fetch(`${BASE}/api/v1/projects/workspace/list`, { headers: { Cookie: cookie } })).json();
  assert.ok(Array.isArray(list.files));

  const unauth = await fetch(`${BASE}/api/v1/projects/workspace/list`);
  assert.equal(unauth.status, 401);
});

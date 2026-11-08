// Separate admin JS - no secrets here, session is httpOnly cookie
const loginForm = document.getElementById('loginForm');
const password = document.getElementById('password');
const loginError = document.getElementById('loginError');
const loginCard = document.getElementById('loginCard');
const statsCard = document.getElementById('statsCard');
const stats = document.getElementById('stats');

async function loadStats() {
  const r = await fetch('/api/admin/stats');
  if (!r.ok) return false;
  const data = await r.json();
  stats.textContent = '';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(data.stats, null, 2);
  const logs = document.createElement('div');
  logs.textContent = 'Logs:';
  const ul = document.createElement('ul');
  (data.logs || []).forEach(l => {
    const li = document.createElement('li');
    li.textContent = `${l.time} ${l.kind} ${l.msg}`;
    ul.appendChild(li);
  });
  stats.append(pre, logs, ul);
  return true;
}

async function refresh() {
  const ok = await loadStats();
  loginCard.style.display = ok ? 'none' : 'block';
  statsCard.style.display = ok ? 'block' : 'none';
}

loginForm.onsubmit = async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { loginError.textContent = data.error || 'Login failed'; return; }
  password.value = '';
  refresh();
};

document.getElementById('logout').onclick = async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  refresh();
};

refresh();

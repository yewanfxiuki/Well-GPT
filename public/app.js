// Crouton AI frontend - XSS-safe, polished UX
const els = {
  model: document.getElementById('model'),
  think: document.getElementById('think'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  form: document.getElementById('form'),
  typing: document.getElementById('typing'),
  chatList: document.getElementById('chatList'),
  newChat: document.getElementById('newChat'),
  menuBtn: document.getElementById('menuBtn'),
  sidebar: document.getElementById('sidebar'),
  loginBtn: document.getElementById('loginBtn'),
  loginModal: document.getElementById('loginModal'),
  closeLogin: document.getElementById('closeLogin'),
  guestBtn: document.getElementById('guestBtn'),
  emailForm: document.getElementById('emailForm'),
  email: document.getElementById('email'),
  emailMsg: document.getElementById('emailMsg'),
  userChip: document.getElementById('userChip'),
  themeBtn: document.getElementById('themeBtn')
};

let chats = JSON.parse(localStorage.getItem('crouton-chats') || '[]');
let currentId = localStorage.getItem('crouton-current') || null;
let sending = false;

const MODEL_NAMES = {
  'opencode/crouton-alpha-free': 'Crouton Alpha Free ★',
  'opencode/iceman-free': 'Iceman Free',
  'opencode/inkling-2-small-free': 'Inkling 2 Small Free',
  'opencode/flint-40b-free': 'Flint 40B Free',
  'opencode/nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL Free',
  'opencode/beam-free': 'Beam Free',
  'opencode/mimo-v2.6-flash-free': 'MiMo-V2.6-Flash Free',
  'opencode/deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash Free',
  'opencode/glm-5.3-flash-free': 'GLM-5.3-Flash Free',
  'opencode/big-pickle': 'Big Pickle'
};

// Theme
const savedTheme = localStorage.getItem('crouton-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
els.themeBtn.onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? '' : 'light';
  if (cur) document.documentElement.setAttribute('data-theme', cur);
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('crouton-theme', cur || 'dark');
};

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const data = await r.json();
    data.models.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = MODEL_NAMES[id] || id;
      els.model.appendChild(opt);
    });
    if (data.models.includes('opencode/crouton-alpha-free')) els.model.value = 'opencode/crouton-alpha-free';
  } catch {
    const opt = document.createElement('option');
    opt.value = 'opencode/crouton-alpha-free';
    opt.textContent = 'Crouton Alpha Free ★';
    els.model.appendChild(opt);
  }
}

function saveChats() {
  localStorage.setItem('crouton-chats', JSON.stringify(chats.slice(0, 50)));
  localStorage.setItem('crouton-current', currentId || '');
  renderChatList();
}

function getCurrent() { return chats.find(c => c.id === currentId) || null; }

function renderChatList() {
  els.chatList.replaceChildren();
  if (chats.length === 0) {
    const p = document.createElement('div');
    p.className = 'chatItem'; p.textContent = 'No chats yet';
    els.chatList.appendChild(p); return;
  }
  chats.forEach(c => {
    const d = document.createElement('div');
    d.className = 'chatItem' + (c.id === currentId ? ' active' : '');
    d.textContent = c.title || 'Untitled';
    d.onclick = () => { currentId = c.id; els.sidebar.classList.remove('open'); saveChats(); renderMessages(); };
    els.chatList.appendChild(d);
  });
}

function addMsg(role, content, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const m = document.createElement('div');
  m.className = 'meta';
  const label = document.createElement('span');
  label.textContent = meta || (role === 'user' ? 'You' : 'Crouton AI');
  m.appendChild(label);
  if (role === 'assistant') {
    const copy = document.createElement('button');
    copy.className = 'copy'; copy.type = 'button'; copy.textContent = 'Copy';
    copy.onclick = () => navigator.clipboard.writeText(content);
    m.appendChild(copy);
  }
  const b = document.createElement('div');
  b.textContent = content;
  wrap.append(m, b);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function renderMessages() {
  els.messages.replaceChildren();
  const c = getCurrent();
  if (!c || c.messages.length === 0) {
    addMsg('assistant', 'Hi! I\'m Crouton AI — live, free, no key needed.\n\nPick a model and think level, then ask anything.', 'Crouton AI');
    return;
  }
  c.messages.forEach(m => addMsg(m.role, m.content, m.role === 'user' ? 'You' : MODEL_NAMES[m.model] || 'Crouton AI' ));
}

// Login modal + many options
function openLogin() { els.loginModal.hidden = false; els.email.focus(); }
function closeLogin() { els.loginModal.hidden = true; els.loginBtn.focus(); }
els.loginBtn.onclick = openLogin;
els.closeLogin.onclick = closeLogin;
els.loginModal.addEventListener('click', (e) => { if (e.target === els.loginModal) closeLogin(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.loginModal.hidden) closeLogin(); });

async function refreshUser() {
  try {
    const r = await fetch('/api/auth/me');
    const d = await r.json();
    if (d.user) {
      els.userChip.hidden = false;
      els.userChip.textContent = `${d.user.provider === 'guest' ? '👤' : '●'} ${d.user.name || d.user.email || d.user.provider}`;
      els.loginBtn.textContent = 'Sign out';
    } else {
      els.userChip.hidden = true;
      els.loginBtn.textContent = 'Sign in';
    }
  } catch { /* offline */ }
}
els.loginBtn.onclick = async () => {
  // If logged in, click = logout; else open modal
  const chipVisible = !els.userChip.hidden;
  if (chipVisible) {
    await fetch('/api/auth/logout', { method: 'POST' });
    await refreshUser();
  } else openLogin();
};
els.guestBtn.onclick = async () => {
  els.emailMsg.textContent = 'Signing in as guest…';
  const r = await fetch('/api/auth/guest', { method: 'POST' });
  if (r.ok) { await refreshUser(); closeLogin(); } else els.emailMsg.textContent = 'Could not sign in. Try again.';
};
els.emailForm.onsubmit = async (e) => {
  e.preventDefault();
  els.emailMsg.textContent = 'Signing in…';
  const r = await fetch('/api/auth/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: els.email.value.trim() }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok) { await refreshUser(); closeLogin(); } else els.emailMsg.textContent = d.error || 'Sign-in failed';
};

els.newChat.onclick = () => {
  const id = Date.now().toString();
  chats.unshift({ id, title: 'New chat', messages: [] });
  currentId = id; saveChats(); renderMessages(); els.input.focus();
};
els.menuBtn.onclick = () => els.sidebar.classList.toggle('open');
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
});

els.form.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || sending) return;
  sending = true;
  els.input.value = '';
  els.typing.textContent = 'Thinking… (live)';

  let c = getCurrent();
  if (!c) {
    const id = Date.now().toString();
    c = { id, title: text.slice(0, 40) || 'New chat', messages: [] };
    chats.unshift(c); currentId = id;
  }
  c.messages.push({ role: 'user', content: text });
  if (c.title === 'New chat') c.title = text.slice(0, 40);
  saveChats(); renderMessages();
  addMsg('assistant', '…', 'Crouton AI');
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: c.messages.slice(-30).map(m => ({ role: m.role, content: m.content })), model: els.model.value, think: els.think.value })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Request failed');
    els.messages.lastChild?.remove();
    const assistantText = data.reply || 'No reply.';
    c.messages.push({ role: 'assistant', content: assistantText, model: data.model });
    saveChats(); renderMessages();
  } catch (err) {
    els.messages.lastChild?.remove();
    addMsg('assistant', `Error: ${err.message}. Please try again.`, 'Error');
  } finally {
    els.typing.textContent = '';
    sending = false;
    els.input.focus();
  }
};

loadModels().then(() => {
  if (!getCurrent() && chats.length > 0) currentId = chats[0].id;
  saveChats(); renderMessages(); refreshUser();
});

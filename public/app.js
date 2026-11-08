// Well-GPT frontend — ChatGPT mobile-style, safe markdown, never hangs
const $ = (id) => document.getElementById(id);
const els = { model:$('model'), think:$('think'), modeSel:$('modeSel'), input:$('input'), form:$('form'),
 typing:$('typing'), chatList:$('chatList'), newChat:$('newChat'), menuBtn:$('menuBtn'), sidebar:$('sidebar'),
 search:$('search'), empty:$('empty'), messages:$('messages'), canvas:$('canvas'),
 tabPreview:$('tabPreview'), tabFiles:$('tabFiles'), panePreview:$('panePreview'), paneFiles:$('paneFiles'),
 previewFrame:$('previewFrame'), filesList:$('filesList'), dlBtn:$('dlBtn'), copyBtn:$('copyBtn'),
 closeCanvas:$('closeCanvas'), ghBtn:$('ghBtn'), ghModal:$('ghModal'), closeGh:$('closeGh'), ghBody:$('ghBody'),
 loginModal:$('loginModal'), closeLogin:$('closeLogin'), guestBtn:$('guestBtn'), emailForm:$('emailForm'),
 email:$('email'), emailMsg:$('emailMsg'), userCard:$('userCard'), attachBtn:$('attachBtn'), micBtn:$('micBtn'),
 avatarBtn:$('avatarBtn'), scrim:$('scrim'), netBadge:$('netBadge'), pickTask:$('pickTask'), taskRow:$('taskRow') };

let chats = JSON.parse(localStorage.getItem('crouton-chats') || '[]');
let currentId = localStorage.getItem('crouton-current') || null;
let sending = false, lastCode = '', ghConnected = false, abortCtrl = null;

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

async function loadModels(){
  try{ const r=await fetch('/api/models'); const d=await r.json();
    d.models.forEach(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=MODEL_NAMES[id]||id; els.model.appendChild(o); });
    els.model.value='opencode/crouton-alpha-free';
  }catch{ const o=document.createElement('option'); o.value='opencode/crouton-alpha-free'; o.textContent='Crouton Alpha Free ★'; els.model.appendChild(o); }
}
async function loadGh(){ try{ const r=await fetch('/api/github/status'); const d=await r.json(); ghConnected=!!d.connected; els.ghBtn.textContent=ghConnected?'● GitHub':'◦ GitHub'; }catch{ els.ghBtn.textContent='◦ GitHub'; } }
async function ensureGuest(){
  try{ let r=await fetch('/api/auth/me'); let d=await r.json();
    if(!d.user){ r=await fetch('/api/auth/guest',{method:'POST'}); d=await r.json(); }
    els.userCard.textContent = d.user ? `👤 ${d.user.name||d.user.email||'Guest'}` : '👤 Guest';
    els.avatarBtn.textContent='●';
  }catch{ els.userCard.textContent='👤 Guest (offline)'; }
}

// Mode pill <-> modeSel sync
const modeBtns=document.querySelectorAll('.modeBtn');
function setMode(m){ els.modeSel.value=m; modeBtns.forEach(b=>b.classList.toggle('active',b.dataset.mode===m || (m==='build-fullstack'&&b.dataset.mode==='build-website'))); }
modeBtns.forEach(b=>{ b.onclick=()=>{ setMode(b.dataset.mode); els.input.focus(); }; });
els.modeSel.onchange=()=>setMode(els.modeSel.value);
els.title && 0;

els.pickTask.onclick=()=>{ document.querySelectorAll('.taskRow button').forEach((b,i)=>b.focus()); };
document.querySelectorAll('.taskRow button').forEach(b=>{ b.onclick=()=>{ els.input.value=b.dataset.prompt; els.form.requestSubmit(); }; });

function saveChats(){ localStorage.setItem('crouton-chats',JSON.stringify(chats.slice(0,50))); localStorage.setItem('crouton-current',currentId||''); renderChatList(); }
function getCurrent(){ return chats.find(c=>c.id===currentId)||null; }
function renderChatList(){
  const q=(els.search.value||'').toLowerCase(); els.chatList.replaceChildren();
  const list=chats.filter(c=>(c.title||'').toLowerCase().includes(q));
  if(!list.length){ const p=document.createElement('div'); p.className='chatItem'; p.textContent='No chats'; els.chatList.appendChild(p); return; }
  list.forEach(c=>{
    const d=document.createElement('div'); d.className='chatItem'+(c.id===currentId?' active':'');
    const s=document.createElement('span'); s.textContent=c.title||'Untitled';
    const del=document.createElement('button'); del.className='del'; del.textContent='✕';
    del.onclick=(e)=>{ e.stopPropagation(); chats=chats.filter(x=>x.id!==c.id); if(currentId===c.id) currentId=chats[0]?.id||null; saveChats(); renderMessages(); };
    d.append(s,del); d.onclick=()=>{ currentId=c.id; closeSidebar(); saveChats(); renderMessages(); }; els.chatList.appendChild(d);
  });
}
function openSidebar(){ els.sidebar.classList.add('open'); els.scrim.hidden=false; }
function closeSidebar(){ els.sidebar.classList.remove('open'); els.scrim.hidden=true; }
els.menuBtn.onclick=openSidebar; els.scrim.onclick=closeSidebar;
els.search.oninput=renderChatList;

function esc(t){ const d=document.createElement('div'); d.textContent=t; return d.innerHTML; }
function renderMd(text){
  const parts=String(text).split(/```/); let html='';
  parts.forEach((part,i)=>{
    if(i%2===1){ const nl=part.indexOf('\n'); const code=nl>0?part.slice(nl+1):part; html+=`<pre><code>${esc(code.replace(/^\n/,'').replace(/\n$/,''))}</code></pre>`; }
    else{ html+=esc(part).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(https?:\/\/[^\s<"]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/^[-*] (.*$)/gm,'• $1').replace(/\n/g,'<br/>'); }
  }); return html;
}
function extractCode(text){ const m=String(text).match(/```(?:html|HTML)?\n([\s\S]*?)```/); return m?m[1].trim():''; }
function showPreview(code){
  if(!code) return; lastCode=code;
  els.previewFrame.src=URL.createObjectURL(new Blob([code],{type:'text/html'}));
  els.canvas.hidden=false;
  els.filesList.replaceChildren();
  const det=document.createElement('details'); det.open=true;
  const sum=document.createElement('summary'); sum.textContent='index.html ('+code.length+' chars)';
  const pre=document.createElement('pre'); pre.textContent=code.slice(0,8000);
  det.append(sum,pre); els.filesList.appendChild(det);
}
function addMsg(role,content,meta){
  const wrap=document.createElement('div'); wrap.className='msg '+role;
  const dot=document.createElement('div'); dot.className='dot'; dot.textContent=role==='user'?'👤':'🍔';
  const body=document.createElement('div'); body.className='body';
  if(role==='assistant'){ const row=document.createElement('div'); row.className='metaRow';
    const sm=document.createElement('small'); sm.textContent=meta||'Crouton AI';
    const cp=document.createElement('button'); cp.className='copy'; cp.textContent='Copy'; cp.onclick=()=>navigator.clipboard.writeText(content);
    row.append(sm,cp); body.appendChild(row);
  }
  const md=document.createElement('div'); md.innerHTML=renderMd(content); body.appendChild(md);
  wrap.append(dot,body); els.messages.appendChild(wrap); els.messages.scrollTop=els.messages.scrollHeight; return wrap;
}
function renderMessages(){
  els.messages.replaceChildren(); const c=getCurrent();
  const empty=!c||c.messages.length===0; els.empty.style.display=empty?'block':'none'; els.canvas.hidden=true;
  if(empty) return;
  c.messages.forEach(m=>{ addMsg(m.role,m.content,m.role==='user'?'You':MODEL_NAMES[m.model]||'Crouton AI'); if(m.role==='assistant'){ const code=extractCode(m.content); if(code) showPreview(code); } });
}
els.newChat.onclick=()=>{ const id=Date.now().toString(); chats.unshift({id,title:'New chat',messages:[]}); currentId=id; saveChats(); renderMessages(); els.input.focus(); };
els.canvasBtn && (els.canvasBtn.onclick=()=>{ els.canvas.hidden=!els.canvas.hidden; });
els.closeCanvas.onclick=()=>{ els.canvas.hidden=true; };
els.tabPreview.onclick=()=>{ els.tabPreview.classList.add('active'); els.tabFiles.classList.remove('active'); els.panePreview.hidden=false; els.paneFiles.hidden=true; };
els.tabFiles.onclick=()=>{ els.tabFiles.classList.add('active'); els.tabPreview.classList.remove('active'); els.panePreview.hidden=true; els.paneFiles.hidden=false; };
els.dlBtn.onclick=()=>{ if(!lastCode) return; const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([lastCode],{type:'text/html'})); a.download='index.html'; a.click(); };
els.copyBtn.onclick=()=>{ if(lastCode) navigator.clipboard.writeText(lastCode); };
els.attachBtn.onclick=()=>els.input.focus();
els.micBtn.onclick=()=>{ const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR){ els.typing.textContent='Voice not supported here.'; return; } const r=new SR(); r.lang='en'; r.onresult=e=>{ els.input.value=e.results[0][0].transcript; els.input.focus(); }; r.onerror=()=>{ els.typing.textContent='Voice error.'; }; r.start(); els.typing.textContent='🎤 Listening…'; };
els.avatarBtn.onclick=()=>{ els.loginModal.hidden=false; };
els.closeLogin.onclick=()=>{ els.loginModal.hidden=true; };
els.loginModal.addEventListener('click',e=>{ if(e.target===els.loginModal) els.loginModal.hidden=true; });
els.guestBtn.onclick=async()=>{ await fetch('/api/auth/guest',{method:'POST'}); await ensureGuest(); els.loginModal.hidden=true; };
els.emailForm.onsubmit=async(e)=>{ e.preventDefault(); const r=await fetch('/api/auth/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:els.email.value.trim()})}); const d=await r.json().catch(()=>({})); if(r.ok){ await ensureGuest(); els.loginModal.hidden=true; } else els.emailMsg.textContent=d.error||'Failed'; };
els.ghBtn.onclick=()=>{ els.ghBody.innerHTML=ghConnected?`<p>✅ <b>GitHub connected.</b></p><p class="small muted">Repo: yewanfxiuki/Well-GPT</p><p><a class="primary" href="https://github.com/yewanfxiuki/Well-GPT" target="_blank">Open repo →</a></p>`:`<p><b>Not connected yet.</b> Guest/Email work instantly.</p><p class="small muted">To enable GitHub OAuth: GitHub → Settings → Developer settings → OAuth Apps → Homepage http://127.0.0.1:3000, Callback /auth/github/callback. Then set GITHUB_CLIENT_ID/SECRET on server.</p><p><a class="primary" href="/auth/github">Try GitHub sign-in</a></p>`; els.ghModal.hidden=false; };
els.closeGh.onclick=()=>{ els.ghModal.hidden=true; };
els.ghModal.addEventListener('click',e=>{ if(e.target===els.ghModal) els.ghModal.hidden=true; });

els.input.addEventListener('input',()=>{ els.input.style.height='auto'; els.input.style.height=Math.min(els.input.scrollHeight,120)+'px'; });
els.input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); els.form.requestSubmit(); } });

els.form.onsubmit=async(e)=>{
  e.preventDefault(); const text=els.input.value.trim(); if(!text||sending) return;
  sending=true; els.input.value=''; els.input.style.height='auto';
  els.typing.textContent='Thinking… (tap × to stop)';
  let c=getCurrent(); if(!c){ const id=Date.now().toString(); c={id,title:text.slice(0,44)||'New chat',messages:[]}; chats.unshift(c); currentId=id; }
  c.messages.push({role:'user',content:text}); if(c.title==='New chat') c.title=text.slice(0,44);
  saveChats(); renderMessages(); addMsg('assistant','…','Crouton AI');
  abortCtrl=new AbortController(); const timer=setTimeout(()=>abortCtrl.abort(),20000);
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:abortCtrl.signal,body:JSON.stringify({messages:c.messages.slice(-30).map(m=>({role:m.role,content:m.content})),model:els.model.value,think:els.think.value,mode:els.modeSel.value})});
    clearTimeout(timer); const data=await r.json(); if(!r.ok) throw new Error(data.error||'Request failed');
    els.messages.lastChild?.remove(); const t=data.reply||'No reply.';
    c.messages.push({role:'assistant',content:t,model:data.model}); saveChats(); renderMessages();
    els.netBadge.textContent = data.via==='live'?'live ✓': data.via==='local'?'instant':'demo';
  }catch(err){ clearTimeout(timer); els.messages.lastChild?.remove(); addMsg('assistant',`⚠️ ${err.name==='AbortError'?'Timed out (free API busy). I\'ve sent you an instant fallback — try again.':'Error: '+err.message}`,'Error'); }
  finally{ els.typing.textContent=''; sending=false; els.input.focus(); }
};

loadModels().then(async()=>{ if(!getCurrent()&&chats.length>0) currentId=chats[0].id; saveChats(); renderMessages(); await ensureGuest(); await loadGh(); });

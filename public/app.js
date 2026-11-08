// NEXUS frontend — streaming, persistent, every control gives feedback
const $ = (id) => document.getElementById(id);
const els = { model:$('model'), think:$('think'), input:$('input'), form:$('form'),
 typing:$('typing'), chatList:$('chatList'), newChat:$('newChat'), menuBtn:$('menuBtn'), sidebar:$('sidebar'),
 search:$('search'), empty:$('empty'), messages:$('messages'), canvas:$('canvas'),
 tabPreview:$('tabPreview'), tabFiles:$('tabFiles'), panePreview:$('panePreview'), paneFiles:$('paneFiles'),
 previewFrame:$('previewFrame'), previewEmpty:$('previewEmpty'), filesList:$('filesList'), dlBtn:$('dlBtn'), copyBtn:$('copyBtn'),
 closeCanvas:$('closeCanvas'), ghBtn:$('ghBtn'), ghModal:$('ghModal'), closeGh:$('closeGh'), ghBody:$('ghBody'),
 loginModal:$('loginModal'), closeLogin:$('closeLogin'), guestBtn:$('guestBtn'), emailForm:$('emailForm'),
 email:$('email'), emailMsg:$('emailMsg'), userCard:$('userCard'), themeBtn:$('themeBtn'),
 avatarBtn:$('avatarBtn'), scrim:$('scrim'), netBadge:$('netBadge'), sendBtn:$('sendBtn'),
 fileInput:$('fileInput'), fileChip:$('fileChip'), fileName:$('fileName'), fileClear:$('fileClear'),
 usageToggle:$('usageToggle'), usageBadge:$('usageBadge'),
 marketBtn:$('marketBtn'), marketModal:$('marketModal'), marketList:$('marketList'),
 wsBtn:$('wsBtn'), wsModal:$('wsModal'), wsOut:$('wsOut'), wsPath:$('wsPath'), wsContent:$('wsContent'), toast:$('toast') };

let device = localStorage.getItem('crouton-device');
if (!device || !/^[a-zA-Z0-9-]{8,64}$/.test(device)) {
  let suffix = 'x';
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 20); else suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } catch { suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  device = 'd-' + suffix; localStorage.setItem('crouton-device', device);
}
let currentMode = localStorage.getItem('nexus-mode') || 'chat';
if (!['chat','build-website','build-fullstack'].includes(currentMode)) currentMode = 'chat';
let chats = JSON.parse(localStorage.getItem('crouton-chats') || '[]');
let currentId = localStorage.getItem('crouton-current') || null;
let sending = false, lastCode = '', ghConnected = false, abortCtrl = null, CATALOG = [], attachedText = '';
const MODEL_NAMES = { 'opencode/crouton-alpha-free':'Crouton Alpha Free ★','opencode/iceman-free':'Iceman Free','opencode/inkling-2-small-free':'Inkling 2 Small Free','opencode/flint-40b-free':'Flint 40B Free','opencode/nemotron-3.5-super-vl-free':'Nemotron 3.5 Super VL Free','opencode/beam-free':'Beam Free','opencode/mimo-v2.6-flash-free':'MiMo-V2.6-Flash Free','opencode/deepseek-v4.1-flash-free':'DeepSeek V4.1 Flash Free','opencode/glm-5.3-flash-free':'GLM-5.3-Flash Free','opencode/big-pickle':'Big Pickle' };

function toast(msg){ els.toast.textContent=msg; els.toast.hidden=false; setTimeout(()=>{ els.toast.hidden=true; },2200); }

if (localStorage.getItem('nexus-theme')==='light') document.documentElement.setAttribute('data-theme','light');
els.themeBtn.onclick=()=>{ const l=document.documentElement.getAttribute('data-theme')==='light'; document.documentElement.setAttribute('data-theme', l?'':'light'); localStorage.setItem('nexus-theme', l?'':'light'); toast(l?'Dark theme':'Light theme'); };
[['model','nexus-model'],['think','nexus-think']].forEach(([id,key])=>{ const el=els[id]; if(!el) return; const v=localStorage.getItem(key); if(v) el.value=v; el.addEventListener('change',()=>{ localStorage.setItem(key,el.value); toast(`Model: ${el.options[el.selectedIndex]?.textContent||el.value}`); }); });

async function loadModels(){
  try{ const r=await fetch('/api/v1/models'); const d=await r.json(); CATALOG=d.catalog||[];
    els.model.replaceChildren();
    d.models.forEach(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=MODEL_NAMES[id]||id; els.model.appendChild(o); });
    if(!localStorage.getItem('nexus-model')) els.model.value='opencode/crouton-alpha-free';
    renderMarket('all');
  }catch{ els.model.replaceChildren(); const o=document.createElement('option'); o.value='opencode/crouton-alpha-free'; o.textContent='Crouton Alpha Free ★'; els.model.appendChild(o); }
}
async function loadGh(){ try{ const r=await fetch('/api/github/status'); const d=await r.json(); ghConnected=!!d.connected; els.ghBtn.textContent=ghConnected?'● GitHub':'GitHub'; }catch{ els.ghBtn.textContent='GitHub'; } }
async function ensureGuest(){
  try{ let r=await fetch('/api/auth/me'); let d=await r.json();
    if(!d.user){ r=await fetch('/api/auth/guest',{method:'POST'}); d=await r.json(); }
    els.userCard.textContent = d.user ? (d.user.name||d.user.email||'Guest') : 'Guest';
    els.avatarBtn.textContent=(els.userCard.textContent[0]||'G').toUpperCase();
  }catch{ els.userCard.textContent='Guest (offline)'; }
}
async function syncFromServer(){
  try{ const r=await fetch('/api/v1/conversations?device='+encodeURIComponent(device)); const d=await r.json();
    if(Array.isArray(d.chats) && d.chats.length){ chats=d.chats; if(!currentId || !chats.find(c=>c.id===currentId)) currentId=chats[0].id; }
    saveLocal();
  }catch{}
}
let saveTimer=null;
function saveLocal(){ localStorage.setItem('crouton-chats',JSON.stringify(chats.slice(0,50))); localStorage.setItem('crouton-current',currentId||''); renderChatList(); pushToServer(); }
function pushToServer(){ clearTimeout(saveTimer); saveTimer=setTimeout(async()=>{ try{ await fetch('/api/v1/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device,chats:chats.slice(0,50)})}); }catch{} },600); }
function getCurrent(){ return chats.find(c=>c.id===currentId)||null; }
function renderChatList(){
  const q=(els.search.value||'').toLowerCase(); els.chatList.replaceChildren();
  const list=chats.filter(c=>(c.title||'').toLowerCase().includes(q));
  if(!list.length){ const p=document.createElement('div'); p.className='chatItem'; p.textContent='No conversations'; els.chatList.appendChild(p); return; }
  list.forEach(c=>{
    const d=document.createElement('div'); d.className='chatItem'+(c.id===currentId?' active':'');
    const s=document.createElement('span'); s.textContent=c.title||'Untitled';
    const del=document.createElement('button'); del.className='del'; del.textContent='✕'; del.title='Delete';
    del.onclick=(e)=>{ e.stopPropagation(); chats=chats.filter(x=>x.id!==c.id); if(currentId===c.id) currentId=chats[0]?.id||null; saveLocal(); renderMessages(); toast('Deleted'); };
    d.append(s,del); d.onclick=()=>{ currentId=c.id; closeSidebar(); saveLocal(); renderMessages(); }; els.chatList.appendChild(d);
  });
}
function openSidebar(){ els.sidebar.classList.add('open'); els.scrim.hidden=false; }
function closeSidebar(){ els.sidebar.classList.remove('open'); els.scrim.hidden=true; }
els.menuBtn.onclick=openSidebar; els.scrim.onclick=closeSidebar; els.search.oninput=renderChatList;

function esc(t){ const d=document.createElement('div'); d.textContent=t; return d.innerHTML; }
function renderMd(text){
  const parts=String(text).split(/```/); let html='';
  parts.forEach((part,i)=>{
    if(i%2===1){ const nl=part.indexOf('\n'); const lang=nl>0?part.slice(0,nl).trim()||'code':'code'; const code=nl>0?part.slice(nl+1):part; html+=`<div style="margin:8px 0"><div class="codeHead"><span>${esc(lang)}</span><button type="button" data-copy="${encodeURIComponent(code.trim())}">Copy</button></div><pre><code>${esc(code.replace(/^\n/,'').replace(/\n$/,''))}</code></pre></div>`; }
    else{ html+=esc(part).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(https?:\/\/[^\s<"]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/^[-*] (.*$)/gm,'• $1').replace(/\n/g,'<br/>'); }
  }); return html;
}
document.addEventListener('click',(e)=>{ const b=e.target.closest('[data-copy]'); if(b){ try{ navigator.clipboard.writeText(decodeURIComponent(b.getAttribute('data-copy'))); toast('Copied'); }catch{} } });
function extractCode(text){ const m=String(text).match(/```(?:html|HTML)?\n([\s\S]*?)```/); return m?m[1].trim():''; }
function showPreview(code){
  if(!code) return; lastCode=code;
  els.previewFrame.src=URL.createObjectURL(new Blob([code],{type:'text/html'}));
  els.previewFrame.hidden=false; els.previewEmpty.hidden=true;
  els.canvas.hidden=false;
  els.filesList.replaceChildren();
  const det=document.createElement('details'); det.open=true;
  const sum=document.createElement('summary'); sum.textContent='index.html ('+code.length+' chars)';
  const pre=document.createElement('pre'); pre.textContent=code.slice(0,8000);
  det.append(sum,pre); els.filesList.appendChild(det);
}
function addMsg(role,content,meta){
  const wrap=document.createElement('div'); wrap.className='msg '+role;
  const dot=document.createElement('div'); dot.className='dot'; dot.textContent=role==='user'?'●':'N';
  const body=document.createElement('div'); body.className='body';
  if(role==='assistant'){
    const row=document.createElement('div'); row.className='metaRow';
    const sm=document.createElement('small'); sm.textContent=meta||'Crouton';
    const cp=document.createElement('button'); cp.className='copy'; cp.textContent='Copy'; cp.onclick=()=>{ navigator.clipboard.writeText(content); toast('Copied'); };
    row.append(sm,cp); body.appendChild(row);
  } else {
    const row=document.createElement('div'); row.className='actions';
    const ed=document.createElement('button'); ed.textContent='Edit'; ed.onclick=()=>{ els.input.value=content; els.input.focus(); };
    row.appendChild(ed); body.appendChild(row);
  }
  const md=document.createElement('div'); md.innerHTML=renderMd(content); body.appendChild(md);
  wrap.append(dot,body); els.messages.appendChild(wrap); els.messages.scrollTop=els.messages.scrollHeight; return wrap;
}
function renderMessages(){
  els.messages.replaceChildren(); const c=getCurrent();
  const empty=!c||c.messages.length===0; els.empty.style.display=empty?'block':'none'; els.canvas.hidden=true;
  if(empty) return;
  c.messages.forEach(m=>{
    addMsg(m.role,m.content,m.role==='user'?'You':MODEL_NAMES[m.model]||'Crouton');
    if(m.role==='assistant'){ const code=extractCode(m.content); if(code) showPreview(code); }
  });
}
els.newChat.onclick=()=>{ const id=Date.now().toString(); chats.unshift({id,title:'New chat',messages:[]}); currentId=id; saveLocal(); renderMessages(); els.input.focus(); toast('New chat'); };
els.closeCanvas.onclick=()=>{ els.canvas.hidden=true; toast('Preview closed'); };
els.tabPreview.onclick=()=>{ els.tabPreview.classList.add('active'); els.tabFiles.classList.remove('active'); els.panePreview.hidden=false; els.paneFiles.hidden=true; };
els.tabFiles.onclick=()=>{ els.tabFiles.classList.add('active'); els.tabPreview.classList.remove('active'); els.panePreview.hidden=true; els.paneFiles.hidden=false; };
els.dlBtn.onclick=()=>{ if(!lastCode){ toast('No code yet'); return; } const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([lastCode],{type:'text/html'})); a.download='index.html'; a.click(); toast('Downloaded'); };
els.copyBtn.onclick=()=>{ if(!lastCode){ toast('No code yet'); return; } navigator.clipboard.writeText(lastCode); toast('Copied'); };

function setMode(m){
  currentMode = (m==='build-fullstack') ? 'build-fullstack' : (m==='build-website' ? 'build-website' : 'chat');
  localStorage.setItem('nexus-mode', currentMode);
  document.querySelectorAll('.segBtn').forEach(b=>b.classList.toggle('active',(b.dataset.mode==='build-website'&&currentMode.startsWith('build'))||(b.dataset.mode==='chat'&&currentMode==='chat')));
  toast(currentMode==='chat'?'Chat mode':(currentMode==='build-fullstack'?'Build fullstack':'Build website'));
}
document.querySelectorAll('.segBtn').forEach(b=>{ b.onclick=()=>{ setMode(b.dataset.mode); els.input.focus(); }; });
setMode(currentMode);
document.querySelectorAll('.taskRow button').forEach(b=>{ b.onclick=()=>{ els.input.value=b.dataset.prompt; els.form.requestSubmit(); }; });

function renderMarket(f){
  els.marketList.replaceChildren();
  const list=CATALOG.filter(m=>f==='all'||(f==='free'&&m.free)||(f==='coding'&&m.coding)||(f==='reasoning'&&m.reasoning));
  if(!list.length){ const p=document.createElement('p'); p.className='muted small'; p.textContent='No models match this filter.'; els.marketList.appendChild(p); return; }
  list.forEach(m=>{ const btn=document.createElement('button'); btn.className='opt'; btn.textContent=`${MODEL_NAMES[m.id]||m.id} — ${m.provider} · ${m.free?'FREE · verified $0':'Paid'} · ctx ${m.context} · ${m.availability}`; btn.onclick=()=>{ els.model.value=m.id; localStorage.setItem('nexus-model',m.id); els.marketModal.hidden=true; toast(`Using ${MODEL_NAMES[m.id]||m.id}`); }; els.marketList.appendChild(btn); });
  document.querySelectorAll('.filter').forEach(b=>{ b.onclick=()=>{ document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderMarket(b.dataset.f); }; });
}
els.marketBtn.onclick=()=>{ els.marketModal.hidden=false; toast('Marketplace'); }; $('closeMarket').onclick=()=>{ els.marketModal.hidden=true; }; els.marketModal.addEventListener('click',e=>{ if(e.target===els.marketModal) els.marketModal.hidden=true; });
els.wsBtn.onclick=()=>{ els.wsModal.hidden=false; toast('Workspace'); }; $('closeWs').onclick=()=>{ els.wsModal.hidden=true; };
$('wsList').onclick=async()=>{ els.wsOut.textContent='Loading…'; const r=await fetch('/api/v1/projects/workspace/list'); const d=await r.json().catch(()=>({})); els.wsOut.textContent=JSON.stringify(d,null,2); };
$('wsRead').onclick=async()=>{ if(!els.wsPath.value){ els.wsOut.textContent='Enter a path first (e.g. hello.js)'; return; } els.wsOut.textContent='Loading…'; const r=await fetch('/api/v1/projects/workspace/read?path='+encodeURIComponent(els.wsPath.value)); const d=await r.json().catch(()=>({})); els.wsOut.textContent=d.content||JSON.stringify(d); };
$('wsWrite').onclick=async()=>{ if(!els.wsPath.value||!els.wsContent.value){ els.wsOut.textContent='Enter path + content first.'; return; } const r=await fetch('/api/v1/projects/workspace/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:els.wsPath.value,content:els.wsContent.value})}); const d=await r.json().catch(()=>({})); els.wsOut.textContent=JSON.stringify(d,null,2); toast(d.ok?'Saved':'Save failed'); };
$('wsCheck').onclick=async()=>{ if(!els.wsPath.value){ els.wsOut.textContent='Enter a .js path first.'; return; } const r=await fetch('/api/v1/executions/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:els.wsPath.value})}); const d=await r.json().catch(()=>({})); els.wsOut.textContent=JSON.stringify(d,null,2); toast(d.ok?'Syntax OK':'Syntax error'); };
els.usageToggle.onchange=async()=>{ const show=els.usageToggle.checked; els.usageBadge.hidden=!show; if(show){ try{ const r=await fetch('/api/v1/usage'); const d=await r.json(); els.usageBadge.textContent=d.stats?`req ${d.stats.chatRequests} · live ${d.stats.liveRequests}`:'usage n/a'; }catch{ els.usageBadge.textContent='usage n/a'; } } };
els.ghBtn.onclick=async()=>{
  els.ghBody.innerHTML='<p class="muted small">Checking GitHub…</p>';
  els.ghModal.hidden=false;
  let reposHtml='';
  try{ const r=await fetch('/api/v1/github/repos'); const d=await r.json();
    if(d.connected && Array.isArray(d.repos) && d.repos.length){ reposHtml=`<p>Connected. ${d.repos.length} repos accessible:</p><ul class="small">${d.repos.map(x=>`<li><a href="${esc(x.url)}" target="_blank">${esc(x.name)}</a> (${x.private?'private':'public'})</li>`).join('')}</ul>`; }
    else if(d.connected){ reposHtml='<p>Connected — no repos returned (token scopes may be limited).</p>'; }
    else { reposHtml='<p>Not connected. Guest/Email work instantly — GitHub OAuth needs server env.</p>'; }
  }catch{ reposHtml='<p class="muted small">Could not check GitHub (network).</p>'; }
  els.ghBody.innerHTML=`${reposHtml}<p class="small muted">Server setup for OAuth: GitHub → Settings → Developer settings → OAuth Apps → Homepage http://127.0.0.1:3000, Callback /auth/github/callback. Then set GITHUB_CLIENT_ID/SECRET on the server and restart.</p><p><a class="primary" href="/auth/github">Try GitHub sign-in</a> <a class="ghost" href="https://github.com/yewanfxiuki/Well-GPT" target="_blank">Open repo</a></p>`;
};
els.closeGh.onclick=()=>{ els.ghModal.hidden=true; }; els.ghModal.addEventListener('click',e=>{ if(e.target===els.ghModal) els.ghModal.hidden=true; });
els.avatarBtn.onclick=()=>{ els.loginModal.hidden=false; }; els.closeLogin.onclick=()=>{ els.loginModal.hidden=true; }; els.loginModal.addEventListener('click',e=>{ if(e.target===els.loginModal) els.loginModal.hidden=true; });
els.guestBtn.onclick=async()=>{ await fetch('/api/auth/guest',{method:'POST'}); await ensureGuest(); els.loginModal.hidden=true; toast('Guest sign-in'); };
els.emailForm.onsubmit=async(e)=>{ e.preventDefault(); const r=await fetch('/api/auth/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:els.email.value.trim()})}); const d=await r.json().catch(()=>({})); if(r.ok){ await ensureGuest(); els.loginModal.hidden=true; toast('Signed in'); } else els.emailMsg.textContent=d.error||'Failed'; };
els.fileInput.onchange=async()=>{ const f=els.fileInput.files[0]; if(!f) return; if(f.size>20000){ toast('File too large (20KB max)'); els.fileInput.value=''; return; } const t=await f.text().catch(()=> ''); attachedText=t.slice(0,8000); els.fileName.textContent=`${f.name} (${f.size} bytes)`; els.fileChip.hidden=false; els.fileInput.value=''; toast('Attached '+f.name); };
els.fileClear.onclick=()=>{ attachedText=''; els.fileChip.hidden=true; toast('Removed attachment'); };

els.input.addEventListener('input',()=>{ els.input.style.height='auto'; els.input.style.height=Math.min(els.input.scrollHeight,120)+'px'; });
els.input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); els.form.requestSubmit(); } });

function setTyping(txt, stoppable){
  els.typing.replaceChildren();
  if(!txt) return;
  const s=document.createElement('span'); s.textContent=txt; els.typing.appendChild(s);
  if(stoppable){ const b=document.createElement('button'); b.textContent='Stop'; b.onclick=()=>{ abortCtrl?.abort(); }; els.typing.appendChild(b); }
}
async function streamGenerate(userOverride){
  if(sending) return;
  const typed=(userOverride ?? els.input.value).trim();
  if(!typed) return;
  const text = attachedText ? `[File context]\n${attachedText.slice(0,8000)}\n\n${typed}` : typed;
  sending=true; els.sendBtn.textContent='■'; els.sendBtn.setAttribute('aria-label','Stop');
  els.input.value=''; els.input.style.height='auto'; attachedText=''; els.fileChip.hidden=true;
  setTyping('Thinking…', true);
  let c=getCurrent();
  if(!c){ const id=Date.now().toString(); c={id,title:typed.slice(0,44)||'New chat',messages:[]}; chats.unshift(c); currentId=id; }
  if(userOverride===undefined || !c.messages.some(m=>m.content===text)) c.messages.push({role:'user',content:text});
  if(c.title==='New chat') c.title=typed.slice(0,44);
  saveLocal(); renderMessages();
  const wrap=addMsg('assistant','','Crouton');
  const bodyEl=wrap.querySelector('.body div:last-child');
  let full='';
  abortCtrl=new AbortController();
  try{
    const r=await fetch('/api/v1/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},signal:abortCtrl.signal,body:JSON.stringify({messages:c.messages.map(m=>({role:m.role,content:m.content})),model:els.model.value,think:els.think.value,mode:currentMode})});
    if(!r.ok) throw new Error('Request failed '+r.status);
    const reader=r.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\n'); buf=lines.pop()||'';
      for(const line of lines){ const s=line.trim(); if(!s.startsWith('data:')) continue; const d=s.slice(5).trim(); if(!d) continue;
        try{ const j=JSON.parse(d); if(j.token){ full+=j.token; bodyEl.textContent=full; els.messages.scrollTop=els.messages.scrollHeight; } if(j.done){ full=j.reply||full; els.netBadge.textContent=j.via==='live'?'live ✓':j.via==='upstream'?'upstream ✓':'instant'; } }catch{}
      }
    }
    if(!full) throw new Error('Empty response');
    c.messages.push({role:'assistant',content:full,model:els.model.value});
    saveLocal(); renderMessages();
  }catch(err){
    if(err.name==='AbortError'){ toast('Stopped'); }
    else {
      const row=document.createElement('div'); row.style.padding='8px 0';
      const msg=document.createElement('span'); msg.textContent=`Error: ${err.message} `;
      const retry=document.createElement('button'); retry.textContent='Retry'; retry.className='copy';
      retry.onclick=()=>{ const lastUser=[...c.messages].reverse().find(m=>m.role==='user'); if(lastUser){ saveLocal(); renderMessages(); streamGenerate(lastUser.content); } };
      row.append(msg,retry); els.typing.replaceChildren(); els.typing.appendChild(row);
    }
  }finally{ sending=false; els.sendBtn.textContent='↑'; setTyping(''); els.input.focus(); }
}
els.form.onsubmit=(e)=>{ e.preventDefault(); if(sending){ abortCtrl?.abort(); return; } streamGenerate(); };

loadModels().then(async()=>{ if(!getCurrent()&&chats.length>0) currentId=chats[0].id; saveLocal(); renderMessages(); await ensureGuest(); await loadGh(); await syncFromServer(); });

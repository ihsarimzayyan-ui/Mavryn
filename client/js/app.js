import { icon, reactionIcons } from './icons.js';

const APP = 'Mavryn';
const root = document.getElementById('app');
const toast = document.getElementById('toast');
const state = {
  me: null, users: [], conversations: [], messages: [], stories: [], calls: [],
  activeConversation: null, tab: 'chats', authMode: 'login', forgotStep: 1,
  forgotQuestion: '', forgotName: '', search: '', typingUser: null, replyTo: null,
  theme: localStorage.getItem('mavryn_theme') || 'dark', socket: null, installPrompt: null,
  pendingCall: null, currentCall: null, callPc: null, callRemote: null, callLocal: null, callAccepted:false, pendingOffer:null,
  callMuted: false, cameraOff: false, screenTrack: null, forwardMessage: null,
  storiesCursor: 0, storyFilter: 'all'
};

const api = async (url, options = {}) => {
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const escapeHtml = (s = '') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtTime = (v) => new Date(v).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
const fmtDate = (v) => new Date(v).toLocaleDateString([], { day:'numeric', month:'short' });
const fmtBytes = (n) => n > 1024*1024 ? `${(n/1024/1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n/1024))} KB`;
const initials = (u) => (u?.displayName || u?.name || '?').trim().split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase();
const userById = id => state.users.find(u => u.id === String(id));
const activeOther = c => c?.type === 'direct' ? userById(c.participants.find(id => id !== state.me.id)) : null;
const convName = c => c?.type === 'group' ? c.name : (activeOther(c)?.displayName || activeOther(c)?.name || 'Conversation');
const avatar = (uOrC, cls='') => {
  const u = uOrC?.displayName ? uOrC : (uOrC?.type === 'group' ? { displayName: uOrC.name, avatarUrl: uOrC.avatarUrl } : activeOther(uOrC));
  return `<div class="avatar ${cls}">${u?.avatarUrl ? `<img src="${u.avatarUrl}" alt="">` : `<span>${escapeHtml(initials(u))}</span>`}${u?.online ? '<span class="online"></span>' : ''}</div>`;
};
const iconBtn = (action, name, label, cls='') => `<button class="tiny-btn ${cls}" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon(name,19)}</button>`;
const showToast = (message, kind='info') => { toast.textContent = message; toast.dataset.kind = kind; toast.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>toast.classList.remove('show'),2600); };
const saveTheme = t => { state.theme=t; localStorage.setItem('mavryn_theme', t); document.documentElement.dataset.theme=t; };

function authView() {
  const login = state.authMode === 'login';
  const register = state.authMode === 'register';
  const forgot = state.authMode === 'forgot';
  let body = '';
  if (login) {
    body = `<form data-form="login">
      <div class="field"><label>Account name</label><input name="name" autocomplete="username" required maxlength="30"></div>
      <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
      <button class="primary" type="submit">Sign in</button>
      <div class="auth-links"><button class="link" type="button" data-action="auth-register">Create account</button><button class="link" type="button" data-action="auth-forgot">Forgot password?</button></div>
    </form>`;
  } else if (register) {
    body = `<form data-form="register">
      <div class="field"><label>Name</label><input name="name" required maxlength="30"></div>
      <div class="field"><label>Password</label><input name="password" type="password" minlength="8" required></div>
      <div class="field"><label>Confirm password</label><input name="confirm" type="password" minlength="8" required></div>
      <div class="field"><label>Recovery question</label><input name="question" placeholder="Example: What is my favorite color?" required maxlength="120"></div>
      <div class="field"><label>Recovery answer</label><input name="answer" required maxlength="120"></div>
      <button class="primary" type="submit">Create account</button>
      <p class="small-note">This private space supports 10 accounts total. The administrator account is reserved.</p>
      <div class="auth-links"><button class="link" type="button" data-action="auth-login">Back to sign in</button></div>
    </form>`;
  } else {
    body = state.forgotStep === 1 ? `<form data-form="forgot-name">
      <div class="field"><label>Account name</label><input name="name" required maxlength="30"></div>
      <button class="primary" type="submit">Continue</button>
      <div class="auth-links"><button class="link" type="button" data-action="auth-login">Back to sign in</button></div>
    </form>` : `<form data-form="forgot-reset">
      <div class="field"><label>Recovery question</label><div class="question-card">${escapeHtml(state.forgotQuestion)}</div></div>
      <div class="field"><label>Answer</label><input name="answer" required></div>
      <div class="field"><label>New password</label><input name="newPassword" type="password" minlength="8" required></div>
      <button class="primary" type="submit">Reset password</button>
      <div class="auth-links"><button class="link" type="button" data-action="auth-login">Back to sign in</button></div>
    </form>`;
  }
  root.innerHTML = `<div class="auth"><div class="auth-card">
    <img class="auth-brand" src="/assets/brand.svg" alt="${APP}">
    <div class="eyebrow">PRIVATE REAL-TIME SPACE</div>
    <h1 class="auth-title">${login?'Welcome back':register?'Create your account':'Recover your account'}</h1>
    <p class="auth-sub">A private 10-member messaging environment built for fast, secure conversation.</p>
    ${body}<div id="auth-error" class="err"></div>
  </div></div>`;
  // authView replaces the DOM, so bind the newly-created forms/buttons immediately.
  bindUI();
}

function renderShell() {
  document.documentElement.dataset.theme = state.theme;
  const tabs = [
    ['chats','grid','Chats'],['people','users','People'],['stories','story','Stories'],['calls','phonecall','Calls'],['settings','settings','Settings']
  ];
  if (state.me?.role === 'admin') tabs.push(['admin','admin','Admin']);
  root.innerHTML = `<div class="app-shell">
    <nav class="rail">
      <button class="brand-btn" data-action="home" aria-label="Home"><img src="/assets/brand.svg" alt="${APP}"></button>
      <div class="rail-nav">${tabs.map(([id,ico,label])=>`<button class="rail-btn ${state.tab===id?'active':''}" data-tab="${id}" title="${label}" aria-label="${label}">${icon(ico,20)}</button>`).join('')}</div>
      <div class="rail-spacer"></div>
      <button class="profile-mini" data-action="profile-settings" title="Profile">${avatar(state.me,'sm')}</button>
      <button class="rail-btn" data-action="logout" title="Sign out">${icon('logout',20)}</button>
    </nav>
    <aside class="sidebar ${state.tab==='chats'&&innerWidth<=900&&state.activeConversation?'open':''}">
      ${sidebarContent()}
    </aside>
    <main class="main">${mainContent()}</main>
    <div id="modal-root"></div>
  </div>`;
  bindUI();
}

function sidebarContent() {
  const title = {chats:'Chats',people:'People',stories:'Stories',calls:'Calls',settings:'Settings',admin:'Admin'}[state.tab] || 'Mavryn';
  return `<div class="side-head"><div><div class="eyebrow">MAVRYN</div><div class="side-title">${title}</div></div><div class="side-actions">${state.tab==='chats'?iconBtn('new-chat','plus','New chat'):''}${state.tab==='people'?iconBtn('new-group','users','New circle'):''}${state.tab==='stories'?iconBtn('new-story','plus','New story'):''}</div></div>
  <div class="search-wrap"><span class="search-ico">${icon('search',17)}</span><input class="search" id="global-search" value="${escapeHtml(state.search)}" placeholder="Search people, chats, messages" autocomplete="off"></div>
  ${state.tab==='chats'?`<div class="tabs"><button class="tab active">All</button><button class="tab" data-action="show-people">Unread</button><button class="tab" data-action="show-stories">Calls</button></div>`:''}
  <div class="list" id="side-list">${sidebarList()}</div>`;
}

function searchList(){
  const q=state.search.trim().toLowerCase();
  const people=state.users.filter(u=>u.id!==state.me.id && [u.displayName,u.name,u.bio].some(x=>String(x||'').toLowerCase().includes(q))).slice(0,12);
  const chats=state.conversations.filter(c=>convName(c).toLowerCase().includes(q)).slice(0,12);
  return `<div class="search-section"><div class="eyebrow">PEOPLE</div>${people.map(u=>`<button class="person-row" data-action="start-chat" data-id="${u.id}">${avatar(u,'sm')}<span class="person-copy"><b>${escapeHtml(u.displayName)}</b><span>@${escapeHtml(u.name)}</span></span>${icon('send',15)}</button>`).join('')||'<div class="empty-list">No people found.</div>'}</div><div class="search-section"><div class="eyebrow">CHATS</div>${chats.map(c=>`<button class="conv" data-action="open-chat" data-id="${c.id}">${avatar(c,'sm')}<span class="conv-main"><span class="conv-name">${escapeHtml(convName(c))}</span><span class="conv-preview">${escapeHtml(c.lastMessage?.text||'Conversation')}</span></span></button>`).join('')||'<div class="empty-list">No matching chats.</div>'}</div>`;
}

function sidebarList() {
  if (state.search.trim()) return searchList();
  if (state.tab==='chats') return state.conversations.map(c => {
    const last = c.lastMessage;
    const preview = last ? (last.text || `[${last.type}]`) : 'No messages yet';
    return `<button class="conv ${state.activeConversation?.id===c.id?'active':''}" data-action="open-chat" data-id="${c.id}">${avatar(c,'sm')}<span class="conv-main"><span class="conv-top"><span class="conv-name">${escapeHtml(convName(c))}</span><span class="conv-time">${last?fmtDate(last.createdAt):''}</span></span><span class="conv-preview">${escapeHtml(preview)}</span></span>${c.unreadCount?`<span class="badge">${c.unreadCount>99?'99+':c.unreadCount}</span>`:''}</button>`;
  }).join('') || `<div class="empty-list">No conversations yet.<br><button class="link" data-action="show-people">Find people</button></div>`;
  if (state.tab==='people') return state.users.filter(u=>u.id!==state.me.id).map(u=>`<div class="person-row">${avatar(u,'sm')}<span class="person-copy"><b>${escapeHtml(u.displayName)}</b><span>${u.online?'Online':u.statusText||'Available'}</span></span><button class="tiny-btn" data-action="start-chat" data-id="${u.id}" title="Message">${icon('send',16)}</button></div>`).join('') || `<div class="empty-list">No other accounts yet.</div>`;
  if (state.tab==='stories') return state.stories.length ? state.stories.map(s=>`<button class="story-row" data-action="view-story" data-id="${s.id}">${avatar(s.user,'sm')}<span><b>${escapeHtml(s.user?.displayName||'Story')}</b><span>${s.text?escapeHtml(s.text.slice(0,38)):'Media story'}</span></span></button>`).join('') : `<div class="empty-list">No active stories.<br><button class="link" data-action="new-story">Create one</button></div>`;
  if (state.tab==='calls') return state.calls.length ? state.calls.map(c=>`<button class="story-row" data-action="call-again" data-id="${c.userId||''}" data-kind="${c.kind||'audio'}">${avatar(userById(c.userId),'sm')}<span><b>${escapeHtml(userById(c.userId)?.displayName||'Call')}</b><span>${c.kind==='video'?'Video':'Voice'} · ${fmtDate(c.startedAt)}</span></span><span class="call-icon">${icon(c.status==='missed'?'flag':'phonecall',15)}</span></button>`).join('') : `<div class="empty-list">No call history.</div>`;
  if (state.tab==='admin') return `<div class="admin-side"><div class="admin-card"><b>Administrator</b><span>A</span><small>Full control of the private space.</small></div><button class="admin-nav" data-action="admin-refresh">${icon('grid',16)} Overview</button><button class="admin-nav" data-action="admin-users">${icon('users',16)} Accounts</button><button class="admin-nav" data-action="admin-reports">${icon('flag',16)} Reports</button></div>`;
  return `<div class="admin-side"><button class="admin-nav" data-action="profile-settings">${icon('user',16)} Profile</button><button class="admin-nav" data-action="security-settings">${icon('shield',16)} Security</button><button class="admin-nav" data-action="appearance-settings">${icon('sun',16)} Appearance</button><button class="admin-nav" data-action="notification-settings">${icon('bell',16)} Notifications</button></div>`;
}

function mainContent() {
  if (state.tab==='settings') return settingsPanel();
  if (state.tab==='people') return peoplePanel();
  if (state.tab==='stories') return storiesPanel();
  if (state.tab==='calls') return callsPanel();
  if (state.tab==='admin') return adminPanel();
  if (!state.activeConversation) return `<section class="empty"><div class="empty-card"><img class="empty-logo" src="/assets/brand.svg"><div class="eyebrow">PRIVATE / TEN MEMBERS</div><h1>Welcome to Mavryn</h1><p>Start a conversation from People, or choose an existing chat. Messages, profiles and presence update in real time.</p><button class="primary narrow" data-action="show-people">Browse people</button></div></section>`;
  return chatPanel();
}

function chatPanel() {
  const c = state.activeConversation;
  const person = activeOther(c);
  const name = convName(c);
  const typing = state.typingUser && state.typingUser.conversationId===c.id;
  return `<section class="chat-view">
    <header class="chat-head"><div class="chat-person"><button class="tiny-btn mobile-back" data-action="close-mobile-chat">${icon('back',18)}</button>${avatar(c)}<div><div class="chat-name">${escapeHtml(name)}</div><div class="chat-state">${typing?`${escapeHtml(userById(state.typingUser.userId)?.displayName||'Someone')} is typing…`:c.type==='group'?`${c.participants.length} members`:person?.online?'Online':person?.lastSeen?`Last seen ${fmtDate(person.lastSeen)}`:'Offline'}</div></div></div><div class="chat-actions">${iconBtn('start-audio','phone','Voice call')} ${iconBtn('start-video','video','Video call')} ${iconBtn('chat-info','info','Details')}</div></header>
    <div class="messages" id="messages">${messageList()}</div>
    <div class="composer-wrap">
      <div class="reply-bar ${state.replyTo?'show':''}"><span>${icon('back',14)}</span><span class="reply-copy">Replying to ${escapeHtml((state.replyTo?.text||'').slice(0,120))}</span><button class="link" data-action="cancel-reply">Cancel</button></div>
      <div class="composer"><button class="tiny-btn" data-action="attach" title="Attach file">${icon('paperclip',19)}</button><button class="tiny-btn" data-action="stickers" title="Stickers">${icon('smile',18)}</button><textarea id="composer-input" placeholder="Write a message…" rows="1"></textarea><button class="tiny-btn" data-action="voice-record" title="Voice message">${icon('mic',18)}</button><button class="send-btn" data-action="send-message" aria-label="Send">${icon('send',19,2)}</button><input id="file-input" type="file" class="hidden" accept="image/*,video/*,audio/*,.pdf,.txt,.zip,.doc,.docx,.xls,.xlsx"></div>
      <div class="composer-hint">Enter to send · Shift+Enter for a new line · files are encrypted in transit</div>
    </div>
  </section>`;
}

function messageList() {
  if (!state.messages.length) return `<div class="message-empty"><div class="eyebrow">FIRST MESSAGE</div><p>Start the conversation.</p></div>`;
  let currentDay='';
  return state.messages.map(m=>{
    const day=fmtDate(m.createdAt); const sep=day!==currentDay?`<div class="date-sep">${day}</div>`:''; currentDay=day;
    const me=m.senderId===state.me.id; const sender=userById(m.senderId);
    let attachment='';
    if(m.attachment?.url){const mt=m.attachment.contentType||''; if(mt.startsWith('image/')) attachment=`<div class="attach"><img src="${m.attachment.url}" alt="${escapeHtml(m.attachment.filename||'Image')}"></div>`; else if(mt.startsWith('video/')) attachment=`<div class="attach"><video src="${m.attachment.url}" controls></video></div>`; else if(mt.startsWith('audio/')) attachment=`<div class="attach audio"><audio src="${m.attachment.url}" controls></audio></div>`; else attachment=`<a class="file-card" href="${m.attachment.url}" target="_blank" rel="noopener">${icon('file',18)}<span><b>${escapeHtml(m.attachment.filename||'File')}</b><small>${m.attachment.size?fmtBytes(m.attachment.size):''}</small></span></a>`;}
    const reactions=Object.entries(m.reactions||{}).filter(([,ids])=>ids?.length).map(([k,ids])=>`<span class="reaction-pill">${reactionIcons[k]||''}${ids.length}</span>`).join('');
    const stateMark=me?`<span>${m.seenBy?.length>1?icon('doublecheck',11):icon('check',11)}</span>`:'';
    const reply=m.replyTo?state.messages.find(x=>x.id===m.replyTo):null;
    return `${sep}<div class="row ${me?'me':''}" data-message-id="${m.id}">${!me?avatar(sender,'sm'):''}<div class="msg"><div class="msg-toolbar"><button class="msg-tool" data-action="reply-message" data-id="${m.id}" title="Reply">${icon('back',15)}</button><button class="msg-tool" data-action="message-more" data-id="${m.id}" title="More">${icon('more',15)}</button></div>${reply?`<div class="reply-quote">${escapeHtml(reply.text||'Attachment')}</div>`:''}${m.text?`<div class="msg-text">${escapeHtml(m.text)}</div>`:''}${attachment}<div class="msg-meta"><span>${m.editedAt?'edited · ':''}${fmtTime(m.createdAt)}</span>${stateMark}</div>${reactions?`<div class="reaction-row">${reactions}</div>`:''}</div></div>`;
  }).join('');
}

function peoplePanel() {
  const others=state.users.filter(u=>u.id!==state.me.id);
  return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">PRIVATE DIRECTORY</div><h2>People</h2><p>Every account has an independent identity, profile and presence.</p></div><button class="primary narrow" data-action="new-group">${icon('plus',17)} Create circle</button></div><div class="people-grid">${others.map(u=>`<article class="person-card">${avatar(u,'lg')}<div class="person-main"><h3>${escapeHtml(u.displayName)}</h3><p>@${escapeHtml(u.name)}</p><div class="status-line">${u.online?'<span class="dot"></span> Online':escapeHtml(u.statusText||'Available')}</div><div class="person-actions"><button class="secondary compact" data-action="start-chat" data-id="${u.id}">${icon('send',15)} Message</button><button class="tiny-btn" data-action="person-details" data-id="${u.id}">${icon('info',16)}</button></div></div></article>`).join('') || `<div class="empty-list">No other members have registered yet.</div>`}</div></section>`;
}

function storiesPanel() {
  return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">24 HOURS</div><h2>Stories</h2><p>Short updates disappear automatically after 24 hours.</p></div><button class="primary narrow" data-action="new-story">${icon('plus',17)} New story</button></div><div class="story-grid">${state.stories.map(s=>`<button class="story-card" data-action="view-story" data-id="${s.id}">${s.mediaUrl?`<img src="${s.mediaUrl}" alt="">`:''}<div class="story-overlay"><div>${avatar(s.user,'sm')}</div><b>${escapeHtml(s.user?.displayName||'Story')}</b><span>${escapeHtml(s.text||'')}</span></div></button>`).join('') || `<div class="empty-list">No active stories.</div>`}</div></section>`;
}

function callsPanel() {
  return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">REAL-TIME</div><h2>Calls</h2><p>Voice and video calls are relayed through the secure signalling channel.</p></div></div><div class="call-list">${state.calls.map(c=>`<article class="call-card">${avatar(userById(c.userId),'sm')}<div><b>${escapeHtml(userById(c.userId)?.displayName||'Member')}</b><p>${c.kind==='video'?'Video':'Voice'} · ${fmtDate(c.startedAt)} · ${c.status||'completed'}</p></div><button class="tiny-btn" data-action="call-again" data-id="${c.userId}" data-kind="${c.kind||'audio'}">${icon(c.kind==='video'?'video':'phonecall',16)}</button></article>`).join('') || `<div class="empty-list">No call records yet.</div>`}</div></section>`;
}

function settingsPanel() {
  return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">CONTROL CENTER</div><h2>Settings</h2><p>Shape your profile, privacy and app experience.</p></div></div><div class="settings-grid">
    <button class="setting-card" data-action="profile-settings">${icon('user',22)}<b>Profile</b><span>Photo, name, bio and status</span></button>
    <button class="setting-card" data-action="security-settings">${icon('shield',22)}<b>Security</b><span>Password and recovery</span></button>
    <button class="setting-card" data-action="appearance-settings">${icon('sun',22)}<b>Appearance</b><span>Theme and chat feel</span></button>
    <button class="setting-card" data-action="notification-settings">${icon('bell',22)}<b>Notifications</b><span>Browser alerts and sound</span></button><button class="setting-card" data-action="privacy-settings">${icon('shield',22)}<b>Privacy</b><span>Blocked accounts and messaging controls</span></button>
    <button class="setting-card" data-action="about-settings">${icon('info',22)}<b>About ${APP}</b><span>Private 10-account network</span></button>
    <button class="setting-card danger-card" data-action="delete-account">${icon('trash',22)}<b>Delete account</b><span>Free the account slot</span></button>
  </div></section>`;
}

let adminMode='overview';
async function adminPanel(){
  // Render shell first; details load into panel async.
  if(adminMode==='users') return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">ADMINISTRATOR</div><h2>Accounts</h2><p>Manage the ten private slots and account status.</p></div>${iconBtn('admin-refresh','back','Back')}</div><div id="admin-body" class="admin-body"><div class="loading-card">Loading…</div></div></section>`;
  if(adminMode==='reports') return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">ADMINISTRATOR</div><h2>Reports</h2><p>Review member reports and update their status.</p></div>${iconBtn('admin-refresh','back','Back')}</div><div id="admin-body" class="admin-body"><div class="loading-card">Loading…</div></div></section>`;
  return `<section class="page-panel"><div class="page-heading"><div><div class="eyebrow">ADMINISTRATOR</div><h2>Overview</h2><p>Private network health, announcements and controls.</p></div></div><div id="admin-body" class="admin-body"><div class="loading-card">Loading…</div></div></section>`;
}

function bindUI(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', async()=>{state.tab=b.dataset.tab;if(state.tab==='stories')await loadStories();if(state.tab==='calls')await loadCalls();renderShell();if(state.tab==='admin')loadAdminBody();}));
  const search=document.getElementById('global-search'); if(search){search.addEventListener('input',()=>{state.search=search.value; renderShell(); const s=document.getElementById('global-search'); if(s){s.focus();s.setSelectionRange(state.search.length,state.search.length);} });}
  document.querySelectorAll('[data-action]').forEach(el=>el.addEventListener('click',()=>handleAction(el.dataset.action,el.dataset)));
  document.querySelectorAll('form[data-form]').forEach(f=>f.addEventListener('submit', async e=>{e.preventDefault();await handleForm(f.dataset.form,new FormData(f));}));
  const composer=document.getElementById('composer-input'); if(composer){ composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleAction('send-message');}}); composer.addEventListener('input',()=>{autoGrow(composer); sendTyping(true); clearTimeout(sendTyping.t); sendTyping.t=setTimeout(()=>sendTyping(false),900);}); }
  document.getElementById('file-input')?.addEventListener('change',handleFile);
  document.querySelectorAll('.msg').forEach(m=>m.addEventListener('contextmenu',e=>e.preventDefault()));
  const messages=document.getElementById('messages'); if(messages){messages.scrollTop=messages.scrollHeight; markLatestSeen();}
  if(state.tab==='admin') loadAdminBody();
}

function autoGrow(el){el.style.height='auto';el.style.height=Math.min(120,el.scrollHeight)+'px';}

async function handleForm(type, fd){
  const data=Object.fromEntries(fd.entries()); const err=document.getElementById('auth-error');
  try{
    if(type==='login'){const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify(data)});state.me=r.user;await postLogin();}
    if(type==='register'){if(data.password!==data.confirm)throw new Error('Passwords do not match.');const r=await api('/api/auth/register',{method:'POST',body:JSON.stringify({name:data.name,password:data.password,question:data.question,answer:data.answer})});state.me=r.user;await postLogin();}
    if(type==='forgot-name'){const r=await api('/api/auth/recovery-question?name='+encodeURIComponent(data.name));state.forgotName=data.name;state.forgotQuestion=r.question;state.forgotStep=2;authView();}
    if(type==='forgot-reset'){await api('/api/auth/reset-password',{method:'POST',body:JSON.stringify({name:state.forgotName,answer:data.answer,newPassword:data.newPassword})});showToast('Password reset complete.','success');state.authMode='login';state.forgotStep=1;authView();}
  }catch(e){if(err)err.textContent=e.message;else showToast(e.message,'error');}
}

async function postLogin(){
  saveTheme(state.me.theme||'dark'); state.tab='chats'; state.authMode='login'; await Promise.all([loadUsers(),loadConversations(),loadStories(),loadCalls()]); connectSocket(); renderShell(); requestNotifications(); showToast(`Welcome, ${state.me.displayName}.`,'success');
}

async function loadUsers(){const r=await api('/api/users');state.users=r.users;}
async function loadConversations(){const r=await api('/api/conversations');state.conversations=r.conversations;}
async function loadStories(){try{const r=await api('/api/stories');state.stories=r.stories;}catch(e){state.stories=[];}}
async function loadCalls(){try{const r=await api('/api/calls');state.calls=r.calls;}catch{state.calls=[];}}

function connectSocket(){
  if(state.socket) state.socket.disconnect();
  state.socket=io({ transports:['websocket','polling'], withCredentials:true });
  state.socket.on('connect',()=>showToast('Live connection established.','success'));
  state.socket.on('connect_error',()=>showToast('Realtime connection unavailable. Retrying…','error'));
  state.socket.on('presence:update',u=>{const i=state.users.findIndex(x=>x.id===u.id);if(i>=0)state.users[i]={...state.users[i],...u};if(state.activeConversation)renderShell();else renderShell();});
  state.socket.on('profile:update',u=>{const i=state.users.findIndex(x=>x.id===u.id);if(i>=0)state.users[i]={...state.users[i],...u};if(state.me.id===u.id)state.me={...state.me,...u};renderShell();});
  state.socket.on('conversation:new',async()=>{await loadConversations();if(state.tab==='chats')renderShell();});
  state.socket.on('conversation:removed',async()=>{await loadConversations();if(state.activeConversation)state.activeConversation=state.conversations.find(c=>c.id===state.activeConversation.id)||null;renderShell();});
  state.socket.on('conversation:update',async()=>{await loadConversations();if(state.activeConversation)state.activeConversation=state.conversations.find(c=>c.id===state.activeConversation.id)||state.activeConversation;renderShell();});
  state.socket.on('user:deleted',async()=>{await loadUsers();await loadConversations();renderShell();});
  state.socket.on('message:new',async m=>{if(state.activeConversation?.id===m.conversationId){if(!state.messages.some(x=>x.id===m.id)){state.messages.push(normalizeMessage(m));renderShell();await markDelivered(m);} }else{const sender=userById(m.senderId);showToast(`${sender?.displayName||'New message'} sent a message.`);notify(sender?.displayName||'New message',m.text||'Attachment');await loadConversations();renderShell();}});
  state.socket.on('message:update',m=>{const i=state.messages.findIndex(x=>x.id===m.id);if(i>=0){state.messages[i]={...state.messages[i],...m};renderShell();}});
  state.socket.on('message:delivered',m=>{const x=state.messages.find(x=>x.id===m.messageId);if(x){x.deliveredBy=[...(x.deliveredBy||[]),m.userId];renderShell();}});
  state.socket.on('message:seen',m=>{const x=state.messages.find(x=>x.id===m.messageId);if(x){x.seenBy=[...(x.seenBy||[]),m.userId];renderShell();}});
  state.socket.on('typing:update',d=>{state.typingUser=d.active?d:null;renderShell();});
  state.socket.on('story:new',async()=>{await loadStories();if(state.tab==='stories')renderShell();});
  state.socket.on('announcement:update',d=>{if(d.value)showToast(d.value);});
  state.socket.on('admin:user:update',async()=>{if(state.me.role==='admin'){await loadUsers();if(state.tab==='admin')loadAdminBody();}});
  state.socket.on('call:ring',d=>{state.pendingCall=d;showCallDialog(d);notify('Incoming call',`${d.kind==='video'?'Video':'Voice'} call`);});
  state.socket.on('call:offer',async d=>{if(!state.pendingCall && !state.currentCall) return; if(!state.currentCall)state.currentCall={callId:d.callId,from:d.from,kind:state.pendingCall?.kind||'audio'};state.pendingOffer=d.description;if(state.callAccepted && state.callPc && !state.callPc.currentRemoteDescription){await state.callPc.setRemoteDescription(new RTCSessionDescription(d.description));const answer=await state.callPc.createAnswer();await state.callPc.setLocalDescription(answer);state.socket?.emit('call:answer',{to:d.from,callId:d.callId,description:answer});}});
  state.socket.on('call:answer',async d=>{if(!state.callPc)return;await state.callPc.setRemoteDescription(new RTCSessionDescription(d.description));});
  state.socket.on('call:ice',async d=>{try{if(state.callPc&&d.candidate)await state.callPc.addIceCandidate(d.candidate);}catch{}});
  state.socket.on('call:end',()=>endCall(false));
}

const normalizeMessage=m=>({...m,deliveredBy:m.deliveredBy||[],seenBy:m.seenBy||[]});
async function openChat(id){
  const c=state.conversations.find(x=>x.id===id);if(!c)return; state.tab='chats';state.activeConversation=c;state.replyTo=null;
  try{const r=await api(`/api/conversations/${id}/messages`);state.messages=r.messages.map(normalizeMessage);state.socket?.emit('conversation:join',id);renderShell();await markLatestSeen();}catch(e){showToast(e.message,'error');}
}
async function startChat(userId){try{const r=await api('/api/conversations/direct',{method:'POST',body:JSON.stringify({userId})});await loadConversations();await openChat(r.conversation.id);}catch(e){showToast(e.message,'error');}}
async function markDelivered(m){try{await api(`/api/conversations/${m.conversationId}/delivered`,{method:'POST',body:JSON.stringify({messageId:m.id})});}catch{}}
async function markLatestSeen(){const last=state.messages[state.messages.length-1];if(last&&last.senderId!==state.me.id)await api(`/api/conversations/${last.conversationId}/read`,{method:'POST',body:JSON.stringify({messageId:last.id})}).catch(()=>{});}
function sendTyping(active){if(!state.socket||!state.activeConversation)return; state.socket.emit(active?'typing:start':'typing:stop',state.activeConversation.id);}

async function sendMessage(extra={}){
  if(!state.activeConversation)return; const el=document.getElementById('composer-input'); const text=el?.value.trim()||''; if(!text&&!extra.attachment&&!extra.type)return;
  try{await api(`/api/conversations/${state.activeConversation.id}/messages`,{method:'POST',body:JSON.stringify({text,type:extra.type||'text',attachment:extra.attachment||null,replyTo:state.replyTo?.id||null})});if(el){el.value='';autoGrow(el);}state.replyTo=null;sendTyping(false);await loadConversations();}catch(e){showToast(e.message,'error');}
}

async function handleFile(e){const file=e.target.files?.[0];e.target.value='';if(!file||!state.activeConversation)return;if(file.size>8*1024*1024){showToast('File is larger than 8 MB.','error');return;}const dataUrl=await fileToDataUrl(file);try{const r=await api('/api/uploads',{method:'POST',body:JSON.stringify({dataUrl,filename:file.name,kind:'attachment'})});await sendMessage({type:file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':'file',attachment:r});}catch(e2){showToast(e2.message,'error');}}
const fileToDataUrl=file=>new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(file);});

async function handleAction(action, data={}){
  try{
    if(action==='auth-login'){state.authMode='login';authView();}
    else if(action==='auth-register'){state.authMode='register';authView();}
    else if(action==='auth-forgot'){state.authMode='forgot';state.forgotStep=1;authView();}
    else if(action==='logout'){await api('/api/auth/logout',{method:'POST'});state.socket?.disconnect();state.me=null;state.activeConversation=null;authView();}
    else if(action==='home'){state.tab='chats';state.activeConversation=null;renderShell();}
    else if(action==='open-chat'){await openChat(data.id);}
    else if(action==='close-mobile-chat'){state.activeConversation=null;renderShell();}
    else if(action==='start-chat'){await startChat(data.id);}
    else if(action==='show-people'){state.tab='people';renderShell();}
    else if(action==='show-stories'){state.tab='stories';await loadStories();renderShell();}
    else if(action==='new-chat'){state.tab='people';state.search='';renderShell();}
    else if(action==='new-group'){openGroupModal();}
    else if(action==='new-story'){openStoryModal();}
    else if(action==='attach'){document.getElementById('file-input')?.click();}
    else if(action==='send-message'){await sendMessage();}
    else if(action==='cancel-reply'){state.replyTo=null;renderShell();}
    else if(action==='reply-message'){const id=data.id||data.closest;const row=document.querySelector(`[data-message-id="${id}"]`); if(row){const m=state.messages.find(x=>x.id===id);state.replyTo=m;renderShell();document.getElementById('composer-input')?.focus();}}
    else if(action==='message-more'){const id=data.id;openMessageMenu(id);}
    else if(action==='voice-record'){toggleVoiceRecord();}
    else if(action==='stickers'){openStickerModal();}
    else if(action==='chat-info'){openChatInfo();}
    else if(action==='profile-settings'){openProfileModal();}
    else if(action==='security-settings'){openSecurityModal();}
    else if(action==='appearance-settings'){openAppearanceModal();}
    else if(action==='notification-settings'){openNotificationModal();}
    else if(action==='privacy-settings'){openPrivacyModal();}
    else if(action==='about-settings'){openAboutModal();}
    else if(action==='delete-account'){if(confirm('Delete this account permanently? This frees one of the 10 account slots.')){await api('/api/me',{method:'DELETE'});state.socket?.disconnect();state.me=null;authView();showToast('Account deleted.','success');}}
    else if(action==='person-details'){const u=userById(data.id);openInfoModal(u);}
    else if(action==='view-story'){openStoryViewer(data.id);}
    else if(action==='admin-refresh'){adminMode='overview';renderShell();}
    else if(action==='admin-users'){adminMode='users';renderShell();}
    else if(action==='admin-reports'){adminMode='reports';renderShell();}
    else if(action==='start-audio'){await startCall('audio');}
    else if(action==='start-video'){await startCall('video');}
    else if(action==='call-again'){const u=userById(data.id);if(u){await startChat(u.id);await startCall(data.kind==='video'?'video':'audio');}}
  }catch(e){showToast(e.message,'error');}
}

function openMessageMenu(id){
  const m=state.messages.find(x=>x.id===id);if(!m)return;
  modal(`Message actions`,`<div class="action-grid">${m.senderId===state.me.id?`<button data-modal-action="edit-msg">${icon('info',18)} Edit</button>`:''}<button data-modal-action="reply-msg">${icon('back',18)} Reply</button><button data-modal-action="react-heart">${icon('heart',18)} React</button><button data-modal-action="react-like">${icon('thumb',18)} Like</button><button data-modal-action="pin-msg">${icon('pin',18)} ${m.pinned?'Unpin':'Pin'}</button><button data-modal-action="save-msg">${icon('bookmark',18)} ${m.savedBy?.includes(state.me.id)?'Unsave':'Save'}</button><button data-modal-action="forward-msg">${icon('send',18)} Forward</button><button data-modal-action="delete-msg">${icon('trash',18)} Delete</button></div>`,async(a)=>{if(a==='edit-msg'){closeModal();openEditMessage(m)}if(a==='reply-msg'){state.replyTo=m;closeModal();renderShell();document.getElementById('composer-input')?.focus();}if(a==='react-heart'){await messageAction(m,'react',{reaction:'heart'});closeModal()}if(a==='react-like'){await messageAction(m,'react',{reaction:'like'});closeModal()}if(a==='pin-msg'){await messageAction(m,'pin');closeModal()}if(a==='save-msg'){await messageAction(m,m.savedBy?.includes(state.me.id)?'unsave':'save');closeModal()}if(a==='forward-msg'){closeModal();openForwardModal(m)}if(a==='delete-msg'){await messageAction(m,'delete');closeModal()}});
}
function openEditMessage(m){modal('Edit message',`<div class="field"><textarea id="edit-text">${escapeHtml(m.text||'')}</textarea></div><button class="primary" data-modal-action="save-edit">Save changes</button>`,async a=>{if(a==='save-edit'){const t=document.getElementById('edit-text').value.trim();await messageAction(m,'edit',{text:t});closeModal();}});}
async function messageAction(m,action,extra={}){await api(`/api/messages/${m.id}/action`,{method:'POST',body:JSON.stringify({action,...extra})});}

function openForwardModal(m){state.forwardMessage=m;const opts=state.conversations.filter(c=>c.id!==m.conversationId).map(c=>`<button class="forward-row" data-modal-action="forward" data-id="${c.id}">${avatar(c,'sm')}<span>${escapeHtml(convName(c))}</span>${icon('send',16)}</button>`).join('')||'<div class="empty-list">No other conversations.</div>';modal('Forward message',opts,async(a,e)=>{if(a==='forward'){const target=e.currentTarget.dataset.id;await api(`/api/messages/${m.id}/forward`,{method:'POST',body:JSON.stringify({conversationId:target})});closeModal();showToast('Message forwarded.','success');await loadConversations();}});}

function openGroupModal(){const others=state.users.filter(u=>u.id!==state.me.id);modal('Create circle',`<div class="field"><label>Circle name</label><input id="group-name" maxlength="60"></div><div class="pick-list">${others.map(u=>`<label class="pick"><input type="checkbox" value="${u.id}"><span>${avatar(u,'sm')}</span><span>${escapeHtml(u.displayName)}</span></label>`).join('')}</div><button class="primary" data-modal-action="create-group">Create circle</button>`,async a=>{if(a==='create-group'){const ids=[...document.querySelectorAll('.pick input:checked')].map(x=>x.value);const name=document.getElementById('group-name').value.trim();const r=await api('/api/groups',{method:'POST',body:JSON.stringify({name,memberIds:ids})});closeModal();await loadConversations();await openChat(r.conversation.id);}});}

function openStoryModal(){modal('New story',`<div class="field"><label>Text</label><textarea id="story-text" maxlength="500" placeholder="Share a moment…"></textarea></div><div class="field"><label>Optional media</label><input id="story-file" type="file" accept="image/*,video/*"></div><button class="primary" data-modal-action="publish-story">Publish story</button>`,async a=>{if(a==='publish-story'){const text=document.getElementById('story-text').value.trim();const file=document.getElementById('story-file').files?.[0];let dataUrl='';if(file){if(file.size>4*1024*1024)throw new Error('Story media must be under 4 MB.');dataUrl=await fileToDataUrl(file);}await api('/api/stories',{method:'POST',body:JSON.stringify({text,dataUrl})});closeModal();await loadStories();renderShell();}});}

function openStoryViewer(id){const s=state.stories.find(x=>x.id===id);if(!s)return;api(`/api/stories/${id}/view`,{method:'POST'}).catch(()=>{});modal('',`<div class="story-view">${s.mediaUrl?((s.mediaType||'').startsWith('video/')?`<video src="${s.mediaUrl}" controls autoplay></video>`:`<img src="${s.mediaUrl}" alt="">`):''}<div class="story-copy">${avatar(s.user,'sm')}<div><b>${escapeHtml(s.user?.displayName||'')}</b><small>${fmtDate(s.createdAt)}</small></div></div>${s.text?`<p>${escapeHtml(s.text)}</p>`:''}</div>`);}

function openProfileModal(){modal('Profile',`<div class="profile-hero"><label class="avatar-upload">${avatar(state.me,'lg')}<input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><div><h3>${escapeHtml(state.me.displayName)}</h3><p>${escapeHtml(state.me.bio||'')}</p></div></div><div class="field"><label>Display name</label><input id="profile-name" value="${escapeHtml(state.me.displayName)}" maxlength="40"></div><div class="field"><label>Bio</label><textarea id="profile-bio" maxlength="180">${escapeHtml(state.me.bio||'')}</textarea></div><div class="field"><label>Status text</label><input id="profile-status" value="${escapeHtml(state.me.statusText||'')}" maxlength="80"></div><button class="primary" data-modal-action="save-profile">Save profile</button>`,async a=>{if(a==='save-profile'){const file=document.getElementById('avatar-file').files?.[0];if(file){if(file.size>2*1024*1024)throw new Error('Avatar must be under 2 MB.');await api('/api/me/avatar',{method:'POST',body:JSON.stringify({dataUrl:await fileToDataUrl(file)})});}const r=await api('/api/me/profile',{method:'PUT',body:JSON.stringify({displayName:document.getElementById('profile-name').value,bio:document.getElementById('profile-bio').value,statusText:document.getElementById('profile-status').value,theme:state.theme})});state.me=r.user;await loadUsers();closeModal();renderShell();}});}

function openSecurityModal(){modal('Security',`<div class="section"><h3>Change password</h3><div class="field"><label>Current password</label><input id="cur-pass" type="password"></div><div class="field"><label>New password</label><input id="new-pass" type="password" minlength="8"></div><button class="primary" data-modal-action="change-pass">Update password</button></div><div class="section"><h3>Recovery question</h3><div class="field"><label>Question</label><input id="rec-q" value="${escapeHtml(state.me.recoveryQuestion||'')}" maxlength="120"></div><div class="field"><label>Answer</label><input id="rec-a"></div><button class="secondary" data-modal-action="change-recovery">Update recovery</button></div>`,async a=>{if(a==='change-pass'){await api('/api/me/password',{method:'PUT',body:JSON.stringify({currentPassword:document.getElementById('cur-pass').value,newPassword:document.getElementById('new-pass').value})});showToast('Password updated.','success');}if(a==='change-recovery'){await api('/api/me/recovery',{method:'PUT',body:JSON.stringify({currentPassword:document.getElementById('cur-pass').value,question:document.getElementById('rec-q').value,answer:document.getElementById('rec-a').value})});showToast('Recovery updated.','success');}});}
function openAppearanceModal(){modal('Appearance',`<div class="theme-grid"><button data-modal-action="theme-dark">${icon('moon',20)}<b>Dark</b><span>Deep, cinematic workspace</span></button><button data-modal-action="theme-light">${icon('sun',20)}<b>Light</b><span>Clean and bright</span></button><button data-modal-action="theme-system">${icon('monitor',20)}<b>System</b><span>Follow your device</span></button></div>`,async a=>{const map={'theme-dark':'dark','theme-light':'light','theme-system':'system'};if(map[a]){saveTheme(map[a]);await api('/api/me/profile',{method:'PUT',body:JSON.stringify({theme:map[a],displayName:state.me.displayName,bio:state.me.bio,statusText:state.me.statusText})});showToast('Theme updated.','success');closeModal();renderShell();}});}
async function openPrivacyModal(){const r=await api('/api/blocks');const rows=r.users||[];modal('Privacy',`<div class="section"><h3>Blocked accounts</h3>${rows.map(u=>`<div class="person-row">${avatar(u,'sm')}<span class="person-copy"><b>${escapeHtml(u.displayName)}</b><span>Messaging blocked</span></span><button class="tiny-btn" data-modal-action="unblock" data-id="${u.id}">${icon('check',15)}</button></div>`).join('')||'<div class="empty-list">No blocked accounts.</div>'}</div>`,async(a,e)=>{if(a==='unblock'){await api('/api/blocks/'+e.currentTarget.dataset.id,{method:'DELETE'});await openPrivacyModal();}});}

function openNotificationModal(){modal('Notifications',`<div class="section"><h3>Browser notifications</h3><p class="small-note">Allow Mavryn to notify this browser when a new message arrives while the tab is not focused.</p><button class="primary" data-modal-action="grant-notify">Allow notifications</button></div><div class="section"><h3>Quiet mode</h3><p class="small-note">Browser-level notification preferences remain under your operating system controls.</p></div>`,async a=>{if(a==='grant-notify'){await requestNotifications();showToast('Notification permission updated.','success');}});}
function openAboutModal(){modal(`About ${APP}`,`<div class="about-brand"><img src="/assets/brand.svg" alt="${APP}"><div><h3>${APP}</h3><p>Private 10-account realtime messaging platform.</p></div></div><div class="section"><h3>Capacity</h3><p class="small-note">1 administrator + up to 9 regular members.</p></div><div class="section"><h3>Install</h3><button class="secondary compact" data-modal-action="install-pwa">${icon('monitor',16)} Install this app</button></div><div class="section"><h3>Deployment</h3><p class="small-note">Designed for a free Render + MongoDB Atlas + monitoring setup.</p></div>`,async a=>{if(a==='install-pwa'){if(state.installPrompt){await state.installPrompt.prompt();state.installPrompt=null;}else showToast('Use your browser menu to install the app.');}});}
function openInfoModal(u){modal('Member details',`${avatar(u,'lg')}<h3>${escapeHtml(u.displayName)}</h3><p>${escapeHtml(u.bio||'No bio')}</p><p class="small-note">${u.online?'Online':u.lastSeen?'Last seen '+fmtDate(u.lastSeen):'Offline'}</p><div class="section"><button class="danger-btn" data-modal-action="block">${icon('shield',16)} Block this account</button></div>`,async a=>{if(a==='block'){await api('/api/blocks/'+u.id,{method:'POST'});closeModal();showToast('Account blocked.','success');}});}
function openChatInfo(){const c=state.activeConversation;const groupTools=c.type==='group'&&c.admins?.includes(state.me.id)?`<div class="section"><h3>Circle controls</h3><button class="secondary compact" data-modal-action="group-avatar">${icon('image',16)} Change circle photo</button><button class="secondary compact" data-modal-action="group-invite">${icon('send',16)} Create invite</button><input id="group-photo" type="file" accept="image/*" class="hidden"></div>`:'';modal('Conversation details',`<div class="section"><h3>${escapeHtml(convName(c))}</h3><p class="small-note">${c.type==='group'?`${c.participants.length} members`:'Direct conversation'} · Updated ${fmtDate(c.updatedAt||Date.now())}</p></div>${groupTools}<div class="pick-list">${c.participants.map(id=>{const u=userById(id);return `<div class="person-row">${avatar(u,'sm')}<span class="person-copy"><b>${escapeHtml(u?.displayName||'Member')}</b><span>${u?.online?'Online':'Offline'}</span></span></div>`}).join('')}</div>`,async(a)=>{if(a==='group-avatar'){document.getElementById('group-photo').click();document.getElementById('group-photo').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024)throw new Error('Circle image must be under 2 MB.');const r=await api(`/api/groups/${c.id}/avatar`,{method:'POST',body:JSON.stringify({dataUrl:await fileToDataUrl(f)})});state.activeConversation=r.conversation;await loadConversations();closeModal();renderShell();};}if(a==='group-invite'){const r=await api(`/api/groups/${c.id}/invite`);try{if(navigator.clipboard) await navigator.clipboard.writeText(r.inviteCode);}catch{} showToast(`Invite code: ${r.inviteCode}`,'success');}});}
function openStickerModal(){
  const stickers=[['Focus','M','STAY SHARP'],['Thanks','A','THANK YOU'],['Nice','Q','NICE ONE'],['Wow','◆','IMPRESSIVE'],['Cheers','+','CHEERS'],['Okay','✓','ALL GOOD'],['Miss you','∞','THINKING OF YOU'],['Ready','→','LET’S GO']];
  modal('Stickers',`<div class="sticker-grid">${stickers.map((s,i)=>`<button data-modal-action="sticker" data-text="${escapeHtml(s[2])}"><div class="sticker-art" data-tone="${i%4}">${escapeHtml(s[1])}</div><span>${escapeHtml(s[0])}</span></button>`).join('')}</div>`,async (a,e)=>{if(a==='sticker'){const t=e?.currentTarget?.dataset?.text; if(t){closeModal();await sendMessage({type:'sticker',text:t});}}});
}

async function toggleVoiceRecord(){
  if(state.recording){state.recording.stop();return;}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return showToast('Voice recording is not supported here.','error');
  const stream=await navigator.mediaDevices.getUserMedia({audio:true}); const rec=new MediaRecorder(stream);const chunks=[];state.recording=rec;showToast('Recording voice message…');
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};rec.onstop=async()=>{state.recording=null;stream.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});if(blob.size>8*1024*1024)return showToast('Voice message is too large.','error');const data=await fileToDataUrl(new File([blob],'voice.webm',{type:blob.type}));try{const r=await api('/api/uploads',{method:'POST',body:JSON.stringify({dataUrl:data,filename:'voice.webm',kind:'voice'})});await sendMessage({type:'audio',attachment:r});}catch(e){showToast(e.message,'error');}};rec.start();setTimeout(()=>{if(state.recording===rec)rec.stop();},90000);
}

async function requestNotifications(){if('Notification' in window&&Notification.permission==='default'){try{await Notification.requestPermission();}catch{}}}
function notify(title,body){if('Notification' in window&&Notification.permission==='granted'&&document.visibilityState!=='visible'){try{new Notification(title,{body,icon:'/assets/favicon.svg'});}catch{}}}

function modal(title,content,onAction=async()=>{}){
  const wrap=document.getElementById('modal-root');if(!wrap)return;wrap.innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="tiny-btn" data-modal-close>${icon('x',18)}</button></div><div class="modal-body">${content}</div></div></div>`;wrap.querySelector('[data-modal-close]').addEventListener('click',closeModal);wrap.querySelector('.modal-backdrop').addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))closeModal();});wrap.querySelectorAll('[data-modal-action]').forEach(btn=>btn.addEventListener('click',async e=>{try{await onAction(btn.dataset.modalAction,e);}catch(err){showToast(err.message,'error');}}));}
function closeModal(){const r=document.getElementById('modal-root');if(r)r.innerHTML='';}

async function loadAdminBody(){
  const body=document.getElementById('admin-body');if(!body||state.me?.role!=='admin')return;
  if(adminMode==='users'){const r=await api('/api/admin/users');body.innerHTML=r.users.map(u=>`<div class="admin-user-row">${avatar(u,'sm')}<div><b>${escapeHtml(u.displayName)}</b><span>${u.role==='admin'?'Administrator':u.status}</span></div><div class="admin-actions">${u.role!=='admin'?`<button class="tiny-btn" data-admin-action="${u.status==='suspended'?'unsuspend':'suspend'}" data-id="${u.id}" title="${u.status==='suspended'?'Unsuspend':'Suspend'}">${icon(u.status==='suspended'?'check':'shield',15)}</button><button class="tiny-btn" data-admin-action="delete" data-id="${u.id}" title="Delete">${icon('trash',15)}</button>`:''}</div></div>`).join('')||'<div class="empty-list">No accounts.</div>';}
  else if(adminMode==='reports'){const r=await api('/api/admin/reports');body.innerHTML=r.reports.map(x=>`<div class="admin-card"><div class="report-head"><b>${escapeHtml(x.reason)}</b><span>${escapeHtml(x.status)}</span></div><p class="small-note">Reporter: ${escapeHtml(userById(x.reporterId)?.displayName||'Unknown')}</p><div class="report-actions"><button class="secondary compact" data-report-action="reviewing" data-id="${x.id}">Review</button><button class="secondary compact" data-report-action="resolved" data-id="${x.id}">Resolve</button><button class="secondary compact" data-report-action="dismissed" data-id="${x.id}">Dismiss</button></div></div>`).join('')||'<div class="empty-list">No reports.</div>';}
  else {const r=await api('/api/admin/stats');const a=await api('/api/admin/announcement');body.innerHTML=`<div class="stats"><div class="stat"><b>${r.users}/10</b><span>Accounts</span></div><div class="stat"><b>${r.remaining}</b><span>Open slots</span></div><div class="stat"><b>${r.messages}</b><span>Messages</span></div><div class="stat"><b>${r.openReports}</b><span>Open reports</span></div></div><div class="admin-card"><h3>Announcement</h3><textarea id="admin-announcement" maxlength="400" placeholder="Optional announcement…">${escapeHtml(a.announcement||'')}</textarea><button class="primary" data-admin-action="announcement">Publish announcement</button></div><div class="admin-card"><h3>Admin account</h3><p class="small-note">Name: A · The admin account can use all member features plus this panel.</p></div>`;}
  body.querySelectorAll('[data-admin-action]').forEach(b=>b.addEventListener('click',async()=>{const a=b.dataset.adminAction,id=b.dataset.id;try{if(a==='announcement'){await api('/api/admin/announcement',{method:'PUT',body:JSON.stringify({value:document.getElementById('admin-announcement').value})});showToast('Announcement published.','success');}else{if(a==='delete'&&!confirm('Delete this account?'))return;await api('/api/admin/users/'+id,{method:'PATCH',body:JSON.stringify({action:a})});await loadUsers();loadAdminBody();}}catch(e){showToast(e.message,'error');}}));
  body.querySelectorAll('[data-report-action]').forEach(b=>b.addEventListener('click',async()=>{await api('/api/admin/reports/'+b.dataset.id,{method:'PATCH',body:JSON.stringify({status:b.dataset.reportAction})});loadAdminBody();}));
}

function showCallDialog(d){modal('Incoming call',`${avatar(userById(d.from),'lg')}<h3>${escapeHtml(userById(d.from)?.displayName||'Member')} is calling</h3><p class="small-note">${d.kind==='video'?'Video call':'Voice call'}</p><div class="call-dialog-actions"><button class="primary" data-modal-action="accept-call">Accept</button><button class="secondary" data-modal-action="decline-call">Decline</button></div>`,async a=>{if(a==='accept-call'){closeModal();await acceptCall(d)}else if(a==='decline-call'){state.socket?.emit('call:end',{to:d.from,callId:d.callId});closeModal();}});}
async function createPeer(kind,peerId,callId,isCaller){
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});state.callPc=pc;
  const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:kind==='video'});state.callLocal=stream;stream.getTracks().forEach(t=>pc.addTrack(t,stream));
  let remote=document.getElementById('call-remote');if(!remote){openCallOverlay(kind);remote=document.getElementById('call-remote');}remote.srcObject=new MediaStream();const localVideo=document.getElementById('call-local');if(localVideo)localVideo.srcObject=stream;pc.ontrack=e=>{e.streams[0].getTracks().forEach(t=>remote.srcObject.addTrack(t));};
  pc.onicecandidate=e=>{if(e.candidate)state.socket?.emit('call:ice',{to:peerId,callId,candidate:e.candidate});};
  if(isCaller){const offer=await pc.createOffer();await pc.setLocalDescription(offer);state.socket?.emit('call:offer',{to:peerId,callId,description:offer});}
  return pc;
}
async function startCall(kind){const c=state.activeConversation;const other=activeOther(c);if(!other)return showToast('Calls are currently available for direct chats.','error');if(!navigator.mediaDevices?.getUserMedia)return showToast('Camera/microphone access is unavailable.','error');const callId=crypto.randomUUID();state.currentCall={callId,to:other.id,kind};openCallOverlay(kind);state.socket?.emit('call:ring',{to:other.id,conversationId:c.id,kind,callId});await createPeer(kind,other.id,callId,true);await api('/api/calls',{method:'POST',body:JSON.stringify({callId,userId:other.id,kind,status:'outgoing'})}).catch(()=>{});}
async function acceptCall(d){state.pendingCall=null;state.callAccepted=true;state.currentCall={callId:d.callId,from:d.from,kind:d.kind};await createPeer(d.kind,d.from,d.callId,false);if(state.pendingOffer){const offer=state.pendingOffer;state.pendingOffer=null;await state.callPc.setRemoteDescription(new RTCSessionDescription(offer));const answer=await state.callPc.createAnswer();await state.callPc.setLocalDescription(answer);state.socket?.emit('call:answer',{to:d.from,callId:d.callId,description:answer});}}
function openCallOverlay(kind){let el=document.getElementById('call-overlay');if(el)el.remove();document.body.insertAdjacentHTML('beforeend',`<div id="call-overlay" class="call-overlay"><div class="call-window"><div class="call-head"><div><div class="eyebrow">${kind==='video'?'VIDEO':'VOICE'} CALL</div><b>Mavryn live</b></div><button class="tiny-btn" data-call-action="end">${icon('x',18)}</button></div><video id="call-remote" autoplay playsinline class="call-remote"></video><video id="call-local" autoplay muted playsinline class="call-local"></video><div class="call-controls"><button class="tiny-btn" data-call-action="mute">${icon('mic',17)}</button>${kind==='video'?`<button class="tiny-btn" data-call-action="camera">${icon('video',17)}</button><button class="tiny-btn" data-call-action="share">${icon('monitor',17)}</button>`:''}<button class="danger-circle" data-call-action="end">${icon('phone',18)}</button></div></div></div>`);bindCallActions();}
function bindCallActions(){document.querySelectorAll('[data-call-action]').forEach(b=>b.addEventListener('click',async()=>{const a=b.dataset.callAction;if(a==='end')await endCall(true);if(a==='mute'&&state.callLocal){state.callMuted=!state.callMuted;state.callLocal.getAudioTracks().forEach(t=>t.enabled=!state.callMuted);}if(a==='camera'&&state.callLocal){state.cameraOff=!state.cameraOff;state.callLocal.getVideoTracks().forEach(t=>t.enabled=!state.cameraOff);}if(a==='share')await shareScreen();}));}
async function shareScreen(){try{if(!state.callPc)return;const screen=await navigator.mediaDevices.getDisplayMedia({video:true});const sender=state.callPc.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(screen.getVideoTracks()[0]);screen.getVideoTracks()[0].onended=async()=>{const cam=state.callLocal?.getVideoTracks()[0];if(sender&&cam)await sender.replaceTrack(cam);};}catch(e){showToast(e.message,'error');}}
async function endCall(local=true){if(state.currentCall&&local){const to=state.currentCall.to||state.currentCall.from;if(to)state.socket?.emit('call:end',{to,callId:state.currentCall.callId});await api('/api/calls/'+encodeURIComponent(state.currentCall.callId),{method:'PATCH',body:JSON.stringify({status:'ended'})}).catch(()=>{});}if(state.callPc){state.callPc.close();state.callPc=null;}state.callLocal?.getTracks().forEach(t=>t.stop());state.callLocal=null;state.currentCall=null;state.pendingCall=null;state.callAccepted=false;state.pendingOffer=null;document.getElementById('call-overlay')?.remove();}

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;});
window.addEventListener('online',()=>showToast('Connection restored.','success'));window.addEventListener('offline',()=>showToast('You are offline.','error'));

async function boot(){
  try{const r=await api('/api/me');state.me=r.user;await postLogin();}
  catch{authView();}
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
boot();

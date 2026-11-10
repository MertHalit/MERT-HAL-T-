// PvP Server - oyun istemcisi (PC + telefon)
const $ = (s) => document.querySelector(s);
const cv = $('#game');
const ctx = cv.getContext('2d');
const mini = $('#mini').getContext('2d');

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const FACTION_UI = {
  kizil: { name: 'Kızıl Ejder Krallığı', short: 'Kızıl Ejder', color: '#e04a3a' },
  gok: { name: 'Gök Kaplan Krallığı', short: 'Gök Kaplan', color: '#3a8de0' },
  yesim: { name: 'Yeşim Turna Krallığı', short: 'Yeşim Turna', color: '#3ac06a' },
};
const CLASS_UI = {
  savasci: { name: 'Savaşçı', color: '#d9534f' },
  golge: { name: 'Gölge Avcı', color: '#9b59b6' },
  buyucu: { name: 'Ruh Kılıcı', color: '#3498db' },
  saman: { name: 'Şaman', color: '#1abc9c' },
};

let MOBT = {};
let skillLv = { q: 1, e: 1, r: 1, f: 1 };
let sparks = [];
let ws = null, myId = null, myFaction = null, MAP = null, CLASSES = null, FACTIONS = FACTION_UI, state = null;
let account = null, selectedChar = null;
const view = new Map(); // yumuşak hareket için çizim konumları
let floaters = [], swings = [], booms = [], rings = [], board = [];
const SKILL_KEYS = ['q', 'e', 'r', 'f'];
const FX_NAMES = { atk: 'Öfke Aurası', sh: 'Demir Kalkan', iv: 'Görünmez', ls: 'Ruh Kılıcı', crit: 'Turna Kutsaması', spd: 'Rüzgâr Adımı' };
const FX_COLORS = { atk: '#ff5a3a', sh: '#7ab8ff', iv: '#b07ad8', ls: '#c44aff', crit: '#ffd04a', spd: '#7affd0' };
let deadUntil = 0, deathBy = '';
let W = 0, H = 0, DPR = 1;

// ---------------- EKRANLAR ----------------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  const inGame = id === 'game';
  $('#hud').classList.toggle('hidden', !inGame);
  $('#touch').classList.toggle('hidden', !(inGame && isTouch));
  if (!inGame) $('#death').classList.add('hidden');
}

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function serverUrl() {
  if (window.KV_SERVER) return window.KV_SERVER;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function connect() {
  $('#aMsg').textContent = 'Sunucuya bağlanılıyor... (ilk açılış 1 dakika sürebilir)';
  ws = new WebSocket(serverUrl());
  ws.onopen = () => {
    $('#aMsg').textContent = '';
    const token = store.get('pvp_token');
    if (token) send({ t: 'token', token });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    const wasPlaying = !!myId;
    myId = null; state = null;
    show('scrAuth');
    $('#aMsg').textContent = wasPlaying ? 'Sunucu bağlantısı koptu. Yeniden bağlanılıyor...' : 'Sunucuya bağlanılamadı. Yeniden deneniyor...';
    setTimeout(connect, 3000);
  };
}

// --- giriş / kayıt ---
let regMode = false;
function setMode(reg) {
  regMode = reg;
  $('#tabLogin').classList.toggle('on', !reg);
  $('#tabReg').classList.toggle('on', reg);
  $('#aPass2').classList.toggle('hidden', !reg);
  $('#aGo').textContent = reg ? 'KAYIT OL' : 'GİRİŞ YAP';
  $('#aPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#aMsg').textContent = '';
}
$('#tabLogin').onclick = () => setMode(false);
$('#tabReg').onclick = () => setMode(true);
$('#aUser').value = store.get('pvp_user') || '';
function doAuth() {
  const user = $('#aUser').value.trim(), pass = $('#aPass').value;
  if (!user || !pass) return ($('#aMsg').textContent = 'Kullanıcı adı ve şifreyi yaz.');
  if (regMode && pass !== $('#aPass2').value) return ($('#aMsg').textContent = 'Şifreler aynı değil.');
  store.set('pvp_user', user);
  $('#aMsg').textContent = 'Bekle...';
  send({ t: regMode ? 'register' : 'login', user, pass });
}
$('#aGo').onclick = doAuth;
for (const id of ['#aUser', '#aPass', '#aPass2']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

// --- karakter seç ---
function renderSelect() {
  $('#sAcc').textContent = `Hesap: ${account.user}` + (account.faction ? ` · ${FACTION_UI[account.faction].name}` : '');
  const box = $('#slots');
  box.innerHTML = '';
  if (selectedChar && !account.chars.some((c) => c.id === selectedChar)) selectedChar = null;
  if (!selectedChar && account.chars[0]) selectedChar = account.chars[0].id;
  for (const c of account.chars) {
    const el = document.createElement('div');
    el.className = 'card slot' + (c.id === selectedChar ? ' sel' : '');
    const av = document.createElement('div');
    av.className = 'av';
    av.style.background = CLASS_UI[c.cls].color;
    av.style.borderColor = FACTION_UI[c.f].color;
    const name = document.createElement('b'); name.textContent = c.name;
    const info = document.createElement('small');
    info.textContent = `Seviye ${c.lvl} ${CLASS_UI[c.cls].name}`;
    const info2 = document.createElement('small');
    info2.textContent = `${FACTION_UI[c.f].short} · ${c.kills} öldürme`;
    info2.style.color = FACTION_UI[c.f].color;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = 'Karakteri sil';
    del.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`${c.name} adlı karakter kalıcı olarak silinsin mi? Bu geri alınamaz.`)) send({ t: 'remove', id: c.id });
    };
    el.append(del, av, name, info, info2);
    el.onclick = () => { selectedChar = c.id; renderSelect(); };
    el.ondblclick = () => play();
    box.appendChild(el);
  }
  for (let i = account.chars.length; i < account.max; i++) {
    const el = document.createElement('div');
    el.className = 'card slot empty';
    el.textContent = '+ Yeni Karakter';
    el.onclick = openCreate;
    box.appendChild(el);
  }
  $('#sPlay').disabled = !selectedChar;
}
function play() { if (selectedChar) { $('#sMsg').textContent = 'Giriliyor...'; send({ t: 'play', id: selectedChar }); } }
$('#sPlay').onclick = play;
$('#sLogout').onclick = () => {
  send({ t: 'logout', token: store.get('pvp_token') });
  store.set('pvp_token', null);
  account = null;
  $('#aPass').value = '';
  show('scrAuth');
};

// --- karakter oluştur ---
let cFaction = null, cClass = 'savasci';
function openCreate() {
  cFaction = account.faction || null;
  for (const el of document.querySelectorAll('#factions .card')) {
    el.classList.toggle('sel', el.dataset.f === cFaction);
    el.classList.toggle('locked', !!account.faction && el.dataset.f !== account.faction);
  }
  $('#cFactionNote').textContent = account.faction
    ? 'Hesabındaki bütün karakterler aynı krallıkta olur.'
    : 'Dikkat: krallık hesabın için bir kez seçilir, sonraki karakterlerin de bu krallıkta olur.';
  for (const el of document.querySelectorAll('#classes .card')) el.classList.toggle('sel', el.dataset.c === cClass);
  $('#cName').value = '';
  $('#cMsg').textContent = '';
  show('scrCreate');
}
for (const el of document.querySelectorAll('#factions .card')) {
  el.onclick = () => {
    if (account.faction) return;
    cFaction = el.dataset.f;
    for (const x of document.querySelectorAll('#factions .card')) x.classList.toggle('sel', x === el);
  };
}
for (const el of document.querySelectorAll('#classes .card')) {
  el.onclick = () => {
    cClass = el.dataset.c;
    for (const x of document.querySelectorAll('#classes .card')) x.classList.toggle('sel', x === el);
  };
}
$('#cGo').onclick = () => {
  if (!cFaction) return ($('#cMsg').textContent = 'Önce bir krallık seç.');
  const name = $('#cName').value.trim();
  if (name.length < 3) return ($('#cMsg').textContent = 'Karakter adı en az 3 harf olmalı.');
  $('#cMsg').textContent = 'Oluşturuluyor...';
  send({ t: 'create', name, cls: cClass, faction: cFaction });
};
$('#cName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#cGo').click(); });
$('#cBack').onclick = () => { show('scrSelect'); renderSelect(); };

$('#exit').onclick = () => { send({ t: 'leave' }); };

// ---------------- MESAJLAR ----------------
let creating = false;
function handle(m) {
  if (m.t === 'error') {
    for (const id of ['#aMsg', '#sMsg', '#cMsg']) $(id).textContent = m.msg;
    if (myId) addChat(m.msg, true);
  } else if (m.t === 'tokenBad') {
    store.set('pvp_token', null);
    show('scrAuth');
  } else if (m.t === 'account') {
    const wasCreate = !$('#scrCreate').classList.contains('hidden');
    const before = account ? account.chars.map((c) => c.id) : [];
    account = m;
    if (m.token) store.set('pvp_token', m.token);
    if (wasCreate) {
      const added = m.chars.find((c) => !before.includes(c.id));
      if (added) selectedChar = added.id;
    }
    myId = null; state = null; view.clear();
    for (const id of ['#aMsg', '#sMsg', '#cMsg']) $(id).textContent = '';
    show('scrSelect');
    renderSelect();
  } else if (m.t === 'kicked') {
    alert(m.msg);
  } else if (m.t === 'welcome') {
    myId = m.id; MAP = m.map; CLASSES = m.classes; FACTIONS = m.factions; myFaction = m.me.f; MOBT = m.mobTypes || {};
    floaters = []; swings = []; booms = []; rings = []; board = [];
    $('#chatlog').innerHTML = ''; $('#feed').innerHTML = '';
    show('game');
    const c = CLASSES[m.me.cls];
    for (const k of SKILL_KEYS) {
      const s = c.skills[k];
      const el = $('#sk' + k.toUpperCase());
      el.querySelector('span').textContent = s.name;
      el.title = `${s.name} (${s.mp} mana, ${s.cd} sn)\n${s.desc}`;
    }
    if (window.itemsUI) itemsUI.init(m);
    if (window.shopUI) shopUI.reset();
    for (const id of ['#shopSetup', '#shopView']) $(id).classList.add('hidden');
    toast(`${FACTIONS[myFaction].name}'na hoş geldin!`);
    addChat('Köyün dışındaki kuklalarla antrenman yap, sonra düşman krallıkları avla!', true);
    addChat('Kendi krallığından oyunculara vuramazsın. Köyler güvenli bölgedir.', true);
  } else if (m.t === 'state') {
    if (!myId) return;
    state = m;
    if (m.board) board = m.board;
    // görüş alanından çıkanları unut
    const seen = new Set(m.players.map((p) => p.id).concat((m.mobs || []).map((x) => x.id)));
    for (const x of m.mobs || []) {
      const v = view.get(x.id);
      if (!v || Math.hypot(v.x - x.x, v.y - x.y) > 300) view.set(x.id, { x: x.x, y: x.y });
    }
    for (const id of view.keys()) if (!seen.has(id)) view.delete(id);
    for (const p of m.players) {
      const v = view.get(p.id);
      if (!v || Math.hypot(v.x - p.x, v.y - p.y) > 300) view.set(p.id, { x: p.x, y: p.y });
    }
    for (const ev of m.ev) onEvent(ev);
  } else if (m.t === 'dead') {
    deadUntil = performance.now() + m.in * 1000;
    deathBy = m.by;
    $('#death').classList.remove('hidden');
  } else if (m.t === 'respawn') {
    deadUntil = 0;
    $('#death').classList.add('hidden');
  } else if (window.shopUI && shopUI.handle(m)) {
    // pazar mesajı
  } else if (window.itemsUI) {
    itemsUI.handle(m);
  }
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = 0; }, 3500);
}

function onEvent(ev) {
  const t = performance.now();
  if (ev.t === 'dmg') {
    const txt = (ev.bs ? 'ARKADAN! ' : '') + (ev.p ? 'DELİCİ ' : '') + (ev.c ? 'KRİTİK ' : '') + '-' + ev.v;
    floaters.push({ x: ev.x + (Math.random() * 20 - 10), y: ev.y - 30, txt, col: ev.bs ? '#ff3aff' : ev.c ? '#ffd04a' : '#ff5a4a', t, big: ev.c || ev.bs });
  } else if (ev.t === 'heal') floaters.push({ x: ev.x, y: ev.y - 30, txt: '+' + (ev.v || ''), col: '#6aff7a', t });
  else if (ev.t === 'swing') swings.push({ id: ev.id, a: ev.a, r: ev.r, t, s: ev.s });
  else if (ev.t === 'spin') rings.push({ kind: 'spin', id: ev.id, x: ev.x, y: ev.y, r: ev.r, t, dur: 220 });
  else if (ev.t === 'wave') rings.push({ kind: 'wave', x: ev.x, y: ev.y, r: ev.r, a: ev.a, arc: ev.arc, t, dur: 350 });
  else if (ev.t === 'buff') rings.push({ kind: 'buff', id: ev.id, x: ev.x, y: ev.y, r: 40, col: FX_COLORS[ev.b] || '#fff', t, dur: 600 });
  else if (ev.t === 'boom') booms.push({ x: ev.x, y: ev.y, t });
  else if (ev.t === 'alert') floaters.push({ x: ev.x, y: ev.y - 40, txt: '!', col: '#ff3a3a', t, big: true });
  else if (ev.t === 'pin') { floaters.push({ x: ev.x, y: ev.y - 20, txt: 'SIKIŞTI!', col: '#ffb04a', t }); booms.push({ x: ev.x, y: ev.y, t, small: true }); }
  else if (ev.t === 'summon') { rings.push({ kind: 'buff', x: ev.x, y: ev.y, r: 90, col: '#b04aff', t, dur: 700 }); floaters.push({ x: ev.x, y: ev.y - 30, txt: 'ÇAĞRI!', col: '#d08aff', t, big: true }); }
  else if (ev.t === 'stoneBreak') {
    booms.push({ x: ev.x, y: ev.y, t, big: true });
    for (let i = 0; i < 40; i++) { const a = Math.random() * 6.28, sp = 80 + Math.random() * 260; sparks.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t, life: 600 + Math.random() * 500, col: Math.random() < 0.5 ? '#b04aff' : '#ff7aff' }); }
  }
  else if (ev.t === 'xp' && ev.id === myId) floaters.push({ x: ev.x, y: ev.y - 50, txt: `+${ev.v} TP`, col: '#8ad0ff', t });
  else if (ev.t === 'kill') addFeed(ev);
  else if (ev.t === 'lvl') {
    const p = state && state.players.find((x) => x.id === ev.id);
    if (p) floaters.push({ x: p.x, y: p.y - 50, txt: 'SEVİYE ' + ev.l + '!', col: '#e8b04a', t, big: true });
    if (ev.id === myId) { addChat(`Tebrikler! Seviye ${ev.l} oldun.`, true); toast(`SEVİYE ${ev.l}!`); }
  } else if (ev.t === 'chat') addChat(ev.msg, false, ev.n, ev.f);
  else if (ev.t === 'sys') addChat(ev.msg, true);
}

function colored(text, f) {
  const s = document.createElement('span');
  s.textContent = text;
  if (f && FACTIONS[f]) s.style.color = FACTIONS[f].color;
  return s;
}

function addChat(text, sys, name, f) {
  const d = document.createElement('div');
  if (name) d.append(colored(name + ': ', f), document.createTextNode(text));
  else d.textContent = text;
  if (sys) d.className = 'sys';
  const log = $('#chatlog');
  log.appendChild(d);
  while (log.children.length > 30) log.firstChild.remove();
}

function addFeed(ev) {
  const d = document.createElement('div');
  d.append(colored(ev.k, ev.kf), document.createTextNode(' ⚔ '), colored(ev.v, ev.vf));
  if (ev.s >= 3) d.append(document.createTextNode(` 🔥 ${ev.s} seri!`));
  $('#feed').prepend(d);
  setTimeout(() => d.remove(), 6000);
  while ($('#feed').children.length > 5) $('#feed').lastChild.remove();
}

// ---------------- KONTROLLER ----------------
const keys = {};
const mouse = { x: 0, y: 0, down: false };
let chatting = false;
const touchState = { mx: 0, my: 0, atk: false, lastAngle: 0 };

addEventListener('keydown', (e) => {
  if (!myId) return;
  if (e.key === 'Enter') {
    const inp = $('#chatin');
    if (chatting) {
      if (inp.value.trim()) send({ t: 'chat', msg: inp.value });
      inp.value = ''; inp.blur(); chatting = false;
    } else { chatting = true; inp.focus(); }
    e.preventDefault();
    return;
  }
  if (chatting) { if (e.key === 'Escape') { chatting = false; $('#chatin').blur(); } return; }
  const k = e.key.toLowerCase();
  if (window.itemsUI && itemsUI.key(k)) return;
  keys[k] = true;
  if (SKILL_KEYS.includes(k)) send({ t: 'skill', k });
  if (k === 'z') send({ t: 'pickup' });
  if (k === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });
cv.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
cv.addEventListener('mousedown', (e) => { if (e.button === 0) mouse.down = true; });
addEventListener('mouseup', () => { mouse.down = false; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// Dokunmatik joystick
const joy = $('#joy'), knob = $('#knob');
let joyTouch = null;
function joyMove(t) {
  const r = joy.getBoundingClientRect();
  let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy), max = r.width / 2;
  if (d > max) { dx = dx / d * max; dy = dy / d * max; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const n = Math.hypot(dx, dy);
  touchState.mx = n > 12 ? dx / max : 0;
  touchState.my = n > 12 ? dy / max : 0;
  if (n > 12) touchState.lastAngle = Math.atan2(dy, dx);
}
joy.addEventListener('touchstart', (e) => { joyTouch = e.changedTouches[0].identifier; joyMove(e.changedTouches[0]); e.preventDefault(); }, { passive: false });
joy.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) if (t.identifier === joyTouch) joyMove(t);
  e.preventDefault();
}, { passive: false });
const joyEnd = (e) => {
  for (const t of e.changedTouches) if (t.identifier === joyTouch) {
    joyTouch = null; touchState.mx = touchState.my = 0; knob.style.transform = '';
  }
};
joy.addEventListener('touchend', joyEnd);
joy.addEventListener('touchcancel', joyEnd);

function holdButton(el, on, off) {
  el.addEventListener('touchstart', (e) => { el.classList.add('on'); on(); e.preventDefault(); }, { passive: false });
  const end = () => { el.classList.remove('on'); if (off) off(); };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}
holdButton($('#tAtk'), () => (touchState.atk = true), () => (touchState.atk = false));
holdButton($('#tPick'), () => send({ t: 'pickup' }));
holdButton($('#tQ'), () => { sendInput(true); send({ t: 'skill', k: 'q' }); });
for (const k of ['e', 'r', 'f']) holdButton($('#t' + k.toUpperCase()), () => { sendInput(true); send({ t: 'skill', k }); });
holdButton($('#tChat'), () => {
  const msg = prompt('Mesajın:');
  if (msg && msg.trim()) send({ t: 'chat', msg });
});

// Telefonda en yakın düşmana otomatik nişan
function autoAim(me) {
  let best = null, bd = 520;
  for (const p of state.players) {
    if (p.id === myId || p.dead || p.f === myFaction) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < bd) { bd = d; best = p; }
  }
  for (const d of state.dummies.concat(state.mobs || [], state.stones || [])) {
    if (d.dead || d.s === 'r') continue;
    const dd = Math.hypot(d.x - me.x, d.y - me.y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best ? Math.atan2(best.y - me.y, best.x - me.x) : touchState.lastAngle;
}

let lastSent = '', lastSendTime = 0;
function sendInput(force) {
  if (!ws || ws.readyState !== 1 || !state || !myId) return;
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  let inp;
  if (isTouch) {
    inp = {
      t: 'input', up: touchState.my < -0.35, down: touchState.my > 0.35, left: touchState.mx < -0.35, right: touchState.mx > 0.35,
      atk: touchState.atk, angle: +autoAim(me).toFixed(3),
    };
  } else {
    const k = chatting ? {} : keys;
    inp = {
      t: 'input', up: !!(k.w || k.arrowup), down: !!(k.s || k.arrowdown), left: !!(k.a || k.arrowleft), right: !!(k.d || k.arrowright),
      atk: !chatting && (mouse.down || !!k[' ']), angle: +Math.atan2(mouse.y - H / 2, mouse.x - W / 2).toFixed(3),
    };
  }
  const s = JSON.stringify(inp);
  const t = performance.now();
  if (force || s !== lastSent || t - lastSendTime > 250) {
    ws.send(s); lastSent = s; lastSendTime = t;
  }
}
setInterval(sendInput, 33);

// ---------------- ÇİZİM ----------------
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
}
addEventListener('resize', resize);
resize();

const ZOOM = () => (isTouch && Math.min(W, H) < 600 ? 0.75 : 1);
const fColor = (f) => (FACTIONS[f] ? FACTIONS[f].color : '#fff');

function drawWorld(cam) {
  const z = ZOOM();
  ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * (W / 2 - cam.x * z), DPR * (H / 2 - cam.y * z));
  ctx.fillStyle = '#0d0808';
  ctx.fillRect(cam.x - W / z, cam.y - H / z, (W / z) * 2, (H / z) * 2);

  // zemin
  ctx.fillStyle = '#3b2f22';
  ctx.fillRect(0, 0, MAP.w, MAP.h);
  ctx.strokeStyle = '#ffffff0a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= MAP.w; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP.h); }
  for (let y = 0; y <= MAP.h; y += 80) { ctx.moveTo(0, y); ctx.lineTo(MAP.w, y); }
  ctx.stroke();
  // çatlaklar (dekor)
  ctx.strokeStyle = '#7a221844';
  ctx.lineWidth = 3;
  for (let i = 0; i < 30; i++) {
    const x = (i * 431) % MAP.w, y = (i * 677) % MAP.h;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 60, y + 25); ctx.lineTo(x + 90, y - 15); ctx.stroke();
  }
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, MAP.w, MAP.h);

  // köyler
  for (const v of MAP.villages) {
    const col = fColor(v.f);
    ctx.fillStyle = '#5a6b3e';
    ctx.beginPath(); ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col + '22';
    ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.setLineDash([18, 10]); ctx.stroke(); ctx.setLineDash([]);
    // sancak
    ctx.fillStyle = '#5a3a1e'; ctx.fillRect(v.x - 3, v.y - 70, 6, 60);
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(v.x + 3, v.y - 70); ctx.lineTo(v.x + 45, v.y - 58); ctx.lineTo(v.x + 3, v.y - 44); ctx.fill();
    ctx.fillStyle = '#ffffffdd'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(FACTIONS[v.f].short.toUpperCase() + ' KÖYÜ', v.x, v.y + 10);
    ctx.font = '13px sans-serif'; ctx.fillText('Güvenli Bölge', v.x, v.y + 30);
  }

  if (window.itemsUI) itemsUI.drawWorld();

  // kayalar
  for (const r of MAP.rocks) {
    ctx.fillStyle = '#2a2420'; ctx.beginPath(); ctx.arc(r.x + 6, r.y + 8, r.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b5f55'; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#857a6f'; ctx.beginPath(); ctx.arc(r.x - r.r * 0.3, r.y - r.r * 0.3, r.r * 0.45, 0, Math.PI * 2); ctx.fill();
  }

  // kuklalar
  for (const d of state.dummies) {
    if (d.dead) continue;
    ctx.fillStyle = '#5a3a1e'; ctx.fillRect(d.x - 4, d.y - 10, 8, 34);
    ctx.fillStyle = '#c9a26a'; ctx.beginPath(); ctx.arc(d.x, d.y - 14, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(d.x - 20, d.y - 2, 40, 7);
    hpBar(d.x, d.y - 40, d.hp / d.mh, '#c9a26a');
    if (d.st) stars(d.x, d.y - 52);
  }

  const tm = performance.now();
  // yerdeki ganimet
  const ICONS = { 1001: '⚔️', 1011: '🗡️', 1021: '⚔️', 1031: '🪄', 2001: '🥋', 2101: '⛑️', 3001: '🪨', 3002: '🌙', 3003: '🔶', 4001: '📜', 4002: '🔩', 5001: '💎', 5002: '✨', 6001: '📘' };
  for (const g of state.drops || []) {
    const bob = Math.sin(tm / 300 + g.x) * 2;
    ctx.fillStyle = g.m ? '#ffd04a55' : g.o ? '#ff3a3a33' : '#ffffff22';
    ctx.beginPath(); ctx.ellipse(g.x, g.y + 9, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(g.g ? '💰' : ICONS[g.i] || '❔', g.x, g.y + bob);
    ctx.textBaseline = 'alphabetic';
    if (g.p) { ctx.font = 'bold 10px sans-serif'; ctx.fillStyle = '#ffd04a'; ctx.fillText('+' + g.p, g.x + 12, g.y - 8); }
    if (g.o) {
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#000'; ctx.fillText(`${g.o} (${g.ot})`, g.x + 1, g.y + 23);
      ctx.fillStyle = '#ff9a8a'; ctx.fillText(`${g.o} (${g.ot})`, g.x, g.y + 22);
    }
  }
  // Bozulma Taşları: canı azaldıkça parıltı ve kıvılcımlar şiddetlenir
  for (const st of state.stones || []) {
    const k = 1 - st.hp / st.mh; // 0: tam can, 1: kırılmak üzere
    const pulse = 1 + Math.sin(tm / (220 - 150 * k)) * (0.08 + 0.2 * k);
    const glow = ctx.createRadialGradient(st.x, st.y, st.r * 0.3, st.x, st.y, st.r * (1.6 + 1.4 * k) * pulse);
    glow.addColorStop(0, `rgba(190,80,255,${0.35 + 0.45 * k})`);
    glow.addColorStop(1, 'rgba(120,20,200,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(st.x, st.y, st.r * (1.6 + 1.4 * k) * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0007'; ctx.beginPath(); ctx.ellipse(st.x, st.y + st.r * 0.8, st.r, st.r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    // kristal
    ctx.fillStyle = '#2a1238';
    ctx.beginPath();
    ctx.moveTo(st.x, st.y - st.r * 1.5); ctx.lineTo(st.x + st.r * 0.75, st.y - st.r * 0.2); ctx.lineTo(st.x + st.r * 0.5, st.y + st.r * 0.8);
    ctx.lineTo(st.x - st.r * 0.5, st.y + st.r * 0.8); ctx.lineTo(st.x - st.r * 0.75, st.y - st.r * 0.2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(220,140,255,${0.5 + 0.5 * k})`; ctx.lineWidth = 2 + 2 * k; ctx.stroke();
    // çatlaklar (can azaldıkça artar)
    ctx.strokeStyle = `rgba(255,150,255,${0.4 + 0.6 * k})`; ctx.lineWidth = 2;
    const cracks = Math.floor(k * 6);
    for (let i = 0; i < cracks; i++) {
      const a = i * 1.7;
      ctx.beginPath(); ctx.moveTo(st.x, st.y - st.r * 0.2);
      ctx.lineTo(st.x + Math.cos(a) * st.r * 0.45, st.y + Math.sin(a) * st.r * 0.6 - st.r * 0.2); ctx.stroke();
    }
    // kıvılcımlar
    if (Math.random() < 0.05 + 0.6 * k) {
      const a = Math.random() * 6.28;
      sparks.push({ x: st.x + Math.cos(a) * st.r * 0.6, y: st.y - st.r * 0.3 + Math.sin(a) * st.r * 0.6, vx: Math.cos(a) * 40, vy: -60 - Math.random() * 80, t: tm, life: 700, col: '#e08aff' });
    }
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#000'; ctx.fillText(`Sv.${st.l} Bozulma Taşı`, st.x + 1, st.y - st.r * 1.5 - 17);
    ctx.fillStyle = '#e08aff'; ctx.fillText(`Sv.${st.l} Bozulma Taşı`, st.x, st.y - st.r * 1.5 - 18);
    ctx.fillStyle = '#000a'; ctx.fillRect(st.x - 40, st.y - st.r * 1.5 - 12, 80, 7);
    ctx.fillStyle = '#b04aff'; ctx.fillRect(st.x - 39, st.y - st.r * 1.5 - 11, 78 * st.hp / st.mh, 5);
  }
  sparks = sparks.filter((p) => tm - p.t < p.life);
  for (const p of sparks) {
    const dt = (tm - p.t) / 1000;
    ctx.globalAlpha = 1 - (tm - p.t) / p.life;
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x + p.vx * dt - 1.5, p.y + p.vy * dt + 40 * dt * dt - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // canavarlar
  for (const mb of state.mobs || []) {
    const T = MOBT[mb.t] || { color: '#888', r: 18, aggro: 'semi', shape: 'beast', name: '?' };
    const v = view.get(mb.id) || { x: mb.x, y: mb.y };
    v.x += (mb.x - v.x) * 0.35; v.y += (mb.y - v.y) * 0.35;
    const r = T.r;
    ctx.globalAlpha = mb.s === 'r' ? 0.45 : 1;
    ctx.fillStyle = '#0006'; ctx.beginPath(); ctx.ellipse(v.x, v.y + r * 0.7, r, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    if (mb.w) { // saldırı hazırlığı: kırmızı uyarı halkası
      ctx.fillStyle = '#ff2a1a44'; ctx.beginPath(); ctx.arc(v.x, v.y, r + 14 + Math.sin(tm / 40) * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = T.color;
    if (T.shape === 'beast') {
      ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(mb.a);
      ctx.beginPath(); ctx.ellipse(0, 0, r * 1.15, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.95, 0, r * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(r * 1.2, -r * 0.18, 2.5, 0, Math.PI * 2); ctx.arc(r * 1.2, r * 0.18, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      ctx.strokeStyle = '#bbb'; ctx.lineWidth = 4; ctx.beginPath();
      ctx.moveTo(v.x + Math.cos(mb.a) * 10, v.y + Math.sin(mb.a) * 10); ctx.lineTo(v.x + Math.cos(mb.a) * 36, v.y + Math.sin(mb.a) * 36); ctx.stroke();
      ctx.beginPath(); ctx.arc(v.x, v.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8c9a0'; ctx.beginPath(); ctx.arc(v.x + Math.cos(mb.a) * 7, v.y + Math.sin(mb.a) * 7, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const label = `Sv.${mb.l} ${T.name}`;
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#000'; ctx.fillText(label, v.x + 1, v.y - r - 15);
    ctx.fillStyle = T.aggro === 'aggr' ? '#ff6a5a' : T.aggro === 'semi' ? '#ffd04a' : '#e8e8e8';
    ctx.fillText(label, v.x, v.y - r - 16);
    if (mb.hp < mb.mh || mb.s === 'c') hpBar(v.x, v.y - r - 10, mb.hp / mb.mh, '#e0473c');
    if (mb.st) stars(v.x, v.y - r - 26);
  }

  // mermiler
  for (const [x, y, k] of state.proj) {
    const col = { fire: '#ff7a1a', poison: '#6aff4a', light: '#fff27a', spirit: '#7affd0' }[k] || '#7ad7ff';
    const r = k === 'fire' ? 13 : k === 'light' ? 8 : 7;
    ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // oyuncular
  const t = performance.now();
  for (const p of state.players) {
    if (p.dead) continue;
    const v = view.get(p.id) || p;
    v.x += (p.x - v.x) * 0.35; v.y += (p.y - v.y) * 0.35;
    const c = CLASSES[p.c];
    const ally = p.f === myFaction;
    ctx.globalAlpha = (p.fx || []).includes('iv') ? 0.35 : 1;
    // krallık halkası
    ctx.fillStyle = fColor(p.f) + '55'; ctx.beginPath(); ctx.ellipse(v.x, v.y + 16, 22, 9, 0, 0, Math.PI * 2); ctx.fill();
    // silah
    ctx.strokeStyle = p.c === 'buyucu' ? '#c9a26a' : '#d8d8e0'; ctx.lineWidth = p.c === 'savasci' ? 6 : 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(v.x + Math.cos(p.a) * 12, v.y + Math.sin(p.a) * 12);
    ctx.lineTo(v.x + Math.cos(p.a) * (p.c === 'golge' ? 32 : 40), v.y + Math.sin(p.a) * (p.c === 'golge' ? 32 : 40)); ctx.stroke();
    if (p.c === 'buyucu') { ctx.fillStyle = '#7ad7ff'; ctx.beginPath(); ctx.arc(v.x + Math.cos(p.a) * 42, v.y + Math.sin(p.a) * 42, 5, 0, Math.PI * 2); ctx.fill(); }
    // gövde
    ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(v.x, v.y, 20, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = p.id === myId ? '#e8b04a' : fColor(p.f); ctx.lineWidth = 3; ctx.stroke();
    // yüz yönü
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(v.x + Math.cos(p.a) * 9, v.y + Math.sin(p.a) * 9, 4, 0, Math.PI * 2); ctx.fill();
    const fx = p.fx || [];
    for (const id of fx) {
      if (id === 'iv') continue;
      const col = FX_COLORS[id];
      if (id === 'sh') { ctx.strokeStyle = col + 'cc'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(v.x, v.y, 28, 0, Math.PI * 2); ctx.stroke(); }
      else {
        const pulse = 26 + Math.sin(t / 150 + id.length) * 3;
        ctx.strokeStyle = col + '99'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(v.x, v.y, pulse + 6 * fx.indexOf(id), 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (p.ps) { ctx.fillStyle = '#6aff4a55'; ctx.beginPath(); ctx.arc(v.x, v.y, 22, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    // isim (krallık renginde) + can
    const label = `Sv.${p.l} ${p.n}`;
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#000'; ctx.fillText(label, v.x + 1, v.y - 39);
    ctx.fillStyle = p.id === myId ? '#e8b04a' : fColor(p.f); ctx.fillText(label, v.x, v.y - 40);
    hpBar(v.x, v.y - 34, p.hp / p.mh, ally ? '#4ad04a' : '#e0473c');
    if (p.st) stars(v.x, v.y - 58);
    if (p.sp) { // pazar tabelası
      ctx.font = 'bold 12px sans-serif';
      const tw = Math.min(150, ctx.measureText(p.sp).width + 30);
      ctx.fillStyle = '#5a3a1e'; ctx.fillRect(v.x - 2, v.y - 78, 4, 30);
      ctx.fillStyle = '#f3e2b8'; ctx.strokeStyle = '#8a5a2a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.rect(v.x - tw / 2, v.y - 98, tw, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#4a2a10'; ctx.textAlign = 'center';
      ctx.fillText('🏪 ' + (p.sp.length > 18 ? p.sp.slice(0, 17) + '…' : p.sp), v.x, v.y - 81);
    }
  }

  // kılıç savurma efekti
  swings = swings.filter((s) => t - s.t < 180);
  for (const s of swings) {
    const p = state.players.find((x) => x.id === s.id);
    if (!p) continue;
    const v = view.get(p.id) || p;
    const k = (t - s.t) / 180;
    ctx.strokeStyle = s.s ? `rgba(255,80,255,${1 - k})` : `rgba(255,240,200,${1 - k})`; ctx.lineWidth = s.s ? 8 : 5;
    ctx.beginPath(); ctx.arc(v.x, v.y, s.r * (0.7 + k * 0.3), s.a - 0.75, s.a + 0.75); ctx.stroke();
  }
  // beceri efektleri: kasırga, dalga, güçlendirme halkası
  rings = rings.filter((g) => t - g.t < g.dur);
  for (const g of rings) {
    const k = (t - g.t) / g.dur;
    const owner = g.id !== undefined && state.players.find((x) => x.id === g.id);
    const o = owner ? (view.get(owner.id) || owner) : g;
    if (g.kind === 'spin') {
      ctx.strokeStyle = `rgba(255,220,150,${0.9 * (1 - k)})`; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(o.x, o.y, g.r * (0.6 + 0.4 * k), k * 6, k * 6 + Math.PI * 1.6); ctx.stroke();
    } else if (g.kind === 'wave') {
      ctx.fillStyle = `rgba(90,140,255,${0.45 * (1 - k)})`;
      ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.arc(g.x, g.y, g.r * (0.4 + 0.6 * k), g.a - g.arc / 2, g.a + g.arc / 2); ctx.closePath(); ctx.fill();
    } else if (g.kind === 'buff') {
      ctx.strokeStyle = g.col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(o.x, o.y, 20 + g.r * k, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // patlamalar
  booms = booms.filter((b) => t - b.t < 400);
  for (const b of booms) {
    const k = (t - b.t) / 400;
    ctx.fillStyle = `rgba(255,120,30,${0.6 * (1 - k)})`;
    if (b.big) ctx.fillStyle = `rgba(190,80,255,${0.6 * (1 - k)})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, (b.small ? 35 : b.big ? 160 : 95) * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
  }
  // hasar yazıları
  floaters = floaters.filter((f) => t - f.t < 900);
  for (const f of floaters) {
    const k = (t - f.t) / 900;
    ctx.globalAlpha = 1 - k;
    ctx.font = `bold ${f.big ? 22 : 16}px sans-serif`;
    ctx.fillStyle = '#000'; ctx.fillText(f.txt, f.x + 1, f.y - k * 40 + 1);
    ctx.fillStyle = f.col; ctx.fillText(f.txt, f.x, f.y - k * 40);
  }
  ctx.globalAlpha = 1;
}

function stars(x, y) {
  const t = performance.now() / 200;
  ctx.fillStyle = '#ffe85a';
  for (let i = 0; i < 3; i++) {
    const a = t + (i * Math.PI * 2) / 3;
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * 12, y + Math.sin(a) * 4, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function hpBar(x, y, frac, col) {
  ctx.fillStyle = '#000a'; ctx.fillRect(x - 22, y, 44, 6);
  ctx.fillStyle = col; ctx.fillRect(x - 21, y + 1, 42 * Math.max(0, frac), 4);
}

function drawMinimap() {
  const mw = 180, mh = 144, sx = mw / MAP.w, sy = mh / MAP.h;
  mini.clearRect(0, 0, mw, mh);
  mini.fillStyle = '#3b2f22cc'; mini.fillRect(0, 0, mw, mh);
  for (const v of MAP.villages) {
    mini.fillStyle = fColor(v.f) + '88';
    mini.beginPath(); mini.arc(v.x * sx, v.y * sy, v.r * sx, 0, Math.PI * 2); mini.fill();
  }
  mini.fillStyle = '#6b5f55';
  for (const r of MAP.rocks) { mini.beginPath(); mini.arc(r.x * sx, r.y * sy, Math.max(2, r.r * sx), 0, Math.PI * 2); mini.fill(); }
  mini.fillStyle = '#ffb04a';
  for (const mb of state.mobs || []) mini.fillRect(mb.x * sx - 1, mb.y * sy - 1, 2, 2);
  mini.fillStyle = '#d08aff';
  for (const st of state.stones || []) { mini.beginPath(); mini.arc(st.x * sx, st.y * sy, 3.5, 0, Math.PI * 2); mini.fill(); }
  for (const p of state.players) {
    if (p.dead) continue;
    const me = p.id === myId;
    mini.fillStyle = me ? '#ffffff' : fColor(p.f);
    const s = me ? 6 : 4;
    mini.fillRect(p.x * sx - s / 2, p.y * sy - s / 2, s, s);
  }
}

function setBar(id, cur, max, label) {
  $(id + ' i').style.width = (100 * Math.max(0, cur) / max) + '%';
  $(id + ' span').textContent = label;
}

function setSkill(id, remain, total) {
  const el = $(id);
  el.querySelector('.cdo').style.height = remain > 0 ? (100 * remain / total) + '%' : '0';
  el.querySelector('.cdt').textContent = remain > 0.05 && total > 1 ? Math.ceil(remain) : '';
}

let lastHud = 0;
let lastCam = { x: 0, y: 0 };
// haritaya tıklama: pazar tabelası
cv.addEventListener('click', (e) => {
  if (!myId || !window.shopUI) return;
  const z = ZOOM();
  shopUI.clickWorld(lastCam.x + (e.clientX - W / 2) / z, lastCam.y + (e.clientY - H / 2) / z);
});
function frame() {
  requestAnimationFrame(frame);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!state || !MAP || !myId) {
    ctx.fillStyle = '#120b0b'; ctx.fillRect(0, 0, cv.width, cv.height);
    return;
  }
  const me = state.players.find((p) => p.id === myId);
  const cam = me ? (view.get(me.id) || me) : MAP.villages[0];
  lastCam = { x: cam.x, y: cam.y };
  drawWorld(cam);

  const t = performance.now();
  if (deadUntil) {
    $('#deathMsg').textContent = `${deathBy} seni öldürdü. ${Math.max(0, Math.ceil((deadUntil - t) / 1000))} saniye sonra köyünde doğacaksın.`;
  }

  if (me && t - lastHud > 80) {
    lastHud = t;
    if (window.itemsUI) itemsUI.tick();
    if (window.shopUI) shopUI.tick();
    const m = state.me;
    setBar('#hpb', me.hp, me.mh, `CAN ${me.hp} / ${me.mh}`);
    setBar('#mpb', m.mp, m.mm, `MANA ${m.mp} / ${m.mm}`);
    setBar('#xpb', m.xp, m.xpn, '');
    const c = CLASSES[me.c];
    setSkill('#skA', m.cd.atk, c.atkCd);
    for (const k of SKILL_KEYS) {
      const K = k.toUpperCase();
      setSkill('#sk' + K, m.cd[k], c.skills[k].cd);
      $('#sk' + K + ' b').textContent = skillLv[k] > 1 ? `${K} ${skillLv[k]}` : K;
      $('#sk' + K).style.opacity = m.mp < c.skills[k].mp ? 0.5 : 1;
      if (isTouch) $('#t' + K).textContent = m.cd[k] > 0.05 ? Math.ceil(m.cd[k]) : K;
    }
    if (isTouch) {
      const canPick = (state.drops || []).some((g) => !g.o && Math.hypot(g.x - me.x, g.y - me.y) < 90);
      $('#tPick').classList.toggle('hidden', !canPick);
    }
    const bf = $('#buffs');
    bf.innerHTML = '';
    for (const [id, left] of m.fx) {
      const d = document.createElement('div');
      d.textContent = `${FX_NAMES[id] || id} ${Math.ceil(left)}s`;
      d.style.borderColor = FX_COLORS[id] || '#e8b04a';
      bf.appendChild(d);
    }
    const info = $('#info');
    info.innerHTML = '';
    const l1 = document.createElement('div');
    l1.append(colored(FACTIONS[me.f].short, me.f), document.createTextNode(` · ${c.name} · Seviye ${me.l}`));
    const l2 = document.createElement('div'); l2.textContent = `Öldürme: ${m.k} · Ölüm: ${m.d} · Çevrimiçi: ${state.online}`;
    const l3 = document.createElement('div'); l3.className = 'zone';
    l3.textContent = m.safe ? '● Güvenli Bölge' : '● PvP Bölgesi';
    l3.style.color = m.safe ? '#8aff8a' : '#ff6a5a';
    info.append(l1, l2, l3);
    const bl = $('#boardList');
    bl.innerHTML = '';
    board.forEach((b, i) => {
      const d = document.createElement('div');
      const a = colored(`${i + 1}. ${b.n} (Sv.${b.l})`, b.f);
      const k = document.createElement('span'); k.textContent = `${b.k}/${b.d}`;
      d.append(a, k); bl.appendChild(d);
    });
    if (!isTouch) drawMinimap();
  }
}
requestAnimationFrame(frame);

connect();

// Uygulama gibi kurulabilmesi için (PWA)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

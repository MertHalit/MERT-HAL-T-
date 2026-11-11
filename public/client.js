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
// Grafik seçimi: 3D (varsayılan) / 2D (eski ve zayıf cihazlar için)
function gfxMode() { try { return localStorage.getItem('pvp_gfx') === '2d' || /[?&]gfx=2d/.test(location.search) ? '2d' : '3d'; } catch { return '3d'; } }
$('#bGfx').textContent = `⚙️ Grafik: ${gfxMode().toUpperCase()}`;
$('#bGfx').onclick = () => {
  const next = gfxMode() === '3d' ? '2d' : '3d';
  if (!confirm(`Grafik ${next.toUpperCase()} olarak değiştirilsin mi? Sayfa yeniden yüklenecek.`)) return;
  try { localStorage.setItem('pvp_gfx', next); } catch {}
  location.href = location.pathname;
};

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
    gfx.init(MAP);
    if (window.r3d) { r3d.reset(); r3d.init(); }
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
    m.mobs = (m.mobs || []).filter((x) => !x.d || window.r3d); // 2D'de ölü canavar gösterilmez
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
  gfx.onEvent(ev);
  if (window.r3d) r3d.onEvent(ev);
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
function autoAim(me, mv) {
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
  if (best) return Math.atan2(best.y - me.y, best.x - me.x);
  if (mv && Math.hypot(mv.x, mv.y) > 0.2) { touchState.lastAngle3 = Math.atan2(mv.y, mv.x); return touchState.lastAngle3; }
  return mv ? (touchState.lastAngle3 ?? me.a) : touchState.lastAngle;
}

let lastSent = '', lastSendTime = 0;
function sendInput(force) {
  if (!ws || ws.readyState !== 1 || !state || !myId) return;
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  let inp;
  const r3 = window.r3d && r3d.ready;
  if (isTouch) {
    inp = {
      t: 'input', up: touchState.my < -0.35, down: touchState.my > 0.35, left: touchState.mx < -0.35, right: touchState.mx > 0.35,
      atk: touchState.atk, angle: +autoAim(me).toFixed(3),
    };
    if (r3) { // 3D: joystick kameraya göre
      const v = r3d.moveVector(-touchState.my, touchState.mx);
      inp = { t: 'input', mx: +v.x.toFixed(3), my: +v.y.toFixed(3), atk: touchState.atk, angle: +autoAim(me, v).toFixed(3) };
    }
  } else {
    const k = chatting ? {} : keys;
    inp = {
      t: 'input', up: !!(k.w || k.arrowup), down: !!(k.s || k.arrowdown), left: !!(k.a || k.arrowleft), right: !!(k.d || k.arrowright),
      atk: !chatting && (mouse.down || !!k[' ']), angle: +Math.atan2(mouse.y - H / 2, mouse.x - W / 2).toFixed(3),
    };
    if (r3) { // 3D: WASD kameraya göre, nişan farenin zemindeki noktasına
      const fwd = (inp.up ? 1 : 0) - (inp.down ? 1 : 0), right = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      const v = r3d.moveVector(fwd, right);
      const len = Math.hypot(v.x, v.y) || 1;
      const mv = view.get(me.id) || me;
      const gp = r3d.groundPoint(mouse.x, mouse.y);
      const ang = gp && (mouse.x || mouse.y) ? Math.atan2(gp.y - mv.y, gp.x - mv.x) : fwd || right ? Math.atan2(v.y, v.x) : me.a;
      inp = { t: 'input', mx: +(v.x / len).toFixed(3) * (fwd || right ? 1 : 0), my: +(v.y / len).toFixed(3) * (fwd || right ? 1 : 0), atk: inp.atk, angle: +ang.toFixed(3) };
    }
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

// Dünya çizimi gfx.js'de (zemin, dekor, karakterler, efektler)
function drawWorld(cam) {
  if (window.r3d && r3d.ready && r3d.render(cam)) return; // 3D
  gfx.drawWorld(cam); // 3D hazır değilse ya da desteklenmiyorsa 2D
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
  if (window.r3d && r3d.ready) { // 3D: tabelanın ekrandaki yerine tıklandı mı?
    for (const p of state.players) {
      if (!p.sp || p.id === myId) continue;
      const v = view.get(p.id) || p;
      const s = r3d.project(v.x, v.y, 2.25);
      if (s && Math.abs(e.clientX - s.x) < 85 && e.clientY > s.y - 55 && e.clientY < s.y + 30) { send({ t: 'viewShop', id: p.id }); return; }
    }
    return;
  }
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

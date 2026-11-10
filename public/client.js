// PvP Server - oyun istemcisi (PC + telefon)
const $ = (s) => document.querySelector(s);
const cv = $('#game');
const ctx = cv.getContext('2d');
const mini = $('#mini').getContext('2d');

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) {
  document.body.classList.add('touch');
  $('#helpPc').classList.add('hidden');
  $('#helpTouch').classList.remove('hidden');
}

let ws = null, myId = null, MAP = null, CLASSES = null, state = null;
const view = new Map(); // yumuşak hareket için çizim konumları
let floaters = [], swings = [], booms = [], board = [];
let deadUntil = 0;
let W = 0, H = 0, DPR = 1;

// ---------------- GİRİŞ ----------------
let selected = 'savasci';
document.querySelectorAll('.cls').forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll('.cls').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    selected = el.dataset.c;
  };
});
try { $('#name').value = localStorage.getItem('pvp_name') || ''; } catch {}
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('#play').onclick = join;

function serverUrl() {
  if (window.KV_SERVER) return window.KV_SERVER;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function join() {
  const name = $('#name').value.trim();
  try { localStorage.setItem('pvp_name', name); } catch {}
  $('#status').textContent = 'Bağlanılıyor...';
  ws = new WebSocket(serverUrl());
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, cls: selected }));
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onerror = () => { $('#status').textContent = 'Sunucuya bağlanılamadı.'; };
  ws.onclose = () => {
    if (myId) { addChat('Sunucu bağlantısı koptu. Sayfayı yenile.', true); }
    else $('#status').textContent = 'Sunucuya bağlanılamadı.';
  };
}

// ---------------- MESAJLAR ----------------
function handle(m) {
  if (m.t === 'welcome') {
    myId = m.id; MAP = m.map; CLASSES = m.classes;
    $('#login').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    if (isTouch) $('#touch').classList.remove('hidden');
    const c = CLASSES[selected];
    $('#skQ span').textContent = c.q.name;
    $('#skE span').textContent = c.e.name;
    addChat('PvP Server\'e hoş geldin! Köyden çık ve savaş.', true);
  } else if (m.t === 'state') {
    state = m;
    if (m.board) board = m.board;
    for (const p of m.players) {
      const v = view.get(p.id);
      if (!v || Math.hypot(v.x - p.x, v.y - p.y) > 300) view.set(p.id, { x: p.x, y: p.y });
    }
    for (const ev of m.ev) onEvent(ev);
  } else if (m.t === 'dead') {
    deadUntil = performance.now() + m.in * 1000;
    $('#deathMsg').textContent = `${m.by} seni öldürdü.`;
    $('#death').classList.remove('hidden');
  } else if (m.t === 'respawn') {
    deadUntil = 0;
    $('#death').classList.add('hidden');
  }
}

function onEvent(ev) {
  const t = performance.now();
  if (ev.t === 'dmg') floaters.push({ x: ev.x + (Math.random() * 20 - 10), y: ev.y - 30, txt: '-' + ev.v, col: '#ff5a4a', t });
  else if (ev.t === 'heal') floaters.push({ x: ev.x, y: ev.y - 30, txt: '+ŞİFA', col: '#6aff7a', t });
  else if (ev.t === 'swing') swings.push({ id: ev.id, a: ev.a, r: ev.r, t });
  else if (ev.t === 'boom') booms.push({ x: ev.x, y: ev.y, t });
  else if (ev.t === 'kill') {
    const s = ev.s >= 3 ? ` 🔥 ${ev.s} seri!` : '';
    addFeed(`⚔ ${ev.k} → ${ev.v}${s}`);
  } else if (ev.t === 'lvl') {
    const p = state && state.players.find((x) => x.id === ev.id);
    if (p) floaters.push({ x: p.x, y: p.y - 50, txt: 'SEVİYE ' + ev.l + '!', col: '#e8b04a', t, big: true });
    if (ev.id === myId) addChat(`Tebrikler! Seviye ${ev.l} oldun.`, true);
  } else if (ev.t === 'chat') addChat(`${ev.n}: ${ev.msg}`);
  else if (ev.t === 'sys') addChat(ev.msg, true);
}

function addChat(text, sys) {
  const d = document.createElement('div');
  d.textContent = text;
  if (sys) d.className = 'sys';
  const log = $('#chatlog');
  log.appendChild(d);
  while (log.children.length > 30) log.firstChild.remove();
}

function addFeed(text) {
  const d = document.createElement('div');
  d.textContent = text;
  $('#feed').prepend(d);
  setTimeout(() => d.remove(), 6000);
  while ($('#feed').children.length > 5) $('#feed').lastChild.remove();
}

// ---------------- KONTROLLER ----------------
const keys = {};
let mouse = { x: 0, y: 0, down: false };
let chatting = false;
const touchState = { mx: 0, my: 0, atk: false, lastAngle: 0 };

addEventListener('keydown', (e) => {
  if (!myId) return;
  if (e.key === 'Enter') {
    const inp = $('#chatin');
    if (chatting) {
      if (inp.value.trim()) ws.send(JSON.stringify({ t: 'chat', msg: inp.value }));
      inp.value = ''; inp.blur(); chatting = false; document.body.classList.remove('chatting');
    } else { chatting = true; document.body.classList.add('chatting'); inp.focus(); }
    e.preventDefault();
    return;
  }
  if (chatting) { if (e.key === 'Escape') { chatting = false; $('#chatin').blur(); } return; }
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === 'q' || k === 'e') ws.send(JSON.stringify({ t: 'skill', k }));
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
holdButton($('#tQ'), () => { sendInput(true); ws.send(JSON.stringify({ t: 'skill', k: 'q' })); });
holdButton($('#tE'), () => { sendInput(true); ws.send(JSON.stringify({ t: 'skill', k: 'e' })); });
holdButton($('#tChat'), () => {
  const msg = prompt('Mesajın:');
  if (msg && msg.trim()) ws.send(JSON.stringify({ t: 'chat', msg }));
});

// Telefonda en yakın düşmana otomatik nişan
function autoAim(me) {
  let best = null, bd = 520;
  for (const p of state.players) {
    if (p.id === myId || p.dead) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < bd) { bd = d; best = p; }
  }
  for (const d of state.dummies) {
    if (d.dead) continue;
    const dd = Math.hypot(d.x - me.x, d.y - me.y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best ? Math.atan2(best.y - me.y, best.x - me.x) : touchState.lastAngle;
}

let lastSent = '', lastSendTime = 0;
function sendInput(force) {
  if (!ws || ws.readyState !== 1 || !state) return;
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
  // kızıl çatlaklar (dekor)
  ctx.strokeStyle = '#7a221844';
  ctx.lineWidth = 3;
  for (let i = 0; i < 18; i++) {
    const x = (i * 431) % MAP.w, y = (i * 677) % MAP.h;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 60, y + 25); ctx.lineTo(x + 90, y - 15); ctx.stroke();
  }
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, MAP.w, MAP.h);

  // köy
  const s = MAP.safe;
  ctx.fillStyle = '#5a6b3e';
  ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9b38a'; ctx.lineWidth = 8; ctx.setLineDash([18, 10]); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#ffffffcc'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('KÖY', s.x, s.y - 8);
  ctx.font = '13px sans-serif'; ctx.fillText('Güvenli Bölge', s.x, s.y + 12);

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
  }

  // mermiler
  for (const [x, y, k] of state.proj) {
    const col = k === 'fire' ? '#ff7a1a' : k === 'poison' ? '#6aff4a' : '#7ad7ff';
    const r = k === 'fire' ? 13 : 7;
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
    ctx.globalAlpha = p.iv ? 0.35 : 1;
    // gölge
    ctx.fillStyle = '#0006'; ctx.beginPath(); ctx.ellipse(v.x, v.y + 16, 18, 7, 0, 0, Math.PI * 2); ctx.fill();
    // silah
    ctx.strokeStyle = p.c === 'buyucu' ? '#c9a26a' : '#d8d8e0'; ctx.lineWidth = p.c === 'savasci' ? 6 : 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(v.x + Math.cos(p.a) * 12, v.y + Math.sin(p.a) * 12);
    ctx.lineTo(v.x + Math.cos(p.a) * (p.c === 'golge' ? 32 : 40), v.y + Math.sin(p.a) * (p.c === 'golge' ? 32 : 40)); ctx.stroke();
    if (p.c === 'buyucu') { ctx.fillStyle = '#7ad7ff'; ctx.beginPath(); ctx.arc(v.x + Math.cos(p.a) * 42, v.y + Math.sin(p.a) * 42, 5, 0, Math.PI * 2); ctx.fill(); }
    // gövde
    ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(v.x, v.y, 20, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = p.id === myId ? '#e8b04a' : '#0008'; ctx.lineWidth = 3; ctx.stroke();
    // yüz yönü
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(v.x + Math.cos(p.a) * 9, v.y + Math.sin(p.a) * 9, 4, 0, Math.PI * 2); ctx.fill();
    if (p.sh) { ctx.strokeStyle = '#7ab8ffcc'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(v.x, v.y, 28, 0, Math.PI * 2); ctx.stroke(); }
    if (p.ps) { ctx.fillStyle = '#6aff4a55'; ctx.beginPath(); ctx.arc(v.x, v.y, 22, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    // isim + can
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#000'; ctx.fillText(`Sv.${p.l} ${p.n}`, v.x + 1, v.y - 39);
    ctx.fillStyle = p.id === myId ? '#e8b04a' : '#fff'; ctx.fillText(`Sv.${p.l} ${p.n}`, v.x, v.y - 40);
    hpBar(v.x, v.y - 34, p.hp / p.mh, p.id === myId ? '#4ad04a' : '#e0473c');
  }

  // kılıç savurma efekti
  swings = swings.filter((s) => t - s.t < 180);
  for (const s of swings) {
    const p = state.players.find((x) => x.id === s.id);
    if (!p) continue;
    const v = view.get(p.id) || p;
    const k = (t - s.t) / 180;
    ctx.strokeStyle = `rgba(255,240,200,${1 - k})`; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(v.x, v.y, s.r * (0.7 + k * 0.3), s.a - 0.75, s.a + 0.75); ctx.stroke();
  }
  // patlamalar
  booms = booms.filter((b) => t - b.t < 400);
  for (const b of booms) {
    const k = (t - b.t) / 400;
    ctx.fillStyle = `rgba(255,120,30,${0.6 * (1 - k)})`;
    ctx.beginPath(); ctx.arc(b.x, b.y, 95 * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
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

function hpBar(x, y, frac, col) {
  ctx.fillStyle = '#000a'; ctx.fillRect(x - 22, y, 44, 6);
  ctx.fillStyle = col; ctx.fillRect(x - 21, y + 1, 42 * Math.max(0, frac), 4);
}

function drawMinimap(me) {
  const sx = 180 / MAP.w, sy = 120 / MAP.h;
  mini.clearRect(0, 0, 180, 120);
  mini.fillStyle = '#3b2f22cc'; mini.fillRect(0, 0, 180, 120);
  mini.fillStyle = '#5a6b3e'; mini.beginPath(); mini.arc(MAP.safe.x * sx, MAP.safe.y * sy, MAP.safe.r * sx, 0, Math.PI * 2); mini.fill();
  mini.fillStyle = '#6b5f55';
  for (const r of MAP.rocks) { mini.beginPath(); mini.arc(r.x * sx, r.y * sy, Math.max(2, r.r * sx), 0, Math.PI * 2); mini.fill(); }
  for (const p of state.players) {
    if (p.dead) continue;
    mini.fillStyle = p.id === myId ? '#e8b04a' : '#ff4a3a';
    mini.fillRect(p.x * sx - 2, p.y * sy - 2, p.id === myId ? 5 : 4, p.id === myId ? 5 : 4);
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
function frame() {
  requestAnimationFrame(frame);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!state || !MAP) {
    ctx.fillStyle = '#120b0b'; ctx.fillRect(0, 0, cv.width, cv.height);
    return;
  }
  const me = state.players.find((p) => p.id === myId);
  const cam = me ? (view.get(me.id) || me) : { x: MAP.safe.x, y: MAP.safe.y };
  drawWorld(cam);

  const t = performance.now();
  if (deadUntil) $('#deathMsg').textContent = $('#deathMsg').textContent.split('.')[0] +
    `. ${Math.max(0, Math.ceil((deadUntil - t) / 1000))} saniye sonra köyde doğacaksın.`;

  if (me && t - lastHud > 80) {
    lastHud = t;
    const m = state.me;
    setBar('#hpb', me.hp, me.mh, `CAN ${me.hp} / ${me.mh}`);
    setBar('#mpb', m.mp, m.mm, `MANA ${m.mp} / ${m.mm}`);
    setBar('#xpb', m.xp, m.xpn, '');
    const c = CLASSES[me.c];
    setSkill('#skA', m.cd.atk, c.atkCd);
    setSkill('#skQ', m.cd.q, c.q.cd);
    setSkill('#skE', m.cd.e, c.e.cd);
    if (isTouch) {
      $('#tQ').textContent = m.cd.q > 0.05 ? Math.ceil(m.cd.q) : 'Q';
      $('#tE').textContent = m.cd.e > 0.05 ? Math.ceil(m.cd.e) : 'E';
    }
    $('#info').innerHTML = '';
    const lines = [
      `<b>${c.name}</b> · Seviye ${me.l}`,
      `Öldürme: ${m.k} · Ölüm: ${m.d}`,
      `Çevrimiçi: ${state.online}`,
      m.safe ? '<span class="zone" style="color:#8aff8a">● Güvenli Bölge</span>' : '<span class="zone" style="color:#ff6a5a">● PvP Bölgesi</span>',
    ];
    $('#info').innerHTML = lines.join('<br>');
    const bl = $('#boardList');
    bl.innerHTML = '';
    board.forEach((b, i) => {
      const d = document.createElement('div');
      const a = document.createElement('span'); a.textContent = `${i + 1}. ${b.n} (Sv.${b.l})`;
      const k = document.createElement('span'); k.textContent = `${b.k}/${b.d}`;
      d.append(a, k); bl.appendChild(d);
    });
    if (!isTouch) drawMinimap(me);
  }
}
requestAnimationFrame(frame);

// Uygulama gibi kurulabilmesi için (PWA)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// PvP Server - çok oyunculu PvP sunucusu
// Sunucu her şeyi kendisi hesaplar (hile koruması): istemci sadece tuşları gönderir.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK = 30; // saniyede 30 güncelleme
const DT = 1 / TICK;

// ---------------- HARİTA ----------------
const MAP = {
  w: 2400,
  h: 1600,
  safe: { x: 260, y: 800, r: 220 }, // köy: burada hasar yok
  rocks: [
    { x: 700, y: 400, r: 60 }, { x: 900, y: 1150, r: 80 }, { x: 1200, y: 700, r: 70 },
    { x: 1500, y: 300, r: 55 }, { x: 1650, y: 1000, r: 90 }, { x: 2000, y: 600, r: 65 },
    { x: 1950, y: 1350, r: 70 }, { x: 1250, y: 1400, r: 50 }, { x: 600, y: 1350, r: 55 },
    { x: 2200, y: 200, r: 50 }, { x: 1100, y: 250, r: 45 },
  ],
};

// ---------------- SINIFLAR ----------------
const CLASSES = {
  savasci: {
    name: 'Savaşçı', hp: 220, mp: 80, speed: 185, color: '#d9534f',
    atk: { type: 'melee', range: 78, arc: 1.5, dmg: 20, cd: 0.6 },
    q: { name: 'Hamle', mp: 25, cd: 5 },
    e: { name: 'Demir Kalkan', mp: 30, cd: 12 },
  },
  golge: {
    name: 'Gölge Avcı', hp: 150, mp: 90, speed: 225, color: '#9b59b6',
    atk: { type: 'melee', range: 64, arc: 1.2, dmg: 13, cd: 0.35 },
    q: { name: 'Zehirli Hançer', mp: 20, cd: 4 },
    e: { name: 'Gölge Örtüsü', mp: 35, cd: 14 },
  },
  buyucu: {
    name: 'Ruh Büyücüsü', hp: 130, mp: 140, speed: 180, color: '#3498db',
    atk: { type: 'proj', dmg: 15, cd: 0.55 },
    q: { name: 'Alev Küresi', mp: 35, cd: 6 },
    e: { name: 'Şifa Işığı', mp: 40, cd: 10 },
  },
};

const MAX_LEVEL = 30;
const PLAYER_R = 20;
const RESPAWN = 5;

const players = new Map(); // id -> oyuncu
const projectiles = [];
const dummies = [];
let events = [];
let nextId = 1;
let now = 0;

for (let i = 0; i < 4; i++) {
  dummies.push({
    id: 'd' + i, dummy: true, n: 'Antrenman Kuklası', x: 580, y: 560 + i * 160,
    hp: 300, mh: 300, dead: false, respawnAt: 0, lvl: 1,
  });
}

// ---------------- YARDIMCILAR ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inSafe = (o) => dist(o, MAP.safe) < MAP.safe.r;
const scale = (p) => 1 + 0.1 * (p.lvl - 1);
const dmgMul = (p) => 1 + 0.08 * (p.lvl - 1);
const xpNeed = (lvl) => 100 * lvl;

function spawnPoint() {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * (MAP.safe.r - 40);
  return { x: MAP.safe.x + Math.cos(a) * r, y: MAP.safe.y + Math.sin(a) * r };
}

function resolveCollisions(o, r) {
  for (const rock of MAP.rocks) {
    const d = dist(o, rock);
    const min = rock.r + r;
    if (d < min && d > 0) {
      o.x = rock.x + ((o.x - rock.x) / d) * min;
      o.y = rock.y + ((o.y - rock.y) / d) * min;
    }
  }
  o.x = clamp(o.x, r, MAP.w - r);
  o.y = clamp(o.y, r, MAP.h - r);
}

function allTargets() {
  const list = [];
  for (const p of players.values()) if (!p.dead) list.push(p);
  for (const d of dummies) if (!d.dead) list.push(d);
  return list;
}

function breakInvis(p) {
  if (p.invisUntil > now) p.invisUntil = 0;
}

function recalcStats(p) {
  const c = CLASSES[p.cls];
  p.mh = Math.round(c.hp * scale(p));
  p.mm = Math.round(c.mp * scale(p));
}

// ---------------- HASAR / ÖLÜM ----------------
function dealDamage(src, target, amount) {
  if (!target || target.dead) return;
  if (src === target) return;
  if (inSafe(target) || (src && !src.dummy && inSafe(src))) return;
  if (target.shieldUntil > now) amount *= 0.5;
  amount = Math.round(amount);
  target.hp -= amount;
  events.push({ t: 'dmg', x: Math.round(target.x), y: Math.round(target.y), v: amount });
  if (target.hp <= 0) kill(src, target);
}

function kill(src, target) {
  target.hp = 0;
  target.dead = true;
  target.respawnAt = now + RESPAWN;
  target.poison = null;
  if (target.dummy) {
    if (src) gainXp(src, 25);
    return;
  }
  target.deaths++;
  target.streak = 0;
  if (src && !src.dummy) {
    src.kills++;
    src.streak = (src.streak || 0) + 1;
    gainXp(src, 50 + 20 * target.lvl);
    events.push({ t: 'kill', k: src.n, v: target.n, s: src.streak });
    sendTo(target, { t: 'dead', by: src.n, in: RESPAWN });
  } else {
    events.push({ t: 'kill', k: '???', v: target.n, s: 0 });
    sendTo(target, { t: 'dead', by: 'bilinmeyen', in: RESPAWN });
  }
}

function gainXp(p, amount) {
  if (p.dummy || p.lvl >= MAX_LEVEL) return;
  p.xp += amount;
  while (p.xp >= xpNeed(p.lvl) && p.lvl < MAX_LEVEL) {
    p.xp -= xpNeed(p.lvl);
    p.lvl++;
    recalcStats(p);
    p.hp = p.mh;
    p.mp = p.mm;
    events.push({ t: 'lvl', id: p.id, l: p.lvl, n: p.n });
  }
}

// ---------------- SALDIRI / BECERİLER ----------------
function shoot(p, kind, dmg, speed, range, r) {
  projectiles.push({
    owner: p.id, kind, dmg, r,
    x: p.x + Math.cos(p.angle) * (PLAYER_R + 4),
    y: p.y + Math.sin(p.angle) * (PLAYER_R + 4),
    vx: Math.cos(p.angle) * speed, vy: Math.sin(p.angle) * speed,
    left: range,
  });
}

function basicAttack(p) {
  const c = CLASSES[p.cls];
  if (p.cd.atk > now) return;
  p.cd.atk = now + c.atk.cd;
  breakInvis(p);
  const dmg = c.atk.dmg * dmgMul(p);
  if (c.atk.type === 'melee') {
    events.push({ t: 'swing', id: p.id, a: +p.angle.toFixed(2), r: c.atk.range });
    for (const t of allTargets()) {
      if (t === p) continue;
      const d = dist(p, t);
      if (d > c.atk.range + PLAYER_R) continue;
      let diff = Math.atan2(t.y - p.y, t.x - p.x) - p.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (Math.abs(diff) <= c.atk.arc / 2) dealDamage(p, t, dmg);
    }
  } else {
    shoot(p, 'bolt', dmg, 560, 540, 7);
  }
}

function useSkill(p, key) {
  const c = CLASSES[p.cls];
  const s = c[key];
  if (!s || p.cd[key] > now || p.mp < s.mp) return;
  p.cd[key] = now + s.cd;
  p.mp -= s.mp;
  const m = dmgMul(p);

  if (p.cls === 'savasci' && key === 'q') {
    breakInvis(p);
    p.dash = { until: now + 0.2, vx: Math.cos(p.angle) * 1100, vy: Math.sin(p.angle) * 1100, hit: new Set(), dmg: 32 * m };
  } else if (p.cls === 'savasci' && key === 'e') {
    p.shieldUntil = now + 4;
  } else if (p.cls === 'golge' && key === 'q') {
    breakInvis(p);
    shoot(p, 'poison', 12 * m, 650, 460, 6);
  } else if (p.cls === 'golge' && key === 'e') {
    p.invisUntil = now + 4;
  } else if (p.cls === 'buyucu' && key === 'q') {
    shoot(p, 'fire', 34 * m, 420, 500, 13);
  } else if (p.cls === 'buyucu' && key === 'e') {
    p.hp = Math.min(p.mh, p.hp + Math.round(65 * scale(p)));
    events.push({ t: 'heal', x: Math.round(p.x), y: Math.round(p.y) });
  }
}

function explode(pr, owner) {
  events.push({ t: 'boom', x: Math.round(pr.x), y: Math.round(pr.y) });
  for (const t of allTargets()) {
    if (t.id === pr.owner) continue;
    if (dist(pr, t) < 95) dealDamage(owner, t, pr.dmg);
  }
}

// ---------------- OYUN DÖNGÜSÜ ----------------
function update() {
  now += DT;

  for (const p of players.values()) {
    if (p.dead) {
      if (now >= p.respawnAt) {
        Object.assign(p, spawnPoint(), { dead: false, hp: p.mh, mp: p.mm });
        sendTo(p, { t: 'respawn' });
      }
      continue;
    }
    const c = CLASSES[p.cls];
    const inp = p.input;
    p.angle = inp.angle;

    if (p.dash && p.dash.until > now) {
      p.x += p.dash.vx * DT;
      p.y += p.dash.vy * DT;
      for (const t of allTargets()) {
        if (t === p || p.dash.hit.has(t.id)) continue;
        if (dist(p, t) < PLAYER_R * 2 + 10) {
          p.dash.hit.add(t.id);
          dealDamage(p, t, p.dash.dmg);
        }
      }
    } else {
      p.dash = null;
      let mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      let my = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
      const len = Math.hypot(mx, my);
      if (len) {
        p.x += (mx / len) * c.speed * DT;
        p.y += (my / len) * c.speed * DT;
      }
    }
    resolveCollisions(p, PLAYER_R);

    if (inp.atk) basicAttack(p);

    // yenilenme (köyde daha hızlı)
    const regen = inSafe(p) ? 4 : 1;
    p.mp = Math.min(p.mm, p.mp + 6 * regen * DT);
    p.hp = Math.min(p.mh, p.hp + (inSafe(p) ? 15 : 1) * DT);

    // zehir
    if (p.poison) {
      if (p.poison.until < now) p.poison = null;
      else {
        p.poison.acc += p.poison.dps * DT;
        if (p.poison.acc >= 4) {
          const src = players.get(p.poison.src);
          dealDamage(src, p, p.poison.acc);
          if (p.poison) p.poison.acc = 0;
        }
      }
    }
  }

  // mermiler
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx * DT;
    pr.y += pr.vy * DT;
    pr.left -= Math.hypot(pr.vx, pr.vy) * DT;
    const owner = players.get(pr.owner);
    let done = pr.left <= 0 || pr.x < 0 || pr.y < 0 || pr.x > MAP.w || pr.y > MAP.h;
    if (!done && MAP.rocks.some((r) => dist(pr, r) < r.r + pr.r)) done = true;
    if (!done) {
      for (const t of allTargets()) {
        if (t.id === pr.owner) continue;
        if (dist(pr, t) < PLAYER_R + pr.r) {
          if (pr.kind === 'fire') { /* patlama aşağıda */ }
          else dealDamage(owner, t, pr.dmg);
          if (pr.kind === 'poison' && !t.dummy && !t.dead && !inSafe(t)) {
            t.poison = { until: now + 4, dps: 8 * (owner ? dmgMul(owner) : 1), src: pr.owner, acc: 0 };
          }
          done = true;
          break;
        }
      }
    }
    if (done) {
      if (pr.kind === 'fire') explode(pr, owner);
      projectiles.splice(i, 1);
    }
  }

  // kuklalar yeniden doğar
  for (const d of dummies) {
    if (d.dead && now >= d.respawnAt) { d.dead = false; d.hp = d.mh; }
    else if (!d.dead) d.hp = Math.min(d.mh, d.hp + 10 * DT);
  }

  broadcast();
}

// ---------------- AĞ ----------------
function sendTo(p, msg) {
  if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

let tickCount = 0;
function broadcast() {
  tickCount++;
  const projData = projectiles.map((p) => [Math.round(p.x), Math.round(p.y), p.kind]);
  const dumData = dummies.map((d) => ({ id: d.id, x: d.x, y: d.y, hp: Math.round(d.hp), mh: d.mh, dead: d.dead }));
  let board = null;
  if (tickCount % 15 === 0) {
    board = [...players.values()]
      .sort((a, b) => b.kills - a.kills || b.lvl - a.lvl)
      .slice(0, 5)
      .map((p) => ({ n: p.n, k: p.kills, d: p.deaths, l: p.lvl }));
  }
  const evs = events;
  events = [];
  const pub = (p) => ({
    id: p.id, n: p.n, c: p.cls, x: Math.round(p.x), y: Math.round(p.y), a: +p.angle.toFixed(2),
    hp: Math.round(p.hp), mh: p.mh, l: p.lvl, dead: p.dead, sh: p.shieldUntil > now,
    iv: p.invisUntil > now, ps: !!p.poison,
  });
  const pubList = [...players.values()].map((p) => [p, pub(p)]);

  for (const me of players.values()) {
    const list = pubList.filter(([p]) => p === me || !(p.invisUntil > now)).map(([, d]) => d);
    const msg = {
      t: 'state', players: list, proj: projData, dummies: dumData, ev: evs,
      me: {
        mp: Math.round(me.mp), mm: me.mm, xp: me.xp, xpn: xpNeed(me.lvl), k: me.kills, d: me.deaths,
        cd: {
          atk: Math.max(0, me.cd.atk - now), q: Math.max(0, me.cd.q - now), e: Math.max(0, me.cd.e - now),
        },
        safe: inSafe(me),
      },
      online: players.size,
    };
    if (board) msg.board = board;
    sendTo(me, msg);
  }
}

// ---------------- HTTP + WEBSOCKET ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !me) {
      const cls = CLASSES[m.cls] ? m.cls : 'savasci';
      const name = String(m.name || '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 14) || 'Oyuncu' + nextId;
      me = {
        id: nextId++, ws, n: name, cls, lvl: 1, xp: 0, kills: 0, deaths: 0, streak: 0,
        angle: 0, dead: false, cd: { atk: 0, q: 0, e: 0 }, shieldUntil: 0, invisUntil: 0, poison: null,
        input: { up: false, down: false, left: false, right: false, atk: false, angle: 0 },
        ...spawnPoint(),
      };
      recalcStats(me);
      me.hp = me.mh;
      me.mp = me.mm;
      players.set(me.id, me);
      const classInfo = {};
      for (const [k, c] of Object.entries(CLASSES)) {
        classInfo[k] = { name: c.name, color: c.color, q: c.q, e: c.e, atkCd: c.atk.cd };
      }
      sendTo(me, { t: 'welcome', id: me.id, map: MAP, classes: classInfo });
      events.push({ t: 'sys', msg: `${me.n} oyuna katıldı (${CLASSES[cls].name})` });
      return;
    }
    if (!me) return;

    if (m.t === 'input') {
      const i = me.input;
      i.up = !!m.up; i.down = !!m.down; i.left = !!m.left; i.right = !!m.right; i.atk = !!m.atk;
      if (Number.isFinite(m.angle)) i.angle = m.angle;
    } else if (m.t === 'skill' && !me.dead && (m.k === 'q' || m.k === 'e')) {
      useSkill(me, m.k);
    } else if (m.t === 'chat') {
      const now2 = Date.now();
      if (me.lastChat && now2 - me.lastChat < 800) return; // spam koruması
      me.lastChat = now2;
      const msg = String(m.msg || '').trim().slice(0, 120);
      if (msg) events.push({ t: 'chat', n: me.n, msg });
    }
  });
  ws.on('close', () => {
    if (me) {
      players.delete(me.id);
      events.push({ t: 'sys', msg: `${me.n} oyundan ayrıldı` });
    }
  });
});

setInterval(update, 1000 / TICK);
server.listen(PORT, () => console.log(`PvP Server çalışıyor: http://localhost:${PORT}`));

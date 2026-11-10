// PvP Server - çok oyunculu PvP sunucusu
// Sunucu her şeyi kendisi hesaplar (hile koruması): istemci sadece tuşları gönderir.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const TICK = 30; // saniyede 30 güncelleme
const DT = 1 / TICK;
const MAX_CHARS = 3;

// ---------------- KRALLIKLAR ----------------
const FACTIONS = {
  kizil: { name: 'Kızıl Ejder Krallığı', short: 'Kızıl Ejder', color: '#e04a3a', village: { x: 450, y: 450 } },
  gok: { name: 'Gök Kaplan Krallığı', short: 'Gök Kaplan', color: '#3a8de0', village: { x: 2550, y: 450 } },
  yesim: { name: 'Yeşim Turna Krallığı', short: 'Yeşim Turna', color: '#3ac06a', village: { x: 1500, y: 1950 } },
};

// ---------------- HARİTA ----------------
const VILLAGE_R = 230;
const MAP = {
  w: 3000,
  h: 2400,
  villages: Object.entries(FACTIONS).map(([f, d]) => ({ f, x: d.village.x, y: d.village.y, r: VILLAGE_R })),
  rocks: [
    { x: 1000, y: 700, r: 70 }, { x: 1500, y: 500, r: 60 }, { x: 2000, y: 700, r: 70 },
    { x: 1200, y: 1200, r: 90 }, { x: 1800, y: 1200, r: 80 }, { x: 1500, y: 900, r: 50 },
    { x: 800, y: 1400, r: 60 }, { x: 2200, y: 1400, r: 60 }, { x: 1000, y: 1900, r: 55 },
    { x: 2000, y: 1900, r: 55 }, { x: 400, y: 1300, r: 70 }, { x: 2600, y: 1300, r: 70 },
    { x: 1500, y: 1450, r: 65 }, { x: 700, y: 2100, r: 50 }, { x: 2300, y: 2100, r: 50 },
    { x: 1500, y: 150, r: 45 },
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

const players = new Map(); // id -> oyuncu (oyunda olan karakterler)
const projectiles = [];
const dummies = [];
let events = [];
let nextId = 1;
let now = 0;

const dummySpots = [
  [750, 450], [700, 620], [560, 720], // Kızıl Ejder köyü yanı
  [2250, 450], [2300, 620], [2440, 720], // Gök Kaplan köyü yanı
  [1300, 1700], [1500, 1660], [1700, 1700], // Yeşim Turna köyü yanı
];
dummySpots.forEach(([x, y], i) => {
  dummies.push({ id: 'd' + i, dummy: true, n: 'Antrenman Kuklası', x, y, hp: 300, mh: 300, dead: false, respawnAt: 0, lvl: 1 });
});

// ---------------- YARDIMCILAR ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inSafe = (o) => MAP.villages.some((v) => dist(o, v) < v.r);
const scale = (p) => 1 + 0.1 * (p.lvl - 1);
const dmgMul = (p) => 1 + 0.08 * (p.lvl - 1);
const xpNeed = (lvl) => 100 * lvl;

function spawnPoint(faction) {
  const v = FACTIONS[faction].village;
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * (VILLAGE_R - 50);
  return { x: v.x + Math.cos(a) * r, y: v.y + Math.sin(a) * r };
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

// Aynı krallıktan oyuncular birbirine vuramaz.
function canHurt(src, t) {
  if (!t || t.dead || src === t) return false;
  if (src && !src.dummy && !t.dummy && src.f === t.f) return false;
  return true;
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
  if (!canHurt(src, target)) return;
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
  target.dirty = true;
  if (src && !src.dummy) {
    src.kills++;
    src.streak = (src.streak || 0) + 1;
    src.dirty = true;
    gainXp(src, 50 + 20 * target.lvl);
    events.push({ t: 'kill', k: src.n, kf: src.f, v: target.n, vf: target.f, s: src.streak });
    sendTo(target, { t: 'dead', by: src.n, in: RESPAWN });
  } else {
    events.push({ t: 'kill', k: '???', v: target.n, vf: target.f, s: 0 });
    sendTo(target, { t: 'dead', by: 'bilinmeyen', in: RESPAWN });
  }
}

function gainXp(p, amount) {
  if (p.dummy || p.lvl >= MAX_LEVEL) return;
  p.xp += amount;
  p.dirty = true;
  while (p.xp >= xpNeed(p.lvl) && p.lvl < MAX_LEVEL) {
    p.xp -= xpNeed(p.lvl);
    p.lvl++;
    recalcStats(p);
    p.hp = p.mh;
    p.mp = p.mm;
    events.push({ t: 'lvl', id: p.id, l: p.lvl, n: p.n });
    saveChar(p);
  }
  if (p.lvl >= MAX_LEVEL) p.xp = 0;
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
      if (!canHurt(p, t)) continue;
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
        Object.assign(p, spawnPoint(p.f), { dead: false, hp: p.mh, mp: p.mm });
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
        if (!canHurt(p, t) || p.dash.hit.has(t.id)) continue;
        if (dist(p, t) < PLAYER_R * 2 + 10) {
          p.dash.hit.add(t.id);
          dealDamage(p, t, p.dash.dmg);
        }
      }
    } else {
      p.dash = null;
      const mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      const my = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
      const len = Math.hypot(mx, my);
      if (len) {
        p.x += (mx / len) * c.speed * DT;
        p.y += (my / len) * c.speed * DT;
      }
    }
    resolveCollisions(p, PLAYER_R);

    if (inp.atk) basicAttack(p);

    // yenilenme (köyde daha hızlı)
    const safe = inSafe(p);
    p.mp = Math.min(p.mm, p.mp + 6 * (safe ? 4 : 1) * DT);
    p.hp = Math.min(p.mh, p.hp + (safe ? 15 : 1) * DT);

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
        if (owner && !canHurt(owner, t)) continue; // dost oyuncunun içinden geçer
        if (dist(pr, t) < PLAYER_R + pr.r) {
          if (pr.kind !== 'fire') dealDamage(owner, t, pr.dmg);
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
  const ws = p.ws || p;
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
      .map((p) => ({ n: p.n, k: p.kills, d: p.deaths, l: p.lvl, f: p.f }));
  }
  const evs = events;
  events = [];
  const pub = (p) => ({
    id: p.id, n: p.n, c: p.cls, f: p.f, x: Math.round(p.x), y: Math.round(p.y), a: +p.angle.toFixed(2),
    hp: Math.round(p.hp), mh: p.mh, l: p.lvl, dead: p.dead, sh: p.shieldUntil > now,
    iv: p.invisUntil > now, ps: !!p.poison,
  });
  const pubList = [...players.values()].map((p) => [p, pub(p)]);

  for (const me of players.values()) {
    // görünmez oyuncular sadece kendine ve kendi krallığına görünür
    const list = pubList.filter(([p]) => p === me || p.f === me.f || !(p.invisUntil > now)).map(([, d]) => d);
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

// ---------------- HESAP SİSTEMİ ----------------
const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;
const NAME_RE = /^[\p{L}\p{N}_]{3,14}$/u;

async function hashPass(pass, salt) {
  return (await scrypt(pass, salt, 32)).toString('hex');
}

function charSummary(c) {
  return { id: c.id, name: c.name, cls: c.cls, f: c.faction, lvl: c.lvl, kills: c.kills };
}

async function loadChars(acc) {
  const list = [];
  for (const id of acc.chars) {
    const c = await db.get('char:' + id);
    if (c) list.push(charSummary(c));
  }
  return list;
}

async function newToken(acc) {
  const token = crypto.randomBytes(24).toString('hex');
  const all = [...(acc.tokens || []), token];
  const old = all.slice(0, -5); // en fazla 5 cihazda açık oturum
  acc.tokens = all.slice(-5);
  await db.set('tok:' + token, acc.user.toLowerCase());
  await db.set('acc:' + acc.user.toLowerCase(), acc);
  for (const t of old) await db.del('tok:' + t);
  return token;
}

async function sendAccount(conn, token) {
  conn.send({
    t: 'account', user: conn.acc.user, faction: conn.acc.faction, token,
    chars: await loadChars(conn.acc), max: MAX_CHARS,
  });
}

function saveChar(p) {
  p.dirty = false;
  return db.set('char:' + p.charId, {
    id: p.charId, owner: p.owner, name: p.n, cls: p.cls, faction: p.f,
    lvl: p.lvl, xp: p.xp, kills: p.kills, deaths: p.deaths, created: p.created,
  }).catch((e) => console.error('Kayıt hatası:', e.message));
}

// periyodik kayıt
setInterval(() => {
  for (const p of players.values()) if (p.dirty) saveChar(p);
}, 15000);

const handlers = {
  async register(conn, m) {
    const user = String(m.user || '');
    const pass = String(m.pass || '');
    if (!USER_RE.test(user)) return conn.err('Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _).');
    if (pass.length < 6 || pass.length > 64) return conn.err('Şifre en az 6 karakter olmalı.');
    const salt = crypto.randomBytes(16).toString('hex');
    const acc = { user, salt, hash: await hashPass(pass, salt), faction: null, chars: [], tokens: [], created: Date.now() };
    if (!(await db.claim('acc:' + user.toLowerCase(), acc))) return conn.err('Bu kullanıcı adı alınmış.');
    conn.acc = acc;
    await sendAccount(conn, await newToken(acc));
  },

  async login(conn, m) {
    if (conn.fails >= 5) return conn.err('Çok fazla hatalı deneme. Biraz bekle.');
    const user = String(m.user || '');
    const acc = USER_RE.test(user) ? await db.get('acc:' + user.toLowerCase()) : null;
    const ok = acc && crypto.timingSafeEqual(Buffer.from(await hashPass(String(m.pass || ''), acc.salt), 'hex'), Buffer.from(acc.hash, 'hex'));
    if (!ok) {
      conn.fails = (conn.fails || 0) + 1;
      if (conn.fails >= 5) setTimeout(() => { conn.fails = 0; }, 30000);
      return conn.err('Kullanıcı adı veya şifre yanlış.');
    }
    conn.acc = acc;
    await sendAccount(conn, await newToken(acc));
  },

  async token(conn, m) {
    const userKey = await db.get('tok:' + String(m.token || '').slice(0, 64));
    const acc = userKey && (await db.get('acc:' + userKey));
    if (!acc || !(acc.tokens || []).includes(m.token)) return conn.send({ t: 'tokenBad' });
    conn.acc = acc;
    await sendAccount(conn, m.token);
  },

  async logout(conn, m) {
    if (!conn.acc) return;
    const t = String(m.token || '');
    conn.acc.tokens = (conn.acc.tokens || []).filter((x) => x !== t);
    await db.set('acc:' + conn.acc.user.toLowerCase(), conn.acc);
    await db.del('tok:' + t);
    conn.acc = null;
  },

  async create(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me) return;
    acc.chars = acc.chars || [];
    if (acc.chars.length >= MAX_CHARS) return conn.err(`En fazla ${MAX_CHARS} karakter açabilirsin.`);
    const name = String(m.name || '').trim();
    if (!NAME_RE.test(name)) return conn.err('Karakter adı 3-14 karakter olmalı (harf, rakam, _).');
    if (!CLASSES[m.cls]) return conn.err('Geçersiz sınıf.');
    const faction = acc.faction || m.faction;
    if (!FACTIONS[faction]) return conn.err('Bir krallık seç.');
    const id = crypto.randomBytes(8).toString('hex');
    if (!(await db.claim('name:' + name.toLowerCase(), id))) return conn.err('Bu karakter adı alınmış.');
    const c = { id, owner: acc.user.toLowerCase(), name, cls: m.cls, faction, lvl: 1, xp: 0, kills: 0, deaths: 0, created: Date.now() };
    await db.set('char:' + id, c);
    acc.faction = faction; // hesabın krallığı ilk karakterde belirlenir
    acc.chars.push(id);
    await db.set('acc:' + acc.user.toLowerCase(), acc);
    await sendAccount(conn);
  },

  async remove(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me || !acc.chars.includes(m.id)) return;
    const c = await db.get('char:' + m.id);
    if ([...players.values()].some((p) => p.charId === m.id)) return conn.err('Bu karakter şu an oyunda.');
    acc.chars = acc.chars.filter((x) => x !== m.id);
    if (acc.chars.length === 0) acc.faction = null; // hiç karakter kalmazsa krallık yeniden seçilebilir
    await db.set('acc:' + acc.user.toLowerCase(), acc);
    if (c) { await db.del('char:' + m.id); await db.del('name:' + c.name.toLowerCase()); }
    await sendAccount(conn);
  },

  async play(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me || !acc.chars.includes(m.id)) return;
    const c = await db.get('char:' + m.id);
    if (!c) return conn.err('Karakter bulunamadı.');
    // aynı hesap başka yerde oyundaysa onu çıkar
    for (const p of players.values()) {
      if (p.owner === acc.user.toLowerCase()) {
        sendTo(p, { t: 'kicked', msg: 'Hesabına başka bir yerden girildi.' });
        p.ws.close();
        removePlayer(p);
      }
    }
    const me = {
      id: nextId++, ws: conn.ws, charId: c.id, owner: c.owner, n: c.name, cls: c.cls, f: c.faction,
      lvl: c.lvl, xp: c.xp, kills: c.kills, deaths: c.deaths, created: c.created, streak: 0,
      angle: 0, dead: false, cd: { atk: 0, q: 0, e: 0 }, shieldUntil: 0, invisUntil: 0, poison: null, dirty: false,
      input: { up: false, down: false, left: false, right: false, atk: false, angle: 0 },
      ...spawnPoint(c.faction),
    };
    recalcStats(me);
    me.hp = me.mh;
    me.mp = me.mm;
    conn.me = me;
    players.set(me.id, me);
    const classInfo = {};
    for (const [k, cl] of Object.entries(CLASSES)) {
      classInfo[k] = { name: cl.name, color: cl.color, q: cl.q, e: cl.e, atkCd: cl.atk.cd };
    }
    const factionInfo = {};
    for (const [k, f] of Object.entries(FACTIONS)) factionInfo[k] = { name: f.name, short: f.short, color: f.color };
    conn.send({ t: 'welcome', id: me.id, map: MAP, classes: classInfo, factions: factionInfo, me: { f: me.f, cls: me.cls } });
    events.push({ t: 'sys', msg: `${me.n} oyuna katıldı (${FACTIONS[me.f].short} · ${CLASSES[me.cls].name})` });
  },

  async leave(conn) {
    if (!conn.me) return;
    removePlayer(conn.me);
    conn.me = null;
    await sendAccount(conn);
  },
};

function removePlayer(p) {
  if (!players.has(p.id)) return;
  players.delete(p.id);
  saveChar(p);
  events.push({ t: 'sys', msg: `${p.n} oyundan ayrıldı` });
}

// ---------------- HTTP + WEBSOCKET ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  const conn = {
    ws, acc: null, me: null, fails: 0, busy: false,
    send: (msg) => sendTo(ws, msg),
    err: (msg) => sendTo(ws, { t: 'error', msg }),
  };

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const me = conn.me;

    // oyun içi mesajlar (hızlı yol)
    if (me && players.has(me.id)) {
      if (m.t === 'input') {
        const i = me.input;
        i.up = !!m.up; i.down = !!m.down; i.left = !!m.left; i.right = !!m.right; i.atk = !!m.atk;
        if (Number.isFinite(m.angle)) i.angle = m.angle;
        return;
      }
      if (m.t === 'skill') {
        if (!me.dead && (m.k === 'q' || m.k === 'e')) useSkill(me, m.k);
        return;
      }
      if (m.t === 'chat') {
        const t = Date.now();
        if (me.lastChat && t - me.lastChat < 800) return; // spam koruması
        me.lastChat = t;
        const msg = String(m.msg || '').trim().slice(0, 120);
        if (msg) events.push({ t: 'chat', n: me.n, f: me.f, msg });
        return;
      }
    }

    // hesap işlemleri (sırayla, aynı anda bir tane)
    const h = handlers[m.t];
    if (!h || conn.busy) return;
    conn.busy = true;
    try { await h(conn, m); } catch (e) { console.error(e); conn.err('Sunucu hatası, tekrar dene.'); }
    conn.busy = false;
  });

  ws.on('close', () => {
    if (conn.me) removePlayer(conn.me);
  });
});

setInterval(update, 1000 / TICK);

function shutdown() {
  Promise.all([...players.values()].map(saveChar)).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`PvP Server çalışıyor: http://localhost:${PORT} · veritabanı: ${db.kind}`));

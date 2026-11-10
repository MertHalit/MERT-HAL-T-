// PvP Server - yetkili (authoritative) oyun sunucusu
// Bütün oyun kuralları burada hesaplanır; istemci sadece tuş bilgisi gönderir.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { SpatialGrid } = require('./aoi');
const { ActionGate, CheatMonitor, auditMove } = require('./anticheat');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const TICK = 30; // simülasyon: saniyede 30 adım
const DT = 1 / TICK;
const SEND_EVERY = 2; // ağ: her 2 adımda bir gönder (saniyede 15 paket)
const MAX_CHARS = 3;

// Görüş alanı: oyuncuya sadece bu yarıçaptaki varlıklar gönderilir (20 px = 1 metre → 55 m).
const VIEW_R = 1100;
const CELL = 256;
const grid = new SpatialGrid(CELL);

// ---------------- KRALLIKLAR ----------------
const FACTIONS = {
  kizil: { name: 'Kızıl Ejder Krallığı', short: 'Kızıl Ejder', color: '#e04a3a', village: { x: 450, y: 450 } },
  gok: { name: 'Gök Kaplan Krallığı', short: 'Gök Kaplan', color: '#3a8de0', village: { x: 2550, y: 450 } },
  yesim: { name: 'Yeşim Turna Krallığı', short: 'Yeşim Turna', color: '#3ac06a', village: { x: 1500, y: 1950 } },
};

// ---------------- HARİTA ----------------
const VILLAGE_R = 230;
const MAP = {
  id: 1,
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

// ---------------- SINIFLAR VE BECERİLER ----------------
// Her beceri: ad, mana, bekleme süresi, açıklama ve sunucuda çalışan cast() fonksiyonu.
// (Unreal GAS'taki GameplayAbility mantığı: maliyet + bekleme süresi + etkiler + etiketler.)
const CLASSES = {
  savasci: {
    name: 'Savaşçı', hp: 230, mp: 90, speed: 185, color: '#d9534f', stats: { str: 8, dex: 4, int: 2, vit: 6 },
    atk: { type: 'melee', range: 78, arc: 1.6, dmg: 20, cd: 0.6 },
    skills: {
      q: { name: 'Kılıç Kasırgası', mp: 30, cd: 7, desc: '360° üç vuruşlu dönüş, son vuruş geri savurur', cast: (p, m) => spinCombo(p, m) },
      e: { name: 'Öfke Aurası', mp: 25, cd: 25, desc: '12 sn boyunca +%30 saldırı gücü', cast: (p) => buff(p, p, 'atk', 12, { atk: 0.3 }) },
      r: { name: 'Hamle', mp: 25, cd: 6, desc: 'İleri atılır, çarptıklarını sersemletir', cast: (p, m) => dash(p, p.angle, 0.2, { dmg: 30 * m, kb: 320, stun: 0.5 }) },
      f: { name: 'Demir Kalkan', mp: 30, cd: 14, desc: '4 sn boyunca %50 az hasar', cast: (p) => buff(p, p, 'sh', 4, { taken: -0.5 }) },
    },
  },
  golge: {
    name: 'Gölge Avcı', hp: 160, mp: 100, speed: 225, color: '#9b59b6', stats: { str: 5, dex: 9, int: 2, vit: 4 },
    atk: { type: 'melee', range: 64, arc: 1.2, dmg: 13, cd: 0.35 },
    skills: {
      q: { name: 'Zehirli Hançer', mp: 20, cd: 4, desc: 'Fırlatılan hançer, 4 sn zehirler', cast: (p, m) => shoot(p, 'poison', 12 * m, 650, 460, 6) },
      e: { name: 'Gölge Örtüsü', mp: 35, cd: 16, desc: '5 sn görünmezlik; ilk vuruş ×1.5', cast: (p) => { buff(p, p, 'iv', 5, {}); p.ambush = true; } },
      r: { name: 'Sinsi Darbe', mp: 25, cd: 6, desc: 'Güçlü darbe; hedefin arkasındaysan ×2.5', cast: (p, m) => backstab(p, m) },
      f: { name: 'Geri Sıçrama', mp: 15, cd: 8, desc: 'Geriye doğru hızla sıçrar', cast: (p) => dash(p, p.angle + Math.PI, 0.16, null) },
    },
  },
  buyucu: {
    name: 'Ruh Kılıcı', hp: 190, mp: 120, speed: 190, color: '#3498db', stats: { str: 6, dex: 4, int: 6, vit: 5 },
    atk: { type: 'melee', range: 74, arc: 1.4, dmg: 17, cd: 0.55 },
    skills: {
      q: { name: 'Ruh Kılıcı', mp: 30, cd: 30, desc: '25 sn: verdiğin hasarın %12\'si cana döner', cast: (p) => buff(p, p, 'ls', 25, { lifesteal: 0.12 }) },
      e: { name: 'Alev Küresi', mp: 35, cd: 6, desc: 'Çarpınca patlayan alan hasarı', cast: (p, m) => shoot(p, 'fire', 32 * m, 420, 500, 13) },
      r: { name: 'Kara Dalga', mp: 30, cd: 8, desc: 'Öndeki koniye hasar ve güçlü geri savurma', cast: (p, m) => wave(p, m) },
      f: { name: 'Şifa Işığı', mp: 40, cd: 12, desc: 'Kendi canını yeniler', cast: (p) => heal(p, p, 70) },
    },
  },
  saman: {
    name: 'Şaman', hp: 150, mp: 150, speed: 195, color: '#1abc9c', stats: { str: 2, dex: 4, int: 9, vit: 5 },
    atk: { type: 'proj', dmg: 13, cd: 0.55, kind: 'spirit' },
    skills: {
      q: { name: 'Şimşek', mp: 25, cd: 5, desc: 'Hızlı yıldırım; vurduğunu 0.8 sn sersemletir', cast: (p, m) => shoot(p, 'light', 24 * m, 950, 520, 7, { stun: 0.8 }) },
      e: { name: 'Turna Kutsaması', mp: 40, cd: 30, desc: 'Yakındaki dostlara 20 sn +%25 kritik şansı', cast: (p) => allies(p, 320).forEach((a) => buff(p, a, 'crit', 20, { crit: 0.25 })) },
      r: { name: 'Şifa Yağmuru', mp: 45, cd: 14, desc: 'Yakındaki dostların canını yeniler', cast: (p) => allies(p, 280).forEach((a) => heal(p, a, 55)) },
      f: { name: 'Rüzgâr Adımı', mp: 30, cd: 18, desc: 'Yakındaki dostlara 6 sn +%30 hız', cast: (p) => allies(p, 280).forEach((a) => buff(p, a, 'spd', 6, { speed: 0.3 })) },
    },
  },
};
const SKILL_KEYS = ['q', 'e', 'r', 'f'];
const DASH_SPEED = 1100;

const MAX_LEVEL = 30;
const PLAYER_R = 20;
const RESPAWN = 5;
const BASE_CRIT = 0.05;
const CRIT_MUL = 1.6;
const PVP_KB = 0.5; // oyunculara uygulanan geri savurma oranı (canavarlara tam uygulanacak)

const players = new Map(); // id -> oyuncu (oyundaki karakterler)
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
  const d = {
    id: 'd' + i, dummy: true, n: 'Antrenman Kuklası', x, y, hp: 400, mh: 400, dead: false, respawnAt: 0, lvl: 1,
    angle: Math.PI / 2, stunUntil: 0, effects: [],
  };
  dummies.push(d);
  grid.insert(d);
});

// ---------------- YARDIMCILAR ----------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inSafe = (o) => MAP.villages.some((v) => dist(o, v) < v.r);
const scale = (p) => 1 + 0.1 * (p.lvl - 1);
const dmgMul = (p) => 1 + 0.08 * (p.lvl - 1);
const xpNeed = (lvl) => 100 * lvl;
const inRock = (o, r) => MAP.rocks.some((k) => dist(o, k) < k.r + r);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

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

// Izgarayı kullanarak sadece yakındaki canlı hedefleri getirir.
function targetsNear(x, y, r) {
  return grid.query(x, y, r + PLAYER_R, (e) => !e.dead);
}

// Aynı krallıktan oyuncular birbirine vuramaz.
function canHurt(src, t) {
  if (!t || t.dead || src === t) return false;
  if (src && !src.dummy && !t.dummy && src.f === t.f) return false;
  return true;
}

// Yakındaki dost oyuncular (kendisi dahil) - "parti" sistemi gelene kadar aynı krallıktakiler
function allies(p, r) {
  return grid.query(p.x, p.y, r, (e) => !e.dummy && !e.dead && e.f === p.f);
}

// ---------------- ETKİLER (BUFF / DEBUFF) ----------------
// Etki = { id, until, mods }  →  mods: atk, taken, crit, speed, lifesteal (oran olarak)
function buff(src, target, id, duration, mods) {
  target.effects = target.effects.filter((e) => e.id !== id); // aynı etki üst üste binmez, süresi yenilenir
  target.effects.push({ id, until: now + duration, mods, dur: duration });
  events.push({ t: 'buff', id: target.id, b: id, x: Math.round(target.x), y: Math.round(target.y) });
}
function mod(p, key) {
  let s = 0;
  for (const e of p.effects) if (e.until > now && e.mods[key]) s += e.mods[key];
  return s;
}
const hasFx = (p, id) => p.effects.some((e) => e.id === id && e.until > now);
const isStunned = (p) => p.stunUntil > now;
function clearFx(p, id) { p.effects = p.effects.filter((e) => e.id !== id); }

function breakInvis(p) {
  if (hasFx(p, 'iv')) clearFx(p, 'iv');
}

function recalcStats(p) {
  const c = CLASSES[p.cls];
  p.mh = Math.round(c.hp * scale(p) * (1 + (p.stats.vit - 5) * 0.02));
  p.mm = Math.round(c.mp * scale(p) * (1 + (p.stats.int - 5) * 0.02));
  p.crit = BASE_CRIT + p.stats.dex * 0.004;
}

function heal(src, target, base) {
  const amount = Math.round(base * scale(src));
  target.hp = Math.min(target.mh, target.hp + amount);
  events.push({ t: 'heal', x: Math.round(target.x), y: Math.round(target.y), v: amount });
}

// ---------------- HASAR / ÖLÜM ----------------
// opts: { kb: geri savurma gücü, stun: sersemletme süresi, from: savurma merkezi, mul: ek çarpan, noCrit }
function dealDamage(src, target, amount, opts = {}) {
  if (!canHurt(src, target)) return 0;
  if (inSafe(target) || (src && !src.dummy && inSafe(src))) return 0;
  let crit = false;
  if (src && !src.dummy) {
    amount *= 1 + mod(src, 'atk');
    if (opts.mul) amount *= opts.mul;
    if (src.ambush) { amount *= 1.5; src.ambush = false; } // gölgeden çıkan ilk vuruş
    if (!opts.noCrit && Math.random() < src.crit + mod(src, 'crit')) { amount *= CRIT_MUL; crit = true; }
  }
  amount *= Math.max(0.1, 1 + mod(target, 'taken'));
  amount = Math.max(1, Math.round(amount));
  target.hp -= amount;
  events.push({ t: 'dmg', x: Math.round(target.x), y: Math.round(target.y), v: amount, c: crit ? 1 : 0, bs: opts.bs ? 1 : 0 });

  // can çalma (Ruh Kılıcı aurası)
  if (src && !src.dummy && !src.dead) {
    const ls = mod(src, 'lifesteal');
    if (ls > 0) src.hp = Math.min(src.mh, src.hp + amount * ls);
  }
  // geri savurma + sersemletme
  if (opts.kb && !target.dummy) {
    const from = opts.from || src;
    const d = dist(from, target) || 1;
    const k = opts.kb * PVP_KB;
    target.kb = { vx: ((target.x - from.x) / d) * k, vy: ((target.y - from.y) / d) * k };
  }
  if (opts.stun) {
    target.stunUntil = Math.max(target.stunUntil || 0, now + (target.dummy ? opts.stun : opts.stun * 0.7));
    if (!target.dummy) target.dash = null;
  }
  if (target.hp <= 0) kill(src, target);
  return amount;
}

function kill(src, target) {
  target.hp = 0;
  target.dead = true;
  target.respawnAt = now + RESPAWN;
  target.poison = null;
  target.effects = [];
  target.kb = null;
  target.timers = [];
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
    p.statPoints += 3;
    recalcStats(p);
    p.hp = p.mh;
    p.mp = p.mm;
    events.push({ t: 'lvl', id: p.id, l: p.lvl, n: p.n, x: Math.round(p.x), y: Math.round(p.y) });
    saveChar(p);
  }
  if (p.lvl >= MAX_LEVEL) p.xp = 0;
}

// ---------------- VURUŞ TESPİTİ (hedef seçmeden) ----------------
// Koni: karakterin baktığı yönde, 'range' uzunluğunda ve 'arc' açısında alan.
function hitCone(p, range, arc, fn) {
  let n = 0;
  for (const t of targetsNear(p.x, p.y, range)) {
    if (!canHurt(p, t) || dist(p, t) > range + PLAYER_R) continue;
    if (Math.abs(angleDiff(Math.atan2(t.y - p.y, t.x - p.x), p.angle)) <= arc / 2) { fn(t); n++; }
  }
  return n;
}
// Daire: karakterin etrafında 360°.
function hitCircle(cx, cy, src, r, fn) {
  for (const t of targetsNear(cx, cy, r)) {
    if (canHurt(src, t) && Math.hypot(t.x - cx, t.y - cy) <= r + PLAYER_R) fn(t);
  }
}
// Saldıran, hedefin arkasında mı? (hedefin baktığı yön ile hedef→saldıran yönü arasındaki açı > 110°)
function isBehind(attacker, target) {
  const toAtt = Math.atan2(attacker.y - target.y, attacker.x - target.x);
  return Math.abs(angleDiff(toAtt, target.angle)) > (110 * Math.PI) / 180;
}

// ---------------- SALDIRI / BECERİLER ----------------
function shoot(p, kind, dmg, speed, range, r, extra) {
  projectiles.push({
    owner: p.id, kind, dmg, r, extra: extra || null,
    x: p.x + Math.cos(p.angle) * (PLAYER_R + 4),
    y: p.y + Math.sin(p.angle) * (PLAYER_R + 4),
    vx: Math.cos(p.angle) * speed, vy: Math.sin(p.angle) * speed,
    left: range,
  });
}

function later(p, delay, fn) { p.timers.push({ at: now + delay, fn }); }

function dash(p, angle, duration, hit) {
  p.dash = { until: now + duration, vx: Math.cos(angle) * DASH_SPEED, vy: Math.sin(angle) * DASH_SPEED, hit: new Set(), opts: hit };
}

function spinCombo(p, m) {
  const R = 115;
  for (let i = 0; i < 3; i++) {
    later(p, i * 0.22, () => {
      events.push({ t: 'spin', id: p.id, r: R, x: Math.round(p.x), y: Math.round(p.y), i });
      const last = i === 2;
      hitCircle(p.x, p.y, p, R, (t) => dealDamage(p, t, (last ? 24 : 16) * m, { kb: last ? 380 : 90, stun: last ? 0.45 : 0.15 }));
    });
  }
}

function wave(p, m) {
  const R = 175, ARC = 1.7;
  events.push({ t: 'wave', id: p.id, a: +p.angle.toFixed(2), r: R, arc: ARC, x: Math.round(p.x), y: Math.round(p.y) });
  hitCone(p, R, ARC, (t) => dealDamage(p, t, 30 * m, { kb: 520, stun: 0.3 }));
}

function backstab(p, m) {
  events.push({ t: 'swing', id: p.id, a: +p.angle.toFixed(2), r: 72, x: Math.round(p.x), y: Math.round(p.y), s: 1 });
  hitCone(p, 72, 1.0, (t) => {
    const behind = isBehind(p, t);
    dealDamage(p, t, 28 * m, { mul: behind ? 2.5 : 1, bs: behind, stun: behind ? 0.4 : 0 });
  });
}

function basicAttack(p) {
  const c = CLASSES[p.cls];
  // saldırı hızı tamamen sunucu saatine bağlı: istemci ne kadar hızlı tıklarsa tıklasın değişmez
  if (!p.gate.tryUse('atk', now, c.atk.cd)) return;
  breakInvis(p);
  const dmg = c.atk.dmg * dmgMul(p);
  if (c.atk.type === 'melee') {
    events.push({ t: 'swing', id: p.id, a: +p.angle.toFixed(2), r: c.atk.range, x: Math.round(p.x), y: Math.round(p.y) });
    hitCone(p, c.atk.range, c.atk.arc, (t) => dealDamage(p, t, dmg, { kb: 60 }));
  } else {
    shoot(p, c.atk.kind || 'bolt', dmg, 560, 540, 7);
  }
}

function useSkill(p, key) {
  const s = CLASSES[p.cls].skills[key];
  if (!s || p.mp < s.mp || isStunned(p)) return;
  if (!p.gate.tryUse(key, now, s.cd)) return;
  p.mp -= s.mp;
  if (key !== 'e' || p.cls !== 'golge') breakInvis(p);
  s.cast(p, dmgMul(p));
}

function explode(pr, owner) {
  events.push({ t: 'boom', x: Math.round(pr.x), y: Math.round(pr.y) });
  hitCircle(pr.x, pr.y, owner, 95, (t) => {
    if (t.id !== pr.owner) dealDamage(owner, t, pr.dmg, { kb: 200, from: pr });
  });
}

// ---------------- OYUN DÖNGÜSÜ ----------------
function update() {
  now += DT;

  for (const p of players.values()) {
    p.playTime += DT;
    if (p.dead) {
      if (now >= p.respawnAt) {
        Object.assign(p, spawnPoint(p.f), { dead: false, hp: p.mh, mp: p.mm, stunUntil: 0 });
        grid.update(p);
        sendTo(p, { t: 'respawn' });
      }
      continue;
    }
    const c = CLASSES[p.cls];
    const inp = p.input;
    const stunned = isStunned(p);
    if (!stunned) p.angle = inp.angle;
    p.effects = p.effects.filter((e) => e.until > now);

    // zamanlanmış beceri adımları (kombo vuruşları vb.)
    if (p.timers.length) {
      const due = p.timers.filter((t) => t.at <= now);
      p.timers = p.timers.filter((t) => t.at > now);
      for (const t of due) if (!p.dead) t.fn();
      if (p.dead) continue;
    }

    const px = p.x, py = p.y;
    const speed = c.speed * (1 + mod(p, 'speed'));
    let maxSpeed = speed;

    if (p.dash && p.dash.until > now) {
      maxSpeed = DASH_SPEED;
      p.x += p.dash.vx * DT;
      p.y += p.dash.vy * DT;
      if (p.dash.opts) {
        for (const t of targetsNear(p.x, p.y, PLAYER_R + 10)) {
          if (!canHurt(p, t) || p.dash.hit.has(t.id)) continue;
          if (dist(p, t) < PLAYER_R * 2 + 10) {
            p.dash.hit.add(t.id);
            dealDamage(p, t, p.dash.opts.dmg, { kb: p.dash.opts.kb, stun: p.dash.opts.stun });
          }
        }
      }
    } else {
      p.dash = null;
      if (!stunned) {
        const mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        const my = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
        const len = Math.hypot(mx, my);
        if (len) {
          p.x += (mx / len) * speed * DT;
          p.y += (my / len) * speed * DT;
        }
      }
    }
    // geri savrulma (hızla sönümlenir)
    if (p.kb) {
      p.x += p.kb.vx * DT;
      p.y += p.kb.vy * DT;
      maxSpeed += Math.hypot(p.kb.vx, p.kb.vy);
      p.kb.vx *= 0.82; p.kb.vy *= 0.82;
      if (Math.hypot(p.kb.vx, p.kb.vy) < 20) p.kb = null;
    }
    resolveCollisions(p, PLAYER_R);
    if (!auditMove(p, px, py, DT, maxSpeed)) p.monitor && p.monitor.flag('speed', `${Math.round(dist({ x: px, y: py }, p))}px/tick`);
    grid.update(p);

    if (inp.atk && !stunned) basicAttack(p);

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
          dealDamage(src, p, p.poison.acc, { noCrit: true });
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
    let done = pr.left <= 0 || pr.x < 0 || pr.y < 0 || pr.x > MAP.w || pr.y > MAP.h || inRock(pr, pr.r);
    if (!done) {
      for (const t of targetsNear(pr.x, pr.y, pr.r)) {
        if (t.id === pr.owner) continue;
        if (owner && !canHurt(owner, t)) continue; // dost oyuncunun içinden geçer
        if (dist(pr, t) < PLAYER_R + pr.r) {
          if (pr.kind !== 'fire') dealDamage(owner, t, pr.dmg, { kb: 40, from: pr, stun: pr.extra && pr.extra.stun });
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

  if (++tickCount % SEND_EVERY === 0) broadcast();
}

// ---------------- AĞ ----------------
function sendTo(p, msg) {
  const ws = p.ws || p;
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

let tickCount = 0;
let lastBoard = null;
function broadcast() {
  const evs = events;
  events = [];
  // olayları ikiye ayır: konumlu olanlar (sadece yakındakilere) ve genel olanlar (herkese)
  const localEv = evs.filter((e) => e.x !== undefined);
  const globalEv = evs.filter((e) => e.x === undefined);

  if (tickCount % 30 === 0) {
    lastBoard = [...players.values()]
      .sort((a, b) => b.kills - a.kills || b.lvl - a.lvl)
      .slice(0, 5)
      .map((p) => ({ n: p.n, k: p.kills, d: p.deaths, l: p.lvl, f: p.f }));
  }

  for (const me of players.values()) {
    const vx = me.x, vy = me.y, r2 = VIEW_R * VIEW_R;
    const near = (o) => (o.x - vx) ** 2 + (o.y - vy) ** 2 <= r2;
    const vis = grid.query(vx, vy, VIEW_R);
    const plist = [];
    const dlist = [];
    for (const e of vis) {
      if (e.dummy) {
        dlist.push({ id: e.id, x: e.x, y: e.y, hp: Math.round(e.hp), mh: e.mh, dead: e.dead, st: e.stunUntil > now });
      } else if (e === me || e.f === me.f || !hasFx(e, 'iv')) {
        // görünmez düşmanların konumu hiç gönderilmez (istemcide gizlemek yetmez: hile ile görülebilir)
        plist.push({
          id: e.id, n: e.n, c: e.cls, f: e.f, x: Math.round(e.x), y: Math.round(e.y), a: +e.angle.toFixed(2),
          hp: Math.round(e.hp), mh: e.mh, l: e.lvl, dead: e.dead, ps: !!e.poison, st: e.stunUntil > now,
          fx: e.effects.filter((x) => x.until > now).map((x) => x.id),
        });
      }
    }
    const msg = {
      t: 'state',
      players: plist,
      dummies: dlist,
      proj: projectiles.filter(near).map((p) => [Math.round(p.x), Math.round(p.y), p.kind]),
      ev: globalEv.concat(localEv.filter(near)),
      me: {
        mp: Math.round(me.mp), mm: me.mm, xp: me.xp, xpn: xpNeed(me.lvl), k: me.kills, d: me.deaths,
        cd: { atk: me.gate.remaining('atk', now), q: me.gate.remaining('q', now), e: me.gate.remaining('e', now),
          r: me.gate.remaining('r', now), f: me.gate.remaining('f', now) },
        fx: me.effects.filter((x) => x.until > now).map((x) => [x.id, +(x.until - now).toFixed(1), x.dur]),
        safe: inSafe(me),
      },
      online: players.size,
    };
    if (tickCount % 30 === 0) msg.board = lastBoard;
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
  return { id: c.id, name: c.name, cls: c.cls, f: c.faction, lvl: c.level, kills: c.kills };
}

async function newToken(acc) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.createSession(acc.id, token);
  return token;
}

async function sendAccount(conn, token) {
  const acc = await db.getAccount(conn.acc.id); // güncel krallık bilgisi için
  conn.acc = acc;
  const chars = await db.listCharacters(acc.id);
  conn.send({ t: 'account', user: acc.username, faction: acc.faction, token, chars: chars.map(charSummary), max: MAX_CHARS });
}

function saveChar(p) {
  p.dirty = false;
  return db.saveCharacter({
    id: p.charId, level: p.lvl, exp: p.xp, alignment: p.alignment, mapId: MAP.id,
    x: p.dead ? null : Math.round(p.x), y: p.dead ? null : Math.round(p.y), z: 0,
    str: p.stats.str, dex: p.stats.dex, int: p.stats.int, vit: p.stats.vit, statPoints: p.statPoints,
    gold: p.gold, kills: p.kills, deaths: p.deaths, playSeconds: Math.round(p.playTime),
  }).catch((e) => console.error('Kayıt hatası:', e.message));
}

// periyodik kayıt (konum dahil)
setInterval(() => {
  for (const p of players.values()) saveChar(p);
}, 30000);

const handlers = {
  async register(conn, m) {
    const user = String(m.user || '');
    const pass = String(m.pass || '');
    if (!USER_RE.test(user)) return conn.err('Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _).');
    if (pass.length < 6 || pass.length > 64) return conn.err('Şifre en az 6 karakter olmalı.');
    const salt = crypto.randomBytes(16).toString('hex');
    const acc = await db.createAccount(user, await hashPass(pass, salt), salt);
    if (!acc) return conn.err('Bu kullanıcı adı alınmış.');
    conn.acc = acc;
    await db.touchLogin(acc.id);
    await sendAccount(conn, await newToken(acc));
  },

  async login(conn, m) {
    if (conn.fails >= 5) return conn.err('Çok fazla hatalı deneme. 30 saniye bekle.');
    const user = String(m.user || '');
    const acc = USER_RE.test(user) ? await db.getAccountByName(user) : null;
    const hash = await hashPass(String(m.pass || ''), acc ? acc.salt : 'x'); // hesap yoksa da aynı süre harca
    const ok = acc && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(acc.hash, 'hex'));
    if (!ok) {
      conn.fails++;
      if (conn.fails >= 5) setTimeout(() => { conn.fails = 0; }, 30000);
      if (acc) db.logSecurity(acc.id, null, 'loginFail', null).catch(() => {});
      return conn.err('Kullanıcı adı veya şifre yanlış.');
    }
    if (acc.status === 1) return conn.err('Bu hesap engellenmiş.');
    conn.acc = acc;
    await db.touchLogin(acc.id);
    await sendAccount(conn, await newToken(acc));
  },

  async token(conn, m) {
    const accountId = await db.getSessionAccount(String(m.token || '').slice(0, 64));
    const acc = accountId && (await db.getAccount(accountId));
    if (!acc || acc.status === 1) return conn.send({ t: 'tokenBad' });
    conn.acc = acc;
    await db.touchLogin(acc.id);
    await sendAccount(conn, m.token);
  },

  async logout(conn, m) {
    if (!conn.acc) return;
    await db.deleteSession(String(m.token || ''));
    conn.acc = null;
  },

  async create(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me) return;
    if ((await db.countCharacters(acc.id)) >= MAX_CHARS) return conn.err(`En fazla ${MAX_CHARS} karakter açabilirsin.`);
    const name = String(m.name || '').trim();
    if (!NAME_RE.test(name)) return conn.err('Karakter adı 3-14 karakter olmalı (harf, rakam, _).');
    const cls = CLASSES[m.cls];
    if (!cls) return conn.err('Geçersiz sınıf.');
    const faction = acc.faction || m.faction; // hesabın krallığı ilk karakterde belirlenir
    if (!FACTIONS[faction]) return conn.err('Bir krallık seç.');
    const c = await db.createCharacter(acc.id, { name, cls: m.cls, faction, ...cls.stats });
    if (!c) return conn.err('Bu karakter adı alınmış.');
    if (!acc.faction) await db.setFaction(acc.id, faction);
    await sendAccount(conn);
  },

  async remove(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me) return;
    const id = String(m.id);
    if ([...players.values()].some((p) => p.charId === id)) return conn.err('Bu karakter şu an oyunda.');
    if (!(await db.deleteCharacter(id, acc.id))) return;
    if ((await db.countCharacters(acc.id)) === 0) await db.setFaction(acc.id, null); // hiç karakter kalmazsa krallık yeniden seçilebilir
    await sendAccount(conn);
  },

  async play(conn, m) {
    const acc = conn.acc;
    if (!acc || conn.me) return;
    const c = await db.getCharacter(String(m.id));
    if (!c || c.accountId !== acc.id) return conn.err('Karakter bulunamadı.');
    // aynı hesap başka yerde oyundaysa onu çıkar
    for (const p of players.values()) {
      if (p.accountId === acc.id) {
        sendTo(p, { t: 'kicked', msg: 'Hesabına başka bir yerden girildi.' });
        p.ws.close();
        removePlayer(p);
      }
    }
    // son kaldığı yerden başla (geçerliyse); değilse kendi köyünde
    const pos = c.x != null && c.y != null && c.mapId === MAP.id && !inRock({ x: c.x, y: c.y }, PLAYER_R)
      && c.x > 0 && c.y > 0 && c.x < MAP.w && c.y < MAP.h ? { x: c.x, y: c.y } : spawnPoint(c.faction);
    const me = {
      id: nextId++, ws: conn.ws, monitor: conn.monitor, charId: c.id, accountId: acc.id, n: c.name, cls: c.cls, f: c.faction,
      lvl: c.level, xp: c.exp, kills: c.kills, deaths: c.deaths, alignment: c.alignment, gold: c.gold,
      stats: { str: c.str, dex: c.dex, int: c.int, vit: c.vit }, statPoints: c.statPoints, playTime: c.playSeconds,
      streak: 0, angle: 0, dead: false, gate: new ActionGate(), effects: [], timers: [], kb: null, stunUntil: 0, ambush: false,
      poison: null, dirty: false,
      input: { up: false, down: false, left: false, right: false, atk: false, angle: 0 },
      ...pos,
    };
    recalcStats(me);
    me.hp = me.mh;
    me.mp = me.mm;
    conn.me = me;
    players.set(me.id, me);
    grid.insert(me);
    const classInfo = {};
    for (const [k, cl] of Object.entries(CLASSES)) {
      const sk = {};
      for (const key of SKILL_KEYS) sk[key] = { name: cl.skills[key].name, cd: cl.skills[key].cd, mp: cl.skills[key].mp, desc: cl.skills[key].desc };
      classInfo[k] = { name: cl.name, color: cl.color, skills: sk, atkCd: cl.atk.cd };
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
  grid.remove(p);
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
  conn.monitor = new CheatMonitor(
    (kind) => {
      sendTo(ws, { t: 'kicked', msg: 'Şüpheli davranış nedeniyle bağlantın kesildi.' });
      console.warn(`Oyuncu atıldı (${kind}):`, conn.acc && conn.acc.username);
      ws.close();
    },
    (kind, detail) => {
      db.logSecurity(conn.acc && conn.acc.id, conn.me && conn.me.charId, kind, detail ? String(detail) : null).catch(() => {});
    },
  );

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return conn.monitor.flag('badPacket', 'json'); }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return conn.monitor.flag('badPacket', 'format');
    if (!conn.monitor.allow(m.t)) { // paket sınırı
      if (handlers[m.t]) conn.err('Çok hızlı işlem yaptın, birkaç saniye bekle.');
      return;
    }
    const me = conn.me;

    // oyun içi mesajlar (hızlı yol)
    if (me && players.has(me.id)) {
      if (m.t === 'input') {
        const i = me.input;
        i.up = m.up === true; i.down = m.down === true; i.left = m.left === true; i.right = m.right === true; i.atk = m.atk === true;
        if (Number.isFinite(m.angle) && Math.abs(m.angle) <= 7) i.angle = m.angle;
        return;
      }
      if (m.t === 'skill') {
        if (!me.dead && SKILL_KEYS.includes(m.k)) useSkill(me, m.k);
        return;
      }
      if (m.t === 'chat') {
        const msg = String(m.msg || '').trim().slice(0, 120);
        if (msg) events.push({ t: 'chat', n: me.n, f: me.f, msg });
        return;
      }
    }

    // hesap işlemleri (sırayla, aynı anda bir tane)
    const h = handlers[m.t];
    if (!h) return;
    if (conn.busy) return;
    conn.busy = true;
    try { await h(conn, m); } catch (e) { console.error(e); conn.err('Sunucu hatası, tekrar dene.'); }
    conn.busy = false;
  });

  ws.on('close', () => {
    if (conn.me) removePlayer(conn.me);
  });
});

function shutdown() {
  Promise.all([...players.values()].map(saveChar)).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

db.ready.then(() => {
  setInterval(update, 1000 / TICK);
  server.listen(PORT, () => console.log(`PvP Server çalışıyor: http://localhost:${PORT} · veritabanı: ${db.kind}`));
});

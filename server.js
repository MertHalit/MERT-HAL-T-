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
const I = require('./items');
const { TABLES: LOOT } = require('./loot');

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
  smiths: Object.values(FACTIONS).map((d) => ({ x: d.village.x + 120, y: d.village.y + 115 })),
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
const blocked = (o, r) => MAP.rocks.concat(MAP.solids || []).some((k) => dist(o, k) < k.r + r);
const inRock = (o, r) => MAP.rocks.some((k) => dist(o, k) < k.r + r) || (MAP.houses || []).some((k) => dist(o, k) < k.r + r);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function spawnPoint(faction) {
  const v = FACTIONS[faction].village;
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * (VILLAGE_R - 50);
  return { x: v.x + Math.cos(a) * r, y: v.y + Math.sin(a) * r };
}

function resolveCollisions(o, r) {
  for (const rock of MAP.rocks.concat(MAP.solids || [], stones.filter((s) => !s.dead))) {
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
  return grid.query(x, y, r + 30, (e) => !e.dead);
}

const isPlayer = (e) => !!e && !e.dummy && !e.mob && !e.stone;

// Aynı krallıktan oyuncular birbirine vuramaz; canavarlar birbirine vuramaz; geri dönen canavara vurulamaz.
function canHurt(src, t) {
  if (!t || t.dead || src === t) return false;
  if (isPlayer(src) && isPlayer(t) && src.f === t.f) return false;
  if (src && !isPlayer(src) && !isPlayer(t)) return false;
  if (t.mob && t.state === 'return') return false;
  return true;
}

// Yakındaki dost oyuncular (kendisi dahil) - "parti" sistemi gelene kadar aynı krallıktakiler
function allies(p, r) {
  return grid.query(p.x, p.y, r, (e) => isPlayer(e) && !e.dead && e.f === p.f);
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

// Karakter değerleri: sınıf + seviye + statüler + kuşanılmış eşyalar + efsunlar
function recalcStats(p) {
  const c = CLASSES[p.cls];
  const eq = I.equipStats(p.inv || []);
  const b = eq.bonus;
  p.eqAtk = eq.atk; // hasara yüzde
  p.eqDef = eq.def; // alınan hasardan yüzde azaltma
  p.bonus = b;
  p.mh = Math.round(c.hp * scale(p) * (1 + (p.stats.vit - 5) * 0.02)) + eq.hp + (b.hp || 0);
  p.mm = Math.round(c.mp * scale(p) * (1 + (p.stats.int - 5) * 0.02)) + (b.mp || 0);
  p.crit = BASE_CRIT + (p.stats.dex + (b.dex || 0)) * 0.004 + (b.crit || 0) / 100;
  if (p.hp > p.mh) p.hp = p.mh;
  if (p.mp > p.mm) p.mp = p.mm;
}
const bonusOf = (p, k) => (p.bonus && p.bonus[k]) || 0;

function heal(src, target, base) {
  const amount = Math.round(base * scale(src) * (src.curSkillMul || 1));
  target.hp = Math.min(target.mh, target.hp + amount);
  healThreat(src, amount);
  events.push({ t: 'heal', x: Math.round(target.x), y: Math.round(target.y), v: amount });
}

// ---------------- HASAR / ÖLÜM ----------------
// opts: { kb: geri savurma gücü, stun: sersemletme süresi, from: savurma merkezi, mul: ek çarpan, noCrit }
function dealDamage(src, target, amount, opts = {}) {
  if (!canHurt(src, target)) return 0;
  if (inSafe(target) || (isPlayer(src) && inSafe(src))) return 0;
  let crit = false, pierce = false;
  if (isPlayer(src)) {
    amount *= 1 + mod(src, 'atk') + src.eqAtk / 100 + (src.stats.str + bonusOf(src, 'str') - 5) * 0.01;
    amount *= 1 + (target.mob || target.dummy ? bonusOf(src, 'vsMonster') : bonusOf(src, 'vsPlayer')) / 100;
    if (Math.random() < bonusOf(src, 'pierce') / 100) pierce = true; // delici: savunmayı yok sayar
    if (opts.mul) amount *= opts.mul;
    if (src.ambush) { amount *= 1.5; src.ambush = false; } // gölgeden çıkan ilk vuruş
    if (!opts.noCrit && Math.random() < src.crit + mod(src, 'crit')) { amount *= CRIT_MUL; crit = true; }
  }
  amount *= Math.max(0.1, 1 + mod(target, 'taken'));
  if (target.stone && !pierce) amount *= 1 - target.armor; // taşın zırhı
  if (isPlayer(target) && !pierce) {
    const def = target.eqDef + bonusOf(target, opts.magic ? 'magicDef' : 'meleeDef');
    amount *= 1 - Math.min(0.75, def / 100);
  }
  amount = Math.max(1, Math.round(amount));
  target.hp -= amount;
  events.push({ t: 'dmg', x: Math.round(target.x), y: Math.round(target.y), v: amount, c: crit ? 1 : 0, bs: opts.bs ? 1 : 0, p: pierce ? 1 : 0 });

  // can çalma (Ruh Kılıcı aurası)
  if (isPlayer(src) && !src.dead) {
    const ls = mod(src, 'lifesteal') + bonusOf(src, 'lifesteal') / 100;
    if (ls > 0) src.hp = Math.min(src.mh, src.hp + amount * ls);
    const ms = bonusOf(src, 'manasteal') / 100;
    if (ms > 0) src.mp = Math.min(src.mm, src.mp + amount * ms);
    if (!opts.stun && Math.random() < bonusOf(src, 'stun') / 100) opts = { ...opts, stun: 0.5 };
  }
  // geri savurma + sersemletme
  if (opts.kb && !target.dummy && !target.stone && !(target.mob && target.heavy)) {
    const from = opts.from || src;
    const d = dist(from, target) || 1;
    const k = opts.kb * (target.mob ? 1 : PVP_KB); // canavarlara tam savurma
    target.kb = { vx: ((target.x - from.x) / d) * k, vy: ((target.y - from.y) / d) * k };
  }
  if (opts.stun && !target.stone) {
    target.stunUntil = Math.max(target.stunUntil || 0, now + (isPlayer(target) ? opts.stun * 0.7 : opts.stun));
    if (isPlayer(target)) target.dash = null;
  }
  if (target.mob && isPlayer(src)) onMobHit(target, src, amount);
  if (target.stone && isPlayer(src)) onStoneHit(target, src, amount);
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
    if (isPlayer(src)) gainXp(src, 25);
    return;
  }
  if (target.mob) return onMobDeath(target, src);
  if (target.stone) return onStoneDeath(target, src);
  target.deaths++;
  target.streak = 0;
  target.dirty = true;
  if (src && src.mob) {
    events.push({ t: 'kill', k: src.n, v: target.n, vf: target.f, s: 0 });
    sendTo(target, { t: 'dead', by: src.n, in: RESPAWN });
  } else if (isPlayer(src)) {
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
  if (!isPlayer(p) || p.lvl >= MAX_LEVEL) return;
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
    if (!canHurt(p, t) || dist(p, t) > range + (t.r || PLAYER_R)) continue;
    if (Math.abs(angleDiff(Math.atan2(t.y - p.y, t.x - p.x), p.angle)) <= arc / 2) { fn(t); n++; }
  }
  return n;
}
// Daire: karakterin etrafında 360°.
function hitCircle(cx, cy, src, r, fn) {
  for (const t of targetsNear(cx, cy, r)) {
    if (canHurt(src, t) && Math.hypot(t.x - cx, t.y - cy) <= r + (t.r || PLAYER_R)) fn(t);
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
  hitCone(p, R, ARC, (t) => dealDamage(p, t, 30 * m, { kb: 520, stun: 0.3, magic: true }));
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
  if (!p.gate.tryUse('atk', now, c.atk.cd / (1 + bonusOf(p, 'atkSpeed') / 100))) return;
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
  if (!s || p.mp < s.mp || isStunned(p) || p.shop) return;
  if (!p.gate.tryUse(key, now, s.cd)) return;
  p.mp -= s.mp;
  if (key !== 'e' || p.cls !== 'golge') breakInvis(p);
  p.curSkillMul = skillMul(p, key);
  s.cast(p, dmgMul(p) * p.curSkillMul);
  p.curSkillMul = 1;
}

function explode(pr, owner) {
  events.push({ t: 'boom', x: Math.round(pr.x), y: Math.round(pr.y) });
  hitCircle(pr.x, pr.y, owner, 95, (t) => {
    if (t.id !== pr.owner) dealDamage(owner, t, pr.dmg, { kb: 200, from: pr, magic: true });
  });
}

// ---------------- CANAVARLAR ----------------
// Davranış tipleri:
//   passive : asla saldırmaz, vurulunca kaçar
//   semi    : yarı agresif - biri vurunca (veya grubuna vurulunca) saldırır
//   aggr    : tam agresif - görüş menziline giren oyuncuya saldırır
// Durum makinesi: idle (boşta/dolaşma) → chase (kovalama) → attack (saldırı hazırlığı + vuruş)
//                 → return (doğduğu yere dönüş, canı dolar) → idle
const MOB_TYPES = {
  tilki: { name: 'Kızıl Tilki', lvl: 1, hp: 60, dmg: 5, speed: 150, r: 15, aggro: 'passive', color: '#d9772b', shape: 'beast', xp: 18, respawn: 15 },
  kurt: { name: 'Boz Kurt', lvl: 3, hp: 130, dmg: 9, speed: 175, r: 17, aggro: 'semi', color: '#8a8f99', shape: 'beast', xp: 40, respawn: 18 },
  domuz: { name: 'Yaban Domuzu', lvl: 5, hp: 220, dmg: 13, speed: 160, r: 20, aggro: 'semi', color: '#6b4a32', shape: 'beast', xp: 70, respawn: 20 },
  haydut: { name: 'Dağ Haydudu', lvl: 8, hp: 320, dmg: 18, speed: 170, r: 19, aggro: 'aggr', color: '#5a5f2a', shape: 'human', xp: 120, respawn: 25, sight: 230 },
  ayi: { name: 'Kara Ayı', lvl: 12, hp: 900, dmg: 32, speed: 150, r: 28, aggro: 'aggr', color: '#2b2420', shape: 'beast', xp: 320, respawn: 45, sight: 200, heavy: false },
};
// Grup = [tür, merkez x, merkez y, kaç tane]
const SPAWN_GROUPS = [
  ['tilki', 800, 300, 3], ['tilki', 350, 800, 3], ['tilki', 2200, 300, 3], ['tilki', 2650, 800, 3], ['tilki', 1150, 2000, 3], ['tilki', 1850, 2000, 3],
  ['kurt', 900, 850, 4], ['kurt', 2100, 850, 4], ['kurt', 1200, 1700, 4], ['kurt', 1800, 1700, 4],
  ['domuz', 600, 1100, 3], ['domuz', 2400, 1100, 3], ['domuz', 800, 1700, 3], ['domuz', 2200, 1700, 3],
  ['haydut', 1150, 950, 4], ['haydut', 1850, 950, 4], ['haydut', 1500, 1250, 4],
  ['ayi', 1500, 700, 1], ['ayi', 350, 1900, 2], ['ayi', 2650, 1900, 2],
];
const LEASH = 800; // 40 metre: doğma noktasından bu kadar uzaklaşan canavar geri döner
const MOB_ATTACK_WINDUP = 0.35; // saldırı öncesi hazırlık (oyuncu kaçabilsin diye)
const MOB_ATTACK_CD = 1.3;
const PACK_ALERT_R = 450;
const ACTIVE_R = 1400; // yakınında oyuncu olmayan canavarlar "uyur" (işlemci tasarrufu)
const mobs = [];
let mobSeq = 0;

function freeSpot(cx, cy, spread, r) {
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * spread;
    const p = { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d };
    if (!inRock(p, r + 4) && !inSafe(p) && p.x > r && p.y > r && p.x < MAP.w - r && p.y < MAP.h - r) return p;
  }
  return { x: cx, y: cy };
}

function makeMob(type, home, pack) {
  const T = MOB_TYPES[type];
  const pos = freeSpot(home.x, home.y, 70, T.r);
  const m = {
    id: 'm' + ++mobSeq, mob: true, type, n: T.name, lvl: T.lvl, aggro: T.aggro, r: T.r, heavy: !!T.heavy,
    hp: T.hp, mh: T.hp, dmg: T.dmg, speed: T.speed, sight: T.sight || 0, xp: T.xp,
    home: { x: pos.x, y: pos.y }, x: pos.x, y: pos.y, angle: Math.random() * 6.28, pack,
    state: 'idle', threat: new Map(), dmgBy: new Map(), target: null, windUntil: 0, nextAtk: 0, wander: null, nextWander: now + Math.random() * 4,
    fleeUntil: 0, fleeFrom: null, kb: null, stunUntil: 0, effects: [], dead: false, respawnAt: 0, active: true,
  };
  grid.insert(m);
  mobs.push(m);
  return m;
}

for (const [type, x, y, count] of SPAWN_GROUPS) {
  const pack = [];
  for (let i = 0; i < count; i++) pack.push(makeMob(type, { x, y }, pack));
}

function mobView(m) {
  return {
    id: m.id, t: m.type, x: Math.round(m.x), y: Math.round(m.y), a: +m.angle.toFixed(2), hp: Math.round(m.hp), mh: m.mh, l: m.lvl,
    st: m.stunUntil > now ? 1 : 0, w: m.windUntil > now ? 1 : 0, s: m.state === 'return' ? 'r' : m.target ? 'c' : 'i',
  };
}

// ---- Tehdit (aggro) ----
function addThreat(m, p, v) {
  if (m.aggro === 'passive' || m.state === 'return' || !isPlayer(p)) return;
  m.threat.set(p.id, (m.threat.get(p.id) || 0) + v);
}

// Oyuncu canavara vurduğunda: tehdit ekle, gruba haber ver (Pack Alert), pasifse kaç
function onMobHit(m, p, amount) {
  m.dmgBy.set(p.id, (m.dmgBy.get(p.id) || 0) + amount);
  if (m.aggro === 'passive') {
    m.fleeUntil = now + 2.5;
    m.fleeFrom = { x: p.x, y: p.y };
    return;
  }
  addThreat(m, p, amount);
  for (const o of m.pack) {
    if (o === m || o.dead || o.state === 'return') continue;
    if (dist(o, m) <= PACK_ALERT_R && o.threat.size === 0) {
      addThreat(o, p, 1); // zincirleme: gruptaki herkes saldırana yönelir
      events.push({ t: 'alert', x: Math.round(o.x), y: Math.round(o.y) });
    }
  }
}

// İyileştiren oyuncu, iyileştirdiği kişiyle savaşan canavarların dikkatini çeker
function healThreat(healer, amount) {
  if (!isPlayer(healer)) return;
  for (const m of grid.query(healer.x, healer.y, 600, (e) => e.mob && !e.dead && e.threat.size > 0)) addThreat(m, healer, amount * 0.5);
}

function pickTarget(m) {
  let best = null, bestV = -1;
  for (const [pid, v] of m.threat) {
    const p = players.get(pid);
    // geçersiz hedefleri tehdit tablosundan sil: çıkmış, ölmüş, köyde, çok uzakta
    if (!p || p.dead || inSafe(p) || dist(p, m.home) > LEASH + 150 || (hasFx(p, 'iv') && dist(p, m) > 60)) { m.threat.delete(pid); continue; }
    if (v > bestV) { bestV = v; best = p; }
  }
  return best;
}

function startReturn(m) {
  m.state = 'return';
  m.threat.clear();
  m.dmgBy.clear();
  m.target = null;
  m.windUntil = 0;
  m.kb = null;
}

// ---- Çarpışma: kayalar, harita kenarı ve köyler (canavar köye giremez). Çarpışma normalini döndürür. ----
function pushOutMob(m) {
  let nx = 0, ny = 0;
  const obstacles = MAP.rocks.concat(MAP.villages, MAP.solids || [], stones.filter((s) => !s.dead));
  for (const o of obstacles) {
    const d = dist(m, o);
    const min = o.r + m.r;
    if (d < min && d > 0) {
      const ux = (m.x - o.x) / d, uy = (m.y - o.y) / d;
      m.x = o.x + ux * min; m.y = o.y + uy * min;
      nx += ux; ny += uy;
    }
  }
  if (m.x < m.r) { m.x = m.r; nx += 1; }
  if (m.y < m.r) { m.y = m.r; ny += 1; }
  if (m.x > MAP.w - m.r) { m.x = MAP.w - m.r; nx -= 1; }
  if (m.y > MAP.h - m.r) { m.y = MAP.h - m.r; ny -= 1; }
  const len = Math.hypot(nx, ny);
  return len ? { x: nx / len, y: ny / len } : null;
}

// ---- Geri savrulma + duvara sıkıştırma ----
// Savrulan canavar bir engele çarparsa hız vektörünün duvara giren bileşeni silinir (v' = v - (v·n)n),
// yani duvar boyunca kayar. Kalan hız çok küçükse (köşe ya da dik çarpma) canavar sıkışmış sayılır ve sersemler.
function applyKnockback(m) {
  const before = Math.hypot(m.kb.vx, m.kb.vy);
  m.x += m.kb.vx * DT;
  m.y += m.kb.vy * DT;
  const n = pushOutMob(m);
  if (n) {
    const dot = m.kb.vx * n.x + m.kb.vy * n.y;
    if (dot < 0) { m.kb.vx -= dot * n.x; m.kb.vy -= dot * n.y; }
    if (Math.hypot(m.kb.vx, m.kb.vy) < before * 0.35) {
      m.stunUntil = Math.max(m.stunUntil, now + 0.6);
      m.kb = null;
      events.push({ t: 'pin', x: Math.round(m.x), y: Math.round(m.y) });
      return;
    }
  }
  m.kb.vx *= 0.82; m.kb.vy *= 0.82;
  if (Math.hypot(m.kb.vx, m.kb.vy) < 20) m.kb = null;
}

// ---- Yumuşak ayrışma: canavarlar iç içe geçmez; oyuncuya değince canavar kenara çekilir (oyuncu kilitlenmez) ----
function separate(m) {
  for (const o of grid.query(m.x, m.y, m.r + 30, (e) => e !== m && !e.dead && (e.mob || isPlayer(e)))) {
    const d = dist(m, o) || 0.01;
    const min = m.r + (o.mob ? o.r : PLAYER_R);
    if (d >= min) continue;
    const overlap = min - d;
    const ux = (m.x - o.x) / d, uy = (m.y - o.y) / d;
    if (o.mob) {
      m.x += ux * overlap * 0.25; m.y += uy * overlap * 0.25;
      o.x -= ux * overlap * 0.25; o.y -= uy * overlap * 0.25;
    } else {
      m.x += ux * overlap * 0.5; m.y += uy * overlap * 0.5; // sadece canavar itilir
    }
  }
}

function moveToward(m, tx, ty, speed, stopAt = 0) {
  const dx = tx - m.x, dy = ty - m.y;
  const d = Math.hypot(dx, dy);
  if (d <= stopAt + 0.5 || d < 1) return true;
  const step = Math.min(speed * DT, d - stopAt);
  m.x += (dx / d) * step;
  m.y += (dy / d) * step;
  m.angle = Math.atan2(dy, dx);
  return false;
}

function onMobDeath(m, src) {
  m.dead = true;
  m.respawnAt = now + MOB_TYPES[m.type].respawn;
  m.threat.clear();
  m.target = null;
  m.windUntil = 0;
  m.kb = null;
  if (isPlayer(src)) {
    // seviye farkı cezası: çok düşük seviye canavardan az tecrübe
    const diff = src.lvl - m.lvl;
    const mul = diff > 10 ? 0.1 : diff > 5 ? 0.5 : 1;
    const xp = Math.max(1, Math.round(m.xp * mul));
    gainXp(src, xp);
    events.push({ t: 'xp', id: src.id, v: xp, x: Math.round(m.x), y: Math.round(m.y) });
  }
  // ganimet yere düşer; sahibi en çok hasar veren oyuncu
  const owner = topDamager(m.dmgBy) || (isPlayer(src) ? src : null);
  spawnDrops(LOOT[m.type].roll(), m, owner, 0.6);
  m.dmgBy.clear();
}

function updateMob(m) {
  if (m.summoned && (m.dead || (m.state === 'idle' && now > m.expireAt))) {
    // çağrılmış canavarlar yeniden doğmaz
    grid.remove(m);
    m.gone = true;
    return;
  }
  if (m.dead) {
    if (now >= m.respawnAt) {
      const p = freeSpot(m.home.x, m.home.y, 40, m.r);
      Object.assign(m, { dead: false, hp: m.mh, x: p.x, y: p.y, state: 'idle', stunUntil: 0 });
      grid.update(m);
    }
    return;
  }
  m.effects = m.effects.filter((e) => e.until > now);
  if (m.kb) applyKnockback(m);
  separate(m);

  if (m.stunUntil > now) {
    m.windUntil = 0; // sersemleyince saldırı hazırlığı bozulur
    pushOutMob(m);
    grid.update(m);
    return;
  }

  if (m.state === 'return') {
    m.hp = Math.min(m.mh, m.hp + m.mh * 0.25 * DT);
    if (moveToward(m, m.home.x, m.home.y, m.speed * 1.6, 5)) {
      m.state = 'idle';
      m.hp = m.mh;
    }
  } else {
    // 40 m sınırı
    if (dist(m, m.home) > LEASH) startReturn(m);
    else {
      let target = pickTarget(m);
      // tam agresif: görüş menzilindeki oyuncuyu fark eder
      if (!target && m.aggro === 'aggr') {
        const seen = grid.query(m.x, m.y, m.sight, (e) => isPlayer(e) && !e.dead && !inSafe(e) && !hasFx(e, 'iv'));
        if (seen.length) {
          addThreat(m, seen[0], 1);
          events.push({ t: 'alert', x: Math.round(m.x), y: Math.round(m.y) });
          for (const o of m.pack) if (o !== m && !o.dead && o.threat.size === 0 && dist(o, m) < PACK_ALERT_R) addThreat(o, seen[0], 1);
          target = seen[0];
        }
      }
      m.target = target;
      if (target) {
        m.state = 'chase';
        const reach = m.r + PLAYER_R + 8;
        const d = dist(m, target);
        m.angle = Math.atan2(target.y - m.y, target.x - m.x);
        if (m.windUntil) {
          if (now >= m.windUntil) {
            // vuruş anı: oyuncu hâlâ menzildeyse ve canavarın önündeyse hasar al
            if (d <= reach + 18) dealDamage(m, target, m.dmg * (0.9 + Math.random() * 0.2), { noCrit: true });
            m.windUntil = 0;
            m.nextAtk = now + MOB_ATTACK_CD;
          }
        } else if (d > reach) {
          moveToward(m, target.x, target.y, m.speed, reach - 4);
        } else if (now >= m.nextAtk) {
          m.windUntil = now + MOB_ATTACK_WINDUP;
          events.push({ t: 'mwind', id: m.id, x: Math.round(m.x), y: Math.round(m.y) });
        }
      } else if (m.state === 'chase') {
        // hedef kayboldu: yerine dön
        if (dist(m, m.home) > 60) startReturn(m); else m.state = 'idle';
      } else if (m.fleeUntil > now && m.fleeFrom) {
        const a = Math.atan2(m.y - m.fleeFrom.y, m.x - m.fleeFrom.x);
        moveToward(m, m.x + Math.cos(a) * 100, m.y + Math.sin(a) * 100, m.speed * 1.2);
        if (dist(m, m.home) > LEASH * 0.6) { m.fleeUntil = 0; startReturn(m); }
      } else {
        // boşta: doğma noktası çevresinde dolaş
        if (now >= m.nextWander) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * 110;
          m.wander = { x: m.home.x + Math.cos(a) * r, y: m.home.y + Math.sin(a) * r };
          m.nextWander = now + 3 + Math.random() * 5;
        }
        if (m.wander && moveToward(m, m.wander.x, m.wander.y, m.speed * 0.35, 3)) m.wander = null;
        if (m.hp < m.mh) m.hp = Math.min(m.mh, m.hp + m.mh * 0.05 * DT);
      }
    }
  }
  pushOutMob(m);
  grid.update(m);
}

let mobTick = 0;
function updateMobs() {
  // yarım saniyede bir: yakınında oyuncu olmayan ve boşta olan canavarları uyut
  if (mobTick++ % 15 === 0) {
    for (const m of mobs) {
      m.active = m.dead || m.state !== 'idle' || grid.query(m.x, m.y, ACTIVE_R, isPlayer).length > 0;
    }
  }
  for (const m of mobs) if (m.active) updateMob(m);
  for (let i = mobs.length - 1; i >= 0; i--) if (mobs[i].gone) mobs.splice(i, 1);
}

// ---------------- YERE DÜŞEN GANİMET ----------------
// Eşyalar ayrı bir ızgarada tutulur (saldırıların hedefi olmasınlar diye).
const dropGrid = new SpatialGrid(CELL);
const drops = [];
let dropSeq = 0;
const DROP_OWN = 30; // saniye: bu süre boyunca sadece sahibi toplayabilir
const DROP_LIFE = 120; // saniye: sonra yok olur
const PICK_R = 90;

// En çok hasar veren (hâlâ oyunda olan) oyuncu
function topDamager(map) {
  let best = null, bestV = 0;
  for (const [pid, v] of map) {
    const p = players.get(pid);
    if (p && v > bestV) { bestV = v; best = p; }
  }
  return best;
}

// Eşyaları kaynağın etrafına dairesel olarak saçar: her eşya eşit aralıklı bir açıyla, rastgele bir hızla fırlar,
// sürtünmeyle yavaşlar ve kayalardan seker.
function spawnDrops(list, at, owner, power = 1) {
  const n = list.length;
  list.forEach((d, i) => {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.7;
    const sp = (170 + Math.random() * 190) * power;
    const start = (at.r || 15) * 0.6;
    const g = {
      id: 'g' + ++dropSeq, drop: true, itemId: d.id || 0, count: d.count || 1, plus: d.plus || 0, gold: d.gold || 0, attrs: d.attrs || null,
      x: at.x + Math.cos(a) * start, y: at.y + Math.sin(a) * start, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      ownerChar: owner ? owner.charId : null, ownerName: owner ? owner.n : null, ownUntil: now + DROP_OWN, expireAt: now + DROP_LIFE,
    };
    drops.push(g);
    dropGrid.insert(g);
  });
}

function updateDrops() {
  for (let i = drops.length - 1; i >= 0; i--) {
    const g = drops[i];
    if (now >= g.expireAt) { dropGrid.remove(g); drops.splice(i, 1); continue; }
    if (!g.vx && !g.vy) continue;
    g.x += g.vx * DT;
    g.y += g.vy * DT;
    for (const o of MAP.rocks.concat(stones.filter((s) => !s.dead))) {
      const d = dist(g, o), min = o.r + 8;
      if (d < min && d > 0) {
        const ux = (g.x - o.x) / d, uy = (g.y - o.y) / d;
        g.x = o.x + ux * min; g.y = o.y + uy * min;
        const dot = g.vx * ux + g.vy * uy;
        if (dot < 0) { g.vx -= 1.6 * dot * ux; g.vy -= 1.6 * dot * uy; } // sekme
      }
    }
    g.x = clamp(g.x, 10, MAP.w - 10);
    g.y = clamp(g.y, 10, MAP.h - 10);
    g.vx *= 0.86; g.vy *= 0.86;
    if (Math.hypot(g.vx, g.vy) < 8) { g.vx = 0; g.vy = 0; }
    dropGrid.update(g);
  }
}

// Oyuncunun yakınındaki ganimeti topla
function pickup(p) {
  if (p.dead) return;
  const near = dropGrid.query(p.x, p.y, PICK_R).sort((a, b) => dist(a, p) - dist(b, p));
  let gold = 0, blocked = null, full = false;
  const got = [];
  for (const g of near) {
    if (g.ownerChar && g.ownerChar !== p.charId && now < g.ownUntil) { blocked = blocked || g; continue; }
    if (g.gold) {
      gold += g.gold;
    } else {
      const left = I.giveItem(p.inv, g.itemId, g.count, { plus: g.plus, attrs: g.attrs ? g.attrs.map((a) => ({ ...a })) : undefined });
      const taken = g.count - left;
      if (taken > 0) got.push([g.itemId, taken, g.plus]);
      if (left > 0) { g.count = left; full = true; continue; }
    }
    dropGrid.remove(g);
    drops.splice(drops.indexOf(g), 1);
  }
  if (gold) p.gold += gold;
  if (gold || got.length) {
    sendTo(p, { t: 'loot', gold, items: got });
    if (got.length) { recalcStats(p); sendInv(p); saveInv(p); } else sendTo(p, { t: 'gold', gold: p.gold });
    saveChar(p);
  }
  if (full) sendTo(p, { t: 'notice', msg: 'Çantan dolu!' });
  else if (blocked && !gold && !got.length) {
    sendTo(p, { t: 'notice', msg: `Bu ganimet ${blocked.ownerName} adlı oyuncuya ait (${Math.ceil(blocked.ownUntil - now)} sn).` });
  }
}

// ---------------- BOZULMA TAŞLARI ----------------
// Hareketsiz, çok canlı ve zırhlı. Canı %80/%60/%40/%20'ye düştükçe etrafına agresif canavar grupları çağırır.
const STONE_TYPES = {
  5: { hp: 3000, armor: 0.3, r: 32, loot: 'tas5', summon: ['kurt', 'domuz'], respawn: 90, xp: 400 },
  10: { hp: 6500, armor: 0.35, r: 36, loot: 'tas10', summon: ['domuz', 'haydut'], respawn: 120, xp: 1000 },
  15: { hp: 11000, armor: 0.4, r: 40, loot: 'tas15', summon: ['haydut', 'ayi'], respawn: 150, xp: 2200 },
};
const STONE_SITES = [
  [1250, 600, 5], [1750, 600, 5], [650, 1450, 5], [2350, 1450, 5],
  [1000, 1550, 10], [2000, 1550, 10], [1350, 1550, 10], [1500, 300, 10],
  [1500, 1100, 15],
];
const STONE_THRESHOLDS = [0.8, 0.6, 0.4, 0.2];
const ACTIVE_STONES = 5;
const stones = [];
let stoneSeq = 0;

function placeStone(st) {
  const used = new Set(stones.filter((s) => s !== st && !s.dead).map((s) => s.site));
  const free = STONE_SITES.map((_, i) => i).filter((i) => !used.has(i));
  const site = free[Math.floor(Math.random() * free.length)];
  const [x, y, lvl] = STONE_SITES[site];
  const T = STONE_TYPES[lvl];
  Object.assign(st, {
    site, x, y, lvl, r: T.r, hp: T.hp, mh: T.hp, armor: T.armor, dead: false, fired: 0, dmgBy: new Map(),
    n: 'Bozulma Taşı', effects: [], stunUntil: 0, angle: 0,
  });
  grid.update(st);
}

for (let i = 0; i < ACTIVE_STONES; i++) {
  const st = { id: 's' + ++stoneSeq, stone: true, x: 0, y: 0 };
  stones.push(st);
  grid.insert(st);
  placeStone(st);
}

function summonWave(st, target) {
  const T = STONE_TYPES[st.lvl];
  const groups = 3 + (Math.random() < 0.5 ? 1 : 0);
  for (let g = 0; g < groups; g++) {
    const a = Math.random() * Math.PI * 2, d = st.r + 110 + Math.random() * 110;
    const center = { x: st.x + Math.cos(a) * d, y: st.y + Math.sin(a) * d };
    const type = T.summon[Math.floor(Math.random() * T.summon.length)];
    const count = 2 + (Math.random() < 0.5 ? 1 : 0);
    const pack = [];
    for (let k = 0; k < count; k++) {
      const m = makeMob(type, center, pack);
      Object.assign(m, { summoned: true, aggro: 'aggr', sight: 320, expireAt: now + 150 });
      pack.push(m);
      if (target) addThreat(m, target, 5);
    }
    events.push({ t: 'summon', x: Math.round(center.x), y: Math.round(center.y) });
  }
}

function onStoneHit(st, p, amount) {
  st.dmgBy.set(p.id, (st.dmgBy.get(p.id) || 0) + amount);
  while (st.fired < STONE_THRESHOLDS.length && st.hp / st.mh <= STONE_THRESHOLDS[st.fired]) {
    st.fired++;
    summonWave(st, topDamager(st.dmgBy) || p);
  }
}

function onStoneDeath(st, src) {
  st.dead = true;
  const T = STONE_TYPES[st.lvl];
  st.respawnAt = now + T.respawn;
  grid.remove(st);
  const owner = topDamager(st.dmgBy) || (isPlayer(src) ? src : null);
  // tecrübe: hasar payına göre paylaştırılır
  let total = 0;
  for (const v of st.dmgBy.values()) total += v;
  for (const [pid, v] of st.dmgBy) {
    const p = players.get(pid);
    if (!p) continue;
    const xp = Math.round(T.xp * (0.3 + 0.7 * (v / total)));
    gainXp(p, xp);
    events.push({ t: 'xp', id: p.id, v: xp, x: Math.round(st.x), y: Math.round(st.y) });
  }
  spawnDrops(LOOT[T.loot].roll(), st, owner, 1.3);
  events.push({ t: 'stoneBreak', x: Math.round(st.x), y: Math.round(st.y), r: st.r });
  if (owner) events.push({ t: 'sys', msg: `${owner.n}, Sv.${st.lvl} Bozulma Taşı'nı kırdı!` });
}

function updateStones() {
  for (const st of stones) {
    if (st.dead && now >= st.respawnAt) {
      placeStone(st);
      grid.insert(st);
      events.push({ t: 'sys', msg: `Bir yerde Sv.${st.lvl} Bozulma Taşı belirdi...` });
    } else if (!st.dead && st.dmgBy.size && st.hp < st.mh) {
      // kimse vurmuyorsa (yakında oyuncu yoksa) yavaşça iyileşir
      if (!grid.query(st.x, st.y, 600, isPlayer).length) {
        st.hp = Math.min(st.mh, st.hp + st.mh * 0.02 * DT);
        if (st.hp >= st.mh) { st.dmgBy.clear(); st.fired = 0; }
      }
    }
  }
}

// ---------------- BECERİ SEVİYELERİ ----------------
const SKILL_IDS = { q: 1, e: 2, r: 3, f: 4 };
const MAX_SKILL_LV = 20;
const skillMul = (p, key) => 1 + 0.04 * ((p.skillLv[key] || 1) - 1); // her seviye +%4

function saveSkills(p) {
  return db.saveSkills(p.charId, SKILL_KEYS.map((k) => ({ skillId: SKILL_IDS[k], level: p.skillLv[k], grade: 0 })))
    .catch((e) => console.error('Beceri kayıt hatası:', e.message));
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
    const speed = c.speed * (1 + mod(p, 'speed') + bonusOf(p, 'moveSpeed') / 100);
    let maxSpeed = speed;

    if (p.dash && p.dash.until > now) {
      maxSpeed = DASH_SPEED;
      p.x += p.dash.vx * DT;
      p.y += p.dash.vy * DT;
      if (p.dash.opts) {
        for (const t of targetsNear(p.x, p.y, PLAYER_R + 10)) {
          if (!canHurt(p, t) || p.dash.hit.has(t.id)) continue;
          if (dist(p, t) < PLAYER_R + (t.r || PLAYER_R) + 10) {
            p.dash.hit.add(t.id);
            dealDamage(p, t, p.dash.opts.dmg, { kb: p.dash.opts.kb, stun: p.dash.opts.stun });
          }
        }
      }
    } else {
      p.dash = null;
      if (!stunned && !p.shop) {
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
    // hareket denetimi çarpışma itmesinden ÖNCE yapılır (itme sunucunun kendi hesabı, güvenilir)
    if (!auditMove(p, px, py, DT, maxSpeed)) p.monitor && p.monitor.flag('speed', `${Math.round(dist({ x: px, y: py }, p))}px/tick`);
    resolveCollisions(p, PLAYER_R);
    grid.update(p);

    if (inp.atk && !stunned && !p.shop) basicAttack(p);

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
        if (dist(pr, t) < (t.r || PLAYER_R) + pr.r) {
          if (pr.kind !== 'fire') dealDamage(owner, t, pr.dmg, { kb: 40, from: pr, stun: pr.extra && pr.extra.stun, magic: true });
          if (pr.kind === 'poison' && isPlayer(t) && !t.dead && !inSafe(t)) {
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

  updateMobs();
  updateStones();
  updateDrops();

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
    const mlist = [];
    const slist = [];
    const glist = dropGrid.query(vx, vy, VIEW_R).map((g) => {
      const other = g.ownerChar && g.ownerChar !== me.charId && now < g.ownUntil;
      return {
        id: g.id, i: g.itemId, g: g.gold, n: g.count, p: g.plus, x: Math.round(g.x), y: Math.round(g.y),
        o: other ? g.ownerName : undefined, ot: other ? Math.ceil(g.ownUntil - now) : undefined,
        m: g.ownerChar === me.charId && now < g.ownUntil ? 1 : 0,
      };
    });
    for (const e of vis) {
      if (e.stone) {
        slist.push({ id: e.id, x: e.x, y: e.y, r: e.r, hp: Math.round(e.hp), mh: e.mh, l: e.lvl });
      } else if (e.mob) {
        mlist.push(mobView(e));
      } else if (e.dummy) {
        dlist.push({ id: e.id, x: e.x, y: e.y, hp: Math.round(e.hp), mh: e.mh, dead: e.dead, st: e.stunUntil > now });
      } else if (e === me || e.f === me.f || !hasFx(e, 'iv')) {
        // görünmez düşmanların konumu hiç gönderilmez (istemcide gizlemek yetmez: hile ile görülebilir)
        plist.push({
          id: e.id, n: e.n, c: e.cls, f: e.f, x: Math.round(e.x), y: Math.round(e.y), a: +e.angle.toFixed(2),
          hp: Math.round(e.hp), mh: e.mh, l: e.lvl, dead: e.dead, ps: !!e.poison, st: e.stunUntil > now,
          fx: e.effects.filter((x) => x.until > now).map((x) => x.id),
          sp: e.shop ? e.shop.title : undefined,
        });
      }
    }
    const msg = {
      t: 'state',
      players: plist,
      dummies: dlist,
      mobs: mlist,
      stones: slist,
      drops: glist,
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

// ---------------- EŞYA İŞLEMLERİ ----------------
const SMITH_RANGE = 170;
const CLASS_WEAPON = { savasci: 1001, golge: 1011, buyucu: 1021, saman: 1031 };

// Yeni karakterin başlangıç eşyaları
function giveStarterKit(p) {
  p.inv.push({ container: I.EQUIP, slot: I.EQUIP_SLOT.weapon, itemId: CLASS_WEAPON[p.cls], count: 1, plus: 0, attrs: I.emptyAttrs() });
  p.inv.push({ container: I.EQUIP, slot: I.EQUIP_SLOT.armor, itemId: 2001, count: 1, plus: 0, attrs: I.emptyAttrs() });
  p.inv.push({ container: I.EQUIP, slot: I.EQUIP_SLOT.helmet, itemId: 2101, count: 1, plus: 0, attrs: I.emptyAttrs() });
  I.giveItem(p.inv, 3001, 3);
  I.giveItem(p.inv, 4001, 1);
  I.giveItem(p.inv, 4002, 1);
  I.giveItem(p.inv, 5001, 3);
  I.giveItem(p.inv, 5002, 2);
  if (!p.gold) p.gold = 5000;
  saveInv(p);
  saveChar(p);
}

function sendInv(p) {
  sendTo(p, {
    t: 'inv', gold: p.gold,
    items: p.inv.map((i) => ({ c: i.container, s: i.slot, id: i.itemId, n: i.count, p: i.plus, a: i.attrs.filter((a) => a.type).map((a) => [a.type, a.value]) })),
  });
}

// Envanter kayıtları sırayla yapılır (bir önceki bitmeden sonraki başlamaz → eski veri yeniyi ezmez)
function saveInv(p) {
  const snapshot = p.inv.map((i) => ({ ...i, attrs: i.attrs.map((a) => ({ ...a })) }));
  p.saveChain = (p.saveChain || Promise.resolve())
    .then(() => db.saveInventory(p.charId, snapshot))
    .catch((e) => console.error('Envanter kayıt hatası:', e.message));
  return p.saveChain;
}

function itemChanged(p) {
  recalcStats(p);
  sendInv(p);
  saveInv(p);
}

const nearSmith = (p) => MAP.smiths.some((s) => dist(p, s) <= SMITH_RANGE);
const slotArg = (v, max) => Number.isInteger(v) && v >= 0 && v < max;

const ITEM_HANDLERS = {
  pickup(p) { pickup(p); },

  // Beceri Kitabı oku: seçilen becerinin seviyesi +1
  useBook(p, m) {
    if (!slotArg(m.slot, I.BAG_SIZE) || !SKILL_KEYS.includes(m.k)) return p.monitor.flag('invalidAction', 'useBook');
    const it = I.find(p.inv, I.BAG, m.slot);
    if (!it || it.itemId !== 6001) return;
    if (p.skillLv[m.k] >= MAX_SKILL_LV) return sendTo(p, { t: 'notice', msg: 'Bu beceri zaten en yüksek seviyede.' });
    it.count--;
    if (it.count <= 0) p.inv.splice(p.inv.indexOf(it), 1);
    p.skillLv[m.k]++;
    saveSkills(p);
    sendInv(p);
    saveInv(p);
    sendTo(p, { t: 'skills', lv: p.skillLv });
    sendTo(p, { t: 'notice', msg: `${CLASSES[p.cls].skills[m.k].name} seviye ${p.skillLv[m.k]} oldu!` });
  },

  // çantadaki eşyayı kuşan (yuvada eşya varsa yer değiştirir)
  equip(p, m) {
    if (!slotArg(m.slot, I.BAG_SIZE)) return p.monitor.flag('invalidAction', 'equip');
    const it = I.find(p.inv, I.BAG, m.slot);
    if (!it || !I.isEquip(it.itemId)) return;
    const T = I.ITEMS[it.itemId];
    if (T.cls && T.cls !== p.cls) return sendTo(p, { t: 'notice', msg: `Bu eşyayı sadece ${CLASSES[T.cls].name} kullanabilir.` });
    const es = I.EQUIP_SLOT[T.kind];
    const old = I.find(p.inv, I.EQUIP, es);
    const from = it.slot;
    it.container = I.EQUIP; it.slot = es;
    if (old) {
      // eski eşya, yenisinin boşalttığı yere (sığmazsa ilk boş yere) gider
      const to = I.canPlace(p.inv, old.itemId, from, old) ? from : I.freeSlot(p.inv, old.itemId, old);
      if (to < 0) { it.container = I.BAG; it.slot = from; return sendTo(p, { t: 'notice', msg: 'Çantada yer yok.' }); }
      old.container = I.BAG; old.slot = to;
    }
    itemChanged(p);
  },

  // m.to verilirse eşya çantada o hücreye bırakılır (sürükle-bırak)
  unequip(p, m) {
    if (!slotArg(m.slot, 3)) return p.monitor.flag('invalidAction', 'unequip');
    const it = I.find(p.inv, I.EQUIP, m.slot);
    if (!it) return;
    const to = slotArg(m.to, I.BAG_SIZE) && I.canPlace(p.inv, it.itemId, m.to) ? m.to : I.freeSlot(p.inv, it.itemId);
    if (to < 0) return sendTo(p, { t: 'notice', msg: 'Çantan dolu.' });
    it.container = I.BAG; it.slot = to;
    itemChanged(p);
  },

  // çanta içinde sürükle-bırak (taşıma / yığma)
  moveItem(p, m) {
    if (!slotArg(m.from, I.BAG_SIZE) || !slotArg(m.to, I.BAG_SIZE)) return p.monitor.flag('invalidAction', 'moveItem');
    const it = I.find(p.inv, I.BAG, m.from);
    const r = I.moveInBag(p.inv, it, m.to);
    if (r.error) { sendTo(p, { t: 'notice', msg: r.error }); return sendInv(p); }
    itemChanged(p);
  },

  // eşyayı yere at (30 sn boyunca sadece sahibi geri alabilir)
  dropItem(p, m) {
    if (!slotArg(m.slot, I.BAG_SIZE)) return p.monitor.flag('invalidAction', 'dropItem');
    if (p.dead || p.shop) return;
    const it = I.find(p.inv, I.BAG, m.slot);
    if (!it) return;
    p.inv.splice(p.inv.indexOf(it), 1);
    spawnDrops([{ id: it.itemId, count: it.count, plus: it.plus, attrs: it.attrs }], p, p, 0.25);
    itemChanged(p);
  },

  openShop(p, m) { openShop(p, m); },
  closeShop(p) { closeShop(p); },
  viewShop(p, m) { viewShop(p, m); },
  buy(p, m) { buy(p, m); },

  // demircide yükseltme: protect 0 = standart, 1 = Kutsama Parşömeni, 2 = Büyülü Metal
  upgrade(p, m) {
    if (p.dead) return;
    if (!nearSmith(p)) return sendTo(p, { t: 'upRes', error: 'Yükseltme için köydeki demirciye gitmelisin.' });
    if (![0, 1].includes(m.c) || !slotArg(m.slot, I.BAG_SIZE) || ![0, 1, 2].includes(m.protect)) return p.monitor.flag('invalidAction', 'upgrade');
    const it = I.find(p.inv, m.c, m.slot);
    if (!it) return sendTo(p, { t: 'upRes', error: 'Eşya bulunamadı.' });
    const name = I.ITEMS[it.itemId].name;
    const res = I.upgrade(p.inv, p.gold, it, m.protect);
    if (res.error) return sendTo(p, { t: 'upRes', error: res.error });
    p.gold -= res.cost;
    itemChanged(p);
    saveChar(p);
    sendTo(p, { t: 'upRes', outcome: res.outcome, from: res.from, to: res.to, name, c: m.c, slot: m.slot });
    if (res.outcome === 'success' && res.to >= 7) events.push({ t: 'sys', msg: `${p.n}, ${name} eşyasını +${res.to} yaptı!` });
  },

  // Efsun Taşı: yeni efsun ekle
  addBonus(p, m) {
    if (![0, 1].includes(m.c) || !slotArg(m.slot, I.BAG_SIZE)) return p.monitor.flag('invalidAction', 'addBonus');
    const it = I.find(p.inv, m.c, m.slot);
    if (!it || !I.isEquip(it.itemId)) return;
    if (I.bonusCount(it) >= I.MAX_BASIC_BONUS) return sendTo(p, { t: 'bonusRes', error: 'Bu eşyada zaten 5 efsun var.' });
    if (!I.takeItem(p.inv, 5001, 1)) return sendTo(p, { t: 'bonusRes', error: 'Efsun Taşın yok.' });
    const res = I.addBonus(it);
    itemChanged(p);
    sendTo(p, { t: 'bonusRes', ok: res.ok, kind: 'add', c: it.container, slot: it.slot });
  },

  // Değişim Tozu: efsunları yeniden çek
  rerollBonus(p, m) {
    if (![0, 1].includes(m.c) || !slotArg(m.slot, I.BAG_SIZE)) return p.monitor.flag('invalidAction', 'rerollBonus');
    const it = I.find(p.inv, m.c, m.slot);
    if (!it || !I.isEquip(it.itemId)) return;
    if (I.bonusCount(it) === 0) return sendTo(p, { t: 'bonusRes', error: 'Önce Efsun Taşı ile efsun eklemelisin.' });
    if (!I.takeItem(p.inv, 5002, 1)) return sendTo(p, { t: 'bonusRes', error: 'Değişim Tozun yok.' });
    I.rerollBonus(it);
    itemChanged(p);
    sendTo(p, { t: 'bonusRes', ok: true, kind: 'reroll', c: it.container, slot: it.slot });
  },
};

// ---------------- PAZAR TEZGAHI ----------------
// Satıcının eşyaları envanterde 'pazar' kabına (container 3) taşınır, fiyatlarıyla birlikte saklanır.
// SATIN ALMA NEDEN GÜVENLİ (race condition yok):
//   1) Sunucu tek iş parçacıklı bir olay döngüsünde çalışır. buy() içindeki "kontrol et → aktar" adımları
//      arada hiç beklemeden (await olmadan) tek seferde yapılır. Aynı eşyaya aynı milisaniyede iki istek gelse
//      bile biri tamamen bittikten sonra diğeri işlenir; ikinci istek eşyayı bulamaz ("satılmış") ve reddedilir.
//   2) Alıcı, gördüğü fiyatı ve eşya kimliğini isteğe ekler. Sunucudaki fiyat/eşya farklıysa satış reddedilir.
//   3) Veritabanına iki oyuncunun envanteri ve altını TEK işlemde (transaction + FOR UPDATE kilidi) yazılır.
const SHOP_MAX_PRICE = 2000000000;
const SHOP_VIEW_R = 260;

const shopItems = (p) => p.inv.filter((i) => i.container === I.SHOP).sort((a, b) => a.slot - b.slot);
const invView = (i) => ({ k: i.slot, id: i.itemId, n: i.count, p: i.plus, a: i.attrs.filter((a) => a.type).map((a) => [a.type, a.value]), price: i.price });

function shopMsg(seller) {
  return { t: 'shop', id: seller.id, title: seller.shop.title, seller: seller.n, items: shopItems(seller).map(invView) };
}

function refreshShop(seller) {
  sendTo(seller, { ...shopMsg(seller), t: 'myShop' });
  for (const vid of seller.shop.viewers) {
    const v = players.get(vid);
    if (v && dist(v, seller) <= SHOP_VIEW_R + 200) sendTo(v, shopMsg(seller));
    else seller.shop.viewers.delete(vid);
  }
}

function openShop(p, m) {
  if (p.shop) return sendTo(p, { t: 'notice', msg: 'Pazarın zaten açık.' });
  if (p.dead || !inSafe(p)) return sendTo(p, { t: 'notice', msg: 'Pazar sadece köyde (güvenli bölgede) kurulabilir.' });
  const title = String(m.title || '').trim().slice(0, 28) || `${p.n}'in Pazarı`;
  const list = Array.isArray(m.items) ? m.items : [];
  if (!list.length || list.length > I.SHOP_SIZE) return sendTo(p, { t: 'notice', msg: `Pazara 1-${I.SHOP_SIZE} eşya koyabilirsin.` });
  const picked = [];
  for (const e of list) {
    const it = e && slotArg(e.s, I.BAG_SIZE) ? I.find(p.inv, I.BAG, e.s) : null;
    const price = Number(e && e.price);
    if (!it || picked.some((x) => x.it === it)) return p.monitor.flag('invalidAction', 'openShop');
    if (!Number.isInteger(price) || price < 1 || price > SHOP_MAX_PRICE) return sendTo(p, { t: 'notice', msg: 'Fiyatlar 1 ile 2.000.000.000 altın arasında olmalı.' });
    picked.push({ it, price });
  }
  picked.forEach(({ it, price }, k) => { it.container = I.SHOP; it.slot = k; it.price = price; });
  p.shop = { title, viewers: new Set() };
  p.input.up = p.input.down = p.input.left = p.input.right = p.input.atk = false;
  itemChanged(p);
  refreshShop(p);
  events.push({ t: 'sys', msg: `${p.n} pazar kurdu: "${title}"` });
}

// Pazarı kapat: eşyalar çantaya döner. force: oyundan çıkarken (yer yoksa eşyalar pazar kabında kalır, sonraki girişte döner)
function closeShop(p, force = false) {
  if (!p.shop) return true;
  const items = shopItems(p);
  const sim = p.inv.filter((i) => i.container !== I.SHOP).map((i) => ({ ...i }));
  const places = [];
  for (const it of items) {
    const s = I.freeSlot(sim, it.itemId);
    if (s < 0 && !force) { sendTo(p, { t: 'notice', msg: 'Çantanda yer yok, pazar kapatılamadı.' }); return false; }
    if (s >= 0) sim.push({ container: I.BAG, slot: s, itemId: it.itemId, count: 1 });
    places.push(s);
  }
  items.forEach((it, i) => { if (places[i] >= 0) { it.container = I.BAG; it.slot = places[i]; it.price = null; } });
  for (const vid of p.shop.viewers) { const v = players.get(vid); if (v) sendTo(v, { t: 'shopClosed', id: p.id }); }
  p.shop = null;
  sendTo(p, { t: 'myShop', closed: true });
  itemChanged(p);
  return true;
}

// Oyun girişinde: önceki oturumdan pazar kabında kalan eşyaları çantaya geri koy
function returnShopItems(p) {
  for (const it of shopItems(p)) {
    const s = I.freeSlot(p.inv, it.itemId);
    if (s >= 0) { it.container = I.BAG; it.slot = s; it.price = null; }
  }
}

function viewShop(p, m) {
  const seller = players.get(m.id);
  if (!seller || !seller.shop) return sendTo(p, { t: 'shopClosed', id: m.id });
  if (dist(p, seller) > SHOP_VIEW_R) return sendTo(p, { t: 'notice', msg: 'Pazara biraz daha yaklaşmalısın.' });
  seller.shop.viewers.add(p.id);
  sendTo(p, shopMsg(seller));
}

function buy(p, m) {
  // --- KONTROL (beklemeden, tek seferde) ---
  const fail = (msg) => sendTo(p, { t: 'buyRes', error: msg });
  const seller = players.get(m.id);
  if (!seller || !seller.shop) return fail('Bu pazar kapandı.');
  if (seller === p) return fail('Kendi pazarından alamazsın.');
  if (p.dead || dist(p, seller) > SHOP_VIEW_R) return fail('Pazara yakın olmalısın.');
  const it = slotArg(m.k, I.SHOP_SIZE) ? I.find(seller.inv, I.SHOP, m.k) : null;
  if (!it || it.itemId !== m.itemId) return fail('Bu eşya az önce satıldı.');
  if (it.price !== m.price) return fail('Fiyat değişti, listeyi yenile.');
  const qty = I.stackMax(it.itemId) > 1 ? Number(m.qty) : it.count;
  if (!Number.isInteger(qty) || qty < 1 || qty > it.count) return fail('Geçersiz miktar.');
  const total = it.price * qty;
  if (!Number.isSafeInteger(total) || p.gold < total) return fail('Yeterli altının yok.');
  const sim = p.inv.map((i) => ({ ...i }));
  if (I.giveItem(sim, it.itemId, qty, { plus: it.plus }) > 0) return fail('Çantanda yer yok.');

  // --- AKTAR (aynı adımda) ---
  I.giveItem(p.inv, it.itemId, qty, { plus: it.plus, attrs: it.attrs.map((a) => ({ ...a })) });
  it.count -= qty;
  if (it.count <= 0) seller.inv.splice(seller.inv.indexOf(it), 1);
  p.gold -= total;
  seller.gold += total;

  // --- KAYDET (iki oyuncu tek işlemde) ---
  const snap = (x) => x.inv.map((i) => ({ ...i, attrs: i.attrs.map((a) => ({ ...a })) }));
  const parties = [{ charId: seller.charId, inv: snap(seller), gold: seller.gold }, { charId: p.charId, inv: snap(p), gold: p.gold }];
  const chain = Promise.all([p.saveChain, seller.saveChain])
    .then(() => db.saveTrade(parties))
    .catch((e) => console.error('Takas kayıt hatası:', e.message));
  p.saveChain = chain;
  seller.saveChain = chain;
  db.logSecurity(p.accountId, p.charId, 'trade', `${seller.n} -> ${p.n}: ${I.ITEMS[it.itemId].name} x${qty} = ${total}`).catch(() => {});

  const name = I.ITEMS[it.itemId].name + (it.plus ? ` +${it.plus}` : '') + (qty > 1 ? ` ×${qty}` : '');
  sendTo(p, { t: 'buyRes', ok: true, name, total });
  sendInv(p);
  sendInv(seller);
  sendTo(seller, { t: 'notice', msg: `${p.n} pazarından ${name} aldı (+${total.toLocaleString('tr-TR')} altın)` });
  if (!shopItems(seller).length) { sendTo(seller, { t: 'notice', msg: 'Pazarındaki her şey satıldı!' }); closeShop(seller, true); }
  else refreshShop(seller);
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
    const pos = c.x != null && c.y != null && c.mapId === MAP.id && !blocked({ x: c.x, y: c.y }, PLAYER_R)
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
    me.inv = await db.getInventory(c.id);
    me.saveChain = Promise.resolve();
    if (me.inv.length === 0) giveStarterKit(me);
    returnShopItems(me);
    if (I.normalize(me.inv)) saveInv(me);
    me.skillLv = { q: 1, e: 1, r: 1, f: 1 };
    for (const sk of await db.getSkills(c.id)) {
      const key = SKILL_KEYS.find((k) => SKILL_IDS[k] === sk.skillId);
      if (key) me.skillLv[key] = Math.min(MAX_SKILL_LV, Math.max(1, sk.level));
    }
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
    const mobInfo = {};
    for (const [k, t] of Object.entries(MOB_TYPES)) mobInfo[k] = { name: t.name, color: t.color, r: t.r, aggro: t.aggro, shape: t.shape };
    const itemInfo = {};
    for (const [id, t] of Object.entries(I.ITEMS)) itemInfo[id] = { name: t.name, kind: t.kind, cls: t.cls, atk: t.atk, def: t.def, hp: t.hp, desc: t.desc, stack: t.stack || 1, w: t.w || 1, h: t.h || 1 };
    const bonusInfo = {};
    for (const [id, b] of Object.entries(I.BONUSES)) bonusInfo[id] = { name: b.name, pct: b.pct };
    conn.send({
      t: 'welcome', id: me.id, map: MAP, classes: classInfo, factions: factionInfo, mobTypes: mobInfo, me: { f: me.f, cls: me.cls },
      items: itemInfo, bonuses: bonusInfo, plusMul: I.PLUS_MUL,
      upgrade: I.UPGRADE.map((u) => ({ chance: u.chance, gold: u.gold, mat: u.mat || null })),
    });
    sendInv(me);
    sendTo(me, { t: 'skills', lv: me.skillLv });
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
  closeShop(p, true);
  players.delete(p.id);
  grid.remove(p);
  saveChar(p);
  saveInv(p);
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
      if (ITEM_HANDLERS[m.t]) {
        ITEM_HANDLERS[m.t](me, m);
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
  Promise.all([...players.values()].flatMap((p) => [saveChar(p), saveInv(p)])).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------- HARİTA DEKORU (yollar, evler, ağaçlar) ----------------
// Sabit tohumlu rastgele üretim: her açılışta aynı harita. Ağaç gövdeleri ve evler gerçek engeldir.
function buildDecor() {
  let seed = 20261105;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const C = { x: MAP.w / 2, y: MAP.h / 2 };
  const segDist = (p, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, t = clamp(((p.x - x1) * dx + (p.y - y1) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
  };
  MAP.roads = MAP.villages.map((v) => [v.x, v.y, C.x, C.y]);
  const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  // her köye 4 ev: yol ve demirci yönünden uzak açılar
  MAP.houses = [];
  for (const v of MAP.villages) {
    const road = Math.atan2(C.y - v.y, C.x - v.x);
    const smith = MAP.smiths.find((s) => dist(s, v) < v.r);
    const smithA = Math.atan2(smith.y - v.y, smith.x - v.x);
    const cand = [];
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180;
      if (angDiff(a, road) > 0.8 && angDiff(a, smithA) > 0.6) cand.push(a);
    }
    for (let i = 0; i < 4; i++) {
      const a = cand[Math.floor(((i + 0.5) * cand.length) / 4)];
      MAP.houses.push({ x: Math.round(v.x + Math.cos(a) * 160), y: Math.round(v.y + Math.sin(a) * 160), r: 34, f: v.f, v: i });
    }
  }
  // ağaçlar
  MAP.trees = [];
  for (let i = 0; i < 4000 && MAP.trees.length < 95; i++) {
    const p = { x: Math.round(60 + rnd() * (MAP.w - 120)), y: Math.round(60 + rnd() * (MAP.h - 120)) };
    if (MAP.villages.some((v) => dist(p, v) < v.r + 45)) continue;
    if (MAP.rocks.some((k) => dist(p, k) < k.r + 55)) continue;
    if (STONE_SITES.some(([x, y]) => Math.hypot(p.x - x, p.y - y) < 130)) continue;
    if (SPAWN_GROUPS.some(([, x, y]) => Math.hypot(p.x - x, p.y - y) < 150)) continue;
    if (dummySpots.some(([x, y]) => Math.hypot(p.x - x, p.y - y) < 70)) continue;
    if (MAP.roads.some(([x1, y1, x2, y2]) => segDist(p, x1, y1, x2, y2) < 60)) continue;
    if (MAP.trees.some((t) => dist(p, t) < 75)) continue;
    const nearVillage = MAP.villages.some((v) => dist(p, v) < 650);
    MAP.trees.push({ x: p.x, y: p.y, k: nearVillage && rnd() < 0.55 ? 'cherry' : 'pine', s: 0.85 + rnd() * 0.4 });
  }
  MAP.solids = MAP.trees.map((t) => ({ x: t.x, y: t.y, r: 14 })).concat(MAP.houses.map((h) => ({ x: h.x, y: h.y, r: h.r })));
}
buildDecor();

db.ready.then(() => {
  setInterval(update, 1000 / TICK);
  server.listen(PORT, () => console.log(`PvP Server çalışıyor: http://localhost:${PORT} · veritabanı: ${db.kind}`));
});

// Testler için iç yapılar (oyun davranışını etkilemez)
module.exports = { mobs, players, MAP, stones, drops, grid, dropGrid, applyKnockback, updateMob, getNow: () => now };

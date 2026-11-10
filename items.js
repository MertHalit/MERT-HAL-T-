// Eşya, yükseltme (+basma) ve efsun sistemi.
// Bu dosya sadece kuralları içerir (saf fonksiyonlar). Sunucu sonuçları uygular ve envanteri
// tek işlemde (transaction) kaydeder. Rastgelelik sunucuda üretilir; istemci sonucu etkileyemez.
const crypto = require('crypto');

// Güvenli rastgele sayı [0, 1)
const rand = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;

// ---------------- EŞYA ŞABLONLARI ----------------
// kind: weapon / armor / helmet / material / scroll / bonus
// atk: hasara yüzde eklenir, def: alınan hasarı yüzde azaltır, hp: can ekler
const ITEMS = {
  1001: { name: 'Demir Kılıç', kind: 'weapon', cls: 'savasci', atk: 20, w: 1, h: 2 },
  1011: { name: 'Çelik Hançer', kind: 'weapon', cls: 'golge', atk: 18, w: 1, h: 1 },
  1021: { name: 'Ruh Palası', kind: 'weapon', cls: 'buyucu', atk: 19, w: 1, h: 2 },
  1031: { name: 'Ardıç Asası', kind: 'weapon', cls: 'saman', atk: 17, w: 1, h: 2 },
  2001: { name: 'Deri Zırh', kind: 'armor', def: 10, hp: 30, w: 2, h: 2 },
  2101: { name: 'Demir Miğfer', kind: 'helmet', def: 4, hp: 50, w: 1, h: 1 },
  3001: { name: 'Kara Demir Parçası', kind: 'material', stack: 200, w: 1, h: 1, desc: '+4 → +6 yükseltmede kullanılır' },
  3002: { name: 'Ay Taşı', kind: 'material', stack: 200, w: 1, h: 1, desc: 'Nadir malzeme: +6 → +8' },
  3003: { name: 'Kadim Pul', kind: 'material', stack: 200, w: 1, h: 1, desc: 'Güçlü canavarlardan düşer: +8 → +9' },
  4001: { name: 'Kutsama Parşömeni', kind: 'scroll', stack: 50, w: 1, h: 1, desc: 'Yükseltme başarısız olursa eşya yanmaz, 1 seviye düşer' },
  4002: { name: 'Büyülü Metal', kind: 'scroll', stack: 50, w: 1, h: 1, desc: 'Yükseltme başarısız olursa eşyanın seviyesi değişmez' },
  5001: { name: 'Efsun Taşı', kind: 'bonus', stack: 50, w: 1, h: 1, desc: 'Eşyaya yeni bir efsun ekler (en fazla 5)' },
  5002: { name: 'Değişim Tozu', kind: 'bonus', stack: 50, w: 1, h: 1, desc: 'Eşyadaki efsunları yeniden çeker' },
};
const EQUIP_KINDS = ['weapon', 'armor', 'helmet'];
const EQUIP_SLOT = { weapon: 0, armor: 1, helmet: 2 };
const BAG = 0, EQUIP = 1;
const BAG_SIZE = 30;
const isEquip = (id) => EQUIP_KINDS.includes((ITEMS[id] || {}).kind);
const stackMax = (id) => (ITEMS[id] && ITEMS[id].stack) || 1;

// +seviyeye göre temel değer çarpanı
const PLUS_MUL = [1, 1.1, 1.2, 1.32, 1.45, 1.6, 1.8, 2.05, 2.35, 2.7];

// ---------------- YÜKSELTME TABLOSU ----------------
// [şu anki seviye] → { başarı şansı, altın, gereken malzeme }
const UPGRADE = [
  { chance: 1.0, gold: 500 }, // +0 → +1
  { chance: 0.95, gold: 1000 }, // +1 → +2
  { chance: 0.9, gold: 2000 }, // +2 → +3
  { chance: 0.8, gold: 4000 }, // +3 → +4
  { chance: 0.7, gold: 7000, mat: [3001, 1] }, // +4 → +5
  { chance: 0.5, gold: 10000, mat: [3001, 2] }, // +5 → +6
  { chance: 0.4, gold: 15000, mat: [3002, 1] }, // +6 → +7
  { chance: 0.25, gold: 22000, mat: [3002, 2] }, // +7 → +8
  { chance: 0.15, gold: 30000, mat: [3003, 1] }, // +8 → +9
];
const PROTECT = { 0: null, 1: 4001, 2: 4002 }; // 0: standart demirci, 1: Kutsama Parşömeni, 2: Büyülü Metal

// ---------------- EFSUN HAVUZU (15 efsun × 5 kademe) ----------------
const BONUSES = {
  1: { key: 'hp', name: 'Maks. Can', values: [100, 200, 300, 500, 750], pct: false },
  2: { key: 'mp', name: 'Maks. Mana', values: [50, 100, 150, 250, 400], pct: false },
  3: { key: 'crit', name: 'Kritik Vuruş Şansı', values: [2, 4, 6, 10, 15], pct: true },
  4: { key: 'pierce', name: 'Delici Vuruş Şansı', values: [2, 4, 6, 10, 15], pct: true },
  5: { key: 'atkSpeed', name: 'Saldırı Hızı', values: [2, 4, 6, 10, 15], pct: true },
  6: { key: 'moveSpeed', name: 'Hareket Hızı', values: [2, 4, 6, 10, 15], pct: true },
  7: { key: 'vsMonster', name: 'Canavarlara Karşı Güç', values: [2, 4, 6, 10, 15], pct: true },
  8: { key: 'vsPlayer', name: 'Oyunculara Karşı Güç', values: [2, 4, 6, 10, 15], pct: true },
  9: { key: 'meleeDef', name: 'Kılıç Savunması', values: [2, 4, 6, 10, 15], pct: true },
  10: { key: 'magicDef', name: 'Büyü Savunması', values: [2, 4, 6, 10, 15], pct: true },
  11: { key: 'lifesteal', name: 'Can Emme', values: [2, 4, 6, 10, 15], pct: true },
  12: { key: 'manasteal', name: 'Mana Emme', values: [2, 4, 6, 10, 15], pct: true },
  13: { key: 'stun', name: 'Sersemletme Şansı', values: [2, 4, 6, 10, 15], pct: true },
  14: { key: 'str', name: 'Güç', values: [1, 2, 3, 5, 8], pct: false },
  15: { key: 'dex', name: 'Çeviklik', values: [1, 2, 3, 5, 8], pct: false },
};
// Kademe ağırlıkları: Kademe 1 çok sık, Kademe 5 çok nadir
const TIER_WEIGHTS = [40, 30, 18, 9, 3];
// Hangi eşya türüne hangi efsunlar gelebilir
const BONUS_POOL = {
  weapon: [1, 3, 4, 5, 7, 8, 11, 12, 13, 14, 15],
  armor: [1, 2, 6, 9, 10, 11, 12, 14, 15],
  helmet: [1, 2, 3, 4, 5, 9, 10, 12],
};
const MAX_BASIC_BONUS = 5; // 1-5: temel efsunlar (6-7 özel efsunlar için ayrıldı)
const ADD_BONUS_CHANCE = [1.0, 0.8, 0.6, 0.4, 0.25]; // 1., 2., ... 5. efsunu ekleme şansı

// Ağırlıklı rastgele seçim
function weightedPick(weights, r = rand()) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < weights.length; i++) {
    if ((x -= weights[i]) < 0) return i;
  }
  return weights.length - 1;
}
const rollTier = () => weightedPick(TIER_WEIGHTS); // 0..4

// Havuzdan TEKRARSIZ n efsun seç (kısmi Fisher-Yates karıştırma)
function pickUnique(pool, n, exclude = []) {
  const arr = pool.filter((id) => !exclude.includes(id));
  const out = [];
  for (let i = 0; i < n && i < arr.length; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
    out.push(arr[i]);
  }
  return out;
}

const emptyAttrs = () => Array.from({ length: 7 }, () => ({ type: 0, value: 0 }));
const bonusCount = (item) => item.attrs.slice(0, MAX_BASIC_BONUS).filter((a) => a.type).length;

function makeBonus(type) {
  const tier = rollTier();
  return { type, value: BONUSES[type].values[tier] };
}

// Efsun Arttırma: boş bir yuvaya, eşyada olmayan rastgele bir efsun ekler
function addBonus(item) {
  const kind = ITEMS[item.itemId].kind;
  const have = item.attrs.filter((a) => a.type).map((a) => a.type);
  const n = bonusCount(item);
  if (n >= MAX_BASIC_BONUS) return { ok: false, reason: 'full' };
  if (rand() >= ADD_BONUS_CHANCE[n]) return { ok: false, reason: 'fail' };
  const [type] = pickUnique(BONUS_POOL[kind], 1, have);
  if (!type) return { ok: false, reason: 'full' };
  item.attrs[n] = makeBonus(type);
  return { ok: true };
}

// Efsun Değiştirme: efsun sayısı aynı kalır, hepsi tekrarsız olarak yeniden çekilir
function rerollBonus(item) {
  const kind = ITEMS[item.itemId].kind;
  const n = bonusCount(item);
  if (n === 0) return { ok: false, reason: 'none' };
  const types = pickUnique(BONUS_POOL[kind], n);
  for (let i = 0; i < MAX_BASIC_BONUS; i++) item.attrs[i] = i < n ? makeBonus(types[i]) : { type: 0, value: 0 };
  return { ok: true };
}

// ---------------- ENVANTER YARDIMCILARI ----------------
const find = (inv, container, slot) => inv.find((i) => i.container === container && i.slot === slot);
const countOf = (inv, itemId) => inv.filter((i) => i.container === BAG && i.itemId === itemId).reduce((a, i) => a + i.count, 0);

function freeSlot(inv) {
  for (let s = 0; s < BAG_SIZE; s++) if (!find(inv, BAG, s)) return s;
  return -1;
}

// Çantaya eşya ekle (yığılabilenleri mevcut yığınlara ekler). Sığmayan miktarı döndürür.
function giveItem(inv, itemId, count = 1, extra = {}) {
  const max = stackMax(itemId);
  if (max > 1) {
    for (const it of inv) {
      if (count <= 0) break;
      if (it.container === BAG && it.itemId === itemId && it.count < max) {
        const add = Math.min(max - it.count, count);
        it.count += add;
        count -= add;
      }
    }
  }
  while (count > 0) {
    const slot = freeSlot(inv);
    if (slot < 0) break;
    const add = Math.min(max, count);
    inv.push({ container: BAG, slot, itemId, count: add, plus: extra.plus || 0, attrs: extra.attrs || emptyAttrs() });
    count -= add;
  }
  return count;
}

// Çantadan belirli miktar eşya tüket (önce kontrol edilmeli)
function takeItem(inv, itemId, count) {
  if (countOf(inv, itemId) < count) return false;
  for (const it of inv.filter((i) => i.container === BAG && i.itemId === itemId)) {
    const t = Math.min(it.count, count);
    it.count -= t;
    count -= t;
    if (count <= 0) break;
  }
  for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
  return true;
}

// ---------------- YÜKSELTME ----------------
// Sonuç: success (seviye +1) / destroyed (eşya yandı) / downgraded (seviye -1) / kept (değişmedi)
function upgrade(inv, gold, item, protect = 0) {
  const T = ITEMS[item.itemId];
  if (!T || !isEquip(item.itemId)) return { error: 'Bu eşya yükseltilemez.' };
  if (item.plus >= 9) return { error: 'Eşya zaten en yüksek seviyede (+9).' };
  const step = UPGRADE[item.plus];
  if (gold < step.gold) return { error: `Yeterli altının yok (${step.gold} gerekli).` };
  if (step.mat && countOf(inv, step.mat[0]) < step.mat[1]) return { error: `${ITEMS[step.mat[0]].name} ×${step.mat[1]} gerekli.` };
  const prot = PROTECT[protect];
  if (protect && !prot) return { error: 'Geçersiz koruma seçimi.' };
  if (prot && countOf(inv, prot) < 1) return { error: `${ITEMS[prot].name} yok.` };

  // bedeller her durumda ödenir
  if (step.mat) takeItem(inv, step.mat[0], step.mat[1]);
  if (prot) takeItem(inv, prot, 1);
  const cost = step.gold;

  const from = item.plus;
  if (rand() < step.chance) {
    item.plus++;
    return { outcome: 'success', from, to: item.plus, cost };
  }
  if (protect === 2) return { outcome: 'kept', from, to: from, cost };
  if (protect === 1) {
    item.plus = Math.max(0, item.plus - 1);
    return { outcome: 'downgraded', from, to: item.plus, cost };
  }
  const idx = inv.indexOf(item);
  if (idx >= 0) inv.splice(idx, 1);
  return { outcome: 'destroyed', from, to: -1, cost };
}

// ---------------- KUŞANILMIŞ EŞYALARIN TOPLAM ETKİSİ ----------------
function equipStats(inv) {
  const out = { atk: 0, def: 0, hp: 0, bonus: {} };
  for (const it of inv) {
    if (it.container !== EQUIP) continue;
    const T = ITEMS[it.itemId];
    if (!T) continue;
    const m = PLUS_MUL[it.plus] || 1;
    out.atk += (T.atk || 0) * m;
    out.def += (T.def || 0) * m;
    out.hp += Math.round((T.hp || 0) * m);
    for (const a of it.attrs) {
      if (!a.type || !BONUSES[a.type]) continue;
      const k = BONUSES[a.type].key;
      out.bonus[k] = (out.bonus[k] || 0) + a.value;
    }
  }
  return out;
}

module.exports = {
  ITEMS, BONUSES, UPGRADE, TIER_WEIGHTS, BONUS_POOL, PLUS_MUL, BAG, EQUIP, BAG_SIZE, EQUIP_SLOT, MAX_BASIC_BONUS,
  isEquip, stackMax, find, countOf, freeSlot, giveItem, takeItem, upgrade, addBonus, rerollBonus, equipStats,
  weightedPick, pickUnique, emptyAttrs, bonusCount,
};

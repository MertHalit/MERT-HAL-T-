// Ganimet tabloları (Loot Table).
// Her tablo: garanti altın aralığı + bağımsız şanslı eşya satırları + "en az şu kadar eşya" garantisi.
// roll() sadece NE düşeceğini hesaplar; yere saçma ve sahiplik sunucuda yapılır.
const crypto = require('crypto');

const rand = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));

class LootTable {
  // entries: [{ id, chance, min, max, plus: [enAz, enÇok] }]
  constructor({ gold = [0, 0], goldPiles = 1, entries = [], minDrops = 0 }) {
    this.gold = gold;
    this.goldPiles = goldPiles;
    this.entries = entries;
    this.minDrops = minDrops;
  }

  roll() {
    const out = [];
    for (const e of this.entries) {
      if (rand() < e.chance) out.push(this.make(e));
    }
    // garanti: yeterli eşya çıkmadıysa ağırlıklı olarak (şansa göre) ekle
    const total = this.entries.reduce((a, e) => a + e.chance, 0);
    while (out.length < this.minDrops && total > 0) {
      let x = rand() * total;
      const e = this.entries.find((en) => (x -= en.chance) < 0) || this.entries[this.entries.length - 1];
      out.push(this.make(e));
    }
    if (this.gold[1] > 0) {
      const g = randInt(this.gold[0], this.gold[1]);
      const piles = Math.max(1, this.goldPiles);
      for (let i = 0; i < piles; i++) out.push({ gold: Math.max(1, Math.round(g / piles)) });
    }
    return out;
  }

  make(e) {
    return { id: e.id, count: randInt(e.min || 1, e.max || 1), plus: e.plus ? randInt(e.plus[0], e.plus[1]) : 0 };
  }
}

const W = [1001, 1011, 1021, 1031]; // sınıf silahları

const TABLES = {
  // ---- canavarlar ----
  tilki: new LootTable({ gold: [3, 10] }),
  kurt: new LootTable({ gold: [12, 30], entries: [{ id: 3001, chance: 0.08 }] }),
  domuz: new LootTable({ gold: [25, 55], entries: [{ id: 3001, chance: 0.15 }, { id: 5001, chance: 0.02 }] }),
  haydut: new LootTable({
    gold: [50, 110],
    entries: [{ id: 3001, chance: 0.2 }, { id: 3002, chance: 0.04 }, { id: 4001, chance: 0.03 }, { id: 5001, chance: 0.03 }, { id: 5002, chance: 0.02 }, { id: 6001, chance: 0.02 }],
  }),
  ayi: new LootTable({
    gold: [150, 300],
    entries: [{ id: 3002, chance: 0.15 }, { id: 3003, chance: 0.06 }, { id: 4002, chance: 0.05 }, { id: 5001, chance: 0.08 }, { id: 5002, chance: 0.06 }, { id: 6001, chance: 0.05 }],
  }),

  // ---- Bozulma Taşları ----
  tas5: new LootTable({
    gold: [400, 800], goldPiles: 3, minDrops: 3,
    entries: [
      { id: 3001, chance: 0.7, min: 1, max: 3 }, { id: 4001, chance: 0.25 }, { id: 5001, chance: 0.35 }, { id: 5002, chance: 0.2 },
      { id: 6001, chance: 0.3 }, { id: 2001, chance: 0.1, plus: [0, 2] }, { id: 2101, chance: 0.1, plus: [0, 2] },
      ...W.map((id) => ({ id, chance: 0.04, plus: [0, 2] })),
    ],
  }),
  tas10: new LootTable({
    gold: [1200, 2200], goldPiles: 4, minDrops: 4,
    entries: [
      { id: 3001, chance: 0.8, min: 2, max: 4 }, { id: 3002, chance: 0.35 }, { id: 4001, chance: 0.35 }, { id: 4002, chance: 0.15 },
      { id: 5001, chance: 0.5, min: 1, max: 2 }, { id: 5002, chance: 0.35 }, { id: 6001, chance: 0.45 },
      { id: 2001, chance: 0.15, plus: [1, 3] }, { id: 2101, chance: 0.15, plus: [1, 3] },
      ...W.map((id) => ({ id, chance: 0.06, plus: [1, 3] })),
    ],
  }),
  tas15: new LootTable({
    gold: [3000, 5000], goldPiles: 5, minDrops: 5,
    entries: [
      { id: 3002, chance: 0.6, min: 1, max: 2 }, { id: 3003, chance: 0.25 }, { id: 4001, chance: 0.5 }, { id: 4002, chance: 0.3 },
      { id: 5001, chance: 0.6, min: 1, max: 3 }, { id: 5002, chance: 0.5, min: 1, max: 2 }, { id: 6001, chance: 0.6, min: 1, max: 2 },
      { id: 2001, chance: 0.2, plus: [2, 4] }, { id: 2101, chance: 0.2, plus: [2, 4] },
      ...W.map((id) => ({ id, chance: 0.08, plus: [2, 4] })),
    ],
  }),
};

module.exports = { LootTable, TABLES };

// Hile koruması.
//
// TEMEL KURAL: İstemci (oyuncunun bilgisayarı/telefonu) hiçbir sonuca karar vermez.
//   - İstemci "konumum şu" demez, sadece "ileri tuşuna basıyorum" der. Konumu sunucu hesaplar.
//     Bu yüzden hız hilesi, ışınlanma ve duvardan geçme baştan imkânsızdır.
//   - İstemci "vurdum, 500 hasar" demez, sadece "saldırı tuşuna basıyorum" der. Saldırı hızı,
//     menzil, hasar ve bekleme süreleri sunucuda hesaplanır.
//   - Eşya kullanımı, yükseltme, alışveriş: hepsi sunucuda doğrulanır.
//
// Bu dosyadaki ek katmanlar:
//   1) Paket sınırlayıcı (token bucket): saniyede çok fazla paket gönderen istemciyi yavaşlatır.
//   2) Eylem bekleme süresi (ActionGate): her eylemin sunucu saatine göre en kısa aralığı.
//   3) Hareket denetçisi: sunucunun kendi hesapladığı hareketin bile sınırı aşmadığını kontrol eder
//      (hata ya da istismar durumunda oyuncuyu son geçerli konuma geri çeker).
//   4) İhlal puanı: şüpheli davranışlar puan biriktirir; sınır aşılınca kayıt tutulur ve oyuncu atılır.

// ---------------- 1) Paket sınırlayıcı ----------------
class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  take(n = 1) {
    const t = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// Mesaj türüne göre sınırlar (saniyedeki ortalama, anlık en fazla)
const LIMITS = {
  input: [45, 70], // istemci saniyede ~30 gönderir
  skill: [8, 12],
  chat: [1.5, 4],
  auth: [0.5, 5], // giriş/kayıt/karakter işlemleri
  item: [10, 15],
  other: [10, 20],
};
const CATEGORY = {
  input: 'input', skill: 'skill', chat: 'chat',
  register: 'auth', login: 'auth', token: 'auth', create: 'auth', remove: 'auth', play: 'auth', leave: 'auth', logout: 'auth',
  useItem: 'item', moveItem: 'item', upgrade: 'item', equip: 'item', unequip: 'item', addBonus: 'item', rerollBonus: 'item',
};

// ---------------- 2) Eylem bekleme süresi ----------------
// Sunucu saati (oyun zamanı) ile çalışır; istemcinin gönderdiği zaman damgalarına asla güvenilmez.
class ActionGate {
  constructor() { this.next = new Map(); }
  // Eylem şu an yapılabilir mi? Yapılabiliyorsa bekleme süresini başlatır.
  tryUse(action, now, cooldown) {
    const n = this.next.get(action) || 0;
    if (now < n) return false;
    this.next.set(action, now + cooldown);
    return true;
  }
  remaining(action, now) { return Math.max(0, (this.next.get(action) || 0) - now); }
  reset(action) { this.next.delete(action); }
}

// ---------------- 3) Hareket denetçisi ----------------
// Her tick'te: izin verilen en fazla yol = hız × geçen süre × tolerans (+ atılma becerisi).
const MOVE_TOLERANCE = 1.15;
function auditMove(p, prevX, prevY, dt, maxSpeed) {
  const moved = Math.hypot(p.x - prevX, p.y - prevY);
  const allowed = maxSpeed * dt * MOVE_TOLERANCE + 2; // +2 px: çarpışma itmesi payı
  if (moved <= allowed) return true;
  p.x = prevX; // son geçerli konuma geri çek
  p.y = prevY;
  return false;
}

// ---------------- 4) İhlal puanı ----------------
const VIOLATION = {
  rate: 1, // paket sınırı aşıldı
  badPacket: 5, // bozuk veya beklenmeyen paket
  speed: 10, // hareket denetimi başarısız
  invalidAction: 3, // sahip olmadığı eşya, menzil dışı vb.
};
const KICK_SCORE = 60;
const DECAY_PER_SEC = 2;

class CheatMonitor {
  constructor(onKick, onLog) {
    this.buckets = {};
    this.score = 0;
    this.last = Date.now();
    this.onKick = onKick;
    this.onLog = onLog;
    this.logged = {};
    this.kicked = false;
  }

  // Paket gelince çağrılır; false dönerse paket işlenmez.
  allow(type) {
    const cat = CATEGORY[type] || 'other';
    if (!this.buckets[cat]) this.buckets[cat] = new TokenBucket(...LIMITS[cat]);
    if (this.buckets[cat].take()) return true;
    this.flag('rate', cat);
    return false;
  }

  flag(kind, detail) {
    const t = Date.now();
    this.score = Math.max(0, this.score - ((t - this.last) / 1000) * DECAY_PER_SEC);
    this.last = t;
    this.score += VIOLATION[kind] || 1;
    // aynı türü dakikada en fazla bir kez kaydet (veritabanını şişirmemek için)
    if (!this.logged[kind] || t - this.logged[kind] > 60000) {
      this.logged[kind] = t;
      this.onLog(kind, detail);
    }
    if (this.score >= KICK_SCORE && !this.kicked) {
      this.kicked = true;
      this.onKick(kind);
    }
  }
}

module.exports = { TokenBucket, ActionGate, CheatMonitor, auditMove };

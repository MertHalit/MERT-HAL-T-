// PvP Server - grafik motoru
// Bütün görseller kodla çizilir (dış çizim dosyası yok). Zemin, parçalar (chunk) halinde bir kez çizilip
// önbelleğe alınır; karakterler, ağaçlar ve evler her karede derinliğe (y) göre sıralanarak çizilir.
// client.js'deki ortak değişkenleri kullanır: ctx, W, H, DPR, ZOOM, state, view, myId, myFaction, MAP, CLASSES,
// FACTIONS, MOBT, floaters, swings, rings, booms, sparks, hpBar, stars.
window.gfx = (() => {
  const CHUNK = 512;
  const chunks = new Map();
  let chunkScale = 1;
  let mapRef = null;
  const anim = new Map(); // id -> { x, y, phase, moving, face }
  let hits = []; // vuruş kıvılcımları
  let shake = 0;

  // ---------------- YARDIMCILAR ----------------
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (x, y) => (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)) >>> 0;
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
  function ellipse(g, x, y, rx, ry, fill) { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill(); }
  function circle(g, x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  function rrect(g, x, y, w, h, r, fill) {
    g.fillStyle = fill; g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
    g.closePath(); g.fill();
  }
  const segDist = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };

  // ---------------- ZEMİN (önbellekli parçalar) ----------------
  function init(map) {
    mapRef = map;
    chunks.clear();
    anim.clear();
    hits = [];
    chunkScale = Math.min(window.devicePixelRatio || 1, 1.5);
  }

  function getChunk(cx, cy) {
    const key = cx + ',' + cy;
    let c = chunks.get(key);
    if (c) { chunks.delete(key); chunks.set(key, c); return c; }
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(CHUNK * chunkScale);
    const g = c.getContext('2d');
    g.scale(chunkScale, chunkScale);
    g.translate(-cx * CHUNK, -cy * CHUNK);
    drawGround(g, cx * CHUNK, cy * CHUNK);
    chunks.set(key, c);
    if (chunks.size > 24) chunks.delete(chunks.keys().next().value);
    return c;
  }

  function drawGround(g, x0, y0) {
    const M = mapRef;
    const x1 = x0 + CHUNK, y1 = y0 + CHUNK;
    // harita dışı
    g.fillStyle = '#16200f';
    g.fillRect(x0, y0, CHUNK, CHUNK);
    g.save();
    g.beginPath(); g.rect(0, 0, M.w, M.h); g.clip();
    // temel çimen: merkeze doğru daha kuru
    const cxm = M.w / 2, cym = M.h / 2;
    const grad = g.createRadialGradient(cxm, cym, 100, cxm, cym, Math.max(M.w, M.h) * 0.7);
    grad.addColorStop(0, '#6e7a3c');
    grad.addColorStop(0.5, '#56803a');
    grad.addColorStop(1, '#4a7a36');
    g.fillStyle = grad;
    g.fillRect(x0, y0, CHUNK, CHUNK);
    // yumuşak lekeler: parça sınırlarında kesilmesin diye komşu hücreler de çizilir
    const CELL = 128;
    for (let gx = Math.floor((x0 - CELL) / CELL); gx <= Math.floor((x1 + CELL) / CELL); gx++) {
      for (let gy = Math.floor((y0 - CELL) / CELL); gy <= Math.floor((y1 + CELL) / CELL); gy++) {
        const r = rng(hash(gx, gy));
        for (let i = 0; i < 3; i++) {
          const x = (gx + r()) * CELL, y = (gy + r()) * CELL, rad = 40 + r() * 90;
          const light = r() < 0.5;
          const rg = g.createRadialGradient(x, y, 0, x, y, rad);
          rg.addColorStop(0, light ? 'rgba(140,170,70,0.22)' : 'rgba(30,60,20,0.22)');
          rg.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = rg;
          g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        }
      }
    }
    // yollar
    for (const [ax, ay, bx, by] of M.roads || []) {
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(70,55,30,0.35)'; g.lineWidth = 78; line(g, ax, ay, bx, by);
      g.strokeStyle = '#8f7a52'; g.lineWidth = 64; line(g, ax, ay, bx, by);
      g.strokeStyle = '#a08a60'; g.lineWidth = 44; line(g, ax, ay, bx, by);
    }
    // çimen tutamları, çiçekler, çakıllar
    const TC = 64;
    for (let gx = Math.floor(x0 / TC) - 1; gx <= Math.floor(x1 / TC); gx++) {
      for (let gy = Math.floor(y0 / TC) - 1; gy <= Math.floor(y1 / TC); gy++) {
        const r = rng(hash(gx + 9999, gy - 777));
        const n = 3 + Math.floor(r() * 4);
        for (let i = 0; i < n; i++) {
          const x = (gx + r()) * TC, y = (gy + r()) * TC;
          const onRoad = (M.roads || []).some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) < 30);
          if (onRoad) {
            if (r() < 0.5) circle(g, x, y, 1.5 + r() * 2, r() < 0.5 ? '#7a6644' : '#b8a27a');
            continue;
          }
          const k = r();
          if (k < 0.75) { // tutam
            g.strokeStyle = r() < 0.5 ? '#3d6a2a' : '#7a9c48'; g.lineWidth = 1.5;
            g.beginPath();
            for (let b = -1; b <= 1; b++) { g.moveTo(x + b * 2, y); g.lineTo(x + b * 3 + (r() - 0.5) * 2, y - 5 - r() * 4); }
            g.stroke();
          } else if (k < 0.85) { // çiçek
            const col = ['#f4f0e0', '#f7d04a', '#e88aa8', '#b8a0f0'][Math.floor(r() * 4)];
            for (let p = 0; p < 4; p++) circle(g, x + Math.cos(p * 1.57) * 2, y + Math.sin(p * 1.57) * 2, 1.6, col);
            circle(g, x, y, 1.2, '#f2b030');
          } else if (k < 0.92) {
            circle(g, x, y, 2 + r() * 2, '#8a8a78');
            circle(g, x - 0.6, y - 0.6, 1 + r(), '#a8a898');
          }
        }
      }
    }
    // köy meydanları: taş döşeme
    for (const v of M.villages) {
      if (v.x + v.r < x0 || v.x - v.r > x1 || v.y + v.r < y0 || v.y - v.r > y1) continue;
      const col = FACTIONS && FACTIONS[v.f] ? FACTIONS[v.f].color : '#c9a26a';
      g.save();
      g.beginPath(); g.arc(v.x, v.y, v.r, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#a49a86'; g.fillRect(v.x - v.r, v.y - v.r, v.r * 2, v.r * 2);
      const TS = 28;
      for (let tx = -v.r; tx < v.r; tx += TS) {
        for (let ty = -v.r; ty < v.r; ty += TS) {
          const off = (Math.floor(ty / TS) % 2) * (TS / 2);
          const r = rng(hash(tx + v.x, ty + v.y));
          rrect(g, v.x + tx + off + 1, v.y + ty + 1, TS - 2, TS - 2, 4, shade('#a49a86', Math.floor((r() - 0.5) * 26)));
        }
      }
      g.restore();
      // kenar taşları
      g.strokeStyle = '#6a6252'; g.lineWidth = 10; g.beginPath(); g.arc(v.x, v.y, v.r - 4, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = col; g.lineWidth = 3; g.setLineDash([16, 10]); g.beginPath(); g.arc(v.x, v.y, v.r - 4, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      // merkezde krallık amblemi
      g.fillStyle = shade(col, -60) + '88';
      g.beginPath(); g.arc(v.x, v.y, 46, 0, Math.PI * 2); g.fill();
      g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.arc(v.x, v.y, 46, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(v.x, v.y, 32, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    // harita sınırı
    g.strokeStyle = '#2a3a1a'; g.lineWidth = 14; g.strokeRect(0, 0, M.w, M.h);
  }
  function line(g, ax, ay, bx, by) { g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); }

  // ---------------- DEKOR ----------------
  function drawRock(g, k) {
    const r = rng(hash(k.x, k.y));
    const pts = [];
    const n = 9;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const rad = k.r * (0.85 + r() * 0.25); pts.push([k.x + Math.cos(a) * rad, k.y + Math.sin(a) * rad * 0.8]); }
    ellipse(g, k.x + 8, k.y + k.r * 0.45, k.r * 1.05, k.r * 0.5, 'rgba(0,0,0,0.3)');
    g.fillStyle = '#5e5a52';
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y - k.r * 0.25) : g.moveTo(x, y - k.r * 0.25))); g.closePath(); g.fill();
    // üst yüz (açık)
    g.fillStyle = '#8a857a';
    g.beginPath(); pts.forEach(([x, y], i) => { const px = k.x + (x - k.x) * 0.8, py = k.y - k.r * 0.35 + (y - k.y) * 0.65; i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath(); g.fill();
    // yosun
    g.fillStyle = 'rgba(90,130,50,0.55)';
    g.beginPath(); g.ellipse(k.x - k.r * 0.2, k.y - k.r * 0.55, k.r * 0.45, k.r * 0.22, -0.3, 0, Math.PI * 2); g.fill();
    // çatlak
    g.strokeStyle = 'rgba(40,36,30,0.5)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(k.x + k.r * 0.1, k.y - k.r * 0.5); g.lineTo(k.x + k.r * 0.25, k.y - k.r * 0.1); g.lineTo(k.x + k.r * 0.15, k.y + k.r * 0.2); g.stroke();
  }

  function drawTree(g, t, tm, fade) {
    const s = t.s || 1;
    ellipse(g, t.x + 10 * s, t.y + 4, 34 * s, 13 * s, 'rgba(0,0,0,0.28)');
    // gövde
    g.fillStyle = '#5a3c22'; g.fillRect(t.x - 5 * s, t.y - 30 * s, 10 * s, 32 * s);
    g.fillStyle = '#6e4a2a'; g.fillRect(t.x - 5 * s, t.y - 30 * s, 4 * s, 32 * s);
    g.globalAlpha = fade;
    const sway = Math.sin(tm / 900 + t.x) * 1.5;
    if (t.k === 'cherry') {
      const blobs = [[0, -62, 30], [-22, -50, 22], [22, -52, 22], [-10, -78, 20], [14, -76, 20]];
      for (const [bx, by, br] of blobs) circle(g, t.x + bx * s + sway, t.y + by * s, br * s, '#d77a9a');
      for (const [bx, by, br] of blobs) circle(g, t.x + bx * s + sway - 4, t.y + by * s - 5, br * s * 0.7, '#f0a8c0');
      const r = rng(hash(t.x, t.y));
      for (let i = 0; i < 10; i++) circle(g, t.x + (r() - 0.5) * 60 * s + sway, t.y - (45 + r() * 45) * s, 2.2, '#fde0ea');
    } else {
      const layers = [[-40, 34, '#2f5a2a'], [-58, 28, '#3a6e30'], [-74, 21, '#468038'], [-87, 13, '#55923f']];
      for (const [ly, lr, col] of layers) {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(t.x + sway, t.y + (ly - lr * 0.9) * s);
        g.lineTo(t.x + lr * s + sway * 0.5, t.y + (ly + lr * 0.45) * s);
        g.lineTo(t.x - lr * s + sway * 0.5, t.y + (ly + lr * 0.45) * s);
        g.closePath(); g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  function drawHouse(g, h, tm) {
    const col = FACTIONS && FACTIONS[h.f] ? FACTIONS[h.f].color : '#a04030';
    const roof = shade(col, -70), roofHi = shade(col, -35);
    const w = 84, x = h.x, y = h.y;
    ellipse(g, x + 10, y + 6, 54, 16, 'rgba(0,0,0,0.3)');
    // taban
    g.fillStyle = '#6a6252'; g.fillRect(x - w / 2 - 4, y - 6, w + 8, 10);
    // duvar
    g.fillStyle = '#efe3c8'; g.fillRect(x - w / 2, y - 52, w, 48);
    g.strokeStyle = '#6a4a2a'; g.lineWidth = 3;
    g.strokeRect(x - w / 2, y - 52, w, 48);
    for (const px of [-w / 2 + 14, w / 2 - 14]) { g.beginPath(); g.moveTo(x + px, y - 52); g.lineTo(x + px, y - 4); g.stroke(); }
    // kapı ve pencereler
    g.fillStyle = '#6a3a1e'; g.fillRect(x - 10, y - 30, 20, 26);
    g.fillStyle = '#3a2412'; g.fillRect(x - 1, y - 30, 2, 26);
    for (const px of [-28, 28]) {
      g.fillStyle = '#f7d48a'; g.fillRect(x + px - 7, y - 42, 14, 12);
      g.strokeStyle = '#6a4a2a'; g.lineWidth = 2; g.strokeRect(x + px - 7, y - 42, 14, 12);
      g.beginPath(); g.moveTo(x + px, y - 42); g.lineTo(x + px, y - 30); g.stroke();
    }
    // pagoda çatı (uçları kalkık)
    g.fillStyle = roof;
    g.beginPath();
    g.moveTo(x - w / 2 - 22, y - 48);
    g.quadraticCurveTo(x - w / 2 - 8, y - 56, x - w / 2 + 4, y - 66);
    g.lineTo(x - 14, y - 92); g.lineTo(x + 14, y - 92);
    g.lineTo(x + w / 2 - 4, y - 66);
    g.quadraticCurveTo(x + w / 2 + 8, y - 56, x + w / 2 + 22, y - 48);
    g.lineTo(x + w / 2 + 6, y - 54); g.lineTo(x - w / 2 - 6, y - 54);
    g.closePath(); g.fill();
    // kiremit çizgileri
    g.strokeStyle = roofHi; g.lineWidth = 2;
    for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(x + i * 6, y - 90); g.lineTo(x + i * 16, y - 56); g.stroke(); }
    g.fillStyle = shade(col, -90); g.fillRect(x - 18, y - 96, 36, 6);
    circle(g, x, y - 99, 4, '#e8b04a');
  }

  function lanterns(v) {
    const out = [];
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.26; out.push({ x: v.x + Math.cos(a) * (v.r - 22), y: v.y + Math.sin(a) * (v.r - 22) }); }
    return out;
  }
  function drawLantern(g, l, tm) {
    g.fillStyle = '#3a2a1a'; g.fillRect(l.x - 2, l.y - 34, 4, 34);
    g.fillRect(l.x - 8, l.y - 36, 16, 3);
    const flick = 0.85 + Math.sin(tm / 120 + l.x) * 0.08 + Math.sin(tm / 47 + l.y) * 0.05;
    const glow = g.createRadialGradient(l.x, l.y - 26, 2, l.x, l.y - 26, 46 * flick);
    glow.addColorStop(0, 'rgba(255,190,90,0.45)'); glow.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(l.x, l.y - 26, 46 * flick, 0, Math.PI * 2); g.fill();
    rrect(g, l.x - 6, l.y - 33, 12, 15, 5, '#d9442a');
    g.fillStyle = `rgba(255,220,140,${0.6 * flick})`; g.fillRect(l.x - 3, l.y - 30, 6, 9);
  }

  function drawBanner(g, v, tm) {
    const col = FACTIONS && FACTIONS[v.f] ? FACTIONS[v.f].color : '#c33';
    g.fillStyle = '#4a3020'; g.fillRect(v.x - 3, v.y - 110, 6, 110);
    circle(g, v.x, v.y - 112, 5, '#e8b04a');
    const wave = (i) => Math.sin(tm / 300 + i * 0.8) * 4;
    g.fillStyle = col;
    g.beginPath(); g.moveTo(v.x + 3, v.y - 106);
    for (let i = 0; i <= 5; i++) g.lineTo(v.x + 3 + i * 11, v.y - 106 + wave(i));
    for (let i = 5; i >= 0; i--) g.lineTo(v.x + 3 + i * 11, v.y - 66 + wave(i) - i * 2);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)'; circle(g, v.x + 30, v.y - 87 + wave(2.5), 8, 'rgba(255,240,200,0.85)');
  }

  // ---------------- KARAKTERLER ----------------
  const LOOK = {
    savasci: { robe: '#a8322a', trim: '#e0b040', skin: '#f0c8a0', hair: '#2a1a10', weapon: 'sword', hat: 'helm' },
    golge: { robe: '#3a2a4a', trim: '#8a5ac0', skin: '#e8c098', hair: '#1a1a1a', weapon: 'dagger', hat: 'hood' },
    buyucu: { robe: '#24508a', trim: '#7ad7ff', skin: '#f0c8a0', hair: '#3a2010', weapon: 'saber', hat: 'knot' },
    saman: { robe: '#1f7a6a', trim: '#f0e0a0', skin: '#f0cca8', hair: '#4a2a14', weapon: 'staff', hat: 'straw' },
    haydut: { robe: '#4a4a2a', trim: '#6a2a1a', skin: '#d8a880', hair: '#2a2010', weapon: 'saber', hat: 'mask' },
    demirci: { robe: '#6a4a2a', trim: '#3a2a1a', skin: '#e8b890', hair: '#4a3020', weapon: 'hammer', hat: 'band' },
  };

  // o: { look, a (bakış açısı), phase, moving, atk (0..1 ya da -1), f (krallık), alpha, scale }
  function drawHero(g, x, y, o) {
    const L = LOOK[o.look] || LOOK.savasci;
    const s = o.scale || HERO_SCALE;
    const a = o.a || 0;
    const facingUp = Math.sin(a) < -0.45;
    const flip = Math.cos(a) < 0 ? -1 : 1;
    const step = o.moving ? Math.sin(o.phase) : 0;
    const bob = o.moving ? Math.abs(Math.cos(o.phase)) * 1.5 : 0;
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    // gölge + krallık halkası
    ellipse(g, 0, 2, 16, 6, 'rgba(0,0,0,0.32)');
    if (o.f && FACTIONS[o.f]) { g.strokeStyle = FACTIONS[o.f].color + 'aa'; g.lineWidth = 2; g.beginPath(); g.ellipse(0, 2, 19, 7.5, 0, 0, Math.PI * 2); g.stroke(); }
    // bacaklar
    rrect(g, -7 + step * 2, -9, 6, 11, 2, '#2a2018');
    rrect(g, 1 - step * 2, -9, 6, 11, 2, '#2a2018');
    const by = -bob;
    const weaponBehind = facingUp;
    if (weaponBehind) drawWeapon(g, L, a, o.atk, by);
    // gövde (cüppe / zırh)
    g.fillStyle = L.robe;
    g.beginPath(); g.moveTo(-10, -10 + by); g.lineTo(-8, -26 + by); g.lineTo(8, -26 + by); g.lineTo(10, -10 + by); g.closePath(); g.fill();
    g.fillStyle = shade(L.robe, 25); g.fillRect(-8, -26 + by, 5, 15);
    // kemer (krallık rengi)
    g.fillStyle = o.f && FACTIONS[o.f] ? FACTIONS[o.f].color : L.trim; g.fillRect(-9, -15 + by, 18, 3);
    g.fillStyle = L.trim; g.fillRect(-1, -26 + by, 2, 11);
    if (o.look === 'savasci') { // omuzluklar
      ellipse(g, -9, -24 + by, 5, 4, '#9a9aa8'); ellipse(g, 9, -24 + by, 5, 4, '#9a9aa8');
    }
    if (o.look === 'demirci') { g.fillStyle = '#3a2a1a'; g.fillRect(-7, -22 + by, 14, 12); }
    // kafa
    const hy = -33 + by;
    circle(g, 0, hy, 9, L.skin);
    // saç / başlık
    if (L.hat === 'helm') {
      g.fillStyle = '#8a8a98'; g.beginPath(); g.arc(0, hy - 1, 9.5, Math.PI, 0); g.fill();
      g.fillStyle = '#e0b040'; g.fillRect(-1.5, hy - 12, 3, 6);
      g.fillStyle = '#6a6a78'; g.fillRect(-10, hy - 1, 20, 2.5);
    } else if (L.hat === 'hood') {
      g.fillStyle = L.robe; g.beginPath(); g.arc(0, hy, 10.5, Math.PI * 0.9, Math.PI * 2.1); g.fill();
      g.fillStyle = shade(L.robe, -20); g.beginPath(); g.arc(0, hy + 1, 10.5, Math.PI * 1.05, Math.PI * 1.95); g.fill();
    } else if (L.hat === 'straw') {
      g.fillStyle = L.hair; g.beginPath(); g.arc(0, hy - 1, 9, Math.PI, 0); g.fill();
      g.fillStyle = '#d8b868'; g.beginPath(); g.moveTo(-16, hy - 3); g.lineTo(0, hy - 16); g.lineTo(16, hy - 3); g.closePath(); g.fill();
      g.strokeStyle = '#a8883a'; g.lineWidth = 1; g.beginPath(); g.moveTo(-8, hy - 7); g.lineTo(8, hy - 7); g.stroke();
    } else if (L.hat === 'knot') {
      g.fillStyle = L.hair; g.beginPath(); g.arc(0, hy - 1, 9.5, Math.PI, 0); g.fill(); circle(g, 0, hy - 11, 4, L.hair);
    } else if (L.hat === 'mask') {
      g.fillStyle = L.hair; g.beginPath(); g.arc(0, hy - 1, 9.5, Math.PI, 0); g.fill();
      if (!facingUp) { g.fillStyle = '#2a1a10'; g.fillRect(-9, hy + 1, 18, 6); }
    } else if (L.hat === 'band') {
      g.fillStyle = L.hair; g.beginPath(); g.arc(0, hy - 1, 9.5, Math.PI, 0); g.fill();
      g.fillStyle = '#c8302a'; g.fillRect(-9.5, hy - 4, 19, 3);
    }
    // yüz
    if (!facingUp && L.hat !== 'hood') {
      const ex = Math.cos(a) * 3;
      circle(g, -3 + ex, hy + 1, 1.4, '#2a1a10');
      circle(g, 3 + ex, hy + 1, 1.4, '#2a1a10');
    } else if (!facingUp) {
      circle(g, -2.5 + Math.cos(a) * 3, hy + 2, 1.3, '#d0a0ff');
      circle(g, 2.5 + Math.cos(a) * 3, hy + 2, 1.3, '#d0a0ff');
    }
    if (!weaponBehind) drawWeapon(g, L, a, o.atk, by);
    g.restore();
    void flip;
  }

  function drawWeapon(g, L, a, atk, by) {
    // saldırı: silah, bakış yönünün iki yanında yay çizer
    const swing = atk >= 0 ? -1.3 + 2.6 * easeOut(atk) : 0.55;
    const ang = a + swing;
    const hx = Math.cos(a) * 9, hy = -18 + by + Math.sin(a) * 4;
    g.save();
    g.translate(hx, hy);
    g.rotate(ang);
    if (L.weapon === 'sword') {
      g.fillStyle = '#d8d8e4'; g.beginPath(); g.moveTo(4, -2.5); g.lineTo(30, -2); g.lineTo(34, 0); g.lineTo(30, 2); g.lineTo(4, 2.5); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.fillRect(6, -1, 24, 1);
      g.fillStyle = '#e0b040'; g.fillRect(2, -6, 3, 12);
      g.fillStyle = '#5a3a1e'; g.fillRect(-4, -1.5, 6, 3);
    } else if (L.weapon === 'dagger') {
      g.fillStyle = '#c8c8d8'; g.beginPath(); g.moveTo(3, -2); g.lineTo(17, 0); g.lineTo(3, 2); g.closePath(); g.fill();
      g.fillStyle = '#8a5ac0'; g.fillRect(0, -3.5, 3, 7);
      g.fillStyle = '#2a1a2a'; g.fillRect(-4, -1.2, 4, 2.4);
    } else if (L.weapon === 'saber') {
      g.strokeStyle = L.trim === '#7ad7ff' ? '#bfe8ff' : '#c8c8c8'; g.lineWidth = 3.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(4, 0); g.quadraticCurveTo(18, -6, 30, -3); g.stroke();
      if (L.trim === '#7ad7ff') { g.strokeStyle = 'rgba(122,215,255,0.45)'; g.lineWidth = 8; g.beginPath(); g.moveTo(6, 0); g.quadraticCurveTo(18, -6, 30, -3); g.stroke(); }
      g.fillStyle = '#e0b040'; g.fillRect(2, -4, 2.5, 8);
      g.fillStyle = '#3a2a1a'; g.fillRect(-4, -1.5, 6, 3);
    } else if (L.weapon === 'staff') {
      g.strokeStyle = '#7a5a30'; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-8, 0); g.lineTo(30, 0); g.stroke();
      circle(g, 32, 0, 5, '#7affd0'); circle(g, 31, -1.5, 2, '#eafff7');
      g.fillStyle = 'rgba(122,255,208,0.3)'; g.beginPath(); g.arc(32, 0, 9, 0, Math.PI * 2); g.fill();
    } else if (L.weapon === 'hammer') {
      g.fillStyle = '#5a3a1e'; g.fillRect(-2, -1.5, 20, 3);
      g.fillStyle = '#5a5a64'; g.fillRect(16, -6, 7, 12);
    }
    g.restore();
  }
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  const HERO_SCALE = 1.3;

  // ---------------- CANAVARLAR ----------------
  const BEAST = {
    tilki: { body: '#d9772b', belly: '#f6e2c8', len: 1.25, ears: 'point', tail: 'bushy', tusk: false },
    kurt: { body: '#8a8f99', belly: '#c8ccd2', len: 1.3, ears: 'point', tail: 'long', tusk: false },
    domuz: { body: '#6b4a32', belly: '#8a6448', len: 1.15, ears: 'small', tail: 'curl', tusk: true },
    ayi: { body: '#2e2620', belly: '#4a3e34', len: 1.1, ears: 'round', tail: 'none', tusk: false },
  };
  function drawBeast(g, x, y, type, r, a, phase, moving, wind, alpha) {
    const B = BEAST[type] || BEAST.kurt;
    const flip = Math.cos(a) < 0 ? -1 : 1;
    const step = moving ? Math.sin(phase) : 0;
    g.save();
    g.translate(x, y);
    g.globalAlpha = alpha;
    ellipse(g, 0, r * 0.35, r * 1.2, r * 0.42, 'rgba(0,0,0,0.3)');
    g.scale(flip, 1);
    const lean = wind ? -0.15 : 0;
    g.rotate(lean);
    const L = r * B.len, H = r * 0.62;
    // bacaklar
    g.strokeStyle = shade(B.body, -30); g.lineWidth = Math.max(3, r * 0.22); g.lineCap = 'round';
    for (const [lx, ph] of [[-L * 0.55, 0], [-L * 0.3, Math.PI], [L * 0.35, Math.PI], [L * 0.6, 0]]) {
      const sw = Math.sin(phase + ph) * (moving ? r * 0.25 : 0);
      g.beginPath(); g.moveTo(lx, -H * 0.4); g.lineTo(lx + sw, r * 0.3); g.stroke();
    }
    // kuyruk
    if (B.tail === 'bushy') {
      g.fillStyle = B.body; g.beginPath(); g.ellipse(-L - r * 0.4, -H * 0.9 + step, r * 0.6, r * 0.3, -0.5, 0, Math.PI * 2); g.fill();
      circle(g, -L - r * 0.85, -H * 1.15 + step, r * 0.18, '#fff');
    } else if (B.tail === 'long') {
      g.strokeStyle = B.body; g.lineWidth = r * 0.22; g.beginPath(); g.moveTo(-L * 0.9, -H); g.quadraticCurveTo(-L * 1.3, -H * 1.2 + step * 2, -L * 1.45, -H * 0.6); g.stroke();
    } else if (B.tail === 'curl') {
      g.strokeStyle = B.body; g.lineWidth = 2.5; g.beginPath(); g.arc(-L - 3, -H, 4, 0, Math.PI * 1.5); g.stroke();
    }
    // gövde
    g.fillStyle = B.body; g.beginPath(); g.ellipse(0, -H, L, H, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = B.belly; g.beginPath(); g.ellipse(0, -H * 0.62, L * 0.75, H * 0.38, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(B.body, 22); g.beginPath(); g.ellipse(-L * 0.15, -H * 1.35, L * 0.6, H * 0.3, 0, 0, Math.PI * 2); g.fill();
    if (type === 'domuz') { g.strokeStyle = '#3a2416'; g.lineWidth = 2; for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * r * 0.18, -H * 1.9); g.lineTo(i * r * 0.18 - 2, -H * 1.55); g.stroke(); } }
    // kafa
    const hx = L * 0.95, hy = -H * 1.25;
    circle(g, hx, hy, r * 0.5, B.body);
    g.fillStyle = shade(B.body, -15); g.beginPath(); g.ellipse(hx + r * 0.45, hy + r * 0.12, r * 0.32, r * 0.22, 0, 0, Math.PI * 2); g.fill();
    circle(g, hx + r * 0.72, hy + r * 0.08, r * 0.09, '#1a1010');
    // kulaklar
    g.fillStyle = shade(B.body, -20);
    if (B.ears === 'point') { g.beginPath(); g.moveTo(hx - r * 0.2, hy - r * 0.35); g.lineTo(hx - r * 0.05, hy - r * 0.85); g.lineTo(hx + r * 0.15, hy - r * 0.35); g.closePath(); g.fill(); }
    else if (B.ears === 'round') { circle(g, hx - r * 0.2, hy - r * 0.42, r * 0.18, shade(B.body, -10)); circle(g, hx + r * 0.2, hy - r * 0.45, r * 0.18, shade(B.body, -10)); }
    else { g.beginPath(); g.ellipse(hx - r * 0.1, hy - r * 0.45, r * 0.12, r * 0.2, -0.4, 0, Math.PI * 2); g.fill(); }
    // göz
    circle(g, hx + r * 0.2, hy - r * 0.1, r * 0.09, wind ? '#ff3a2a' : '#ffe9a0');
    if (B.tusk) { g.fillStyle = '#f4f0e0'; g.beginPath(); g.moveTo(hx + r * 0.5, hy + r * 0.25); g.lineTo(hx + r * 0.62, hy - r * 0.05); g.lineTo(hx + r * 0.42, hy + r * 0.2); g.fill(); }
    g.restore();
  }

  function drawDummy(g, d) {
    ellipse(g, d.x + 4, d.y + 14, 18, 6, 'rgba(0,0,0,0.3)');
    g.fillStyle = '#6a4626'; g.fillRect(d.x - 4, d.y - 26, 8, 42);
    g.fillRect(d.x - 20, d.y - 14, 40, 6);
    circle(g, d.x, d.y - 32, 13, '#d8b86a');
    g.strokeStyle = '#a8883a'; g.lineWidth = 2;
    g.beginPath(); g.arc(d.x, d.y - 32, 8, 0, Math.PI * 2); g.stroke();
    circle(g, d.x, d.y - 32, 3, '#c83a2a');
    g.strokeStyle = '#c8a050'; g.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(d.x - 20, d.y - 11 + i); g.lineTo(d.x - 26, d.y - 4 + i * 3); g.stroke(); }
  }

  function drawStone(g, st, tm) {
    const k = 1 - st.hp / st.mh;
    const pulse = 1 + Math.sin(tm / (220 - 150 * k)) * (0.08 + 0.2 * k);
    const R = st.r * (1.6 + 1.4 * k) * pulse;
    const glow = g.createRadialGradient(st.x, st.y - st.r * 0.5, st.r * 0.3, st.x, st.y - st.r * 0.5, R);
    glow.addColorStop(0, `rgba(190,80,255,${0.35 + 0.45 * k})`); glow.addColorStop(1, 'rgba(120,20,200,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(st.x, st.y - st.r * 0.5, R, 0, Math.PI * 2); g.fill();
    ellipse(g, st.x + 6, st.y + st.r * 0.25, st.r * 1.1, st.r * 0.38, 'rgba(0,0,0,0.35)');
    // kaide taşları
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; ellipse(g, st.x + Math.cos(a) * st.r * 0.8, st.y + Math.sin(a) * st.r * 0.3, st.r * 0.3, st.r * 0.18, '#4a4048'); }
    // kristal (üç parça)
    const sh = (dx, h, w, c1, c2) => {
      g.fillStyle = c1; g.beginPath();
      g.moveTo(st.x + dx, st.y - h); g.lineTo(st.x + dx + w, st.y - h * 0.35); g.lineTo(st.x + dx + w * 0.6, st.y + 4);
      g.lineTo(st.x + dx - w * 0.6, st.y + 4); g.lineTo(st.x + dx - w, st.y - h * 0.35); g.closePath(); g.fill();
      g.fillStyle = c2; g.beginPath(); g.moveTo(st.x + dx, st.y - h); g.lineTo(st.x + dx + w, st.y - h * 0.35); g.lineTo(st.x + dx + w * 0.6, st.y + 4); g.lineTo(st.x + dx, st.y - h * 0.2); g.closePath(); g.fill();
    };
    sh(-st.r * 0.55, st.r * 1.1, st.r * 0.35, '#3a1850', '#5a2a78');
    sh(st.r * 0.5, st.r * 1.0, st.r * 0.32, '#3a1850', '#5a2a78');
    sh(0, st.r * 1.7, st.r * 0.5, '#2a1238', '#4a1e66');
    g.strokeStyle = `rgba(230,160,255,${0.45 + 0.55 * k})`; g.lineWidth = 1.5 + 2 * k;
    g.beginPath(); g.moveTo(st.x, st.y - st.r * 1.7); g.lineTo(st.x, st.y - st.r * 0.2); g.stroke();
    const cracks = Math.floor(k * 7);
    g.strokeStyle = `rgba(255,170,255,${0.5 + 0.5 * k})`; g.lineWidth = 2;
    for (let i = 0; i < cracks; i++) {
      const a = i * 1.9, cy = st.y - st.r * (0.5 + (i % 3) * 0.3);
      g.beginPath(); g.moveTo(st.x, cy); g.lineTo(st.x + Math.cos(a) * st.r * 0.35, cy + Math.sin(a) * st.r * 0.25); g.stroke();
    }
    if (Math.random() < 0.05 + 0.6 * k) {
      const a = Math.random() * 6.28;
      sparks.push({ x: st.x + Math.cos(a) * st.r * 0.5, y: st.y - st.r + Math.sin(a) * st.r * 0.5, vx: Math.cos(a) * 40, vy: -60 - Math.random() * 80, t: tm, life: 700, col: '#e08aff' });
    }
  }

  function drawSmith(g, s, tm) {
    // örs
    ellipse(g, s.x + 30, s.y + 6, 18, 5, 'rgba(0,0,0,0.3)');
    g.fillStyle = '#3a3a42'; g.fillRect(s.x + 20, s.y - 14, 26, 8); g.fillRect(s.x + 27, s.y - 6, 12, 10);
    g.fillStyle = '#5a5a64'; g.fillRect(s.x + 20, s.y - 14, 26, 3);
    // ocak kıvılcımı
    if (Math.sin(tm / 500) > 0.85 && Math.random() < 0.5) sparks.push({ x: s.x + 34, y: s.y - 16, vx: (Math.random() - 0.5) * 90, vy: -80 - Math.random() * 60, t: tm, life: 400, col: '#ffb04a' });
    const hit = (tm % 1000) / 1000;
    drawHero(g, s.x, s.y, { look: 'demirci', a: 0, atk: hit < 0.3 ? hit / 0.3 : -1, moving: false, phase: 0 });
  }

  // ---------------- PARÇACIKLAR ----------------
  function onEvent(ev) {
    const t = performance.now();
    if (ev.t === 'dmg') {
      const n = ev.c || ev.bs ? 12 : 6;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 140;
        hits.push({ x: ev.x, y: ev.y - 16, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, t, life: 250 + Math.random() * 200, col: ev.c ? '#ffd04a' : ev.bs ? '#ff5aff' : '#fff0c0' });
      }
      if (ev.c || ev.bs) shake = Math.max(shake, 5);
    } else if (ev.t === 'lvl') {
      for (let i = 0; i < 30; i++) {
        const a = Math.random() * Math.PI * 2;
        hits.push({ x: ev.x + Math.cos(a) * 18, y: ev.y, vx: Math.cos(a) * 20, vy: -120 - Math.random() * 120, t, life: 900, col: '#ffe08a' });
      }
    } else if (ev.t === 'stoneBreak') shake = Math.max(shake, 12);
  }

  // ---------------- ANA ÇİZİM ----------------
  function updateAnim(id, x, y) {
    let s = anim.get(id);
    if (!s) { s = { x, y, phase: 0, moving: false, still: 0 }; anim.set(id, s); }
    const d = Math.hypot(x - s.x, y - s.y);
    if (d > 0.4) { s.phase += d * 0.18; s.moving = true; s.still = 0; } else if (++s.still > 4) s.moving = false;
    s.x = x; s.y = y;
    return s;
  }

  function drawWorld(cam) {
    const z = ZOOM();
    const tm = performance.now();
    let sx = 0, sy = 0;
    if (shake > 0.3) { sx = (Math.random() - 0.5) * shake; sy = (Math.random() - 0.5) * shake; shake *= 0.85; } else shake = 0;
    ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * (W / 2 - (cam.x + sx) * z), DPR * (H / 2 - (cam.y + sy) * z));
    const vw = W / z, vh = H / z;
    const vx0 = cam.x - vw / 2 - 160, vy0 = cam.y - vh / 2 - 200, vx1 = cam.x + vw / 2 + 160, vy1 = cam.y + vh / 2 + 160;
    const vis = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

    // zemin parçaları
    ctx.fillStyle = '#16200f';
    ctx.fillRect(cam.x - vw, cam.y - vh, vw * 2, vh * 2);
    for (let cx = Math.floor((cam.x - vw / 2) / CHUNK); cx <= Math.floor((cam.x + vw / 2) / CHUNK); cx++) {
      for (let cy = Math.floor((cam.y - vh / 2) / CHUNK); cy <= Math.floor((cam.y + vh / 2) / CHUNK); cy++) {
        if (cx < -1 || cy < -1 || cx * CHUNK > MAP.w + CHUNK || cy * CHUNK > MAP.h + CHUNK) continue;
        ctx.drawImage(getChunk(cx, cy), cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
      }
    }

    // yerdeki ganimet (zemin seviyesi)
    const ICONS = { 1001: '⚔️', 1011: '🗡️', 1021: '⚔️', 1031: '🪄', 2001: '🥋', 2101: '⛑️', 3001: '🪨', 3002: '🌙', 3003: '🔶', 4001: '📜', 4002: '🔩', 5001: '💎', 5002: '✨', 6001: '📘' };
    for (const gd of state.drops || []) {
      if (!vis(gd.x, gd.y)) continue;
      const bob = Math.sin(tm / 300 + gd.x) * 2;
      const glow = ctx.createRadialGradient(gd.x, gd.y + 4, 1, gd.x, gd.y + 4, 18);
      glow.addColorStop(0, gd.m ? 'rgba(255,208,74,0.55)' : gd.o ? 'rgba(255,90,70,0.35)' : 'rgba(255,255,255,0.35)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(gd.x, gd.y + 4, 18, 0, Math.PI * 2); ctx.fill();
      ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(gd.g ? '💰' : ICONS[gd.i] || '❔', gd.x, gd.y + bob - 4);
      ctx.textBaseline = 'alphabetic';
      if (gd.p) label(gd.x + 12, gd.y - 12, '+' + gd.p, '#ffd04a', 10);
      if (gd.o) label(gd.x, gd.y + 22, `${gd.o} (${gd.ot})`, '#ff9a8a', 10);
    }

    // derinliğe göre sıralanacak çizimler
    const list = [];
    const labels = [];
    const me = state.players.find((p) => p.id === myId);
    const meV = me ? view.get(me.id) || me : null;
    for (const k of MAP.rocks) if (vis(k.x, k.y)) list.push([k.y + k.r * 0.3, () => drawRock(ctx, k)]);
    for (const t of MAP.trees || []) {
      if (!vis(t.x, t.y)) continue;
      // oyuncu ağacın arkasındaysa yaprakları saydamlaştır
      const behind = meV && meV.y < t.y && meV.y > t.y - 110 && Math.abs(meV.x - t.x) < 45;
      list.push([t.y, () => drawTree(ctx, t, tm, behind ? 0.45 : 1)]);
    }
    for (const h of MAP.houses || []) if (vis(h.x, h.y)) list.push([h.y, () => drawHouse(ctx, h, tm)]);
    for (const v of MAP.villages) {
      if (vis(v.x, v.y)) {
        list.push([v.y, () => drawBanner(ctx, v, tm)]);
        labels.push(() => label(v.x, v.y + 70, FACTIONS[v.f].short.toUpperCase() + ' KÖYÜ', '#fff', 15, true));
      }
      for (const l of lanterns(v)) if (vis(l.x, l.y)) list.push([l.y, () => drawLantern(ctx, l, tm)]);
    }
    for (const s of MAP.smiths || []) if (vis(s.x, s.y)) { list.push([s.y, () => drawSmith(ctx, s, tm)]); labels.push(() => label(s.x + 10, s.y - 62, '🔨 Demirci', '#ffd04a', 12)); }
    for (const d of state.dummies) {
      if (d.dead || !vis(d.x, d.y)) continue;
      list.push([d.y, () => drawDummy(ctx, d)]);
      labels.push(() => { hpBar(d.x, d.y - 54, d.hp / d.mh, '#d8b86a'); if (d.st) stars(d.x, d.y - 62); });
    }
    for (const st of state.stones || []) {
      if (!vis(st.x, st.y)) continue;
      list.push([st.y, () => drawStone(ctx, st, tm)]);
      labels.push(() => {
        const top = st.y - st.r * 1.7 - 14;
        label(st.x, top - 10, `Sv.${st.l} Bozulma Taşı`, '#e08aff', 13);
        ctx.fillStyle = '#000a'; ctx.fillRect(st.x - 40, top - 4, 80, 7);
        ctx.fillStyle = '#b04aff'; ctx.fillRect(st.x - 39, top - 3, 78 * st.hp / st.mh, 5);
      });
    }
    for (const mb of state.mobs || []) {
      const v = view.get(mb.id) || { x: mb.x, y: mb.y };
      v.x += (mb.x - v.x) * 0.35; v.y += (mb.y - v.y) * 0.35;
      if (!vis(v.x, v.y)) continue;
      const T = MOBT[mb.t] || { name: '?', r: 18, aggro: 'semi' };
      const s = updateAnim(mb.id, v.x, v.y);
      const alpha = mb.s === 'r' ? 0.5 : 1;
      list.push([v.y, () => {
        if (mb.w) { ctx.fillStyle = `rgba(255,40,20,${0.25 + 0.15 * Math.sin(tm / 40)})`; ctx.beginPath(); ctx.ellipse(v.x, v.y, T.r + 16, (T.r + 16) * 0.45, 0, 0, Math.PI * 2); ctx.fill(); }
        if (mb.t === 'haydut') drawHero(ctx, v.x, v.y, { look: 'haydut', a: mb.a, phase: s.phase, moving: s.moving, atk: mb.w ? 0 : -1, alpha });
        else drawBeast(ctx, v.x, v.y, mb.t, T.r, mb.a, s.phase, s.moving, mb.w, alpha);
      }]);
      const top = v.y - (mb.t === 'haydut' ? 62 : T.r * 1.9 + 8);
      labels.push(() => {
        label(v.x, top - 6, `Sv.${mb.l} ${T.name}`, T.aggro === 'aggr' ? '#ff7a6a' : T.aggro === 'semi' ? '#ffd04a' : '#f0f0f0', 11);
        if (mb.hp < mb.mh || mb.s === 'c') hpBar(v.x, top, mb.hp / mb.mh, '#e0473c');
        if (mb.st) stars(v.x, top - 18);
      });
    }
    const lastSwing = {};
    for (const s of swings) lastSwing[s.id] = s;
    for (const p of state.players) {
      if (p.dead) continue;
      const v = view.get(p.id) || p;
      v.x += (p.x - v.x) * 0.35; v.y += (p.y - v.y) * 0.35;
      if (!vis(v.x, v.y)) continue;
      const s = updateAnim(p.id, v.x, v.y);
      const sw = lastSwing[p.id];
      const atk = sw ? Math.min(1, (tm - sw.t) / 180) : -1;
      const fx = p.fx || [];
      const invis = fx.includes('iv');
      list.push([v.y, () => {
        // güçlendirme auraları (ayak altında)
        for (const id of fx) {
          if (id === 'iv') continue;
          const col = FX_COLORS[id] || '#fff';
          const pr = 22 + Math.sin(tm / 160 + id.length) * 2;
          ctx.strokeStyle = col + 'aa'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.ellipse(v.x, v.y + 1, pr, pr * 0.4, 0, 0, Math.PI * 2); ctx.stroke();
        }
        if (fx.includes('sh')) { ctx.strokeStyle = 'rgba(122,184,255,0.7)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(v.x, v.y - 24, 32, 0, Math.PI * 2); ctx.stroke(); }
        drawHero(ctx, v.x, v.y, { look: p.c, a: p.a, phase: s.phase, moving: s.moving, atk, f: p.f, alpha: invis ? 0.35 : 1 });
        if (p.ps) { ctx.fillStyle = 'rgba(106,255,74,0.25)'; ctx.beginPath(); ctx.arc(v.x, v.y - 24, 22, 0, Math.PI * 2); ctx.fill(); }
      }]);
      labels.push(() => {
        const nm = `Sv.${p.l} ${p.n}`;
        label(v.x, v.y - 68, nm, p.id === myId ? '#ffd04a' : fColor(p.f), 12);
        hpBar(v.x, v.y - 63, p.hp / p.mh, p.f === myFaction ? '#4ad04a' : '#e0473c');
        if (p.st) stars(v.x, v.y - 78);
        if (p.sp) shopSign(v.x, v.y, p.sp);
      });
    }
    list.sort((a, b) => a[0] - b[0]);
    for (const [, fn] of list) fn();

    // mermiler
    for (const [x, y, k] of state.proj) {
      if (!vis(x, y)) continue;
      const col = { fire: '#ff7a1a', poison: '#6aff4a', light: '#fff27a', spirit: '#7affd0' }[k] || '#7ad7ff';
      const r = k === 'fire' ? 11 : 6;
      const gl = ctx.createRadialGradient(x, y - 18, 0, x, y - 18, r * 2.6);
      gl.addColorStop(0, '#ffffff'); gl.addColorStop(0.3, col); gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y - 18, r * 2.6, 0, Math.PI * 2); ctx.fill();
      ellipse(ctx, x, y, r, r * 0.4, 'rgba(0,0,0,0.25)');
    }

    // saldırı yayları
    for (const s of swings) {
      const p = state.players.find((x) => x.id === s.id);
      if (!p) continue;
      const v = view.get(p.id) || p;
      const k = (tm - s.t) / 180;
      if (k > 1) continue;
      ctx.strokeStyle = s.s ? `rgba(255,80,255,${0.9 * (1 - k)})` : `rgba(255,245,220,${0.8 * (1 - k)})`;
      ctx.lineWidth = s.s ? 7 : 4;
      ctx.beginPath(); ctx.arc(v.x, v.y - 20, s.r * (0.75 + k * 0.25), s.a - 0.8 + k * 0.4, s.a + 0.8 * k); ctx.stroke();
    }
    swings = swings.filter((s) => tm - s.t < 200);
    // beceri efektleri
    rings = rings.filter((gr) => tm - gr.t < gr.dur);
    for (const gr of rings) {
      const k = (tm - gr.t) / gr.dur;
      const owner = gr.id !== undefined && state.players.find((x) => x.id === gr.id);
      const o = owner ? view.get(owner.id) || owner : gr;
      if (gr.kind === 'spin') {
        ctx.strokeStyle = `rgba(255,225,160,${0.9 * (1 - k)})`; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.ellipse(o.x, o.y - 10, gr.r * (0.6 + 0.4 * k), gr.r * (0.6 + 0.4 * k) * 0.55, 0, k * 6, k * 6 + Math.PI * 1.6); ctx.stroke();
      } else if (gr.kind === 'wave') {
        ctx.fillStyle = `rgba(90,140,255,${0.45 * (1 - k)})`;
        ctx.beginPath(); ctx.moveTo(gr.x, gr.y); ctx.arc(gr.x, gr.y, gr.r * (0.4 + 0.6 * k), gr.a - gr.arc / 2, gr.a + gr.arc / 2); ctx.closePath(); ctx.fill();
      } else if (gr.kind === 'buff') {
        ctx.strokeStyle = gr.col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(o.x, o.y, 18 + gr.r * k, (18 + gr.r * k) * 0.45, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = gr.col; ctx.fillRect(o.x - 1, o.y - 50 * k - 10, 2, 14);
        ctx.globalAlpha = 1;
      }
    }
    booms = booms.filter((b) => tm - b.t < 450);
    for (const b of booms) {
      const k = (tm - b.t) / 450;
      const R = (b.small ? 35 : b.big ? 170 : 95) * (0.4 + k * 0.6);
      const gl = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, R);
      gl.addColorStop(0, b.big ? `rgba(255,200,255,${0.8 * (1 - k)})` : `rgba(255,240,180,${0.8 * (1 - k)})`);
      gl.addColorStop(0.5, b.big ? `rgba(190,80,255,${0.5 * (1 - k)})` : `rgba(255,120,30,${0.5 * (1 - k)})`);
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, Math.PI * 2); ctx.fill();
    }
    // kıvılcımlar
    sparks = sparks.filter((p) => tm - p.t < p.life);
    hits = hits.filter((p) => tm - p.t < p.life);
    for (const p of sparks.concat(hits)) {
      const dt = (tm - p.t) / 1000;
      ctx.globalAlpha = 1 - (tm - p.t) / p.life;
      ctx.fillStyle = p.col;
      ctx.fillRect(p.x + p.vx * dt - 1.5, p.y + p.vy * dt + 160 * dt * dt - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    // isimler ve can çubukları her şeyin üstünde
    for (const fn of labels) fn();
    // uçan yazılar
    floaters = floaters.filter((f) => tm - f.t < 900);
    for (const f of floaters) {
      const k = (tm - f.t) / 900;
      ctx.globalAlpha = 1 - k * k;
      const size = (f.big ? 22 : 16) * (k < 0.15 ? 0.7 + k * 2 : 1);
      ctx.font = `900 ${size}px sans-serif`; ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(f.txt, f.x, f.y - k * 45);
      ctx.fillStyle = f.col; ctx.fillText(f.txt, f.x, f.y - k * 45);
    }
    ctx.globalAlpha = 1;

    // ekran kenarı gölgelendirmesi (vinyet)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,5,0,0.45)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }

  function label(x, y, text, col, size = 12, big = false) {
    ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center';
    ctx.lineWidth = big ? 4 : 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = col; ctx.fillText(text, x, y);
  }

  function shopSign(x, y, title) {
    ctx.font = 'bold 12px sans-serif';
    const t = title.length > 18 ? title.slice(0, 17) + '…' : title;
    const tw = Math.min(160, ctx.measureText(t).width + 34);
    ctx.fillStyle = '#5a3a1e'; ctx.fillRect(x - 2, y - 102, 4, 26);
    ctx.fillStyle = '#f3e2b8'; ctx.strokeStyle = '#8a5a2a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.rect(x - tw / 2, y - 122, tw, 24); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4a2a10'; ctx.textAlign = 'center'; ctx.fillText('🏪 ' + t, x, y - 105);
  }

  return { init, drawWorld, onEvent, drawHero, drawBeast };
})();

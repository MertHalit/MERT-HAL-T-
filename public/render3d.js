// PvP Server - 3D grafik motoru (Three.js)
// Modeller: KayKit Adventurers (Kay Lousberg) ve Quaternius paketleri — hepsi CC0 (serbest kullanım).
// Sunucu 2D (piksel) koordinat kullanır; burada 1 metre = 40 piksel olarak 3D'ye çevrilir.
// client.js'deki ortak değişkenleri kullanır: state, view, myId, myFaction, MAP, CLASSES, FACTIONS, MOBT, floaters,
// swings, rings, booms, W, H, DPR, isTouch, hpBar, stars, fColor, FX_COLORS.
import * as THREE from './vendor/three.min.js';

const { GLTFLoader, SkeletonUtils } = THREE;
const S = 1 / 40; // piksel → metre
const HUMAN_H = 2.0; // karakter boyu silahla birlikte (metre)
const loader = new GLTFLoader();
const models = {}; // ad -> gltf
let clips = {}; // insan animasyonları (ortak iskelet)
let renderer, scene, camera, sun, hemi, ground, overlay;
let ready = false, building = false;
const ents = new Map(); // id -> varlık (karakter / canavar / taş / kukla / ganimet)
const fx = []; // geçici efektler
let yaw = 0, pitch = 0.82, dist = 10; // kamera
const treeInst = []; // kamerayı kapatan ağaçları gizlemek için: { meshes: [InstancedMesh], i, x, z, m: [Matrix4] }
const tmpV = new THREE.Vector3();
const ray = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let lastT = performance.now();

// ---------------- MODEL YÜKLEME ----------------
const ASSETS = {
  char_savasci: 'char_savasci', char_golge: 'char_golge', char_buyucu: 'char_buyucu', char_saman: 'char_saman', char_haydut: 'char_haydut',
  anim: 'anim_humanoid', sword: 'w_sword_1handed',
  mob_kurt: 'mob_kurt', mob_tilki: 'mob_tilki', mob_domuz: 'mob_domuz', mob_ayi: 'mob_ayi',
  pine1: 'n_PineTree_1', pine2: 'n_PineTree_2', pine3: 'n_PineTree_3', pine4: 'n_PineTree_4', pine5: 'n_PineTree_5',
  pineA1: 'n_PineTree_Autumn_1', pineA2: 'n_PineTree_Autumn_2',
  tree1: 'n_CommonTree_1', tree2: 'n_CommonTree_2', tree3: 'n_CommonTree_3', tree4: 'n_CommonTree_4', tree5: 'n_CommonTree_5',
  rock1: 'n_Rock_Moss_1', rock2: 'n_Rock_Moss_2', rock3: 'n_Rock_Moss_3', rock4: 'n_Rock_Moss_4', rock5: 'n_Rock_Moss_5', rock6: 'n_Rock_Moss_6', rock7: 'n_Rock_Moss_7',
  bush1: 'n_Bush_1', bush2: 'n_Bush_2', grass1: 'n_Grass', grass2: 'n_Grass_2', flowers: 'n_Flowers', plant1: 'n_Plant_1', plant2: 'n_Plant_2', plant3: 'n_Plant_3',
  house1: 'v_House_1', house2: 'v_House_2', house3: 'v_House_3', house4: 'v_House_4',
  well: 'v_Well', barrel: 'v_Barrel', crate: 'v_Crate', cart: 'v_Cart', market: 'v_MarketStand_1', bench: 'v_Bench_1', bonfire: 'v_Bonfire_Lit', fence: 'v_Fence',
};

async function loadAll(onProgress) {
  const keys = Object.keys(ASSETS);
  let done = 0;
  await Promise.all(keys.map(async (k) => {
    models[k] = await loader.loadAsync(`assets/${ASSETS[k]}.glb`);
    onProgress(++done / keys.length);
  }));
  clips = {};
  for (const c of models.anim.animations) clips[c.name] = c;
}

// ---------------- SAHNE ----------------
function makeRenderer() {
  const canvas = document.getElementById('game3d');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.25 : 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !isTouch;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fc4e8');
  scene.fog = new THREE.Fog('#b9d3ea', 38, 95);
  camera = new THREE.PerspectiveCamera(45, 1, 0.5, 200);
  hemi = new THREE.HemisphereLight('#dcecff', '#4b5a2c', 1.25);
  scene.add(hemi);
  sun = new THREE.DirectionalLight('#fff0d4', 2.6);
  sun.castShadow = !isTouch;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  overlay = document.getElementById('game');
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const segDist = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

// Arazi: tüm harita tek bir dokuya çizilir (yollar, köy meydanları, çimen tonları) + yakından ince çimen dokusu
function buildGround() {
  const M = MAP;
  const TW = isTouch ? 2048 : 4096, TH = Math.round((TW * M.h) / M.w);
  const k = TW / M.w;
  const c = document.createElement('canvas');
  c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(TW / 2, TH / 2, 50, TW / 2, TH / 2, TW * 0.7);
  grd.addColorStop(0, '#7a8a44'); grd.addColorStop(0.45, '#5e8c3c'); grd.addColorStop(1, '#4f8436');
  g.fillStyle = grd; g.fillRect(0, 0, TW, TH);
  const r = seeded(77);
  for (let i = 0; i < 1400; i++) {
    const x = r() * TW, y = r() * TH, rad = (30 + r() * 140) * k;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, r() < 0.5 ? 'rgba(150,180,80,0.18)' : 'rgba(30,70,25,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.lineCap = 'round';
  for (const [ax, ay, bx, by] of M.roads || []) {
    g.strokeStyle = 'rgba(80,60,30,0.35)'; g.lineWidth = 84 * k; g.beginPath(); g.moveTo(ax * k, ay * k); g.lineTo(bx * k, by * k); g.stroke();
    g.strokeStyle = '#9a8258'; g.lineWidth = 66 * k; g.stroke();
    g.strokeStyle = '#ab9468'; g.lineWidth = 40 * k; g.stroke();
  }
  for (let i = 0; i < 9000; i++) {
    const x = r() * M.w, y = r() * M.h;
    if ((M.roads || []).some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) < 30)) { g.fillStyle = r() < 0.5 ? '#7a6644' : '#c2ad85'; g.fillRect(x * k, y * k, 3 * k, 3 * k); }
  }
  for (const v of M.villages) {
    const col = FACTIONS[v.f].color;
    g.save(); g.beginPath(); g.arc(v.x * k, v.y * k, v.r * k, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#a89e88'; g.fillRect((v.x - v.r) * k, (v.y - v.r) * k, v.r * 2 * k, v.r * 2 * k);
    const TS = 26;
    for (let tx = -v.r; tx < v.r; tx += TS) for (let ty = -v.r; ty < v.r; ty += TS) {
      const off = (Math.floor(ty / TS) % 2) * (TS / 2), sh = Math.floor((r() - 0.5) * 30);
      g.fillStyle = `rgb(${168 + sh},${158 + sh},${136 + sh})`;
      g.fillRect((v.x + tx + off + 1.5) * k, (v.y + ty + 1.5) * k, (TS - 3) * k, (TS - 3) * k);
    }
    g.restore();
    g.strokeStyle = '#6a6252'; g.lineWidth = 12 * k; g.beginPath(); g.arc(v.x * k, v.y * k, (v.r - 5) * k, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = col; g.lineWidth = 4 * k; g.setLineDash([18 * k, 10 * k]); g.stroke(); g.setLineDash([]);
    g.fillStyle = col + '66'; g.beginPath(); g.arc(v.x * k, v.y * k, 50 * k, 0, Math.PI * 2); g.fill();
    g.strokeStyle = col; g.lineWidth = 4 * k; g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // ince detay (yakından çimen dokusu)
  const dc = document.createElement('canvas'); dc.width = dc.height = 256;
  const dg = dc.getContext('2d');
  dg.fillStyle = '#808080'; dg.fillRect(0, 0, 256, 256);
  const dr = seeded(5);
  for (let i = 0; i < 2600; i++) { const v = 90 + dr() * 90; dg.fillStyle = `rgb(${v},${v},${v})`; dg.fillRect(dr() * 256, dr() * 256, 1 + dr() * 2, 2 + dr() * 4); }
  const detail = new THREE.CanvasTexture(dc);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.fragmentShader = 'uniform sampler2D detailMap;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n diffuseColor.rgb *= 0.55 + 0.9 * texture2D(detailMap, vMapUv * vec2(260.0, 208.0)).r;',
    );
  };
  ground = new THREE.Mesh(new THREE.PlaneGeometry(M.w * S, M.h * S), mat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((M.w * S) / 2, 0, (M.h * S) / 2);
  ground.receiveShadow = true;
  scene.add(ground);
  // harita dışı
  const out = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshLambertMaterial({ color: '#3d5a2a' }));
  out.rotation.x = -Math.PI / 2; out.position.set((M.w * S) / 2, -0.05, (M.h * S) / 2);
  scene.add(out);
}

// Aynı modelin çok kopyası: her alt parça için tek InstancedMesh (hızlı)
function instanced(modelKey, list, { scale = 1, shadow = true, tint = null, occluder = false } = {}) {
  if (!list.length) return;
  const recs = occluder ? list.map((it) => ({ meshes: [], i: 0, x: it.x * S, z: it.y * S, m: [], hidden: false })) : null;
  const root = models[modelKey].scene;
  root.updateMatrixWorld(true);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let mat = o.material;
    if (tint && tint.match(mat)) { mat = mat.clone(); mat.color = new THREE.Color(tint.color); }
    const im = new THREE.InstancedMesh(o.geometry, mat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rot || 0);
      const s = (it.s || 1) * scale;
      sv.set(s, s, s);
      pv.set(it.x * S, 0, it.y * S);
      m4.compose(pv, q, sv).multiply(o.matrixWorld);
      im.setMatrixAt(i, m4);
      if (recs) { recs[i].meshes.push(im); recs[i].m.push(m4.clone()); recs[i].i = i; }
    });
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
  });
  if (recs) treeInst.push(...recs);
}

// Kamera ile karakter arasındaki ağaçları gizle (yoksa karakter görünmez)
const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
function updateOccluders(tx, tz) {
  const cx = camera.position.x, cz = camera.position.z;
  const dx = tx - cx, dz = tz - cz, L2 = dx * dx + dz * dz;
  const dirty = new Set();
  for (const t of treeInst) {
    const u = Math.max(0, Math.min(1, ((t.x - cx) * dx + (t.z - cz) * dz) / L2));
    const px = cx + u * dx, pz = cz + u * dz;
    const near = Math.hypot(t.x - px, t.z - pz) < 3.6 && u > 0.02 && u < 0.95;
    const nearCam = Math.hypot(t.x - cx, t.z - cz) < 5.5;
    const hide = near || nearCam;
    if (hide === t.hidden) continue;
    t.hidden = hide;
    t.meshes.forEach((im, k) => { im.setMatrixAt(t.i, hide ? zeroM : t.m[k]); dirty.add(im); });
  }
  for (const im of dirty) im.instanceMatrix.needsUpdate = true;
}

// modelin yüksekliğini ölç (ölçekleme için)
function modelSize(key) {
  const box = new THREE.Box3().setFromObject(models[key].scene);
  return box.getSize(new THREE.Vector3());
}

function buildDecor() {
  const M = MAP;
  const r = seeded(4242);
  // ağaçlar: çam ve (kiraz yerine) pembe yapraklı ağaçlar
  const pines = { pine1: [], pine2: [], pine3: [], pine4: [], pine5: [], pineA1: [], pineA2: [] };
  const trees = { tree1: [], tree2: [], tree3: [], tree4: [], tree5: [] };
  for (const t of M.trees || []) {
    const it = { x: t.x, y: t.y, s: t.s * (0.9 + r() * 0.3), rot: r() * Math.PI * 2 };
    if (t.k === 'cherry') trees['tree' + (1 + Math.floor(r() * 5))].push(it);
    else pines[r() < 0.12 ? 'pineA' + (1 + Math.floor(r() * 2)) : 'pine' + (1 + Math.floor(r() * 5))].push(it);
  }
  const pineH = modelSize('pine1').y, treeH = modelSize('tree1').y;
  for (const [k, list] of Object.entries(pines)) instanced(k, list, { scale: 7 / pineH, occluder: true });
  for (const [k, list] of Object.entries(trees)) instanced(k, list, { scale: 5.5 / treeH, occluder: true, tint: { match: (m) => /leaf|leaves|green/i.test(m.name), color: '#f2a7c3' } });
  // kayalar (sunucudaki engel yarıçapına göre)
  // kayalar: sadece yassı modeller; her model kendi boyutuna göre ölçeklenir (çap = engel çapı)
  const rocks = {};
  const flat = ['rock3', 'rock5', 'rock6', 'rock7'];
  for (const k of M.rocks) {
    const key = flat[Math.floor(r() * flat.length)];
    const sz = modelSize(key);
    (rocks[key] = rocks[key] || []).push({ x: k.x, y: k.y, s: (k.r * S * 2.2) / Math.max(sz.x, sz.z), rot: r() * 6.28 });
  }
  for (const [k, list] of Object.entries(rocks)) instanced(k, list);
  // evler: köy merkezine bakar
  const hs = modelSize('house1');
  const houses = { house1: [], house2: [], house3: [], house4: [] };
  for (const h of M.houses || []) {
    const v = M.villages.find((x) => x.f === h.f);
    const rot = Math.atan2(v.x - h.x, v.y - h.y);
    houses['house' + (1 + (h.v % 4))].push({ x: h.x, y: h.y, rot, s: (h.r * S * 2.6) / Math.max(hs.x, hs.z) });
  }
  for (const [k, list] of Object.entries(houses)) instanced(k, list, { occluder: true });
  // köy süsleri
  const props = { well: [], barrel: [], crate: [], cart: [], bench: [], bonfire: [], market: [] };
  for (const v of M.villages) {
    const smith = M.smiths.find((s) => Math.hypot(s.x - v.x, s.y - v.y) < v.r);
    props.barrel.push({ x: smith.x + 34, y: smith.y - 26 }, { x: smith.x + 48, y: smith.y - 6 });
    props.crate.push({ x: smith.x - 36, y: smith.y - 20, rot: 0.4 });
    const road = Math.atan2(M.h / 2 - v.y, M.w / 2 - v.x);
    props.bonfire.push({ x: v.x - Math.cos(road) * 85, y: v.y - Math.sin(road) * 85 });
    props.bench.push({ x: v.x - Math.cos(road) * 85 + 40, y: v.y - Math.sin(road) * 85, rot: Math.PI / 2 });
    props.cart.push({ x: v.x + Math.cos(road + 0.55) * 200, y: v.y + Math.sin(road + 0.55) * 200, rot: road + Math.PI / 2 });
    props.well.push({ x: v.x + Math.cos(road + Math.PI + 0.9) * 120, y: v.y + Math.sin(road + Math.PI + 0.9) * 120 });
  }
  const unit = (k, m) => m / Math.max(...modelSize(k).toArray());
  instanced('barrel', props.barrel, { scale: unit('barrel', 0.75) });
  instanced('crate', props.crate, { scale: unit('crate', 0.7) });
  instanced('bonfire', props.bonfire, { scale: unit('bonfire', 1.1) });
  instanced('bench', props.bench, { scale: unit('bench', 1.5) });
  instanced('cart', props.cart, { scale: unit('cart', 1.9) });
  instanced('well', props.well, { scale: unit('well', 1.8) });
  // çimen, çiçek, çalı (yollardan ve köylerden uzak)
  const deco = { grass1: [], grass2: [], flowers: [], bush1: [], bush2: [], plant1: [], plant2: [], plant3: [] };
  const keys = Object.keys(deco);
  for (let i = 0; i < (isTouch ? 900 : 2200); i++) {
    const x = 30 + r() * (M.w - 60), y = 30 + r() * (M.h - 60);
    if (M.villages.some((v) => Math.hypot(x - v.x, y - v.y) < v.r + 10)) continue;
    if ((M.roads || []).some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) < 38)) continue;
    if (M.rocks.some((k) => Math.hypot(x - k.x, y - k.y) < k.r + 10)) continue;
    const kk = keys[Math.floor(r() * r() * keys.length)];
    deco[kk].push({ x, y, rot: r() * 6.28, s: 0.7 + r() * 0.6 });
  }
  const dsz = { grass1: 0.6, grass2: 0.6, flowers: 0.6, bush1: 1.4, bush2: 1.3, plant1: 0.8, plant2: 0.8, plant3: 0.9 };
  for (const [k, list] of Object.entries(deco)) instanced(k, list, { scale: unit(k, dsz[k]), shadow: k.startsWith('bush') });
  // köy sancakları ve fenerler
  for (const v of M.villages) {
    const col = new THREE.Color(FACTIONS[v.f].color);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 8), new THREE.MeshLambertMaterial({ color: '#4a3020' }));
    pole.position.set(v.x * S, 2.1, v.y * S); pole.castShadow = true; scene.add(pole);
    const flagGeo = new THREE.PlaneGeometry(1.6, 1.0, 12, 4);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide }));
    flag.position.set(v.x * S + 0.82, 3.6, v.y * S); flag.castShadow = true; scene.add(flag);
    flag.userData.base = flagGeo.attributes.position.array.slice();
    fx.push({ kind: 'flag', mesh: flag, forever: true });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const lx = (v.x + Math.cos(a) * (v.r - 22)) * S, lz = (v.y + Math.sin(a) * (v.r - 22)) * S;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.6, 6), new THREE.MeshLambertMaterial({ color: '#3a2a1a' }));
      post.position.set(lx, 0.8, lz); scene.add(post);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.32), new THREE.MeshStandardMaterial({ color: '#d9442a', emissive: '#ff8a3a', emissiveIntensity: 1.4 }));
      lamp.position.set(lx, 1.75, lz); scene.add(lamp);
    }
  }
}

// ---------------- KARAKTERLER ----------------
const LOOKS = {
  savasci: { model: 'char_savasci', show: ['2H_Sword', 'Knight_Helmet', 'Knight_Cape'], atk: ['2H_Melee_Attack_Slice', '2H_Melee_Attack_Chop'], idle: '2H_Melee_Idle' },
  golge: { model: 'char_golge', show: ['Knife', 'Knife_Offhand', 'Rogue_Cape'], atk: ['Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'] },
  buyucu: { model: 'char_buyucu', show: ['Barbarian_Cape', 'Barbarian_Hat'], atk: ['1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Chop'], sword: true },
  saman: { model: 'char_saman', show: ['2H_Staff', 'Mage_Hat', 'Mage_Cape'], atk: ['Spellcast_Shoot'], cast: true },
  haydut: { model: 'char_haydut', show: ['Knife'], atk: ['1H_Melee_Attack_Stab', '1H_Melee_Attack_Slice_Diagonal'] },
  demirci: { model: 'char_buyucu', show: ['1H_Axe', 'Barbarian_Hat'], atk: ['1H_Melee_Attack_Chop'] },
};
const WEAPON_PARTS = /Sword|Shield|Knife|Crossbow|Throwable|Axe|Mug|Spellbook|Wand|Staff|Helmet|Hat|Cape/;

function makeHuman(look) {
  const L = LOOKS[look] || LOOKS.savasci;
  const src = models[L.model];
  const obj = SkeletonUtils.clone(src.scene);
  const mats = [];
  obj.traverse((o) => {
    if (o.isMesh) {
      if (WEAPON_PARTS.test(o.name)) o.visible = L.show.includes(o.name);
      o.castShadow = true;
      o.material = o.material.clone(); // görünmezlik için kendi malzemesi
      mats.push(o.material);
    }
  });
  if (L.sword) {
    const hand = obj.getObjectByName('handslotr') || obj.getObjectByName('handslot.r'); // Three.js adlardaki noktayı siler
    const sw = models.sword.scene.clone(true);
    sw.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color('#2a7aff'); o.material.emissiveIntensity = 0.9; o.castShadow = true; mats.push(o.material); } });
    hand.add(sw);
  }
  const size = new THREE.Box3().setFromObject(src.scene).getSize(new THREE.Vector3());
  const wrap = new THREE.Group();
  obj.scale.setScalar(HUMAN_H / size.y);
  wrap.add(obj);
  const mixer = new THREE.AnimationMixer(obj);
  return { root: wrap, mixer, mats, look: L, actions: {}, cur: null, oneShot: 0 };
}

function play(e, name, { once = false, fade = 0.15, speed = 1 } = {}) {
  const clip = e.clips ? e.clips[name] : clips[name];
  if (!clip) return;
  let a = e.actions[name];
  if (!a) { a = e.mixer.clipAction(clip); e.actions[name] = a; }
  if (once) {
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
    a.timeScale = speed;
    if (e.cur && e.cur !== a) e.cur.crossFadeTo(a, fade, false);
    a.play();
    e.cur = a;
    e.oneShot = performance.now() + (clip.duration / speed) * 1000 - fade * 1000;
    return;
  }
  if (e.cur === a) return;
  a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); a.timeScale = speed; a.play();
  if (e.cur) e.cur.crossFadeTo(a, fade, false);
  e.cur = a;
}

// ---------------- CANAVARLAR ----------------
const MOB_MODELS = { kurt: 'mob_kurt', tilki: 'mob_tilki', domuz: 'mob_domuz', ayi: 'mob_ayi' };
function makeMob(type, r) {
  if (type === 'haydut') { const h = makeHuman('haydut'); h.isHuman = true; return h; }
  const src = models[MOB_MODELS[type]];
  const obj = SkeletonUtils.clone(src.scene);
  const mats = [];
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); mats.push(o.material); } });
  const size = new THREE.Box3().setFromObject(src.scene).getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.z);
  const wrap = new THREE.Group();
  const target = type === 'ayi' ? r * S * 3.2 : r * S * 2.9; // boy (metre)
  obj.scale.setScalar(target / len);
  wrap.add(obj);
  const c = {};
  for (const cl of src.animations) c[cl.name.replace(/^.*\|/, '').replace('Spider_', '')] = cl;
  return { root: wrap, mixer: new THREE.AnimationMixer(obj), mats, clips: c, actions: {}, cur: null, oneShot: 0, type };
}

// ---------------- DİĞER VARLIKLAR ----------------
function makeStone(st) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#3a1a55', emissive: '#a040ff', emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.3, flatShading: true });
  const rr = st.r * S;
  for (const [x, z, h, w] of [[0, 0, 2.4, 0.55], [-0.55, 0.2, 1.4, 0.35], [0.5, -0.15, 1.6, 0.38], [0.15, 0.5, 1.1, 0.3]]) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), mat);
    m.scale.set(w * rr * 1.3, h * rr * 0.62, w * rr * 1.3);
    m.position.set(x * rr, h * rr * 0.5, z * rr);
    m.rotation.y = x * 3;
    m.castShadow = true;
    g.add(m);
  }
  const baseMat = new THREE.MeshLambertMaterial({ color: '#4a4048' });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.DodecahedronGeometry(rr * 0.35, 0), baseMat);
    b.position.set(Math.cos(a) * rr * 1.1, rr * 0.1, Math.sin(a) * rr * 1.1); b.castShadow = true;
    g.add(b);
  }
  const light = new THREE.PointLight('#c060ff', 6, 9, 1.6);
  light.position.y = rr * 1.4;
  g.add(light);
  return { root: g, mat, light, stone: true };
}

function makeDummy() {
  const g = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: '#6a4626' });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.7, 8), wood); post.position.y = 0.85; post.castShadow = true;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.1), wood); arm.position.y = 1.15; arm.castShadow = true;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 20), new THREE.MeshLambertMaterial({ color: '#d8b86a' }));
  head.rotation.x = Math.PI / 2; head.position.set(0, 1.5, 0.05); head.castShadow = true;
  const bull = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.13, 16), new THREE.MeshLambertMaterial({ color: '#c83a2a' }));
  bull.rotation.x = Math.PI / 2; bull.position.set(0, 1.5, 0.06);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.6, 10), new THREE.MeshLambertMaterial({ color: '#c8a050' }));
  body.position.y = 0.95; body.castShadow = true;
  g.add(post, arm, body, head, bull);
  return { root: g, dummy: true };
}

const iconCache = {};
const ICONS = { 1001: '⚔️', 1011: '🗡️', 1021: '⚔️', 1031: '🪄', 2001: '🥋', 2101: '⛑️', 3001: '🪨', 3002: '🌙', 3003: '🔶', 4001: '📜', 4002: '🔩', 5001: '💎', 5002: '✨', 6001: '📘', gold: '💰' };
function iconTex(key) {
  if (iconCache[key]) return iconCache[key];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 32); gr.addColorStop(0, 'rgba(255,240,180,0.7)'); gr.addColorStop(1, 'rgba(255,240,180,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.font = '40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ICONS[key] || '❔', 32, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return (iconCache[key] = t);
}
function makeDrop(d) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTex(d.g ? 'gold' : d.i), depthWrite: false }));
  sp.scale.set(0.8, 0.8, 0.8);
  const g = new THREE.Group(); g.add(sp);
  return { root: g, sprite: sp, drop: true };
}
function makeSmith() {
  const h = makeHuman('demirci');
  const anvil = new THREE.Group();
  const iron = new THREE.MeshStandardMaterial({ color: '#3a3a42', metalness: 0.7, roughness: 0.4 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.22, 0.35), iron); top.position.y = 0.62;
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 0.28), iron); leg.position.y = 0.26;
  top.castShadow = leg.castShadow = true;
  anvil.add(top, leg);
  anvil.position.set(0.9, 0, 0.3);
  h.root.add(anvil);
  return h;
}

// ---------------- VARLIK GÜNCELLEME ----------------
const toWorld = (x, y, h = 0) => tmpV.set(x * S, h, y * S);
const faceRot = (a) => Math.atan2(Math.cos(a), Math.sin(a)); // sunucu açısı -> modelin y dönüşü

function sync(id, make) {
  let e = ents.get(id);
  if (!e) { e = make(); e.id = id; ents.set(id, e); scene.add(e.root); e.px = null; }
  e.seen = frameNo;
  return e;
}
let frameNo = 0;

function updateEntities(dt, tm) {
  frameNo++;
  const lastSwing = {};
  for (const s of swings) lastSwing[s.id] = s;
  // oyuncular
  for (const p of state.players) {
    const v = view.get(p.id) || p;
    v.x += (p.x - v.x) * 0.3; v.y += (p.y - v.y) * 0.3;
    const e = sync('p' + p.id, () => { const h = makeHuman(p.c); h.player = true; return h; });
    e.root.position.copy(toWorld(v.x, v.y));
    const target = faceRot(p.a);
    e.root.rotation.y += Math.atan2(Math.sin(target - e.root.rotation.y), Math.cos(target - e.root.rotation.y)) * Math.min(1, dt * 14);
    const speed = e.px ? Math.hypot(v.x - e.px.x, v.y - e.px.y) / Math.max(dt, 0.001) : 0;
    e.px = { x: v.x, y: v.y };
    const inv = (p.fx || []).includes('iv');
    for (const m of e.mats) { m.transparent = inv; m.opacity = inv ? 0.3 : 1; }
    if (p.dead) {
      if (!e.dead) { e.dead = true; play(e, 'Death_A', { once: true }); }
      continue;
    } else if (e.dead) { e.dead = false; e.cur = null; }
    const sw = lastSwing[p.id];
    if (sw && sw !== e.lastSwing) { e.lastSwing = sw; const L = e.look; play(e, L.atk[Math.floor(Math.random() * L.atk.length)], { once: true, speed: 1.6, fade: 0.08 }); }
    if (performance.now() > e.oneShot) {
      if (p.sp) play(e, 'Sit_Floor_Idle');
      else if (p.st) play(e, 'Hit_A');
      else if (speed > 40) play(e, 'Running_A', { speed: Math.min(1.4, speed / 170) });
      else play(e, e.look.idle || 'Idle');
    }
    // güçlendirme halkası (ayak altı)
    syncAura(e, p.fx || []);
  }
  // canavarlar
  for (const mb of state.mobs || []) {
    const v = view.get(mb.id) || { x: mb.x, y: mb.y };
    v.x += (mb.x - v.x) * 0.3; v.y += (mb.y - v.y) * 0.3;
    const T = MOBT[mb.t] || { r: 18 };
    const e = sync(mb.id, () => makeMob(mb.t, T.r));
    e.root.position.copy(toWorld(v.x, v.y));
    const target = faceRot(mb.a);
    e.root.rotation.y += Math.atan2(Math.sin(target - e.root.rotation.y), Math.cos(target - e.root.rotation.y)) * Math.min(1, dt * 10);
    const speed = e.px ? Math.hypot(v.x - e.px.x, v.y - e.px.y) / Math.max(dt, 0.001) : 0;
    e.px = { x: v.x, y: v.y };
    for (const m of e.mats) { m.transparent = mb.s === 'r' || e.fade < 1; m.opacity = mb.s === 'r' ? 0.5 : e.fade == null ? 1 : e.fade; }
    if (mb.d) {
      if (!e.dead) { e.dead = true; e.fade = 1; play(e, e.isHuman ? 'Death_A' : 'Death', { once: true }); }
      e.fade = Math.max(0, (e.fade || 1) - dt * 0.5);
      e.root.visible = e.fade > 0.02;
      continue;
    } else if (e.dead) { e.dead = false; e.fade = 1; e.root.visible = true; e.cur = null; }
    if (mb.w && !e.wind) { e.wind = true; play(e, e.isHuman ? '1H_Melee_Attack_Stab' : e.clips && e.clips.Attack ? 'Attack' : 'Attack_Headbutt', { once: true, speed: 1.3 }); }
    if (!mb.w) e.wind = false;
    if (performance.now() > e.oneShot) {
      if (e.isHuman) play(e, speed > 30 ? 'Running_A' : 'Idle');
      else play(e, speed > 150 ? 'Gallop' : speed > 20 ? 'Walk' : 'Idle', { speed: speed > 150 ? 1 : Math.max(0.6, speed / 90) });
    }
  }
  // taşlar
  for (const st of state.stones || []) {
    const e = sync(st.id, () => makeStone(st));
    e.root.position.copy(toWorld(st.x, st.y));
    const k = 1 - st.hp / st.mh;
    const pulse = 0.5 + 0.5 * Math.sin(tm / (260 - 170 * k));
    e.mat.emissiveIntensity = 0.5 + k * 1.6 + pulse * (0.3 + k);
    e.light.intensity = 4 + k * 14 + pulse * 4;
    e.root.rotation.y += dt * (0.1 + k * 0.8);
    if (Math.random() < 0.05 + 0.5 * k) spark(st.x, st.y, 1.5 + Math.random(), '#e08aff', 1);
  }
  // kuklalar
  for (const d of state.dummies) {
    const e = sync(d.id, makeDummy);
    e.root.position.copy(toWorld(d.x, d.y));
    e.root.visible = !d.dead;
    e.root.rotation.z = d.st ? Math.sin(tm / 40) * 0.08 : e.root.rotation.z * 0.9;
  }
  // ganimet
  for (const d of state.drops || []) {
    const e = sync(d.id, () => makeDrop(d));
    e.root.position.copy(toWorld(d.x, d.y, 0.55 + Math.sin(tm / 300 + d.x) * 0.08));
  }
  // demirciler (sabit)
  for (let i = 0; i < (MAP.smiths || []).length; i++) {
    const s = MAP.smiths[i];
    const e = sync('smith' + i, makeSmith);
    e.root.position.copy(toWorld(s.x, s.y));
    e.root.rotation.y = -Math.PI / 2;
    if (performance.now() > e.oneShot) {
      if (Math.random() < 0.01) play(e, '1H_Melee_Attack_Chop', { once: true, speed: 0.9 });
      else play(e, 'Idle');
    }
  }
  // görüş alanından çıkanları sil
  for (const [id, e] of ents) {
    if (e.seen !== frameNo) {
      scene.remove(e.root);
      if (e.mixer) e.mixer.stopAllAction();
      ents.delete(id);
    }
  }
  for (const e of ents.values()) if (e.mixer) e.mixer.update(dt);
}

const auraGeo = new THREE.RingGeometry(0.55, 0.7, 40);
function syncAura(e, list) {
  const key = list.filter((x) => x !== 'iv').join(',');
  if (e.auraKey === key) return;
  e.auraKey = key;
  if (e.auras) for (const m of e.auras) e.root.remove(m);
  e.auras = [];
  list.filter((x) => x !== 'iv').forEach((id, i) => {
    const m = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({ color: FX_COLORS[id] || '#fff', transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.03 + i * 0.01; m.scale.setScalar(1 + i * 0.25);
    if (id === 'sh') { m.geometry = new THREE.SphereGeometry(1.1, 20, 14); m.rotation.x = 0; m.position.y = 0.9; m.material.opacity = 0.22; }
    e.root.add(m); e.auras.push(m);
  });
}

// ---------------- EFEKTLER ----------------
const additive = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const sparkGeo = new THREE.SphereGeometry(0.05, 4, 3);
function spark(x, y, h, color, life = 0.6) {
  const m = new THREE.Mesh(sparkGeo, additive(color));
  m.position.set(x * S, h, y * S);
  scene.add(m);
  fx.push({ kind: 'spark', mesh: m, t: 0, life, v: new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3) });
}
function onEvent(ev) {
  if (!ready) return;
  if (ev.t === 'dmg') {
    const n = ev.c || ev.bs ? 10 : 4;
    for (let i = 0; i < n; i++) spark(ev.x, ev.y, 1.1, ev.c ? '#ffd04a' : ev.bs ? '#ff5aff' : '#fff0c0', 0.45);
    // vurulan oyuncu/canavar darbe animasyonu
  } else if (ev.t === 'lvl') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 6, 24, 1, true), additive('#ffd04a', 0.6));
    m.position.set(ev.x * S, 3, ev.y * S); scene.add(m);
    fx.push({ kind: 'pillar', mesh: m, t: 0, life: 1.2 });
  } else if (ev.t === 'stoneBreak') {
    for (let i = 0; i < 50; i++) spark(ev.x, ev.y, 1 + Math.random() * 2, i % 2 ? '#b04aff' : '#ff7aff', 1.2);
    shake = 0.5;
  } else if (ev.t === 'heal') {
    for (let i = 0; i < 10; i++) spark(ev.x + (Math.random() - 0.5) * 30, ev.y + (Math.random() - 0.5) * 30, 0.4, '#6aff7a', 0.9);
  }
}
let shake = 0;

const projMeshes = [];
const projGeo = new THREE.SphereGeometry(1, 12, 8);
function updateEffects(dt, tm) {
  // mermiler
  const list = state.proj || [];
  while (projMeshes.length < list.length) { const m = new THREE.Mesh(projGeo, additive('#7ad7ff')); scene.add(m); projMeshes.push(m); }
  projMeshes.forEach((m, i) => {
    const pr = list[i];
    m.visible = !!pr;
    if (!pr) return;
    const [x, y, k] = pr;
    m.position.set(x * S, 1.2, y * S);
    m.material.color.set({ fire: '#ff7a1a', poison: '#6aff4a', light: '#fff27a', spirit: '#7affd0' }[k] || '#7ad7ff');
    m.scale.setScalar(k === 'fire' ? 0.32 : 0.16);
    if (Math.random() < 0.6) spark(x, y, 1.2, m.material.color.getStyle(), 0.3);
  });
  // vuruş yayları, kasırga, dalga, patlama, güçlendirme
  for (const s of swings) {
    if (s.r3d) continue;
    s.r3d = true;
    const p = state.players.find((x) => x.id === s.id);
    if (!p) continue;
    const v = view.get(p.id) || p;
    const arc = new THREE.Mesh(new THREE.RingGeometry(s.r * S * 0.8, s.r * S, 24, 1, -0.8, 1.6), additive(s.s ? '#ff50ff' : '#ffe2a0', 0.45));
    arc.rotation.x = -Math.PI / 2;
    arc.rotation.z = -s.a;
    arc.position.set(v.x * S, 0.9, v.y * S);
    scene.add(arc);
    fx.push({ kind: 'fade', mesh: arc, t: 0, life: 0.2 });
  }
  for (const r of rings) {
    if (r.r3d) continue;
    r.r3d = true;
    let m;
    if (r.kind === 'spin') {
      m = new THREE.Mesh(new THREE.TorusGeometry(r.r * S, 0.05, 6, 48), additive('#ffc860', 0.6));
      m.rotation.x = Math.PI / 2;
      const owner = state.players.find((x) => x.id === r.id);
      const o = owner ? view.get(owner.id) || owner : r;
      m.position.set(o.x * S, 0.8, o.y * S);
      fx.push({ kind: 'grow', mesh: m, t: 0, life: 0.3, from: 0.6, to: 1.1 });
    } else if (r.kind === 'wave') {
      m = new THREE.Mesh(new THREE.CircleGeometry(r.r * S, 24, -r.arc / 2, r.arc), additive('#5a8cff', 0.6));
      m.rotation.x = -Math.PI / 2; m.rotation.z = -r.a;
      m.position.set(r.x * S, 0.2, r.y * S);
      fx.push({ kind: 'grow', mesh: m, t: 0, life: 0.4, from: 0.4, to: 1 });
    } else if (r.kind === 'buff') {
      m = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 6, 32), additive(r.col, 0.9));
      m.rotation.x = Math.PI / 2; m.position.set(r.x * S, 0.1, r.y * S);
      fx.push({ kind: 'rise', mesh: m, t: 0, life: 0.7 });
    }
    if (m) scene.add(m);
  }
  for (const b of booms) {
    if (b.r3d) continue;
    b.r3d = true;
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), additive(b.big ? '#c060ff' : '#ff8a3a', 0.7));
    m.position.set(b.x * S, 0.6, b.y * S);
    scene.add(m);
    fx.push({ kind: 'grow', mesh: m, t: 0, life: 0.45, from: 0.3, to: (b.small ? 35 : b.big ? 170 : 95) * S });
  }
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    if (f.kind === 'flag') {
      const pos = f.mesh.geometry.attributes.position;
      const base = f.mesh.userData.base;
      for (let j = 0; j < pos.count; j++) { const x = base[j * 3]; pos.array[j * 3 + 2] = Math.sin(tm / 300 + x * 3) * 0.12 * (x + 0.8); }
      pos.needsUpdate = true;
      continue;
    }
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) { scene.remove(f.mesh); f.mesh.geometry !== sparkGeo && f.mesh.geometry.dispose(); f.mesh.material.dispose(); fx.splice(i, 1); continue; }
    if (f.kind === 'spark') { f.v.y -= 9 * dt; f.mesh.position.addScaledVector(f.v, dt); f.mesh.material.opacity = 1 - k; }
    else if (f.kind === 'fade') f.mesh.material.opacity = 0.45 * (1 - k);
    else if (f.kind === 'grow') { f.mesh.scale.setScalar(f.from + (f.to - f.from) * k); f.mesh.material.opacity = 0.6 * (1 - k); }
    else if (f.kind === 'rise') { f.mesh.position.y = 0.1 + k * 2; f.mesh.material.opacity = 0.9 * (1 - k); }
    else if (f.kind === 'pillar') { f.mesh.material.opacity = 0.6 * (1 - k); f.mesh.scale.x = f.mesh.scale.z = 1 - k * 0.5; }
  }
}

// ---------------- KAMERA ----------------
function updateCamera(me, dt) {
  const tx = me.x * S, tz = me.y * S;
  const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
  camera.position.set(tx + off.x, off.y, tz + off.z);
  if (shake > 0.01) { camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake; shake *= 0.85; }
  camera.lookAt(tx, 1.2, tz);
  if (frameNo % 4 === 0) updateOccluders(tx, tz);
  sun.position.set(tx + 14, 30, tz + 10);
  sun.target.position.set(tx, 0, tz);
}

// kameraya göre hareket yönü: ileri/sağ girdisini dünya (x, y) vektörüne çevirir
function moveVector(fwd, right) {
  const fx_ = -Math.sin(yaw), fz = -Math.cos(yaw); // ileri (kameradan karaktere)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return { x: fx_ * fwd + rx * right, y: fz * fwd + rz * right };
}
// fare konumunu zemine düşür → dünya koordinatı (piksel)
function groundPoint(sx, sy) {
  ray.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), camera);
  const p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(groundPlane, p)) return null;
  return { x: p.x / S, y: p.z / S };
}
function project(x, y, h) {
  const v = tmpV.set(x * S, h, y * S).project(camera);
  if (v.z > 1) return null;
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
}

// fare / dokunmatik ile kamera döndürme ve yakınlaştırma
let dragging = false, lastX = 0, lastY = 0, touchRot = null;
const gameCanvas = () => document.getElementById('game');
function setupControls() {
  const cv = gameCanvas();
  cv.addEventListener('mousedown', (e) => { if (e.button === 2 || e.button === 1) { dragging = true; lastX = e.clientX; lastY = e.clientY; } });
  addEventListener('mouseup', () => { dragging = false; });
  addEventListener('mousemove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.006;
    pitch = Math.max(0.35, Math.min(1.35, pitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
  });
  cv.addEventListener('wheel', (e) => { dist = Math.max(5, Math.min(20, dist + e.deltaY * 0.01)); e.preventDefault(); }, { passive: false });
  // telefonda: boş ekranda tek parmakla sürükle = döndür, iki parmak = yakınlaştır
  cv.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) touchRot = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    else if (e.touches.length === 2) touchRot = { pinch: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), d: dist };
  }, { passive: true });
  cv.addEventListener('touchmove', (e) => {
    if (!touchRot) return;
    if (e.touches.length === 1 && touchRot.x != null) {
      yaw -= (e.touches[0].clientX - touchRot.x) * 0.008;
      pitch = Math.max(0.35, Math.min(1.35, pitch + (e.touches[0].clientY - touchRot.y) * 0.005));
      touchRot = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && touchRot.pinch) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      dist = Math.max(5, Math.min(20, touchRot.d * (touchRot.pinch / d)));
    }
  }, { passive: true });
  cv.addEventListener('touchend', () => { touchRot = null; });
}

// ---------------- ETİKETLER (2D katman) ----------------
function drawOverlay(ctx, tm) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const label = (x, y, text, col, size = 12) => {
    ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = col; ctx.fillText(text, x, y);
  };
  for (const v of MAP.villages) { const s = project(v.x, v.y, 5); if (s) label(s.x, s.y, FACTIONS[v.f].short.toUpperCase() + ' KÖYÜ', '#fff', 15); }
  for (const s of MAP.smiths || []) { const p = project(s.x, s.y, 2.3); if (p) label(p.x, p.y, '🔨 Demirci', '#ffd04a', 12); }
  for (const p of state.players) {
    if (p.dead) continue;
    const v = view.get(p.id) || p;
    const s = project(v.x, v.y, 2.25);
    if (!s) continue;
    label(s.x, s.y - 8, `Sv.${p.l} ${p.n}`, p.id === myId ? '#ffd04a' : fColor(p.f), 12);
    hpBar(s.x, s.y - 3, p.hp / p.mh, p.f === myFaction ? '#4ad04a' : '#e0473c');
    if (p.st) stars(s.x, s.y - 22);
    if (p.sp) {
      const t = p.sp.length > 18 ? p.sp.slice(0, 17) + '…' : p.sp;
      ctx.font = 'bold 12px sans-serif';
      const tw = Math.min(160, ctx.measureText(t).width + 34);
      ctx.fillStyle = '#f3e2b8'; ctx.strokeStyle = '#8a5a2a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.rect(s.x - tw / 2, s.y - 48, tw, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#4a2a10'; ctx.fillText('🏪 ' + t, s.x, s.y - 31);
    }
  }
  for (const mb of state.mobs || []) {
    if (mb.d) continue;
    const v = view.get(mb.id) || mb;
    const T = MOBT[mb.t] || { name: '?', r: 18, aggro: 'semi' };
    const s = project(v.x, v.y, mb.t === 'haydut' ? 2.2 : T.r * S * 2.6 + 0.4);
    if (!s) continue;
    label(s.x, s.y - 8, `Sv.${mb.l} ${T.name}`, T.aggro === 'aggr' ? '#ff7a6a' : T.aggro === 'semi' ? '#ffd04a' : '#f0f0f0', 11);
    if (mb.hp < mb.mh || mb.s === 'c') hpBar(s.x, s.y - 3, mb.hp / mb.mh, '#e0473c');
    if (mb.st) stars(s.x, s.y - 20);
  }
  for (const st of state.stones || []) {
    const s = project(st.x, st.y, st.r * S * 3.2);
    if (!s) continue;
    label(s.x, s.y - 10, `Sv.${st.l} Bozulma Taşı`, '#e08aff', 13);
    ctx.fillStyle = '#000a'; ctx.fillRect(s.x - 40, s.y - 4, 80, 7);
    ctx.fillStyle = '#b04aff'; ctx.fillRect(s.x - 39, s.y - 3, 78 * st.hp / st.mh, 5);
  }
  for (const d of state.dummies) { if (d.dead) continue; const s = project(d.x, d.y, 2.0); if (s) { hpBar(s.x, s.y, d.hp / d.mh, '#d8b86a'); if (d.st) stars(s.x, s.y - 10); } }
  for (const d of state.drops || []) {
    const s = project(d.x, d.y, 0.1);
    if (!s) continue;
    if (d.p) label(s.x + 12, s.y - 26, '+' + d.p, '#ffd04a', 10);
    if (d.o) label(s.x, s.y + 12, `${d.o} (${d.ot})`, '#ff9a8a', 10);
  }
  floaters = floaters.filter((f) => tm - f.t < 900);
  for (const f of floaters) {
    const k = (tm - f.t) / 900;
    const s = project(f.x, f.y + 30, 2.0);
    if (!s) continue;
    ctx.globalAlpha = 1 - k * k;
    const size = (f.big ? 22 : 16) * (k < 0.15 ? 0.7 + k * 2 : 1);
    ctx.font = `900 ${size}px sans-serif`; ctx.textAlign = 'center';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(f.txt, s.x, s.y - k * 50);
    ctx.fillStyle = f.col; ctx.fillText(f.txt, s.x, s.y - k * 50);
  }
  ctx.globalAlpha = 1;
  swings = swings.filter((s) => tm - s.t < 250);
  rings = rings.filter((r) => tm - r.t < (r.dur || 500));
  booms = booms.filter((b) => tm - b.t < 500);
}

// ---------------- DIŞA AÇIK ARAYÜZ ----------------
async function init() {
  if (building || ready) return;
  building = true;
  try {
    makeRenderer();
    setupControls();
    const bar = document.getElementById('load3d');
    bar.classList.remove('hidden');
    await loadAll((k) => { bar.querySelector('i').style.width = Math.round(k * 100) + '%'; bar.querySelector('span').textContent = `3D modeller yükleniyor... %${Math.round(k * 100)}`; });
    buildGround();
    buildDecor();
    bar.classList.add('hidden');
    document.getElementById('game3d').classList.remove('hidden');
    ready = true;
  } catch (e) {
    console.error('3D başlatılamadı, 2D grafiklere geçiliyor:', e);
    document.getElementById('load3d').classList.add('hidden');
    window.r3d = null;
  }
  building = false;
}

function render(cam) {
  if (!ready) return false;
  const tm = performance.now();
  const dt = Math.min(0.05, (tm - lastT) / 1000);
  lastT = tm;
  if (renderer.domElement.width !== Math.floor(W * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(H * renderer.getPixelRatio())) {
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
  const me = state.players.find((p) => p.id === myId);
  updateEntities(dt, tm);
  updateEffects(dt, tm);
  updateCamera(me ? view.get(me.id) || me : cam, dt);
  renderer.render(scene, camera);
  drawOverlay(ctx, tm);
  return true;
}

function reset() {
  for (const e of ents.values()) scene && scene.remove(e.root);
  ents.clear();
}

// Grafik seçeneği: ?gfx=2d adres eki ya da ayarlardan "2D" seçilmişse 3D hiç başlatılmaz
let want2d = /[?&]gfx=2d/.test(location.search);
try { if (localStorage.getItem('pvp_gfx') === '2d') want2d = true; } catch {}
if (!want2d) window.r3d = {
  get ready() { return ready; },
  init, render, onEvent, moveVector, groundPoint, reset, project,
  get yaw() { return yaw; },
};

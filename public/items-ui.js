// PvP Server - çanta, demirci ve efsun ekranları
// (client.js'deki $, send, state, myId, MAP, ctx gibi ortak değişkenleri kullanır)
window.itemsUI = (() => {
  let ITEMS = {}, BONUSES = {}, PLUS_MUL = [], UPG = [];
  let inv = [], gold = 0;
  let sel = null; // seçili eşya: { c, s }
  let smithSel = null;
  const BAG = 0, EQUIP = 1, BAG_SIZE = 30;
  const EQUIP_NAMES = ['Silah', 'Zırh', 'Miğfer'];
  const ICON = { 1001: '⚔️', 1011: '🗡️', 1021: '⚔️', 1031: '🪄', 2001: '🥋', 2101: '⛑️', 3001: '🪨', 3002: '🌙', 3003: '🔶', 4001: '📜', 4002: '🔩', 5001: '💎', 5002: '✨', 6001: '📘' };
  const PROT_NAMES = ['Standart (başarısızlıkta YANAR)', 'Kutsama Parşömeni (1 seviye düşer)', 'Büyülü Metal (seviye korunur)'];
  const PROT_ITEM = [null, 4001, 4002];

  const find = (c, s) => inv.find((i) => i.c === c && i.s === s);
  const countOf = (id) => inv.filter((i) => i.c === BAG && i.id === id).reduce((a, i) => a + i.n, 0);
  const isEquip = (id) => ['weapon', 'armor', 'helmet'].includes((ITEMS[id] || {}).kind);
  const fmt = (n) => n.toLocaleString('tr-TR');
  const nearSmith = () => {
    if (!state || !MAP || !MAP.smiths) return false;
    const me = state.players.find((p) => p.id === myId);
    return me && MAP.smiths.some((s) => Math.hypot(s.x - me.x, s.y - me.y) <= 160);
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function itemTitle(it) {
    return ITEMS[it.id].name + (isEquip(it.id) && it.p ? ` +${it.p}` : '');
  }

  // Eşya ayrıntıları (değerler, efsunlar)
  function detailLines(it) {
    const T = ITEMS[it.id];
    const lines = [];
    const m = PLUS_MUL[it.p] || 1;
    if (T.cls) lines.push([`Sınıf: ${CLASSES[T.cls] ? CLASSES[T.cls].name : T.cls}`, '#c9a98a']);
    if (T.atk) lines.push([`Saldırı Gücü +%${Math.round(T.atk * m)}`, '#fff']);
    if (T.def) lines.push([`Savunma %${Math.round(T.def * m)}`, '#fff']);
    if (T.hp) lines.push([`Maks. Can +${Math.round(T.hp * m)}`, '#fff']);
    for (const [type, val] of it.a || []) {
      const B = BONUSES[type];
      if (B) lines.push([`${B.name} +${val}${B.pct ? '%' : ''}`, '#7ad7ff']);
    }
    if (T.desc) lines.push([T.desc, '#c9a98a']);
    if (T.stack > 1) lines.push([`Adet: ${it.n}`, '#c9a98a']);
    return lines;
  }

  function cell(it, onClick, selected) {
    const d = el('div', 'icell' + (selected ? ' sel' : '') + (it ? '' : ' empty'));
    if (it) {
      d.appendChild(el('span', 'ico', ICON[it.id] || '❔'));
      if (it.p) d.appendChild(el('span', 'plus', '+' + it.p));
      if (it.n > 1) d.appendChild(el('span', 'cnt', it.n));
      d.title = itemTitle(it);
    }
    if (onClick) d.onclick = onClick;
    return d;
  }

  // ---------------- ÇANTA ----------------
  function renderInv() {
    const panel = $('#invPanel');
    if (panel.classList.contains('hidden')) return;
    $('#invGold').textContent = `💰 ${fmt(gold)} altın`;
    const eq = $('#invEquip');
    eq.innerHTML = '';
    for (let s = 0; s < 3; s++) {
      const it = find(EQUIP, s);
      const wrap = el('div', 'eqslot');
      wrap.appendChild(cell(it, () => { sel = it ? { c: EQUIP, s } : null; renderInv(); }, sel && sel.c === EQUIP && sel.s === s));
      wrap.appendChild(el('small', null, EQUIP_NAMES[s]));
      eq.appendChild(wrap);
    }
    const bag = $('#invBag');
    bag.innerHTML = '';
    for (let s = 0; s < BAG_SIZE; s++) {
      const it = find(BAG, s);
      bag.appendChild(cell(it, () => { sel = it ? { c: BAG, s } : null; renderInv(); }, sel && sel.c === BAG && sel.s === s));
    }
    const det = $('#invDetail');
    det.innerHTML = '';
    const it = sel && find(sel.c, sel.s);
    if (!it) { det.appendChild(el('div', 'muted', 'Ayrıntı görmek için bir eşyaya dokun.')); return; }
    det.appendChild(el('b', null, itemTitle(it)));
    for (const [txt, col] of detailLines(it)) { const l = el('div', null, txt); l.style.color = col; det.appendChild(l); }
    const acts = el('div', 'acts');
    if (it.id === 6001 && it.c === BAG) {
      const c = CLASSES[state.players.find((p) => p.id === myId).c];
      for (const k of ['q', 'e', 'r', 'f']) {
        const lv = skillLv[k] || 1;
        const b = btn(`📘 ${k.toUpperCase()}: ${c.skills[k].name} (Sv.${lv}${lv >= 20 ? ' MAKS' : ''})`, () => send({ t: 'useBook', slot: it.s, k }));
        if (lv >= 20) b.disabled = true;
        acts.appendChild(b);
      }
    }
    if (isEquip(it.id)) {
      if (it.c === BAG) acts.appendChild(btn('Kuşan', () => send({ t: 'equip', slot: it.s })));
      else acts.appendChild(btn('Çıkar', () => send({ t: 'unequip', slot: it.s })));
      if (countOf(5001) > 0 && (it.a || []).length < 5) acts.appendChild(btn(`💎 Efsun Ekle (${countOf(5001)})`, () => send({ t: 'addBonus', c: it.c, slot: it.s })));
      if (countOf(5002) > 0 && (it.a || []).length > 0) acts.appendChild(btn(`✨ Efsun Değiştir (${countOf(5002)})`, () => send({ t: 'rerollBonus', c: it.c, slot: it.s })));
      if (nearSmith()) acts.appendChild(btn('🔨 Demirciye Götür', () => openSmith({ c: it.c, s: it.s })));
    }
    det.appendChild(acts);
  }

  function btn(text, fn) {
    const b = el('button', 'sbtn', text);
    b.onclick = fn;
    return b;
  }

  function toggleInv(force) {
    const p = $('#invPanel');
    const show = force !== undefined ? force : p.classList.contains('hidden');
    p.classList.toggle('hidden', !show);
    if (show) { $('#smithPanel').classList.add('hidden'); renderInv(); }
  }

  // ---------------- DEMİRCİ ----------------
  function openSmith(pick) {
    if (!nearSmith()) return addChat('Demirciye yaklaşmalısın.', true);
    $('#invPanel').classList.add('hidden');
    $('#smithPanel').classList.remove('hidden');
    if (pick) smithSel = pick;
    $('#smithResult').textContent = '';
    renderSmith();
  }

  function renderSmith() {
    const panel = $('#smithPanel');
    if (panel.classList.contains('hidden')) return;
    $('#smithGold').textContent = `💰 ${fmt(gold)} altın`;
    const list = $('#smithItems');
    list.innerHTML = '';
    const ups = inv.filter((i) => isEquip(i.id)).sort((a, b) => b.c - a.c || a.s - b.s);
    if (smithSel && !find(smithSel.c, smithSel.s)) smithSel = null;
    if (!smithSel && ups[0]) smithSel = { c: ups[0].c, s: ups[0].s };
    for (const it of ups) {
      const isSel = smithSel && smithSel.c === it.c && smithSel.s === it.s;
      const c = cell(it, () => { smithSel = { c: it.c, s: it.s }; $('#smithResult').textContent = ''; renderSmith(); }, isSel);
      if (it.c === EQUIP) c.classList.add('worn');
      list.appendChild(c);
    }
    const info = $('#smithInfo');
    info.innerHTML = '';
    const it = smithSel && find(smithSel.c, smithSel.s);
    if (!it) { info.appendChild(el('div', 'muted', 'Yükseltilecek eşya yok.')); $('#smithGo').disabled = true; return; }
    info.appendChild(el('b', null, itemTitle(it) + (it.c === EQUIP ? ' (kuşanılmış)' : '')));
    if (it.p >= 9) {
      info.appendChild(el('div', null, 'Bu eşya en yüksek seviyede (+9).'));
      $('#smithGo').disabled = true;
      return;
    }
    const u = UPG[it.p];
    const pct = Math.round(u.chance * 100);
    const ch = el('div', 'chance', `+${it.p} → +${it.p + 1}   Başarı şansı: %${pct}`);
    ch.style.color = pct >= 80 ? '#8aff8a' : pct >= 40 ? '#ffd04a' : '#ff6a5a';
    info.appendChild(ch);
    const g = el('div', null, `Ücret: ${fmt(u.gold)} altın`);
    if (gold < u.gold) g.style.color = '#ff6a5a';
    info.appendChild(g);
    if (u.mat) {
      const have = countOf(u.mat[0]);
      const mm = el('div', null, `Malzeme: ${ITEMS[u.mat[0]].name} ×${u.mat[1]} (sende ${have})`);
      if (have < u.mat[1]) mm.style.color = '#ff6a5a';
      info.appendChild(mm);
    }
    // koruma seçimi
    const prot = $('#smithProt');
    const cur = Number(prot.value || 0);
    prot.innerHTML = '';
    PROT_NAMES.forEach((name, i) => {
      const o = el('option', null, i && PROT_ITEM[i] ? `${name} — sende ${countOf(PROT_ITEM[i])}` : name);
      o.value = i;
      if (i && countOf(PROT_ITEM[i]) === 0) o.disabled = true;
      prot.appendChild(o);
    });
    prot.value = PROT_ITEM[cur] && countOf(PROT_ITEM[cur]) === 0 ? 0 : cur;
    const warn = $('#smithWarn');
    warn.textContent = Number(prot.value) === 0 && pct < 100 ? '⚠ Başarısız olursa eşya tamamen yok olur!' : '';
    $('#smithGo').disabled = gold < u.gold || (u.mat && countOf(u.mat[0]) < u.mat[1]);
  }

  function doUpgrade() {
    const it = smithSel && find(smithSel.c, smithSel.s);
    if (!it) return;
    const protect = Number($('#smithProt').value || 0);
    if (protect === 0 && UPG[it.p].chance < 1 && !confirm(`${itemTitle(it)} başarısız olursa YANACAK. Devam edilsin mi?`)) return;
    $('#smithGo').disabled = true;
    $('#smithResult').textContent = 'Demirci çekiçliyor... 🔨';
    $('#smithResult').style.color = '#e8b04a';
    send({ t: 'upgrade', c: it.c, slot: it.s, protect });
  }

  // ---------------- MESAJLAR ----------------
  function handle(m) {
    if (m.t === 'inv') {
      inv = m.items; gold = m.gold;
      renderInv(); renderSmith();
    } else if (m.t === 'gold') {
      gold = m.gold; renderInv(); renderSmith();
    } else if (m.t === 'loot') {
      const names = m.items.map(([id, n, p]) => ITEMS[id].name + (p ? ` +${p}` : '') + (n > 1 ? ` ×${n}` : ''));
      if (names.length) addChat(`Topladın: ${names.join(', ')}`, true);
      const me = state && state.players.find((p) => p.id === myId);
      if (me && m.gold) floaters.push({ x: me.x + 20, y: me.y - 60, txt: `+${m.gold} altın`, col: '#ffd04a', t: performance.now() });
      if (me && names.length) floaters.push({ x: me.x - 20, y: me.y - 75, txt: names[0] + (names.length > 1 ? ` +${names.length - 1}` : ''), col: '#ffffff', t: performance.now() });
    } else if (m.t === 'skills') {
      skillLv = m.lv;
      renderInv();
    } else if (m.t === 'notice') {
      addChat(m.msg, true); toast(m.msg);
    } else if (m.t === 'upRes') {
      const r = $('#smithResult');
      if (m.error) { r.textContent = m.error; r.style.color = '#ff6a5a'; renderSmith(); return; }
      const txt = {
        success: [`BAŞARILI! ${m.name} artık +${m.to} ✨`, '#8aff8a'],
        destroyed: [`Başarısız... ${m.name} yandı 🔥`, '#ff6a5a'],
        downgraded: [`Başarısız. Kutsama Parşömeni eşyayı korudu: +${m.to}`, '#ffd04a'],
        kept: [`Başarısız. Büyülü Metal sayesinde eşya +${m.to} olarak kaldı`, '#ffd04a'],
      }[m.outcome];
      r.textContent = txt[0]; r.style.color = txt[1];
      toast(txt[0]);
      if (m.outcome === 'destroyed') smithSel = null;
    } else if (m.t === 'bonusRes') {
      if (m.error) return toast(m.error);
      if (m.kind === 'add') toast(m.ok ? 'Yeni efsun eklendi! 💎' : 'Efsun ekleme başarısız oldu.');
      else toast('Efsunlar değişti ✨');
      sel = { c: m.c, s: m.slot };
      renderInv();
    } else return false;
    return true;
  }

  function init(m) {
    ITEMS = m.items || {}; BONUSES = m.bonuses || {}; PLUS_MUL = m.plusMul || []; UPG = m.upgrade || [];
    sel = null; smithSel = null;
    $('#invPanel').classList.add('hidden');
    $('#smithPanel').classList.add('hidden');
  }

  // Haritada demirci NPC'leri
  function drawWorld() {
    if (!MAP || !MAP.smiths) return;
    for (const s of MAP.smiths) {
      ctx.fillStyle = '#0006'; ctx.beginPath(); ctx.ellipse(s.x, s.y + 16, 18, 7, 0, 0, Math.PI * 2); ctx.fill();
      // örs
      ctx.fillStyle = '#3a3a40'; ctx.fillRect(s.x + 18, s.y + 2, 26, 9); ctx.fillRect(s.x + 25, s.y + 11, 12, 10);
      // demirci
      ctx.fillStyle = '#7a4a2a'; ctx.beginPath(); ctx.arc(s.x, s.y, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2a1a10'; ctx.fillRect(s.x - 12, s.y - 2, 24, 14);
      ctx.fillStyle = '#e8c9a0'; ctx.beginPath(); ctx.arc(s.x, s.y - 8, 7, 0, Math.PI * 2); ctx.fill();
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#000'; ctx.fillText('🔨 Demirci', s.x + 1, s.y - 29);
      ctx.fillStyle = '#ffd04a'; ctx.fillText('🔨 Demirci', s.x, s.y - 30);
    }
  }

  // Demirci yakınındayken ipucu
  let lastNear = null;
  function tick() {
    const n = nearSmith();
    if (n !== lastNear) {
      lastNear = n;
      $('#tSmith').classList.toggle('hidden', !n);
      $('#smithHint').classList.toggle('hidden', !n || isTouch);
      if (!n) $('#smithPanel').classList.add('hidden');
    }
  }

  function key(k) {
    if (k === 'i') { toggleInv(); return true; }
    if (k === 'g') { if (nearSmith()) openSmith(); return true; }
    if (k === 'escape') { $('#invPanel').classList.add('hidden'); $('#smithPanel').classList.add('hidden'); return true; }
    return false;
  }

  // düğmeler
  $('#bInv').onclick = () => toggleInv();
  $('#invClose').onclick = () => toggleInv(false);
  $('#smithClose').onclick = () => $('#smithPanel').classList.add('hidden');
  $('#smithGo').onclick = doUpgrade;
  $('#smithProt').onchange = renderSmith;
  $('#tSmith').addEventListener('touchstart', (e) => { e.preventDefault(); openSmith(); }, { passive: false });
  $('#tSmith').onclick = () => openSmith();
  $('#tInv').addEventListener('touchstart', (e) => { e.preventDefault(); toggleInv(); }, { passive: false });

  return { handle, init, drawWorld, tick, key };
})();

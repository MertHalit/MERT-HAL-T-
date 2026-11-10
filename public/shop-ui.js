// PvP Server - oyuncu pazarı (tezgah kurma ve alışveriş)
window.shopUI = (() => {
  const U = () => itemsUI;
  let stall = []; // kurulumda seçilenler: [{ s: çanta hücresi, price }]
  let myShop = null; // açık pazarım: { title, items }
  let viewing = null; // baktığım pazar: { id, title, seller, items }

  const $el = (t, c, x) => U().el(t, c, x);

  // ---------------- SATICI: PAZAR KUR ----------------
  function openSetup() {
    const me = state && state.players.find((p) => p.id === myId);
    if (!myShop && !(state && state.me.safe)) return toast('Pazar sadece köyde kurulabilir.');
    $('#invPanel').classList.add('hidden');
    $('#shopView').classList.add('hidden');
    $('#shopSetup').classList.remove('hidden');
    if (!$('#shopTitle').value && me) $('#shopTitle').value = `${me.n}'in Pazarı`;
    renderSetup();
  }

  function renderSetup() {
    const panel = $('#shopSetup');
    if (panel.classList.contains('hidden')) return;
    const inv = U().inv;
    stall = stall.filter((e) => inv.some((i) => i.c === 0 && i.s === e.s));
    const open = !!myShop;
    $('#shopSetupBody').classList.toggle('hidden', open);
    $('#shopOpenBody').classList.toggle('hidden', !open);
    if (open) {
      $('#shopOpenTitle').textContent = `"${myShop.title}" açık. Satılan eşyalar burada güncellenir.`;
      const list = $('#shopOpenList');
      list.innerHTML = '';
      for (const it of myShop.items) list.appendChild(row(it, $el('span', 'price', `${U().fmt(it.price)} / adet`)));
      if (!myShop.items.length) list.appendChild($el('div', 'muted', 'Her şey satıldı.'));
      return;
    }
    // çanta: tıklayınca pazara ekle
    U().renderBag($('#shopBag'), {
      filter: (it) => !stall.some((e) => e.s === it.s),
      onClick: (it) => {
        if (stall.length >= 8) return toast('En fazla 8 eşya koyabilirsin.');
        stall.push({ s: it.s, price: 1000 });
        renderSetup();
      },
    });
    const list = $('#shopStall');
    list.innerHTML = '';
    if (!stall.length) list.appendChild($el('div', 'muted', 'Satmak istediğin eşyalara çantadan tıkla.'));
    for (const e of stall) {
      const it = inv.find((i) => i.c === 0 && i.s === e.s);
      const input = document.createElement('input');
      input.type = 'number'; input.min = 1; input.max = 2000000000; input.value = e.price; input.className = 'pinput';
      input.oninput = () => { e.price = Math.floor(Number(input.value) || 0); };
      const unit = $el('small', 'muted', (U().ITEMS[it.id].stack || 1) > 1 ? 'altın / adet' : 'altın');
      const rm = U().btn('✕', () => { stall = stall.filter((x) => x !== e); renderSetup(); });
      const wrap = $el('span', 'pwrap'); wrap.append(input, unit, rm);
      list.appendChild(row(it, wrap));
    }
    $('#shopGo').disabled = !stall.length;
  }

  // ortak eşya satırı: simge, ad, efsunlar, adet + sağda özel içerik
  function row(it, right) {
    const r = $el('div', 'srow');
    const ic = $el('span', 'sico', U().ICON[it.id] || '❔');
    const info = $el('div', 'sinfo');
    info.appendChild($el('b', null, U().itemTitle({ id: it.id, p: it.p }) + (it.n > 1 ? ` ×${it.n}` : '')));
    for (const [txt, col] of U().detailLines({ id: it.id, p: it.p, a: it.a, n: it.n })) {
      if (/^Adet|kullanılır|Sınıf/.test(txt)) continue;
      const l = $el('div', null, txt); l.style.color = col; info.appendChild(l);
    }
    r.append(ic, info, right);
    return r;
  }

  function startShop() {
    const bad = stall.find((e) => !(e.price >= 1 && e.price <= 2000000000));
    if (bad) return toast('Fiyatlar 1 ile 2.000.000.000 arasında olmalı.');
    send({ t: 'openShop', title: $('#shopTitle').value, items: stall.map((e) => ({ s: e.s, price: e.price })) });
  }

  // ---------------- ALICI ----------------
  function renderView() {
    if (!viewing) return;
    $('#shopViewTitle').textContent = `🏪 ${viewing.title}`;
    $('#shopViewSeller').textContent = `Satıcı: ${viewing.seller} · Altının: ${U().fmt(U().gold)}`;
    const list = $('#shopViewList');
    list.innerHTML = '';
    if (!viewing.items.length) list.appendChild($el('div', 'muted', 'Bu pazarda eşya kalmadı.'));
    for (const it of viewing.items) {
      const stack = (U().ITEMS[it.id].stack || 1) > 1;
      const box = $el('span', 'pwrap');
      let qty = null;
      if (stack) {
        qty = document.createElement('input');
        qty.type = 'number'; qty.min = 1; qty.max = it.n; qty.value = 1; qty.className = 'pinput small';
        box.appendChild(qty);
      }
      const total = $el('span', 'price', `${U().fmt(it.price)}${stack ? ' / adet' : ''}`);
      const buyBtn = U().btn('Satın Al', () => {
        const q = stack ? Math.max(1, Math.min(it.n, Math.floor(Number(qty.value) || 1))) : it.n;
        const cost = q * it.price;
        if (cost > U().gold) return toast('Yeterli altının yok.');
        if (!confirm(`${U().itemTitle({ id: it.id, p: it.p })}${q > 1 ? ' ×' + q : ''} için ${U().fmt(cost)} altın ödensin mi?`)) return;
        buyBtn.disabled = true;
        // gördüğümüz fiyat ve eşya kimliği gönderilir; sunucuda değiştiyse satış reddedilir
        send({ t: 'buy', id: viewing.id, k: it.k, itemId: it.id, price: it.price, qty: q });
      });
      if (it.price > U().gold) buyBtn.classList.add('dim');
      box.append(total, buyBtn);
      list.appendChild(row(it, box));
    }
  }

  // ---------------- MESAJLAR ----------------
  function handle(m) {
    if (m.t === 'myShop') {
      myShop = m.closed ? null : { title: m.title, items: m.items };
      if (m.closed) { stall = []; toast('Pazar kapandı.'); }
      $('#bShop').textContent = myShop ? '🏪 Pazarım (açık)' : '🏪 Pazar Kur';
      renderSetup();
    } else if (m.t === 'shop') {
      viewing = m;
      $('#shopView').classList.remove('hidden');
      $('#invPanel').classList.add('hidden');
      $('#shopSetup').classList.add('hidden');
      renderView();
    } else if (m.t === 'shopClosed') {
      if (viewing && viewing.id === m.id) { viewing = null; $('#shopView').classList.add('hidden'); toast('Bu pazar kapandı.'); }
    } else if (m.t === 'buyRes') {
      if (m.error) { toast(m.error); if (viewing) send({ t: 'viewShop', id: viewing.id }); }
      else { toast(`Satın aldın: ${m.name} (-${U().fmt(m.total)} altın)`); addChat(`Satın aldın: ${m.name}`, true); }
    } else return false;
    return true;
  }

  // haritada tabelaya tıklanınca
  function clickWorld(wx, wy) {
    if (!state) return false;
    for (const p of state.players) {
      if (!p.sp || p.id === myId) continue;
      const v = view.get(p.id) || p;
      if (Math.abs(wx - v.x) < 75 && wy > v.y - 95 && wy < v.y + 25) { send({ t: 'viewShop', id: p.id }); return true; }
    }
    return false;
  }

  function tick() {
    const show = !!(state && (state.me.safe || myShop));
    $('#bShop').classList.toggle('hidden', !show);
    $('#tShop').classList.toggle('hidden', !show);
  }

  function onInv() { renderSetup(); renderView(); }

  $('#bShop').onclick = openSetup;
  $('#tShop').addEventListener('touchstart', (e) => { e.preventDefault(); openSetup(); }, { passive: false });
  $('#shopSetupClose').onclick = () => $('#shopSetup').classList.add('hidden');
  $('#shopViewClose').onclick = () => { $('#shopView').classList.add('hidden'); viewing = null; };
  $('#shopGo').onclick = startShop;
  $('#shopStop').onclick = () => send({ t: 'closeShop' });
  $('#shopRefresh').onclick = () => viewing && send({ t: 'viewShop', id: viewing.id });

  return { handle, clickWorld, tick, onInv, reset: () => { myShop = null; viewing = null; stall = []; } };
})();

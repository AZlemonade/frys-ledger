/* Fry's Ledger v0.1 — AZ Lemonade Stand consignment app.
   Plain JS, no framework. Talks to Supabase over REST. Works offline with an outbox. */
(function () {
  'use strict';
  const CFG = window.LEDGER_CONFIG || {};
  const URL0 = (CFG.url || '').replace(/\/+$/, '');
  const KEY = CFG.key || '';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const nowIso = () => new Date().toISOString();

  // ---------------- state ----------------
  const S = {
    session: LS.get('session', null),   // {access_token, refresh_token, expires_at, user:{email}}
    me: LS.get('me', null),             // people row
    skus: LS.get('skus', []),
    locations: LS.get('locations', []),
    balances: LS.get('balances', {}),   // {location_id: {sku_id: units}}
    masterAt: LS.get('masterAt', null),
    outbox: LS.get('outbox', []),       // [{id, path, method, body, headers}]
    screen: 'van',
    load: { wh: null, lines: [] },
    drop: { store: null, lines: [] },
    other: null,
    count: { loc: null, cells: {} },
    lastPos: null
  };
  const email = () => S.session && S.session.user && S.session.user.email;
  const myVan = () => S.me && S.me.van_location_id;
  const sku = id => S.skus.find(s => s.sku_id === id);
  const loc = id => S.locations.find(l => l.location_id === id);
  const myRoutes = () => ((S.me && S.me.routes_covered) || '').split(/[,&/]+/).map(s => s.trim()).filter(Boolean);
  const isWarehouseMgr = () => S.me && /warehouse/i.test(S.me.role || '');

  // ---------------- http ----------------
  async function refreshToken() {
    if (!S.session || !S.session.refresh_token) return false;
    const r = await fetch(URL0 + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: S.session.refresh_token }) });
    if (!r.ok) return false;
    const j = await r.json(); setSession(j); return true;
  }
  function setSession(j) {
    S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)), user: j.user };
    LS.set('session', S.session);
  }
  async function ensureToken() {
    if (!S.session) throw new Error('not signed in');
    if (S.session.expires_at - 60 < Date.now() / 1000) { if (!(await refreshToken())) throw new Error('session expired'); }
    return S.session.access_token;
  }
  async function api(path, opt) {
    opt = opt || {};
    const tok = await ensureToken();
    const h = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, opt.headers || {});
    const r = await fetch(URL0 + path, { method: opt.method || 'GET', headers: h, body: opt.body == null ? undefined : (typeof opt.body === 'string' || opt.body instanceof Blob ? opt.body : JSON.stringify(opt.body)) });
    if (r.status === 401 && !opt._retried) { if (await refreshToken()) return api(path, Object.assign({}, opt, { _retried: true })); }
    if (!r.ok) { const t = await r.text(); throw new Error(r.status + ' ' + t.slice(0, 200)); }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }

  // ---------------- outbox (offline queue) ----------------
  function enqueue(item) { item.id = uuid(); item.queued_at = nowIso(); S.outbox.push(item); LS.set('outbox', S.outbox); updateSync(); flush(); }
  let flushing = false;
  async function flush() {
    if (flushing || !navigator.onLine || !S.session) return; flushing = true;
    try {
      while (S.outbox.length) {
        const it = S.outbox[0];
        try { await api(it.path, { method: it.method, body: it.body, headers: it.headers }); }
        catch (e) {
          // A rejected line (bad data, RLS) must not block everything behind it forever: after 5 tries park it.
          it.tries = (it.tries || 0) + 1; it.lastError = String(e.message || e);
          if (/^4\d\d/.test(it.lastError) && it.tries >= 5) { S.outbox.shift(); S.outbox.push(Object.assign(it, { parked: true })); LS.set('outbox', S.outbox); }
          else { LS.set('outbox', S.outbox); }
          break;
        }
        S.outbox.shift(); LS.set('outbox', S.outbox);
      }
    } finally { flushing = false; updateSync(); }
  }
  window.addEventListener('online', flush);
  setInterval(flush, 30000);
  function updateSync() {
    const el = $('#sync'); if (!el) return;
    const n = S.outbox.length;
    if (!navigator.onLine) { el.textContent = n ? n + ' waiting (offline)' : 'offline'; el.className = 'sync off'; }
    else if (n) { el.textContent = n + ' uploading'; el.className = 'sync pending'; }
    else { el.textContent = 'synced'; el.className = 'sync'; }
    const mp = $('#more-pending'); if (mp) mp.textContent = String(n);
  }

  // ---------------- master data ----------------
  async function loadMaster() {
    const [skus, locations, me] = await Promise.all([
      api('/rest/v1/skus?select=*&active=eq.true&order=category,name'),
      api('/rest/v1/locations?select=*&active=eq.true&order=type,route,name'),
      api('/rest/v1/people?select=*&email=eq.' + encodeURIComponent((email() || '').toLowerCase()))
    ]);
    S.skus = skus; S.locations = locations; S.me = me[0] || null; S.masterAt = nowIso();
    LS.set('skus', skus); LS.set('locations', locations); LS.set('me', S.me); LS.set('masterAt', S.masterAt);
    if (!S.me) throw new Error('Your email is not on the People list yet. Ask Austin to add ' + email());
  }
  async function loadBalances(ids) {
    ids = ids.filter(Boolean); if (!ids.length) return;
    const rows = await api('/rest/v1/v_balance?select=location_id,sku_id,units&location_id=in.(' + ids.map(encodeURIComponent).join(',') + ')');
    ids.forEach(id => { S.balances[id] = {}; });
    rows.forEach(r => { S.balances[r.location_id][r.sku_id] = r.units; });
    LS.set('balances', S.balances);
  }
  function localAdjust(from, to, skuId, units) {
    // keep the cached balances honest while the outbox drains
    [[from, -units], [to, units]].forEach(([id, d]) => { if (!S.balances[id]) return; S.balances[id][skuId] = (S.balances[id][skuId] || 0) + d; });
    LS.set('balances', S.balances);
  }

  // ---------------- barcode ----------------
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function skuFromCode(code) {
    const d = digits(code); if (!d) return null;
    const cands = new Set([d]);
    if (d.length === 13 && d[0] === '0') cands.add(d.slice(1));
    if (d.length === 12) cands.add('0' + d);
    if (d.length === 14) cands.add(d.slice(2));         // GTIN-14 -> 12-digit core (check digit differs; matched below)
    for (const s of S.skus) {
      if (cands.has(s.unit_upc) || cands.has(s.case_gtin14)) return s;
      if (d.length === 14 && s.unit_upc && d.slice(2, 13) === s.unit_upc.slice(0, 11)) return s;
      if (d.length === 12 && s.case_gtin14 && s.case_gtin14.slice(2, 13) === d.slice(0, 11)) return s;
    }
    return null;
  }
  const scanner = {
    kind: (('BarcodeDetector' in window) ? 'native' : (window.Html5Qrcode ? 'lib' : 'none')),
    active: null,
    async start(container, onCode) {
      this.stop();
      container.innerHTML = '';
      if (this.kind === 'native') {
        const video = document.createElement('video'); video.setAttribute('playsinline', ''); video.muted = true; container.appendChild(video);
        const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Point at the case or bottle barcode'; container.appendChild(hint);
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream; await video.play();
        const det = new window.BarcodeDetector({ formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'itf', 'code_128'] });
        let stop = false; this.active = { stop: () => { stop = true; stream.getTracks().forEach(t => t.stop()); } };
        const tick = async () => { if (stop) return; try { const codes = await det.detect(video); if (codes.length) { this.stop(); onCode(codes[0].rawValue); return; } } catch (e) {} setTimeout(tick, 150); };
        tick();
      } else if (this.kind === 'lib') {
        const id = 'qr-' + uuid(); const div = document.createElement('div'); div.id = id; container.appendChild(div);
        const h = new window.Html5Qrcode(id, { formatsToSupport: [window.Html5QrcodeSupportedFormats.UPC_A, window.Html5QrcodeSupportedFormats.UPC_E, window.Html5QrcodeSupportedFormats.EAN_13, window.Html5QrcodeSupportedFormats.EAN_8, window.Html5QrcodeSupportedFormats.ITF, window.Html5QrcodeSupportedFormats.CODE_128] });
        this.active = { stop: () => h.stop().catch(() => {}) };
        await h.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 140 } }, txt => { this.stop(); onCode(txt); }, () => {});
      } else {
        container.innerHTML = '<div style="padding:12px;text-align:center;color:var(--ink-3)">No camera scanner on this phone. Tap the SKU instead.</div>';
      }
    },
    stop() { if (this.active) { try { this.active.stop(); } catch (e) {} this.active = null; } }
  };

  // ---------------- GPS ----------------
  function getPos() {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(p => { S.lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }; res(S.lastPos); }, () => res(S.lastPos), { enableHighAccuracy: true, timeout: 6000, maximumAge: 120000 });
    });
  }
  function distKm(a, b) { const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }

  // ---------------- UI helpers ----------------
  function go(name) {
    scanner.stop();
    S.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + name));
    $$('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.go === name));
    window.scrollTo(0, 0);
    ({ van: renderVan, load: renderLoad, drop: renderDrop, other: renderOther, count: renderCount, more: renderMore })[name]();
  }
  function msg(el, kind, text) { const d = document.createElement('div'); d.className = 'msg ' + kind; d.textContent = text; el.prepend(d); setTimeout(() => d.remove(), 6000); }
  function fmtCs(units, upc) { const c = Math.floor(units / upc), e = units % upc; return (units < 0 ? '<span class="neg">' : '') + c + ' cs ' + e + (units < 0 ? '</span>' : ''); }
  function sheet(title, opts, onPick, withSearch) {
    const p = $('#sheet-panel'); p.innerHTML = '<h2>' + title + '</h2>' + (withSearch ? '<input class="search" placeholder="Search" autocomplete="off">' : '') + '<div class="list"></div><button class="btn quiet" id="sheet-close">Cancel</button>';
    const list = $('.list', p);
    const render = q => {
      q = (q || '').toLowerCase();
      list.innerHTML = '';
      opts.filter(o => !q || (o.label + ' ' + (o.sub || '')).toLowerCase().includes(q)).slice(0, 200).forEach(o => {
        const d = document.createElement('div'); d.className = 'opt' + (o.dim ? ' dim' : ''); d.innerHTML = o.label + (o.sub ? '<small>' + o.sub + '</small>' : '');
        d.onclick = () => { $('#sheet').classList.remove('on'); onPick(o); }; list.appendChild(d);
      });
    };
    render('');
    if (withSearch) $('.search', p).oninput = e => render(e.target.value);
    $('#sheet-close').onclick = () => $('#sheet').classList.remove('on');
    $('#sheet').classList.add('on');
  }
  function storeOptions(all) {
    const routes = myRoutes();
    let stores = S.locations.filter(l => l.type === 'STORE');
    const mine = stores.filter(s => routes.includes(s.route));
    const pos = S.lastPos;
    const withDist = s => (pos && s.lat && s.lng) ? distKm(pos, s) : null;
    const opts = (all ? stores : (mine.length ? mine : stores)).map(s => { const d = withDist(s); return { id: s.location_id, label: s.kroger_store_no + ' · ' + s.name, sub: (s.address || '') + (s.city ? ', ' + s.city : '') + (d != null ? ' · ' + d.toFixed(1) + ' km' : '') + ' · ' + s.route, d }; });
    if (pos) opts.sort((a, b) => (a.d == null ? 1e9 : a.d) - (b.d == null ? 1e9 : b.d));
    if (!all && mine.length && mine.length < stores.length) opts.push({ id: '__all', label: 'Show all ' + stores.length + ' stores', dim: true });
    return opts;
  }
  function pickStore(onPick) {
    getPos().then(() => {
      const open = all => sheet('Store', storeOptions(all), o => { if (o.id === '__all') return open(true); onPick(loc(o.id)); }, true);
      open(false);
    });
  }
  function pickWarehouse(onPick) {
    const whs = S.locations.filter(l => l.type === 'WAREHOUSE');
    const home = (S.me && S.me.home_warehouse || '').toLowerCase();
    sheet('Warehouse', whs.map(w => ({ id: w.location_id, label: w.name, sub: home && w.name.toLowerCase().includes(home.split(/[ &,]/)[0]) ? 'your home warehouse' : '' })), o => onPick(loc(o.id)));
  }
  function pickSku(onPick, note) {
    sheet('SKU' + (note ? ' · ' + note : ''), S.skus.map(s => ({ id: s.sku_id, label: s.name, sub: s.units_per_case + ' per case' })), o => onPick(sku(o.id)));
  }

  // ---------------- line entry (shared by load / drop / other) ----------------
  function lineEntry(container, ctx) {
    // ctx: {from, to, onAdd(line), balanceLoc (for the hint), lines}
    container.innerHTML = '<div class="scan" id="le-scan">Tap to scan case or bottle</div>' +
      '<div class="field" id="le-sku"><div><div class="lab">SKU</div><div class="val">Tap to choose</div></div><span id="le-upc" class="pill"></span></div>' +
      '<div class="qty"><label><span class="lab">Cases</span><input id="le-cases" type="number" inputmode="numeric" min="0" value="0"></label><label><span class="lab">Loose units</span><input id="le-each" type="number" inputmode="numeric" min="0" value="0"></label></div>' +
      '<div class="hint" id="le-hint"></div><button class="btn" id="le-add" disabled>Add line</button>';
    let cur = null;
    const hint = () => {
      const c = +$('#le-cases').value || 0, e = +$('#le-each').value || 0;
      if (!cur) { $('#le-hint').textContent = ''; $('#le-add').disabled = true; return; }
      const units = c * cur.units_per_case + e;
      let t = '= ' + units + ' units';
      const bf = S.balances[ctx.from] && S.balances[ctx.from][cur.sku_id];
      if (bf != null) t += ' · ' + (loc(ctx.from) || {}).name + ' has ' + bf + (bf - units < 0 ? ' (short by ' + (units - bf) + ')' : '');
      const bt = ctx.to && S.balances[ctx.to] && S.balances[ctx.to][cur.sku_id];
      if (bt != null && loc(ctx.to) && loc(ctx.to).type !== 'VIRTUAL') t += ' · ' + loc(ctx.to).name + ' will have ' + (bt + units);
      $('#le-hint').textContent = t; $('#le-add').disabled = units <= 0;
    };
    const setSku = s => { cur = s; $('#le-sku .val').textContent = s ? s.name : 'Tap to choose'; $('#le-upc').textContent = s ? s.units_per_case + '/cs' : ''; hint(); $('#le-cases').focus(); };
    $('#le-scan').onclick = () => scanner.start($('#le-scan'), code => { const s = skuFromCode(code); if (s) { setSku(s); $('#le-scan').innerHTML = 'Scanned ' + code + ' · tap to scan again'; } else { $('#le-scan').innerHTML = 'Code ' + code + ' is not on the SKU list · tap to try again'; } });
    $('#le-sku').onclick = () => pickSku(setSku);
    $('#le-cases').oninput = hint; $('#le-each').oninput = hint;
    $('#le-add').onclick = () => {
      const c = +$('#le-cases').value || 0, e = +$('#le-each').value || 0; const units = c * cur.units_per_case + e; if (units <= 0) return;
      ctx.onAdd({ sku_id: cur.sku_id, units, cases_in: c, eaches_in: e });
      setSku(null); $('#le-cases').value = 0; $('#le-each').value = 0; $('#le-scan').textContent = 'Tap to scan case or bottle';
    };
  }
  function renderLines(container, lines, onDel) {
    container.innerHTML = lines.length ? '<div class="hint">' + lines.length + ' line' + (lines.length > 1 ? 's' : '') + ' on this batch</div>' : '';
    lines.forEach((l, i) => { const s = sku(l.sku_id); const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span class="k">' + s.name + '</span><span class="v">' + l.cases_in + ' cs ' + l.eaches_in + ' = ' + l.units + '<span class="del">remove</span></span>'; $('.del', d).onclick = () => onDel(i); container.appendChild(d); });
  }
  async function postBatch(type, from, to, lines, extra) {
    const pos = await getPos();
    const batch = uuid();
    const rows = lines.map(l => Object.assign({ type, from_loc: from, to_loc: to, sku_id: l.sku_id, units: l.units, cases_in: l.cases_in, eaches_in: l.eaches_in, user_email: email(), device_id: deviceId(), device_ts: nowIso(), lat: pos && pos.lat, lng: pos && pos.lng, gps_ok: gpsOk(pos, to, from), source: 'app', batch_id: batch }, extra || {}));
    enqueue({ path: '/rest/v1/movements', method: 'POST', body: rows, headers: { Prefer: 'return=minimal' } });
    lines.forEach(l => localAdjust(from, to, l.sku_id, l.units));
    return batch;
  }
  function gpsOk(pos, to, from) {
    const st = [loc(to), loc(from)].find(l => l && l.type === 'STORE'); if (!pos || !st || !st.lat) return null; return distKm(pos, st) <= 0.3;
  }
  function deviceId() { let d = LS.get('device_id'); if (!d) { d = uuid().slice(0, 8); LS.set('device_id', d); } return d; }

  // ---------------- screens ----------------
  function renderVan() {
    const van = myVan();
    $('#van-title').textContent = isWarehouseMgr() ? 'On my truck' : 'On my van';
    $('#van-sub').textContent = van ? (loc(van) || {}).name + ' · as of ' + (S.masterAt ? new Date(S.masterAt).toLocaleString() : 'never') : 'No vehicle assigned to you';
    const list = $('#van-list'); list.innerHTML = '';
    const b = S.balances[van] || {};
    const rows = S.skus.map(s => [s, b[s.sku_id] || 0]).filter(x => x[1] !== 0);
    if (!rows.length) list.innerHTML = '<div class="hint">Nothing on the van. Load from a warehouse to start.</div>';
    rows.forEach(([s, u]) => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span class="k">' + s.name + '</span><span class="v">' + fmtCs(u, s.units_per_case) + '</span>'; list.appendChild(d); });
    $('#van-hint').textContent = rows.some(r => r[1] < 0) ? 'A negative line means more was dropped than loaded. Log the missing load, or tell Greyson.' : '';
  }
  function renderLoad() {
    const st = S.load; const to = myVan();
    $('#load-title').textContent = isWarehouseMgr() ? 'Load truck' : 'Load';
    $('#load-wh .val').textContent = st.wh ? loc(st.wh).name : 'Choose';
    $('#load-wh').onclick = () => pickWarehouse(async w => { st.wh = w.location_id; try { await loadBalances([w.location_id]); } catch (e) {} renderLoad(); });
    if (st.wh) lineEntry($('#load-entry'), { from: st.wh, to, onAdd: l => { st.lines.push(l); renderLoad(); } }); else $('#load-entry').innerHTML = '';
    renderLines($('#load-lines'), st.lines, i => { st.lines.splice(i, 1); renderLoad(); });
    $('#load-finish').disabled = !st.lines.length;
    $('#load-finish').onclick = async () => { await postBatch('LOAD', st.wh, to, st.lines); msg($('#s-van'), 'ok', 'Load saved: ' + st.lines.length + ' line(s) from ' + loc(st.wh).name); S.load = { wh: null, lines: [] }; go('van'); };
  }
  function renderDrop() {
    const st = S.drop; const from = myVan();
    $('#drop-store .val').textContent = st.store ? loc(st.store).kroger_store_no + ' · ' + loc(st.store).name : 'Choose';
    $('#drop-store').onclick = () => pickStore(async s => { st.store = s.location_id; try { await loadBalances([s.location_id]); } catch (e) {} renderDrop(); });
    if (st.store) lineEntry($('#drop-entry'), { from, to: st.store, onAdd: l => { st.lines.push(l); renderDrop(); } }); else $('#drop-entry').innerHTML = '';
    renderLines($('#drop-lines'), st.lines, i => { st.lines.splice(i, 1); renderDrop(); });
    $('#drop-finish').disabled = !st.lines.length;
    $('#drop-finish').onclick = async () => { const n = st.lines.length; const name = loc(st.store).name; await postBatch('DROP', from, st.store, st.lines); S.drop = { store: null, lines: [] }; msg($('#s-van'), 'ok', 'Drop saved: ' + n + ' line(s) at ' + name); go('van'); };
  }
  function renderOther() {
    $('#other-transfer').style.display = isWarehouseMgr() ? '' : 'none';
    $$('#s-other .row.tap').forEach(r => { r.onclick = () => { S.other = { type: r.dataset.other, lines: [], loc: null, note: '', photo: null }; renderOtherForm(); }; });
    if (!S.other) $('#other-form').innerHTML = '';
    else renderOtherForm();
  }
  function renderOtherForm() {
    const o = S.other; const f = $('#other-form'); const van = myVan();
    const specs = {
      RETURN: { title: 'Return to warehouse', pick: 'warehouse', from: () => van, to: () => o.loc, type: 'RETURN' },
      WRITEOFF: { title: 'Write off', pick: 'store-or-van', from: () => o.loc, to: () => 'WRITEOFF', type: 'WRITEOFF', note: true, photo: true },
      DEMO: { title: 'Demo / sampling', pick: 'store', from: () => o.loc, to: () => 'DEMO', type: 'DEMO', note: true },
      PICKUP: { title: 'Pick up from a store', pick: 'store', from: () => o.loc, to: () => van, type: 'STORE_XFER', hint: 'Then drop it at the other store from the Drop tab.' },
      TRANSFER_IN: { title: 'Transfer in from Dunlap / STEM', pick: 'warehouse', from: () => 'PLANT', to: () => o.loc, type: 'TRANSFER_IN' }
    }[o.type];
    f.innerHTML = '<h1 style="font-size:20px">' + specs.title + '</h1>' + (specs.hint ? '<div class="sub">' + specs.hint + '</div>' : '') +
      '<div class="field" id="of-loc"><div><div class="lab">' + (specs.pick === 'warehouse' ? 'Warehouse' : 'Location') + '</div><div class="val">' + (o.loc ? loc(o.loc).name : 'Choose') + '</div></div><span>›</span></div>' +
      '<div id="of-entry"></div><div class="lines" id="of-lines"></div>' +
      (specs.note ? '<textarea id="of-note" rows="2" placeholder="' + (o.type === 'WRITEOFF' ? 'What happened (required)' : 'Event or store contact') + '">' + (o.note || '') + '</textarea>' : '') +
      (specs.photo ? '<input type="file" id="of-photo" accept="image/*" capture="environment"><div class="hint">Photo of the damaged product is required.</div>' : '') +
      '<button class="btn" id="of-save" disabled>Save</button><button class="btn quiet" id="of-cancel">Cancel</button>';
    $('#of-loc').onclick = () => {
      const after = async l => { o.loc = l.location_id; try { await loadBalances([l.location_id]); } catch (e) {} renderOtherForm(); };
      if (specs.pick === 'warehouse') pickWarehouse(after);
      else if (specs.pick === 'store-or-van') sheet('Where is the product?', [{ id: van, label: 'My van' }, { id: '__store', label: 'A store' }], x => x.id === '__store' ? pickStore(after) : after(loc(van)));
      else pickStore(after);
    };
    if (o.loc) lineEntry($('#of-entry'), { from: specs.from(), to: specs.to(), onAdd: l => { o.lines.push(l); renderOtherForm(); } });
    renderLines($('#of-lines'), o.lines, i => { o.lines.splice(i, 1); renderOtherForm(); });
    const check = () => { $('#of-save').disabled = !(o.lines.length && (!specs.note || o.type !== 'WRITEOFF' || ($('#of-note').value || '').trim().length >= 3) && (!specs.photo || ($('#of-photo').files && $('#of-photo').files.length))); };
    check();
    if (specs.note) $('#of-note').oninput = e => { o.note = e.target.value; check(); };
    if (specs.photo) $('#of-photo').onchange = check;
    $('#of-cancel').onclick = () => { S.other = null; renderOther(); };
    $('#of-save').onclick = async () => {
      let photo_url = null;
      if (specs.photo) {
        const file = $('#of-photo').files[0]; const path = 'writeoffs/' + new Date().toISOString().slice(0, 10) + '/' + uuid() + '.jpg';
        try { await api('/storage/v1/object/photos/' + path, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'image/jpeg', 'x-upsert': 'true' } }); photo_url = 'photos/' + path; }
        catch (e) { photo_url = 'pending:' + path; msg(f, 'warn', 'Photo will upload when back online.'); LS.set('photo_' + path, { name: file.name, type: file.type }); }
      }
      await postBatch(specs.type, specs.from(), specs.to(), o.lines, { note: o.note || null, photo_url });
      msg($('#s-van'), 'ok', specs.title + ' saved.'); S.other = null; go('van');
    };
  }
  function renderCount() {
    const c = S.count;
    $('#count-loc .val').textContent = c.loc ? loc(c.loc).name : 'Choose';
    $('#count-loc').onclick = () => sheet('What are you counting?', [{ id: myVan(), label: 'My van' }, { id: '__store', label: 'A store' }].concat(isWarehouseMgr() ? S.locations.filter(l => l.type === 'WAREHOUSE').map(w => ({ id: w.location_id, label: w.name })) : []), x => { if (x.id === '__store') pickStore(s => { c.loc = s.location_id; c.cells = {}; renderCount(); }); else { c.loc = x.id; c.cells = {}; renderCount(); } });
    const g = $('#count-grid'); g.innerHTML = '';
    if (!c.loc) { $('#count-actions').innerHTML = ''; return; }
    const isStore = loc(c.loc).type === 'STORE';
    S.skus.forEach(s => {
      const cell = c.cells[s.sku_id] || (c.cells[s.sku_id] = { b: '', d: '' });
      const d = document.createElement('div'); d.className = 'row';
      d.innerHTML = '<span class="k">' + s.name + '<br><small style="color:var(--ink-3)">' + s.units_per_case + '/cs</small></span><span class="cells">' + (isStore ? '<label><small>backstock</small><input type="number" inputmode="numeric" min="0" data-s="' + s.sku_id + '" data-f="b" value="' + cell.b + '"></label><label><small>display</small><input type="number" inputmode="numeric" min="0" data-s="' + s.sku_id + '" data-f="d" value="' + cell.d + '"></label>' : '<label><small>units</small><input type="number" inputmode="numeric" min="0" data-s="' + s.sku_id + '" data-f="b" value="' + cell.b + '"></label>') + '</span>';
      g.appendChild(d);
    });
    $$('input', g).forEach(i => { i.oninput = () => { c.cells[i.dataset.s][i.dataset.f] = i.value; }; });
    $('#count-actions').innerHTML = '<div class="hint">Blank counts as zero. Every SKU is compared to the book when you post.</div><button class="btn" id="count-post">Post count</button><button class="btn quiet" id="count-clear">Clear</button>';
    $('#count-clear').onclick = () => { c.cells = {}; renderCount(); };
    $('#count-post').onclick = async () => {
      const total = S.skus.reduce((a, s) => a + (+c.cells[s.sku_id].b || 0) + (+c.cells[s.sku_id].d || 0), 0);
      if (!confirm('Post this count for ' + loc(c.loc).name + '? ' + total + ' units total. This resets the book to what you counted.')) return;
      const count_id = uuid();
      enqueue({ path: '/rest/v1/counts', method: 'POST', body: { count_id, location_id: c.loc, user_email: email() }, headers: { Prefer: 'return=minimal' } });
      enqueue({ path: '/rest/v1/count_lines', method: 'POST', body: S.skus.map(s => ({ count_id, sku_id: s.sku_id, backstock_units: +c.cells[s.sku_id].b || 0, display_units: +c.cells[s.sku_id].d || 0 })), headers: { Prefer: 'return=minimal' } });
      enqueue({ path: '/rest/v1/rpc/post_count', method: 'POST', body: { p_count_id: count_id } });
      msg($('#s-van'), 'ok', 'Count posted for ' + loc(c.loc).name + '.'); S.count = { loc: null, cells: {} }; go('van');
    };
  }
  function renderMore() {
    $('#more-email').textContent = email() || '';
    $('#more-master').textContent = S.masterAt ? new Date(S.masterAt).toLocaleDateString() + ' · ' + S.skus.length + ' SKUs · ' + S.locations.filter(l => l.type === 'STORE').length + ' stores' : 'not loaded';
    $('#more-scanner').textContent = { native: 'camera (built in)', lib: 'camera (library)', none: 'not available' }[scanner.kind];
    updateSync();
    $('#more-refresh').onclick = async () => { try { await loadMaster(); await loadBalances([myVan()]); msg($('#s-more'), 'ok', 'Refreshed.'); renderMore(); } catch (e) { msg($('#s-more'), 'err', e.message); } };
    $('#more-retry').onclick = () => { S.outbox.forEach(i => { delete i.parked; i.tries = 0; }); LS.set('outbox', S.outbox); flush(); };
    $('#more-signout').onclick = () => { if (S.outbox.length && !confirm(S.outbox.length + ' uploads are still pending. Sign out anyway?')) return; ['session', 'me', 'balances'].forEach(LS.del); location.reload(); };
  }

  // ---------------- auth ----------------
  async function sendCode() {
    const em = ($('#login-email').value || '').trim().toLowerCase(); if (!em.includes('@')) return;
    $('#login-send').disabled = true;
    const r = await fetch(URL0 + '/auth/v1/otp', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, create_user: true }) });
    $('#login-send').disabled = false;
    if (!r.ok) { $('#login-msg').innerHTML = '<div class="msg err">Could not send a code: ' + (await r.text()).slice(0, 120) + '</div>'; return; }
    LS.set('login_email', em); $('#login-step1').style.display = 'none'; $('#login-step2').style.display = ''; $('#login-code').focus();
    $('#login-msg').innerHTML = '<div class="msg ok">Code sent to ' + em + '. Check spam if it is not there in a minute.</div>';
  }
  async function verifyCode() {
    const em = LS.get('login_email'); const code = digits($('#login-code').value);
    const r = await fetch(URL0 + '/auth/v1/verify', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'email', email: em, token: code }) });
    if (!r.ok) { $('#login-msg').innerHTML = '<div class="msg err">That code did not work. Codes expire after a few minutes; send a new one.</div>'; return; }
    setSession(await r.json()); await boot();
  }

  // ---------------- boot ----------------
  async function boot() {
    if (!S.session) { $('#login').style.display = ''; $('#app').style.display = 'none'; return; }
    $('#login').style.display = 'none'; $('#app').style.display = '';
    $('#who').textContent = email() + (S.me ? ' · ' + (S.me.van_location_id || S.me.role) : '');
    try { if (navigator.onLine) { await loadMaster(); await loadBalances([myVan()]); } }
    catch (e) { if (/not on the People list/.test(e.message)) { alert(e.message); ['session', 'me'].forEach(LS.del); location.reload(); return; } console.warn(e); }
    $('#who').textContent = email() + (S.me ? ' · ' + (S.me.van_location_id || S.me.role) : '');
    updateSync(); flush(); go('van');
  }
  $$('[data-go]').forEach(b => { b.onclick = () => go(b.dataset.go); });
  $('#login-send').onclick = sendCode; $('#login-verify').onclick = verifyCode;
  $('#login-back').onclick = () => { $('#login-step1').style.display = ''; $('#login-step2').style.display = 'none'; };
  $('#login-email').value = LS.get('login_email', '');
  $('#login-code').onkeydown = e => { if (e.key === 'Enter') verifyCode(); };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  boot();
})();

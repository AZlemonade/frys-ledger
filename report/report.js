/* Fry's Ledger inventory report v1.2 — AZ Lemonade Stand.
   Reads the azls-frys-ledger views over the Supabase REST API. Read only. */
(function () {
  'use strict';
  const CFG = window.LEDGER_CONFIG || {};
  const URL0 = (CFG.url || '').replace(/\/+$/, '');
  const KEY = CFG.key || '';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const S = {
    session: LS.get('session', null), rows: [], value: [], shrink: [], opening: [], locs: [], skus: [],
    byLoc: {}, skuById: {}, people: {}, bal: {}, open: new Set(),
    day: { date: '', rows: [], stops: [], open: new Set() },
    sort: { stores: { k: 'value', dir: -1 }, shrink: { k: 'value', dir: 1 } }
  };
  const email = () => S.session && S.session.user && S.session.user.email;

  // ---------- http ----------
  async function refreshToken() {
    if (!S.session || !S.session.refresh_token) return false;
    const r = await fetch(URL0 + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: S.session.refresh_token }) });
    if (!r.ok) return false;
    setSession(await r.json()); return true;
  }
  function setSession(j) {
    S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)), user: j.user };
    LS.set('session', S.session);
  }
  async function api(path, retried) {
    if (!S.session) throw new Error('not signed in');
    if (S.session.expires_at - 60 < Date.now() / 1000) { if (!(await refreshToken())) throw new Error('session expired'); }
    const r = await fetch(URL0 + '/rest/v1/' + path, { headers: { apikey: KEY, Authorization: 'Bearer ' + S.session.access_token } });
    if (r.status === 401 && !retried) { if (await refreshToken()) return api(path, true); }
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 160));
    return r.json();
  }
  // Supabase hands back at most 1,000 rows a request. Page through so nothing is quietly cut off.
  async function apiAll(path) {
    const out = [], sep = path.indexOf('?') > -1 ? '&' : '?';
    for (let off = 0; ; off += 1000) {
      const page = await api(path + sep + 'limit=1000&offset=' + off);
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  // ---------- formatting ----------
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const money2 = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = n => Math.round(n).toLocaleString();
  const signed = n => (n > 0 ? '+' : '') + num(n);
  const cases = n => (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const day = s => s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
  const daysSince = s => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TZ = 'America/Phoenix';                 // Arizona, no daylight saving: always UTC-7
  const clock = t => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const azToday = () => new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10);
  const shiftDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const longDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const sku = id => S.skuById[id] || { sku_id: id, name: id, units_per_case: 1, cost_per_case: 0 };
  const caseLoose = (units, upc) => {           // 150 on a 12-pack reads "12 cs + 6"
    upc = upc || 1; const a = Math.abs(units), c = Math.floor(a / upc), e = a - c * upc, sg = units < 0 ? '-' : '';
    return c && e ? sg + c + ' cs + ' + e : c ? sg + c + ' cs' : sg + e + ' ea';
  };
  const valueOf = (id, units) => { const s = sku(id); return units / (s.units_per_case || 1) * (+s.cost_per_case || 0); };
  const whoName = e => (S.people[(e || '').toLowerCase()] || {}).name || (e || '').split('@')[0] || 'unknown';
  const place = id => {
    if (id === 'PLANT') return 'Dunlap / STEM';
    if (id === 'VARIANCE') return 'Variance';
    if (id === 'WRITEOFF') return 'Write-off';
    if (id === 'DEMO') return 'Demo';
    const l = S.byLoc[id]; if (!l) return id;
    return l.type === 'STORE' ? (l.kroger_store_no || id) + ' · ' + (l.name || l.city || '') : (l.name || id);
  };

  // ---------- load ----------
  async function load() {
    const [tot, val, locs, skus, adj, counts, bal, people] = await Promise.all([
      apiAll('v_location_total?select=location_id,type,name,route,units,cases_equiv,value_at_cost,last_drop,last_count&order=location_id'),
      api('v_inventory_value?select=type,units,cases_equiv,value_at_cost'),
      apiAll('locations?select=location_id,kroger_store_no,name,city,merchandiser,route,type,active&order=location_id'),
      api('skus?select=sku_id,name,units_per_case,cost_per_case&order=sku_id'),
      apiAll('movements?select=id,from_loc,to_loc,sku_id,units,ts,user_email,source,ref&type=eq.COUNT_ADJ&order=id'),
      apiAll('counts?select=count_id,location_id,posted_at&order=posted_at'),
      apiAll('v_balance?select=location_id,sku_id,units&units=neq.0&order=location_id,sku_id'),
      api('people?select=email,name')
    ]);
    S.locs = locs; S.skus = skus; S.value = val;
    S.byLoc = Object.fromEntries(locs.map(l => [l.location_id, l]));
    S.skuById = Object.fromEntries(skus.map(s => [s.sku_id, s]));
    S.people = Object.fromEntries(people.map(p => [(p.email || '').toLowerCase(), p]));
    S.bal = {};
    bal.forEach(b => { (S.bal[b.location_id] = S.bal[b.location_id] || []).push(b); });
    S.rows = tot.map(t => {
      const l = S.byLoc[t.location_id] || {};
      return {
        id: t.location_id, type: t.type, store: l.kroger_store_no || t.location_id, name: t.name,
        route: t.route || l.route || '', merch: l.merchandiser || '', city: l.city || '',
        units: +t.units || 0, cases: +t.cases_equiv || 0, value: +t.value_at_cost || 0,
        last_drop: t.last_drop, last_count: t.last_count
      };
    });

    // The first count at a location measures what was already there before the ledger existed.
    // That is opening stock, not shrink, so it is reported on its own line and kept out of shrink.
    // Hand corrections (source manual) sit with it for the same reason.
    const firstCount = {};
    counts.filter(c => c.posted_at).forEach(c => { if (!firstCount[c.location_id]) firstCount[c.location_id] = c.count_id; });
    S.shrink = []; S.opening = [];
    adj.forEach(m => {
      const s = sku(m.sku_id);
      const loss = m.to_loc === 'VARIANCE';           // stock left the location
      const units = loss ? -Math.abs(m.units) : Math.abs(m.units);
      const locId = loss ? m.from_loc : m.to_loc;
      const l = S.byLoc[locId] || {};
      const row = {
        loc_id: locId,
        locName: (l.kroger_store_no ? l.kroger_store_no + ' · ' : '') + (l.city || l.name || locId || ''),
        route: l.route || '(none)', sku: s.name,
        units, cases: units / (s.units_per_case || 1), value: units / (s.units_per_case || 1) * (+s.cost_per_case || 0),
        ts: m.ts, who: m.user_email
      };
      const opening = m.source !== 'count' || !m.ref || m.ref === firstCount[locId];
      (opening ? S.opening : S.shrink).push(row);
    });
    render();
    if (!S.day.date) S.day.date = azToday();
    $('#d-date').value = S.day.date;
    await loadDay(S.day.date);
  }

  // ---------- render ----------
  function render() {
    const stores = S.rows.filter(r => r.type === 'STORE');
    const totalValue = S.rows.reduce((a, r) => a + r.value, 0);
    const storeValue = stores.reduce((a, r) => a + r.value, 0);
    const shrinkUnits = S.shrink.reduce((a, r) => a + r.units, 0);
    const shrinkValue = S.shrink.reduce((a, r) => a + r.value, 0);
    const openUnits = S.opening.reduce((a, r) => a + r.units, 0);
    const counted = stores.filter(r => r.last_count).length;
    const stale = stores.filter(r => { const d = daysSince(r.last_count); return d === null || d > 30; }).length;

    $('#asof').textContent = 'As of ' + new Date().toLocaleString() + ' · signed in as ' + email();
    $('#tiles').innerHTML = [
      tile('Inventory at cost', money(totalValue), num(S.rows.reduce((a, r) => a + r.units, 0)) + ' units across ' + S.rows.filter(r => r.units !== 0).length + ' locations holding stock'),
      tile('On consignment in stores', money(storeValue), stores.filter(r => r.units !== 0).length + ' of ' + stores.length + ' stores holding stock'),
      tile('Shrink since opening', money(shrinkValue), num(shrinkUnits) + ' units over ' + S.shrink.length + ' adjustments' + (openUnits ? ' · first counts excluded' : '')),
      tile('Counts', counted + ' of ' + stores.length, stale + ' not counted in 30 days')
    ].join('');

    // month-end value
    const order = ['STORE', 'VAN', 'WAREHOUSE'];
    const label = { STORE: 'Stores (consignment)', VAN: 'Vans and trucks', WAREHOUSE: 'Warehouses' };
    const vrows = order.filter(t => S.value.some(v => v.type === t)).map(t => {
      const v = S.value.find(x => x.type === t);
      const n = S.rows.filter(r => r.type === t).length;
      return `<tr><td>${label[t] || t}</td><td class="num">${n}</td><td class="num">${num(v.units)}</td><td class="num">${cases(v.cases_equiv)}</td><td class="num">${money2(v.value_at_cost)}</td></tr>`;
    });
    fill('#t-value', vrows, `<tr><td>Total</td><td class="num">${S.rows.length}</td><td class="num">${num(S.rows.reduce((a, r) => a + r.units, 0))}</td><td class="num">${cases(S.rows.reduce((a, r) => a + r.cases, 0))}</td><td class="num">${money2(totalValue)}</td></tr>`, 'Nothing in the ledger yet.');

    // route filter options
    const routes = [...new Set(S.rows.map(r => r.route).filter(Boolean))].sort();
    const sel = $('#f-route'), keep = sel.value;
    sel.innerHTML = '<option value="">All routes</option>' + routes.map(r => `<option${r === keep ? ' selected' : ''}>${r}</option>`).join('');

    renderStores(); renderShrink();
  }
  function tile(lab, val, sub) { return `<div class="tile"><div class="lab">${lab}</div><div class="val">${val}</div><div class="sub2">${sub}</div></div>`; }
  function fill(sel, rows, footHtml, emptyMsg) {
    const t = $(sel);
    t.querySelector('tbody').innerHTML = rows.length ? rows.join('') : `<tr><td colspan="9"><div class="empty">${emptyMsg}</div></td></tr>`;
    t.querySelector('tfoot').innerHTML = rows.length ? footHtml : '';
  }

  function storeRows() {
    const q = ($('#q-stores').value || '').toLowerCase().trim();
    const route = $('#f-route').value, type = $('#f-type').value;
    const empties = $('#f-empty').value === 'all';
    let rows = S.rows.filter(r => (!type || r.type === type) && (!route || r.route === route) && (empties || r.units !== 0));
    if (q) rows = rows.filter(r => (r.store + ' ' + r.name + ' ' + r.city + ' ' + r.merch + ' ' + r.route).toLowerCase().includes(q));
    const s = S.sort.stores;
    return rows.sort((a, b) => {
      const x = a[s.k], y = b[s.k];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * s.dir;
      return String(x || '').localeCompare(String(y || '')) * s.dir;
    });
  }
  // One location's stock by SKU, largest value first.
  function skuLines(id) {
    return (S.bal[id] || []).map(b => {
      const s = sku(b.sku_id);
      return { sku_id: b.sku_id, name: s.name, upc: s.units_per_case || 1, units: +b.units || 0, value: valueOf(b.sku_id, +b.units || 0) };
    }).sort((a, b) => b.value - a.value);
  }
  function detailRow(r) {
    const lines = skuLines(r.id);
    const body = lines.length ? lines.map(l =>
      `<tr><td>${l.sku_id}</td><td>${esc(l.name)}</td><td class="num${l.units < 0 ? ' neg' : ''}">${num(l.units)}</td><td class="num">${caseLoose(l.units, l.upc)}</td><td class="num${l.value < 0 ? ' neg' : ''}">${money2(l.value)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="dim">Nothing on the book here.</td></tr>';
    return `<tr class="detail"><td colspan="9"><table class="sub"><thead><tr><th>SKU</th><th>Product</th><th class="num">Units</th><th class="num">Cases</th><th class="num">Value at cost</th></tr></thead><tbody>${body}</tbody></table></td></tr>`;
  }
  function renderStores() {
    const rows = storeRows();
    const html = rows.map(r => {
      const d = daysSince(r.last_count);
      const isOpen = S.open.has(r.id);
      const cnt = r.last_count ? `<span class="pill${d > 30 ? ' stale' : ''}">${day(r.last_count)}${d > 30 ? ' · ' + d + 'd' : ''}</span>` : '<span class="pill stale">never</span>';
      return `<tr class="loc${isOpen ? ' open' : ''}" data-id="${esc(r.id)}"><td><span class="chev">${isOpen ? '▾' : '▸'}</span>${r.store}</td><td>${esc(r.name)}${r.city ? ' <span style="color:var(--ink-3)">· ' + esc(r.city) + '</span>' : ''}</td><td>${r.route || '—'}</td><td>${r.merch || '—'}</td>` +
        `<td class="num${r.units < 0 ? ' neg' : ''}">${num(r.units)}</td><td class="num">${cases(r.cases)}</td><td class="num${r.value < 0 ? ' neg' : ''}">${money2(r.value)}</td>` +
        `<td>${day(r.last_drop)}</td><td>${cnt}</td></tr>` + (isOpen ? detailRow(r) : '');
    });
    fill('#t-stores', html,
      `<tr><td colspan="4">${rows.length} location${rows.length === 1 ? '' : 's'}</td><td class="num">${num(rows.reduce((a, r) => a + r.units, 0))}</td><td class="num">${cases(rows.reduce((a, r) => a + r.cases, 0))}</td><td class="num">${money2(rows.reduce((a, r) => a + r.value, 0))}</td><td></td><td></td></tr>`,
      'Nothing with stock here. Switch to "Empty locations too" to see every location, or wait for the first drop.');
    const all = rows.length && rows.every(r => S.open.has(r.id));
    $('#expand-all').textContent = all ? 'Collapse all' : 'Expand all';
  }

  function shrinkGroups() {
    const by = $('#f-shrink').value;
    const key = r => by === 'route' ? r.route : by === 'sku' ? r.sku : r.locName;
    const m = new Map();
    S.shrink.forEach(r => {
      const k = key(r) || '(none)';
      const g = m.get(k) || { name: k, units: 0, cases: 0, value: 0, events: 0 };
      g.units += r.units; g.cases += r.cases; g.value += r.value; g.events++;
      m.set(k, g);
    });
    const s = S.sort.shrink;
    return [...m.values()].sort((a, b) => {
      const x = a[s.k], y = b[s.k];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * s.dir;
      return String(x).localeCompare(String(y)) * s.dir;
    });
  }
  function renderShrink() {
    const groups = shrinkGroups();
    const ou = S.opening.reduce((a, r) => a + r.units, 0), ov = S.opening.reduce((a, r) => a + r.value, 0);
    const onet = {}; S.opening.forEach(r => { onet[r.loc_id] = (onet[r.loc_id] || 0) + r.units; });
    const olocs = Object.values(onet).filter(v => v !== 0).length;   // a +4 and a -4 that cancel is not a location
    $('#shrink-opening').innerHTML = S.opening.length
      ? `<b>Opening stock found by first counts: ${signed(ou)} units, ${money2(ov)} at cost, across ${olocs} location${olocs === 1 ? '' : 's'}.</b> Not shrink. A location's first count measures what was already there before the ledger started, so it is kept out of the numbers below. Shrink starts with each location's second count.`
      : '';
    const chart = $('#shrink-chart');
    if (!groups.length) {
      chart.innerHTML = '<div class="empty">No shrink yet. It starts showing once a location has been counted a second time.</div>';
    } else {
      const max = Math.max(...groups.map(g => Math.abs(g.value)), 1);
      const top = [...groups].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 8);
      chart.innerHTML = '<div style="font-size:13px;color:var(--ink-3);margin-bottom:6px">Biggest movers by value at cost</div>' +
        top.map(g => `<div class="row"><div class="name" title="${esc(g.name)}">${esc(g.name)}</div>` +
          `<div class="track"><div class="fill${g.value >= 0 ? ' up' : ''}" style="width:${Math.max(2, Math.abs(g.value) / max * 100)}%"></div></div>` +
          `<div class="amt${g.value < 0 ? ' neg' : ' pos'}">${money2(g.value)}</div></div>`).join('');
    }
    const html = groups.map(g => `<tr><td>${esc(g.name)}</td><td class="num${g.units < 0 ? ' neg' : ' pos'}">${num(g.units)}</td><td class="num">${cases(g.cases)}</td><td class="num${g.value < 0 ? ' neg' : ' pos'}">${money2(g.value)}</td><td class="num">${g.events}</td></tr>`);
    fill('#t-shrink', html,
      `<tr><td>Total</td><td class="num">${num(groups.reduce((a, g) => a + g.units, 0))}</td><td class="num">${cases(groups.reduce((a, g) => a + g.cases, 0))}</td><td class="num">${money2(groups.reduce((a, g) => a + g.value, 0))}</td><td class="num">${groups.reduce((a, g) => a + g.events, 0)}</td></tr>`,
      'Nothing adjusted yet.');
  }

  // ---------- daily activity ----------
  const KIND = { LOAD: 'Load', DROP: 'Drop', RETURN: 'Return', STORE_XFER: 'Pickup', TRANSFER_IN: 'Transfer in', WRITEOFF: 'Write-off', DEMO: 'Demo', SOLD: 'Sold', COUNT_ADJ: 'Count', MIX_CORR: 'Correction' };
  async function loadDay(date) {
    S.day.date = date; S.day.open = new Set();
    $('#d-title').textContent = longDate(date);
    $('#d-body').innerHTML = '<div class="empty">Loading…</div>';
    // A day is midnight to midnight in Arizona. The phone's own clock (device_ts) decides the day
    // when there is one, so a drop that synced after midnight still lands on the day it happened.
    const a = new Date(date + 'T07:00:00Z').toISOString(), b = new Date(Date.parse(date + 'T07:00:00Z') + 864e5).toISOString();
    const or = '(and(device_ts.gte."' + a + '",device_ts.lt."' + b + '"),and(device_ts.is.null,ts.gte."' + a + '",ts.lt."' + b + '"))';
    try {
      S.day.rows = await apiAll('movements?select=id,ts,device_ts,type,from_loc,to_loc,sku_id,units,user_email,batch_id,ref,note&or=' + encodeURIComponent(or) + '&order=id');
    } catch (e) { $('#d-body').innerHTML = '<div class="msg err">Could not load that day: ' + esc(e.message) + '</div>'; return; }
    S.day.stops = buildStops(S.day.rows);
    renderDay();
  }
  // One stop = one save on the phone: a drop at a store, a load at a warehouse, one count.
  function buildStops(rows) {
    const m = new Map();
    rows.forEach(r => {
      const t = r.device_ts || r.ts;
      const count = r.type === 'COUNT_ADJ';
      const at = count ? (r.to_loc === 'VARIANCE' ? r.from_loc : r.to_loc) : null;
      const key = count ? 'C|' + (r.ref || r.batch_id || r.id) + '|' + at : (r.batch_id || 'R' + r.id) + '|' + r.type + '|' + r.from_loc + '|' + r.to_loc;
      let s = m.get(key);
      if (!s) { s = { key, who: (r.user_email || '').toLowerCase(), type: r.type, from: r.from_loc, to: r.to_loc, at, t, lines: [], note: r.note || '' }; m.set(key, s); }
      if (t < s.t) s.t = t;
      const u = count ? (r.to_loc === 'VARIANCE' ? -r.units : r.units) : r.units;
      s.lines.push({ sku_id: r.sku_id, units: u });
    });
    return [...m.values()].map(s => {
      s.units = s.lines.reduce((a, l) => a + l.units, 0);
      s.value = s.lines.reduce((a, l) => a + valueOf(l.sku_id, l.units), 0);
      return s;
    }).sort((x, y) => (x.t < y.t ? -1 : 1));
  }
  function dayFilter(s) {
    const f = $('#d-type').value;
    if (!f) return true;
    if (f === 'DROP') return s.type === 'DROP';
    if (f === 'LOAD') return s.type === 'LOAD' || s.type === 'RETURN';
    if (f === 'COUNT') return s.type === 'COUNT_ADJ';
    return !['DROP', 'LOAD', 'RETURN', 'COUNT_ADJ'].includes(s.type);
  }
  function stopWhere(s) {
    if (s.type === 'COUNT_ADJ') return place(s.at);
    if (s.type === 'DROP') return place(s.to);
    if (s.type === 'LOAD') return place(s.from) + ' → ' + place(s.to);
    return place(s.from) + ' → ' + place(s.to);
  }
  function renderDay() {
    const stops = S.day.stops.filter(dayFilter);
    const drops = S.day.stops.filter(s => s.type === 'DROP');
    const loads = S.day.stops.filter(s => s.type === 'LOAD');
    const cnts = S.day.stops.filter(s => s.type === 'COUNT_ADJ');
    $('#d-tiles').innerHTML = [
      tile('Stores dropped', String(new Set(drops.map(s => s.to)).size), drops.length + ' drop' + (drops.length === 1 ? '' : 's')),
      tile('Units dropped', num(drops.reduce((a, s) => a + s.units, 0)), money2(drops.reduce((a, s) => a + s.value, 0)) + ' at cost'),
      tile('Units loaded', num(loads.reduce((a, s) => a + s.units, 0)), loads.length + ' load' + (loads.length === 1 ? '' : 's') + ' out of the warehouses'),
      tile('Counts', String(cnts.length), cnts.length ? 'net ' + signed(cnts.reduce((a, s) => a + s.units, 0)) + ' units against the book' : 'none this day')
    ].join('');
    if (!stops.length) {
      $('#d-body').innerHTML = '<div class="empty">' + (S.day.stops.length ? 'Nothing of that kind on this day. Switch the filter to All activity.' : 'Nothing was recorded on ' + longDate(S.day.date) + '.') + '</div>';
      return;
    }
    const byWho = new Map();
    stops.forEach(s => { (byWho.get(s.who) || byWho.set(s.who, []).get(s.who)).push(s); });
    const people = [...byWho.entries()].sort((x, y) => whoName(x[0]).localeCompare(whoName(y[0])));
    $('#d-body').innerHTML = people.map(([who, list]) => {
      const dr = list.filter(s => s.type === 'DROP');
      const head = `<div class="who"><b>${esc(whoName(who))}</b><span>${list.length} stop${list.length === 1 ? '' : 's'}` +
        (dr.length ? ` · dropped ${num(dr.reduce((a, s) => a + s.units, 0))} units (${money2(dr.reduce((a, s) => a + s.value, 0))}) at ${new Set(dr.map(s => s.to)).size} store${new Set(dr.map(s => s.to)).size === 1 ? '' : 's'}` : '') + '</span></div>';
      const rows = list.map(s => {
        const isOpen = S.day.open.has(s.key);
        const cnt = s.type === 'COUNT_ADJ';
        const main = `<tr class="stop${isOpen ? ' open' : ''}" data-key="${esc(s.key)}"><td><span class="chev">${isOpen ? '▾' : '▸'}</span>${clock(s.t)}</td>` +
          `<td><span class="kind k-${s.type}">${KIND[s.type] || s.type}</span></td><td>${esc(stopWhere(s))}</td>` +
          `<td class="num">${s.lines.length}</td><td class="num${cnt && s.units < 0 ? ' neg' : ''}">${cnt ? signed(s.units) : num(s.units)}</td><td class="num${s.value < 0 ? ' neg' : ''}">${money2(s.value)}</td></tr>`;
        if (!isOpen) return main;
        const lines = [...s.lines].sort((x, y) => x.sku_id.localeCompare(y.sku_id)).map(l => {
          const k = sku(l.sku_id), v = valueOf(l.sku_id, l.units);
          return `<tr><td>${l.sku_id}</td><td>${esc(k.name)}</td><td class="num${l.units < 0 ? ' neg' : ''}">${cnt ? signed(l.units) : num(l.units)}</td><td class="num">${caseLoose(l.units, k.units_per_case)}</td><td class="num${v < 0 ? ' neg' : ''}">${money2(v)}</td></tr>`;
        }).join('');
        const note = s.note ? `<div class="dim" style="margin:4px 0 0">Note: ${esc(s.note)}</div>` : '';
        return main + `<tr class="detail"><td colspan="6"><table class="sub"><thead><tr><th>SKU</th><th>Product</th><th class="num">${cnt ? 'Variance' : 'Units'}</th><th class="num">Cases</th><th class="num">Value at cost</th></tr></thead><tbody>${lines}</tbody></table>${note}</td></tr>`;
      }).join('');
      return `<div class="dayblock">${head}<div class="wrap"><table class="daytab"><thead><tr><th>Time</th><th>What</th><th>Where</th><th class="num">SKUs</th><th class="num">Units</th><th class="num">Value at cost</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('');
  }

  // ---------- csv ----------
  function csv(name, header, rows) {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const body = [header, ...rows].map(r => r.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function download(which) {
    if (which === 'value') {
      csv('frys-ledger-inventory-value', ['Where', 'Locations', 'Units', 'Cases', 'Value at cost'],
        S.value.map(v => [v.type, S.rows.filter(r => r.type === v.type).length, v.units, v.cases_equiv, v.value_at_cost]));
    } else if (which === 'stores') {
      csv('frys-ledger-balances', ['Store', 'Name', 'City', 'Route', 'Merchandiser', 'Type', 'Units', 'Cases', 'Value at cost', 'Last drop', 'Last count'],
        storeRows().map(r => [r.store, r.name, r.city, r.route, r.merch, r.type, r.units, r.cases.toFixed(1), r.value.toFixed(2), r.last_drop || '', r.last_count || '']));
    } else if (which === 'stores-sku') {
      const out = [];
      storeRows().forEach(r => skuLines(r.id).forEach(l => out.push([r.store, r.name, r.city, r.route, r.type, l.sku_id, l.name, l.units, (l.units / l.upc).toFixed(2), l.value.toFixed(2)])));
      csv('frys-ledger-balances-by-sku', ['Store', 'Name', 'City', 'Route', 'Type', 'SKU', 'Product', 'Units', 'Cases', 'Value at cost'], out);
    } else if (which === 'day') {
      const out = [];
      S.day.stops.filter(dayFilter).forEach(s => s.lines.forEach(l => {
        const k = sku(l.sku_id);
        out.push([S.day.date, clock(s.t), whoName(s.who), KIND[s.type] || s.type, place(s.type === 'COUNT_ADJ' ? s.at : s.from), place(s.type === 'COUNT_ADJ' ? s.at : s.to), l.sku_id, k.name, l.units, (l.units / (k.units_per_case || 1)).toFixed(2), valueOf(l.sku_id, l.units).toFixed(2), s.note]);
      }));
      csv('frys-ledger-activity-' + S.day.date, ['Date', 'Time (AZ)', 'Merchandiser', 'What', 'From', 'To', 'SKU', 'Product', 'Units', 'Cases', 'Value at cost', 'Note'], out);
    } else {
      csv('frys-ledger-shrink', ['Name', 'Units', 'Cases', 'Value at cost', 'Adjustments'],
        shrinkGroups().map(g => [g.name, g.units, g.cases.toFixed(1), g.value.toFixed(2), g.events]));
    }
  }

  // ---------- wiring ----------
  $$('#t-stores th[data-k]').forEach(th => th.onclick = () => {
    const k = th.dataset.k, s = S.sort.stores;
    s.dir = s.k === k ? -s.dir : (['units', 'cases', 'value'].includes(k) ? -1 : 1); s.k = k; renderStores();
  });
  $$('#t-shrink th[data-k]').forEach(th => th.onclick = () => {
    const k = th.dataset.k, s = S.sort.shrink;
    s.dir = s.k === k ? -s.dir : 1; s.k = k; renderShrink();
  });
  $('#t-stores tbody').onclick = e => {
    const tr = e.target.closest('tr.loc'); if (!tr) return;
    const id = tr.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderStores();
  };
  $('#expand-all').onclick = () => {
    const rows = storeRows(), all = rows.length && rows.every(r => S.open.has(r.id));
    rows.forEach(r => all ? S.open.delete(r.id) : S.open.add(r.id)); renderStores();
  };
  $('#d-body').onclick = e => {
    const tr = e.target.closest('tr.stop'); if (!tr) return;
    const k = tr.dataset.key; S.day.open.has(k) ? S.day.open.delete(k) : S.day.open.add(k); renderDay();
  };
  $('#d-date').onchange = () => { if ($('#d-date').value) loadDay($('#d-date').value); };
  $('#d-prev').onclick = () => { const d = shiftDay(S.day.date, -1); $('#d-date').value = d; loadDay(d); };
  $('#d-next').onclick = () => { const d = shiftDay(S.day.date, 1); $('#d-date').value = d; loadDay(d); };
  $('#d-today').onclick = () => { const d = azToday(); $('#d-date').value = d; loadDay(d); };
  $('#d-type').onchange = renderDay;
  $('#q-stores').oninput = renderStores;
  $('#f-route').onchange = renderStores;
  $('#f-type').onchange = renderStores;
  $('#f-empty').onchange = renderStores;
  $('#f-shrink').onchange = renderShrink;
  $$('[data-csv]').forEach(b => b.onclick = () => download(b.dataset.csv));
  $('#refresh').onclick = async () => { $('#refresh').disabled = true; try { await load(); } catch (e) { alertErr(e); } $('#refresh').disabled = false; };
  $('#signout').onclick = () => { ['session'].forEach(LS.del); location.reload(); };

  async function signIn() {
    const em = ($('#login-email').value || '').trim().toLowerCase();
    const pw = $('#login-password').value || '';
    if (!em.includes('@') || !pw) { $('#login-msg').innerHTML = '<div class="msg err">Enter your email and password.</div>'; return; }
    $('#login-signin').disabled = true;
    try {
      const r = await fetch(URL0 + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, password: pw }) });
      if (!r.ok) { const t = await r.text(); $('#login-msg').innerHTML = '<div class="msg err">' + (/invalid/i.test(t) ? 'That email and password did not match.' : t.slice(0, 140)) + '</div>'; return; }
      setSession(await r.json());
      $('#login-password').value = '';
      await boot();
    } finally { $('#login-signin').disabled = false; }
  }
  function alertErr(e) { $('#asof').textContent = 'Could not load: ' + (e.message || e); }
  $('#login-signin').onclick = signIn;
  $('#login-password').onkeydown = e => { if (e.key === 'Enter') signIn(); };
  $('#login-email').value = LS.get('login_email', '');

  async function boot() {
    if (!S.session) { $('#login').style.display = ''; $('#app').style.display = 'none'; return; }
    $('#login').style.display = 'none'; $('#app').style.display = '';
    try { await load(); } catch (e) {
      if (/not signed in|session expired/i.test(e.message)) { LS.del('session'); location.reload(); return; }
      alertErr(e);
    }
  }
  boot();
})();

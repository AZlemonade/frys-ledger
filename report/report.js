/* Fry's Ledger inventory report v1.0 — AZ Lemonade Stand.
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

  const S = { session: LS.get('session', null), rows: [], value: [], shrink: [], locs: [], skus: [], sort: { stores: { k: 'value', dir: -1 }, shrink: { k: 'value', dir: 1 } } };
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

  // ---------- formatting ----------
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const money2 = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = n => Math.round(n).toLocaleString();
  const cases = n => (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const day = s => s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
  const daysSince = s => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null;

  // ---------- load ----------
  async function load() {
    const [tot, val, locs, skus, adj] = await Promise.all([
      api('v_location_total?select=location_id,type,name,route,units,cases_equiv,value_at_cost,last_drop,last_count'),
      api('v_inventory_value?select=type,units,cases_equiv,value_at_cost'),
      api('locations?select=location_id,kroger_store_no,city,merchandiser,route,type,active'),
      api('skus?select=sku_id,name,units_per_case,cost_per_case'),
      api('movements?select=from_loc,to_loc,sku_id,units,ts,user_email&type=eq.COUNT_ADJ&order=ts')
    ]);
    S.locs = locs; S.skus = skus; S.value = val;
    const byLoc = Object.fromEntries(locs.map(l => [l.location_id, l]));
    S.rows = tot.map(t => {
      const l = byLoc[t.location_id] || {};
      return {
        id: t.location_id, type: t.type, store: l.kroger_store_no || t.location_id, name: t.name,
        route: t.route || l.route || '', merch: l.merchandiser || '', city: l.city || '',
        units: +t.units || 0, cases: +t.cases_equiv || 0, value: +t.value_at_cost || 0,
        last_drop: t.last_drop, last_count: t.last_count
      };
    });
    const skuById = Object.fromEntries(skus.map(s => [s.sku_id, s]));
    S.shrink = adj.map(m => {
      const s = skuById[m.sku_id] || { units_per_case: 1, cost_per_case: 0, name: m.sku_id };
      const loss = m.to_loc === 'VARIANCE';           // stock left the location
      const signed = loss ? -Math.abs(m.units) : Math.abs(m.units);
      const loc = byLoc[loss ? m.from_loc : m.to_loc] || {};
      return {
        loc_id: loss ? m.from_loc : m.to_loc,
        locName: (loc.kroger_store_no ? loc.kroger_store_no + ' · ' : '') + (loc.city || loc.location_id || ''),
        route: loc.route || '(none)', sku: s.name,
        units: signed, cases: signed / (s.units_per_case || 1),
        value: signed / (s.units_per_case || 1) * (+s.cost_per_case || 0),
        ts: m.ts, who: m.user_email
      };
    });
    render();
  }

  // ---------- render ----------
  function render() {
    const stores = S.rows.filter(r => r.type === 'STORE');
    const totalValue = S.rows.reduce((a, r) => a + r.value, 0);
    const storeValue = stores.reduce((a, r) => a + r.value, 0);
    const shrinkUnits = S.shrink.reduce((a, r) => a + r.units, 0);
    const shrinkValue = S.shrink.reduce((a, r) => a + r.value, 0);
    const counted = stores.filter(r => r.last_count).length;
    const stale = stores.filter(r => { const d = daysSince(r.last_count); return d === null || d > 30; }).length;

    $('#asof').textContent = 'As of ' + new Date().toLocaleString() + ' · signed in as ' + email();
    $('#tiles').innerHTML = [
      tile('Inventory at cost', money(totalValue), num(S.rows.reduce((a, r) => a + r.units, 0)) + ' units across ' + S.rows.length + ' locations'),
      tile('On consignment in stores', money(storeValue), stores.length + ' stores holding stock'),
      tile('Shrink since opening', money(shrinkValue), num(shrinkUnits) + ' units over ' + S.shrink.length + ' adjustments'),
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
    let rows = S.rows.filter(r => (!type || r.type === type) && (!route || r.route === route));
    if (q) rows = rows.filter(r => (r.store + ' ' + r.name + ' ' + r.city + ' ' + r.merch + ' ' + r.route).toLowerCase().includes(q));
    const s = S.sort.stores;
    return rows.sort((a, b) => {
      const x = a[s.k], y = b[s.k];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * s.dir;
      return String(x || '').localeCompare(String(y || '')) * s.dir;
    });
  }
  function renderStores() {
    const rows = storeRows();
    const html = rows.map(r => {
      const d = daysSince(r.last_count);
      const cnt = r.last_count ? `<span class="pill${d > 30 ? ' stale' : ''}">${day(r.last_count)}${d > 30 ? ' · ' + d + 'd' : ''}</span>` : '<span class="pill stale">never</span>';
      return `<tr><td>${r.store}</td><td>${r.name}${r.city ? ' <span style="color:var(--ink-3)">· ' + r.city + '</span>' : ''}</td><td>${r.route || '—'}</td><td>${r.merch || '—'}</td>` +
        `<td class="num${r.units < 0 ? ' neg' : ''}">${num(r.units)}</td><td class="num">${cases(r.cases)}</td><td class="num${r.value < 0 ? ' neg' : ''}">${money2(r.value)}</td>` +
        `<td>${day(r.last_drop)}</td><td>${cnt}</td></tr>`;
    });
    fill('#t-stores', html,
      `<tr><td colspan="4">${rows.length} location${rows.length === 1 ? '' : 's'}</td><td class="num">${num(rows.reduce((a, r) => a + r.units, 0))}</td><td class="num">${cases(rows.reduce((a, r) => a + r.cases, 0))}</td><td class="num">${money2(rows.reduce((a, r) => a + r.value, 0))}</td><td></td><td></td></tr>`,
      'No stock at these locations yet. It shows up here as soon as the first drop is logged.');
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
    const chart = $('#shrink-chart');
    if (!groups.length) {
      chart.innerHTML = '<div class="empty">No count adjustments yet. Once the opening counts are posted, anything that came up short shows here.</div>';
    } else {
      const max = Math.max(...groups.map(g => Math.abs(g.value)), 1);
      const top = [...groups].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 8);
      chart.innerHTML = '<div style="font-size:13px;color:var(--ink-3);margin-bottom:6px">Biggest movers by value at cost</div>' +
        top.map(g => `<div class="row"><div class="name" title="${g.name}">${g.name}</div>` +
          `<div class="track"><div class="fill${g.value >= 0 ? ' up' : ''}" style="width:${Math.max(2, Math.abs(g.value) / max * 100)}%"></div></div>` +
          `<div class="amt${g.value < 0 ? ' neg' : ' pos'}">${money2(g.value)}</div></div>`).join('');
    }
    const html = groups.map(g => `<tr><td>${g.name}</td><td class="num${g.units < 0 ? ' neg' : ' pos'}">${num(g.units)}</td><td class="num">${cases(g.cases)}</td><td class="num${g.value < 0 ? ' neg' : ' pos'}">${money2(g.value)}</td><td class="num">${g.events}</td></tr>`);
    fill('#t-shrink', html,
      `<tr><td>Total</td><td class="num">${num(groups.reduce((a, g) => a + g.units, 0))}</td><td class="num">${cases(groups.reduce((a, g) => a + g.cases, 0))}</td><td class="num">${money2(groups.reduce((a, g) => a + g.value, 0))}</td><td class="num">${groups.reduce((a, g) => a + g.events, 0)}</td></tr>`,
      'Nothing adjusted yet.');
  }

  // ---------- csv ----------
  function csv(name, header, rows) {
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const body = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
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
  $('#q-stores').oninput = renderStores;
  $('#f-route').onchange = renderStores;
  $('#f-type').onchange = renderStores;
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

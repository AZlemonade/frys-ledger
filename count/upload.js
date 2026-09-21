/* Fry's Ledger warehouse count upload v1.1 — AZ Lemonade Stand.
   Takes a pasted or uploaded sheet of warehouse stock and writes it to the ledger, either as an
   opening transfer in (no variance) or as a full recount (variance against the book). */
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
    session: LS.get('session', null), me: null,
    skus: [], locs: [], barcodes: [], book: {},
    loc: '', mode: 'open', lines: [], posted: false
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
  async function call(path, opts, retried) {
    if (!S.session) throw new Error('not signed in');
    if (S.session.expires_at - 60 < Date.now() / 1000) { if (!(await refreshToken())) throw new Error('session expired'); }
    const o = opts || {};
    const headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + S.session.access_token }, o.headers || {});
    if (o.body != null) headers['Content-Type'] = 'application/json';
    const r = await fetch(URL0 + '/rest/v1/' + path, { method: o.method || 'GET', headers, body: o.body != null ? JSON.stringify(o.body) : undefined });
    if (r.status === 401 && !retried) { if (await refreshToken()) return call(path, opts, true); }
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  const api = p => call(p);
  const post = (p, body) => call(p, { method: 'POST', body, headers: { Prefer: 'return=minimal' } });

  // ---------- formatting ----------
  const money2 = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = n => Math.round(n).toLocaleString();
  const signed = n => (n > 0 ? '+' : '') + num(n);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const dez = s => s.replace(/(\d+)oz/g, '$1');   // the sheets say 32oz, the SKU list says 32
  const digits = s => String(s == null ? '' : s).replace(/\D/g, '');

  // ---------- load ----------
  async function load() {
    const [skus, locs, people, barcodes] = await Promise.all([
      api('skus?select=sku_id,name,units_per_case,cost_per_case,active&active=is.true&order=sku_id'),
      api('locations?select=location_id,name,type,active&type=eq.WAREHOUSE&active=is.true&order=name'),
      api('people?select=email,name,role,supervisor&email=eq.' + encodeURIComponent(email())),
      api('barcodes?select=code,sku_id')
    ]);
    S.skus = skus; S.locs = locs; S.barcodes = barcodes || [];
    S.me = (people && people[0]) || null;
    $('#who').textContent = 'signed in as ' + email() + (S.me ? ' · ' + S.me.role : '');

    const allowed = S.me && (/warehouse/i.test(S.me.role || '') || /admin/i.test(S.me.role || '') || S.me.supervisor);
    if (!allowed) {
      const d = $('#denied'); d.classList.remove('hide');
      d.textContent = 'This page writes warehouse stock to the ledger, so it is limited to Austin, Greyson and the warehouse manager. Count your own stores in the app instead.';
      return;
    }
    $('#work').classList.remove('hide');

    const sel = $('#loc');
    sel.innerHTML = '<option value="">Choose a warehouse</option>' + S.locs.map(l => '<option value="' + l.location_id + '">' + l.name + '</option>').join('');
    sel.onchange = pickLoc;
  }

  async function pickLoc() {
    S.loc = $('#loc').value; S.book = {}; S.posted = false;
    const st = $('#loc-state');
    if (!S.loc) { st.textContent = '…'; st.className = 'pill'; review(); return; }
    st.textContent = 'loading the book'; st.className = 'pill';
    try {
      const rows = await api('v_balance?select=sku_id,units&location_id=eq.' + encodeURIComponent(S.loc));
      rows.forEach(r => { S.book[r.sku_id] = +r.units || 0; });
    } catch (e) { st.textContent = 'could not load the book'; st.className = 'pill bad'; return; }
    const onBook = S.skus.filter(s => (S.book[s.sku_id] || 0) !== 0).length;
    const total = S.skus.reduce((a, s) => a + (S.book[s.sku_id] || 0), 0);
    if (onBook === 0) {
      st.textContent = 'nothing on the book yet'; st.className = 'pill warnp';
      setMode('open');
    } else {
      st.textContent = num(total) + ' units on the book across ' + onBook + ' SKUs'; st.className = 'pill';
      setMode('count');
    }
    review();
  }

  function setMode(m) {
    S.mode = m;
    $$('.mode').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    const n = $('#mode-note');
    const onBook = S.skus.filter(s => (S.book[s.sku_id] || 0) !== 0).length;
    if (m === 'count' && S.loc && onBook === 0) {
      n.className = 'msg warn'; n.classList.remove('hide');
      n.textContent = 'This warehouse has nothing on the book, so a recount would post the whole load as variance and the shrink report would read it as a gain. Opening balance is almost certainly what you want.';
    } else if (m === 'open' && onBook > 0) {
      n.className = 'msg warn'; n.classList.remove('hide');
      n.textContent = 'This warehouse already has ' + num(S.skus.reduce((a, s) => a + (S.book[s.sku_id] || 0), 0)) + ' units on the book. An opening balance adds to that rather than replacing it. If you are correcting a count, use Recount.';
    } else n.classList.add('hide');
  }

  // ---------- matching a sheet row to a SKU ----------
  let index = null;
  function buildIndex() {
    index = {};
    const put = (k, sku) => { if (k && !(k in index)) index[k] = sku; };
    S.skus.forEach(s => {
      put(norm(s.sku_id), s.sku_id);
      put(dez(norm(s.sku_id)), s.sku_id);
      put(norm(s.name), s.sku_id);
      put(dez(norm(s.name)), s.sku_id);
    });
    S.barcodes.forEach(b => put(digits(b.code), b.sku_id));
  }
  function matchSku(cell) {
    if (!index) buildIndex();
    const raw = String(cell == null ? '' : cell).trim();
    if (!raw) return null;
    const n0 = norm(raw), n = dez(n0);
    if (index[n0]) return index[n0];
    if (index[n]) return index[n];
    const d = digits(raw);
    if (d.length >= 11 && index[d]) return index[d];
    if (n.length < 4) return null;
    // the sheet says "32oz Strawberry Lemonade 12pk" and the SKU list says "32 Strawberry"
    let hit = null, best = 0;
    for (const s of S.skus) {
      const sn = dez(norm(s.name));
      if (sn && sn.length >= 4 && n.indexOf(sn) === 0 && sn.length > best) { hit = s.sku_id; best = sn.length; }
    }
    if (hit) return hit;
    // or the sheet is the short one: "32 Straw" against "32 Strawberry". Take the shortest fit.
    best = Infinity;
    for (const s of S.skus) {
      const sn = dez(norm(s.name));
      if (sn && sn.indexOf(n) === 0 && sn.length < best) { hit = s.sku_id; best = sn.length; }
    }
    return hit;
  }

  // ---------- parsing ----------
  function splitRow(line, sep) {
    if (sep === '\t') return line.split('\t');
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  }
  const isNum = v => v !== '' && v != null && isFinite(String(v).replace(/[$,\s]/g, ''));
  const toNum = v => +String(v).replace(/[$,\s]/g, '') || 0;

  function parse(text) {
    const raw = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
    if (!raw.length) return [];
    const sep = raw[0].indexOf('\t') > -1 ? '\t' : ',';
    let rows = raw.map(l => splitRow(l, sep).map(c => c.trim()));

    // header row?
    let cCase = -1, cUnit = -1, cSku = -1;
    const h = rows[0].map(c => c.toLowerCase());
    const looksHeader = h.some(c => /^(sku|item|product|code|description)/.test(c)) || h.some(c => /case/.test(c)) || h.some(c => /unit|each|bottle|jar|qty|quantity/.test(c));
    if (looksHeader && !rows[0].some(c => matchSku(c))) {
      h.forEach((c, i) => {
        if (cSku < 0 && /^(sku|item|product|code|description)/.test(c)) cSku = i;
        if (cCase < 0 && /case/.test(c) && !/per\s*case|\/\s*cs|units.*case/.test(c)) cCase = i;
        if (cUnit < 0 && /(loose|each|bottle|jar|unit)/.test(c) && !/per|\/\s*cs/.test(c)) cUnit = i;
        if (cUnit < 0 && cCase < 0 && /^(qty|quantity|count|on hand|onhand)/.test(c)) cCase = i;
      });
      rows = rows.slice(1);
    }

    return rows.map((cells, i) => {
      let sku = null, skuCell = '';
      if (cSku >= 0) { sku = matchSku(cells[cSku]); skuCell = cells[cSku] || ''; }
      if (!sku) for (const c of cells) { const m = matchSku(c); if (m) { sku = m; skuCell = c; break; } }

      let cs = 0, un = 0;
      if (cCase >= 0 || cUnit >= 0) {
        if (cCase >= 0 && isNum(cells[cCase])) cs = toNum(cells[cCase]);
        if (cUnit >= 0 && isNum(cells[cUnit])) un = toNum(cells[cUnit]);
      } else {
        const nums = [];
        cells.forEach((c, j) => { if (c !== skuCell && isNum(c)) nums.push(toNum(c)); });
        // a bare barcode column can look numeric; anything 11 digits or longer is not a quantity
        const qty = nums.filter(n => String(Math.abs(n)).length < 11);
        cs = qty.length ? qty[0] : 0;
        un = qty.length > 1 ? qty[1] : 0;
      }
      return { n: i + 1, raw: cells.join(' | '), sku_id: sku, cases: cs, eaches: un };
    });
  }

  // ---------- review ----------
  function build() {
    const parsed = parse($('#paste').value);
    const bySku = {};
    const bad = [];
    parsed.forEach(p => {
      if (!p.sku_id) { if (p.raw.replace(/[\s|]/g, '')) bad.push(p); return; }
      const s = skuOf(p.sku_id);
      const units = p.cases * (s.units_per_case || 1) + p.eaches;
      if (!bySku[p.sku_id]) bySku[p.sku_id] = { sku_id: p.sku_id, cases: 0, eaches: 0, units: 0, rows: 0 };
      const b = bySku[p.sku_id];
      b.cases += p.cases; b.eaches += p.eaches; b.units += units; b.rows++;
    });

    // every active SKU is a line: a recount has to say zero out loud
    S.lines = S.skus.map(s => {
      const b = bySku[s.sku_id];
      const book = S.book[s.sku_id] || 0;
      const counted = b ? b.units : 0;
      return {
        sku_id: s.sku_id, name: s.name, upc: s.units_per_case || 1, cost: +s.cost_per_case || 0,
        onSheet: !!b, rows: b ? b.rows : 0, cases: b ? b.cases : 0, eaches: b ? b.eaches : 0,
        counted, book, diff: counted - book
      };
    });
    S.bad = bad;
    S.parsedCount = parsed.length;
    return S.lines;
  }
  const skuOf = id => S.skus.find(s => s.sku_id === id) || { units_per_case: 1, cost_per_case: 0, name: id };
  const valueOf = l => l.counted / (l.upc || 1) * l.cost;

  function review() {
    const ps = $('#parse-state');
    if (!$('#paste').value.trim()) {
      ps.textContent = ''; $('#review').classList.add('hide'); $('#post-sec').classList.add('hide'); return;
    }
    build();
    const onSheet = S.lines.filter(l => l.onSheet);
    const missing = S.lines.filter(l => !l.onSheet && (S.mode === 'count' ? l.book !== 0 : false));
    ps.textContent = S.parsedCount + ' rows read · ' + onSheet.length + ' matched to a SKU' + (S.bad.length ? ' · ' + S.bad.length + ' not matched' : '');

    $('#review').classList.remove('hide');
    $('#post-sec').classList.remove('hide');
    $('#review-note').textContent = S.mode === 'open'
      ? 'These go in as a transfer from Dunlap / STEM. Nothing is compared to the book.'
      : 'Every active SKU is compared to the book. A SKU you did not count is counted as zero, which is what a full count means.';

    const totUnits = onSheet.reduce((a, l) => a + l.counted, 0);
    const totCases = onSheet.reduce((a, l) => a + l.counted / (l.upc || 1), 0);
    const totValue = onSheet.reduce((a, l) => a + valueOf(l), 0);
    const totDiff = S.lines.reduce((a, l) => a + l.diff, 0);
    const diffValue = S.lines.reduce((a, l) => a + l.diff / (l.upc || 1) * l.cost, 0);

    const tile = (lab, val, sub, cls) => '<div class="tile"><div class="lab">' + lab + '</div><div class="val' + (cls || '') + '">' + val + '</div><div class="sub2">' + sub + '</div></div>';
    $('#tiles').innerHTML = [
      tile('Counted', num(totUnits) + ' units', (Math.round(totCases * 10) / 10).toLocaleString() + ' cases across ' + onSheet.length + ' SKUs'),
      tile('Value at cost', money2(totValue), 'cost per case from the SKU list'),
      S.mode === 'count'
        ? tile('Variance', signed(totDiff) + ' units', money2(diffValue) + ' against the book', totDiff < 0 ? ' neg' : totDiff > 0 ? ' pos' : '')
        : tile('Goes in as', 'Transfer in', 'from Dunlap / STEM, no variance'),
      tile('Needs a look', String(S.bad.length + missing.length), S.bad.length + ' unmatched rows, ' + missing.length + ' on the book but not counted', (S.bad.length + missing.length) ? ' neg' : '')
    ].join('');

    const w = [];
    if (S.bad.length) w.push('<div class="msg err"><b>' + S.bad.length + ' row' + (S.bad.length > 1 ? 's' : '') + ' did not match a SKU</b> and will be left out. They are red in the table below. Fix the sheet and paste again, or leave them if they are subtotals or notes.</div>');
    if (missing.length) w.push('<div class="msg warn"><b>' + missing.length + ' SKU' + (missing.length > 1 ? 's are' : ' is') + ' on the book but not on your sheet.</b> A recount is a full count, so ' + (missing.length > 1 ? 'they' : 'it') + ' will be written down to zero. They are amber below. If you only counted part of the warehouse, stop and count the rest.</div>');
    if (S.mode === 'open' && S.lines.some(l => l.onSheet && l.book !== 0)) w.push('<div class="msg warn">Some of these SKUs already have stock on the book here. An opening balance adds to it.</div>');
    $('#warnings').innerHTML = w.join('');

    const head = S.mode === 'count'
      ? '<tr><th>SKU</th><th>Product</th><th class="num">Cases</th><th class="num">Loose</th><th class="num">Counted</th><th class="num">Book</th><th class="num">Variance</th><th class="num">Value at cost</th></tr>'
      : '<tr><th>SKU</th><th>Product</th><th class="num">Cases</th><th class="num">Loose</th><th class="num">Units in</th><th class="num">Value at cost</th><th>From the sheet</th></tr>';
    $('#lines-head').innerHTML = head;

    const show = S.mode === 'count' ? S.lines : S.lines.filter(l => l.onSheet);
    const body = show.map(l => {
      const cls = (!l.onSheet && l.book !== 0) ? ' class="zero"' : '';
      if (S.mode === 'count') return '<tr' + cls + '><td>' + l.sku_id + '</td><td>' + l.name + '</td>' +
        '<td class="num">' + (l.onSheet ? num(l.cases) : '—') + '</td><td class="num">' + (l.onSheet ? num(l.eaches) : '—') + '</td>' +
        '<td class="num">' + num(l.counted) + '</td><td class="num">' + num(l.book) + '</td>' +
        '<td class="num ' + (l.diff < 0 ? 'neg' : l.diff > 0 ? 'pos' : '') + '">' + (l.diff ? signed(l.diff) : '—') + '</td>' +
        '<td class="num">' + money2(valueOf(l)) + '</td></tr>';
      return '<tr><td>' + l.sku_id + '</td><td>' + l.name + '</td><td class="num">' + num(l.cases) + '</td><td class="num">' + num(l.eaches) + '</td>' +
        '<td class="num">' + num(l.counted) + '</td><td class="num">' + money2(valueOf(l)) + '</td><td class="raw">' + l.rows + ' row' + (l.rows > 1 ? 's' : '') + '</td></tr>';
    }).join('') + S.bad.map(b => '<tr class="bad"><td colspan="' + (S.mode === 'count' ? 7 : 6) + '">Row ' + b.n + ' did not match a SKU</td><td class="raw">' + esc(b.raw) + '</td></tr>').join('');
    $('#t-lines tbody').innerHTML = body || '<tr><td colspan="8" style="color:var(--ink-3)">Nothing matched yet.</td></tr>';

    $('#t-lines tfoot').innerHTML = S.mode === 'count'
      ? '<tr><td colspan="4">Total</td><td class="num">' + num(totUnits) + '</td><td class="num">' + num(S.lines.reduce((a, l) => a + l.book, 0)) + '</td><td class="num ' + (totDiff < 0 ? 'neg' : totDiff > 0 ? 'pos' : '') + '">' + (totDiff ? signed(totDiff) : '—') + '</td><td class="num">' + money2(totValue) + '</td></tr>'
      : '<tr><td colspan="4">Total</td><td class="num">' + num(totUnits) + '</td><td class="num">' + money2(totValue) + '</td><td></td></tr>';

    const ready = !!S.loc && onSheet.length > 0 && !S.posted;
    $('#post').disabled = !ready;
    $('#post-state').textContent = !S.loc ? 'Choose a warehouse first.'
      : S.posted ? 'Already posted. Reload the page to do another.'
      : !onSheet.length ? 'Nothing matched a SKU yet.'
      : S.mode === 'open'
        ? 'Will write ' + onSheet.length + ' transfer in rows into ' + locName() + '.'
        : 'Will post a full count of ' + locName() + ' and write ' + S.lines.filter(l => l.diff !== 0).length + ' variance rows.';
  }
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const locName = () => (S.locs.find(l => l.location_id === S.loc) || {}).name || S.loc;

  // ---------- posting ----------
  async function doPost() {
    const onSheet = S.lines.filter(l => l.onSheet);
    const note = $('#note').value.trim();
    const what = S.mode === 'open'
      ? 'Write ' + num(onSheet.reduce((a, l) => a + l.counted, 0)) + ' units into ' + locName() + ' as a transfer in from Dunlap / STEM?'
      : 'Post a full count of ' + locName() + '? This resets the book to what you counted and writes ' + S.lines.filter(l => l.diff !== 0).length + ' variance rows.';
    if (!confirm(what + '\n\nThis cannot be undone from this page.')) return;

    $('#post').disabled = true;
    $('#post-state').textContent = 'writing…';
    const m = $('#post-msg');
    try {
      if (S.mode === 'open') {
        const batch = uuid();
        const rows = onSheet.filter(l => l.counted > 0).map(l => ({
          type: 'TRANSFER_IN', from_loc: 'PLANT', to_loc: S.loc, sku_id: l.sku_id, units: l.counted,
          cases_in: l.cases || null, eaches_in: l.eaches || null,
          user_email: email(), source: 'manual', batch_id: batch,
          ref: 'upload ' + new Date().toISOString().slice(0, 10),
          note: note || 'opening balance uploaded from a sheet'
        }));
        if (!rows.length) throw new Error('every line came to zero units');
        await post('movements', rows);
        m.className = 'msg ok';
        m.textContent = rows.length + ' transfer in rows written into ' + locName() + ', ' + num(rows.reduce((a, r) => a + r.units, 0)) + ' units. Open the report to see it.';
      } else {
        const count_id = uuid();
        await post('counts', { count_id, location_id: S.loc, user_email: email(), note: note || 'uploaded from a sheet' });
        await post('count_lines', S.lines.map(l => ({ count_id, sku_id: l.sku_id, backstock_units: l.counted, display_units: 0 })));
        const n = await call('rpc/post_count', { method: 'POST', body: { p_count_id: count_id } });
        m.className = 'msg ok';
        m.textContent = 'Count posted for ' + locName() + '. ' + (n === null ? '' : n + ' variance rows written. ') + 'The book now reads what you counted.';
      }
      S.posted = true;
      $('#post-state').textContent = 'done';
    } catch (e) {
      m.className = 'msg err';
      m.textContent = 'Nothing was written. ' + e.message;
      $('#post-state').textContent = '';
      $('#post').disabled = false;
    }
  }

  // ---------- template ----------
  function template() {
    const head = 'sku_id,product,units_per_case,cases,loose_units\n';
    const body = S.skus.map(s => [s.sku_id, '"' + s.name + '"', s.units_per_case, '', ''].join(',')).join('\n');
    const blob = new Blob([head + body + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'warehouse-count-template.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- sign in ----------
  async function signIn() {
    const e = $('#login-email').value.trim(), p = $('#login-password').value;
    const box = $('#login-msg');
    if (!e || !p) { box.className = 'msg err'; box.textContent = 'Email and password, please.'; return; }
    $('#login-signin').disabled = true; box.className = ''; box.textContent = '';
    try {
      const r = await fetch(URL0 + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) });
      if (!r.ok) throw new Error(r.status === 400 ? 'That email and password did not match.' : 'Sign in failed (' + r.status + ').');
      setSession(await r.json());
      LS.set('login_email', e);
      await start();
    } catch (err) {
      box.className = 'msg err'; box.textContent = err.message;
      $('#login-signin').disabled = false;
    }
  }

  async function start() {
    $('#login').style.display = 'none';
    $('#app').style.display = '';
    try { await load(); }
    catch (e) {
      const d = $('#denied'); d.classList.remove('hide'); d.textContent = 'Could not load: ' + e.message;
      if (/session|not signed in/i.test(e.message)) { LS.del('session'); S.session = null; $('#app').style.display = 'none'; $('#login').style.display = ''; }
    }
  }

  // ---------- wiring ----------
  $('#login-signin').onclick = signIn;
  $('#login-password').onkeydown = e => { if (e.key === 'Enter') signIn(); };
  $('#login-email').value = LS.get('login_email', '') || '';
  $('#signout').onclick = () => { LS.del('session'); location.reload(); };
  $$('.mode').forEach(b => b.onclick = () => { setMode(b.dataset.mode); review(); });
  $('#paste').oninput = review;
  $('#clear').onclick = () => { $('#paste').value = ''; review(); };
  $('#pick-file').onclick = () => $('#file').click();
  $('#file').onchange = () => {
    const f = $('#file').files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('#paste').value = r.result; review(); };
    r.readAsText(f);
  };
  $('#template').onclick = template;
  $('#post').onclick = doPost;
  setMode('open');

  if (S.session) start();
})();

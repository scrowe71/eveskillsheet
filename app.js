import { SCOPES, buildSnapshot } from './shared/snapshot.js';
import { renderSheet, tickCountdowns, until, starBtn, missingList } from './shared/render.js';
import { effectiveSkills, shipStatus, shipRace, RACES, formatDuration, parsePlan, planGap, planText, queueSummary, formatSp, formatNum, timeAgo, roman, esc } from './shared/lib.js';

// ---------------------------------------------------------------- config
export const APP_VERSION = '1.2.0';   // bump on every release
const CFG = window.SKILLSHEET_CONFIG || {};
const SSO = 'https://login.eveonline.com/v2/oauth';
const ESI = 'https://esi.evetech.net';
const IMG = 'https://images.evetech.net';
const STALE_MS = 15 * 60 * 1000;        // auto-refresh characters older than this on load
const REPUBLISH_MS = 60 * 60 * 1000;    // keep shared sheets at most an hour behind
const redirectUri = () => CFG.redirectUri || `${location.origin}/`;
const configured = () => CFG.clientId && !/PASTE/i.test(CFG.clientId);

// ---------------------------------------------------------------- storage
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage full?', k, e); } },
};

const state = {
  chars: ls.get('ss.chars', {}),      // id -> { id, name, access, refresh, exp, scopes, needsLogin, sheet }
  main: ls.get('ss.main', null),
  snaps: ls.get('ss.snaps', {}),      // id -> snapshot
  errors: {},
  selected: ls.get('ss.selected', 'ships'),
  watch: new Set(ls.get('ss.watch', [])),   // ship type ids on the watchlist
  mx: { q: '', filter: null, race: 'all', cls: 'all', open: null },   // ship matrix view
  plans: ls.get('ss.plans', []),       // [{ id, name, entries: [[skillId, level]], updated }]
  pv: { sel: null, char: null, edit: null, showDone: false },          // skill plan view
  busy: null,
  data: null,                          // { SK, SH }
};
const saveChars = () => ls.set('ss.chars', state.chars);
const saveSnaps = () => ls.set('ss.snaps', state.snaps);
const sharingOn = () => CFG.sharing === true;
const savePlans = () => ls.set('ss.plans', state.plans);

function toggleWatch(id) {
  if (state.watch.has(id)) state.watch.delete(id); else state.watch.add(id);
  ls.set('ss.watch', [...state.watch]);
  renderAside();
}

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeJwt(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(part + '='.repeat((4 - part.length % 4) % 4)))));
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4000);
}

function setBusy(text) {
  state.busy = text;
  const el = $('#status');
  el.textContent = text || '';
  el.classList.toggle('working', !!text);
  $('#refreshBtn').disabled = !!text;
}

const charList = () => Object.values(state.chars).sort((a, b) =>
  (b.id === state.main) - (a.id === state.main) || (state.snaps[b.id]?.totalSp || 0) - (state.snaps[a.id]?.totalSp || 0));

// ---------------------------------------------------------------- SSO (PKCE, no client secret)
async function login() {
  if (!configured()) { toast('Add your EVE application Client ID to config.js first.', 'error'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('ss.pkce', JSON.stringify({ verifier, state: st }));
  const p = new URLSearchParams({
    response_type: 'code', redirect_uri: redirectUri(), client_id: CFG.clientId,
    scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: st,
  });
  location.href = `${SSO}/authorize?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${SSO}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: CFG.clientId }),
  });
  if (!r.ok) {
    const err = new Error(`EVE login failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function storeToken(tok, existing = {}) {
  const jwt = decodeJwt(tok.access_token);
  const id = Number(String(jwt.sub).split(':').pop());
  const c = state.chars[id] = { ...existing, ...state.chars[id], id, name: jwt.name };
  Object.assign(c, {
    access: tok.access_token,
    refresh: tok.refresh_token || c.refresh,
    exp: jwt.exp * 1000,
    scopes: [].concat(jwt.scp || []),
    needsLogin: false,
  });
  if (!state.main) { state.main = id; ls.set('ss.main', id); }   // first character added becomes the main
  saveChars();
  return id;
}

async function handleCallback(params) {
  const saved = JSON.parse(sessionStorage.getItem('ss.pkce') || 'null');
  sessionStorage.removeItem('ss.pkce');
  history.replaceState(null, '', location.pathname);
  if (params.get('error')) throw new Error(`EVE login: ${params.get('error_description') || params.get('error')}`);
  if (!saved || saved.state !== params.get('state')) throw new Error('Login check failed (state mismatch). Please add the character again.');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), code_verifier: saved.verifier });
  return storeToken(tok);
}

const refreshing = {};
async function getToken(id) {
  const c = state.chars[id];
  if (!c) throw new Error('Unknown character');
  if (c.access && c.exp - 60_000 > Date.now()) return c.access;
  return (refreshing[id] ??= (async () => {
    try {
      const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh });
      storeToken(tok, c);
      return state.chars[id].access;
    } catch (e) {
      if (e.status === 400 || e.status === 401) { c.needsLogin = true; saveChars(); }
      throw e;
    } finally {
      delete refreshing[id];
    }
  })());
}

// ---------------------------------------------------------------- ESI
async function esi(path, { charId, method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = { Accept: 'application/json', 'X-Compatibility-Date': CFG.compatibilityDate || '2025-09-30' };
    if (charId) headers.Authorization = `Bearer ${await getToken(charId)}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(ESI + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.ok) return r.json();
    const wait = Number(r.headers.get('Retry-After') || r.headers.get('X-ESI-Error-Limit-Reset')) || 2 ** attempt;
    if (r.status === 420 || r.status === 429 || r.status >= 500) { await sleep(Math.min(wait, 60) * 1000); continue; }
    if (r.status === 401 && charId && attempt === 0) { state.chars[charId].exp = 0; continue; }
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch { /* not JSON */ }
    const err = new Error(`ESI ${r.status} on ${path}${detail ? `: ${detail}` : ''}`);
    err.status = r.status;
    throw err;
  }
  throw new Error(`ESI kept failing on ${path}; try again in a few minutes.`);
}

const esiFor = id => (path, { auth, method, body } = {}) => esi(path, { charId: auth ? id : undefined, method, body });

// ---------------------------------------------------------------- refresh
async function refreshChar(id) {
  try {
    state.snaps[id] = await buildSnapshot(esiFor(id), id);
    state.chars[id].name = state.snaps[id].char.name;
    delete state.errors[id];
    saveSnaps(); saveChars();
    const sh = state.chars[id].sheet;
    if (sh && Date.now() - (sh.ts || 0) > REPUBLISH_MS) {
      publish(id, sh.include, { quiet: true }).catch(e => console.warn('auto-update of shared sheet failed', e));
    }
  } catch (e) {
    state.errors[id] = e.message;
    console.error(e);
  }
}

async function refreshAll(ids = Object.keys(state.chars).map(Number)) {
  const list = ids.filter(id => !state.chars[id]?.needsLogin);
  if (!list.length) return;
  let done = 0;
  setBusy(`Updating ${list.length} character${list.length > 1 ? 's' : ''}…`);
  await pool(list, 3, async id => {
    await refreshChar(id);
    setBusy(`Updating characters… ${++done}/${list.length}`);
    render();
  });
  setBusy(null);
  const failed = list.filter(id => state.errors[id]);
  if (failed.length) toast(`Couldn't update ${failed.map(id => state.chars[id].name).join(', ')}: ${state.errors[failed[0]]}`, 'error');
  render();
}

// ---------------------------------------------------------------- sharing (Pages Function + D1)
async function api(path, { id, method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${await getToken(id)}` };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    const err = new Error(data?.error || `Share server error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function publish(id, include, { quiet = false } = {}) {
  const res = await api('/api/sheets', { id, method: 'POST', body: { include } });
  state.chars[id].sheet = { slug: res.slug, include, ts: Date.now() };
  saveChars();
  if (!quiet) toast('Sheet published. Anyone with the link can view it.');
  return res;
}

async function unpublish(id) {
  const sh = state.chars[id].sheet;
  if (!sh) return;
  await api(`/api/sheets/${encodeURIComponent(sh.slug)}`, { id, method: 'DELETE' });
  delete state.chars[id].sheet;
  saveChars();
  toast('Sheet removed. The link no longer works.');
}

async function syncShareStatus(id) {
  try {
    const res = await api('/api/sheets', { id });
    state.chars[id].sheet = res.slug ? { slug: res.slug, include: res.include, ts: res.updatedAt } : undefined;
  } catch (e) {
    if (e.status === 404) delete state.chars[id].sheet;
    else throw e;
  }
  saveChars();
}

const shareUrl = slug => `${location.origin}/s/${slug}`;

function openShare(id) {
  const c = state.chars[id];
  const dlg = $('#shareDlg');
  const draw = () => {
    const sh = c.sheet;
    const inc = sh?.include || { queue: true, attributes: true, clones: false };
    dlg.innerHTML = `
      <form method="dialog" class="dlg">
        <h2>Share ${esc(c.name)}'s skill sheet</h2>
        <p class="dim">Creates a read-only page with a private link. The data is pulled straight from ESI by the server, so viewers can trust it wasn't edited. Skills and ships are always included.</p>
        <label class="check"><input type="checkbox" name="queue" ${inc.queue ? 'checked' : ''}> Skill queue</label>
        <label class="check"><input type="checkbox" name="attributes" ${inc.attributes ? 'checked' : ''}> Attributes &amp; remaps</label>
        <label class="check"><input type="checkbox" name="clones" ${inc.clones ? 'checked' : ''}> Clones &amp; implants <small class="warn">shows jump clone locations</small></label>
        ${sh ? `
          <div class="linkbox"><input readonly value="${esc(shareUrl(sh.slug))}" id="shareLink"><button type="button" id="copyLink">Copy</button><a class="btn" href="${esc(shareUrl(sh.slug))}" target="_blank" rel="noopener">Open ↗</a></div>
          <p class="hint">Last updated ${timeAgo(sh.ts)}. It updates on its own when you refresh here (at most hourly).</p>` : ''}
        <div class="dlg-actions">
          ${sh ? '<button type="button" id="unpubBtn" class="danger">Stop sharing</button>' : ''}
          <span style="flex:1"></span>
          <button value="cancel">Close</button>
          <button type="button" id="pubBtn" class="primary">${sh ? 'Update sheet' : 'Publish sheet'}</button>
        </div>
      </form>`;
    const form = dlg.querySelector('form');
    const inc2 = () => ({ queue: form.queue.checked, attributes: form.attributes.checked, clones: form.clones.checked });
    dlg.querySelector('#pubBtn').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Publishing…';
      try { await publish(id, inc2()); draw(); render(); }
      catch (err) { toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'Try again'; }
    };
    dlg.querySelector('#unpubBtn')?.addEventListener('click', async e => {
      e.target.disabled = true;
      try { await unpublish(id); draw(); render(); }
      catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
    });
    dlg.querySelector('#copyLink')?.addEventListener('click', async e => {
      try { await navigator.clipboard.writeText(shareUrl(c.sheet.slug)); e.target.textContent = 'Copied'; }
      catch { dlg.querySelector('#shareLink').select(); }
    });
  };
  draw();
  dlg.showModal();
  syncShareStatus(id).then(draw).catch(() => { /* share server not set up yet: the publish button will explain */ });
}

// ---------------------------------------------------------------- rendering
function trainingLine(snap) {
  const qs = queueSummary(snap?.queue);
  if (!snap) return '<small class="dim">Not loaded yet</small>';
  if (!qs) return '<small class="dim">Queue hidden</small>';
  if (qs.empty) return '<small class="warn">Queue empty</small>';
  const n = state.data?.SK[qs.current.id]?.n || 'Skill';
  if (qs.paused) return `<small class="warn">Paused · ${esc(n)} ${roman(qs.current.lvl)}</small>`;
  return `<small>${esc(n)} ${roman(qs.current.lvl)} · ${until(qs.current.finish)}</small>`;
}

function renderAside() {
  const list = charList();
  const totalSp = list.reduce((n, c) => n + (state.snaps[c.id]?.totalSp || 0), 0);
  $('#chars').innerHTML = `
    <button class="char all ${state.selected === 'ships' ? 'sel' : ''}" data-sel="ships">
      <span class="allicon">⛭</span>
      <span class="info"><span class="top"><b>Ships</b></span>
      <small class="dim">Who can fly what · ${state.watch.size} on watchlist</small></span>
    </button>
    <button class="char all ${state.selected === 'plans' ? 'sel' : ''}" data-sel="plans">
      <span class="allicon">☰</span>
      <span class="info"><span class="top"><b>Skill plans</b></span>
      <small class="dim">${state.plans.length} saved plan${state.plans.length === 1 ? '' : 's'}</small></span>
    </button>
    <button class="char all ${state.selected === 'all' ? 'sel' : ''}" data-sel="all">
      <span class="allicon">∑</span>
      <span class="info"><span class="top"><b>All characters</b><span class="sp">${formatSp(totalSp)}</span></span>
      <small class="dim">${list.length} character${list.length === 1 ? '' : 's'}</small></span>
    </button>
    ${list.map(c => {
      const s = state.snaps[c.id];
      return `
      <div class="char ${state.selected === c.id ? 'sel' : ''}" data-sel="${c.id}">
        <img src="${IMG}/characters/${c.id}/portrait?size=64" alt="" width="34" height="34">
        <span class="info">
          <span class="top"><b>${esc(c.name)}</b>${c.id === state.main ? '<span class="glyph main" title="Main character">★</span>' : ''}${c.sheet && sharingOn() ? '<span class="glyph shared" title="Has a shared sheet">⇗</span>' : ''}<span class="sp">${s ? formatSp(s.totalSp) : ''}</span></span>
          ${c.needsLogin ? `<small class="warn">Login expired · <a href="#" data-relogin="${c.id}">log in again</a></small>`
            : state.errors[c.id] ? `<small class="warn" title="${esc(state.errors[c.id])}">Update failed</small>` : trainingLine(s)}
        </span>
        <button class="icon" data-remove="${c.id}" title="Remove from this browser">×</button>
      </div>`;
    }).join('')}`;
}

function renderMain() {
  const main = $('#main');
  if (!Object.keys(state.chars).length) {
    main.innerHTML = `
      <div class="empty big">
        <h2>Track all your characters' skills in one place</h2>
        <p>Log in with your main first, then add each alt. EVE asks every character to approve access once.<br>After that they all stay here in this browser.</p>
        <button class="primary big" id="firstLogin">Log in with EVE Online</button>
      </div>`;
    return;
  }
  if (state.selected === 'ships') { renderMatrix(main); return; }
  if (state.selected === 'plans') {
    if (state.pv.edit && $('#planText')) return;   // don't wipe a plan being typed when a refresh finishes
    renderPlans(main); return;
  }
  if (state.selected === 'all' || !state.chars[state.selected]) { main.replaceChildren(overview()); return; }

  const id = state.selected;
  const snap = state.snaps[id];
  if (!snap) {
    main.innerHTML = `<div class="empty big">${state.errors[id] ? `<span class="warn">${esc(state.errors[id])}</span>` : 'Loading from ESI…'}</div>`;
    return;
  }
  let host = main.querySelector('.sheet');
  if (!host || host.dataset.char !== String(id)) {
    main.innerHTML = '';
    host = document.createElement('div');
    host.className = 'sheet';
    host.dataset.char = id;
    main.append(host);
  }
  const c = state.chars[id];
  renderSheet(host, snap, state.data, {
    defaultTab: 'ships',
    watch: state.watch,
    onToggleWatch: toggleWatch,
    actions: `
      ${id !== state.main ? `<button data-main="${id}">Make main</button>` : ''}
      ${sharingOn() ? `<button class="primary" data-share="${id}">${c.sheet ? 'Shared ✓' : 'Share sheet'}</button>` : ''}`,
  });
}

function overview() {
  const list = charList();
  const now = Date.now();
  const rows = list.map(c => {
    const s = state.snaps[c.id];
    const qs = queueSummary(s?.queue, now);
    return { c, s, qs };
  });
  const totalSp = rows.reduce((n, r) => n + (r.s?.totalSp || 0), 0);
  const unalloc = rows.reduce((n, r) => n + (r.s?.unallocSp || 0), 0);
  const training = rows.filter(r => r.qs && !r.qs.empty && !r.qs.paused).length;
  const soon = rows.filter(r => r.qs && (r.qs.empty || (r.qs.ends && r.qs.ends - now < 24 * 3600e3))).length;

  const el = document.createElement('div');
  el.innerHTML = `
    <section class="stats">
      <div class="stat"><span>Total skillpoints</span><b>${formatSp(totalSp)}</b><small>${formatNum(totalSp)} SP</small></div>
      <div class="stat"><span>Unallocated</span><b>${formatSp(unalloc)}</b><small>across all characters</small></div>
      <div class="stat"><span>Training</span><b>${training}<span class="dim"> / ${list.length}</span></b><small>characters with an active queue</small></div>
      <div class="stat"><span>Need attention</span><b class="${soon ? 'warn' : ''}">${soon}</b><small>queue empty or ends within 24h</small></div>
    </section>
    <table class="overview">
      <thead><tr><th>Character</th><th class="num">Skillpoints</th><th class="num">Unallocated</th><th class="num">Can fly</th><th>Training now</th><th class="num">Level done in</th><th class="num">Queue ends in</th><th class="num">Synced</th></tr></thead>
      <tbody>
        ${rows.map(({ c, s, qs }) => {
          const cur = qs && !qs.empty ? qs.current : null;
          const warn = qs && (qs.empty || qs.paused || (qs.ends && qs.ends - now < 24 * 3600e3));
          return `<tr class="click" data-sel="${c.id}">
            <td><div class="item"><img src="${IMG}/characters/${c.id}/portrait?size=64" alt="" width="32" height="32">
              <div><b>${esc(c.name)}</b>${c.id === state.main ? ' <em class="main">MAIN</em>' : ''}${c.sheet && sharingOn() ? ' <em class="shared">SHARED</em>' : ''}<small class="dim">${esc(s?.char.corpName || '')}</small></div></div></td>
            <td class="num">${s ? formatNum(s.totalSp) : '—'}</td>
            <td class="num ${s?.unallocSp ? 'accent' : 'dim'}">${s ? formatNum(s.unallocSp) : '—'}</td>
            <td class="num">${s ? `<b class="good">${flyCount(c.id)}</b> <span class="dim">hulls</span>` : '—'}</td>
            <td>${cur ? `${esc(state.data.SK[cur.id]?.n || 'Skill')} <b class="lvl">${roman(cur.lvl)}</b>` : `<span class="${qs ? 'warn' : 'dim'}">${!s ? '—' : !qs ? 'Hidden' : 'Queue empty'}</span>`}</td>
            <td class="num">${cur && !qs.paused ? until(cur.finish) : ''}</td>
            <td class="num ${warn ? 'warn' : ''}">${qs?.paused ? 'Paused' : qs?.ends ? until(qs.ends) : ''}</td>
            <td class="num dim">${c.needsLogin ? '<span class="warn">Login expired</span>' : s ? timeAgo(s.syncedAt) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="hint">Click a character to open their full sheet. Characters, logins and cached data are stored only in this browser. ${sharingOn() ? ' Only sheets you choose to share are sent to the server.' : ''}</p>`;
  return el;
}


// ---------------------------------------------------------------- ship matrix (all characters)
const MX_FILTERS = [['watch', '★ Watchlist'], ['any', 'Someone can fly'], ['close', 'Someone within 7 days'], ['all', 'All hulls'], ['none', 'Nobody can fly']];
let pilotCache = { key: '', list: [] };

function pilots() {
  const list = charList().filter(c => state.snaps[c.id]);
  const key = list.map(c => `${c.id}:${state.snaps[c.id].syncedAt}`).join('|');
  if (pilotCache.key !== key) {
    pilotCache = { key, list: list.map(c => ({ c, skills: effectiveSkills(state.snaps[c.id]), attrs: state.snaps[c.id].attrs, status: {} })) };
  }
  return pilotCache.list;
}

function statusFor(p, shipId) {
  return p.status[shipId] ??= shipStatus(state.data.SH[shipId], p.skills, state.data.SK, p.attrs);
}

function flyCount(charId) {
  const p = pilots().find(x => x.c.id === charId);
  if (!p) return 0;
  return Object.keys(state.data.SH).filter(id => statusFor(p, id).ok).length;
}

function renderMatrix(main) {
  const { SK, SH } = state.data;
  const mx = state.mx;
  mx.filter ??= state.watch.size ? 'watch' : 'any';
  const ps = pilots();
  const terms = mx.q.toLowerCase().split(/\s+/).filter(Boolean);
  const classes = [...new Set(Object.values(SH).map(s => s.g))].sort();

  const groups = new Map();
  for (const [id, ship] of Object.entries(SH)) {
    const race = shipRace(ship, SK);
    if (mx.race !== 'all' && race !== mx.race) continue;
    if (mx.cls !== 'all' && ship.g !== mx.cls) continue;
    if (!terms.every(t => ship.n.toLowerCase().includes(t) || ship.g.toLowerCase().includes(t))) continue;
    const st = ps.map(p => statusFor(p, id));
    const n = st.filter(x => x.ok).length;
    const best = Math.min(...st.filter(x => !x.ok && x.minutes != null).map(x => x.minutes), Infinity);
    const keep = mx.filter === 'watch' ? state.watch.has(Number(id))
      : mx.filter === 'any' ? n > 0
      : mx.filter === 'close' ? n > 0 || best <= 7 * 1440
      : mx.filter === 'none' ? n === 0 : true;
    if (!keep) continue;
    let g = groups.get(ship.g);
    if (!g) groups.set(ship.g, g = { name: ship.g, rows: [] });
    g.rows.push({ id: Number(id), ship, race, st, n, best });
  }
  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of list) g.rows.sort((a, b) => b.n - a.n || a.best - b.best || a.ship.n.localeCompare(b.ship.n));
  const shown = list.reduce((n, g) => n + g.rows.length, 0);

  const cell = (r, i) => {
    const s = r.st[i];
    const open = mx.open === `${r.id}:${ps[i].c.id}`;
    if (s.ok) return '<td class="mx ok" title="Can fly">✓</td>';
    const t = s.minutes != null ? formatDuration(s.minutes * 60000) : `${formatSp(s.sp)} SP`;
    const cls = s.minutes != null && s.minutes <= 7 * 1440 ? 'soon' : s.minutes != null && s.minutes <= 30 * 1440 ? 'mid' : 'far';
    return `<td class="mx ${cls} ${open ? 'open' : ''}" data-mx="${r.id}:${ps[i].c.id}" title="${esc(ps[i].c.name)}: ${s.missing.length} skill(s) missing. Click for details">${t}</td>`;
  };

  main.innerHTML = ps.length ? `
    <section class="pilot-chips">
      ${ps.map(p => `<button class="pchip" data-sel="${p.c.id}" title="Open ${esc(p.c.name)}"><img src="${IMG}/characters/${p.c.id}/portrait?size=64" alt="" width="28" height="28"><span><b>${esc(p.c.name)}</b>${p.c.id === state.main ? ' <span class="glyph main">★</span>' : ''}<small><b class="good">${flyCount(p.c.id)}</b> hulls</small></span></button>`).join('')}
    </section>
    <section class="filters">
      <input id="mxSearch" type="search" placeholder="Search ships or classes…" value="${esc(mx.q)}" autocomplete="off">
      <select id="mxFilter">${MX_FILTERS.map(([v, l]) => `<option value="${v}" ${mx.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="mxRace"><option value="all">All races</option>${RACES.map(r => `<option ${mx.race === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <select id="mxClass"><option value="all">All classes</option>${classes.map(c => `<option ${mx.cls === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <span class="dim">${shown} hull${shown === 1 ? '' : 's'}</span>
    </section>
    ${shown ? `
    <div class="mx-wrap"><table class="matrix">
      <thead><tr><th class="mx-ship">Ship</th>${ps.map(p => `<th class="mx-pilot" title="${esc(p.c.name)}"><img src="${IMG}/characters/${p.c.id}/portrait?size=64" alt="" width="26" height="26"><span>${esc(p.c.name)}</span></th>`).join('')}</tr></thead>
      ${list.map(g => `
        <tbody>
          <tr class="mx-group"><td colspan="${ps.length + 1}">${esc(g.name)} <span class="dim">· ${g.rows.length}</span></td></tr>
          ${g.rows.map(r => {
            const openPilot = ps.findIndex(p => mx.open === `${r.id}:${p.c.id}`);
            return `<tr>
              <td class="mx-ship"><div class="item">${starBtn(r.id, state.watch.has(r.id))}<img src="${IMG}/types/${r.id}/icon?size=32" alt="" width="26" height="26" loading="lazy"><div>${esc(r.ship.n)}<small class="dim">${esc(r.race)}</small></div></div></td>
              ${ps.map((_, i) => cell(r, i)).join('')}
            </tr>
            ${openPilot >= 0 ? `<tr class="mx-detail"><td colspan="${ps.length + 1}"><b>${esc(ps[openPilot].c.name)}</b> needs for the ${esc(r.ship.n)}:${missingList(r.st[openPilot].missing)}</td></tr>` : ''}`;
          }).join('')}
        </tbody>`).join('')}
    </table></div>` : `<div class="empty big">${mx.filter === 'watch' ? 'Your watchlist is empty. Switch the filter to <b>Someone can fly</b> or <b>All hulls</b> and click ☆ next to the ships you care about.' : 'No ships match these filters.'}</div>`}
    <p class="hint">✓ = can fly now. Otherwise the cell shows training time with that character's current attributes and implants (green ≤ 7 days, amber ≤ 30 days). Click a time to see the missing skills.</p>`
    : '<div class="empty big">Add a character to see which ships they can fly.</div>';
}

// ---------------------------------------------------------------- skill plans
const skName = id => state.data.SK[id]?.n || `Skill ${id}`;

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileSafe = s => s.replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '_') || 'plan';

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 1500); } }
  catch { toast("Couldn't reach the clipboard. Use Download instead.", 'error'); }
}

function gapFor(plan, charId) {
  const snap = state.snaps[charId];
  if (!snap) return null;
  return planGap(plan.entries, effectiveSkills(snap), state.data.SK, snap.attrs);
}

function planEditor(plan) {
  const text = plan ? planText(plan.entries.map(([id, l]) => [id, l, skName(id)])) : '';
  return `
    <section class="panel plan-edit">
      <h3>${plan ? 'Edit plan' : 'New skill plan'}</h3>
      <label class="field">Name<input id="planName" value="${esc(plan?.name || '')}" placeholder="e.g. Ishtar ratting" maxlength="80"></label>
      <label class="field">Skills, one per line<textarea id="planText" rows="12" spellcheck="false" placeholder="Gallente Cruiser V&#10;Drones 5&#10;Heavy Assault Cruisers IV&#10;&#10;Paste from EVE, EVEMon or any skill list. Levels can be 1-5 or I-V.">${esc(text)}</textarea></label>
      <div class="dim" id="planParse"></div>
      <div class="row-actions">
        <label class="btn file">Load EVEMon file (.emp / .xml)<input type="file" id="planFile" accept=".emp,.xml,.txt" hidden></label>
        <span style="flex:1"></span>
        <button id="planCancel">Cancel</button>
        <button id="planSave" class="primary">Save plan</button>
      </div>
    </section>`;
}

function updateParseHint() {
  const el = $('#planParse');
  if (!el) return;
  const { entries, errors } = parsePlan($('#planText').value, state.data.SK);
  el.innerHTML = `<b class="good">${entries.length}</b> skill level${entries.length === 1 ? '' : 's'} recognised` +
    (errors.length ? ` · <span class="warn">${errors.length} line${errors.length === 1 ? '' : 's'} not recognised: ${esc(errors.slice(0, 4).join(', '))}${errors.length > 4 ? '…' : ''}</span>` : '');
}

function renderPlans(main) {
  const pv = state.pv;
  const plans = state.plans;
  if (pv.sel && !plans.find(p => p.id === pv.sel)) pv.sel = null;
  pv.sel ??= plans[0]?.id || null;
  const plan = plans.find(p => p.id === pv.sel);
  const chars = charList().filter(c => state.snaps[c.id]);
  if (!pv.char || !state.snaps[pv.char]) pv.char = chars[0]?.id || null;

  let body = '';
  if (pv.edit) {
    body = planEditor(pv.edit === 'new' ? null : plan);
  } else if (!plan) {
    body = `<div class="empty big"><h2>No skill plans yet</h2><p>Paste a list of skills (from EVE, EVEMon or a fitting guide) and compare it against any of your characters.</p><button class="primary big" id="planNew2">Create a plan</button></div>`;
  } else {
    const gaps = chars.map(c => ({ c, g: gapFor(plan, c.id) }));
    const cur = gaps.find(x => x.c.id === pv.char);
    const g = cur?.g;
    const missing = g ? g.steps : [];
    const doneRows = g && pv.showDone ? plan.entries.filter(([id, lvl]) => Math.max(0, effectiveSkills(state.snaps[pv.char])[id]?.t ?? 0) >= lvl) : [];
    let cum = 0;
    body = `
      <section class="plan-head">
        <div><h2>${esc(plan.name)}</h2><span class="dim">${plan.entries.length} skill levels in plan · updated ${timeAgo(plan.updated)}</span></div>
        <div class="actions">
          <button id="planCopyAll">Copy plan</button>
          <button id="planEdit">Edit</button>
          <button id="planDelete" class="danger">Delete</button>
        </div>
      </section>
      ${chars.length ? `
      <section class="pilot-chips">
        ${gaps.map(({ c, g }) => {
          const pct = g.total ? Math.round(g.done / g.total * 100) : 100;
          return `<button class="pchip ${c.id === pv.char ? 'sel' : ''}" data-plan-char="${c.id}">
            <img src="${IMG}/characters/${c.id}/portrait?size=64" alt="" width="28" height="28">
            <span><b>${esc(c.name)}</b><small>${g.steps.length ? `${pct}% · ${g.minutes != null ? formatDuration(g.minutes * 60000) : formatSp(g.sp) + ' SP'} to go` : '<span class="good">✓ Plan complete</span>'}</small></span>
          </button>`;
        }).join('')}
      </section>
      <section class="stats">
        <div class="stat"><span>Plan items done</span><b>${g.done}<span class="dim"> / ${g.total}</span></b><small>${esc(cur.c.name)}</small></div>
        <div class="stat"><span>Levels to train</span><b>${missing.length}</b><small>${missing.filter(m => m.prereq).length} are prerequisites not in the plan</small></div>
        <div class="stat"><span>Skillpoints needed</span><b>${formatSp(g.sp)}</b><small>${formatNum(Math.round(g.sp))} SP</small></div>
        <div class="stat"><span>Training time</span><b>${g.minutes != null ? formatDuration(g.minutes * 60000) : '—'}</b><small>at current attributes</small></div>
      </section>
      <div class="toolbar">
        <button class="primary" id="gapCopy" ${missing.length ? '' : 'disabled'}>Copy missing skills</button>
        <button id="gapTxt" ${missing.length ? '' : 'disabled'}>Download .txt</button>
        <button id="gapCsv" ${missing.length ? '' : 'disabled'}>Download .csv</button>
        <label class="check"><input type="checkbox" id="planShowDone" ${pv.showDone ? 'checked' : ''}> Show trained plan skills</label>
      </div>
      ${missing.length ? `
      <div class="scroll-x"><table class="queue plan-table">
        <thead><tr><th>#</th><th>Skill</th><th class="num">SP</th><th class="num">Time</th><th class="num">Running total</th></tr></thead>
        <tbody>
          ${missing.map((m, i) => { cum += m.minutes || 0; return `<tr>
            <td class="dim">${i + 1}</td>
            <td><div class="item"><img src="${IMG}/types/${m.id}/icon?size=32" alt="" width="22" height="22" loading="lazy">${esc(m.name)} <b class="lvl">${roman(m.lvl)}</b>${m.prereq ? ' <em class="tag">prerequisite</em>' : ''}</div></td>
            <td class="num dim">${formatNum(Math.round(m.sp))}</td>
            <td class="num">${m.minutes != null ? formatDuration(m.minutes * 60000) : '—'}</td>
            <td class="num dim">${m.minutes != null ? formatDuration(cum * 60000) : ''}</td>
          </tr>`; }).join('')}
        </tbody>
      </table></div>` : `<div class="empty big"><span class="good">✓</span> ${esc(cur.c.name)} has every skill in this plan.</div>`}
      ${doneRows.length ? `<h3 class="sub">Already trained</h3><div class="done-list">${doneRows.map(([id, l]) => `<span>✓ ${esc(skName(id))} ${roman(l)}</span>`).join('')}</div>` : ''}
      <p class="hint">The missing list is in training order, with prerequisites first. "Copy missing skills" gives one skill level per line (e.g. <code>Drones IV</code>), which you can paste into EVE's skill queue or a skill plan. Plans are saved in this browser; use Copy plan to move one to another device.</p>`
      : '<div class="empty big">Add a character to compare plans against.</div>'}`;
  }

  main.innerHTML = `
    <section class="plan-tabs">
      ${plans.map(p => `<button class="${p.id === pv.sel && !pv.edit ? 'on' : ''}" data-plan="${p.id}">${esc(p.name)}</button>`).join('')}
      <button id="planNew" class="primary">+ New plan</button>
    </section>
    ${body}`;
  if (pv.edit) updateParseHint();
}

function missingExport(kind) {
  const plan = state.plans.find(p => p.id === state.pv.sel);
  const c = state.chars[state.pv.char];
  const g = gapFor(plan, c.id);
  const base = `${fileSafe(plan.name)}_${fileSafe(c.name)}_missing`;
  if (kind === 'text') return planText(g.steps.map(s => [s.id, s.lvl, s.name]));
  if (kind === 'txt') return download(`${base}.txt`, planText(g.steps.map(s => [s.id, s.lvl, s.name])) + '\n');
  const csv = ['Order,Skill,Level,Prerequisite,SP,Training minutes',
    ...g.steps.map((s, i) => `${i + 1},"${s.name}",${s.lvl},${s.prereq ? 'yes' : 'no'},${Math.round(s.sp)},${s.minutes != null ? Math.round(s.minutes) : ''}`)].join('\n');
  download(`${base}.csv`, csv + '\n', 'text/csv');
}

document.addEventListener('click', e => {
  if (state.selected !== 'plans') return;
  const t = e.target, pv = state.pv;
  const tab = t.closest('[data-plan]');
  if (tab) { pv.sel = tab.dataset.plan; pv.edit = null; return renderPlans($('#main')); }
  const ch = t.closest('[data-plan-char]');
  if (ch) { pv.char = Number(ch.dataset.planChar); return renderPlans($('#main')); }
  const id = t.closest('button')?.id;
  if (id === 'planNew' || id === 'planNew2') { pv.edit = 'new'; return renderPlans($('#main')); }
  if (id === 'planEdit') { pv.edit = 'edit'; return renderPlans($('#main')); }
  if (id === 'planCancel') { pv.edit = null; return renderPlans($('#main')); }
  if (id === 'planSave') {
    const name = $('#planName').value.trim();
    const { entries } = parsePlan($('#planText').value, state.data.SK);
    if (!name) { toast('Give the plan a name.', 'error'); return; }
    if (!entries.length) { toast('No skills recognised. Use one skill per line, like "Drones V".', 'error'); return; }
    if (pv.edit === 'new') {
      const p = { id: Math.random().toString(36).slice(2, 10), name, entries, updated: Date.now() };
      state.plans.push(p); pv.sel = p.id;
    } else {
      Object.assign(state.plans.find(p => p.id === pv.sel), { name, entries, updated: Date.now() });
    }
    savePlans(); pv.edit = null; renderAside(); renderPlans($('#main'));
    toast(`Saved "${name}".`);
    return;
  }
  if (id === 'planDelete') {
    const btn = t.closest('button');
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Click again to delete'; setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Delete'; } }, 3000); return; }
    state.plans = state.plans.filter(p => p.id !== pv.sel); pv.sel = null;
    savePlans(); renderAside(); renderPlans($('#main'));
    return;
  }
  if (id === 'planCopyAll') { const p = state.plans.find(x => x.id === pv.sel); return copyText(planText(p.entries.map(([i, l]) => [i, l, skName(i)])), t.closest('button')); }
  if (id === 'gapCopy') return copyText(missingExport('text'), t.closest('button'));
  if (id === 'gapTxt') return missingExport('txt');
  if (id === 'gapCsv') return missingExport('csv');
});

document.addEventListener('input', e => { if (e.target.id === 'planText') updateParseHint(); });
document.addEventListener('change', async e => {
  if (e.target.id === 'planShowDone') { state.pv.showDone = e.target.checked; renderPlans($('#main')); }
  if (e.target.id === 'planFile' && e.target.files[0]) {
    const f = e.target.files[0];
    let text;
    try {
      // .emp files are gzipped XML
      text = /\.emp$/i.test(f.name) && 'DecompressionStream' in window
        ? await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : await f.text();
    } catch { text = await f.text(); }
    const { entries } = parsePlan(text, state.data.SK);
    $('#planText').value = planText(entries.map(([i, l]) => [i, l, skName(i)]));
    if (!$('#planName').value) $('#planName').value = f.name.replace(/\.(emp|xml|txt)$/i, '');
    updateParseHint();
  }
});

function render() {
  renderAside();
  renderMain();
  $('#version').textContent = `v${APP_VERSION}`;
}

// ---------------------------------------------------------------- events
function select(id) {
  state.selected = ['all', 'ships', 'plans'].includes(id) ? id : Number(id);
  ls.set('ss.selected', state.selected);
  render();
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('#addBtn') || t.closest('#firstLogin')) { login(); return; }
  if (t.closest('#refreshBtn')) { refreshAll(); return; }
  const rm = t.closest('[data-remove]');
  if (rm) {
    e.stopPropagation();
    const id = Number(rm.dataset.remove);
    const btn = rm;
    if (btn.dataset.confirm !== '1') {   // two-click confirm, since dialogs like confirm() are avoided
      btn.dataset.confirm = '1'; btn.textContent = 'Remove?'; btn.classList.add('confirm');
      setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '×'; btn.classList.remove('confirm'); } }, 3000);
      return;
    }
    delete state.chars[id]; delete state.snaps[id];
    if (state.main === id) { state.main = charList()[0]?.id || null; ls.set('ss.main', state.main); }
    if (state.selected === id) state.selected = 'ships';
    saveChars(); saveSnaps(); render();
    toast('Removed from this browser. A shared sheet stays up until you stop sharing it (log the character in again to do that).');
    return;
  }
  const re = t.closest('[data-relogin]');
  if (re) { e.preventDefault(); login(); return; }
  const mk = t.closest('[data-main]');
  if (mk) { state.main = Number(mk.dataset.main); ls.set('ss.main', state.main); render(); return; }
  const sh = t.closest('[data-share]');
  if (sh) { openShare(Number(sh.dataset.share)); return; }
  const w = t.closest('[data-watch]');
  if (w && state.selected === 'ships') { toggleWatch(Number(w.dataset.watch)); renderMatrix($('#main')); return; }
  const mxc = t.closest('[data-mx]');
  if (mxc) { state.mx.open = state.mx.open === mxc.dataset.mx ? null : mxc.dataset.mx; renderMatrix($('#main')); return; }
  const sel = t.closest('[data-sel]');
  if (sel) select(sel.dataset.sel);
});

document.addEventListener('input', e => {
  if (e.target.id !== 'mxSearch') return;
  const pos = e.target.selectionStart;
  state.mx.q = e.target.value;
  renderMatrix($('#main'));
  const n = $('#mxSearch'); n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* ignore */ }
});

document.addEventListener('change', e => {
  const map = { mxFilter: 'filter', mxRace: 'race', mxClass: 'cls' };
  if (!map[e.target.id]) return;
  state.mx[map[e.target.id]] = e.target.value;
  state.mx.open = null;
  renderMatrix($('#main'));
});

// ---------------------------------------------------------------- boot
async function loadData() {
  const [SK, SH] = await Promise.all(['data/skills.json', 'data/ships.json'].map(u => fetch(u).then(r => r.json())));
  state.data = { SK, SH };
}

async function boot() {
  if (!configured()) $('#setup').hidden = false;
  await loadData();
  const params = new URLSearchParams(location.search);
  let added = null;
  if (params.has('code') || params.has('error')) {
    try {
      added = await handleCallback(params);
      state.selected = added; ls.set('ss.selected', added);
      toast(`${state.chars[added].name} added.`);
    } catch (e) { toast(e.message, 'error'); }
  }
  render();
  setInterval(() => tickCountdowns(), 30_000);

  if (added) await refreshAll([added]);
  const stale = Object.keys(state.chars).map(Number).filter(id => id !== added && (!state.snaps[id] || Date.now() - state.snaps[id].syncedAt > STALE_MS));
  if (stale.length) await refreshAll(stale);
}

boot().catch(e => { console.error(e); toast(e.message, 'error'); });

import { SCOPES, buildSnapshot } from './shared/snapshot.js';
import { renderSheet, tickCountdowns, until } from './shared/render.js';
import { queueSummary, formatSp, formatNum, timeAgo, roman, esc } from './shared/lib.js';

// ---------------------------------------------------------------- config
export const APP_VERSION = '1.0.0';   // bump on every release
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
  selected: ls.get('ss.selected', 'all'),
  busy: null,
  data: null,                          // { SK, SH }
};
const saveChars = () => ls.set('ss.chars', state.chars);
const saveSnaps = () => ls.set('ss.snaps', state.snaps);

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
          <span class="top"><b>${esc(c.name)}</b>${c.id === state.main ? '<span class="glyph main" title="Main character">★</span>' : ''}${c.sheet ? '<span class="glyph shared" title="Has a shared sheet">⇗</span>' : ''}<span class="sp">${s ? formatSp(s.totalSp) : ''}</span></span>
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
    actions: `
      ${id !== state.main ? `<button data-main="${id}">Make main</button>` : ''}
      <button class="primary" data-share="${id}">${c.sheet ? 'Shared ✓' : 'Share sheet'}</button>`,
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
      <thead><tr><th>Character</th><th class="num">Skillpoints</th><th class="num">Unallocated</th><th>Training now</th><th class="num">Level done in</th><th class="num">Queue ends in</th><th class="num">Synced</th></tr></thead>
      <tbody>
        ${rows.map(({ c, s, qs }) => {
          const cur = qs && !qs.empty ? qs.current : null;
          const warn = qs && (qs.empty || qs.paused || (qs.ends && qs.ends - now < 24 * 3600e3));
          return `<tr class="click" data-sel="${c.id}">
            <td><div class="item"><img src="${IMG}/characters/${c.id}/portrait?size=64" alt="" width="32" height="32">
              <div><b>${esc(c.name)}</b>${c.id === state.main ? ' <em class="main">MAIN</em>' : ''}${c.sheet ? ' <em class="shared">SHARED</em>' : ''}<small class="dim">${esc(s?.char.corpName || '')}</small></div></div></td>
            <td class="num">${s ? formatNum(s.totalSp) : '—'}</td>
            <td class="num ${s?.unallocSp ? 'accent' : 'dim'}">${s ? formatNum(s.unallocSp) : '—'}</td>
            <td>${cur ? `${esc(state.data.SK[cur.id]?.n || 'Skill')} <b class="lvl">${roman(cur.lvl)}</b>` : `<span class="${qs ? 'warn' : 'dim'}">${!s ? '—' : !qs ? 'Hidden' : 'Queue empty'}</span>`}</td>
            <td class="num">${cur && !qs.paused ? until(cur.finish) : ''}</td>
            <td class="num ${warn ? 'warn' : ''}">${qs?.paused ? 'Paused' : qs?.ends ? until(qs.ends) : ''}</td>
            <td class="num dim">${c.needsLogin ? '<span class="warn">Login expired</span>' : s ? timeAgo(s.syncedAt) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="hint">Click a character to open their full sheet. Characters, logins and cached data are stored only in this browser. Only sheets you choose to share are sent to the server.</p>`;
  return el;
}

function render() {
  renderAside();
  renderMain();
  $('#version').textContent = `v${APP_VERSION}`;
}

// ---------------------------------------------------------------- events
function select(id) {
  state.selected = id === 'all' ? 'all' : Number(id);
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
    if (state.selected === id) state.selected = 'all';
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
  const sel = t.closest('[data-sel]');
  if (sel) select(sel.dataset.sel);
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

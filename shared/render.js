// Renders one character sheet (header, stats, tabs). Shared by the private app
// and the public /s/<link> page.
import {
  effectiveSkills, skillGroups, skillStats, queueSummary, queueProgress, shipStatus, jumpCloneReady,
  formatSp, formatNum, formatDuration, formatDate, timeAgo, roman, esc, shipRace, RACES,
} from './lib.js';

const IMG = 'https://images.evetech.net';
const ATTR_NAMES = [['int', 'Intelligence'], ['mem', 'Memory'], ['per', 'Perception'], ['wil', 'Willpower'], ['cha', 'Charisma']];
const ATTR_SHORT = { int: 'INT', mem: 'MEM', per: 'PER', wil: 'WIL', cha: 'CHA' };

/** A span that the ticker keeps counting down. */
export const until = (ts, empty = '') => ts ? `<span data-until="${ts}">${formatDuration(ts - Date.now())}</span>` : empty;

export function tickCountdowns(root = document) {
  const now = Date.now();
  for (const el of root.querySelectorAll('[data-until]')) el.textContent = formatDuration(Number(el.dataset.until) - now);
}

/**
 * root: element to render into. snap: snapshot from buildSnapshot.
 * data: { SK: skills.json, SH: ships.json }. opts: { actions: html, publicView: bool }
 */
export function renderSheet(root, snap, data, opts = {}) {
  const st = root._sheet ||= { tab: opts.defaultTab || 'skills', q: '', untrained: false, shipQ: '', shipFilter: 'all', shipRace: 'all', shipGroup: 'class', openShip: null };
  st.snap = snap; st.data = data; st.opts = opts;
  SKILLS = data.SK;
  st.skills = effectiveSkills(snap);
  if (!root._wired) { wire(root); root._wired = true; }
  const tabs = availableTabs(snap);
  if (!tabs.some(t => t[0] === st.tab)) st.tab = 'skills';

  root.innerHTML = `
    ${header(snap, st.skills, opts)}
    <nav class="tabs" role="tablist">
      ${tabs.map(([k, label]) => `<button role="tab" data-tab="${k}" class="${k === st.tab ? 'on' : ''}">${label}</button>`).join('')}
    </nav>
    <div class="tab-body" id="tabBody"></div>`;
  renderTab(root);
}

function availableTabs(snap) {
  return [
    ['skills', 'Skills'],
    snap.queue && ['queue', `Skill queue${snap.queue.length ? ` <i>${queueSummary(snap.queue)?.count || 0}</i>` : ''}`],
    ['ships', 'Ships'],
    snap.attrs && ['attributes', 'Attributes'],
    snap.clones && ['clones', 'Clones &amp; implants'],
  ].filter(Boolean);
}

function header(snap, skills, opts) {
  const c = snap.char;
  const stats = skillStats(skills);
  const qs = queueSummary(snap.queue);
  let training = '<b class="dim">Hidden</b>';
  if (qs?.empty) training = '<b class="warn">Queue empty</b>';
  else if (qs?.paused) training = '<b class="warn">Paused</b><small>' + esc(skillLabel(qs.current)) + '</small>';
  else if (qs) training = `<b>${until(qs.ends)}</b><small>${esc(skillLabel(qs.current))} · ${until(qs.current.finish)}</small>`;

  return `
  <div class="sheet-head">
    <img class="portrait" src="${IMG}/characters/${c.id}/portrait?size=128" alt="" width="96" height="96">
    <div class="who">
      <h1>${esc(c.name)}</h1>
      <div class="aff">
        ${c.corpId ? `<span><img src="${IMG}/corporations/${c.corpId}/logo?size=32" alt="">${esc(c.corpName)}</span>` : ''}
        ${c.allianceId ? `<span><img src="${IMG}/alliances/${c.allianceId}/logo?size=32" alt="">${esc(c.allianceName)}</span>` : ''}
      </div>
      <div class="meta dim">
        ${c.birthday ? `Born ${esc(c.birthday.slice(0, 10))}` : ''}
        ${c.sec != null ? ` · Security ${Number(c.sec).toFixed(1)}` : ''}
        · Synced from ESI <span title="${esc(formatDate(snap.syncedAt))}">${timeAgo(snap.syncedAt)}</span>
      </div>
    </div>
    <div class="actions">${opts.actions || ''}</div>
  </div>
  <section class="stats">
    <div class="stat"><span>Total skillpoints</span><b>${formatNum(snap.totalSp)}</b><small>${formatSp(snap.totalSp)} SP</small></div>
    <div class="stat"><span>Unallocated</span><b>${formatSp(snap.unallocSp)}</b><small>${formatNum(snap.unallocSp)} SP</small></div>
    <div class="stat"><span>Skills</span><b>${stats.count}</b><small>${stats.atV} at level V</small></div>
    <div class="stat"><span>Queue ends</span>${training}</div>
  </section>`;
}

let SKILLS = {};
function skillLabel(q) {
  return `${SKILLS[q.id]?.n || `Skill ${q.id}`} ${roman(q.lvl)}`;
}

function renderTab(root) {
  const st = root._sheet;
  root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === st.tab));
  const body = root.querySelector('#tabBody');
  body.innerHTML = { skills: tabSkills, queue: tabQueue, ships: tabShips, attributes: tabAttributes, clones: tabClones }[st.tab](st);
}

// ---------------------------------------------------------------- skills
function tabSkills(st) {
  const { SK } = st.data;
  const queued = {};
  for (const q of st.snap.queue || []) if (!q.finish || q.finish > Date.now()) queued[q.id] = Math.max(queued[q.id] || 0, q.lvl);
  const terms = st.q.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = skillGroups(st.skills, SK).map(g => ({
    ...g,
    shown: g.skills.filter(s => (st.untrained || s.t >= 0) && terms.every(t => s.name.toLowerCase().includes(t) || g.name.toLowerCase().includes(t))),
  })).filter(g => g.shown.length);

  const pips = s => Array.from({ length: 5 }, (_, i) => {
    const lvl = i + 1;
    const cls = lvl <= s.t ? (lvl <= s.a ? 'on' : 'on alpha') : (queued[s.id] >= lvl ? 'queued' : '');
    return `<i class="${cls}"></i>`;
  }).join('');

  return `
  <div class="toolbar">
    <input type="search" id="skillSearch" placeholder="Search skills or groups…" value="${esc(st.q)}" autocomplete="off">
    <label class="check"><input type="checkbox" id="skillUntrained" ${st.untrained ? 'checked' : ''}> Show skills not injected</label>
    <span class="legend"><i class="pip on"></i>Trained <i class="pip queued"></i>Queued <i class="pip on alpha"></i>Alpha-limited</span>
  </div>
  ${groups.length ? groups.map(g => `
    <details class="group" ${terms.length ? 'open' : ''}>
      <summary class="group-head">
        <span class="gname">${esc(g.name)}</span>
        <span class="dim">${g.trained}/${g.total} skills · ${g.atV} at V</span>
        <b>${formatSp(g.sp)} SP</b>
      </summary>
      <div class="skill-list">
        ${g.shown.map(s => `
          <div class="skill ${s.t < 0 ? 'missing' : ''}">
            <span class="sname">${esc(s.name)} <small>×${s.rank}</small></span>
            <span class="pips">${pips(s)}</span>
            <span class="num dim">${s.t >= 0 ? formatNum(s.sp) : '—'}</span>
          </div>`).join('')}
      </div>
    </details>`).join('') : '<p class="empty">No skills match.</p>'}`;
}

// ---------------------------------------------------------------- queue
function tabQueue(st) {
  const now = Date.now();
  const left = (st.snap.queue || []).filter(q => !q.finish || q.finish > now);
  if (!left.length) return '<p class="empty big">The skill queue is empty.</p>';
  const paused = left.every(q => !q.finish);
  const sk = id => st.data.SK[id]?.n || `Skill ${id}`;
  return `
  ${paused ? '<div class="banner small">Training is paused. Times show once the queue is running again.</div>' : ''}
  <table class="queue">
    <thead><tr><th>#</th><th>Skill</th><th class="num">SP</th><th>Progress</th><th class="num">Finishes in</th><th class="num">Finishes at</th></tr></thead>
    <tbody>
    ${left.map((q, i) => {
      const p = i === 0 && !paused ? queueProgress(q, now) : 0;
      return `<tr>
        <td class="dim">${i + 1}</td>
        <td><div class="item"><img src="${IMG}/types/${q.id}/icon?size=32" alt="" width="24" height="24">${esc(sk(q.id))} <b class="lvl">${roman(q.lvl)}</b></div></td>
        <td class="num dim">${q.endSp != null ? formatNum(q.endSp - (q.lvlStartSp ?? 0)) : ''}</td>
        <td>${i === 0 && !paused ? `<div class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></div>` : ''}</td>
        <td class="num">${until(q.finish, '<span class="dim">—</span>')}</td>
        <td class="num dim">${formatDate(q.finish)}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`;
}

// ---------------------------------------------------------------- ships
const SHIP_FILTERS = [['all', 'All ships'], ['ok', 'Can fly'], ['close', 'Within 7 days'], ['month', 'Within 30 days'], ['no', "Can't fly yet"]];

export function shipFilterMatch(filter, s, watched) {
  if (filter === 'watch') return watched;
  if (filter === 'ok') return s.ok;
  if (filter === 'no') return !s.ok;
  if (filter === 'close') return !s.ok && s.minutes != null && s.minutes <= 7 * 1440;
  if (filter === 'month') return !s.ok && s.minutes != null && s.minutes <= 30 * 1440;
  return true;
}

export const starBtn = (id, on) => `<button class="star ${on ? 'on' : ''}" data-watch="${id}" title="${on ? 'Remove from' : 'Add to'} your watchlist">${on ? '★' : '☆'}</button>`;

function tabShips(st) {
  const { SK, SH } = st.data;
  const watch = st.opts.watch;           // Set of type ids, or undefined on public sheets
  const terms = st.shipQ.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map();
  let flyable = 0, total = 0;
  for (const [id, ship] of Object.entries(SH)) {
    const s = shipStatus(ship, st.skills, SK, st.snap.attrs);
    const race = shipRace(ship, SK);
    total++; if (s.ok) flyable++;
    const watched = !!watch?.has(Number(id));
    const show = terms.every(t => ship.n.toLowerCase().includes(t) || ship.g.toLowerCase().includes(t)) &&
      (st.shipRace === 'all' || race === st.shipRace) && shipFilterMatch(st.shipFilter, s, watched);
    const key = st.shipGroup === 'race' ? race : ship.g;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { name: key, ok: 0, total: 0, ships: [] });
    if (st.shipRace === 'all' || race === st.shipRace) { g.total++; if (s.ok) g.ok++; }
    if (show) g.ships.push({ id: Number(id), ...ship, race, watched, s });
  }
  const list = [...groups.values()].filter(g => g.ships.length).sort((a, b) =>
    st.shipGroup === 'race' ? RACES.indexOf(a.name) - RACES.indexOf(b.name) : b.ok / b.total - a.ok / a.total || a.name.localeCompare(b.name));
  const timeTxt = s => s.minutes != null ? ` · ~${formatDuration(s.minutes * 60000)}` : '';
  const openAll = terms.length || st.shipFilter !== 'all' || st.shipRace !== 'all';
  const filters = watch ? [['watch', '★ Watchlist'], ...SHIP_FILTERS] : SHIP_FILTERS;

  return `
  <div class="toolbar">
    <input type="search" id="shipSearch" placeholder="Search ships or classes…" value="${esc(st.shipQ)}" autocomplete="off">
    <select id="shipFilter">${filters.map(([v, l]) => `<option value="${v}" ${st.shipFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="shipRace"><option value="all">All races</option>${RACES.map(r => `<option ${st.shipRace === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <select id="shipGroup">
      <option value="class" ${st.shipGroup === 'class' ? 'selected' : ''}>Group by class</option>
      <option value="race" ${st.shipGroup === 'race' ? 'selected' : ''}>Group by race</option>
    </select>
    <span class="dim">Can fly <b class="good">${flyable}</b> of ${total} hulls</span>
  </div>
  ${list.length ? list.map(g => `
    <details class="group" ${openAll ? 'open' : ''}>
      <summary class="group-head">
        <span class="gname">${esc(g.name)}</span>
        <span class="meter-sm"><i style="width:${(g.ok / Math.max(1, g.total) * 100).toFixed(0)}%"></i></span>
        <b>${g.ok}/${g.total}</b>
      </summary>
      <div class="ship-list">
        ${g.ships.sort((a, b) => (b.s.ok - a.s.ok) || a.s.sp - b.s.sp || a.n.localeCompare(b.n)).map(sh => `
          <div class="ship ${sh.s.ok ? 'ok' : ''} ${st.openShip === sh.id ? 'open' : ''}" data-ship="${sh.id}">
            <div class="ship-row">
              ${watch ? starBtn(sh.id, sh.watched) : ''}
              <img src="${IMG}/types/${sh.id}/icon?size=32" alt="" width="28" height="28" loading="lazy">
              <span class="sname">${esc(sh.n)} <small class="dim">${esc(st.shipGroup === 'race' ? sh.g : sh.race)}</small></span>
              ${sh.s.ok ? '<span class="good">✓ Can fly</span>'
                : `<span class="dim">${sh.s.missing.length} skill${sh.s.missing.length > 1 ? 's' : ''} · ${formatSp(sh.s.sp)} SP${timeTxt(sh.s)}</span>`}
            </div>
            ${st.openShip === sh.id && !sh.s.ok ? missingList(sh.s.missing) : ''}
          </div>`).join('')}
      </div>
    </details>`).join('') : `<p class="empty">${st.shipFilter === 'watch' ? 'Your watchlist is empty. Click ☆ next to any ship to add it.' : 'No ships match.'}</p>`}
  <p class="hint">Times use the character's current attributes and implants${st.snap.attrs ? '' : ' (hidden on this sheet, so times are not shown)'}. Click a ship to see what's missing.</p>`;
}

export function missingList(missing) {
  return `<ul class="missing-list">
    ${missing.map(m => `<li><span>${esc(m.name)} ${m.injected ? `${roman(m.from)} → ` : '<em>not injected</em> → '}<b>${roman(m.to)}</b></span><span class="dim">${formatSp(m.sp)} SP${m.minutes != null ? ` · ${formatDuration(m.minutes * 60000)}` : ''}</span></li>`).join('')}
  </ul>`;
}

// ---------------------------------------------------------------- attributes
function tabAttributes(st) {
  const a = st.snap.attrs;
  const max = Math.max(32, ...ATTR_NAMES.map(([k]) => a[k] || 0));
  const now = Date.now();
  return `
  <div class="two-col">
    <div class="panel">
      <h3>Attributes</h3>
      ${ATTR_NAMES.map(([k, n]) => `
        <div class="attr"><span>${n}</span><div class="bar"><i style="width:${(a[k] / max * 100).toFixed(0)}%"></i></div><b>${a[k]}</b></div>`).join('')}
      <p class="hint">Values include active implants. Training speed for a skill is primary + half of secondary, in SP per minute.</p>
    </div>
    <div class="panel">
      <h3>Remaps</h3>
      <div class="kv"><span>Bonus remaps available</span><b>${a.bonusRemaps}</b></div>
      <div class="kv"><span>Last remap</span><b>${a.lastRemap ? formatDate(a.lastRemap) : 'Never'}</b></div>
      <div class="kv"><span>Next yearly remap</span><b>${!a.remapReady || a.remapReady <= now ? '<span class="good">Available now</span>' : `${until(a.remapReady)} <small class="dim">(${formatDate(a.remapReady)})</small>`}</b></div>
      <h3 style="margin-top:18px">Fastest-training skill groups right now</h3>
      ${fastestGroups(st)}
    </div>
  </div>`;
}

function fastestGroups(st) {
  const a = st.snap.attrs;
  const pairs = new Map();
  for (const s of Object.values(st.data.SK)) {
    if (!s.p) continue;
    const k = `${s.p}/${s.s}`;
    const p = pairs.get(k) || { k, p: s.p, s: s.s, rate: a[s.p] + a[s.s] / 2, groups: new Set() };
    p.groups.add(s.g);
    pairs.set(k, p);
  }
  return [...pairs.values()].sort((x, y) => y.rate - x.rate).slice(0, 4).map(p => `
    <div class="kv"><span>${ATTR_SHORT[p.p]} / ${ATTR_SHORT[p.s]} <small class="dim">${esc([...p.groups].slice(0, 3).join(', '))}${p.groups.size > 3 ? '…' : ''}</small></span><b>${formatNum(Math.round(p.rate * 60))} SP/h</b></div>`).join('');
}

// ---------------------------------------------------------------- clones
function tabClones(st) {
  const c = st.snap.clones;
  const imp = list => list?.length ? `<div class="implants">${list.map(i => `
      <div class="implant"><img src="${IMG}/types/${i.id}/icon?size=32" alt="" width="28" height="28" loading="lazy"><span>${esc(i.name)}</span></div>`).join('')}</div>`
    : '<p class="dim">No implants</p>';
  const ready = jumpCloneReady(c.lastJump, st.skills);
  return `
  <div class="two-col">
    <div class="panel">
      <h3>Active clone</h3>
      ${imp(st.snap.implants)}
      <div class="kv"><span>Home station</span><b>${c.home ? esc(c.home.name) : '—'}</b></div>
      <div class="kv"><span>Last clone jump</span><b>${c.lastJump ? formatDate(c.lastJump) : 'Never'}</b></div>
      <div class="kv"><span>Next jump available</span><b>${!ready || ready <= Date.now() ? '<span class="good">Now</span>' : until(ready)}</b></div>
    </div>
    <div class="panel">
      <h3>Jump clones <span class="dim">(${c.jump.length})</span></h3>
      ${c.jump.length ? c.jump.map(j => `
        <div class="jc">
          <div class="jc-head"><b>${esc(j.loc.name)}</b>${j.label ? `<span class="dim">${esc(j.label)}</span>` : ''}</div>
          ${imp(j.implants)}
        </div>`).join('') : '<p class="dim">No jump clones.</p>'}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- events
function wire(root) {
  root.addEventListener('click', e => {
    const st = root._sheet;
    const star = e.target.closest('[data-watch]');
    if (star) { e.stopPropagation(); st.opts.onToggleWatch?.(Number(star.dataset.watch)); keepOpen(root, () => renderTab(root)); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { st.tab = tab.dataset.tab; renderTab(root); return; }
    const ship = e.target.closest('[data-ship]');
    if (ship) {
      const id = Number(ship.dataset.ship);
      st.openShip = st.openShip === id ? null : id;
      keepOpen(root, () => renderTab(root));
    }
  });
  root.addEventListener('input', e => {
    const st = root._sheet;
    if (e.target.id === 'skillSearch') { st.q = e.target.value; rerenderKeepFocus(root, '#skillSearch'); }
    if (e.target.id === 'shipSearch') { st.shipQ = e.target.value; rerenderKeepFocus(root, '#shipSearch'); }
  });
  root.addEventListener('change', e => {
    const st = root._sheet;
    if (e.target.id === 'skillUntrained') { st.untrained = e.target.checked; renderTab(root); }
    if (e.target.id === 'shipFilter') { st.shipFilter = e.target.value; renderTab(root); }
    if (e.target.id === 'shipRace') { st.shipRace = e.target.value; renderTab(root); }
    if (e.target.id === 'shipGroup') { st.shipGroup = e.target.value; renderTab(root); }
  });
}

/** Re-render without collapsing the groups the user had open. */
export function keepOpen(root, fn) {
  const open = [...root.querySelectorAll('details.group[open] .gname')].map(x => x.textContent);
  fn();
  root.querySelectorAll('details.group').forEach(d => { if (open.includes(d.querySelector('.gname')?.textContent)) d.open = true; });
}

function rerenderKeepFocus(root, sel) {
  const el = root.querySelector(sel);
  const pos = el.selectionStart;
  renderTab(root);
  const n = root.querySelector(sel);
  n.focus();
  try { n.setSelectionRange(pos, pos); } catch { /* search inputs in some browsers */ }
}

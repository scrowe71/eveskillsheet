// Pure helpers (no DOM, no network) so they can be tested in Node.

// Skillpoints needed to reach each level, for a rank-1 skill.
const SP_TABLE = [0, 250, 1415, 8000, 45255, 256000];
export const spForLevel = (rank, lvl) => SP_TABLE[lvl] * rank;
export const INFOMORPH_SYNC = 33399;   // reduces jump clone cooldown by 1h per level

/**
 * Skill levels the character really has right now. ESI's skill list only updates
 * when the character logs in, so queue entries whose finish time has passed are
 * counted as trained.
 */
export function effectiveSkills(snap, now = Date.now()) {
  const out = {};
  for (const [id, [t, a, sp]] of Object.entries(snap.skills || {})) out[id] = { t, a, sp };
  for (const q of snap.queue || []) {
    if (q.finish && q.finish <= now) {
      const s = out[q.id] ??= { t: 0, a: 0, sp: 0 };
      if (q.lvl > s.t) { s.t = q.lvl; s.a = Math.max(s.a, q.lvl); s.sp = Math.max(s.sp, q.endSp || 0); s.fromQueue = true; }
    }
  }
  return out;
}

export const trainedLevel = (skills, id) => skills[id]?.t ?? -1;   // -1 = not injected

/** SP per minute for a skill from attributes: primary + secondary / 2. */
export function spPerMinute(attrs, skill) {
  if (!attrs || !skill?.p) return null;
  return (attrs[skill.p] || 0) + (attrs[skill.s] || 0) / 2;
}

/**
 * Everything still needed to meet a list of [skillId, level] requirements,
 * following prerequisite chains for skills that aren't injected or high enough.
 * Returns [{ id, from, to, sp, minutes }].
 */
export function missingFor(reqs, skills, SK, attrs) {
  const need = new Map();   // id -> target level
  const visit = (id, lvl, depth = 0) => {
    if (depth > 12) return;
    if (trainedLevel(skills, id) >= lvl) return;
    if ((need.get(id) || 0) >= lvl) return;
    need.set(id, lvl);
    for (const [pid, plvl] of SK[id]?.q || []) visit(pid, plvl, depth + 1);
  };
  for (const [id, lvl] of reqs) visit(id, lvl);

  const out = [];
  for (const [id, to] of need) {
    const s = SK[id] || { r: 1 };
    const have = skills[id];
    const from = Math.max(0, have?.t ?? 0);
    const sp = Math.max(0, spForLevel(s.r, to) - Math.max(have?.sp || 0, spForLevel(s.r, from)));
    const rate = spPerMinute(attrs, s);
    out.push({ id, name: s.n || `Skill ${id}`, injected: !!have, from, to, sp, minutes: rate ? sp / rate : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function shipStatus(ship, skills, SK, attrs) {
  const missing = missingFor(ship.q, skills, SK, attrs);
  const sp = missing.reduce((n, m) => n + m.sp, 0);
  const minutes = missing.every(m => m.minutes != null) ? missing.reduce((n, m) => n + m.minutes, 0) : null;
  return { ok: missing.length === 0, missing, sp, minutes };
}

/** Group skills by in-game group, including ones the character doesn't have. */
export function skillGroups(skills, SK) {
  const groups = new Map();
  for (const [id, s] of Object.entries(SK)) {
    let g = groups.get(s.g);
    if (!g) groups.set(s.g, g = { name: s.g, skills: [], trained: 0, total: 0, sp: 0, atV: 0 });
    const have = skills[id];
    g.skills.push({ id: Number(id), name: s.n, rank: s.r, t: have?.t ?? -1, a: have?.a ?? -1, sp: have?.sp || 0 });
    g.total++;
    if (have) { g.trained++; g.sp += have.sp || 0; if (have.t === 5) g.atV++; }
  }
  for (const g of groups.values()) g.skills.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillStats(skills) {
  const list = Object.values(skills);
  return {
    count: list.length,
    atV: list.filter(s => s.t === 5).length,
  };
}

/** What the queue looks like right now. */
export function queueSummary(queue, now = Date.now()) {
  if (!queue) return null;
  const left = queue.filter(q => !q.finish || q.finish > now);
  if (!left.length) return { empty: true, count: 0 };
  const paused = left.every(q => !q.finish);
  const current = left[0];
  const ends = paused ? null : Math.max(...left.map(q => q.finish || 0));
  return { empty: false, paused, count: left.length, current, ends };
}

/** Progress (0..1) through the level currently training. */
export function queueProgress(q, now = Date.now()) {
  if (!q.start || !q.finish || now <= q.start) return 0;
  if (now >= q.finish) return 1;
  // Training may have started part-way through the level.
  const span = (q.endSp ?? 0) - (q.lvlStartSp ?? 0);
  const startFrac = span > 0 && q.startSp != null ? (q.startSp - q.lvlStartSp) / span : 0;
  return startFrac + (1 - startFrac) * ((now - q.start) / (q.finish - q.start));
}

export function jumpCloneReady(lastJump, skills) {
  if (!lastJump) return null;
  const lvl = Math.max(0, trainedLevel(skills, INFOMORPH_SYNC));
  return lastJump + (24 - lvl) * 3600e3;
}

// ---------------------------------------------------------------- formatting
export function formatSp(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}
export const formatNum = n => Number(n).toLocaleString('en-US');
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];
export const roman = n => ROMAN[n] ?? '';

export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms <= 0) return 'done';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${Math.max(1, mm)}m`;
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const formatDate = ts => ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' EVE' : '';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- ship race / faction
const EMPIRES = ['Amarr', 'Caldari', 'Gallente', 'Minmatar'];
export const RACES = [...EMPIRES, 'Triglavian', 'ORE', 'Pirate / faction', 'Upwell', 'Other'];

/** Works out a hull's race from the racial ship skills it needs. Two empires = pirate/faction hull. */
export function shipRace(ship, SK) {
  const set = new Set();
  for (const [id] of ship.q) {
    const n = SK[id]?.n || '';
    for (const r of EMPIRES) if (n.startsWith(`${r} `)) set.add(r);
    if (n.startsWith('Precursor')) set.add('Triglavian');
    if (/^(Mining |Exhumers|Industrial Command|Capital Industrial|Expedition)/.test(n)) set.add('ORE');
    if (n.startsWith('Upwell')) set.add('Upwell');
  }
  const emp = EMPIRES.filter(r => set.has(r));
  if (emp.length > 1) return 'Pirate / faction';
  if (emp.length === 1) return emp[0];
  for (const r of ['Triglavian', 'ORE', 'Upwell']) if (set.has(r)) return r;
  return 'Other';
}

// ---------------------------------------------------------------- skill plans
const ROMAN_IN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

/**
 * Reads a pasted skill plan. Understands:
 *  - one skill per line: "Gallente Cruiser V", "Drones 5", "Drones\t5", "1. Drones IV"
 *  - EVEMon plan XML: <entry skillID="3436" skill="Drones" level="5" ...>
 * Returns { entries: [[skillId, level]], errors: [line] }. Keeps the plan's order,
 * and drops repeats (a later higher level replaces an earlier one).
 */
export function parsePlan(text, SK) {
  const byName = new Map(Object.entries(SK).map(([id, s]) => [s.n.toLowerCase(), Number(id)]));
  const entries = [], errors = [];
  const add = (id, lvl) => {
    const i = entries.findIndex(e => e[0] === id && e[1] >= lvl);
    if (i < 0) entries.push([id, lvl]);
  };
  const xml = [...String(text).matchAll(/<entry\b[^>]*>/gi)];
  if (xml.length) {
    for (const [tag] of xml) {
      const id = Number(tag.match(/skillID="(\d+)"/i)?.[1]);
      const lvl = Number(tag.match(/level="(\d)"/i)?.[1]);
      const name = tag.match(/skill="([^"]+)"/i)?.[1];
      const sid = SK[id] ? id : byName.get((name || '').toLowerCase());
      if (sid && lvl >= 1 && lvl <= 5) add(sid, lvl); else errors.push(name || tag.slice(0, 60));
    }
    return { entries, errors };
  }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(\d+[.)]|[-*•])\s+/, '').trim();
    if (!line) continue;
    const m = line.match(/^(.+?)[\s:]+(?:level\s*)?(v|iv|iii|ii|i|[1-5])\s*$/i);
    const id = m && byName.get(m[1].trim().toLowerCase());
    if (!id) { errors.push(raw.trim()); continue; }
    add(id, ROMAN_IN[m[2].toLowerCase()] || Number(m[2]));
  }
  return { entries, errors };
}

/**
 * Every skill level a character still needs to finish a plan, in training order:
 * missing prerequisites first, then each level one at a time.
 * Returns { steps: [{ id, name, lvl, sp, minutes, prereq }], done, total, sp, minutes }.
 */
export function planGap(entries, skills, SK, attrs) {
  const have = id => Math.max(0, skills[id]?.t ?? 0);
  const planned = {};            // id -> highest level already queued in steps
  const steps = [];
  const inPlan = new Set(entries.map(e => e[0]));
  const need = (id, lvl, prereq, depth = 0) => {
    if (depth > 12) return;
    const from = Math.max(have(id), planned[id] || 0);
    if (from >= lvl) return;
    if (!planned[id] && have(id) === 0 && !skills[id]) {
      for (const [pid, plvl] of SK[id]?.q || []) need(pid, plvl, true, depth + 1);
    }
    const s = SK[id] || { n: `Skill ${id}`, r: 1 };
    const rate = spPerMinute(attrs, s);
    for (let l = from + 1; l <= lvl; l++) {
      const sp = spForLevel(s.r, l) - Math.max(spForLevel(s.r, l - 1), l === have(id) + 1 ? skills[id]?.sp || 0 : 0);
      steps.push({ id, name: s.n, lvl: l, sp: Math.max(0, sp), minutes: rate ? Math.max(0, sp) / rate : null, prereq: prereq && !inPlan.has(id) });
    }
    planned[id] = lvl;
  };
  let done = 0;
  for (const [id, lvl] of entries) {
    if (have(id) >= lvl) done++;
    need(id, lvl, false);
  }
  const sp = steps.reduce((n, s) => n + s.sp, 0);
  const minutes = steps.every(s => s.minutes != null) ? steps.reduce((n, s) => n + s.minutes, 0) : null;
  return { steps, done, total: entries.length, sp, minutes };
}

/** "Skill Name V" lines, the format EVE and most tools accept when pasting a skill list. */
export const planText = list => list.map(([id, lvl, name]) => `${name} ${roman(lvl)}`).join('\n');

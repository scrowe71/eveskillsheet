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
 * following prerequisite chains (checked against trained levels, injected or not).
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
// A plan entry is [skillId, level, rec] where rec = 1 for "recommended", 0/absent for "required".
const ROMAN_IN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
const REC_WORDS = /^(recommended|rec|optional|nice to have)$/i;
const REQ_WORDS = /^(required|req|mandatory|minimum|min)$/i;

/** Adds an entry unless the same skill + level is already there (required beats recommended). */
export function addEntry(entries, id, lvl, rec) {
  const same = entries.find(e => e[0] === id && e[1] === lvl);
  if (same) { if (!rec) same[2] = 0; return entries; }
  entries.push([id, lvl, rec ? 1 : 0]);
  return entries;
}

/**
 * Reads a pasted skill plan. Understands:
 *  - one skill per line: "Gallente Cruiser V", "Drones 5", "Drones\t5", "1. Drones IV"
 *  - a priority after the level: "Drones V (recommended)", "Drones IV [req]"
 *  - section headings that switch priority: "Required:", "## Recommended", "Optional skills:"
 *  - EVEMon plan XML: <entry skillID="3436" skill="Drones" level="5" ...> (priority 1 = required, else recommended)
 * defaultRec sets the priority for lines with no marker or heading.
 * Returns { entries: [[skillId, level, rec]], errors: [line] } in the plan's order.
 */
export function parsePlan(text, SK, defaultRec = false) {
  const byName = new Map(Object.entries(SK).map(([id, s]) => [s.n.toLowerCase(), Number(id)]));
  const entries = [], errors = [];
  const xml = [...String(text).matchAll(/<entry\b[^>]*>/gi)];
  if (xml.length) {
    for (const [tag] of xml) {
      const id = Number(tag.match(/skillID="(\d+)"/i)?.[1]);
      const lvl = Number(tag.match(/level="(\d)"/i)?.[1]);
      const name = tag.match(/skill="([^"]+)"/i)?.[1];
      const prio = Number(tag.match(/priority="(\d+)"/i)?.[1] || 1);
      const sid = SK[id] ? id : byName.get((name || '').toLowerCase());
      if (sid && lvl >= 1 && lvl <= 5) addEntry(entries, sid, lvl, defaultRec || prio > 1); else errors.push(name || tag.slice(0, 60));
    }
    return { entries, errors };
  }
  let rec = !!defaultRec;
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/^\s*(\d+[.)]|[-*•])\s+/, '').trim();
    if (!line) continue;
    const head = line.replace(/^#+\s*/, '').replace(/\s*(skills?)?\s*:?\s*$/i, '').trim();
    if (REC_WORDS.test(head)) { rec = true; continue; }
    if (REQ_WORDS.test(head)) { rec = false; continue; }
    let lineRec = rec;
    const mark = line.match(/\s*(?:[([]\s*([a-z ]+?)\s*[)\]]|[-–]\s*([a-z ]+))\s*$/i);
    const word = mark && (mark[1] || mark[2]);
    if (word && (REC_WORDS.test(word) || REQ_WORDS.test(word))) { lineRec = REC_WORDS.test(word); line = line.slice(0, mark.index).trim(); }
    const m = line.match(/^(.+?)[\s:]+(?:level\s*)?(v|iv|iii|ii|i|[1-5])\s*$/i);
    const id = m && byName.get(m[1].trim().toLowerCase());
    if (!id) { errors.push(raw.trim()); continue; }
    addEntry(entries, id, ROMAN_IN[m[2].toLowerCase()] || Number(m[2]), lineRec);
  }
  return { entries, errors };
}

/**
 * Every skill level a character still needs, in training order: all required
 * entries first (with their missing prerequisites), then recommended ones.
 * Prerequisites take the priority of the entry that needs them.
 * Returns { steps: [{ id, name, lvl, sp, minutes, prereq, rec }], req: {...totals}, all: {...totals} }.
 */
export function planGap(entries, skills, SK, attrs) {
  const have = id => Math.max(0, skills[id]?.t ?? 0);
  const planned = {};
  const steps = [];
  const inPlan = new Set(entries.map(e => e[0]));
  const need = (id, lvl, rec, prereq, depth = 0) => {
    if (depth > 12) return;
    const from = Math.max(have(id), planned[id] || 0);
    if (from >= lvl) return;
    // Prerequisites come first, checked against what's actually trained: a skillbook can be injected
    // before its prerequisites are, so being injected (even at level 0) proves nothing.
    if (!planned[id]) {
      for (const [pid, plvl] of SK[id]?.q || []) need(pid, plvl, rec, true, depth + 1);
    }
    const s = SK[id] || { n: `Skill ${id}`, r: 1 };
    const rate = spPerMinute(attrs, s);
    for (let l = from + 1; l <= lvl; l++) {
      const sp = Math.max(0, spForLevel(s.r, l) - Math.max(spForLevel(s.r, l - 1), l === have(id) + 1 ? skills[id]?.sp || 0 : 0));
      steps.push({ id, name: s.n, lvl: l, sp, minutes: rate ? sp / rate : null, prereq: prereq && !inPlan.has(id), rec: !!rec });
    }
    planned[id] = lvl;
  };
  const req = entries.filter(e => !e[2]), rec = entries.filter(e => e[2]);
  for (const [id, lvl] of req) need(id, lvl, false, false);
  for (const [id, lvl] of rec) need(id, lvl, true, false);

  const totals = (list, ents) => ({
    done: ents.filter(([id, lvl]) => have(id) >= lvl).length,
    total: ents.length,
    sp: list.reduce((n, s) => n + s.sp, 0),
    minutes: list.every(s => s.minutes != null) ? list.reduce((n, s) => n + s.minutes, 0) : null,
    levels: list.length,
  });
  return { steps, req: totals(steps.filter(s => !s.rec), req), all: totals(steps, entries) };
}

/** "Skill Name V" lines, the format EVE and most tools accept when pasting a skill list. */
export const planText = list => list.map(([id, lvl, name]) => `${name} ${roman(lvl)}`).join('\n');

/** Whole plan as text with Required / Recommended sections (parsePlan reads it back). */
export function planToText(entries, nameOf) {
  const req = entries.filter(e => !e[2]), rec = entries.filter(e => e[2]);
  const block = list => list.map(([id, lvl]) => `${nameOf(id)} ${roman(lvl)}`).join('\n');
  if (!rec.length) return block(req);
  return `Required:\n${block(req)}\n\nRecommended:\n${block(rec)}`;
}

// ---------------------------------------------------------------- ship fits (EFT format)
/**
 * Reads an EFT fit (what EVE's fitting window, Pyfa and zKillboard copy):
 *   [Ishtar, Ratting]
 *   Drone Damage Amplifier II
 *   Heavy Missile Launcher II, Scourge Heavy Missile
 *   [Empty High slot]
 *   Ogre II x5
 * ITEMS: items.json ({name: [typeId, kindCode, reqs]}). SH: ships.json.
 * Returns { ship: {id, name, q} | null, name, items: [{ id, name, kind, qty, reqs }], unknown: [line] }.
 * kind: module | subsystem | charge (loaded) | drone | implant | booster | cargo
 */
export function parseFit(text, SH, ITEMS) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim());
  const shipByName = new Map(Object.entries(SH).map(([id, s]) => [s.n.toLowerCase(), { id: Number(id), name: s.n, q: s.q }]));
  const itemByName = new Map(Object.entries(ITEMS).map(([n, v]) => [n.toLowerCase(), { name: n, id: v[0], code: v[1], reqs: v[2] }]));
  const out = { ship: null, name: '', items: [], unknown: [] };
  let i = 0;
  while (i < lines.length && !lines[i]) i++;
  const head = (lines[i] || '').match(/^\[([^,\]]+)(?:,\s*(.*))?\]$/);
  if (head) {
    out.ship = shipByName.get(head[1].trim().toLowerCase()) || null;
    out.name = (head[2] || '').trim();
    if (!out.ship) out.unknown.push(`${head[1].trim()} (ship)`);
    i++;
  }
  const add = (it, kind, qty = 1) => {
    const prev = out.items.find(x => x.id === it.id && x.kind === kind);
    if (prev) prev.qty += qty; else out.items.push({ id: it.id, name: it.name, kind, qty, reqs: it.reqs });
  };
  for (; i < lines.length; i++) {
    let line = lines[i];
    if (!line || /^\[empty .* slot\]$/i.test(line)) continue;
    line = line.replace(/\s*\/offline$/i, '').trim();
    const qm = line.match(/^(.*\S)\s+x(\d+)$/i);
    if (qm) {                                   // "Hammerhead II x5": drone bay or cargo
      const it = itemByName.get(qm[1].toLowerCase());
      if (!it) { out.unknown.push(line); continue; }
      add(it, it.code === 'd' || it.code === 'f' ? 'drone' : 'cargo', Number(qm[2]));
      continue;
    }
    let it = itemByName.get(line.toLowerCase()), charge = null;
    if (!it && line.includes(',')) {           // "Module, Loaded Charge"
      const k = line.indexOf(',');
      it = itemByName.get(line.slice(0, k).trim().toLowerCase());
      charge = itemByName.get(line.slice(k + 1).trim().toLowerCase());
      if (it && !charge) out.unknown.push(`${line.slice(k + 1).trim()} (charge)`);
    }
    if (!it) { out.unknown.push(line); continue; }
    add(it, it.code === 's' ? 'subsystem' : it.code === 'c' ? 'cargo' : it.code === 'd' || it.code === 'f' ? 'drone' : it.code === 'i' ? 'implant' : it.code === 'b' ? 'booster' : 'module');
    if (charge) add(charge, 'charge');
  }
  return out;
}

/**
 * Skill requirements of a fit as plan entries [skillId, level, rec].
 * The hull, modules and subsystems are required. Drones, loaded charges, implants and boosters count as
 * required when checking "can fly" (drones/charges/implants options), or as recommended when
 * optionalAsRec is set (used when turning a fit into a skill plan). Cargo is ignored.
 */
export function fitEntries(fit, { drones = true, charges = true, implants = true, optionalAsRec = false } = {}) {
  const req = new Map(), rec = new Map();
  const put = (map, reqs) => { for (const [id, lvl] of reqs || []) map.set(id, Math.max(map.get(id) || 0, lvl)); };
  if (fit.ship) put(req, fit.ship.q);
  for (const it of fit.items) {
    if (it.kind === 'module' || it.kind === 'subsystem') put(req, it.reqs);
    else if ((it.kind === 'drone' && drones) || (it.kind === 'charge' && charges) || ((it.kind === 'implant' || it.kind === 'booster') && implants)) put(optionalAsRec ? rec : req, it.reqs);
  }
  const out = [...req].map(([id, lvl]) => [id, lvl, 0]);
  for (const [id, lvl] of rec) if (lvl > (req.get(id) || 0)) out.push([id, lvl, 1]);
  return out;
}

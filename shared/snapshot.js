// Builds one character "snapshot" from ESI. Used by the browser app AND by the
// share server (Cloudflare Pages Function), so a published sheet always comes
// straight from ESI and can't be edited by whoever publishes it.
//
// esi(path, { auth, method, body }) must return parsed JSON or throw an Error
// with a numeric .status.

export const SNAPSHOT_VERSION = 1;

export const SCOPES = [
  'esi-skills.read_skills.v1',
  'esi-skills.read_skillqueue.v1',
  'esi-clones.read_clones.v1',
  'esi-clones.read_implants.v1',
  'esi-universe.read_structures.v1',
];

const isStation = id => id >= 60000000 && id < 64000000;
const isStructure = id => id >= 1e12;

export async function buildSnapshot(esi, charId, include = {}) {
  const inc = { queue: true, attributes: true, clones: true, ...include };
  const base = `/characters/${charId}`;
  const opt = p => p.catch(e => { if (e.status === 403) return null; throw e; });  // missing scope → section hidden

  const [pub, skills, queue, attrs, implants, clones] = await Promise.all([
    esi(base),
    esi(`${base}/skills`, { auth: true }),
    inc.queue ? opt(esi(`${base}/skillqueue`, { auth: true })) : null,
    inc.attributes ? opt(esi(`${base}/attributes`, { auth: true })) : null,
    inc.clones ? opt(esi(`${base}/implants`, { auth: true })) : null,
    inc.clones ? opt(esi(`${base}/clones`, { auth: true })) : null,
  ]);

  // ---- names (corp, alliance, implants, NPC stations) via the public bulk endpoint
  const ids = new Set([pub.corporation_id, pub.alliance_id].filter(Boolean));
  for (const t of implants || []) ids.add(t);
  const locIds = new Set();
  if (clones) {
    if (clones.home_location) locIds.add(clones.home_location.location_id);
    for (const jc of clones.jump_clones || []) {
      locIds.add(jc.location_id);
      for (const t of jc.implants || []) ids.add(t);
    }
  }
  for (const l of locIds) if (isStation(l)) ids.add(l);

  const names = {};
  const list = [...ids];
  for (let i = 0; i < list.length; i += 500) {
    try {
      for (const n of await esi('/universe/names', { method: 'POST', body: list.slice(i, i + 500) })) names[n.id] = n.name;
    } catch { /* names are cosmetic */ }
  }
  await Promise.all([...locIds].filter(isStructure).map(async id => {
    try { names[id] = (await esi(`/universe/structures/${id}`, { auth: true })).name; }
    catch { names[id] = null; }   // no docking access: ESI won't tell us the name
  }));
  const loc = id => ({ id, name: names[id] || (isStructure(id) ? 'Structure (no docking access)' : `Location ${id}`) });

  return {
    v: SNAPSHOT_VERSION,
    syncedAt: Date.now(),
    char: {
      id: charId,
      name: pub.name,
      corpId: pub.corporation_id,
      corpName: names[pub.corporation_id] || '',
      allianceId: pub.alliance_id || null,
      allianceName: pub.alliance_id ? names[pub.alliance_id] || '' : '',
      birthday: pub.birthday || null,
      sec: pub.security_status ?? null,
    },
    totalSp: skills.total_sp || 0,
    unallocSp: skills.unallocated_sp || 0,
    // typeId -> [trained level, active level, skillpoints]
    skills: Object.fromEntries((skills.skills || []).map(s => [s.skill_id, [s.trained_skill_level, s.active_skill_level, s.skillpoints_in_skill]])),
    queue: queue && queue.map(q => ({
      id: q.skill_id, lvl: q.finished_level, pos: q.queue_position,
      start: q.start_date ? Date.parse(q.start_date) : null,
      finish: q.finish_date ? Date.parse(q.finish_date) : null,
      startSp: q.training_start_sp ?? null, endSp: q.level_end_sp ?? null, lvlStartSp: q.level_start_sp ?? null,
    })).sort((a, b) => a.pos - b.pos),
    attrs: attrs && {
      cha: attrs.charisma, int: attrs.intelligence, mem: attrs.memory, per: attrs.perception, wil: attrs.willpower,
      bonusRemaps: attrs.bonus_remaps ?? 0,
      lastRemap: attrs.last_remap_date ? Date.parse(attrs.last_remap_date) : null,
      remapReady: attrs.accrued_remap_cooldown_date ? Date.parse(attrs.accrued_remap_cooldown_date) : null,
    },
    implants: implants && implants.map(id => ({ id, name: names[id] || `Implant ${id}` })),
    clones: clones && {
      home: clones.home_location ? { ...loc(clones.home_location.location_id), kind: clones.home_location.location_type } : null,
      lastJump: clones.last_clone_jump_date ? Date.parse(clones.last_clone_jump_date) : null,
      jump: (clones.jump_clones || []).map(jc => ({
        label: jc.name || '',
        loc: loc(jc.location_id),
        implants: (jc.implants || []).map(id => ({ id, name: names[id] || `Implant ${id}` })),
      })),
    },
  };
}

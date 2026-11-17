// POST /api/sheets   publish or update the logged-in character's sheet
// GET  /api/sheets   is the logged-in character's sheet shared? (returns its link)
import { bearer, verifyEveToken } from '../../../server/auth.js';
import { makeEsi } from '../../../server/esi.js';
import { json, error, needDb, newSlug } from '../../../server/http.js';
import { buildSnapshot } from '../../../shared/snapshot.js';

export async function onRequestGet({ request, env }) {
  try {
    const db = needDb(env);
    const who = await verifyEveToken(bearer(request), env);
    const row = await db.prepare('SELECT slug, include, updated_at FROM sheets WHERE character_id = ?').bind(who.id).first();
    if (!row) return json({ error: 'Not shared' }, 404);
    return json({ slug: row.slug, include: JSON.parse(row.include), updatedAt: row.updated_at });
  } catch (e) { return error(e); }
}

export async function onRequestPost({ request, env }) {
  try {
    const db = needDb(env);
    const token = bearer(request);
    const who = await verifyEveToken(token, env);
    if (!who.scopes.includes('esi-skills.read_skills.v1')) throw Object.assign(new Error('This login is missing the skills permission. Log the character in again.'), { status: 403 });

    let body = {};
    try { body = await request.json(); } catch { /* defaults */ }
    const inc = body.include || {};
    const include = { queue: !!inc.queue, attributes: !!inc.attributes, clones: !!inc.clones };

    const existing = await db.prepare('SELECT slug, updated_at FROM sheets WHERE character_id = ?').bind(who.id).first();
    if (existing && Date.now() - existing.updated_at < 20_000) return json({ slug: existing.slug, updatedAt: existing.updated_at });

    // Pulled from ESI here on the server, so the person publishing can't alter it.
    const snap = await buildSnapshot(makeEsi(token), who.id, include);
    snap.publishedAt = Date.now();
    snap.include = include;

    const slug = existing?.slug || newSlug();
    const now = Date.now();
    await db.prepare(`
      INSERT INTO sheets (slug, character_id, character_name, include, data, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT(character_id) DO UPDATE SET
        character_name = excluded.character_name, include = excluded.include,
        data = excluded.data, updated_at = excluded.updated_at`)
      .bind(slug, who.id, snap.char.name, JSON.stringify(include), JSON.stringify(snap), now).run();
    return json({ slug, updatedAt: now });
  } catch (e) { return error(e); }
}

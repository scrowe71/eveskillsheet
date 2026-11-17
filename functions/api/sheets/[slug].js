// GET    /api/sheets/<slug>   public: the shared sheet data
// DELETE /api/sheets/<slug>   stop sharing (only the character it belongs to)
import { bearer, verifyEveToken } from '../../../server/auth.js';
import { json, error, needDb } from '../../../server/http.js';

const validSlug = s => /^[A-Za-z0-9_-]{6,40}$/.test(s);

export async function onRequestGet({ params, env }) {
  try {
    const db = needDb(env);
    if (!validSlug(params.slug)) return json({ error: 'Not found' }, 404);
    const row = await db.prepare('SELECT data FROM sheets WHERE slug = ?').bind(params.slug).first();
    if (!row) return json({ error: 'Not found' }, 404);
    return new Response(row.data, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex' },
    });
  } catch (e) { return error(e); }
}

export async function onRequestDelete({ params, request, env }) {
  try {
    const db = needDb(env);
    const who = await verifyEveToken(bearer(request), env);
    const res = await db.prepare('DELETE FROM sheets WHERE slug = ? AND character_id = ?').bind(params.slug, who.id).run();
    if (!res.meta?.changes) return json({ error: 'That sheet does not belong to this character' }, 404);
    return json({ ok: true });
  } catch (e) { return error(e); }
}

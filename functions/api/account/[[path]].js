// /api/account/...  EveSkillsheet accounts (see server/account.js)
//   POST   /api/account/login              {access_token, refresh_token}  log in (creates the account on first login)
//   POST   /api/account/logout
//   GET    /api/account                    characters + saved fits, plans, watchlist, prefs
//   POST   /api/account/characters         {access_token, refresh_token}  add a character to the account
//   DELETE /api/account/characters/<id>
//   GET    /api/account/token/<id>         short-lived ESI access token for one of your characters
//   PUT    /api/account/data/<kind>        {value}  save fits | plans | watch | prefs
//   POST   /api/account/import             one-time move of data that used to live in the browser
import { json, error, needDb } from '../../../server/http.js';
import { verifyEveToken } from '../../../server/auth.js';
import {
  ensureSchema, err, clientId, currentAccount, createSession, endSession, saveCharacter, accessTokenFor,
  accountPayload, putData, refreshToken,
} from '../../../server/account.js';

export async function onRequest(ctx) { return handleAccount(ctx); }

export async function handleAccount({ request, env, params }, fetchImpl = fetch) {
  try {
    const db = needDb(env);
    await ensureSchema(db);
    const parts = [].concat(params.path || []).filter(Boolean);
    const route = `${request.method} ${parts[0] || ''}`;
    const body = async () => { try { return await request.json(); } catch { return {}; } };

    if (route === 'POST login') {
      const { access_token, refresh_token } = await body();
      if (!access_token || !refresh_token) throw err(400, 'Missing tokens');
      const who = await verifyEveToken(access_token, { CLIENT_ID: clientId(env) }, fetchImpl);
      // Log into the account this character already belongs to, or start a new one with it as main.
      const owned = await db.prepare('SELECT account_id FROM account_characters WHERE character_id = ?').bind(who.id).first();
      const accountId = owned?.account_id ?? who.id;
      await db.prepare('INSERT OR IGNORE INTO accounts (id, main_character_id, created_at) VALUES (?, ?, ?)').bind(accountId, who.id, Date.now()).run();
      await saveCharacter(env, accountId, access_token, refresh_token, fetchImpl);
      const cookie = await createSession(db, accountId);
      return json(await accountPayload(db, accountId), 200, { 'Set-Cookie': cookie });
    }

    if (route === 'POST logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': await endSession(request, db) });
    }

    const me = await currentAccount(request, db);
    if (!me) throw err(401, 'Not logged in');

    if (route === 'GET ') return json(await accountPayload(db, me.id));

    if (route === 'POST characters') {
      const { access_token, refresh_token } = await body();
      if (!access_token || !refresh_token) throw err(400, 'Missing tokens');
      const who = await saveCharacter(env, me.id, access_token, refresh_token, fetchImpl);
      return json({ id: who.id, name: who.name });
    }

    if (route === 'DELETE characters' && parts[1]) {
      const id = Number(parts[1]);
      const res = await db.prepare('DELETE FROM account_characters WHERE character_id = ? AND account_id = ?').bind(id, me.id).run();
      if (!res.meta?.changes) throw err(404, 'That character is not on your account');
      return json({ ok: true });
    }

    if (route === 'GET token' && parts[1]) {
      return json(await accessTokenFor(env, me.id, Number(parts[1]), fetchImpl));
    }

    if (route === 'PUT data' && parts[1]) {
      await putData(db, me.id, parts[1], (await body()).value);
      return json({ ok: true });
    }

    if (route === 'POST import') {
      // Characters, fits, plans and watchlist that were saved in this browser before accounts existed.
      const b = await body();
      const added = [], failed = [];
      for (const refresh of [].concat(b.refresh_tokens || []).slice(0, 50)) {
        try {
          const tok = await refreshToken(env, refresh, fetchImpl);
          const who = await saveCharacter(env, me.id, tok.access_token, tok.refresh_token || refresh, fetchImpl);
          added.push(who.name);
        } catch (e) { failed.push(e.message); }
      }
      const current = (await accountPayload(db, me.id)).data;
      const mergeById = (a = [], b2 = []) => { const seen = new Set(a.map(x => x.id)); return [...a, ...b2.filter(x => x && !seen.has(x.id))]; };
      if (Array.isArray(b.fits)) await putData(db, me.id, 'fits', mergeById(current.fits, b.fits));
      if (Array.isArray(b.plans)) await putData(db, me.id, 'plans', mergeById(current.plans, b.plans));
      if (Array.isArray(b.watch)) await putData(db, me.id, 'watch', [...new Set([...(current.watch || []), ...b.watch])]);
      if (b.prefs && typeof b.prefs === 'object') await putData(db, me.id, 'prefs', { ...b.prefs, ...(current.prefs || {}) });
      return json({ added, failed, ...(await accountPayload(db, me.id)) });
    }

    throw err(404, 'Not found');
  } catch (e) {
    return e.needsLogin ? json({ error: e.message, needsLogin: true }, 401) : error(e);
  }
}

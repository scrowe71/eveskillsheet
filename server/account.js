// Accounts for EveSkillsheet.
//
// An account is created by logging in with a character (your main). Characters added
// while logged in belong to that account, and so do fits, skill plans and the ship
// watchlist. Everything is private to the account and follows it to any device.
//
// EVE refresh tokens are stored encrypted (AES-GCM, key from the TOKEN_KEY secret).
// The browser never holds them: it asks /api/account/token/<id> for a short-lived
// access token and calls ESI with that.
import { verifyEveToken } from './auth.js';

export const CLIENT_ID_DEFAULT = '0f22c28f5a494edea1d0319467cde55d';   // public; matches config.js
const SSO_TOKEN = 'https://login.eveonline.com/v2/oauth/token';
const SESSION_DAYS = 30;
export const DATA_KINDS = ['fits', 'plans', 'watch', 'prefs'];
const MAX_DATA_BYTES = 1_000_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id INTEGER PRIMARY KEY, main_character_id INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account_characters (
     character_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, name TEXT NOT NULL,
     refresh_enc TEXT NOT NULL, access_token TEXT, access_exp INTEGER NOT NULL DEFAULT 0,
     scopes TEXT NOT NULL DEFAULT '[]', needs_login INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_account_characters_account ON account_characters (account_id)`,
  `CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account_data (
     account_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, kind))`,
];
let ready = null;
export const ensureSchema = db => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));

export const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const clientId = env => env.CLIENT_ID || CLIENT_ID_DEFAULT;

// ---------------------------------------------------------------- encryption
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let keyCache = null;
async function aesKey(env) {
  if (!env.TOKEN_KEY || String(env.TOKEN_KEY).length < 16) throw err(503, 'Accounts are not set up yet: add a TOKEN_KEY secret (at least 16 characters) to this Pages project (see README).');
  if (keyCache?.src === env.TOKEN_KEY) return keyCache.key;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TOKEN_KEY));
  keyCache = { src: env.TOKEN_KEY, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  return keyCache.key;
}
export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decrypt(env, blob) {
  const [iv, ct] = String(blob).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}

// ---------------------------------------------------------------- sessions
const cookies = req => Object.fromEntries((req.headers.get('Cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
export const sessionCookie = (id, maxAge) => `ss_sess=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const randomId = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createSession(db, accountId) {
  const id = randomId();
  await db.prepare('INSERT INTO account_sessions (id, account_id, expires) VALUES (?, ?, ?)').bind(id, accountId, Date.now() + SESSION_DAYS * 86400e3).run();
  return sessionCookie(id, SESSION_DAYS * 86400);
}
export async function currentAccount(req, db) {
  const sid = cookies(req).ss_sess;
  if (!sid) return null;
  const row = await db.prepare('SELECT account_id, expires FROM account_sessions WHERE id = ?').bind(sid).first();
  if (!row || row.expires < Date.now()) return null;
  return { id: row.account_id, sid };
}
export async function endSession(req, db) {
  const sid = cookies(req).ss_sess;
  if (sid) await db.prepare('DELETE FROM account_sessions WHERE id = ?').bind(sid).run();
  return sessionCookie('', 0);
}

// ---------------------------------------------------------------- characters
/** Exchange a refresh token for a new access token (PKCE public client: no secret). */
export async function refreshToken(env, refresh, fetchImpl = fetch) {
  const r = await fetchImpl(SSO_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId(env) }),
  });
  if (!r.ok) throw err(r.status === 400 || r.status === 401 ? 401 : 502, `EVE login refresh failed (${r.status})`, { needsLogin: r.status === 400 || r.status === 401 });
  return r.json();
}

/** Save (or move) a character into an account, with its tokens. Returns the verified character. */
export async function saveCharacter(env, accountId, accessToken, refresh, fetchImpl = fetch) {
  const who = await verifyEveToken(accessToken, { CLIENT_ID: clientId(env) }, fetchImpl);
  const exp = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
  await env.DB.prepare(`
    INSERT INTO account_characters (character_id, account_id, name, refresh_enc, access_token, access_exp, scopes, needs_login, added_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)
    ON CONFLICT(character_id) DO UPDATE SET account_id = excluded.account_id, name = excluded.name, refresh_enc = excluded.refresh_enc,
      access_token = excluded.access_token, access_exp = excluded.access_exp, scopes = excluded.scopes, needs_login = 0`)
    .bind(who.id, accountId, who.name, await encrypt(env, refresh), accessToken, exp, JSON.stringify(who.scopes), Date.now()).run();
  return who;
}

/** Valid access token for one of the account's characters, refreshing if needed. */
export async function accessTokenFor(env, accountId, characterId, fetchImpl = fetch) {
  const db = env.DB;
  const load = () => db.prepare('SELECT * FROM account_characters WHERE character_id = ? AND account_id = ?').bind(characterId, accountId).first();
  const row = await load();
  if (!row) throw err(404, 'That character is not on your account');
  if (row.access_token && row.access_exp - 60_000 > Date.now()) return { access_token: row.access_token, exp: row.access_exp };
  try {
    const tok = await refreshToken(env, await decrypt(env, row.refresh_enc), fetchImpl);
    const exp = JSON.parse(atob(tok.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
    await db.prepare('UPDATE account_characters SET access_token = ?, access_exp = ?, refresh_enc = ?, needs_login = 0 WHERE character_id = ?')
      .bind(tok.access_token, exp, await encrypt(env, tok.refresh_token || await decrypt(env, row.refresh_enc)), characterId).run();
    return { access_token: tok.access_token, exp };
  } catch (e) {
    const again = await load();   // another request may have refreshed it a moment ago
    if (again?.access_token && again.access_exp - 60_000 > Date.now()) return { access_token: again.access_token, exp: again.access_exp };
    if (e.needsLogin) await db.prepare('UPDATE account_characters SET needs_login = 1 WHERE character_id = ?').bind(characterId).run();
    throw e;
  }
}

// ---------------------------------------------------------------- account payload
export async function accountPayload(db, accountId) {
  const acc = await db.prepare('SELECT id, main_character_id FROM accounts WHERE id = ?').bind(accountId).first();
  const { results: chars } = await db.prepare('SELECT character_id, name, scopes, needs_login, added_at FROM account_characters WHERE account_id = ? ORDER BY added_at').bind(accountId).all();
  const { results: data } = await db.prepare('SELECT kind, data, updated_at FROM account_data WHERE account_id = ?').bind(accountId).all();
  return {
    account: { id: acc.id, main: acc.main_character_id },
    characters: chars.map(c => ({ id: c.character_id, name: c.name, scopes: JSON.parse(c.scopes), needsLogin: !!c.needs_login })),
    data: Object.fromEntries(data.map(d => [d.kind, JSON.parse(d.data)])),
  };
}

export async function putData(db, accountId, kind, value) {
  if (!DATA_KINDS.includes(kind)) throw err(400, 'Unknown data type');
  const text = JSON.stringify(value ?? null);
  if (text.length > MAX_DATA_BYTES) throw err(413, 'Too much data');
  await db.prepare(`INSERT INTO account_data (account_id, kind, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(accountId, kind, text, Date.now()).run();
}

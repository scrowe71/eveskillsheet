export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});

export const error = (e) => json({ error: e.message || 'Something went wrong' }, e.status && e.status < 600 ? e.status : 500);

export function needDb(env) {
  if (!env.DB) throw Object.assign(new Error('Sharing is not set up yet: bind a D1 database named DB to this Pages project (see README).'), { status: 503 });
  return env.DB;
}

export function newSlug() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

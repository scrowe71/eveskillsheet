// Server-side ESI client for buildSnapshot().
const ESI = 'https://esi.evetech.net';

export function makeEsi(token, fetchImpl = fetch) {
  return async (path, { auth, method = 'GET', body } = {}) => {
    const headers = {
      Accept: 'application/json',
      'X-Compatibility-Date': '2025-09-30',
      'User-Agent': 'EveSkillsheet (https://skillsheet.crankyape.space)',
    };
    if (auth) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetchImpl(ESI + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (r.ok) return r.json();
      if (r.status >= 500 || r.status === 420 || r.status === 429) { await new Promise(res => setTimeout(res, 800 * (attempt + 1))); continue; }
      throw Object.assign(new Error(`ESI ${r.status} on ${path}`), { status: r.status });
    }
    throw Object.assign(new Error(`ESI is not responding (${path})`), { status: 502 });
  };
}

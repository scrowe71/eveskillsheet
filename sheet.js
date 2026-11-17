// Public, read-only view of a shared sheet: /s/<link>
import { renderSheet, tickCountdowns } from './shared/render.js';
import { esc, formatDate } from './shared/lib.js';

const main = document.querySelector('#main');
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

async function boot() {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(slug)) throw Object.assign(new Error('This link is not valid.'), { status: 404 });
  const [r, SK, SH] = await Promise.all([
    fetch(`/api/sheets/${encodeURIComponent(slug)}`),
    fetch('/data/skills.json').then(x => x.json()),
    fetch('/data/ships.json').then(x => x.json()),
  ]);
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? 'This sheet does not exist or is no longer shared.' : `Server error ${r.status}`), { status: r.status });
  const snap = await r.json();
  document.title = `${snap.char.name} · Skill sheet · EveSkillsheet`;
  main.innerHTML = '<div class="sheet"></div>';
  renderSheet(main.firstChild, snap, { SK, SH }, {
    publicView: true,
    actions: `<span class="verified" title="Published ${esc(formatDate(snap.publishedAt || snap.syncedAt))}">✓ Verified via EVE SSO</span>`,
  });
  setInterval(() => tickCountdowns(), 30_000);
}

boot().catch(e => {
  main.innerHTML = `<div class="empty big"><h2>${e.status === 404 ? 'Sheet not found' : 'Could not load this sheet'}</h2><p>${esc(e.message)}</p></div>`;
});

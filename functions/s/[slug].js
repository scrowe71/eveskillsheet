// /s/<slug> serves the public sheet page; sheet.js reads the slug from the address.
export async function onRequestGet({ request, env }) {
  const page = await env.ASSETS.fetch(new URL('/sheet', request.url));
  return new Response(page.body, { status: 200, headers: page.headers });
}

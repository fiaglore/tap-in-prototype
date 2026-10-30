// Two public hostnames, one Worker: the main site (events) and the Tap In for Business subdomain.
//
// With BUSINESS_HOST and MAIN_HOST set (see wrangler.jsonc):
//   business host   /                  -> the Business landing page (served in place, URL stays "/")
//                   /business/         -> redirects to /
//                   /organiser/, /play/, /e/  -> redirect to the same page on the main host
//   main host       /business/, /offices/ -> redirect to the business host
// Everything else (the API, /app/, /gate/, /i/, /signin/, /privacy/, /terms/, assets) answers on both hosts.
// The session cookie is host-only, so people sign in once on each host.
//
// Unset, or on any other host (workers.dev, localhost, tests), nothing here applies and every page answers where it is.

const lower = (v) => String(v || '').trim().toLowerCase();

const BUSINESS_PAGE = /^\/(?:business|offices)(?:\/index\.html)?\/?$/;
const EVENT_PAGE = /^\/(?:organiser|play|e)(?:\/index\.html)?\/?$/;

function redirect(host, pathname, url) {
  return new Response(null, { status: 301, headers: { Location: `https://${host}${pathname}${url.search}`, 'Cache-Control': 'public, max-age=300' } });
}

// Returns a Response to send straight back, or null to carry on as normal. `assets` is env.ASSETS.
export function routeByHost(request, env, url) {
  const biz = lower(env.BUSINESS_HOST);
  const main = lower(env.MAIN_HOST);
  if (!biz || !main || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const host = url.host.toLowerCase();
  const path = url.pathname;
  const mainHosts = [main, main.replace(/^www\./, '')];

  if (host === biz) {
    if (path === '/' || path === '/index.html') return env.ASSETS.fetch(new Request(new URL('/business/', url), request));
    if (/^\/business(?:\/index\.html)?\/?$/.test(path)) return redirect(biz, '/', url);
    if (EVENT_PAGE.test(path)) return redirect(main, path, url);
    return null;
  }
  if (mainHosts.includes(host) && BUSINESS_PAGE.test(path)) {
    return redirect(biz, path.startsWith('/offices') ? '/offices/' : '/', url);
  }
  return null;
}

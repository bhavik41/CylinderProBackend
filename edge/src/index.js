import { Hono } from 'hono';
import { jwtVerify } from 'jose';

const app = new Hono();

// The two masters endpoints are the only responses safe to cache at the edge — they
// have no auth middleware on the origin and return identical, rarely-changing global
// catalog data for every tenant (see backend/routes/masters.js).
const CACHEABLE_PATHS = new Set(['/api/masters/gas-types', '/api/masters/cylinder-sizes']);
const CACHE_TTL_SECONDS = 60;

const AUTH_PATHS = new Set(['/api/auth/signin', '/api/auth/signup']);

// Forward method/headers/body to the origin and stream its response back unchanged.
// Never transforms business responses — this Worker has no business logic of its own.
async function proxyToOrigin(c) {
  const url = new URL(c.req.raw.url);
  const originUrl = new URL(url.pathname + url.search, c.env.ORIGIN_URL);

  // Strip the incoming Host header — it's this Worker's own hostname, not the
  // origin's. Left in place, some origins (anything itself behind Cloudflare) will
  // reject the request outright since the Host won't match any zone for that IP.
  // Deleting it lets fetch() set the correct Host for originUrl automatically.
  const requestHeaders = new Headers(c.req.raw.headers);
  requestHeaders.delete('host');

  const originReq = new Request(originUrl, {
    method: c.req.raw.method,
    headers: requestHeaders,
    body: ['GET', 'HEAD'].includes(c.req.raw.method) ? undefined : c.req.raw.body,
    // Required by the Workers runtime when streaming a body through fetch().
    duplex: ['GET', 'HEAD'].includes(c.req.raw.method) ? undefined : 'half'
  });

  const originRes = await fetch(originReq);

  // fetch() transparently decompresses a gzip/br body but leaves Content-Encoding /
  // Content-Length on the Response describing the ORIGINAL compressed bytes — passing
  // that straight through makes the client try to decompress already-decompressed
  // data. Strip them; Cloudflare's edge re-compresses on the way out as needed.
  const responseHeaders = new Headers(originRes.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  return new Response(originRes.body, {
    status: originRes.status,
    statusText: originRes.statusText,
    headers: responseHeaders
  });
}

function clientKey(c) {
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

// CORS preflight: browsers never send Authorization/body on OPTIONS, and the origin's
// own `cors` middleware already generates the correct preflight response from the
// forwarded Origin header — just relay it straight through, no rate limit or auth check.
app.options('*', async (c) => proxyToOrigin(c));

// Health check stays fully public and unthrottled (mirrors server.js mounting it
// before its rate limiters) — it's what uptime monitors hit.
app.get('/api/health', async (c) => proxyToOrigin(c));

app.get('/api/masters/gas-types', async (c) => cachedProxy(c));
app.get('/api/masters/cylinder-sizes', async (c) => cachedProxy(c));

async function cachedProxy(c) {
  const cache = caches.default;
  const cacheKey = new Request(c.req.raw.url, c.req.raw);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const res = await proxyToOrigin(c);
  if (res.ok) {
    const cacheable = new Response(res.body, res);
    cacheable.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    c.executionCtx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return cacheable;
  }
  return res;
}

app.post('/api/auth/signin', async (c) => authRoute(c));
app.post('/api/auth/signup', async (c) => authRoute(c));

async function authRoute(c) {
  const { success } = await c.env.AUTH_LIMITER.limit({ key: clientKey(c) });
  if (!success) {
    return c.json({ error: 'Too many login attempts. Please try again shortly.' }, 429);
  }
  return proxyToOrigin(c);
}

// Everything else under /api/* — general rate limit, then a fast-fail JWT signature
// + expiry pre-check before proxying through. This is an optimization only: the
// origin's middleware/auth.js is still the authoritative check (it also verifies
// token_version against the live User doc for "log out all sessions", which this
// edge check has no way to know about since it never touches the database).
app.all('/api/*', async (c) => {
  const { success } = await c.env.API_LIMITER.limit({ key: clientKey(c) });
  if (!success) {
    return c.json({ error: 'Too many requests. Please slow down and try again shortly.' }, 429);
  }

  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: 'No token provided' }, 401);
  }
  try {
    await jwtVerify(token, new TextEncoder().encode(c.env.JWT_SECRET));
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  return proxyToOrigin(c);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;

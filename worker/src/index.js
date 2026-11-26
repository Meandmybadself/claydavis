import { verifyRun } from './verify.js';

const TOKEN_TTL_MS = 6 * 3600 * 1000;
const MAX_BODY = 400 * 1024;
const RUNS_PER_HOUR = 30;
const enc = new TextEncoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const hmacKey = (secret, usage) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);

async function sign(secret, text) {
  return b64(await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(text)));
}

async function readToken(secret, token) {
  const [id, iat, sig] = String(token || '').split('.');
  if (!id || !iat || !sig || !/^\d+$/.test(iat)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), unb64(sig), enc.encode(`${id}.${iat}`));
    return ok ? { id, iat: Number(iat) } : null;
  } catch {
    return null;
  }
}

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanName(raw) {
  const name = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  return name || '???';
}

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return headers;
}

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  return (await res.json()).success === true;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_big');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function top(env, limit) {
  const { results } = await env.DB
    .prepare('SELECT name, MAX(score_ms) AS score_ms FROM scores GROUP BY name ORDER BY score_ms DESC LIMIT ?')
    .bind(limit)
    .all();
  return results.map((r) => ({ name: r.name, score: r.score_ms / 1000 }));
}

async function route(request, env) {
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!env.SIGNING_SECRET) throw new HttpError(500, 'not_configured');

  if (request.method === 'GET' && url.pathname === '/api/top') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    return json({ scores: await top(env, limit) }, 200, { 'Cache-Control': 'public, max-age=10' });
  }

  // Hands out a signed, timestamped run token. The server clock bounds any score.
  if (request.method === 'POST' && url.pathname === '/api/start') {
    const body = await readJson(request).catch(() => ({}));
    if (!(await turnstileOk(env, body.cf, ip))) throw new HttpError(403, 'challenge_failed');
    const id = b64(crypto.getRandomValues(new Uint8Array(12)));
    const iat = Date.now();
    return json({ token: `${id}.${iat}.${await sign(env.SIGNING_SECRET, `${id}.${iat}`)}` });
  }

  if (request.method === 'POST' && url.pathname === '/api/finish') {
    const body = await readJson(request);
    const run = await readToken(env.SIGNING_SECRET, body.token);
    if (!run) throw new HttpError(401, 'bad_token');
    const now = Date.now();
    if (now - run.iat > TOKEN_TTL_MS) throw new HttpError(401, 'token_expired');

    const verdict = verifyRun(body.taps, now - run.iat);
    if (!verdict.ok) throw new HttpError(422, verdict.error);

    const ipHash = await sha(`${ip}|${env.SIGNING_SECRET}`);
    const recent = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM scores WHERE ip_hash = ? AND created_at > ?')
      .bind(ipHash, now - 3600 * 1000)
      .first();
    if (recent.n >= RUNS_PER_HOUR) throw new HttpError(429, 'slow_down');

    try {
      // The run id is the primary key, so a token can only ever be used once.
      await env.DB
        .prepare('INSERT INTO scores (id, name, score_ms, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
        .bind(run.id, cleanName(body.name), verdict.scoreMs, now, ipHash)
        .run();
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new HttpError(409, 'already_submitted');
      throw err;
    }
    const rank = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM scores WHERE score_ms > ?')
      .bind(verdict.scoreMs)
      .first();
    return json({ score: verdict.scoreMs / 1000, rank: rank.n + 1 });
  }

  throw new HttpError(404, 'not_found');
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
    const extra = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra });
    let res;
    try {
      res = await route(request, env);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      res = err instanceof HttpError ? json({ error: err.code }, err.status) : json({ error: 'server_error' }, 500);
    }
    for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
    return res;
  },
};

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../sim.js';
import { verifyRun } from '../worker/src/verify.js';
import worker from '../worker/src/index.js';

// A plausible human: ~9 taps/s with jitter, slowing down until breath runs out.
function humanRun(seed = 1, stopAfterMs = 40000) {
  let x = seed;
  const rand = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const sim = new Sim();
  sim.tap(0, 0);
  let t = 0;
  let side = 1;
  while (t < stopAfterMs && !sim.over) {
    const need = 3 + 8 * (1 - Math.exp(-t / 20000)) + Math.max(0, t / 1000 - 20) * 0.1;
    t += Math.round(1000 / (need * 1.15 + rand() * 1.5) + rand() * 25);
    if (sim.tap(t, side) === 'ok') side ^= 1;
  }
  return sim;
}

test('replay reproduces the live sim score', () => {
  const live = humanRun(7);
  live.advance(Infinity);
  const v = verifyRun(live.log, 10 * 60 * 1000);
  assert.ok(v.ok, v.error);
  assert.equal(v.scoreMs, live.t);
  assert.ok(v.scoreMs > 5000);
});

test('rejects bad logs and impossible claims', () => {
  const live = humanRun(3);
  live.advance(Infinity);
  assert.equal(verifyRun(live.log, 1000).error, 'too_long');            // longer than the server clock allows
  assert.equal(verifyRun([[0, 0]], 1e9).error, 'bad_log');
  assert.equal(verifyRun([[5, 0], [100, 1]], 1e9).error, 'invalid_tap'); // must start at 0
  assert.equal(verifyRun([[0, 0], [100, 0]], 1e9).error, 'invalid_tap'); // same side twice
  assert.equal(verifyRun([[0, 0], [10, 1]], 1e9).error, 'invalid_tap'); // too fast
  assert.equal(verifyRun([[0, 0], [100, 1.5]], 1e9).error, 'bad_log');
});

test('a tap log can not outlast the breath it earned', () => {
  // Only two taps then nothing: the replay must end the run, not trust a long score.
  const v = verifyRun([[0, 0], [100, 1]], 1e9);
  assert.ok(v.ok);
  assert.ok(v.scoreMs < 6000);
});

test('rejects metronome macros', () => {
  const log = [[0, 0]];
  for (let i = 1; i < 400; i++) log.push([i * 100, i % 2]);
  assert.equal(verifyRun(log, 1e9).error, 'robotic');
});

// Minimal in-memory D1 stand-in, just enough for the Worker.
function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('ip_hash')) return { n: rows.filter((r) => r.ip_hash === args[0] && r.created_at > args[1]).length };
              return { n: rows.filter((r) => r.score_ms > args[0]).length };
            },
            async all() {
              const best = new Map();
              for (const r of rows) best.set(r.name, Math.max(best.get(r.name) || 0, r.score_ms));
              return { results: [...best].map(([name, score_ms]) => ({ name, score_ms })).sort((a, b) => b.score_ms - a.score_ms).slice(0, args[0]) };
            },
            async run() {
              if (rows.some((r) => r.id === args[0])) throw new Error('UNIQUE constraint failed');
              rows.push({ id: args[0], name: args[1], score_ms: args[2], created_at: args[3], ip_hash: args[4] });
            },
          };
        },
      };
    },
  };
}

const call = (env, path, body) =>
  worker.fetch(new Request(`https://x.test${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '1.2.3.4' } } : {}), env);

test('worker: start, finish once, leaderboard', async () => {
  const env = { DB: fakeDb(), SIGNING_SECRET: 'test-secret' };
  const { token } = await (await call(env, '/api/start', {})).json();
  const live = humanRun(11, 12000);
  live.advance(Infinity);
  await new Promise((r) => setTimeout(r, 30)); // server clock must be ahead of the run? (run is simulated, so fake it below)

  // The simulated run is longer than real elapsed time, so the server must refuse it.
  let res = await call(env, '/api/finish', { token, name: 'cheat', taps: live.log });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'too_long');

  // A token from further in the past (as if the run really took that long) is accepted.
  const realNow = Date.now;
  Date.now = () => realNow() + live.t + 5000;
  try {
    res = await call(env, '/api/finish', { token, name: 'clay!!<b>', taps: live.log });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.score, live.t / 1000);
    assert.equal(out.rank, 1);

    res = await call(env, '/api/finish', { token, name: 'clay', taps: live.log });
    assert.equal(res.status, 409);                                    // token already used
    res = await call(env, '/api/finish', { token: token + 'x', name: 'a', taps: live.log });
    assert.equal(res.status, 401);                                    // forged token
  } finally {
    Date.now = realNow;
  }

  const top = await (await call(env, '/api/top')).json();
  assert.deepEqual(top.scores, [{ name: 'CLAYB', score: live.t / 1000 }]);
});

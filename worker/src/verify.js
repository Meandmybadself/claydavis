import { Sim, STEP_MS } from '../../sim.js';

const MAX_TAPS = 20000;
const MAX_MS = 3600 * 1000;

// Replays a tap log with the real game rules. The score is whatever the replay
// says, never what the client claims.
export function verifyRun(log, maxScoreMs) {
  if (!Array.isArray(log) || log.length < 2 || log.length > MAX_TAPS) return { ok: false, error: 'bad_log' };

  const sim = new Sim();
  for (const entry of log) {
    if (!Array.isArray(entry) || entry.length !== 2) return { ok: false, error: 'bad_log' };
    const [ms, side] = entry;
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS || (side !== 0 && side !== 1)) {
      return { ok: false, error: 'bad_log' };
    }
    const result = sim.tap(ms, side);
    if (result === 'over') {
      // Floating point can differ by a step between browsers, so allow a hair of slack.
      if (ms - sim.t <= 5 * STEP_MS) break;
      return { ok: false, error: 'tap_after_end' };
    }
    if (result !== 'ok') return { ok: false, error: 'invalid_tap' };
  }

  sim.advance(Infinity);
  const scoreMs = sim.t;
  if (scoreMs > maxScoreMs) return { ok: false, error: 'too_long' };

  // Humans are never perfectly even. Long, metronome-steady logs are macros.
  const gaps = [];
  for (let i = 1; i < sim.log.length; i++) gaps.push(sim.log[i][0] - sim.log[i - 1][0]);
  if (gaps.length >= 60) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (sd < 6) return { ok: false, error: 'robotic' };
  }
  return { ok: true, scoreMs };
}

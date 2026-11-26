// Game rules shared by the browser and the score-verifying Worker.
// Time advances in fixed steps so the same tap log always gives the same score.

export const STEP_MS = 10;
export const GRACE_MS = 900;      // before breath starts draining
export const START_BREATH = 0.6;
export const PER_PRESS = 0.075;   // breath gained per correct (alternating) press
export const MIN_GAP_MS = 35;     // taps closer than this are ignored
export const MAX_TAPS_PER_SEC = 20;

// Taps are worth less the longer you last, so the run gets steadily harder.
export const tapValue = (t) => Math.max(0.3, 1 / (1 + t / 40));
// Alternating presses per second needed to break even at time t (seconds).
export const requiredRate = (t) => 3 + 8 * (1 - Math.exp(-t / 20)) + Math.max(0, t - 20) * 0.1;

export class Sim {
  constructor() {
    this.t = 0;               // simulated ms
    this.breath = START_BREATH;
    this.over = false;
    this.lastSide = null;
    this.log = [];            // accepted taps as [ms, side]
  }

  advance(ms) {
    while (!this.over && this.t + STEP_MS <= ms) {
      this.t += STEP_MS;
      if (this.t > GRACE_MS) {
        this.breath -= requiredRate(this.t / 1000) * PER_PRESS * (STEP_MS / 1000);
      }
      if (this.breath <= 0) {
        this.breath = 0;
        this.over = true;
      }
    }
  }

  // The first tap must be at 0 and starts the run. Returns 'ok' or why it was ignored.
  tap(ms, side) {
    if (this.over) return 'over';
    if (this.log.length === 0) {
      if (ms !== 0) return 'bad';
      this.lastSide = side;
      this.log.push([0, side]);
      return 'ok';
    }
    const last = this.log[this.log.length - 1][0];
    if (ms - last < MIN_GAP_MS) return 'fast';
    if (side === this.lastSide) return 'same';
    // Count taps in the trailing second, including this one.
    let n = 1;
    for (let i = this.log.length - 1; i >= 0 && ms - this.log[i][0] < 1000; i--) n++;
    if (n > MAX_TAPS_PER_SEC) return 'fast';
    this.advance(ms);
    if (this.over) return 'over';
    this.lastSide = side;
    this.breath = Math.min(1, this.breath + PER_PRESS * tapValue(ms / 1000));
    this.log.push([ms, side]);
    return 'ok';
  }
}

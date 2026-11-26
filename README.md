# Clay Davis

Alternate two buttons to keep Senator Clay Davis saying "shiiiiiiiiiiit" as long as you can.

- **Keyboard:** `←` / `→`, `A` / `B`, or `Z` / `X`
- **Touch:** the on-screen A and B buttons
- **Challenge links:** `?t=23.45` asks the player to beat 23.45 seconds

## Run locally

Static files, no build step. It needs a web server (audio is loaded with `fetch`):

    python3 -m http.server

## How it works

- `frames/` holds 74 stills at 29.97fps, in sync with `sounds/shit.mp3`.
- The middle of the vowel is crossfaded and looped; the real ending plays when you run out of breath.
- Difficulty is `requiredRate()` and the tuning constants at the top of `game.js`.
- Files are cached for a long time. After changing `style.css` or `game.js`, bump its `?v=` number in `index.html` (`sim.js` is imported by `game.js`).
- Best score is saved in `localStorage`.

## Leaderboard (Cloudflare Worker + D1)

Scores are kept server side in `worker/`. The browser never sends a score, only the log of its taps.
The Worker replays that log with the same rules (`sim.js`) and computes the score itself.

- `POST /api/start` returns an HMAC-signed run token carrying the server's start time.
- `POST /api/finish` replays the taps, rejects runs longer than the server clock allows, rejects impossible
  or metronome-perfect tap logs, and stores the score. A token works once (its id is the primary key).
- `GET /api/top` returns the top scores (best per set of 3-letter initials), cached for 10 seconds.
- Optional Cloudflare Turnstile on `/api/start`, plus a per-IP hourly cap on stored runs.

Setup (from `worker/`):

    npm install
    npx wrangler d1 create claydavis              # paste the database_id into wrangler.toml
    npx wrangler d1 execute claydavis --remote --file=schema.sql
    npx wrangler secret put SIGNING_SECRET        # any long random string
    npx wrangler deploy

The route in `wrangler.toml` sends `claydavis.meandmybadself.com/api/*` to the Worker, so the site's DNS record
must be proxied (orange cloud). To use Turnstile, create a widget, `wrangler secret put TURNSTILE_SECRET`, and set
`TURNSTILE_SITE_KEY` at the top of `game.js`. Local dev: put `SIGNING_SECRET=dev` in `worker/.dev.vars`,
run `npx wrangler d1 execute claydavis --local --file=schema.sql`, then `npx wrangler dev`.
Tests: `node --test test/`.

Limits: the game runs on the player's device, so a human-looking bot that sends a valid, plausibly jittered
tap log can still post a score. Turnstile, the plausibility checks and the rate limits make that costly, not impossible.

Unofficial fan project. Not affiliated with HBO. *The Wire* footage and audio belong to their owners.

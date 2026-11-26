# Clay Davis

Alternate two buttons to keep Senator Clay Davis saying "shiiiiiiiiiiit" as long as you can.

- **Keyboard:** `←` / `→`, `A` / `L`, or `Z` / `X`
- **Touch:** the on-screen A and B buttons
- **Challenge links:** `?t=23.45` asks the player to beat 23.45 seconds

## Run locally

Static files, no build step. It needs a web server (audio is loaded with `fetch`):

    python3 -m http.server

## How it works

- `frames/` holds 74 stills at 29.97fps, in sync with `sounds/shit.mp3`.
- The middle of the vowel is crossfaded and looped; the real ending plays when you run out of breath.
- Difficulty is `requiredRate()` and the tuning constants at the top of `game.js`.
- Best score is saved in `localStorage`.

Unofficial fan project. Not affiliated with HBO. *The Wire* footage and audio belong to their owners.

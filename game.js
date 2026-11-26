import { Sim } from './sim.js';

(() => {
  'use strict';

  // The 74 stills line up with the audio at NTSC frame rate.
  const FRAME_COUNT = 74;
  const FPS = 30000 / 1001;

  // Audio map, in seconds: "shhh" intro, steady "iiii" that loops, then the ending.
  const LOOP_START = 0.98;
  const LOOP_END = 1.78;
  const CROSSFADE = 0.12;
  const TAIL_START = 1.95;

  // Leaderboard API (the Cloudflare Worker in worker/). Leave API empty to turn it off.
  const API = '/api';
  const TURNSTILE_SITE_KEY = '0x4AAAAAAGU5AcFx9f_jk6C3';   // public; leave empty to turn the bot check off
  // The widget only allows the live hostname, so local dev runs without it.
  const CHALLENGE = location.hostname === 'claydavis.meandmybadself.com' ? TURNSTILE_SITE_KEY : '';

  // Tuning (the game rules themselves live in sim.js so the server can replay runs)
  const AUDIO_LEAD = 0.15;    // seconds between the first tap and the sound starting
  const LOCKOUT_MS = 1200;    // stops leftover mashing from skipping the results

  // Lines in Clay's voice that rotate while you play. Edit freely.
  const PHRASES = [
    'SHEEEEEIT.',
    'I AIN’T STOLE NOTHIN’!',
    'THAT’S A LIE, AND YOU KNOW IT.',
    'WHY YOU GOT TO BE LIKE THAT?',
    'JUST A POOR COUNTRY LAWYER.',
    'I’M A PUBLIC SERVANT!',
    'DON’T YOU “SHIIIT” ME.',
    'SHEEEEE-IT, THEY CAN’T PROVE NOTHIN’.',
  ];
  const PHRASE_SECONDS = 2.5;
  const phraseAt = (t) => PHRASES[Math.floor(t / PHRASE_SECONDS) % PHRASES.length];

  const KEYS = { ArrowLeft: 0, KeyA: 0, KeyZ: 0, ArrowRight: 1, KeyL: 1, KeyX: 1 };

  const VERDICTS = [
    [0, 'That was barely a "shoot."'],
    [5, 'Corner boy lungs.'],
    [10, 'Solid. The ward boss nods.'],
    [20, 'City Council material.'],
    [30, 'State Senator status!'],
    [45, 'Federal-indictment-level shiiit.'],
    [60, 'LEGENDARY. Sheeeee-it.'],
  ];

  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const ctx = canvas.getContext('2d');
  const pads = [...document.querySelectorAll('.pad')];

  let state = 'loading';
  let startedAt = 0;
  let sim = null;
  let forfeit = false;
  let runToken = null;
  let runId = 0;
  let elapsed = 0;
  let breath = 0;
  let lastSide = null;
  let unlockAt = 0;
  let lastFrame = -1;
  let animation = 0;
  let best = readBest();
  let shareData = null;
  const frames = [];

  function readBest() {
    try { return Number(localStorage.getItem('shiiit-best')) || 0; } catch { return 0; }
  }
  function writeBest(v) {
    try { localStorage.setItem('shiiit-best', String(v)); } catch { /* private mode */ }
  }

  const challenge = (() => {
    const v = Number(new URLSearchParams(location.search).get('t'));
    return Number.isFinite(v) && v > 0 && v < 1000 ? v : 0;
  })();

  /* ---------- audio ---------- */

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audio = new AudioCtx();
  let sound = null;
  let loopEnd = LOOP_END;
  let voice = null;

  // Bake a crossfade into the buffer so the "iiii" loops without a click.
  function makeSeamless(buffer) {
    const rate = buffer.sampleRate;
    const a = Math.round(LOOP_START * rate);
    const n = Math.round(CROSSFADE * rate);
    const nominal = Math.round(LOOP_END * rate);
    const search = Math.round(0.03 * rate);
    const ref = buffer.getChannelData(0);

    // Nudge the loop end so its vocal pulses line up with the loop start.
    let b = nominal;
    let bestScore = -Infinity;
    for (let end = nominal - search; end <= nominal + search; end += 2) {
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < n; i += 4) {
        const s = ref[end - n + i];
        dot += s * ref[a - n + i];
        energy += s * s;
      }
      const score = dot / Math.sqrt(energy || 1);
      if (score > bestScore) { bestScore = score; b = end; }
    }

    const out = audio.createBuffer(buffer.numberOfChannels, buffer.length, rate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      dst.set(src);
      for (let i = 0; i < n; i++) {
        const k = i / n;
        dst[b - n + i] = src[b - n + i] * (1 - k) + src[a - n + i] * k;
      }
    }
    loopEnd = b / rate;
    return { looped: out, original: buffer };
  }

  function play(buffer, offset, loop, fadeIn = 0, delay = 0) {
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    if (loop) {
      source.loop = true;
      source.loopStart = LOOP_START;
      source.loopEnd = loopEnd;
    }
    if (fadeIn) {
      gain.gain.setValueAtTime(0, audio.currentTime);
      gain.gain.linearRampToValueAtTime(1, audio.currentTime + fadeIn);
    }
    source.connect(gain).connect(audio.destination);
    source.start(audio.currentTime + delay, offset);
    return { source, gain };
  }

  // iOS Safari wouldn't play the natively looped source, so chain plain one-shot
  // segments instead (the same kind of playback that works for the ending).
  let loopRate = 1;
  function playLoop(delay) {
    const gain = audio.createGain();
    gain.connect(audio.destination);
    const v = { gain, sources: [], next: audio.currentTime + delay, first: true };
    v.schedule = () => {
      while (v.next < audio.currentTime + 0.4) {
        const offset = v.first ? 0 : LOOP_START;
        const length = loopEnd - offset;
        const src = audio.createBufferSource();
        src.buffer = sound.looped;
        src.playbackRate.value = loopRate;
        src.connect(gain);
        src.start(v.next, offset, length);
        src.onended = () => { v.sources = v.sources.filter((x) => x !== src); };
        v.sources.push(src);
        v.next += length / loopRate;
        v.first = false;
      }
    };
    v.schedule();
    return v;
  }

  function stop(v, fade = 0.08) {
    if (!v) return;
    const now = audio.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fade);
    for (const s of v.sources || [v.source]) { try { s.stop(now + fade); } catch { /* not started */ } }
  }

  /* ---------- drawing ---------- */

  function draw(i) {
    i = Math.max(0, Math.min(FRAME_COUNT - 1, i));
    if (i === lastFrame || !frames[i]) return;
    lastFrame = i;
    ctx.drawImage(frames[i], 0, 0, canvas.width, canvas.height);
  }

  // Play forward through the intro, then ping-pong over the loop so there's no jump cut.
  function frameAt(t) {
    const first = Math.round(LOOP_START * FPS);
    const last = Math.round(LOOP_END * FPS);
    const f = Math.floor(t * FPS);
    if (f <= last) return f;
    const span = last - first;
    const p = (f - last) % (span * 2);
    return p <= span ? last - p : first + (p - span);
  }

  function word(t, done) {
    return 'SH' + 'I'.repeat(1 + Math.floor(t * 3)) + (done ? 'T' : '');
  }

  function render(done = false) {
    $('time').textContent = elapsed.toFixed(2);
    $('letters').textContent = word(elapsed, done);
    const box = $('word');
    box.classList.toggle('long', $('letters').offsetWidth > box.clientWidth);
    const fill = $('fill');
    fill.style.transform = `scaleX(${breath})`;
    fill.className = breath < 0.25 ? 'low' : breath < 0.5 ? 'mid' : '';
  }

  function setPrompt(text, warn = false) {
    const el = $('prompt');
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  function highlightNext() {
    pads.forEach((p, i) => p.classList.toggle('next', state === 'playing' && i !== lastSide));
  }

  /* ---------- game flow ---------- */

  function ready() {
    state = 'ready';
    cancelAnimationFrame(animation);
    stop(voice);
    voice = null;
    elapsed = 0;
    breath = 0;
    lastSide = null;
    sim = null;
    forfeit = false;
    fetchToken();
    $('results').hidden = true;
    $('best').textContent = best.toFixed(2);
    highlightNext();
    render();
    draw(0);
    setPrompt(challenge
      ? `BEAT ${challenge.toFixed(2)}s!\nALTERNATE A + B`
      : 'ALTERNATE A + B\nTO START');
  }

  function start(side) {
    // Mobile browsers keep the audio clock frozen until resume() settles, and a
    // sound started before then loses its opening. Wait for it, then begin.
    state = 'starting';
    // iOS only unlocks audio if something is played synchronously inside the tap.
    const unlock = audio.createBufferSource();
    unlock.buffer = audio.createBuffer(1, 1, 22050);
    unlock.connect(audio.destination);
    unlock.start(0);
    const begin = () => {
      if (state !== 'starting') return;
      state = 'playing';
      // A short lead lets phone audio hardware wake up so the opening isn't clipped.
      loopRate = 1;
      voice = playLoop(AUDIO_LEAD);
      startedAt = performance.now() + AUDIO_LEAD * 1000;
      sim = new Sim();
      sim.tap(0, side);
      breath = sim.breath;
      lastSide = side;
      highlightNext();
      setPrompt(phraseAt(0));
      animation = requestAnimationFrame(tick);
    };
    if (audio.state === 'running') return begin();
    // Browsers only allow audio to start from a user gesture; this is one.
    // resume() can stay pending forever on some mobile browsers, so don't wait long.
    audio.resume().then(begin, begin);
    setTimeout(begin, 250);
  }

  function tick() {
    if (state !== 'playing') return;
    const ms = Math.max(0, Math.floor(performance.now() - startedAt));
    sim.advance(ms);
    breath = sim.breath;
    if (sim.over) {
      elapsed = sim.t / 1000;
      return finish();
    }
    elapsed = ms / 1000;

    // His voice sags as he runs out of breath.
    if (elapsed > LOOP_END) {
      loopRate = 0.93 + 0.1 * breath;
    }
    voice.schedule();

    draw(frameAt(elapsed));
    render();
    if (breath < 0.25) setPrompt('FASTER!!', true);
    else setPrompt(challenge && elapsed > challenge ? 'YOU BEAT IT!' : phraseAt(elapsed));
    animation = requestAnimationFrame(tick);
  }

  function finish() {
    state = 'over';
    cancelAnimationFrame(animation);
    breath = 0;
    unlockAt = performance.now() + LOCKOUT_MS;
    highlightNext();
    render(true);
    setPrompt('');

    stop(voice);
    voice = play(sound.original, TAIL_START, false, 0.08);

    const record = elapsed > best;
    if (record) {
      best = elapsed;
      writeBest(best.toFixed(2));
      $('best').textContent = best.toFixed(2);
    }

    prepareResults(Number(elapsed.toFixed(2)), record);

    // Play out the last stills along with the ending.
    const from = Math.round(TAIL_START * FPS);
    const began = performance.now();
    const outro = () => {
      const f = from + Math.floor(((performance.now() - began) / 1000) * FPS);
      draw(f);
      if (f < FRAME_COUNT - 1 || performance.now() < unlockAt) {
        animation = requestAnimationFrame(outro);
      } else {
        showResults();
      }
    };
    animation = requestAnimationFrame(outro);
  }

  /* ---------- results + sharing ---------- */

  function prepareResults(score, record) {
    const seconds = score.toFixed(2);
    const verdict = VERDICTS.filter(([min]) => score >= min).pop()[1];

    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('t', seconds);
    const shout = 'SH' + 'I'.repeat(Math.min(40, 3 + Math.round(score))) + 'T.';
    const text = `${shout} I kept Clay Davis going for ${seconds} seconds. Beat that.`;
    shareData = { text, url: url.href, file: null };

    $('final').textContent = `${seconds}s`;
    $('verdict').textContent = verdict;
    let note = record ? 'NEW PERSONAL BEST!' : `Your best: ${best.toFixed(2)}s`;
    if (challenge) {
      note += score > challenge
        ? ` You beat the ${challenge.toFixed(2)}s challenge.`
        : ` ${(challenge - score).toFixed(2)}s short of the challenge.`;
    }
    $('note').textContent = note;

    const enc = encodeURIComponent;
    $('toX').href = `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url.href)}`;
    $('toBsky').href = `https://bsky.app/intent/compose?text=${enc(`${text} ${url.href}`)}`;
    $('toFb').href = `https://www.facebook.com/sharer/sharer.php?u=${enc(url.href)}`;
    $('copy').textContent = 'COPY';

    makeCard(seconds);
    prepareBoard();
  }

  // Build the image up front: Safari only allows share() directly from a tap.
  function makeCard(seconds) {
    const card = document.createElement('canvas');
    card.width = 1200;
    card.height = 630;
    const c = card.getContext('2d');
    const still = frames[40];
    const scale = Math.max(card.width / still.width, card.height / still.height);
    c.drawImage(still, (card.width - still.width * scale) / 2, 0, still.width * scale, still.height * scale);

    const shade = c.createLinearGradient(0, 300, 0, 630);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,.95)');
    c.fillStyle = shade;
    c.fillRect(0, 300, 1200, 330);

    c.textAlign = 'center';
    c.fillStyle = '#f2b631';
    c.font = '60px "Press Start 2P", monospace';
    c.fillText('SHIIIIIIIIIIT', 600, 485);
    c.fillStyle = '#f4ead8';
    c.font = '34px "Press Start 2P", monospace';
    c.fillText(`I held it for ${seconds}s`, 600, 560);
    c.font = '18px "Press Start 2P", monospace';
    c.fillText('CLAY DAVIS', 600, 605);

    const dataUrl = card.toDataURL('image/jpeg', 0.88);
    $('card').src = dataUrl;
    $('save').href = dataUrl;

    const current = shareData;
    card.toBlob((blob) => {
      if (blob) current.file = new File([blob], 'sheeeit.jpg', { type: 'image/jpeg' });
    }, 'image/jpeg', 0.88);
  }

  /* ---------- leaderboard ---------- */

  let submission = null;

  async function fetchToken() {
    const id = ++runId;
    runToken = null;
    if (!API) return;
    try {
      const cf = CHALLENGE ? await takeChallenge() : undefined;
      if (id !== runId) return;
      const res = await fetch(`${API}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cf }),
      });
      if (!res.ok) return;
      const { token } = await res.json();
      if (id === runId) runToken = token;
    } catch { /* the leaderboard is optional */ }
  }

  // Cloudflare Turnstile, only shown to the player if it needs a click. It is
  // solved ahead of time so the server's run clock can start with the run.
  let challengeWidget = null;
  let challengeToken = null;
  let challengeWaiter = null;

  function loadChallenge() {
    const render = () => {
      challengeWidget = window.turnstile.render('#turnstile', {
        sitekey: CHALLENGE,
        action: 'turnstile-spin-v2',
        appearance: 'interaction-only',
        callback: (token) => {
          challengeToken = token;
          deliverChallenge();
        },
        'expired-callback': () => { challengeToken = null; },
      });
    };
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = render;
    document.head.append(script);
  }

  // Each token works once: hand it over, then start solving the next one.
  function deliverChallenge() {
    if (!challengeToken || !challengeWaiter) return;
    const token = challengeToken;
    const resolve = challengeWaiter;
    challengeToken = challengeWaiter = null;
    resolve(token);
    window.turnstile.reset(challengeWidget);
  }

  // Only the newest run waits for a token.
  function takeChallenge() {
    return new Promise((resolve) => {
      challengeWaiter = resolve;
      deliverChallenge();
    });
  }

  function drawBoard(scores, mine) {
    const list = $('scores');
    list.replaceChildren(...scores.map((s, i) => {
      const li = document.createElement('li');
      const you = mine && s.name === mine.name && Math.abs(s.score - mine.score) < 0.005;
      if (you) li.className = 'you';
      li.textContent = `${String(i + 1).padStart(2, ' ')} ${s.name.padEnd(3, ' ')} ${s.score.toFixed(2)}s`;
      return li;
    }));
    $('board').hidden = false;
  }

  async function loadBoard(mine) {
    if (!API) return;
    try {
      const res = await fetch(`${API}/top?limit=10`);
      if (res.ok) drawBoard((await res.json()).scores, mine);
    } catch { /* offline */ }
  }

  function prepareBoard() {
    $('board').hidden = true;
    $('postform').hidden = true;
    $('posted').textContent = '';
    submission = null;
    if (!API) return;
    if (runToken && !forfeit && sim && sim.log.length > 1) {
      submission = { token: runToken, taps: sim.log };
      runToken = null;
      $('name').value = readName();
      $('post').disabled = false;
      $('postform').hidden = false;
    }
    loadBoard();
  }

  const initials = (raw) => raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  $('name').addEventListener('input', (e) => { e.target.value = initials(e.target.value); });

  function readName() {
    try { return initials(localStorage.getItem('shiiit-name') || ''); } catch { return ''; }
  }

  const WHY = {
    too_long: 'That run didn’t check out.',
    robotic: 'Too perfect to be human.',
    slow_down: 'Easy, too many runs. Try later.',
    token_expired: 'This run timed out. Play again.',
    already_submitted: 'Already posted.',
    challenge_failed: 'Bot check failed.',
  };

  $('post').addEventListener('click', async () => {
    if (!submission) return;
    const name = initials($('name').value);
    try { localStorage.setItem('shiiit-name', name); } catch { /* private mode */ }
    $('post').disabled = true;
    $('posted').textContent = 'POSTING…';
    try {
      const res = await fetch(`${API}/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submission, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      submission = null;
      $('postform').hidden = true;
      $('posted').textContent = `POSTED! RANK #${data.rank}`;
      loadBoard({ name: name || '???', score: data.score });
    } catch (err) {
      $('posted').textContent = WHY[err.message] || 'Couldn’t post. Try again.';
      $('post').disabled = !submission || err.message === 'already_submitted';
    }
  });

  function showResults() {
    $('results').hidden = false;
    $('again').focus({ preventScroll: true });
    $('results').scrollTop = 0;
  }

  async function copyLink() {
    const message = `${shareData.text} ${shareData.url}`;
    try {
      await navigator.clipboard.writeText(message);
      $('copy').textContent = 'COPIED!';
    } catch {
      window.prompt('Copy your score:', message);
    }
  }

  $('share').addEventListener('click', async () => {
    if (!navigator.share) return copyLink();
    const { text, url, file } = shareData;
    const withFile = { files: [file], text: `${text} ${url}` };
    try {
      await navigator.share(file && navigator.canShare?.(withFile) ? withFile : { text, url });
    } catch (err) {
      if (err.name !== 'AbortError') copyLink();
    }
  });
  $('copy').addEventListener('click', copyLink);
  $('again').addEventListener('click', ready);

  /* ---------- input ---------- */

  function press(side) {
    if (state === 'ready') return start(side);
    if (state !== 'playing') return;
    const ms = Math.floor(performance.now() - startedAt);
    if (ms <= 0) return; // still inside the audio lead-in
    const result = sim.tap(ms, side);
    if (result === 'same') {
      const pad = pads[side];
      pad.classList.remove('wrong');
      void pad.offsetWidth; // restart the animation
      pad.classList.add('wrong');
      return;
    }
    if (result !== 'ok') return;
    lastSide = side;
    breath = sim.breath;
    highlightNext();
  }

  pads.forEach((pad) => {
    const side = Number(pad.dataset.side);
    // pointerdown (not click) so two thumbs register independently with no delay.
    pad.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      pad.classList.add('down');
      press(side);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      pad.addEventListener(type, () => pad.classList.remove('down'));
    }
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const side = KEYS[e.code];
    if (side === undefined) return;
    e.preventDefault();
    if (e.repeat) return; // holding a key down doesn't count
    pads[side].classList.add('down');
    press(side);
  });
  window.addEventListener('keyup', (e) => {
    const side = KEYS[e.code];
    if (side !== undefined) pads[side].classList.remove('down');
  });

  // Animation frames pause in background tabs, so end the run there.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'playing') {
      elapsed = (performance.now() - startedAt) / 1000;
      forfeit = true; // the replay wouldn't match, so this run can't be posted
      finish();
    }
  });

  /* ---------- loading ---------- */

  function loadFrame(i) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { frames[i] = img; if (i === 0) draw(0); resolve(); };
      img.onerror = reject;
      img.src = `frames/${String(i).padStart(2, '0')}.jpg`;
    });
  }

  async function loadSound() {
    // Lets iPhones play sound even with the ring/silent switch on silent.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const res = await fetch('sounds/shit.mp3');
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const data = await res.arrayBuffer();
    const buffer = await new Promise((ok, fail) => audio.decodeAudioData(data, ok, fail));
    sound = makeSeamless(buffer);
  }

  let loaded = 0;
  const progress = (p) => p.then(() => {
    loaded++;
    setPrompt(`LOADING… ${Math.round((loaded / (FRAME_COUNT + 1)) * 100)}%`);
  });

  if (API && CHALLENGE) loadChallenge();

  Promise.all([
    progress(loadSound()),
    ...Array.from({ length: FRAME_COUNT }, (_, i) => progress(loadFrame(i))),
  ]).then(ready).catch((err) => {
    console.error(err);
    setPrompt('COULDN’T LOAD.\nPLEASE REFRESH.', true);
  });
})();

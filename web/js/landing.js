// Signed-out landing: play the admin's latest briefing (or the one shipped with the site), show its headlines and voices, then sign in.
import { SECTIONS, api, h, icon, toast } from './api.js';
import { SUPABASE_URL } from '../config.js';

// Written by the worker after each admin briefing; refetched at most hourly.
const DEMO_URL = `${SUPABASE_URL}/storage/v1/object/public/briefings/showcase/sample.json`;

const MAILBOXES = [
  [/@(gmail|googlemail)\.com$/, 'Gmail', 'https://mail.google.com/mail/u/0/#search/%22sign-in+link%22'],
  [/@(outlook|hotmail|live|msn)\./, 'Outlook', 'https://outlook.live.com/mail/0/'],
  [/@(yahoo|ymail)\./, 'Yahoo Mail', 'https://mail.yahoo.com/'],
  [/@(icloud|me|mac)\.com$/, 'iCloud Mail', 'https://www.icloud.com/mail'],
];

const $ = (id) => document.getElementById(id);

/** 0:07, 1:23 — the same clock the app shows. */
const fmtTime = (s) => {
  const n = Math.max(0, Math.round(s || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

export class Landing {
  constructor({ onSignedIn }) {
    this.onSignedIn = onSignedIn;
    this.audio = $('sampleAudio');
    this.voiceAudio = new Audio();
    this.email = '';
    this.clips = [];
    this.segments = [];
    this.stories = [];
    this.current = null;
    this.bindPlayer();
    this.bindSignIn();
  }

  async show() {
    const hr = new Date().getHours();
    $('lgGreeting').textContent = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    this.checkLinkError();
    let data = {};
    for (const url of [`${DEMO_URL}?h=${Math.floor(Date.now() / 3600000)}`, '/sample/sample.json']) {
      try {
        const res = await fetch(url);
        if (res.ok) data = await res.json();
      } catch { /* not published yet or offline: try the next one */ }
      // A playable sample is either the day's clips or, on older payloads, one file.
      if (data.briefing?.clips?.length || data.briefing?.audio_url) break;
    }
    this.render(data);
  }

  // ------------------------------------------------------------------ sample
  /**
   * The sample is the app's own briefing shape — a list of clips with one running
   * timeline — so the landing plays it with the app's player card, its segmented
   * bar and its story rows. Older showcase payloads carry a single file instead,
   * so whatever we get is normalised into clips first.
   */
  render({ briefing }) {
    const b = briefing || {};
    this.briefing = b;
    this.stories = b.stories || [];
    this.chapters = (b.chapters || []).filter((c) => c.kind !== 'section');
    this.clips = this.normaliseClips(b);
    this.duration = b.duration || this.clips.reduce((n, c) => n + c.duration, 0);
    this.index = 0;
    this.current = null;

    this.paintHero();
    this.buildSegments();
    this.paintStories();
    this.tick();
  }

  /** Clips with absolute [start, end] positions, whether the payload had clips or one file. */
  normaliseClips(b) {
    const clips = (b.clips || []).filter((c) => c?.url).map((c) => ({ ...c }));
    if (!clips.length) {
      if (!b.audio_url) return [];
      return [{ url: b.audio_url, start: 0, end: b.duration || 0, duration: b.duration || 0 }];
    }
    let t = 0;
    for (const c of clips) {
      c.duration = c.duration || Math.max(0, (c.end || 0) - (c.start || 0));
      c.start = t;
      c.end = t + c.duration;
      t = c.end;
    }
    return clips;
  }

  paintHero() {
    const ready = this.clips.length > 0;
    const mins = Math.max(1, Math.round(this.duration / 60));
    const today = this.briefing.date === new Date().toLocaleDateString('en-CA');
    $('sampleLabel').textContent = ready
      ? `${today ? "Today's briefing" : 'A recent briefing'} · ${mins} min`
      : 'Sample briefing';
    $('sampleTitle').textContent = ready
      ? (this.stories[0]?.headline || 'Tap play to hear the briefing')
      : "The sample isn't available right now. Try again in a moment.";
    $('sampleDur').textContent = `-${fmtTime(this.duration)}`;
    for (const id of ['samplePlay', 'samplePrev', 'sampleNext']) $(id).disabled = !ready;
    const cover = this.stories.find((s) => s.image)?.image;
    if (cover) { $('sampleCover').src = cover; $('sampleCover').classList.remove('hidden'); }
  }

  /** One segment per story, sized by how long it runs — the app's bar, built from the chapters. */
  buildSegments() {
    const seg = $('sampleSegs');
    seg.querySelectorAll('.seg').forEach((n) => n.remove());
    this.segments = this.chapters.filter((c) => c.kind === 'story');
    for (const c of this.segments) {
      seg.insertBefore(h('div', { class: 'seg', style: `flex-grow:${Math.max(1, c.end - c.start)}` }, h('i')), $('sampleThumb'));
    }
    seg.classList.toggle('hidden', !this.segments.length);
  }

  /** The stories in the sample, grouped by section the way the app lists them. */
  paintStories() {
    $('sampleSection').hidden = !this.stories.length;
    const groups = [];
    for (const s of this.stories) {
      const last = groups[groups.length - 1];
      if (last && last.section === s.section) last.items.push(s);
      else groups.push({ section: s.section, items: [s] });
    }
    $('sampleStories').replaceChildren(...groups.map((g) => h('div', {},
      h('div', { class: 'section-head' },
        h('span', { class: 'overline' }, SECTIONS[g.section]?.title || g.section),
        h('span', { class: 'dot' })),
      h('div', { class: 'glass-group' }, ...g.items.map((s) => this.storyRow(s))))));
  }

  storyRow(s) {
    const dot = h('button', { class: 'play-dot', type: 'button', 'aria-label': `Play from: ${s.headline}` },
      icon('play', 'i-play'), icon('pause', 'i-pause'));
    const row = h('article', { class: 'story-row', dataset: { id: s.id } },
      h('div', { class: 'story-main' },
        h('div', { class: 'play-col' }, dot, h('span', { class: 't' }, fmtTime(s.start || 0))),
        h('div', { class: 'story-text' },
          h('h3', {}, s.headline),
          h('p', { class: 'story-meta' }, s.source || 'The Guardian')),
        s.image ? h('img', {
          class: 'story-thumb', src: s.image, alt: '', loading: 'lazy', decoding: 'async',
          referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove(),
        }) : null));
    const play = () => this.seekTo(s.start || 0, true);
    dot.addEventListener('click', (e) => { e.stopPropagation(); play(); });
    row.querySelector('.story-main').addEventListener('click', play);
    return row;
  }

  /* ----------------------------------------------------------------- player */
  get clip() { return this.clips[this.index]; }
  get playing() { return !this.audio.paused && !this.audio.ended; }
  /** Seconds into the whole sample, across clips — the app's timeline model. */
  get position() { return (this.clip?.start || 0) + (this.audio.currentTime || 0); }
  get total() { return this.clips.length ? this.clips[this.clips.length - 1].end : 0; }

  bindPlayer() {
    const a = this.audio;
    const seg = $('sampleSegs');
    $('samplePlay').addEventListener('click', () => this.toggle());
    $('samplePrev').addEventListener('click', () => this.step(-1));
    $('sampleNext').addEventListener('click', () => this.step(1));

    // Tap or drag the segmented bar to seek, exactly as in the app.
    const seekToPointer = (e) => {
      const r = seg.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.seekTo(f * (this.duration || 0), this.playing);
      seg.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    };
    let dragging = false;
    seg.addEventListener('pointerdown', (e) => { dragging = true; seg.setPointerCapture(e.pointerId); seekToPointer(e); });
    seg.addEventListener('pointermove', (e) => { if (dragging) seekToPointer(e); });
    seg.addEventListener('pointerup', () => { dragging = false; });
    seg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      this.step(e.key === 'ArrowRight' ? 1 : -1);
      e.preventDefault();
    });

    a.addEventListener('timeupdate', () => this.tick());
    a.addEventListener('play', () => this.setPlaying(true));
    a.addEventListener('pause', () => this.setPlaying(false));
    a.addEventListener('ended', () => {
      if (this.index + 1 < this.clips.length) this.loadClip(this.index + 1, { autoplay: true });
      else this.finish();
    });
    $('sampleCover').addEventListener('error', () => $('sampleCover').classList.add('hidden'));
  }

  /** Make clip `i` the source, seeking into it and keeping playback going if it was playing. */
  loadClip(i, { seek = 0, autoplay = null } = {}) {
    const clip = this.clips[i];
    if (!clip) return;
    this.index = i;
    const a = this.audio;
    const play = autoplay === null ? this.playing : autoplay;
    if (a.dataset.clip !== String(i)) { a.dataset.clip = String(i); a.src = clip.url; }
    const apply = () => { try { a.currentTime = seek; } catch { /* not seekable yet */ } };
    if (a.readyState >= 1) apply();
    else a.addEventListener('loadedmetadata', apply, { once: true });
    if (play) a.play().catch(() => {});
    this.tick();
  }

  toggle() {
    if (!this.clips.length) return;
    this.voiceAudio.pause();
    if (this.playing) { this.audio.pause(); return; }
    if (!this.audio.src) this.loadClip(this.index, { autoplay: true });
    else this.audio.play().catch(() => {});
  }

  /** Jump anywhere on the sample's timeline, landing on whichever clip covers it. */
  seekTo(seconds, play = this.playing) {
    if (!this.clips.length) return;
    const t = Math.max(0, Math.min(seconds, this.total));
    let i = 0;
    for (let n = 0; n < this.clips.length; n += 1) if (t >= this.clips[n].start - 0.02) i = n;
    if (t >= this.total - 0.05) { this.loadClip(this.clips.length - 1, { seek: this.clips[this.clips.length - 1].duration, autoplay: false }); return; }
    this.loadClip(i, { seek: t - this.clips[i].start, autoplay: play });
  }

  /** Previous or next story, skipping the greeting and section intros. */
  step(dir) {
    const stories = this.segments || [];
    if (!stories.length) return;
    const t = this.position;
    const hit = dir > 0
      ? stories.find((c) => c.start > t + 0.4)
      : [...stories].reverse().find((c) => c.start < t - 1.2) || stories[0];
    if (hit) this.seekTo(hit.start, this.playing);
  }

  setPlaying(on) {
    $('sampleHero').classList.toggle('playing-now', on);
    $('samplePlay').setAttribute('aria-label', on ? 'Pause the briefing' : 'Play the briefing');
    this.highlight(this.current);
  }

  /** Walk the timeline: segment fills, thumb, clock, the story playing, its card. */
  tick() {
    if (!this.clips.length) return;
    const t = this.position;
    const dur = this.duration || this.total || 0;
    const segs = $('sampleSegs').querySelectorAll('.seg');
    (this.segments || []).forEach((s, i) => {
      const f = s.end > s.start ? Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start))) : 0;
      const fill = segs[i]?.firstChild;
      if (fill) fill.style.width = `${f * 100}%`;
    });
    const frac = dur ? Math.min(1, t / dur) : 0;
    $('sampleThumb').style.left = `${frac * 100}%`;
    $('sampleSegs').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    $('sampleCur').textContent = fmtTime(t);
    $('sampleDur').textContent = `-${fmtTime(Math.max(0, dur - t))}`;

    const ch = [...(this.segments || [])].reverse().find((c) => t >= c.start);
    const story = this.stories.find((s) => s.id === ch?.id);
    if (story) {
      $('sampleTitle').textContent = story.headline;
      const cover = $('sampleCover');
      if (story.image && cover.dataset.src !== story.image) {
        cover.dataset.src = story.image;
        cover.src = story.image;
        cover.classList.remove('hidden');
      } else if (!story.image) cover.classList.add('hidden');
    }
    const id = ch?.id || null;
    if (id !== this.current) { this.current = id; this.highlight(id); }
  }

  finish() {
    this.audio.dataset.clip = '';
    this.setPlaying(false);
    $('sampleTitle').textContent = 'Want this every morning, before you wake?';
    this.current = null;
    this.highlight(null);
  }

  highlight(id) {
    document.querySelectorAll('.story-row.current').forEach((r) => r.classList.remove('current', 'playing-now'));
    if (!id) return;
    const el = document.querySelector(`.story-row[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add('current');
    if (this.playing) el.classList.add('playing-now');
  }

  // ----------------------------------------------------------------- sign in
  openSignIn() {
    $('signin').classList.remove('hidden');
    this.audio.pause();
    this.voiceAudio.pause();
    if (!$('emailForm').classList.contains('hidden')) setTimeout(() => $('loginEmail').focus(), 50);
  }

  closeSignIn() { $('signin').classList.add('hidden'); }

  error(msg) {
    $('loginError').textContent = msg || '';
    $('loginError').classList.toggle('hidden', !msg);
  }

  // A sign-in link that failed comes back as #error=...&error_description=...
  checkLinkError() {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (!hash.get('error')) return;
    history.replaceState(null, '', location.pathname);
    this.openSignIn();
    this.error(/expired|invalid/i.test(hash.get('error_description') || hash.get('error_code') || '')
      ? 'That sign-in link has expired or was already used. Enter your email for a new one.'
      : `Sign-in didn't work: ${hash.get('error_description') || hash.get('error')}`);
  }

  bindSignIn() {
    document.querySelectorAll('[data-signin]').forEach((b) => b.addEventListener('click', () => this.openSignIn()));
    $('signinClose').addEventListener('click', () => this.closeSignIn());
    $('signin').addEventListener('click', (e) => { if (e.target.id === 'signin') this.closeSignIn(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSignIn(); });
    const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = label; };

    const INTRO = "Enter your email and we'll send you a link. New here? That creates your account.";

    $('googleBtn').addEventListener('click', async () => {
      this.error();
      $('googleBtn').disabled = true;
      $('googleLabel').textContent = 'Opening Google…';
      try {
        await api.signInWithGoogle(); // leaves the page; the session is picked up when Google sends us back
      } catch (ex) {
        this.error(/provider is not enabled|unsupported provider/i.test(ex.message)
          ? 'Google sign-in is not switched on yet. Use email instead.' : ex.message);
        $('googleBtn').disabled = false;
        $('googleLabel').textContent = 'Continue with Google';
      }
    });

    $('useEmail').addEventListener('click', () => {
      this.error();
      $('providerStep').classList.add('hidden');
      $('emailForm').classList.remove('hidden');
      $('loginHint').textContent = INTRO;
      $('loginEmail').focus();
    });

    const send = async () => {
      await api.sendCode(this.email);
      this.cooldown();
    };
    const sendError = (ex) => this.error(/signups? not allowed/i.test(ex.message)
      ? "New sign-ups are paused right now. Please try again later."
      : /after (\d+) seconds/i.test(ex.message)
        // Per-email cooldown: one email per address every 60 seconds.
        ? `A link was just sent to this email. Use that one, or wait ${ex.message.match(/after (\d+) seconds/i)[1]} seconds for a new one.`
        : /rate limit/i.test(ex.message)
          // Supabase's built-in sender allows only a few emails an hour for the whole site.
          ? 'Sign-in emails are busy right now. Use the last link you received, or try again in a little while.'
          : ex.message);

    $('emailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      this.error();
      this.email = $('loginEmail').value.trim().toLowerCase();
      busy($('sendCodeBtn'), true, 'Sending…');
      try {
        await send();
        this.showSent();
      } catch (ex) {
        sendError(ex);
      } finally {
        busy($('sendCodeBtn'), false, 'Email me a sign-in link');
      }
    });

    $('resendBtn').addEventListener('click', async () => {
      this.error();
      try { await send(); toast('Sent a new link. Use the newest email.'); } catch (ex) { sendError(ex); }
    });

    $('showCode').addEventListener('click', () => {
      $('codeForm').classList.toggle('hidden');
      if (!$('codeForm').classList.contains('hidden')) $('loginCode').focus();
    });

    $('codeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      this.error();
      const code = $('loginCode').value.trim();
      if (!code) return;
      busy($('verifyBtn'), true, 'Signing in…');
      try {
        await api.verifyCode(this.email, code);
        await this.signedIn();
      } catch (ex) {
        this.error(/expired|invalid/i.test(ex.message) ? 'That code is wrong or has expired. Request a new one.' : ex.message);
      } finally {
        busy($('verifyBtn'), false, 'Sign in with code');
      }
    });

    $('changeEmail').addEventListener('click', () => {
      this.error();
      this.stopWaiting();
      $('sentStep').classList.add('hidden');
      $('emailForm').classList.remove('hidden');
      $('signinTitle').textContent = 'Get started';
      $('loginHint').textContent = INTRO;
    });
  }

  // After the email is sent: the link usually opens in another tab, which signs this browser in.
  // Watch for that session so this tab moves on by itself.
  showSent() {
    $('emailForm').classList.add('hidden');
    $('sentStep').classList.remove('hidden');
    $('codeForm').classList.add('hidden');
    $('signinTitle').textContent = 'Check your email';
    $('loginHint').replaceChildren('We sent a sign-in link to ', h('b', {}, this.email),
      '. Open it on this device and tap ', h('b', {}, 'Sign in'), '. Check spam if it isn\'t there in a minute.');
    const inbox = MAILBOXES.find(([re]) => re.test(this.email));
    $('openMail').classList.toggle('hidden', !inbox);
    if (inbox) { $('openMail').href = inbox[2]; $('openMail').textContent = `Open ${inbox[1]}`; }
    this.stopWaiting();
    const check = async () => { if (await api.session()) this.signedIn(); };
    this.waitTimer = setInterval(check, 3000);
    this.onFocus = () => check();
    window.addEventListener('focus', this.onFocus);
  }

  stopWaiting() {
    clearInterval(this.waitTimer);
    if (this.onFocus) window.removeEventListener('focus', this.onFocus);
  }

  cooldown(seconds = 60) {
    const btn = $('resendBtn');
    clearInterval(this.coolTimer);
    let left = seconds;
    const tick = () => {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `Resend in ${left}s` : 'Resend email';
      left -= 1;
      if (left < 0) clearInterval(this.coolTimer);
    };
    tick();
    this.coolTimer = setInterval(tick, 1000);
  }

  async signedIn() {
    if (this.done) return;
    this.done = true;
    this.stopWaiting();
    this.closeSignIn();
    await this.onSignedIn();
  }

  stop() {
    this.stopWaiting();
    this.audio.pause();
    this.voiceAudio.pause();
  }
}

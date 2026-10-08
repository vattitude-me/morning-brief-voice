// Audio player: APK-style hero with segmented progress, chapters, lock-screen
// controls and resume.
//
// Two sources are supported:
//   * one file per briefing (briefing.audio_url) — the on-device build;
//   * a playlist of shared daily clips (briefing.clips[]) — the single-source pack,
//     played back to back with the next clip pre-buffered so the joins are seamless.
import { fmtTime, h, store } from './api.js';

export class Player extends EventTarget {
  constructor() {
    super();
    // Two <audio> elements: the active one plays, the idle one pre-buffers the next clip.
    this.buffers = [document.getElementById('audio'), new Audio()];
    this.buffers[1].preload = 'auto';
    this.audio = this.buffers[0];
    this.clips = null;
    this.index = 0;
    this.hero = document.getElementById('hero');
    this.heroInView = true;
    this.el = {
      play: document.getElementById('playBtn'),
      prev: document.getElementById('prevChapter'),
      next: document.getElementById('nextChapter'),
      seg: document.getElementById('segProgress'),
      thumb: document.getElementById('segThumb'),
      cur: document.getElementById('curTime'),
      dur: document.getElementById('durTime'),
      state: document.getElementById('heroState'),
      title: document.getElementById('heroTitle'),
      cover: document.getElementById('heroCover'),
      mini: document.getElementById('miniPlayer'),
      miniTitle: document.getElementById('miniTitle'),
      miniSub: document.getElementById('miniSub'),
      miniBar: document.getElementById('miniBar'),
      miniCover: document.getElementById('miniCover'),
      miniEq: document.getElementById('miniEq'),
    };
    this.briefing = null;
    this.chapters = [];
    this.segments = [];
    this.current = null;
    this.speed = store.get('rate', 1);
    this.bind();
  }

  bind() {
    const { el } = this;
    el.play.addEventListener('click', () => this.toggle());
    document.getElementById('miniPlay').addEventListener('click', () => this.toggle());
    el.prev.addEventListener('click', () => this.prevChapter());
    el.next.addEventListener('click', () => this.nextChapter());
    document.getElementById('miniNext').addEventListener('click', () => this.nextChapter());

    // Tap or drag the segmented bar to seek.
    const seekToEvent = (e) => {
      const r = el.seg.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.seekTo(f * (this.total || 0));
      el.seg.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    };
    let dragging = false;
    el.seg.addEventListener('pointerdown', (e) => { dragging = true; el.seg.setPointerCapture(e.pointerId); seekToEvent(e); });
    el.seg.addEventListener('pointermove', (e) => { if (dragging) seekToEvent(e); });
    el.seg.addEventListener('pointerup', () => { dragging = false; });
    el.seg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') this.skip(10);
      else if (e.key === 'ArrowLeft') this.skip(-10);
      else return;
      e.preventDefault();
    });

    // Both elements share the same handlers; the idle one is ignored.
    for (const buf of this.buffers) {
      buf.addEventListener('timeupdate', () => { if (buf === this.audio) this.tick(); });
      buf.addEventListener('loadedmetadata', () => {
        if (buf !== this.audio) return;
        buf.playbackRate = this.speed;
        this.tick();
      });
      buf.addEventListener('play', () => { if (buf === this.audio) this.setPlaying(true); });
      buf.addEventListener('pause', () => { if (buf === this.audio) this.setPlaying(false); });
      buf.addEventListener('ended', () => { if (buf === this.audio) this.onEnded(); });
    }
    // A cover that fails to load hides itself instead of showing a broken icon.
    el.cover.addEventListener('error', () => el.cover.classList.add('hidden'));
    el.miniCover.addEventListener('error', () => { el.miniCover.classList.add('hidden'); el.miniEq.classList.remove('hidden'); });

    // Show the floating mini player once the hero scrolls away.
    new IntersectionObserver(([entry]) => {
      this.heroInView = entry.isIntersecting;
      this.showMini();
    }, { threshold: 0.05 }).observe(this.hero);

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.audio.play());
      ms.setActionHandler('pause', () => this.audio.pause());
      ms.setActionHandler('previoustrack', () => this.prevChapter());
      ms.setActionHandler('nexttrack', () => this.nextChapter());
      try { ms.setActionHandler('seekto', (d) => { this.seekTo(d.seekTime); }); } catch { /* unsupported */ }
    }
  }

  get isPlaying() { return !this.audio.paused && !this.audio.ended; }

  /**
   * The floating player shows whenever the hero card is off screen and there is
   * something to resume. Kept in one place because the observer only fires when the
   * card crosses the viewport, not when the tab or the briefing changes underneath it.
   */
  showMini() {
    const show = !!this.briefing && !this.heroInView && (this.isPlaying || this.position > 0);
    this.el.mini.classList.toggle('show', show);
    this.el.mini.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  /** Seconds into the whole briefing (not the current clip). */
  get position() {
    if (!this.clips) return this.audio.currentTime || 0;
    return (this.clips[this.index]?.start || 0) + (this.audio.currentTime || 0);
  }

  /** Total briefing length. */
  get total() {
    if (!this.clips) return this.audio.duration || this.briefing?.duration || 0;
    return this.clips.length ? this.clips[this.clips.length - 1].end : 0;
  }

  clipIndexAt(t) {
    let found = 0;
    for (let i = 0; i < this.clips.length; i += 1) { if (t >= this.clips[i].start - 0.02) found = i; }
    return found;
  }

  /** Make clip `i` active, optionally seeking within it, and pre-buffer the next one. */
  loadClip(i, { seek = 0, autoplay = null } = {}) {
    const play = autoplay === null ? this.isPlaying : autoplay;
    const clip = this.clips[i];
    if (!clip) return;
    this.index = i;
    const el = this.audio;
    if (el.dataset.clip !== String(i)) {
      el.dataset.clip = String(i);
      el.src = clip.url;
    }
    const applySeek = () => { try { el.currentTime = seek; } catch { /* not seekable yet */ } };
    if (el.readyState >= 1) applySeek();
    else el.addEventListener('loadedmetadata', applySeek, { once: true });
    el.playbackRate = this.speed;
    if (play) el.play().catch(() => {});
    this.preloadNext();
  }

  /** Buffer the following clip into the idle element so the join is seamless. */
  preloadNext() {
    if (!this.clips) return;
    const next = this.clips[this.index + 1];
    if (!next) return;
    const idle = this.buffers.find((b) => b !== this.audio);
    if (idle.dataset.clip !== String(this.index + 1)) {
      idle.dataset.clip = String(this.index + 1);
      idle.src = next.url;
      idle.load();
    }
  }

  /** A clip finished: swap to the pre-buffered element, or stop at the end of the day. */
  onEnded() {
    if (this.clips && this.index + 1 < this.clips.length) {
      this.audio = this.buffers.find((b) => b !== this.audio);
      this.index += 1;
      this.audio.playbackRate = this.speed;
      this.audio.play().catch(() => {});
      this.preloadNext();
      this.tick();
      return;
    }
    this.setPlaying(false);
    store.set(`pos-${this.briefing?.date}`, 0);
    this.el.state.textContent = 'Finished';
    this.el.title.textContent = "That's today's briefing. Have a great day!";
  }

  load(briefing) {
    if (!briefing) return;
    this.briefing = briefing;
    this.chapters = (briefing.chapters || []).filter((c) => c.kind !== 'section');
    this.current = null;
    this.clips = briefing.clips && briefing.clips.length ? briefing.clips : null;
    this.index = 0;
    for (const buf of this.buffers) {
      buf.pause();
      delete buf.dataset.clip;
      buf.removeAttribute('src');
    }
    this.audio = this.buffers[0];
    if (this.clips) this.loadClip(0);
    else this.audio.src = briefing.audio_url;
    this.buildSegments();
    const saved = store.get(`pos-${briefing.date}`, 0);
    if (saved > 5 && (!briefing.duration || saved < briefing.duration - 5)) this.seekTo(saved);
    this.tick();
  }

  buildSegments() {
    const b = this.briefing;
    const total = Math.max(1, b.duration || 1);
    const ends = this.chapters.map((c, i) => (i + 1 < this.chapters.length ? this.chapters[i + 1].start : b.duration));
    this.segments = this.chapters.map((c, i) => ({ chapter: c, start: c.start, end: ends[i] }));
    const seg = this.el.seg;
    seg.querySelectorAll('.seg').forEach((n) => n.remove());
    for (const s of this.segments) {
      const d = h('div', { class: 'seg', style: `flex-grow:${Math.max(1, s.end - s.start)}` }, h('i'));
      seg.insertBefore(d, this.el.thumb);
    }
  }

  storyFor(chapter) {
    return this.briefing?.stories.find((s) => s.id === chapter?.id);
  }

  sectionTitle(chapter) {
    const story = this.storyFor(chapter);
    return this.briefing?.sections.find((s) => s.key === story?.section)?.title || '';
  }

  currentChapter(t = this.position) {
    let found = null;
    for (const c of this.chapters) { if (t >= c.start - 0.05) found = c; }
    return found;
  }

  toggle() {
    if (!this.briefing) return;
    if (this.isPlaying) this.audio.pause();
    else this.audio.play().catch(() => {});
  }

  skip(sec) {
    if (!this.briefing) return;
    this.seekTo(this.position + sec);
  }

  playChapter(id) {
    const ch = this.chapters.find((c) => c.id === id);
    if (!ch) return;
    this.seekTo(ch.start);
    this.audio.play().catch(() => {});
  }

  seekTo(seconds) {
    if (!this.briefing) return;
    const limit = this.total || this.briefing.duration || 0;
    const t = Math.max(0, Math.min(seconds, limit));
    if (this.clips) {
      const i = this.clipIndexAt(t);
      if (i !== this.index) {
        this.loadClip(i, { seek: t - this.clips[i].start });
      } else {
        const local = t - this.clips[i].start;
        if (this.audio.readyState >= 1) this.audio.currentTime = local;
        else this.audio.addEventListener('loadedmetadata', () => { this.audio.currentTime = local; }, { once: true });
        this.preloadNext();
      }
    } else if (this.audio.readyState >= 1) {
      this.audio.currentTime = t;
    } else {
      this.audio.addEventListener('loadedmetadata', () => { this.audio.currentTime = t; }, { once: true });
    }
    this.tick();
  }

  nextChapter() {
    const ch = this.currentChapter();
    const i = this.chapters.indexOf(ch);
    if (i >= 0 && i < this.chapters.length - 1) this.playChapter(this.chapters[i + 1].id);
  }

  prevChapter() {
    const ch = this.currentChapter();
    const i = this.chapters.indexOf(ch);
    if (ch && this.position - ch.start > 3) this.playChapter(ch.id);
    else if (i > 0) this.playChapter(this.chapters[i - 1].id);
  }

  setRate(rate) {
    this.speed = rate;
    this.buffers.forEach((buf) => { buf.playbackRate = rate; });
    store.set('rate', rate);
  }

  setPlaying(on) {
    document.body.classList.toggle('playing', on);
    this.hero.classList.toggle('playing-now', on);
    this.el.play.setAttribute('aria-label', on ? 'Pause briefing' : 'Play briefing');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
    this.dispatchEvent(new CustomEvent('state', { detail: { playing: on } }));
  }

  tick() {
    const { el } = this;
    const b = this.briefing;
    if (!b) return;
    const dur = this.total || b.duration || 0;
    const t = this.position;
    if (t > 0 && Math.round(t) % 5 === 0) store.set(`pos-${b.date}`, t);

    // Segments + thumb.
    const segs = el.seg.querySelectorAll('.seg');
    this.segments.forEach((s, i) => {
      const f = s.end > s.start ? Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start))) : 0;
      const fill = segs[i]?.firstChild;
      if (fill) fill.style.width = `${f * 100}%`;
    });
    const frac = dur ? t / dur : 0;
    el.thumb.style.left = `${frac * 100}%`;
    el.seg.setAttribute('aria-valuenow', String(Math.round(frac * 100)));

    // Times: elapsed and remaining.
    el.cur.textContent = fmtTime(t);
    el.dur.textContent = `-${fmtTime(Math.max(0, dur - t))}`;

    // Hero state + title + cover.
    const ch = this.currentChapter(t);
    const story = this.storyFor(ch);
    const section = this.sectionTitle(ch);
    const started = t >= 0.5;
    el.state.textContent = !started && !this.isPlaying
      ? `Ready · ${b.stories.length} ${b.stories.length === 1 ? 'story' : 'stories'}`
      : [this.isPlaying ? 'Now playing' : 'Paused', section].filter(Boolean).join(' · ');
    el.title.textContent = story?.headline || ch?.title || b.title;
    // A greeting or a section intro has no picture of its own, so the cover shows what
    // is about to be read instead of jumping back to the first story of the brief.
    const upNext = story ? null : this.chapters.find((c) => c.kind === 'story' && c.start >= t - 0.01);
    const img = (story || this.storyFor(upNext))?.image || b.stories.find((s) => s.image)?.image;
    if (img && el.cover.dataset.src !== img) { el.cover.dataset.src = img; el.cover.src = img; el.cover.classList.remove('hidden'); }
    else if (!img) el.cover.classList.add('hidden');

    // Mini player.
    el.miniTitle.textContent = story?.headline || b.title;
    el.miniSub.textContent = [section, `${fmtTime(t)} / ${fmtTime(dur)}`].filter(Boolean).join(' · ');
    el.miniBar.style.width = `${frac * 100}%`;
    if (img && el.miniCover.dataset.src !== img) { el.miniCover.dataset.src = img; el.miniCover.src = img; el.miniCover.classList.remove('hidden'); el.miniEq.classList.add('hidden'); }
    else if (!img) { el.miniCover.classList.add('hidden'); el.miniEq.classList.remove('hidden'); }

    if (ch && ch.id !== this.current && (t > 0 || this.isPlaying)) {
      this.current = ch.id;
      this.updateMediaSession(ch, story);
      this.dispatchEvent(new CustomEvent('chapter', { detail: ch }));
    }
  }

  updateMediaSession(ch, story) {
    if (!('mediaSession' in navigator)) return;
    const art = story?.image ? [{ src: story.image, sizes: '512x512' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ch.title,
      artist: 'Morning Brief',
      album: this.briefing.title,
      artwork: [...art, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

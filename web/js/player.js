// Audio player: APK-style hero with segmented progress, chapters, lock-screen
// controls and resume. One audio file per briefing; segments = story chapters.
import { fmtTime, h, store } from './api.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = document.getElementById('audio');
    this.hero = document.getElementById('hero');
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
    const { audio, el } = this;
    el.play.addEventListener('click', () => this.toggle());
    document.getElementById('miniPlay').addEventListener('click', () => this.toggle());
    el.prev.addEventListener('click', () => this.prevChapter());
    el.next.addEventListener('click', () => this.nextChapter());
    document.getElementById('miniNext').addEventListener('click', () => this.nextChapter());

    // Tap or drag the segmented bar to seek.
    const seekToEvent = (e) => {
      const r = el.seg.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (audio.duration) audio.currentTime = f * audio.duration;
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

    audio.addEventListener('timeupdate', () => this.tick());
    audio.addEventListener('loadedmetadata', () => {
      audio.playbackRate = this.speed;
      this.tick();
    });
    audio.addEventListener('play', () => this.setPlaying(true));
    audio.addEventListener('pause', () => this.setPlaying(false));
    // A cover that fails to load hides itself instead of showing a broken icon.
    el.cover.addEventListener('error', () => el.cover.classList.add('hidden'));
    el.miniCover.addEventListener('error', () => { el.miniCover.classList.add('hidden'); el.miniEq.classList.remove('hidden'); });
    audio.addEventListener('ended', () => {
      this.setPlaying(false);
      store.set(`pos-${this.briefing?.date}`, 0);
      el.state.textContent = 'Finished';
      el.title.textContent = "That's today's briefing. Have a great day!";
    });

    // Show the floating mini player once the hero scrolls away.
    new IntersectionObserver(([entry]) => {
      const show = !entry.isIntersecting && this.briefing && (this.isPlaying || audio.currentTime > 0);
      el.mini.classList.toggle('show', !!show);
      el.mini.setAttribute('aria-hidden', show ? 'false' : 'true');
    }, { threshold: 0.05 }).observe(this.hero);

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => audio.play());
      ms.setActionHandler('pause', () => audio.pause());
      ms.setActionHandler('previoustrack', () => this.prevChapter());
      ms.setActionHandler('nexttrack', () => this.nextChapter());
      try { ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; }); } catch { /* unsupported */ }
    }
  }

  get isPlaying() { return !this.audio.paused && !this.audio.ended; }

  load(briefing) {
    this.briefing = briefing;
    this.chapters = (briefing.chapters || []).filter((c) => c.kind !== 'section');
    this.current = null;
    this.audio.src = briefing.audio_url;
    this.buildSegments();
    const saved = store.get(`pos-${briefing.date}`, 0);
    if (saved > 5 && saved < briefing.duration - 5) {
      this.audio.addEventListener('loadedmetadata', () => { this.audio.currentTime = saved; }, { once: true });
    }
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

  currentChapter(t = this.audio.currentTime) {
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
    this.audio.currentTime = Math.min(Math.max(0, this.audio.currentTime + sec), this.audio.duration || 0);
  }

  playChapter(id) {
    const ch = this.chapters.find((c) => c.id === id);
    if (!ch) return;
    this.audio.currentTime = ch.start;
    this.audio.play().catch(() => {});
  }

  nextChapter() {
    const ch = this.currentChapter();
    const i = this.chapters.indexOf(ch);
    if (i >= 0 && i < this.chapters.length - 1) this.playChapter(this.chapters[i + 1].id);
  }

  prevChapter() {
    const ch = this.currentChapter();
    const i = this.chapters.indexOf(ch);
    if (ch && this.audio.currentTime - ch.start > 3) this.playChapter(ch.id);
    else if (i > 0) this.playChapter(this.chapters[i - 1].id);
  }

  setRate(rate) {
    this.speed = rate;
    this.audio.playbackRate = rate;
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
    const { audio, el } = this;
    const b = this.briefing;
    if (!b) return;
    const dur = audio.duration || b.duration || 0;
    const t = audio.currentTime || 0;
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
    const img = story?.image || b.stories.find((s) => s.image)?.image;
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

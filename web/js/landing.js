// Signed-out landing: play the admin's latest briefing (or the one shipped with the site), show its headlines and voices, then sign in.
import { SECTIONS, api, h, store, toast } from './api.js';
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

export class Landing {
  constructor({ onSignedIn }) {
    this.onSignedIn = onSignedIn;
    this.audio = $('sampleAudio');
    this.voiceAudio = new Audio();
    this.email = '';
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
      if (data.briefing?.audio_url) break;
    }
    this.render(data);
  }

  // ------------------------------------------------------------------ sample
  render({ briefing }) {
    this.briefing = briefing;
    const player = $('samplePlayer');
    if (!briefing?.audio_url) {
      player.classList.add('disabled');
      $('samplePlay').disabled = true;
      $('sampleLabel').textContent = 'Sample unavailable';
      $('sampleTitle').textContent = "The sample couldn't load. Check your connection and try again.";
    } else {
      const mins = Math.max(1, Math.round(briefing.duration / 60));
      const today = briefing.date === new Date().toLocaleDateString('en-CA');
      $('sampleLabel').textContent = `${today ? "Today's brief" : 'Sample briefing'} · ${mins} min`;
      $('sampleTitle').textContent = today ? "Tap play to hear this morning's brief" : 'Tap play to hear a real morning brief';
      $('sampleHeading').textContent = today ? "This morning's headlines" : 'Headlines from a recent brief';
      $('sampleDate').textContent = today ? briefing.title : `From ${briefing.title}`;
      $('sampleCards').replaceChildren(...briefing.stories.map((s) => this.card(s)));
      $('sampleSection').hidden = false;
    }
  }

  card(s) {
    const { emoji, title: label } = SECTIONS[s.section] || SECTIONS.custom;
    const media = s.image
      ? h('div', { class: 'card-media' }, h('img', {
        src: s.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
        onerror: (e) => e.target.parentElement.replaceWith(this.placeholder(s.section, emoji)),
      }))
      : this.placeholder(s.section, emoji);
    media.append(h('span', { class: 'chip', dataset: { section: s.section } }, label));
    return h('article', { class: 'sample-card', dataset: { id: s.id } },
      media,
      h('div', { class: 'card-body' },
        h('span', { class: 'meta' }, s.source),
        h('h3', {}, s.headline),
        h('p', {}, s.summary)));
  }

  placeholder(section, emoji) {
    return h('div', { class: 'card-media placeholder', dataset: { section } }, h('span', { 'aria-hidden': 'true' }, emoji));
  }

  bindPlayer() {
    const a = this.audio;
    const player = $('samplePlayer');
    $('samplePlay').addEventListener('click', () => {
      if (!this.briefing?.audio_url) return;
      if (!a.src) a.src = this.briefing.audio_url;
      this.voiceAudio.pause();
      if (a.paused) a.play().catch(() => {}); else a.pause();
    });
    a.addEventListener('play', () => player.classList.add('playing'));
    a.addEventListener('pause', () => player.classList.remove('playing'));
    a.addEventListener('ended', () => {
      $('sampleTitle').textContent = 'Want your own, every morning?';
      this.highlight(null);
    });
    a.addEventListener('timeupdate', () => {
      const b = this.briefing;
      if (!b) return;
      $('sampleBar').style.width = `${Math.min(100, (a.currentTime / (a.duration || b.duration)) * 100)}%`;
      const ch = b.chapters.find((c) => a.currentTime >= c.start && a.currentTime < c.end && c.kind === 'story');
      const id = ch?.id || null;
      if (id === this.current) return;
      this.current = id;
      if (ch) $('sampleTitle').textContent = ch.title;
      this.highlight(id);
    });
  }

  highlight(id) {
    document.querySelectorAll('.sample-card.reading').forEach((c) => c.classList.remove('reading'));
    if (!id) return;
    const el = document.querySelector(`.sample-card[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add('reading');
    const row = $('sampleCards');
    row.scrollTo({ left: el.offsetLeft - row.offsetLeft, behavior: 'smooth' });
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

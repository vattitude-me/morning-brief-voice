// Install helpers, push notifications, welcome + delete-account sheets.
import { SECTIONS, api, h, sectionLabel, toast } from './api.js';

export function wireSheet(dialog) {
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// Install: Chrome/Edge/Android hand us a prompt (caught early in index.html); iPhone needs Share > Add to Home Screen.
let installPrompt = window.__installPrompt || null;
const installWatchers = new Set();
const installChanged = () => installWatchers.forEach((fn) => fn());
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; installChanged(); });
window.addEventListener('appinstalled', () => { installPrompt = null; installChanged(); });
// 'prompt' (one-tap install), 'ios' (show the steps) or null (installed, or this browser can't install).
export const installMode = () => (isInstalled() ? null : installPrompt ? 'prompt' : isIOS() ? 'ios' : null);
export const onInstallChange = (fn) => installWatchers.add(fn);
// Must be called from a tap. Resolves true when the user accepted.
export async function promptInstall() {
  const e = installPrompt;
  if (!e) return false;
  installPrompt = null; // a prompt can only be shown once
  e.prompt();
  const { outcome } = await e.userChoice;
  installChanged();
  return outcome === 'accepted';
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

// The key a subscription was made with, written the way the server publishes it, so the two can be
// compared as strings.
export const subscribedWith = (sub) => {
  const bytes = sub?.options?.applicationServerKey;
  if (!bytes) return '';
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Asks permission and registers this device. Must be called from a tap. Throws a readable message on failure.
export async function enablePush(publicKey) {
  if (!publicKey) throw new Error("The server hasn't published its notification key yet. Try again later.");
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permission was not granted.');
  const reg = await navigator.serviceWorker.ready;
  const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  // A subscription is bound for life to the key it was created with, and pushes signed with any
  // other key are refused. If the server has replaced its key, this device is subscribed to a
  // channel nothing can post to, so drop it and register again with the current key.
  if (sub && subscribedWith(sub) !== publicKey) {
    await api.pushUnsubscribe(sub.toJSON()).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(sub.toJSON());
}

/* ----------------------------------------------------------- Delete account */
export class DeleteAccountSheet {
  constructor() {
    this.dialog = document.getElementById('deleteSheet');
    this.box = document.getElementById('deleteConfirm');
    this.go = document.getElementById('deleteGo');
    if (!this.dialog || !this.box || !this.go) return;

    // Like wireSheet, but nothing closes it while the deletion is running.
    this.dialog.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => this.dialog.close()));
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog && !this.busy) this.dialog.close(); });

    const sync = () => {
      if (this.go && this.box) {
        this.go.disabled = !this.box.checked;
      }
    };
    this.box.addEventListener('change', sync);
    this.box.addEventListener('input', sync);
    this.box.addEventListener('click', sync);

    const form = document.getElementById('deleteForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.run();
      });
    }
    this.go.addEventListener('click', (e) => {
      if (this.box && this.box.checked && !this.busy) {
        e.preventDefault();
        this.run();
      }
    });
    this.dialog.addEventListener('cancel', (e) => { if (this.busy) e.preventDefault(); });
  }

  open(email) {
    document.getElementById('deleteEmail').textContent = email || 'this account';
    document.getElementById('deleteStatus').textContent = '';
    this.box.checked = false;
    this.box.disabled = false;
    this.closers(false);
    this.go.disabled = true;
    this.go.textContent = 'Delete forever';
    this.dialog.showModal();
  }

  closers(disabled) {
    this.dialog.querySelectorAll('[data-close]').forEach((b) => { b.disabled = disabled; });
  }

  async run() {
    if (!this.box.checked || this.busy) return;
    const status = document.getElementById('deleteStatus');
    this.busy = true;
    this.closers(true);
    this.go.disabled = true;
    this.box.disabled = true;
    this.go.textContent = 'Deleting…';
    status.textContent = 'Deleting your account. This can take up to a minute.';
    try {
      await api.deleteAccount();
      // Forget this device's notification subscription and cached briefing (the theme stays).
      try { (await (await navigator.serviceWorker?.ready)?.pushManager.getSubscription())?.unsubscribe(); } catch { /* ignore */ }
      Object.keys(localStorage).filter((k) => k.startsWith('mb-') && k !== 'mb-theme').forEach((k) => localStorage.removeItem(k));
      status.textContent = 'Your account has been deleted.';
      try { await api.signOut(); } catch { /* the session died with the account */ }
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      this.busy = false;
      this.closers(false);
      this.box.disabled = false;
      this.go.disabled = !this.box.checked;
      this.go.textContent = 'Delete forever';
      status.textContent = err.message;
    }
  }
}

/* ------------------------------------------------------------------ Welcome */
// First sign-in: name, which sources to read, then when the first briefing arrives (plus notifications).
const STEP_TITLE = { name: 'A few details', sources: 'Choose your topics', morning: 'Ready for your morning' };

export class WelcomeSheet {
  constructor({ onDone }) {
    this.onDone = onDone;
    this.dialog = document.getElementById('welcomeSheet');
    wireSheet(this.dialog);
    this.dialog.addEventListener('cancel', (e) => e.preventDefault());
    document.getElementById('welcomeForm').addEventListener('submit', (e) => { e.preventDefault(); this.next(); });
    document.getElementById('welcomeBack').addEventListener('click', () => this.back());
    document.getElementById('welcomeSourceAdd').addEventListener('click', () => this.addSource());
    document.getElementById('welcomeSourceUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.addSource(); }
    });
    document.getElementById('welcomeInstallBtn').addEventListener('click', async () => {
      if (await promptInstall()) toast('Installed. Next time, open Morning Brief from your home screen.');
    });
    // Chrome may only offer the install prompt after the sheet is already open.
    onInstallChange(() => { if (this.dialog.open) this.paintInstall(); });
  }

  paintInstall() {
    const mode = installMode();
    document.getElementById('welcomeInstallRow').classList.toggle('hidden', !mode);
    document.getElementById('welcomeInstallIOS').classList.toggle('hidden', mode !== 'ios');
    document.getElementById('welcomeInstallPrompt').classList.toggle('hidden', mode !== 'prompt');
  }

  // askName: first visit, lean two steps. Otherwise only the morning step (e.g. after installing on iPhone).
  open(status, { askName = true } = {}) {
    this.status = status;
    this.steps = askName ? ['name', 'morning'] : ['morning'];
    this.disabled = null;
    this.added = 0;
    const canPush = pushSupported() && Notification.permission !== 'denied';
    this.offeredPush = canPush;
    document.getElementById('welcomePushRow').classList.toggle('hidden', !canPush);
    document.getElementById('welcomePushOn').checked = canPush;
    document.getElementById('welcomeError').textContent = '';
    document.getElementById('welcomeDots').replaceChildren(...(this.steps.length > 1 ? this.steps.map(() => h('span')) : []));
    this.paintInstall();
    this.dialog.showModal();
    this.show(0);
  }

  show(i) {
    this.i = i;
    const step = this.steps[i];
    this.dialog.querySelectorAll('.welcome-step').forEach((el) => el.classList.toggle('hidden', el.dataset.step !== step));
    this.dialog.querySelectorAll('#welcomeDots span').forEach((d, j) => d.classList.toggle('on', j === i));
    document.getElementById('welcomeTitle').textContent = this.steps.length > 1 ? STEP_TITLE[step] : 'Morning notification';
    const last = i === this.steps.length - 1;
    document.getElementById('welcomeGo').textContent = last ? 'Finish setup' : 'Continue';
    document.getElementById('welcomeBack').textContent = i === 0 ? 'Skip setup' : 'Back';
    document.getElementById('welcomeError').textContent = '';
    if (step === 'morning') this.paintMorning();
    this.dialog.querySelector('.sheet-body').scrollTop = 0;
    if (step === 'name') document.getElementById('welcomeName').focus();
  }

  next() {
    if (this.i < this.steps.length - 1) this.show(this.i + 1);
    else this.finish(true);
  }

  back() {
    if (this.i === 0) this.finish(false);
    else this.show(this.i - 1);
  }

  async loadSources() {
    const box = document.getElementById('welcomeSources');
    box.replaceChildren(h('p', { class: 'hint' }, 'Loading topics…'));
    try {
      this.paintSources();
    } catch (err) {
      box.replaceChildren(h('p', { class: 'hint' }, 'All 7 topics are included in your briefing.'));
    }
  }

  paintSources() {
    const topics = Object.entries(SECTIONS).filter(([k]) => k !== 'custom');
    document.getElementById('welcomeSources').replaceChildren(
      h('div', { class: 'chip-row', style: 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;' },
        ...topics.map(([key, info]) => {
          const on = !this.disabled?.has(key);
          const chip = h('button', {
            type: 'button',
            class: 'pill-btn sm' + (on ? '' : ' glass-btn'),
            'aria-pressed': String(on),
          }, info.title);
          chip.addEventListener('click', () => {
            if (!this.disabled) this.disabled = new Set();
            if (this.disabled.has(key)) this.disabled.delete(key);
            else this.disabled.add(key);
            const nowOn = !this.disabled.has(key);
            chip.className = 'pill-btn sm' + (nowOn ? '' : ' glass-btn');
            chip.setAttribute('aria-pressed', String(nowOn));
          });
          return chip;
        })
      )
    );
  }

  async addSource() {
    const input = document.getElementById('welcomeSourceUrl');
    const btn = document.getElementById('welcomeSourceAdd');
    let url = input.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { url = new URL(url).href; } catch {
      toast("That doesn't look like a web link.", { error: true });
      return;
    }
    btn.disabled = true;
    try {
      await api.addSource({ url, section: 'custom' });
      this.added += 1;
      input.value = '';
      toast('Saved to your sources.');
      if (this.sources) this.paintSources();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  async paintMorning() {
    const when = document.getElementById('welcomeWhen');
    const what = document.getElementById('welcomeWhat');
    // The day's brief is recorded once for everyone, so it may already be waiting — in which case
    // there is nothing to wait for and nothing to build.
    let ready = false;
    try {
      ready = (await api.storyAudio(new Date().toLocaleDateString('en-CA'))).length > 0;
    } catch { /* offline, or not signed in yet: fall back to the schedule below */ }
    // The brief is recorded once each morning, so that is as specific as we can be.
    when.textContent = ready ? 'Ready now' : 'Tomorrow morning';
    what.textContent = ready
      ? 'Recorded this morning and waiting for you.'
      : 'The top stories, summarized and read aloud in about five minutes.';
  }

  async finish(save) {
    const err = document.getElementById('welcomeError');
    const name = document.getElementById('welcomeName').value.trim().slice(0, 40);
    const wantPush = save && this.offeredPush && document.getElementById('welcomePushOn').checked;
    const btn = document.getElementById('welcomeGo');
    btn.disabled = true;
    try {
      if (wantPush) {
        if (!this.status?.vapid_public_key) {
          toast('Notifications are still setting up. Try again in a moment.', { error: true, ms: 6000 });
        } else {
          try { await enablePush(this.status.vapid_public_key); } catch (e) { toast(`Notifications are off: ${e.message}`, { error: true, ms: 6000 }); }
        }
      }
      await api.saveSettings({
        onboarded: true,
        ...(this.offeredPush ? { push_offered: true } : {}),
        ...(save && name ? { name } : {}),
        ...(save && this.disabled ? { disabled_sources: [...this.disabled] } : {}),
      });
      this.dialog.close();
      this.onDone?.();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }
}

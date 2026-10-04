// Sources and Voice & settings sheets.
import { SECTIONS, api, clockLabel, h, icon, sectionLabel, timeAgo, toast } from './api.js';
import { LLM_PROVIDERS, VOICES } from './brief.js';

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

// Asks permission and registers this device. Must be called from a tap. Throws a readable message on failure.
export async function enablePush(publicKey) {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permission was not granted.');
  if (!publicKey) throw new Error("The server hasn't published its notification key yet. Try again later.");
  const reg = await navigator.serviceWorker.ready;
  const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(sub.toJSON());
}

/* ------------------------------------------------------------------ Sources */
export class SourcesSheet {
  constructor() {
    this.dialog = document.getElementById('sourcesSheet');
    this.list = document.getElementById('sourceList');
    this.form = document.getElementById('addSourceForm');
    this.urlInput = document.getElementById('sourceUrl');
    this.checkBtn = document.getElementById('checkSourceBtn');
    wireSheet(this.dialog);
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.check(); });
  }

  async open() {
    this.dialog.showModal();
    await this.refresh();
  }

  async check() {
    let url = this.urlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { url = new URL(url).href; } catch {
      toast("That doesn't look like a web link.", { error: true });
      return;
    }
    this.checkBtn.disabled = true;
    this.checkBtn.textContent = 'Adding…';
    try {
      await api.addSource({ url, section: 'custom' });
      toast('Added. It will be checked at the next morning build.');
      this.urlInput.value = '';
      await this.refresh();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      this.checkBtn.disabled = false;
      this.checkBtn.textContent = 'Add link';
    }
  }

  async refresh() {
    const { sources } = await api.sources();
    const groups = Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, []]));
    sources.forEach((s) => (groups[s.section] || groups.custom).push(s));
    // Your own links first, then built-ins alphabetically.
    Object.values(groups).forEach((g) => g.sort((a, b) => a.builtin - b.builtin || a.name.localeCompare(b.name)));
    this.list.replaceChildren(
      ...Object.entries(groups)
        .filter(([, items]) => items.length)
        .map(([key, items]) => h('section', { class: 'source-group' },
          h('h3', {}, sectionLabel(key), h('span', { class: 'tag' }, `${items.filter((s) => s.enabled).length} on`)),
          items.map((s) => this.row(s)))),
    );
  }

  row(s) {
    const host = (() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return s.url; } })();
    const ok = s.last_status === 'ok';
    const pending = s.kind === 'auto' && !s.last_status;
    const statusText = pending ? 'Waiting for the next morning build'
      : s.last_status
        ? ok ? `${s.last_count ?? 0} ${s.last_count === 1 ? 'story' : 'stories'} · ${timeAgo(s.last_fetched_at)}` : s.last_status
        : 'Not checked yet';
    const toggle = h('input', { type: 'checkbox', 'aria-label': `Use ${s.name}` });
    toggle.checked = s.enabled;
    toggle.addEventListener('change', async () => {
      try { await api.updateSource(s, { enabled: toggle.checked }); } catch (err) {
        toggle.checked = !toggle.checked;
        toast(err.message, { error: true });
      }
    });
    const del = s.builtin ? null : h('button', {
      class: 'icon-btn', 'aria-label': `Remove ${s.name}`, title: 'Remove',
      onclick: async () => {
        if (!confirm(`Remove ${s.name}?`)) return;
        try { await api.deleteSource(s.id); await this.refresh(); } catch (err) { toast(err.message, { error: true }); }
      },
    }, icon('trash'));
    return h('div', { class: 'source-row' },
      h('label', { class: 'switch' }, toggle, h('span')),
      h('div', { class: 'source-info' },
        h('span', { class: 'source-name', title: s.name }, s.name),
        h('span', { class: 'source-sub', title: statusText },
          h('span', { class: `status-dot ${s.last_status ? (ok ? 'ok' : 'err') : ''}` }),
          s.builtin ? null : h('span', { class: 'tag' }, s.kind === 'article' ? (s.consumed_at ? 'used' : 'queued') : s.kind === 'auto' ? 'new' : s.kind),
          `${host} · ${statusText}`)),
      del);
  }
}

/* ----------------------------------------------------------------- Settings */
const speedLabel = (value) => `${Number(value).toFixed(2).replace(/0$/, '')}×`;

export class SettingsSheet {
  constructor({ onBuild }) {
    this.dialog = document.getElementById('settingsSheet');
    this.onBuild = onBuild;
    this.previewAudio = new Audio();
    wireSheet(this.dialog);
    this.dialog.addEventListener('close', () => this.previewAudio.pause());
    this.picker = document.getElementById('voicePicker');
    this.picker.addEventListener('toggle', () => { if (!this.picker.open) this.previewAudio.pause(); });
    document.getElementById('saveSettings').addEventListener('click', () => this.save());
    document.getElementById('rebuildBtn').addEventListener('click', () => this.onBuild());
    document.getElementById('pushOn').addEventListener('change', (e) => this.togglePush(e.target));
    document.getElementById('pushTest').addEventListener('click', (e) => this.testPush(e.currentTarget));
    document.getElementById('signOutBtn').addEventListener('click', async () => { await api.signOut(); location.reload(); });
    this.deleteSheet = new DeleteAccountSheet();
    document.getElementById('deleteAccountBtn').addEventListener('click', () => this.deleteSheet.open(this.email));
    const range = document.getElementById('speedRange');
    range.addEventListener('input', () => {
      document.getElementById('speedOut').textContent = speedLabel(range.value);
      this.paintVoiceSummary();
    });
  }

  async open(status, profile) {
    // The voice is usually picked once, so it opens collapsed to a one-line summary.
    this.picker.open = false;
    this.dialog.querySelector('.sheet-body').scrollTop = 0;
    this.dialog.showModal();
    this.status = status || {};
    const { settings } = await api.settings();
    this.settings = settings;
    const voice = VOICES.some((v) => v.id === settings.voice) ? settings.voice : 'gemini:Kore';
    this.renderVoices(VOICES, voice);
    this.renderAI(settings);
    const range = document.getElementById('speedRange');
    range.value = settings.speed;
    range.dispatchEvent(new Event('input'));
    document.getElementById('nameInput').value = settings.name || '';
    document.getElementById('dailyOn').checked = settings.daily !== false;
    document.getElementById('weatherOn').checked = settings.weather;
    document.getElementById('saySourcesOn').checked = !!settings.say_sources;
    document.getElementById('cityInput').value = settings.city;
    document.getElementById('latInput').value = settings.latitude;
    document.getElementById('lonInput').value = settings.longitude;
    this.email = profile?.email || '';
    document.getElementById('accountEmail').textContent = this.email;
    document.getElementById('rebuildGroup').classList.remove('hidden');
    this.renderSteppers(settings.stories);
    this.showStatus(this.status);
    this.refreshPush();
  }

  async refreshPush() {
    const box = document.getElementById('pushOn');
    const hint = document.getElementById('pushHint');
    const supported = pushSupported();
    box.disabled = !supported;
    if (!supported) {
      hint.textContent = 'Notifications need HTTPS and an installed app (on iPhone: Add to Home Screen first).';
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    box.checked = !!(await reg.pushManager.getSubscription()) && Notification.permission === 'granted';
    hint.textContent = Notification.permission === 'denied' ? 'Notifications are blocked in this browser\'s site settings.' : '';
  }

  async togglePush(box) {
    const hint = document.getElementById('pushHint');
    try {
      if (!box.checked) {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) { await api.pushUnsubscribe(existing.toJSON()); await existing.unsubscribe(); }
        return;
      }
      await enablePush(this.status?.vapid_public_key);
      hint.textContent = 'You will be notified each morning when the briefing is ready.';
    } catch (err) {
      box.checked = false;
      hint.textContent = err.message;
    }
  }

  async testPush(btn) {
    const hint = document.getElementById('pushHint');
    btn.disabled = true;
    hint.textContent = 'Asking the server to send a test…';
    try {
      const r = await api.pushTest();
      hint.textContent = r.status === 'done' ? `${r.message}.` : r.message;
    } catch (err) {
      hint.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  showStatus(status) {
    const max = status.limits?.max_custom_sources || 15;
    const items = [
      'Your briefing is built right in this browser when you tap Build — no server involved.',
      'Summaries and voice use your own free API keys (Groq, Gemini or OpenRouter). Keys are sent only to the provider they belong to.',
      'Without an AI key, the built-in summarizer writes plainer summaries and a note appears on your briefing.',
      'Generated audio is cached on this device, so rebuilding is fast and repeat listens are free.',
      `Up to ${max} of your own links are used each day.`,
    ];
    document.getElementById('limitsList').replaceChildren(...items.map((t) => h('li', {}, t)));
    const at = clockLabel(status.batch_time);
    document.getElementById('nextRun').textContent = at
      ? `The old server build ran at ${at}; briefings are now built on demand in your browser.`
      : '';
  }

  renderVoices(voices, selected) {
    this.voices = voices;
    this.selectedVoice = selected;
    this.accent = 'All';
    const accents = ['All', ...new Set(voices.map((v) => v.accent).filter(Boolean))];
    document.getElementById('voiceFilters').replaceChildren(...accents.map((a) => h('button', {
      type: 'button', class: `chip-btn${a === 'All' ? ' active' : ''}`, 'aria-pressed': String(a === 'All'),
      onclick: (e) => {
        this.accent = a;
        document.querySelectorAll('#voiceFilters .chip-btn').forEach((b) => {
          b.classList.toggle('active', b === e.currentTarget);
          b.setAttribute('aria-pressed', String(b === e.currentTarget));
        });
        this.paintVoices();
      },
    }, a)));
    this.paintVoices();
    this.paintVoiceSummary();
  }

  paintVoiceSummary() {
    if (!this.voices) return;
    const v = this.voices.find((x) => x.id === this.selectedVoice);
    const name = v?.name || this.selectedVoice || 'Default';
    document.getElementById('voiceAvatar').textContent = name[0];
    document.getElementById('voiceSummary').textContent =
      [name, v?.accent, speedLabel(document.getElementById('speedRange').value)].filter(Boolean).join(' · ');
  }

  paintVoices() {
    const shown = this.voices.filter((v) => this.accent === 'All' || v.accent === this.accent);
    document.getElementById('voiceGrid').replaceChildren(...shown.map((v) => {
      const radio = h('input', { type: 'radio', name: 'voice', value: v.id, onchange: () => { this.selectedVoice = v.id; this.paintVoiceSummary(); } });
      radio.checked = v.id === this.selectedVoice;
      const btn = h('button', { type: 'button', class: 'preview-btn', 'aria-label': `Hear ${v.name}` }, icon('play'));
      btn.addEventListener('click', (e) => { e.preventDefault(); this.preview(v, btn); });
      return h('label', { class: 'voice-card', title: v.description || v.note || '' },
        radio,
        h('span', { class: 'avatar' }, v.name[0]),
        h('span', { class: 'v-text' },
          h('span', { class: 'v-name' }, v.name, v.recommended ? h('span', { class: 'badge' }, 'Recommended') : null),
          h('span', { class: 'v-meta' }, `${v.accent} · ${v.gender}`)),
        btn);
    }));
  }

  // Free BYOK keys for summaries + voice. Keys live in the user's own
  // profile settings; they're only ever sent to the provider they belong to.
  renderAI(settings) {
    const provSel = document.getElementById('llmProvider');
    const modelSel = document.getElementById('llmModel');
    const keys = settings.llm_keys || {};
    const provider = settings.llm_provider || 'groq';
    provSel.replaceChildren(...Object.entries(LLM_PROVIDERS).map(([k, p]) =>
      h('option', { value: k, selected: k === provider ? '' : null }, p.label)));
    const fillModels = () => {
      const p = LLM_PROVIDERS[provSel.value];
      const cur = settings.llm_model && p.models.includes(settings.llm_model) ? settings.llm_model : p.models[0];
      modelSel.replaceChildren(...p.models.map((m) => h('option', { value: m, selected: m === cur ? '' : null }, m)));
    };
    provSel.onchange = fillModels;
    fillModels();

    const box = document.getElementById('keyFields');
    box.replaceChildren(...Object.entries(LLM_PROVIDERS).map(([k, p]) => {
      const input = h('input', {
        type: 'password', class: 'text-input', id: `key-${k}`, placeholder: 'Paste key…',
        value: keys[k] || '', autocomplete: 'off', spellcheck: 'false',
        'aria-label': p.keyLabel,
      });
      const testBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Test');
      const hint = h('p', { class: 'hint' }, '');
      testBtn.addEventListener('click', async () => {
        const key = input.value.trim();
        if (!key) { hint.textContent = 'Paste a key first.'; return; }
        testBtn.disabled = true;
        hint.textContent = 'Checking…';
        try {
          // Test the model that's actually selected for summaries when this is
          // the chosen provider; otherwise the provider's default. Reasoning
          // models (gpt-oss, Gemini 3.x) need token headroom to think, so the
          // tiny-budget test that used to be here came back empty.
          const model = (k === provSel.value && modelSel.value) || LLM_PROVIDERS[k].models[0];
          const r = await fetch('/api/llm', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: k, apiKey: key, model, maxTokens: 60, json: false,
              messages: [{ role: 'user', content: 'Reply with the word ok.' }],
            }),
          });
          const data = await r.json().catch(() => ({}));
          hint.textContent = r.ok ? 'Key works ✓' : `Failed: ${data.error || r.status}`;
        } catch (err) { hint.textContent = `Failed: ${err.message}`; }
        testBtn.disabled = false;
      });
      return h('div', { class: 'key-row' },
        h('h4', {}, h('label', { for: `key-${k}` }, p.keyLabel),
          h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'key-link' }, 'Get one →')),
        h('div', { class: 'input-row' }, input, testBtn),
        hint);
    }));
  }

  async preview(voice, btn) {
    const a = this.previewAudio;
    const done = () => btn.classList.remove('loading');
    document.querySelectorAll('.preview-btn.loading').forEach((b) => b.classList.remove('loading'));
    if (this.previewVoice === voice.id && !a.paused) { a.pause(); return; }
    this.previewVoice = voice.id;
    btn.classList.add('loading');
    a.playbackRate = Number(document.getElementById('speedRange').value) || 1;
    try {
      let src = voice.preview_url;
      if (!src) {
        // Synthesize a sample on the fly with the user's own key.
        const [provider, vname] = voice.id.split(':');
        const key = (this.settings.llm_keys || {})[provider] || '';
        if (!key) throw new Error(`Add your ${LLM_PROVIDERS[provider].label} key above first.`);
        const r = await fetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: key, voice: vname, text: 'Good morning! This is what your briefing will sound like.' }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Voice failed (${r.status})`);
        src = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'audio/wav' }));
      }
      a.src = src;
      a.onplaying = done;
      a.onerror = () => { done(); toast("Couldn't play that voice sample.", { error: true }); };
      await a.play();
    } catch (err) { done(); toast(err.message, { error: true }); }
  }

  renderSteppers(stories) {
    this.stories = { ...stories };
    document.getElementById('storySteppers').replaceChildren(
      ...Object.keys(SECTIONS).map((key) => {
        const label = sectionLabel(key);
        this.stories[key] ??= 0;
        const out = h('output', {}, this.stories[key] || 'Off');
        const step = (d) => { this.stories[key] = Math.max(0, Math.min(10, this.stories[key] + d)); out.textContent = this.stories[key] || 'Off'; };
        return h('div', { class: 'stepper' }, h('span', {}, label),
          h('div', { class: 'stepper-ctrl' },
            h('button', { type: 'button', 'aria-label': `Fewer ${label} stories`, onclick: () => step(-1) }, '−'),
            out,
            h('button', { type: 'button', 'aria-label': `More ${label} stories`, onclick: () => step(1) }, '+')));
      }),
    );
  }

  async save() {
    const voice = this.selectedVoice;
    const lat = parseFloat(document.getElementById('latInput').value);
    const lon = parseFloat(document.getElementById('lonInput').value);
    const llm_keys = {};
    for (const k of Object.keys(LLM_PROVIDERS)) {
      const v = document.getElementById(`key-${k}`)?.value.trim();
      if (v) llm_keys[k] = v;
      else if (this.settings.llm_keys?.[k]) llm_keys[k] = this.settings.llm_keys[k];
    }
    const body = {
      voice,
      speed: Number(document.getElementById('speedRange').value),
      name: document.getElementById('nameInput').value.trim().slice(0, 40),
      daily: document.getElementById('dailyOn').checked,
      weather: document.getElementById('weatherOn').checked,
      say_sources: document.getElementById('saySourcesOn').checked,
      city: document.getElementById('cityInput').value.trim() || 'Toronto',
      stories: this.stories,
      llm_provider: document.getElementById('llmProvider').value,
      llm_model: document.getElementById('llmModel').value,
      llm_keys,
    };
    if (Number.isFinite(lat)) body.latitude = lat;
    if (Number.isFinite(lon)) body.longitude = lon;
    try {
      const res = await api.saveSettings(body);
      const voiceChanged = voice !== this.settings.voice || body.speed !== this.settings.speed;
      toast(voiceChanged ? 'Saved. Your next briefing will use the new voice.' : 'Saved. Changes apply from the next briefing.');
      this.dialog.close();
      return res;
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
}

/* ----------------------------------------------------------- Delete account */
class DeleteAccountSheet {
  constructor() {
    this.dialog = document.getElementById('deleteSheet');
    this.box = document.getElementById('deleteConfirm');
    this.go = document.getElementById('deleteGo');
    // Like wireSheet, but nothing closes it while the deletion is running.
    this.dialog.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => this.dialog.close()));
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog && !this.busy) this.dialog.close(); });
    this.box.addEventListener('change', () => { this.go.disabled = !this.box.checked; });
    document.getElementById('deleteForm').addEventListener('submit', (e) => { e.preventDefault(); this.run(); });
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
const STEP_TITLE = { name: 'Welcome 👋', sources: 'Your news', morning: "You're all set" };

// "Tomorrow at 5:30 a.m." from the worker's next run (ISO, in the server's time zone).
function whenLabel(status) {
  const next = status?.next_run ? new Date(status.next_run) : null;
  const at = next && !Number.isNaN(next.getTime())
    ? next.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
    : clockLabel(status?.batch_time);
  if (!at) return 'Tomorrow morning';
  const today = new Date().toDateString();
  return next && next.toDateString() === today ? `Today at ${at}` : `Tomorrow at ${at}`;
}

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

  // askName: first visit, all three steps. Otherwise only the morning step (e.g. after installing on iPhone).
  open(status, { askName = true } = {}) {
    this.status = status;
    this.steps = askName ? ['name', 'sources', 'morning'] : ['morning'];
    this.disabled = null; // built-in source ids left out; null until the sources step has loaded
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
    if (askName) this.loadSources();
  }

  show(i) {
    this.i = i;
    const step = this.steps[i];
    this.dialog.querySelectorAll('.welcome-step').forEach((el) => el.classList.toggle('hidden', el.dataset.step !== step));
    this.dialog.querySelectorAll('#welcomeDots span').forEach((d, j) => d.classList.toggle('on', j === i));
    document.getElementById('welcomeTitle').textContent = this.steps.length > 1 ? STEP_TITLE[step] : 'Morning notification';
    const last = i === this.steps.length - 1;
    document.getElementById('welcomeGo').textContent = last ? 'Done' : 'Next';
    document.getElementById('welcomeBack').textContent = i === 0 ? 'Skip' : 'Back';
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
    box.replaceChildren(h('p', { class: 'hint' }, 'Loading sources…'));
    try {
      const { sources } = await api.sources();
      this.sources = sources.filter((s) => s.builtin);
      this.disabled = new Set(this.sources.filter((s) => !s.enabled).map((s) => s.id));
      this.paintSources();
    } catch (err) {
      box.replaceChildren(h('p', { class: 'hint' }, `Couldn't load the source list (${err.message}). You can pick them later in Sources.`));
    }
  }

  paintSources() {
    const groups = Object.fromEntries(Object.keys(SECTIONS).filter((k) => k !== 'custom' && k !== 'follow').map((k) => [k, []]));
    this.sources.forEach((s) => groups[s.section]?.push(s));
    document.getElementById('welcomeSources').replaceChildren(...Object.entries(groups).filter(([, items]) => items.length).map(([key, items]) => {
      const count = h('span', { class: 'tag' });
      const paintCount = () => { count.textContent = `${items.filter((s) => !this.disabled.has(s.id)).length} of ${items.length}`; };
      paintCount();
      return h('section', { class: 'source-pick' },
        h('h3', {}, sectionLabel(key), count),
        h('div', { class: 'chip-row' }, items.map((s) => {
          const chip = h('button', { type: 'button', class: 'source-chip', 'aria-pressed': String(!this.disabled.has(s.id)) }, s.name);
          chip.addEventListener('click', () => {
            if (this.disabled.has(s.id)) this.disabled.delete(s.id); else this.disabled.add(s.id);
            chip.setAttribute('aria-pressed', String(!this.disabled.has(s.id)));
            paintCount();
          });
          return chip;
        })));
    }), this.added ? h('p', { class: 'hint' }, `⭐ ${this.added} of your own ${this.added === 1 ? 'link' : 'links'} added.`) : '');
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
      toast('Added. It will be read at the next morning build.');
      if (this.sources) this.paintSources();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  paintMorning() {
    document.getElementById('welcomeWhen').textContent = whenLabel(this.status);
    const on = this.sources ? this.sources.filter((s) => !this.disabled.has(s.id)).length + this.added : null;
    document.getElementById('welcomeWhat').textContent = on != null
      ? `The top stories from your ${on} sources, summarised and read aloud in about five minutes.`
      : 'The top stories, summarised and read aloud in about five minutes.';
  }

  async finish(save) {
    const err = document.getElementById('welcomeError');
    const name = document.getElementById('welcomeName').value.trim().slice(0, 40);
    const wantPush = save && this.offeredPush && document.getElementById('welcomePushOn').checked;
    const btn = document.getElementById('welcomeGo');
    btn.disabled = true;
    try {
      if (wantPush) {
        try { await enablePush(this.status?.vapid_public_key); } catch (e) { toast(`Notifications are off: ${e.message}`, { error: true, ms: 6000 }); }
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

// Settings tab: a full page mirroring the Android SettingsScreen.
// What's left is what still does something: the daily brief, the narrator, appearance and
// the account. The BYOK voice list and the AI-key panel went with the builder they served.
import { api, h, icon, toast, VOICES, voiceFor } from '../api.js';
import { clipUrl } from '../storypack.js';
import {
  GlassGroup, Hairline, Hint, ListRow, Overline, PillButton, PillStepper,
  SectionLabel, Segmented, SwitchRow, Tag, applyPhotoMode,
} from '../design.js';
import { enablePush, pushSupported } from '../sheets.js';

const speedLabel = (v) => `${Number(v).toFixed(2).replace(/0$/, '')}×`;

export class SettingsPage {
  constructor({ onDirty, goSources, email, setRate }) {
    this.onDirty = onDirty;
    this.goSources = goSources;
    this.email = email || '';
    this.setRate = setRate || (() => {});
    this.root = document.querySelector('#page-settings .screen');
    this.saved = null;
    this.draft = null;
    this.previewAudio = new Audio();
    this.notes = null;      // today's greeting per voice, for the "hear it" buttons
    this.notesDay = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const { settings } = await api.settings();
    this.saved = JSON.parse(JSON.stringify(settings));
    this.draft = JSON.parse(JSON.stringify(settings));
    this.loaded = true;
    this.render();
    this.refreshPush();
  }

  reload() { this.loaded = false; return this.load(); }

  isDirty() {
    return this.loaded && JSON.stringify(this.saved) !== JSON.stringify(this.draft);
  }

  markDirty() { this.onDirty?.(); }

  set(patch) {
    Object.assign(this.draft, patch);
    this.markDirty();
    this.render();
  }

  async save() {
    await api.saveSettings(this.draft);
    this.saved = JSON.parse(JSON.stringify(this.draft));
    applyPhotoMode(this.draft.color_photos);
    this.markDirty();
    this.render();
    toast('Saved. Changes apply from the next briefing.');
  }

  discard() {
    this.draft = JSON.parse(JSON.stringify(this.saved));
    this.markDirty();
    this.render();
  }

  /* ------------------------------------------------------------------ push */
  async refreshPush() {
    const row = document.getElementById('pushRow');
    if (!row) return;
    const supported = pushSupported();
    const hint = document.getElementById('pushHint');
    if (!supported) {
      hint.textContent = 'Notifications need HTTPS and an installed app.';
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      this.pushOn = !!sub && Notification.permission === 'granted';
    } catch { this.pushOn = false; }
    hint.textContent = Notification.permission === 'denied' ? 'Notifications are blocked in this browser\u2019s site settings.' : '';
    this.render();
  }

  async setPush(on) {
    const hint = document.getElementById('pushHint');
    try {
      if (!on) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api.pushUnsubscribe(sub.toJSON()); await sub.unsubscribe(); }
        this.pushOn = false;
        this.render();
        return;
      }
      const { status } = await api.status().catch(() => ({}));
      await enablePush(status?.vapid_public_key);
      this.pushOn = true;
      hint.textContent = 'You will be notified when your briefing is ready.';
      this.render();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async testPush(btn) {
    btn.disabled = true;
    const hint = document.getElementById('pushHint');
    hint.textContent = 'Sending a test…';
    try {
      const r = await api.pushTest();
      hint.textContent = r.message || 'Sent.';
    } catch (err) { hint.textContent = err.message; }
    finally { btn.disabled = false; }
  }

  /* --------------------------------------------------------------- rendering */
  render() {
    if (!this.draft) return;
    const d = this.draft;
    const total = Object.values(d.stories || {}).reduce((n, v) => n + (Number(v) || 0), 0);
    this.root.replaceChildren(
      h('header', { class: 'screen-header' },
        h('div', { class: 'overline-row' }, Overline(d.daily ? 'Daily brief on' : 'Daily brief off')),
        h('h1', { class: 'display' }, 'Settings')),

      SectionLabel('Brief'),
      GlassGroup(
        SwitchRow('Make one every morning', d.daily, { onChange: (on) => this.set({ daily: on }) }),
        Hairline(),
        SwitchRow('Notify this device when it\u2019s ready', !!this.pushOn, {
          detail: 'A morning nudge when your briefing is done',
          onChange: (on) => this.setPush(on),
        }),
        h('div', { class: 'push-test-row hidden', id: 'pushRow' },
          PillButton('Send a test notification', { filled: false, onClick: (e) => this.testPush(e.currentTarget) })),
        h('p', { class: 'hint', id: 'pushHint' }),
        Hairline(),
        ListRow({
          label: 'Topics and story counts',
          value: total ? `${total} stories` : 'None yet',
          caret: true,
          onClick: () => this.goSources(),
        }),
      ),

      SectionLabel('Voice'),
      this.voiceGroup(d),

      SectionLabel('Appearance'),
      this.appearanceGroup(d),

      SectionLabel('Account'),
      GlassGroup(
        ListRow({ label: this.email || 'Signed in', end: Tag('SYNCED') }),
        Hairline(),
        ListRow({ label: 'Sign out', color: 'var(--err)', onClick: async () => { await api.signOut(); location.reload(); } }),
        Hairline(),
        ListRow({ label: 'Delete account', color: 'var(--err)', onClick: () => this.openDelete() }),
      ),

      h('div', { class: 'legal-row' },
        h('span', { class: 'hint' }, 'Morning Brief for web'),
        h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy'),
        h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms')),
    );
    // Push test row visibility depends on push state.
    const pr = document.getElementById('pushRow');
    if (pr) pr.classList.toggle('hidden', !this.pushOn);
  }

  /**
   * Who reads the brief. The pack records both narrators every morning, so switching picks
   * which recording plays — it isn't a per-listener voice, and it costs nothing extra.
   */
  voiceGroup(d) {
    const id = voiceFor(d.voice).id;
    const rows = VOICES.map((v) => {
      const on = v.id === id;
      const row = h('button', {
        type: 'button', class: `voice-row${on ? ' on' : ''}`, 'aria-pressed': String(on),
      },
      h('span', { class: 'avatar' }, v.name[0]),
      h('span', { class: 'v-text' },
        h('span', { class: 'v-name' }, v.name),
        h('span', { class: 'v-meta' }, v.gender === 'female' ? 'A woman reads the news' : 'A man reads the news')),
      h('span', { class: 'preview-btn', role: 'button', tabindex: '0', 'aria-label': `Hear ${v.name}` }, icon('play')));
      row.addEventListener('click', (e) => {
        if (e.target.closest('.preview-btn')) return;
        this.set({ voice: v.id });
      });
      row.querySelector('.preview-btn').addEventListener('click', (e) => { e.stopPropagation(); this.preview(v); });
      return row;
    });

    const speed = Math.round(d.speed * 20);
    return GlassGroup(
      h('div', { class: 'voice-list' }, ...rows),
      Hairline(),
      Hint('Both voices are recorded each morning from the same stories, so switching only changes who you hear. It starts with your next brief.'),
      Hairline(),
      ListRow({
        label: 'Playback speed',
        end: PillStepper(speedLabel(speed / 20), {
          canLower: speed > 16, canRaise: speed < 26,
          lowerLabel: 'Slower', raiseLabel: 'Faster',
          onLower: () => this.setSpeed((speed - 1) / 20),
          onRaise: () => this.setSpeed((speed + 1) / 20),
        }),
      }),
    );
  }

  /** Speed is something you can hear straight away, so it doesn't wait for Save. */
  setSpeed(v) {
    const speed = Math.max(0.8, Math.min(1.3, Math.round(v * 100) / 100));
    this.set({ speed });
    this.setRate(speed);
  }

  /** Play today's greeting in a voice: the real recording, so what you hear is what you get. */
  async preview(voice) {
    const a = this.previewAudio;
    a.pause();
    try {
      const today = new Date().toLocaleDateString('en-CA');
      if (this.notesDay !== today || !this.notes) {
        this.notes = await api.voiceNotes(today);
        this.notesDay = today;
      }
      const note = this.notes.find((n) => n.voice === voice.id && n.note_key === 'greeting_morning');
      if (!note) throw new Error(`${voice.name}'s recording for today isn't ready yet. Try again in a few minutes.`);
      a.src = clipUrl(note.audio_path);
      await a.play();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  appearanceGroup(d) {
    let stored = null;
    try { stored = localStorage.getItem('mb-theme'); } catch { /* ignore */ }
    const seg = Segmented(['Light', 'Dark', 'System'],
      stored === 'light' ? 0 : stored === 'dark' ? 1 : 2,
      {
        glass: true,
        onSelect: (i) => {
          const pref = ['light', 'dark', 'system'][i];
          const resolved = pref === 'system'
            ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
          document.documentElement.dataset.theme = resolved;
          try {
            if (pref === 'system') localStorage.removeItem('mb-theme');
            else localStorage.setItem('mb-theme', pref);
          } catch { /* ignore */ }
          document.dispatchEvent(new CustomEvent('mb-theme', { detail: pref }));
        },
      });
    return h('div', { class: 'appearance-section' }, seg,
      GlassGroup(SwitchRow('Color story photos', d.color_photos !== false, {
        detail: 'Cover and thumbnails in full color',
        onChange: (on) => this.set({ color_photos: on }),
      })));
  }

  openDelete() {
    document.getElementById('deleteSheet').showModal();
  }
}

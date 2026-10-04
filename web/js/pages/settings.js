// Settings tab: a full page mirroring the Android SettingsScreen.
// Brief, voice, greeting & weather, appearance, account, advanced (AI keys).
import { api, h, icon, toast } from '../api.js';
import { LLM_PROVIDERS, VOICES } from '../brief.js';
import {
  GlassGroup, Hairline, Hint, ListRow, Overline, PillButton, PillStepper,
  SectionLabel, Segmented, SwitchRow, Tag,
} from '../design.js';
import { enablePush, pushSupported } from '../sheets.js';

const speedLabel = (v) => `${Number(v).toFixed(2).replace(/0$/, '')}×`;

export class SettingsPage {
  constructor({ onDirty, goSources, email }) {
    this.onDirty = onDirty;
    this.goSources = goSources;
    this.email = email || '';
    this.root = document.querySelector('#page-settings .screen');
    this.saved = null;
    this.draft = null;
    this.voiceOpen = false;
    this.aiOpen = false;
    this.cityOpen = false;
    this.previewAudio = new Audio();
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
        SwitchRow('Say where each story is from', !!d.say_sources, { onChange: (on) => this.set({ say_sources: on }) }),
        Hairline(),
        ListRow({ label: 'Topics and story counts', caret: true, onClick: () => this.goSources() }),
      ),

      SectionLabel('Voice'),
      this.voiceGroup(d),

      SectionLabel('Greeting and weather'),
      this.weatherGroup(d),

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

      SectionLabel('Advanced'),
      this.aiGroup(d),

      h('div', { class: 'legal-row' },
        h('span', { class: 'hint' }, 'Morning Brief for web'),
        h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy'),
        h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms')),
    );
    // Push test row visibility depends on push state.
    const pr = document.getElementById('pushRow');
    if (pr) pr.classList.toggle('hidden', !this.pushOn);
  }

  voiceGroup(d) {
    const v = VOICES.find((x) => x.id === d.voice) || VOICES[0];
    const value = `${v.name} · ${v.accent}`;
    const rows = [
      ListRow({
        label: 'Voice', value, caret: !this.voiceOpen,
        onClick: () => { this.voiceOpen = !this.voiceOpen; this.render(); },
      }),
    ];
    if (this.voiceOpen) {
      const list = h('div', { class: 'voice-list' });
      for (const voice of VOICES) {
        const on = voice.id === d.voice;
        const row = h('button', { type: 'button', class: 'voice-row' + (on ? ' on' : '') },
          h('span', { class: 'avatar' }, voice.name[0]),
          h('span', { class: 'v-text' },
            h('span', { class: 'v-name' }, voice.name, voice.recommended ? h('span', { class: 'badge' }, 'Recommended') : null),
            h('span', { class: 'v-meta' }, `${voice.accent} · ${voice.gender}`)),
          h('span', { type: 'button', class: 'preview-btn', role: 'button', 'aria-label': `Hear ${voice.name}`, tabindex: '0' }, icon('play')));
        row.addEventListener('click', (e) => {
          if (e.target.closest('.preview-btn')) return;
          this.set({ voice: voice.id });
          this.preview(voice);
        });
        row.querySelector('.preview-btn').addEventListener('click', (e) => { e.stopPropagation(); this.preview(voice); });
        list.append(row);
      }
      rows.push(h('div', { class: 'expandable' }, list));
      rows.push(Hairline());
    } else {
      rows.push(Hairline());
    }
    const speed = Math.round(d.speed * 20);
    rows.push(ListRow({
      label: 'Playback speed',
      end: PillStepper(speedLabel(speed / 20), {
        canLower: speed > 16, canRaise: speed < 26,
        lowerLabel: 'Slower', raiseLabel: 'Faster',
        onLower: () => this.set({ speed: (speed - 1) / 20 }),
        onRaise: () => this.set({ speed: (speed + 1) / 20 }),
      }),
    }));
    return GlassGroup(...rows);
  }

  async preview(voice) {
    const a = this.previewAudio;
    a.pause();
    a.playbackRate = Number(this.draft.speed) || 1;
    try {
      let src = voice.preview_url;
      if (!src) {
        const [provider, vname] = voice.id.split(':');
        const key = (this.draft.llm_keys || {})[provider] || '';
        if (!key) throw new Error(`Add your ${LLM_PROVIDERS[provider].label} key below first.`);
        const r = await fetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, apiKey: key, voice: vname, text: 'Good morning! This is what your briefing will sound like.' }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Voice failed (${r.status})`);
        src = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'audio/wav' }));
      }
      a.src = src;
      await a.play();
    } catch (err) { toast(err.message, { error: true }); }
  }

  weatherGroup(d) {
    const nameInput = h('input', {
      type: 'text', class: 'inline-input', value: d.name || '', maxlength: '40',
      placeholder: 'For the greeting', 'aria-label': 'Your name', autocomplete: 'given-name',
    });
    nameInput.addEventListener('input', () => { this.draft.name = nameInput.value.slice(0, 40); this.markDirty(); });
    const rows = [
      h('div', { class: 'list-row' },
        h('div', { class: 'list-row-text' }, h('span', { class: 'list-row-label' }, 'Your name')),
        nameInput),
      Hairline(),
      SwitchRow('Start with the weather', !!d.weather, { onChange: (on) => this.set({ weather: on }) }),
    ];
    if (d.weather) {
      rows.push(Hairline());
      rows.push(ListRow({
        label: 'Weather city', value: d.city || 'Not set', caret: !this.cityOpen,
        onClick: () => { this.cityOpen = !this.cityOpen; this.render(); },
      }));
      if (this.cityOpen) {
        const cityInput = h('input', {
          type: 'text', class: 'pill-field', value: d.city || '',
          placeholder: 'City', 'aria-label': 'Weather city',
        });
        cityInput.addEventListener('input', () => { this.draft.city = cityInput.value; this.markDirty(); });
        rows.push(h('div', { class: 'expandable' }, cityInput,
          Hint('Used for the weather in your intro and local stories.')));
      }
    }
    return GlassGroup(...rows);
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
      GlassGroup(SwitchRow('Color story photos', !!d.color_photos, {
        detail: 'Thumbnails in full color; the large cover stays black and white',
        onChange: (on) => this.set({ color_photos: on }),
      })));
  }

  aiGroup(d) {
    const on = !(d.llm_keys && Object.keys(d.llm_keys).length === 0) || !!d.llm_provider;
    const detail = d.llm_provider ? `On, with ${LLM_PROVIDERS[d.llm_provider]?.label || d.llm_provider}` : 'Off';
    const rows = [
      ListRow({
        label: 'AI-written summaries', detail, caret: !this.aiOpen,
        onClick: () => { this.aiOpen = !this.aiOpen; this.render(); },
      }),
    ];
    if (this.aiOpen) {
      const p = LLM_PROVIDERS[d.llm_provider] || LLM_PROVIDERS.groq;
      const provSel = h('select', { class: 'pill-field', 'aria-label': 'AI provider' },
        ...Object.entries(LLM_PROVIDERS).map(([k, pr]) =>
          h('option', { value: k, selected: k === d.llm_provider ? '' : null }, pr.label)));
      const modelSel = h('select', { class: 'pill-field', 'aria-label': 'AI model' });
      const fillModels = () => {
        const pp = LLM_PROVIDERS[provSel.value];
        const cur = pp.models.includes(d.llm_model) ? d.llm_model : pp.models[0];
        modelSel.replaceChildren(...pp.models.map((m) => h('option', { value: m, selected: m === cur ? '' : null }, m)));
      };
      provSel.addEventListener('change', () => {
        this.draft.llm_provider = provSel.value;
        fillModels();
        this.draft.llm_model = modelSel.value;
        this.markDirty();
        this.render();
      });
      modelSel.addEventListener('change', () => this.set({ llm_model: modelSel.value }));
      fillModels();

      const keyRows = h('div', { class: 'key-rows' });
      for (const [k, pr] of Object.entries(LLM_PROVIDERS)) {
        const input = h('input', {
          type: 'password', class: 'pill-field', placeholder: 'Paste key…',
          value: (d.llm_keys || {})[k] || '', autocomplete: 'off', spellcheck: 'false',
          'aria-label': pr.keyLabel,
        });
        const testBtn = PillButton('Test', { filled: false });
        const hint = Hint('');
        testBtn.addEventListener('click', async () => {
          const key = input.value.trim();
          if (!key) { hint.textContent = 'Paste a key first.'; return; }
          testBtn.disabled = true;
          hint.textContent = 'Checking…';
          try {
            const model = (k === provSel.value && modelSel.value) || pr.models[0];
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
        input.addEventListener('input', () => {
          this.draft.llm_keys = { ...(this.draft.llm_keys || {}) };
          if (input.value.trim()) this.draft.llm_keys[k] = input.value.trim();
          else delete this.draft.llm_keys[k];
          this.markDirty();
        });
        keyRows.append(
          h('div', { class: 'key-row' },
            h('div', { class: 'key-head' },
              h('label', {}, pr.keyLabel),
              h('a', { href: pr.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'key-link' }, 'Get one →')),
            h('div', { class: 'input-row' }, input, testBtn),
            hint));
      }
      rows.push(h('div', { class: 'expandable' },
        h('div', { class: 'input-row' }, provSel, modelSel),
        Hint('Your key, your quota. Keys are sent to the AI service only when building a briefing.'),
        keyRows));
    }
    return GlassGroup(...rows);
  }

  openDelete() {
    document.getElementById('deleteSheet').showModal();
  }
}

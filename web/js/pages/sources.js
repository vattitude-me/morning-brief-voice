// Sources tab: a full page mirroring the Android SourcesScreen.
// Your picks (links) and expandable topic cards, each with its own story count.
import { SECTIONS, api, h, icon, toast } from '../api.js';
import { CheckDot, Chip, GlassGroup, Hairline, Hint, Overline, PillButton, SectionLabel, StoryStepper } from '../design.js';

const MAX_PER_SECTION = 5;
const TOPIC_KEYS = ['top', 'ai', 'tech', 'politics', 'entertainment', 'science', 'sports'];
// "My Sources" (links people paste in) is parked while the seven default categories settle.
// Everything it needs is still below — flip this back to true to restore the card.
const SHOW_MY_SOURCES = false;
const LINK_EXAMPLES = ['cbc.ca/sports/hockey/nhl', 'theglobeandmail.com', 'techcrunch.com'];

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

export class SourcesPage {
  constructor({ onDirty }) {
    this.onDirty = onDirty;
    this.root = document.querySelector('#page-sources .screen');
    this.saved = null;
    this.draft = null;
    this.sources = [];
    this.expanded = new Set();
    this.city = '';
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const [{ settings }, { sources }] = await Promise.all([api.settings(), api.sources()]);
    this.city = settings.city || '';
    this.sources = sources;
    const rawOrder = Array.isArray(settings.section_order) ? settings.section_order : [];
    const order = [
      ...rawOrder.filter((k) => TOPIC_KEYS.includes(k)),
      ...TOPIC_KEYS.filter((k) => !rawOrder.includes(k)),
    ];
    this.saved = {
      stories: { ...settings.stories },
      section_order: [...order],
      enabled: Object.fromEntries(sources.map((s) => [s.id, !!s.enabled])),
    };
    this.draft = {
      stories: { ...settings.stories },
      section_order: [...order],
      enabled: { ...this.saved.enabled },
    };
    this.loaded = true;
    this.render();
  }

  reload() { this.loaded = false; return this.load(); }

  isDirty() {
    if (!this.draft) return false;
    if (JSON.stringify(this.saved.section_order) !== JSON.stringify(this.draft.section_order)) return true;
    const keys = new Set([...Object.keys(this.saved.stories), ...Object.keys(this.draft.stories)]);
    for (const k of keys) if ((this.saved.stories[k] || 0) !== (this.draft.stories[k] || 0)) return true;
    for (const id of Object.keys(this.draft.enabled)) {
      if (!!this.draft.enabled[id] !== !!this.saved.enabled[id]) return true;
    }
    return false;
  }

  markDirty() { this.onDirty?.(); }

  async save() {
    const changedToggles = this.sources.filter((s) => !!this.draft.enabled[s.id] !== !!this.saved.enabled[s.id]);
    await api.saveSettings({ stories: this.draft.stories, section_order: this.draft.section_order });
    for (const s of changedToggles) await api.updateSource(s, { enabled: this.draft.enabled[s.id] });
    this.saved = {
      stories: { ...this.draft.stories },
      section_order: [...this.draft.section_order],
      enabled: { ...this.draft.enabled },
    };
    this.markDirty();
    this.render();
  }

  discard() {
    this.draft = {
      stories: { ...this.saved.stories },
      section_order: [...this.saved.section_order],
      enabled: { ...this.saved.enabled },
    };
    this.markDirty();
    this.render();
  }

  moveTopic(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const list = [...this.draft.section_order];
    const [item] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, item);
    this.draft.section_order = list;
    this.markDirty();
    this.render();
  }

  setStories(key, n) {
    this.draft.stories[key] = Math.max(0, Math.min(MAX_PER_SECTION, n));
    this.markDirty();
    this.render();
  }

  toggleSource(id, on) {
    this.draft.enabled[id] = on;
    this.markDirty();
    this.render();
  }

  on(src) { return !!this.draft.enabled[src.id]; }

  /* ------------------------------------------------------------ rendering */
  render() {
    if (!this.draft) return;
    const order = this.draft.section_order || TOPIC_KEYS;
    this.root.replaceChildren(
      this.header(),
      Hint('Drag topics to set playback order, adjust story counts, or open one to review sources.'),
      ...(SHOW_MY_SOURCES ? [this.picks()] : []),
      GlassGroup(...order.flatMap((key, i) => [
        ...(i ? [Hairline()] : []),
        this.topic(key, i),
      ])),
    );
  }

  header() {
    return h('header', { class: 'screen-header' },
      h('div', { class: 'overline-row' }, Overline('Synced to your account')),
      h('h1', { class: 'display' }, 'Sources'),
      h('p', { class: 'subtitle' }, "What goes into tomorrow's brief."));
  }

  picks() {
    const n = this.draft.stories.custom || 0;
    const stepper = StoryStepper(n, true, MAX_PER_SECTION, (v) => this.setStories('custom', v));
    const label = SectionLabel(SECTIONS.custom.title, {
      detail: 'Paste any news link: a site, section, feed or single article.',
      end: stepper,
    });

    const input = h('input', {
      type: 'text', class: 'pill-field', placeholder: 'Paste a news link…',
      'aria-label': 'News link to add', inputmode: 'url', autocapitalize: 'off', spellcheck: 'false',
    });
    const addBtn = h('button', { type: 'button', class: 'ink-circle sm', 'aria-label': 'Add link' }, icon('plus'));
    let working = false;
    const go = async () => {
      if (working) return;
      let url = input.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try { url = new URL(url).href; } catch { toast("That doesn't look like a web link.", { error: true }); return; }
      working = true;
      addBtn.classList.add('busy');
      try {
        await api.addSource({ url, section: 'custom' });
        const { sources } = await api.sources();
        this.sources = sources;
        for (const s of sources) if (!(s.id in this.draft.enabled)) this.draft.enabled[s.id] = !!s.enabled;
        input.value = '';
        toast('Saved to your sources.');
        this.render();
      } catch (err) { toast(err.message, { error: true }); }
      finally { working = false; addBtn.classList.remove('busy'); }
    };
    addBtn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const addField = h('div', { class: 'add-field' }, input, addBtn);

    const mine = this.sources.filter((s) => s.section === 'custom');
    const chips = mine.length === 0
      ? h('div', { class: 'chip-flow' }, ...LINK_EXAMPLES.map((ex) => Chip(ex, { onClick: () => { input.value = ex; input.focus(); } })))
      : null;
    const list = mine.length
      ? GlassGroup(...mine.flatMap((s, i) => [
          ...(i > 0 ? [Hairline()] : []),
          this.sourceRow(s, () => this.confirmRemove(s)),
        ]))
      : null;
    const offHint = n === 0 && mine.length > 0
      ? Hint('Your picks are set to Off, so these won\'t be in your brief.', 'var(--err)') : null;
    return h('section', { class: 'picks-section' }, label, addField, chips, list, offHint);
  }

  topic(key, index) {
    const sec = SECTIONS[key] || { title: key, icon: 'globe' };
    const n = this.draft.stories[key] || 0;
    const items = this.sources.filter((s) => s.section === key);
    const open = this.expanded.has(key) && items.length > 0;
    const city = (this.city || '').split(',')[0].trim();
    const label = key === 'local' && city ? `${sec.title} · ${city}` : sec.title;

    const sourceCount = items.length ? `${items.length} ${items.length === 1 ? 'source' : 'sources'}` : '';
    const storyCount = n === 0 ? 'Off' : `${n} ${n === 1 ? 'story' : 'stories'}`;
    const summary = sourceCount ? `${sourceCount} · ${storyCount}` : storyCount;
    const toggle = () => {
      if (!items.length) return;
      if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
      this.render();
    };

    const dragHandle = h('span', {
      class: 'drag-handle',
      title: 'Drag to reorder topics (or press Arrow Up/Down)',
      'aria-label': `Reorder ${label}`,
      role: 'button',
      tabindex: '0',
    }, icon('drag'));

    dragHandle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && index > 0) {
        e.preventDefault();
        this.moveTopic(index, index - 1);
      } else if (e.key === 'ArrowDown' && index < this.draft.section_order.length - 1) {
        e.preventDefault();
        this.moveTopic(index, index + 1);
      }
    });

    const catTile = h('span', { class: `cat-tile sm cat-${key}` }, icon(sec.icon || 'globe'));

    const head = h('div', { class: 'topic-head' },
      dragHandle,
      catTile,
      h('button', { type: 'button', class: 'topic-toggle', 'aria-expanded': String(open), disabled: !items.length },
        h('span', { class: 'topic-title' }, label),
        h('span', { class: 'topic-summary' }, summary)),
      StoryStepper(n, true, MAX_PER_SECTION, (v) => this.setStories(key, v)),
      items.length ? h('button', {
        type: 'button', class: 'topic-expand', 'aria-label': `${open ? 'Hide' : 'Show'} ${label} sources`,
        'aria-expanded': String(open),
      }, h('span', { class: 'caret' + (open ? ' open' : ''), 'aria-hidden': 'true' }, icon(open ? 'chev-d' : 'chev-r'))) : null);
    head.querySelector('.topic-toggle').addEventListener('click', toggle);
    head.querySelector('.topic-expand')?.addEventListener('click', toggle);

    const card = h('section', {
      class: 'topic-card' + (n === 0 ? ' off' : ''),
      draggable: 'true',
      'data-key': key,
      'data-index': String(index),
    }, head);

    card.addEventListener('dragstart', (e) => {
      this.draggedIndex = index;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this.root.querySelectorAll('.topic-card').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      this.draggedIndex = null;
    });

    card.addEventListener('dragover', (e) => {
      if (this.draggedIndex == null || this.draggedIndex === index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      card.classList.toggle('drag-over-top', e.clientY < mid);
      card.classList.toggle('drag-over-bottom', e.clientY >= mid);
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over-top', 'drag-over-bottom');
      if (this.draggedIndex == null || this.draggedIndex === index) return;
      const rect = card.getBoundingClientRect();
      const isAbove = e.clientY < (rect.top + rect.height / 2);
      let targetIndex = isAbove ? index : index + 1;
      if (this.draggedIndex < targetIndex) targetIndex--;
      this.moveTopic(this.draggedIndex, targetIndex);
    });

    // Touch support for reordering on mobile screens
    dragHandle.addEventListener('touchstart', () => {
      this.draggedIndex = index;
      card.classList.add('dragging');
    }, { passive: true });

    dragHandle.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetCard = target?.closest('.topic-card');
      this.root.querySelectorAll('.topic-card').forEach((el) => {
        if (el !== targetCard) el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      if (targetCard && targetCard !== card) {
        const rect = targetCard.getBoundingClientRect();
        const isAbove = touch.clientY < (rect.top + rect.height / 2);
        targetCard.classList.toggle('drag-over-top', isAbove);
        targetCard.classList.toggle('drag-over-bottom', !isAbove);
      }
    }, { passive: true });

    dragHandle.addEventListener('touchend', (e) => {
      card.classList.remove('dragging');
      const touch = e.changedTouches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetCard = target?.closest('.topic-card');
      if (targetCard && targetCard !== card && targetCard.dataset.index != null) {
        const tIndex = parseInt(targetCard.dataset.index, 10);
        const rect = targetCard.getBoundingClientRect();
        const isAbove = touch.clientY < (rect.top + rect.height / 2);
        let targetIndex = isAbove ? tIndex : tIndex + 1;
        if (this.draggedIndex < targetIndex) targetIndex--;
        this.moveTopic(this.draggedIndex, targetIndex);
      }
      this.root.querySelectorAll('.topic-card').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      this.draggedIndex = null;
    });
    if (open) {
      const body = h('div', { class: 'topic-body' }, Hairline());
      if (key === 'local') {
        const cityRow = h('button', { type: 'button', class: 'list-row clickable' },
          h('div', { class: 'list-row-text' }, h('span', { class: 'list-row-label' }, 'City')),
          h('span', { class: 'list-row-value' }, city || 'Not set'),
          h('span', { class: 'caret', 'aria-hidden': 'true' }, icon('chev-r')));
        cityRow.addEventListener('click', () => document.querySelector('[data-tab="settings"]')?.click());
        body.append(cityRow);
        if (items.length) body.append(Hairline());
      }
      items.forEach((s, i) => {
        if (i > 0) body.append(Hairline());
        body.append(this.sourceRow(s, null));
      });
      if (n === 0) body.append(Hint('This topic is off. Raise the count to include its stories.', 'var(--err)'));
      card.append(body);
    }
    return card;
  }

  sourceRow(s, onRemove) {
    const host = hostOf(s.url);
    const kind = s.kind === 'article' ? ' · single article' : s.kind === 'page' ? ' · page of links' : ' · feed';
    const row = h('div', { class: 'source-row' },
      h('div', { class: 'source-text' },
        h('span', { class: 'source-name' }, s.name),
        h('span', { class: 'tiny' }, `${host}${kind}`)),
      onRemove && !s.builtin
        ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Remove ${s.name}` }, icon('close'))
        : null,
      h('button', {
        type: 'button', class: 'check-dot' + (this.on(s) ? ' on' : ''),
        'aria-label': `${this.on(s) ? 'Turn off' : 'Turn on'} ${s.name}`,
        'aria-pressed': String(this.on(s)),
      }, this.on(s) ? icon('check') : null));
    const dot = row.querySelector('.check-dot');
    row.addEventListener('click', () => this.toggleSource(s.id, !this.on(s)));
    const rmBtn = row.querySelector('.icon-btn');
    if (rmBtn) rmBtn.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    dot.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSource(s.id, !this.on(s)); });
    return row;
  }

  confirmRemove(s) {
    const dlg = document.getElementById('confirmDialog');
    document.getElementById('confirmTitle').textContent = `Remove ${s.name}?`;
    document.getElementById('confirmBody').textContent = 'Its stories will no longer appear in your briefings.';
    const go = document.getElementById('confirmGo');
    go.textContent = 'Remove';
    const onGo = async () => {
      go.removeEventListener('click', onGo);
      try {
        await api.deleteSource(s.id);
        this.sources = this.sources.filter((x) => x.id !== s.id);
        delete this.draft.enabled[s.id];
        delete this.saved.enabled[s.id];
        this.markDirty();
        this.render();
      } catch (err) { toast(err.message, { error: true }); }
      dlg.close();
    };
    go.addEventListener('click', onGo);
    dlg.showModal();
  }
}

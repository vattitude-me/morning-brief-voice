// Shared UI primitives mirroring the Android app's Design.kt:
// glass panels, overlines, list rows, switches, steppers, segmented controls.
import { h, icon } from './api.js';

export const Overline = (text, color) =>
  h('span', { class: 'overline', ...(color ? { style: `color:${color}` } : {}) }, String(text).toUpperCase());

export const Hint = (text, color) =>
  h('p', { class: 'hint', ...(color ? { style: `color:${color}` } : {}) }, text);

export const Hairline = () => h('div', { class: 'hairline', 'aria-hidden': 'true' });

/** A frosted panel of rows separated by hairlines. */
export function GlassGroup(...children) {
  return h('div', { class: 'glass glass-group' }, ...children);
}

/** A section's label above its panel, with an optional detail line and control on the right. */
export function SectionLabel(text, { detail = null, end = null } = {}) {
  const left = h('div', { class: 'section-label-text' },
    h('span', { class: 'overline', style: 'color:var(--ink)' }, String(text).toUpperCase()),
    detail ? h('p', { class: 'meta' }, detail) : null);
  return h('div', { class: 'section-label' }, left, end);
}

/** A row in a GlassGroup: label, optional detail/value/caret, or a custom end. */
export function ListRow({ label, detail = null, value = null, caret = false, color = null, onClick = null, end = null }) {
  const text = h('div', { class: 'list-row-text' },
    h('span', { class: 'list-row-label', ...(color ? { style: `color:${color}` } : {}) }, label),
    detail ? h('span', { class: 'list-row-detail' }, detail) : null);
  const row = h('div', { class: 'list-row' + (onClick ? ' clickable' : ''), ...(onClick ? { role: 'button', tabindex: '0' } : {}) },
    text,
    value ? h('span', { class: 'list-row-value' }, value) : null,
    end,
    caret ? h('span', { class: 'caret', 'aria-hidden': 'true' }, icon('chev-r')) : null);
  if (onClick) {
    row.addEventListener('click', onClick);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  }
  return row;
}

/** A round on/off mark: filled with a tick when on. */
export const CheckDot = (checked) =>
  h('span', { class: 'check-dot' + (checked ? ' on' : ''), 'aria-hidden': 'true' }, checked ? icon('check') : null);

/** A switch row: label + detail on the left, ink switch on the right. */
export function SwitchRow(label, checked, { detail = null, onChange = null } = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = !!checked;
  const sw = h('label', { class: 'switch' }, input, h('span'));
  const fire = (on) => onChange?.(on);
  input.addEventListener('change', () => fire(input.checked));
  return ListRow({
    label, detail,
    onClick: () => { input.checked = !input.checked; fire(input.checked); },
    end: sw,
  });
}

/** − n + in a pill; 0 reads "Off". */
export function PillStepper(text, { canLower, canRaise, lowerLabel = 'Fewer', raiseLabel = 'More', onLower, onRaise } = {}) {
  const btn = (label, enabled, fn, glyph) => {
    const b = h('button', { type: 'button', class: 'step-btn', 'aria-label': label, disabled: enabled ? null : '' }, glyph);
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  return h('div', { class: 'pill-stepper' },
    btn(lowerLabel, canLower, onLower, '−'),
    h('span', { class: 'step-value' }, text),
    btn(raiseLabel, canRaise, onRaise, '+'));
}

/** A section's story count: − n +, 0 reads "Off". */
export function StoryStepper(n, canRaise, max, onChange) {
  const render = (el) => {
    el.replaceChildren();
    el.append(PillStepper(n === 0 ? 'Off' : String(n), {
      canLower: n > 0, canRaise: canRaise && n < max,
      lowerLabel: 'Fewer stories', raiseLabel: 'More stories',
      onLower: () => onChange(n - 1), onRaise: () => onChange(n + 1),
    }));
  };
  const el = h('div', { class: 'story-stepper' });
  render(el);
  el.refresh = (nn, cc) => { n = nn; canRaise = cc; render(el); };
  return el;
}

/** Options in a pill well; the chosen one is filled with ink. */
export function Segmented(options, selected, { onSelect = null, glass = false } = {}) {
  const well = h('div', { class: 'segmented' + (glass ? ' glass-seg' : ''), role: 'group' });
  const paint = () => {
    well.replaceChildren(...options.map((label, i) => {
      const on = i === selected;
      const b = h('button', {
        type: 'button', class: 'seg-opt' + (on ? ' on' : ''),
        'aria-pressed': String(on),
      }, label);
      b.addEventListener('click', () => { selected = i; paint(); onSelect?.(i); });
      return b;
    }));
  };
  paint();
  well.setSelected = (i) => { selected = i; paint(); };
  return well;
}

/** A small glass pill to tap, such as a suggestion. */
export function Chip(text, { selected = false, onClick = null } = {}) {
  const b = h('button', { type: 'button', class: 'chip' + (selected ? ' on' : ''), 'aria-pressed': String(!!selected) }, text);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** A small ink tag, e.g. FREE / OFFLINE. */
export const Tag = (label) => h('span', { class: 'tag-ink' }, label);

/** A pill button: ink-filled for the main action, glass for the rest. */
export function PillButton(text, { filled = true, onClick = null, iconName = null } = {}) {
  const b = h('button', { type: 'button', class: 'pill-btn' + (filled ? '' : ' glass-btn') },
    iconName ? icon(iconName) : null, text);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

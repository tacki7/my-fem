/** Small declarative widget kit for the parameter panels. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export interface SectionHandle {
  root: HTMLElement;
  body: HTMLElement;
}

/**
 * Which sections the reader has folded away, remembered between visits.
 *
 * There are eighteen of them across three panels. Someone who works with the
 * mesh settings collapses the rest once, and having that undone on every
 * reload is the kind of small tax that makes a tool feel disposable. Keyed by
 * title, so the state follows the section rather than its position.
 */
const FOLD_KEY = 'rollfem.folded.v2';
/**
 * Remembered state per title: true = folded, false = opened. Both are kept,
 * because the input sections now ship folded and "the reader opened this
 * one" has to survive a reload as surely as "the reader folded this one".
 * (v1 kept only the folds, and treated any remembered fold as a reason to
 * ignore every section's default - which, with folded defaults, opened the
 * whole panel the moment one section was folded by hand.)
 */
const folded: Map<string, boolean> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
    return new Map(Object.entries(raw).filter(([, v]) => typeof v === 'boolean') as [string, boolean][]);
  } catch { return new Map(); }
})();
const saveFolded = () => {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(Object.fromEntries(folded))); }
  catch { /* private mode; the app works, it just forgets */ }
};

export function section(
  title: string, opts: { open?: boolean; hint?: string } = {},
): SectionHandle {
  const root = el('section', 'panel-section');
  const head = el('div', 'panel-head');
  const btn = el('button', 'panel-head-btn');
  btn.type = 'button';
  btn.append(el('span', 'panel-head-caret', '▾'), el('span', 'panel-head-title', title));
  head.append(btn);
  // Whatever the section as a whole needs said goes on the heading, where it
  // is found by anyone wondering what the section is - and where it costs no
  // vertical space at all.
  if (opts.hint) head.append(helpMark(opts.hint));
  const body = el('div', 'panel-body');
  root.append(head, body);
  // A remembered choice wins over the default; without one, the default.
  const shut = folded.get(title) ?? opts.open === false;
  if (shut) root.classList.add('collapsed');
  btn.setAttribute('aria-expanded', String(!shut));
  btn.addEventListener('click', () => {
    const nowShut = root.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!nowShut));
    folded.set(title, nowShut);
    saveFolded();
  });
  return { root, body };
}

/** Unfold every section and forget the remembered state. */
export function resetFolds(): void {
  folded.clear();
  saveFolded();
  for (const s of document.querySelectorAll('.panel-section.collapsed')) {
    s.classList.remove('collapsed');
    s.querySelector('.panel-head-btn')?.setAttribute('aria-expanded', 'true');
  }
}

/**
 * A hint the reader asks for, rather than one that is always in their way.
 *
 * The panels carry a lot of explanation - why a quantity does not affect the
 * solve, what a coefficient means, which loop owns a number - and printed in
 * full it was several paragraphs per section, pushing the dials themselves off
 * the bottom of the panel. Behind a marker the text is a click or a hover
 * away and the dials stay where the hand expects them.
 *
 * `title` is set as well as the popup, so the text survives on a touch device
 * and for a screen reader, where a hover never happens.
 */
export function helpMark(text: string): HTMLElement {
  const wrap = el('span', 'help');
  const btn = el('button', 'help-mark', '?');
  btn.type = 'button';
  btn.title = text;
  btn.setAttribute('aria-label', text);
  const bubble = el('span', 'help-bubble', text);
  // A tooltip pinned to the panel would be clipped by its scroll box, so the
  // bubble is placed on the body and positioned against the marker each time.
  // Only on open: it would otherwise have to be tracked on every scroll frame.
  const place = () => {
    const r = btn.getBoundingClientRect();
    bubble.style.left = `${Math.max(8, Math.min(window.innerWidth - 268, r.left - 6))}px`;
    bubble.style.top = `${r.bottom + 6}px`;
  };
  let open = false;
  const show = () => {
    if (open) return;
    open = true;
    document.body.append(bubble);
    place();
  };
  const hide = () => { open = false; bubble.remove(); };
  btn.addEventListener('pointerenter', show);
  btn.addEventListener('pointerleave', hide);
  btn.addEventListener('focus', show);
  btn.addEventListener('blur', hide);
  // Tap on a touch screen, where there is no hover at all.
  btn.addEventListener('click', (e) => { e.preventDefault(); open ? hide() : show(); });
  wrap.append(btn);
  return wrap;
}

export interface SliderOpts {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  /** distribute the slider travel logarithmically */
  log?: boolean;
  value: number;
  format?: (v: number) => string;
  hint?: string;
  onInput: (v: number) => void;
}

export interface SliderHandle {
  root: HTMLElement;
  set(v: number): void;
  get(): number;
  setEnabled(on: boolean): void;
}

export function slider(o: SliderOpts): SliderHandle {
  const root = el('div', 'ctrl');
  const top = el('div', 'ctrl-top');
  const lab = el('label', 'ctrl-label', o.label);
  // The hint moves into a marker beside the label rather than a paragraph
  // under the dial - see `helpMark`.
  if (o.hint) lab.append(helpMark(o.hint));
  const out = el('input', 'ctrl-value');
  out.type = 'text';
  out.inputMode = 'decimal';
  out.spellcheck = false;
  top.append(lab, out);
  const spin = el('span', 'ctrl-spin');
  const spinUp = el('button', 'ctrl-spin-btn', '\u25b4');
  const spinDown = el('button', 'ctrl-spin-btn', '\u25be');
  spinUp.type = 'button'; spinDown.type = 'button';
  spinUp.tabIndex = -1; spinDown.tabIndex = -1;
  spinUp.setAttribute('aria-hidden', 'true');
  spinDown.setAttribute('aria-hidden', 'true');
  spin.append(spinUp, spinDown);
  top.append(spin);
  const input = el('input', 'ctrl-range');
  input.type = 'range';
  const N = 1000;
  input.min = '0'; input.max = String(N); input.step = '1';

  const toPos = (v: number) => {
    const t = o.log
      ? (Math.log(v / o.min)) / Math.log(o.max / o.min)
      : (v - o.min) / (o.max - o.min);
    return Math.round(Math.max(0, Math.min(1, t)) * N);
  };
  const toVal = (pos: number) => {
    const t = pos / N;
    let v = o.log ? o.min * Math.pow(o.max / o.min, t) : o.min + (o.max - o.min) * t;
    if (o.step) v = Math.round(v / o.step) * o.step;
    return v;
  };
  const fmt = o.format ?? ((v: number) => v.toFixed(o.step && o.step >= 1 ? 0 : 3));
  const paint = (v: number) => {
    // Not while it is being typed into: rewriting the box under the cursor
    // eats the keystroke half way through a number.
    if (document.activeElement !== out) {
      out.value = `${fmt(v)}${o.unit ? ' ' + o.unit : ''}`;
    }
    input.style.setProperty('--fill', `${(toPos(v) / N) * 100}%`);
  };

  let value = o.value;
  input.value = String(toPos(value));
  paint(value);
  input.addEventListener('input', () => {
    value = toVal(Number(input.value));
    paint(value);
    o.onInput(value);
  });

  /**
   * Turn a number as the readout shows it back into the value behind it.
   *
   * The two are not the same number. A slider's range is in solver units -
   * metres, pascals - while the readout is in the unit an operator uses, and
   * `format` is what converts: the strip width dial runs 0.05..3 and prints
   * 50..3000 mm. Typing 1450 into it has to mean 1.45 m, not a clamp to the
   * 3 m rail.
   *
   * Rather than have every caller pass an inverse to keep in step with its
   * formatter, the inverse is found by bisection on the formatter itself. That
   * needs only monotonicity - it holds for a unit scale, a log axis, and any
   * rounding a formatter applies - so a dial cannot end up with a conversion
   * that disagrees with the one printing its own value.
   */
  const unformat = (shown: number): number | null => {
    const fLo = Number(fmt(o.min)), fHi = Number(fmt(o.max));
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo === fHi) return null;
    const up = fHi > fLo;
    // Past either rail: take the rail. The repaint then shows what was taken.
    if (up ? shown <= fLo : shown >= fLo) return o.min;
    if (up ? shown >= fHi : shown <= fHi) return o.max;
    let lo = o.min, hi = o.max;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const f = Number(fmt(mid));
      if (!Number.isFinite(f)) return null;
      if ((f < shown) === up) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  /**
   * Type a value instead of dragging for it.
   *
   * A slider is the wrong instrument for an exact number: several of these are
   * logarithmic over four decades, where one pixel of travel is a percent of
   * the value and hitting 180 mm exactly is luck. The readout was already
   * showing the number, so it becomes the field that sets it.
   *
   * The unit is stripped, so the text the box itself printed is valid input.
   */
  const commit = () => {
    const shown = Number(out.value.replace(/[^0-9eE+\-.]/g, ''));
    const v = Number.isFinite(shown) ? unformat(shown) : null;
    if (v === null) { paint(value); return; }
    value = Math.max(o.min, Math.min(o.max, o.step ? Math.round(v / o.step) * o.step : v));
    input.value = String(toPos(value));
    input.style.setProperty('--fill', `${(toPos(value) / N) * 100}%`);
    o.onInput(value);
    // repaint through the formatter, so a clamped or rounded entry shows what
    // was actually taken rather than what was typed
    out.value = `${fmt(value)}${o.unit ? ' ' + o.unit : ''}`;
  };
  /**
   * How much one press of an arrow should move the readout.
   *
   * In display units, so a click steps the number the reader is looking at
   * rather than the solver value behind it - on a dial printing millimetres
   * over a range held in metres those are four orders apart.
   *
   * Two rules, and the larger wins. A 1-2-5 step near a percent of the current
   * value keeps a logarithmic dial usable across its decades: 1200 MPa steps
   * by 10, 2.00 mm by 0.02. The formatter's own last digit is the floor, so a
   * press can never fail to change what is printed - an arrow that looks dead
   * is worse than one that steps coarsely.
   */
  const displayStep = (shown: number): number => {
    const txt = fmt(value);
    const dec = txt.match(/\.(\d+)/)?.[1].length ?? 0;
    const floor = Math.pow(10, -dec);
    const mag = Math.abs(shown);
    if (!(mag > 0)) return floor;
    const raw = mag * 0.01;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / pow;
    const nice = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
    return Math.max(nice, floor);
  };

  const nudge = (dir: 1 | -1) => {
    const shown = Number(fmt(value));
    if (!Number.isFinite(shown)) return;
    const st = displayStep(shown);
    // Snapped to the step grid, so repeated presses land on round numbers
    // instead of drifting off whatever the dial happened to be sitting on.
    const next = Math.round(shown / st) * st + dir * st;
    const v = unformat(Number(next.toPrecision(12)));
    if (v === null) return;
    const clamped = Math.max(o.min, Math.min(o.max, o.step ? Math.round(v / o.step) * o.step : v));
    if (clamped === value) return;
    value = clamped;
    input.value = String(toPos(value));
    paint(value);
    o.onInput(value);
  };
  spinUp.addEventListener('click', () => nudge(1));
  spinDown.addEventListener('click', () => nudge(-1));

  out.addEventListener('change', commit);
  out.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter') { commit(); out.blur(); }
    else if (ev.key === 'Escape') { paint(value); out.blur(); }
    // The arrows work from the keyboard too, as they do on a number input.
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); commit(); nudge(1); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); commit(); nudge(-1); }
  });
  out.addEventListener('focus', () => {
    // Hand over the bare number: the unit is ours to add back.
    out.value = String(Number(fmt(value)));
    out.select();
  });
  out.addEventListener('blur', () => paint(value));

  root.append(top, input);
  return {
    root,
    get: () => value,
    set(v: number) { value = v; input.value = String(toPos(v)); paint(v); },
    setEnabled(on: boolean) {
      input.disabled = !on; out.disabled = !on;
      spinUp.disabled = !on; spinDown.disabled = !on;
      root.classList.toggle('disabled', !on);
    },
  };
}

export function select<T extends string>(
  label: string, options: { value: T; text: string }[], value: T, onChange: (v: T) => void,
  hint?: string,
): { root: HTMLElement; set(v: T): void } {
  const root = el('div', 'ctrl');
  const top = el('div', 'ctrl-top');
  const lab = el('label', 'ctrl-label', label);
  if (hint) lab.append(helpMark(hint));
  top.append(lab);
  const sel = el('select', 'ctrl-select');
  for (const o of options) {
    const opt = el('option');
    opt.value = o.value; opt.textContent = o.text;
    sel.append(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  root.append(top, sel);
  return { root, set(v: T) { sel.value = v; } };
}

export function toggle(
  label: string, value: boolean, onChange: (v: boolean) => void, hint?: string,
): { root: HTMLElement; set(v: boolean): void; setEnabled(on: boolean): void } {
  const root = el('label', 'ctrl-toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const track = el('span', 'toggle-track');
  track.append(el('span', 'toggle-knob'));
  const lab = el('span', 'toggle-label', label);
  if (hint) lab.append(helpMark(hint));
  root.append(input, track, lab);
  return {
    root,
    set(v: boolean) { input.checked = v; },
    setEnabled(on: boolean) { input.disabled = !on; root.classList.toggle('disabled', !on); },
  };
}

export function buttonRow(
  items: { text: string; title?: string; onClick: () => void; primary?: boolean }[],
): HTMLElement {
  const row = el('div', 'btn-row');
  for (const it of items) {
    const b = el('button', it.primary ? 'btn btn-primary' : 'btn', it.text);
    b.type = 'button';
    if (it.title) b.title = it.title;
    b.addEventListener('click', it.onClick);
    row.append(b);
  }
  return row;
}

/** A label / value grid whose values are cheap to update every frame. */
export class StatGrid {
  readonly root: HTMLElement;
  private cells = new Map<string, HTMLElement>();

  constructor(cls = 'stat-grid') { this.root = el('div', cls); }

  add(key: string, label: string, unit?: string): this {
    const row = el('div', 'stat-row');
    row.append(el('span', 'stat-label', label));
    const v = el('span', 'stat-value', '—');
    const wrap = el('span', 'stat-vwrap');
    wrap.append(v);
    if (unit) wrap.append(el('span', 'stat-unit', unit));
    row.append(wrap);
    this.root.append(row);
    this.cells.set(key, v);
    return this;
  }

  set(key: string, text: string, tone?: 'ok' | 'warn' | 'bad'): void {
    const c = this.cells.get(key);
    if (!c) return;
    if (c.textContent !== text) c.textContent = text;
    const want = tone ? `stat-value tone-${tone}` : 'stat-value';
    if (c.className !== want) c.className = want;
  }
}

export interface NumFieldOpts {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** digits shown when the field is not being edited */
  digits?: number;
  onChange: (v: number) => void;
}

export interface NumFieldHandle {
  root: HTMLElement;
  set(v: number): void;
}

/**
 * A compact number cell, for tables where one value per stand has to fit in a
 * column. Commits on Enter or blur rather than per keystroke: these edits are
 * expensive (several of them rebuild a mesh) and half-typed numbers are not
 * values anyone means.
 */
export function numField(o: NumFieldOpts): NumFieldHandle {
  const input = el('input', 'num-field');
  input.type = 'number';
  if (o.min !== undefined) input.min = String(o.min);
  if (o.max !== undefined) input.max = String(o.max);
  input.step = String(o.step ?? 1);
  const digits = o.digits ?? 1;
  const paint = (v: number) => { input.value = v.toFixed(digits); };
  paint(o.value);
  const commit = () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) { paint(o.value); return; }
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    paint(v);
    o.onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { commit(); input.blur(); }
  });
  return {
    root: input,
    set(v: number) { if (document.activeElement !== input) paint(v); },
  };
}

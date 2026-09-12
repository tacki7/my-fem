/**
 * Draggable boundaries between the panels.
 *
 * The movable tracks are CSS custom properties on `#app`, so a drag sets one
 * number and the browser relays everything - no measuring of siblings, no
 * layout written from script that then has to be kept in step with the
 * stylesheet.
 *
 * The handles sit in the grid gaps as absolutely positioned overlays rather
 * than as grid items. A handle that occupied a track of its own would change
 * the very layout it exists to adjust, and every boundary would have to be
 * accounted for twice.
 *
 * Where each handle goes is measured off the panels themselves, not written
 * out from the track sizes: the three looks (see `themes` in the stylesheet)
 * put the same panels in different places - the mill line above the stage or
 * below it, the controls on the left or on the right - and the handle for a
 * track is wherever that track's panel happens to end.
 */

import { el } from './controls';

export type Theme = 'classic' | 'modern' | 'chic';
export const THEMES: Theme[] = ['classic', 'modern', 'chic'];

type Prop = '--col-left' | '--col-right' | '--row-line' | '--row-charts' | '--chart-nip' | '--chart-agc';
/** the properties written as a share of the chart band rather than in pixels */
const PERCENT: ReadonlySet<Prop> = new Set<Prop>(['--chart-nip', '--chart-agc']);

/** One draggable boundary: which track it sizes, and which way it grows. */
interface Gutter {
  /** the custom property on `#app` this handle writes */
  prop: Prop;
  axis: 'x' | 'y';
  /** +1 when dragging towards positive x/y makes the track bigger; depends on where the panel sits */
  sign(): 1 | -1;
  min: number;
  max: number;
  /**
   * The unit the property is written in. Percent for a split inside a band
   * whose width the window decides: a pixel share would be wrong at the
   * next window size, a share of the band is not.
   */
  unit?: '%';
  /** pixels per unit, for a percent handle - how far a drag moves the number */
  scale?(): number;
  /** where to put the handle */
  place(node: HTMLElement): void;
}

/**
 * The sizes each look ships with. The modern look keeps the mill line as a
 * band along the bottom, which wants less height than a panel above the
 * stage; the chic look mirrors the columns, so the wider stats panel is the
 * first column there.
 */
const DEFAULTS: Record<Theme, Record<Prop, number>> = {
  classic: { '--col-left': 292, '--col-right': 332, '--row-line': 460, '--row-charts': 330, '--chart-nip': 50, '--chart-agc': 20 },
  modern:  { '--col-left': 300, '--col-right': 320, '--row-line': 380, '--row-charts': 340, '--chart-nip': 48, '--chart-agc': 20 },
  chic:    { '--col-left': 332, '--col-right': 300, '--row-line': 440, '--row-charts': 330, '--chart-nip': 50, '--chart-agc': 20 },
};

const GAP = 10;
/** the flex gap between the two chart cells, from the stylesheet */
const CHART_GAP = 12;
/** how much of the window a single track may take, so nothing can be lost */
const MAX_FRAC = 0.6;
/** the handle's own width across the gap it sits in */
const HANDLE = 13;

const px = (v: number) => `${Math.round(v)}px`;

export interface LayoutHandle {
  /** re-place the handles; call on resize */
  refresh(): void;
  /** put every track back to the size the current look ships with */
  reset(): void;
  /** switch to another look's remembered sizes and re-place the handles */
  setTheme(theme: Theme): void;
}

/** The look the document is in, read off the root - the switch writes it there. */
export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'modern' || t === 'chic' ? t : 'classic';
}

/**
 * Attach the handles and restore any sizes this browser has remembered.
 *
 * `onResize` runs after every change, because the canvases size themselves
 * from their boxes and will not notice a grid track moving on its own.
 */
export function installLayout(app: HTMLElement, onResize: () => void): LayoutHandle {
  const store = 'rollfem.layout.v2';
  type Stored = Partial<Record<Theme, Partial<Record<Prop, number>>>>;
  const read = (): Stored => {
    try { return JSON.parse(localStorage.getItem(store) ?? '{}'); } catch { return {}; }
  };
  let theme: Theme = currentTheme();
  let sizes: Record<Prop, number> = { ...DEFAULTS[theme], ...read()[theme] };

  const apply = (p: Prop, v: number) => {
    sizes[p] = v;
    app.style.setProperty(p, PERCENT.has(p) ? `${v}%` : px(v));
  };
  const save = () => {
    try {
      const all = read();
      all[theme] = { ...sizes };
      localStorage.setItem(store, JSON.stringify(all));
    } catch { /* private mode */ }
  };

  // Boxes, relative to the app's own - the handles are its children.
  const box = (id: string): DOMRect | null => {
    const n = document.getElementById(id);
    if (!n || n.hidden) return null;
    const r = n.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    return new DOMRect(r.left - a.left, r.top - a.top, r.width, r.height);
  };
  /** the side panel in the first column, and the one in the last */
  const sides = () => {
    const l = box('left'), r = box('right');
    if (!l || !r) return { first: l ?? r, last: r ?? l };
    return l.left <= r.left ? { first: l, last: r } : { first: r, last: l };
  };
  const lineAbove = () => {
    const m = box('millline'), s = box('stage');
    return !m || !s || m.top < s.top;
  };
  const cellHidden = (id: string) => (document.getElementById(id) as HTMLElement | null)?.hidden ?? true;
  /** nothing to the right of the hill: the boundary has nothing to move */
  const agcChartHidden = () => cellHidden('chart-agc') && cellHidden('chart-track');
  const bandWidth = () => Math.max(1, (box('bottom')?.width ?? 1) - CHART_GAP);
  const setBox = (n: HTMLElement, left: number, top: number, w: number, h: number) => {
    n.style.left = px(left); n.style.top = px(top);
    n.style.width = px(Math.max(0, w)); n.style.height = px(Math.max(0, h));
  };

  const gutters: Gutter[] = [
    {
      // The first column, whichever side panel is in it. Its handle runs the
      // panel's own height, on the panel's outer edge.
      prop: '--col-left', axis: 'x', sign: () => 1, min: 200, max: 560,
      place: (n) => {
        const a = sides().first;
        if (!a) { n.hidden = true; return; }
        n.hidden = false;
        setBox(n, a.right + (GAP - HANDLE) / 2, a.top, HANDLE, a.height);
      },
    },
    {
      prop: '--col-right', axis: 'x', sign: () => -1, min: 220, max: 620,
      place: (n) => {
        const b = sides().last;
        if (!b) { n.hidden = true; return; }
        n.hidden = false;
        setBox(n, b.left - GAP + (GAP - HANDLE) / 2, b.top, HANDLE, b.height);
      },
    },
    {
      // The mill line's row. Above the stage the handle is under the line and
      // dragging down enlarges it; below the stage (the modern look) it is
      // over the line and the drag runs the other way.
      prop: '--row-line', axis: 'y', sign: () => (lineAbove() ? 1 : -1), min: 140, max: 900,
      place: (n) => {
        const m = box('millline');
        if (!m) { n.hidden = true; return; }
        n.hidden = false;
        const y = lineAbove() ? m.bottom + (GAP - HANDLE) / 2 : m.top - GAP + (GAP - HANDLE) / 2;
        setBox(n, m.left, y, m.width, HANDLE);
      },
    },
    {
      // The chart band, always under the stage: the handle is above it.
      prop: '--row-charts', axis: 'y', sign: () => -1, min: 90, max: 700,
      place: (n) => {
        const c = box('bottom');
        if (!c) { n.hidden = true; return; }
        n.hidden = false;
        setBox(n, c.left, c.top - GAP + (GAP - HANDLE) / 2, c.width, HANDLE);
      },
    },
    {
      // Between the friction hill and the control trail, inside the chart
      // band. A share rather than a width, and only there when the trail is
      // (it hides while no stand is under control, and the hill takes the
      // whole band).
      prop: '--chart-nip', axis: 'x', sign: () => 1, min: 20, max: 80, unit: '%',
      scale: () => bandWidth() / 100,
      place: (n) => {
        const c = box('bottom'), nip = box('chart-nip');
        n.hidden = agcChartHidden() || !c || !nip;
        if (n.hidden || !c || !nip) return;
        setBox(n, nip.right + (CHART_GAP - HANDLE) / 2, c.top, HANDLE, c.height);
      },
    },
    {
      // Between the control trail and the time-series column. Also a share of
      // the band; only there while both cells are (the trail hides with no
      // stand under control, the column with nothing to trace).
      prop: '--chart-agc', axis: 'x', sign: () => 1, min: 8, max: 40, unit: '%',
      scale: () => bandWidth() / 100,
      place: (n) => {
        const c = box('bottom'), agc = box('chart-agc');
        n.hidden = cellHidden('chart-agc') || cellHidden('chart-track') || !c || !agc;
        if (n.hidden || !c || !agc) return;
        setBox(n, agc.right + (CHART_GAP - HANDLE) / 2, c.top, HANDLE, c.height);
      },
    },
  ];

  const nodes: HTMLElement[] = [];
  const refresh = () => { gutters.forEach((g, i) => g.place(nodes[i])); };

  for (const g of gutters) {
    const n = el('div', `gutter gutter-${g.axis === 'x' ? 'v' : 'h'}`);
    n.setAttribute('role', 'separator');
    n.setAttribute('aria-orientation', g.axis === 'x' ? 'vertical' : 'horizontal');
    n.title = 'ドラッグでサイズ変更 ／ ダブルクリックで既定に戻す';
    nodes.push(n);
    app.append(n);

    n.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      n.setPointerCapture(e.pointerId);
      n.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.style.cursor = g.axis === 'x' ? 'col-resize' : 'row-resize';
      const from = g.axis === 'x' ? e.clientX : e.clientY;
      const start = sizes[g.prop];
      const sign = g.sign();

      const move = (ev: PointerEvent) => {
        const now = g.axis === 'x' ? ev.clientX : ev.clientY;
        const r = app.getBoundingClientRect();
        // Never let one track eat the window: the cap is the smaller of the
        // handle's own limit and a fraction of the box it lives in, so a
        // narrow window keeps a usable stage rather than a sliver of one.
        const span = g.axis === 'x' ? r.width : r.height;
        const hi = g.unit === '%' ? g.max : Math.min(g.max, span * MAX_FRAC);
        const perUnit = g.scale ? g.scale() : 1;
        apply(g.prop, Math.max(g.min, Math.min(hi, start + (sign * (now - from)) / perUnit)));
        refresh();
        onResize();
      };
      const up = (ev: PointerEvent) => {
        n.releasePointerCapture(ev.pointerId);
        n.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
        n.removeEventListener('pointermove', move);
        n.removeEventListener('pointerup', up);
        n.removeEventListener('pointercancel', up);
        save();
        onResize();
      };
      n.addEventListener('pointermove', move);
      n.addEventListener('pointerup', up);
      n.addEventListener('pointercancel', up);
    });

    // A boundary dragged somewhere useless is easier to fix than to explain.
    n.addEventListener('dblclick', () => {
      apply(g.prop, DEFAULTS[theme][g.prop]);
      refresh(); save(); onResize();
    });
  }

  const applyAll = () => { for (const p of Object.keys(sizes) as Prop[]) apply(p, sizes[p]); };
  applyAll();
  refresh();

  return {
    refresh,
    reset() {
      sizes = { ...DEFAULTS[theme] };
      applyAll(); refresh(); save(); onResize();
    },
    setTheme(t) {
      theme = t;
      sizes = { ...DEFAULTS[theme], ...read()[theme] };
      applyAll(); refresh(); onResize();
    },
  };
}

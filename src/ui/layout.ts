/**
 * Draggable boundaries between the panels.
 *
 * The four movable tracks are CSS custom properties on `#app`, so a drag sets
 * one number and the browser relays everything - no measuring of siblings, no
 * layout written from script that then has to be kept in step with the
 * stylesheet.
 *
 * The handles sit in the grid gaps as absolutely positioned overlays rather
 * than as grid items. A handle that occupied a track of its own would change
 * the very layout it exists to adjust, and every boundary would have to be
 * accounted for twice.
 */

import { el } from './controls';

/** One draggable boundary: which track it sizes, and which way it grows. */
interface Gutter {
  /** the custom property on `#app` this handle writes */
  prop: '--col-left' | '--col-right' | '--row-line' | '--row-charts';
  axis: 'x' | 'y';
  /** +1 when dragging towards positive x/y makes the track bigger */
  sign: 1 | -1;
  min: number;
  max: number;
  /** where to put the handle, given the app box */
  place(app: DOMRect, node: HTMLElement): void;
}

const DEFAULTS: Record<Gutter['prop'], number> = {
  '--col-left': 292,
  '--col-right': 332,
  '--row-line': 470,
  '--row-charts': 196,
};

const GAP = 10;
const PAD = 10;
/** how much of the window a single track may take, so nothing can be lost */
const MAX_FRAC = 0.6;

const px = (v: number) => `${Math.round(v)}px`;

export interface LayoutHandle {
  /** re-place the handles; call on resize */
  refresh(): void;
  /** put every track back to the size the app ships with */
  reset(): void;
}

/**
 * Attach the handles and restore any sizes this browser has remembered.
 *
 * `onResize` runs after every change, because the canvases size themselves
 * from their boxes and will not notice a grid track moving on its own.
 */
export function installLayout(app: HTMLElement, onResize: () => void): LayoutHandle {
  const store = 'rollfem.layout.v1';
  const read = (): Partial<Record<Gutter['prop'], number>> => {
    try { return JSON.parse(localStorage.getItem(store) ?? '{}'); } catch { return {}; }
  };
  const sizes: Record<string, number> = { ...DEFAULTS, ...read() };

  const apply = (p: Gutter['prop'], v: number) => {
    sizes[p] = v;
    app.style.setProperty(p, px(v));
  };
  const save = () => {
    try { localStorage.setItem(store, JSON.stringify(sizes)); } catch { /* private mode */ }
  };

  // The mill line and the charts are full-width bands, so their handles run
  // the width of the app; the side panels are full-height columns below the
  // top bar. Each is centred on its own grid gap.
  const rowTop = () => sizes['--row-line'];
  const gutters: Gutter[] = [
    {
      prop: '--col-left', axis: 'x', sign: 1, min: 200, max: 560,
      place: (r, n) => {
        n.style.left = px(PAD + sizes['--col-left'] + (GAP - 13) / 2);
        n.style.top = px(PAD + DEFAULTS['--row-line'] * 0 + 52 + GAP + rowTop() + GAP);
        n.style.height = px(Math.max(0, r.height - PAD * 2 - 52 - GAP * 2 - rowTop()));
      },
    },
    {
      prop: '--col-right', axis: 'x', sign: -1, min: 220, max: 620,
      place: (r, n) => {
        n.style.left = px(r.width - PAD - sizes['--col-right'] - GAP + (GAP - 13) / 2);
        n.style.top = px(PAD + 52 + GAP + rowTop() + GAP);
        n.style.height = px(Math.max(0, r.height - PAD * 2 - 52 - GAP * 2 - rowTop()));
      },
    },
    {
      prop: '--row-line', axis: 'y', sign: 1, min: 140, max: 900,
      place: (r, n) => {
        n.style.top = px(PAD + 52 + GAP + rowTop() + (GAP - 13) / 2);
        n.style.left = px(PAD);
        n.style.width = px(Math.max(0, r.width - PAD * 2));
      },
    },
    {
      prop: '--row-charts', axis: 'y', sign: -1, min: 90, max: 700,
      place: (r, n) => {
        n.style.top = px(r.height - PAD - sizes['--row-charts'] - GAP + (GAP - 13) / 2);
        n.style.left = px(PAD + sizes['--col-left'] + GAP);
        n.style.width = px(Math.max(0,
          r.width - PAD * 2 - sizes['--col-left'] - sizes['--col-right'] - GAP * 2));
      },
    },
  ];

  const nodes: HTMLElement[] = [];
  const refresh = () => {
    const r = app.getBoundingClientRect();
    gutters.forEach((g, i) => g.place(r, nodes[i]));
  };

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

      const move = (ev: PointerEvent) => {
        const now = g.axis === 'x' ? ev.clientX : ev.clientY;
        const r = app.getBoundingClientRect();
        // Never let one track eat the window: the cap is the smaller of the
        // handle's own limit and a fraction of the box it lives in, so a
        // narrow window keeps a usable stage rather than a sliver of one.
        const span = g.axis === 'x' ? r.width : r.height;
        const hi = Math.min(g.max, span * MAX_FRAC);
        apply(g.prop, Math.max(g.min, Math.min(hi, start + g.sign * (now - from))));
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
      apply(g.prop, DEFAULTS[g.prop]);
      refresh(); save(); onResize();
    });
  }

  for (const p of Object.keys(DEFAULTS) as Gutter['prop'][]) apply(p, sizes[p]);
  refresh();

  return {
    refresh,
    reset() {
      for (const p of Object.keys(DEFAULTS) as Gutter['prop'][]) apply(p, DEFAULTS[p]);
      refresh(); save(); onResize();
    },
  };
}

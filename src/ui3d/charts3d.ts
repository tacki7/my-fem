/**
 * Canvas 2D drawing for the 3D tab: profile charts across the strip width,
 * the front view of the roll stack, and the end view of the cluster.
 *
 * The same dark palette as the 2D tab's canvases, in every theme.
 */

import type { Result3D, RollState } from '../sim3d/solver';
import type { Stack } from '../sim3d/stack';
import type { RingInfluence } from '../sim3d/ring';

const FONT = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const BG = '#070a12';
const GRID = 'rgba(140, 170, 210, 0.10)';
const AXIS = 'rgba(140, 170, 210, 0.35)';
const TEXT = '#8ea0bd';
const TEXT_BRIGHT = '#dce6f5';

/** the series colours, one per roll from the work roll outwards */
export const ROLL_COLORS = ['#7fe4ff', '#ffb26e', '#96e6b4', '#a99bff', '#ff8fa8', '#ffe28a', '#7fb2ff', '#c8ff8f', '#ff9df0', '#8fffe6'];
export const STRIP_COLOR = '#ffd166';

export function fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export interface XYSeries {
  label: string;
  color: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** dashed line */
  dash?: boolean;
  /** filled to zero */
  fill?: boolean;
  width?: number;
}

export interface LineChartOpts {
  /** vertical unit label */
  unit: string;
  /** include zero in the y range */
  zero?: boolean;
  /** symmetric about zero */
  symmetric?: boolean;
  /** the x extent [m] drawn, symmetric about 0 */
  halfWidth: number;
  /** shade this |x| band (the strip) */
  strip?: number;
  /** horizontal marker lines with labels */
  marks?: { y: number; label: string; color?: string }[];
}

const nice = (v: number): string => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
};

/** A profile chart: several series against the width coordinate. */
export class LineChart {
  /** what was last drawn, so a hover can be painted over it without recomputing */
  private last: { series: XYSeries[]; o: LineChartOpts } | null = null;
  /** the pointer's x on the canvas [css px], or null when it is off the chart */
  private hoverX: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      if (this.last) this.draw(this.last.series, this.last.o);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      if (this.last) this.draw(this.last.series, this.last.o);
    });
  }

  draw(series: XYSeries[], o: LineChartOpts): void {
    this.last = { series, o };
    const ctx = fit(this.canvas);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const padL = 46, padR = 10, padT = 8, padB = 20;
    const pw = W - padL - padR, ph = H - padT - padB;
    if (pw < 10 || ph < 10) return;

    let lo = Infinity, hi = -Infinity;
    for (const s of series) {
      for (let i = 0; i < s.y.length; i++) {
        const v = s.y[i];
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (const m of o.marks ?? []) { lo = Math.min(lo, m.y); hi = Math.max(hi, m.y); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (o.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
    if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
    const span = hi - lo;
    lo -= span * 0.08; hi += span * 0.08;

    const xr = o.halfWidth * 1e3;
    const sx = (x: number) => padL + ((x + xr) / (2 * xr)) * pw;
    const sy = (y: number) => padT + ((hi - y) / (hi - lo)) * ph;

    // the strip band
    if (o.strip) {
      ctx.fillStyle = 'rgba(255, 209, 102, 0.05)';
      ctx.fillRect(sx(-o.strip * 1e3), padT, sx(o.strip * 1e3) - sx(-o.strip * 1e3), ph);
    }
    // grid
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ny = 4;
    for (let i = 0; i <= ny; i++) {
      const y = lo + ((hi - lo) * i) / ny;
      const py = Math.round(sy(y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
      ctx.fillText(nice(y), padL - 5, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const nx = 4;
    for (let i = 0; i <= nx; i++) {
      const x = -xr + (2 * xr * i) / nx;
      const px = Math.round(sx(x)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke();
      ctx.fillText(`${x.toFixed(0)}`, px, padT + ph + 4);
    }
    // zero line
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = AXIS;
      const py = Math.round(sy(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
    }
    // unit
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(o.unit, padL + 4, padT + 2);
    // marks
    for (const m of o.marks ?? []) {
      ctx.strokeStyle = m.color ?? AXIS;
      ctx.setLineDash([3, 4]);
      const py = Math.round(sy(m.y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color ?? TEXT;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.label, W - padR - 2, py - 1);
    }
    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.6;
      ctx.setLineDash(s.dash ? [5, 4] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.x.length; i++) {
        const v = s.y[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const px = sx(s.x[i] * 1e3), py = sy(v);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (s.fill) {
        // close the area on the series' own first and last finite points,
        // not on the grid's ends (the series is NaN off the strip)
        let i0 = -1, i1 = -1;
        for (let i = 0; i < s.y.length; i++) if (Number.isFinite(s.y[i])) { if (i0 < 0) i0 = i; i1 = i; }
        if (i0 >= 0) {
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = s.color;
          ctx.lineTo(sx(s.x[i1] * 1e3), sy(0));
          ctx.lineTo(sx(s.x[i0] * 1e3), sy(0));
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
    // legend - inline while it fits; a cluster mill's twelve contacts would
    // cover half the plot, so past six series the hover readout (which
    // names every series) is the legend
    if (series.length <= 6) {
      // legend
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      let lx = padL + 4, ly = padT + 14;
      for (const s of series) {
        const tw = ctx.measureText(s.label).width;
        if (lx + tw + 22 > W - padR) { lx = padL + 4; ly += 13; }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(lx, ly + 6); ctx.lineTo(lx + 14, ly + 6); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = TEXT_BRIGHT;
        ctx.fillText(s.label, lx + 18, ly);
        lx += tw + 28;
      }
    }

    // hover readout: a crosshair at the nearest sample and every series'
    // value there
    const hx = this.hoverX;
    if (hx === null || hx < padL || hx > W - padR || series.length === 0) return;
    const xmm = -xr + ((hx - padL) / pw) * 2 * xr;
    // the nearest grid x of the first series (they all share the grid)
    const gx = series[0].x;
    let best = 0, bd = Infinity;
    for (let i = 0; i < gx.length; i++) {
      const d = Math.abs(gx[i] * 1e3 - xmm);
      if (d < bd) { bd = d; best = i; }
    }
    const px = Math.round(sx(gx[best] * 1e3)) + 0.5;
    ctx.strokeStyle = 'rgba(220, 230, 245, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke();
    ctx.setLineDash([]);
    const rows: { color: string; text: string }[] = [];
    for (const s of series) {
      const v = best < s.y.length ? s.y[best] : NaN;
      rows.push({ color: s.color, text: Number.isFinite(v) ? nice(v) : '—' });
      if (Number.isFinite(v)) {
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(px, sy(v), 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    const head = `x = ${(gx[best] * 1e3).toFixed(0)} mm`;
    let bw = ctx.measureText(head).width;
    for (const r of rows) bw = Math.max(bw, ctx.measureText(r.text).width + 16);
    bw += 12;
    const bh = 14 * (rows.length + 1) + 6;
    // the box sits to the right of the crosshair unless that would leave the chart
    let bx = px + 8;
    if (bx + bw > W - padR) bx = px - 8 - bw;
    const by = padT + 2;
    ctx.fillStyle = 'rgba(7, 10, 18, 0.9)';
    ctx.strokeStyle = 'rgba(140, 170, 210, 0.3)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT;
    ctx.fillText(head, bx + 6, by + 4);
    rows.forEach((r, i) => {
      const y = by + 4 + 14 * (i + 1);
      ctx.fillStyle = r.color;
      ctx.fillRect(bx + 6, y + 3, 10, 3);
      ctx.fillStyle = TEXT_BRIGHT;
      ctx.fillText(r.text, bx + 20, y);
    });
  }
}

/** a heat colour for a load share t in [0, 1] */
function heat(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const r = Math.round(40 + 215 * Math.min(1, c * 1.4));
  const g = Math.round(60 + 150 * (c < 0.5 ? c * 2 : 1) - 130 * Math.max(0, c - 0.5) * 2);
  const b = Math.round(120 - 100 * c);
  return `rgb(${r},${g},${b})`;
}

export interface FrontViewOpts {
  /** deflection magnification */
  magnify: number;
  width: number;
}

/**
 * The stack seen from the front: rolls along the width with their deflection
 * magnified, the barrel coloured by the contact load under it, the strip
 * below with its thickness profile on an automatic scale.
 *
 * Rolls are laid out in their stacking order with heights that grow with
 * the diameter but slower than it (a 1300 mm backup roll to scale would be
 * most of the picture and a 65 mm work roll a hairline).
 */
export class FrontView {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(R: Result3D, stack: Stack, o: FrontViewOpts): void {
    const ctx = fit(this.canvas);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const rolls = R.rolls;
    if (!rolls.length) return;
    const xr = -R.x[0];
    const padL = 48, padR = 52, padT = 12, padB = 18;
    const pw = W - padL - padR, ph = H - padT - padB;
    const sx = (x: number) => padL + ((x + xr) / (2 * xr)) * pw;
    const dx = R.x[1] - R.x[0];

    // layers: rolls at (nearly) the same height share a band
    const order = rolls.map((_, i) => i).sort((a, b) => rolls[a].def.cy - rolls[b].def.cy);
    const layers: number[][] = [];
    for (const i of order) {
      const last = layers[layers.length - 1];
      if (last && Math.abs(rolls[last[0]].def.cy - rolls[i].def.cy) < 1e-6) last.push(i);
      else layers.push([i]);
    }
    const stripBand = 60;
    const dref = Math.max(...rolls.map((r) => r.def.D));
    const hOf = (D: number) => Math.pow(D / dref, 0.5);
    let sumH = 0;
    for (const L of layers) sumH += Math.max(...L.map((i) => hOf(rolls[i].def.D)));
    // room between layers: a fixed gap plus the largest magnified
    // deflection, so a roll drawn sagging does not land on the one below
    const pxPerM0 = pw / (2 * xr);
    let vmax = 0;
    for (const r of rolls) for (let s = r.ia; s <= r.ib; s++) if (Number.isFinite(r.v[s])) vmax = Math.max(vmax, Math.abs(r.v[s]));
    // ...but never more than a third of the height across all the layers
    const gap = 8 + Math.min(vmax * o.magnify * pxPerM0, Math.max(0, (0.33 * ph) / layers.length - 8));
    let extra = 0;
    for (const L of layers) if (L.length > 1) extra += (L.length - 1) * 12;
    const avail = ph - stripBand - gap * layers.length - extra;
    const unit = avail / Math.max(sumH, 1e-9);
    // centre lines, from the strip upwards
    const cyPx = new Float64Array(rolls.length), halfPx = new Float64Array(rolls.length);
    let y = padT + ph - stripBand;
    for (const L of layers) {
      const h = Math.max(...L.map((i) => hOf(rolls[i].def.D))) * unit + (L.length - 1) * 12;
      y -= gap + h / 2;
      for (const i of L) { cyPx[i] = y; halfPx[i] = (hOf(rolls[i].def.D) * unit) / 2; }
      y -= h / 2;
    }
    // deflection in pixels: the magnified deflection on the width's own scale
    const pxPerM = pw / (2 * xr);
    const mag = o.magnify;

    const loadOn = (ri: number): Float64Array => {
      const acc = new Float64Array(R.x.length);
      for (const c of R.contacts) {
        if (c.a !== ri && c.b !== ri) continue;
        for (let s = 0; s < acc.length; s++) acc[s] += c.q[s];
      }
      if (ri === stack.wr) for (let s = 0; s < acc.length; s++) acc[s] += Number.isFinite(R.q[s]) ? R.q[s] : 0;
      return acc;
    };
    let qmax = 1e-9;
    const loads = rolls.map((_, i) => loadOn(i));
    for (const l of loads) for (let s = 0; s < l.length; s++) qmax = Math.max(qmax, l[s]);

    ctx.font = FONT;
    // The rolls of a layer that sit side by side in the end view are drawn
    // with a vertical offset so both are seen, and their labels go to
    // alternating sides so they do not land on each other.
    const LAYER_OFF = 12;
    const um = (v: number) => `${(v * 1e6).toFixed(0)} µm`;
    // bow of the axis (centre against the barrel ends) and the roll's own
    // flattening at its heaviest contact; paired rolls of a layer take
    // different spots along the barrel, between the saddle positions
    const labels: { x: number; y: number; text: string }[] = [];
    for (const L of layers) {
      L.forEach((ri, k) => {
        const r = rolls[ri];
        const d = r.def;
        const off = L.length > 1 ? (k - (L.length - 1) / 2) * LAYER_OFF : 0;
        const cy = cyPx[ri] + off;
        const labelLeft = L.length > 1 && k % 2 === 1;
        const hb = halfPx[ri], hn = Math.max(2, hb * (d.Dn / d.D));
        const color = ROLL_COLORS[ri % ROLL_COLORS.length];
        const xa = sx(d.shift - d.Ls / 2), xb = sx(d.shift + d.Ls / 2);
        const x0 = d.shift - d.Lb / 2, x1 = d.shift + d.Lb / 2;
        const s0 = Math.max(r.ia, Math.floor((x0 - R.x[0]) / dx)), s1 = Math.min(r.ib, Math.ceil((x1 - R.x[0]) / dx));
        const vAt = (s: number) => (Number.isFinite(r.v[s]) ? r.v[s] : 0);
        // necks / shaft, each end at the deflected axis there
        ctx.fillStyle = 'rgba(140,170,210,0.16)';
        const yL = cy - vAt(r.ia) * mag * pxPerM, yR = cy - vAt(r.ib) * mag * pxPerM;
        ctx.fillRect(xa, yL - hn, sx(x0) - xa, 2 * hn);
        ctx.fillRect(sx(x1), yR - hn, xb - sx(x1), 2 * hn);
        // the undeflected axis, faint
        ctx.strokeStyle = 'rgba(140,170,210,0.22)';
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(xa, cy + 0.5); ctx.lineTo(xb, cy + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        // barrel following the deflected axis, coloured by load
        for (let s = s0; s < s1; s++) {
          const xa2 = Math.max(x0, R.x[s]), xb2 = Math.min(x1, R.x[s + 1]);
          if (xb2 <= xa2) continue;
          const ya = cy - vAt(s) * mag * pxPerM, yb = cy - vAt(s + 1) * mag * pxPerM;
          const share = (0.5 * (loads[ri][s] + loads[ri][s + 1])) / qmax;
          ctx.fillStyle = share > 0.005 ? heat(share) : 'rgba(110,130,160,0.55)';
          ctx.beginPath();
          ctx.moveTo(sx(xa2), ya - hb); ctx.lineTo(sx(xb2) + 0.7, yb - hb);
          ctx.lineTo(sx(xb2) + 0.7, yb + hb); ctx.lineTo(sx(xa2), ya + hb);
          ctx.closePath();
          ctx.fill();
        }
        // the barrel's outline in the roll's own colour, so two rolls with
        // the same load colour still read as two rolls
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        for (const sgn of [-1, 1]) {
          let pen2 = false;
          for (let s = s0; s <= s1; s++) {
            const xx = Math.max(x0, Math.min(x1, R.x[s]));
            const yy = cy - vAt(s) * mag * pxPerM + sgn * hb;
            if (!pen2) { ctx.moveTo(sx(xx), yy); pen2 = true; } else ctx.lineTo(sx(xx), yy);
          }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        // the axis line carries the deflected shape
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let pen = false;
        for (let s = r.ia; s <= r.ib; s++) {
          const v = r.v[s];
          if (!Number.isFinite(v)) { pen = false; continue; }
          const px = sx(R.x[s]), py = cy - v * mag * pxPerM;
          if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.textAlign = labelLeft ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.id, labelLeft ? xa - 5 : xb + 5, cy);
        // the roll's numbers go on the barrel, drawn after every roll so
        // nothing lands on them (see below)
        {
          const frac = L.length > 1 ? (k === 0 ? 0.34 : 0.66) : 0.5;
          const xm = x0 + (x1 - x0) * frac;
          const sMid = Math.max(r.ia, Math.min(r.ib, Math.round((xm - R.x[0]) / dx)));
          labels.push({ x: sx(xm), y: cy - vAt(sMid) * mag * pxPerM, text: `${d.id}  撓み ${um(r.bow)}  扁平 ${um(r.flatMax)}` });
        }
        for (const s of r.supports) {
          const px = sx(R.x[s]);
          const py = cy - vAt(s) * mag * pxPerM;
          ctx.fillStyle = d.support === 'saddle' ? '#ffc46b' : d.support === 'screw' ? '#ff6b81' : '#6ee7a5';
          ctx.beginPath();
          ctx.moveTo(px, py - hb - 2); ctx.lineTo(px - 4, py - hb - 9); ctx.lineTo(px + 4, py - hb - 9);
          ctx.closePath(); ctx.fill();
        }
      });
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      const tw = ctx.measureText(l.text).width + 10;
      ctx.fillStyle = 'rgba(7, 10, 18, 0.8)';
      ctx.fillRect(l.x - tw / 2, l.y - 8, tw, 16);
      ctx.fillStyle = TEXT_BRIGHT;
      ctx.fillText(l.text, l.x, l.y);
    }

    // the strip: the exit profile on an automatic scale
    const yTop = padT + ph - stripBand + 6;
    let hmin = Infinity, hmax = -Infinity;
    for (let s = 0; s < R.x.length; s++) {
      const h = R.h1[s];
      if (!Number.isFinite(h)) continue;
      hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    }
    if (Number.isFinite(hmin)) {
      const span = Math.max(hmax - hmin, 1e-9);
      const bandPx = 22;
      ctx.fillStyle = STRIP_COLOR;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      let pen = false;
      for (let s = 0; s < R.x.length; s++) {
        const h = R.h1[s];
        if (!Number.isFinite(h)) continue;
        const px = sx(R.x[s]);
        const py = yTop + bandPx - ((h - hmin) / span) * bandPx;
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
      ctx.lineTo(sx(o.width / 2), yTop + bandPx + 6);
      ctx.lineTo(sx(-o.width / 2), yTop + bandPx + 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // the label sits under the strip, centred, clear of the barrels above
      // and the legend line below
      ctx.fillStyle = TEXT;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText(`板 h₁ (p-p ${(span * 1e6).toFixed(1)} µm, 自動スケール)`, sx(0), yTop + bandPx + 8);
    }
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`撓み ×${mag.toFixed(0)}`, 8, H - 4);
    // the support markers, spelled out
    let lx = 8 + ctx.measureText(`撓み ×${mag.toFixed(0)}`).width + 18;
    for (const [col, name] of [['#ff6b81', '圧下スクリュー'], ['#ffc46b', 'サドル'], ['#6ee7a5', 'ベンダー付きチョック']] as const) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(lx, H - 5); ctx.lineTo(lx - 4, H - 12); ctx.lineTo(lx + 4, H - 12); ctx.closePath(); ctx.fill();
      ctx.fillStyle = TEXT;
      ctx.fillText(name, lx + 7, H - 4);
      lx += ctx.measureText(name).width + 22;
    }
    ctx.textAlign = 'right';
    ctx.fillText(`胴の色 = 接触線荷重 0 〜 ${(qmax / 1e6).toFixed(2)} kN/mm`, W - 8, H - 4);
  }
}

/** The cluster seen along the roll axes: circles, contacts weighted by force. */
export class EndView {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(R: Result3D, stack: Stack, width: number, tonf: number): void {
    const ctx = fit(this.canvas);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const rolls = stack.rolls;
    if (!rolls.length) return;
    let top = 0, zmax = 0;
    for (const r of rolls) { top = Math.max(top, r.cy + r.D / 2); zmax = Math.max(zmax, Math.abs(r.cz) + r.D / 2); }
    const wr = rolls[stack.wr];
    const bottom = -wr.D / 2 - 0.02;
    const pad = 14;
    const scale = Math.min((W - 2 * pad) / (2 * zmax + 0.02), (H - 2 * pad - 12) / (top - bottom));
    const cx = W / 2, cy0 = pad + top * scale;
    const px = (z: number) => cx + z * scale;
    const py = (y: number) => cy0 - y * scale;

    // contacts: a designated one carrying nothing is a dashed grey line; a
    // pair that meets with no contact between them is a red one
    let fmax = 1e-9;
    for (const c of R.contacts) fmax = Math.max(fmax, c.total);
    fmax = Math.max(fmax, R.force);
    ctx.lineCap = 'round';
    for (const c of R.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      const t = c.total / fmax;
      if (c.total <= 0) { ctx.strokeStyle = 'rgba(140,170,210,0.5)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; }
      else { ctx.strokeStyle = heat(t); ctx.setLineDash([]); ctx.lineWidth = 1 + 7 * t; }
      ctx.beginPath(); ctx.moveTo(px(A.cz), py(A.cy)); ctx.lineTo(px(B.cz), py(B.cy)); ctx.stroke();
    }
    ctx.setLineDash([]);
    const designated = new Set(R.contacts.map((c) => `${Math.min(c.a, c.b)}-${Math.max(c.a, c.b)}`));
    for (let a = 0; a < rolls.length; a++) {
      for (let b = a + 1; b < rolls.length; b++) {
        if (designated.has(`${a}-${b}`)) continue;
        const A = rolls[a], B = rolls[b];
        if (Math.hypot(A.cy - B.cy, A.cz - B.cz) - (A.D + B.D) / 2 >= 0) continue;
        ctx.strokeStyle = '#ff6b81';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px(A.cz), py(A.cy)); ctx.lineTo(px(B.cz), py(B.cy)); ctx.stroke();
      }
    }
    // strip
    ctx.fillStyle = STRIP_COLOR;
    ctx.fillRect(px(-0.6 * (zmax + wr.D)), py(-wr.D / 2) , 1.2 * (zmax + wr.D) * scale, 3);
    // the strip's push on the work roll
    ctx.strokeStyle = heat(R.force / fmax);
    ctx.lineWidth = 1 + 7 * (R.force / fmax);
    ctx.beginPath(); ctx.moveTo(px(0), py(-wr.D / 2)); ctx.lineTo(px(0), py(0)); ctx.stroke();
    // rolls
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    rolls.forEach((r, i) => {
      const color = ROLL_COLORS[i % ROLL_COLORS.length];
      ctx.beginPath();
      ctx.arc(px(r.cz), py(r.cy), (r.D / 2) * scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(17, 24, 38, 0.92)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (r.shaftBeam) {
        ctx.beginPath();
        ctx.arc(px(r.cz), py(r.cy), (r.Dn / 2) * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(140,170,210,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = color;
      if ((r.D / 2) * scale > 14) ctx.fillText(r.id, px(r.cz), py(r.cy));
      // supports
      if (r.support === 'saddle' || r.support === 'screw') {
        const nA = r.support === 'saddle' ? r.cy : 1, nB = r.support === 'saddle' ? r.cz : 0;
        const nn = Math.hypot(nA, nB) || 1;
        const ex = px(r.cz + (nB / nn) * (r.D / 2)), ey = py(r.cy + (nA / nn) * (r.D / 2));
        ctx.fillStyle = r.support === 'saddle' ? '#ffc46b' : '#ff6b81';
        ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    });
    // contact force labels
    ctx.textBaseline = 'middle';
    for (const c of R.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      const mx = px(0.5 * (A.cz + B.cz)), my = py(0.5 * (A.cy + B.cy));
      const label = `${(c.total / tonf).toFixed(0)}`;
      ctx.fillStyle = 'rgba(7,10,18,0.8)';
      const tw = ctx.measureText(label).width + 6;
      ctx.fillRect(mx - tw / 2, my - 7, tw, 14);
      ctx.fillStyle = TEXT_BRIGHT;
      ctx.fillText(label, mx, my);
    }
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const ang = stack.type === '12hi' || stack.type === '20hi' ? ` ／ 第1中間 ${((stack.angle1 * 180) / Math.PI).toFixed(1)}°` : '';
    ctx.fillText(`接触力 [tonf] ／ 板幅 ${(width * 1e3).toFixed(0)} mm${ang}`, pad, H - 3);
  }
}

export type { RollState };

/**
 * The work roll's cross-section ring mesh, with the deformation under the
 * contact load at the strip centre magnified. The half ring the solve uses
 * is mirrored to a full one; the load axis points down, at the strip.
 */
export class SectionView {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(inf: RingInfluence | undefined, q: number, magnify: number, label: string): void {
    const ctx = fit(this.canvas);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.font = FONT;
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (!inf) {
      ctx.fillText('扁平モデルが Hertz 式のときは断面メッシュはありません', 8, 8);
      return;
    }
    const pad = 14;
    const scale = (Math.min(W, H) / 2 - pad) / inf.R;
    const cx = W / 2, cy = H / 2;
    const { X, u, rows, cols } = inf;
    const px = (x: number, y: number, ux: number, uy: number, side: 1 | -1): [number, number] =>
      [cx + side * (x + ux * q * magnify) * scale, cy - (y + uy * q * magnify) * scale];
    // element edges: radial lines and rings, mirrored
    ctx.lineWidth = 0.7;
    for (const side of [1, -1] as const) {
      ctx.strokeStyle = side === 1 ? 'rgba(127, 228, 255, 0.45)' : 'rgba(127, 228, 255, 0.45)';
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const n = i * rows + j;
          const [x, y] = px(X[2 * n], X[2 * n + 1], u[2 * n], u[2 * n + 1], side);
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const n = i * rows + j;
          const [x, y] = px(X[2 * n], X[2 * n + 1], u[2 * n], u[2 * n + 1], side);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    // the undeformed barrel and hub, faint
    ctx.strokeStyle = 'rgba(140,170,210,0.3)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.arc(cx, cy, inf.R * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, inf.Rhub * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // the load
    ctx.strokeStyle = STRIP_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy + inf.R * scale + 10); ctx.lineTo(cx, cy + inf.R * scale + 2); ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillText(label, 8, 8);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`変形 ×${magnify.toFixed(0)} ／ nt ${inf.nt} × nr ${inf.nr} ／ ハブ ${(inf.Rhub / inf.R).toFixed(2)} R`, 8, H - 6);
  }
}

/** a scalar field on the bite's (x, z) grid as a heat map: columns across the width, rows entry → exit */
export class HeatChart {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(
    field: Float64Array | null, ncol: number, nrow: number, x: ArrayLike<number>, arc: ArrayLike<number>,
    o: { unit: string; scale: number; halfWidth: number; symmetric?: boolean; note?: string },
  ): void {
    const ctx = fit(this.canvas);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.font = FONT;
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (!field || ncol < 1 || nrow < 1) { ctx.fillText(o.note ?? '材料モデルが平面 FEM のときに表示', 8, 8); return; }
    const padL = 46, padR = 62, padT = 8, padB = 20;
    const pw = W - padL - padR, ph = H - padT - padB;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < field.length; i++) { const v = field[i] * o.scale; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) return;
    if (o.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-12); lo = -m; hi = m; }
    if (hi - lo < 1e-12) hi = lo + 1;
    const xr = o.halfWidth * 1e3;
    const sx = (xx: number) => padL + ((xx + xr) / (2 * xr)) * pw;
    const ramp = (t: number): string => {
      const c = Math.max(0, Math.min(1, t));
      if (o.symmetric) {
        // blue - dark - orange
        const u = c * 2 - 1;
        const r = u > 0 ? 40 + 215 * u : 40, g = u > 0 ? 60 + 100 * u : 60 + 80 * -u, b = u < 0 ? 90 + 165 * -u : 90;
        return `rgb(${r | 0},${g | 0},${b | 0})`;
      }
      const r = 30 + 225 * Math.min(1, c * 1.5), g = 40 + 170 * (c < 0.6 ? c / 0.6 : 1) - 120 * Math.max(0, c - 0.6) / 0.4, b = 110 - 100 * c;
      return `rgb(${r | 0},${g | 0},${b | 0})`;
    };
    // columns sit between strip stations; each row is a slice of the arc
    // from entry (top) to exit (bottom), the arc length its own per column
    let arcMax = 1e-9;
    for (let i = 0; i < x.length; i++) if (Number.isFinite(arc[i])) arcMax = Math.max(arcMax, arc[i]);
    for (let c = 0; c < ncol; c++) {
      const x0 = sx(x[c] * 1e3), x1 = sx(x[c + 1] * 1e3);
      const L = 0.5 * ((Number.isFinite(arc[c]) ? arc[c] : 0) + (Number.isFinite(arc[c + 1]) ? arc[c + 1] : 0));
      const hFrac = Math.max(L / arcMax, 0.04);
      for (let r = 0; r < nrow; r++) {
        const v = field[c * nrow + r] * o.scale;
        ctx.fillStyle = ramp((v - lo) / (hi - lo));
        const y0 = padT + ph * (1 - hFrac) + (ph * hFrac * r) / nrow;
        const y1 = padT + ph * (1 - hFrac) + (ph * hFrac * (r + 1)) / nrow;
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.5), y1 - y0 + 0.5);
      }
    }
    // axes
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) { const xx = -xr + (2 * xr * i) / 4; ctx.fillText(`${xx.toFixed(0)}`, sx(xx), padT + ph + 4); }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('入側', padL - 5, padT + ph * 0.06);
    ctx.fillText('出側', padL - 5, padT + ph - 6);
    ctx.fillText(`弧 ${(arcMax * 1e3).toFixed(1)} mm`, padL - 5, padT + ph * 0.5);
    // colour bar
    const bx = W - padR + 10, bw = 10;
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = ramp(1 - k / 40);
      ctx.fillRect(bx, padT + (ph * k) / 40, bw, ph / 40 + 0.5);
    }
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(nice(hi), bx + bw + 4, padT);
    ctx.textBaseline = 'bottom';
    ctx.fillText(nice(lo), bx + bw + 4, padT + ph);
    ctx.textBaseline = 'middle';
    ctx.fillText(o.unit, bx + bw + 4, padT + ph / 2);
  }
}

/**
 * Canvas 2D drawing for the 3D tab: profile charts across the strip width,
 * the front view of the roll stack, and the end view of the cluster.
 *
 * The same dark palette as the 2D tab's canvases, in every theme.
 */

import type { Result3D, RollState } from '../sim3d/solver';
import type { Stack } from '../sim3d/stack';

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
  constructor(private canvas: HTMLCanvasElement) {}

  draw(series: XYSeries[], o: LineChartOpts): void {
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
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = s.color;
        ctx.lineTo(sx(s.x[s.x.length - 1] * 1e3), sy(0));
        ctx.lineTo(sx(s.x[0] * 1e3), sy(0));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
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
    const padL = 14, padR = 52, padT = 12, padB = 18;
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
    const stripBand = 44;
    const dref = Math.max(...rolls.map((r) => r.def.D));
    const hOf = (D: number) => Math.pow(D / dref, 0.55);
    let sumH = 0;
    for (const L of layers) sumH += Math.max(...L.map((i) => hOf(rolls[i].def.D)));
    const gap = 10;
    const avail = ph - stripBand - gap * layers.length;
    const unit = avail / Math.max(sumH, 1e-9);
    // centre lines, from the strip upwards
    const cyPx = new Float64Array(rolls.length), halfPx = new Float64Array(rolls.length);
    let y = padT + ph - stripBand;
    for (const L of layers) {
      const h = Math.max(...L.map((i) => hOf(rolls[i].def.D))) * unit;
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
    // the rolls of a layer that sit side by side in the end view are drawn
    // offset a little so both are seen
    for (const L of layers) {
      L.forEach((ri, k) => {
        const r = rolls[ri];
        const d = r.def;
        const off = L.length > 1 ? (k - (L.length - 1) / 2) * 6 : 0;
        const cy = cyPx[ri] + off;
        const hb = halfPx[ri], hn = Math.max(2, hb * (d.Dn / d.D));
        const color = ROLL_COLORS[ri % ROLL_COLORS.length];
        const xa = sx(d.shift - d.Ls / 2), xb = sx(d.shift + d.Ls / 2);
        // necks / shaft
        ctx.fillStyle = 'rgba(140,170,210,0.16)';
        ctx.fillRect(xa, cy - hn, xb - xa, 2 * hn);
        // the undeflected axis, faint
        ctx.strokeStyle = 'rgba(140,170,210,0.22)';
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(xa, cy + 0.5); ctx.lineTo(xb, cy + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        // barrel following the deflected axis, coloured by load
        const x0 = d.shift - d.Lb / 2, x1 = d.shift + d.Lb / 2;
        const s0 = Math.max(r.ia, Math.floor((x0 - R.x[0]) / dx)), s1 = Math.min(r.ib, Math.ceil((x1 - R.x[0]) / dx));
        const vAt = (s: number) => (Number.isFinite(r.v[s]) ? r.v[s] : 0);
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
        // taper / crown hint: none drawn; the axis line carries the shape
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
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.id, xb + 5, cy);
        for (const s of r.supports) {
          const px = sx(R.x[s]);
          ctx.fillStyle = d.support === 'saddle' ? '#ffc46b' : d.support === 'screw' ? '#ff6b81' : '#6ee7a5';
          ctx.beginPath();
          ctx.moveTo(px, cy - hb - 2); ctx.lineTo(px - 4, cy - hb - 9); ctx.lineTo(px + 4, cy - hb - 9);
          ctx.closePath(); ctx.fill();
        }
      });
    }

    // the strip: the exit profile on an automatic scale
    const yTop = padT + ph - stripBand + 8;
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
      ctx.fillStyle = TEXT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`板 h₁ (p-p ${(span * 1e6).toFixed(1)} µm, 自動スケール)`, sx(o.width / 2) + 6, yTop + bandPx / 2);
    }
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`撓み ×${mag.toFixed(0)}`, padL, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`胴の色 = 接触線荷重 0 〜 ${(qmax / 1e6).toFixed(2)} kN/mm`, W - padR, H - 4);
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

    // contacts
    let fmax = 1e-9;
    for (const c of R.contacts) fmax = Math.max(fmax, c.total);
    fmax = Math.max(fmax, R.force);
    ctx.lineCap = 'round';
    for (const c of R.contacts) {
      const A = rolls[c.a], B = rolls[c.b];
      const t = c.total / fmax;
      ctx.strokeStyle = heat(t);
      ctx.lineWidth = 1 + 7 * t;
      ctx.beginPath(); ctx.moveTo(px(A.cz), py(A.cy)); ctx.lineTo(px(B.cz), py(B.cy)); ctx.stroke();
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
    ctx.fillText(`接触力 [tonf] ／ 板幅 ${(width * 1e3).toFixed(0)} mm`, pad, H - 3);
  }
}

export type { RollState };

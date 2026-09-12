/** Canvas 2D charts: a stacked frame-budget sparkline and the nip pressure plot. */

const FONT = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

function fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export interface Series {
  label: string;
  color: string;
  data: Float32Array;
}

/**
 * Rolling stacked-area chart of the per-frame time budget. The band heights are
 * the actual milliseconds spent in each stage, so the 16.7 ms line shows at a
 * glance whether the frame fits in a 60 Hz budget.
 */
export class BudgetChart {
  private canvas: HTMLCanvasElement;
  private series: Series[];
  private head = 0;
  private len: number;

  constructor(canvas: HTMLCanvasElement, labels: [string, string][], len = 180) {
    this.canvas = canvas;
    this.len = len;
    this.series = labels.map(([label, color]) => ({
      label, color, data: new Float32Array(len),
    }));
  }

  push(values: number[]): void {
    for (let i = 0; i < this.series.length; i++) {
      this.series[i].data[this.head] = values[i] ?? 0;
    }
    this.head = (this.head + 1) % this.len;
  }

  draw(): void {
    const ctx = fit(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // autoscale on the recent peak, but never below one 60 Hz frame
    let peak = 16.7;
    for (let i = 0; i < this.len; i++) {
      let s = 0;
      for (const ser of this.series) s += ser.data[i];
      if (s > peak) peak = s;
    }
    peak *= 1.15;
    const yOf = (v: number) => h - (v / peak) * h;

    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(0, 0, w, h);

    const stack = new Float32Array(this.len);
    for (const ser of this.series) {
      ctx.beginPath();
      for (let k = 0; k < this.len; k++) {
        const i = (this.head + k) % this.len;
        const x = (k / (this.len - 1)) * w;
        ctx.lineTo(x, yOf(stack[i] + ser.data[i]));
      }
      for (let k = this.len - 1; k >= 0; k--) {
        const i = (this.head + k) % this.len;
        ctx.lineTo((k / (this.len - 1)) * w, yOf(stack[i]));
      }
      ctx.closePath();
      ctx.fillStyle = ser.color;
      ctx.fill();
      for (let i = 0; i < this.len; i++) stack[i] += ser.data[i];
    }

    // 60 Hz and 30 Hz budget guides
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    for (const [ms, col, tag] of [[16.7, 'rgba(120,220,170,0.55)', '60'], [33.3, 'rgba(240,180,90,0.45)', '30']] as [number, string, string][]) {
      if (ms > peak) continue;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, yOf(ms)); ctx.lineTo(w, yOf(ms));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.font = FONT;
      ctx.fillText(`${tag}fps`, 3, yOf(ms) - 3);
      ctx.setLineDash([3, 3]);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(226,238,255,0.6)';
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillText(`${peak.toFixed(0)} ms`, w - 3, 11);
    ctx.textAlign = 'left';
  }

  legend(): { label: string; color: string }[] {
    return this.series.map((s) => ({ label: s.label, color: s.color }));
  }
}

export interface HillSample {
  /** position along the rolling direction, relative to the exit plane [mm] */
  x: number;
  /** interface normal pressure [MPa] */
  p: number;
  /** interface shear traction, signed [MPa] */
  tau: number;
}

export interface HillMarkers {
  /** neutral point [mm], null when the whole arc slips */
  neutralX: number | null;
  /**
   * The FEM's own neutral point [mm] when the hill drawn is a theory's, so
   * the two are seen apart; null under the FEM load (they are the same) or
   * when the FEM has none (the strip is skidding).
   */
  neutralFemX: number | null;
  /** plane strain flow stress [MPa], drawn as a reference line */
  flowStress: number;
  /** slab-method mean pressure [MPa] */
  slabMean: number;
  /** entry and exit edges of the contact arc [mm] */
  arcIn: number;
  arcOut: number;
  /**
   * The deformation resistance along the arc [mm, MPa] - the FEM's own
   * column by column under the FEM load, the selected slab theory's along
   * its own arc under the slab load - and what to call it.
   */
  kfCurve: { x: number; kf: number }[];
  kfLabel: string;
  /**
   * The other stands' pressure profiles, drawn as thin outlines behind the
   * selected stand's filled hill, each named at its entry end - so a line
   * reads as a line, the way the control trail does, while the numbers on
   * the axes belong to the stand that was clicked.
   */
  others: { tag: string; samples: HillSample[] }[];
}

/**
 * The friction hill: interface pressure and shear along the contact arc, the
 * plot every rolling text opens with. The neutral point is where the shear
 * changes sign, i.e. where the strip and the barrel run at the same speed.
 */
export class FrictionHillChart {
  private canvas: HTMLCanvasElement;
  private peakHold = 0;
  private inHold = 0;
  private outHold = 0;

  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; }

  draw(samples: HillSample[], mk: HillMarkers): void {
    const ctx = fit(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // padT leaves a caption band above the plot: the axis units used to be
    // drawn level with the topmost gridline, i.e. straight through that
    // gridline's own tick number.
    const padL = 46, padR = 46, padT = 21, padB = 20;
    const capY = 11;
    ctx.clearRect(0, 0, w, h);

    let pmax = mk.flowStress * 1.2, xlo = 0, xhi = 0;
    for (const s of samples) {
      if (s.p > pmax) pmax = s.p;
      if (s.x < xlo) xlo = s.x;
      if (s.x > xhi) xhi = s.x;
    }
    // The theory's arc is its own - longer than the FEM's where it flattens
    // the roll more - and the window has to hold it, and the other stands.
    for (const k of mk.kfCurve) {
      if (k.kf > pmax) pmax = k.kf;
      if (k.x < xlo) xlo = k.x;
    }
    for (const o of mk.others) {
      for (const s of o.samples) {
        if (s.p > pmax) pmax = s.p;
        if (s.x < xlo) xlo = s.x;
      }
    }
    this.peakHold = Math.max(pmax, this.peakHold * 0.985);
    // The window is asymmetric because the arc is: it runs from the entry edge
    // up to the exit plane at x = 0 and stops there. Mirroring the entry side
    // into positive x, as this did, spent half the plot on ground the strip is
    // never on - the hill was drawn at half the resolution the cell allows.
    // The margin past the exit is kept small but non-zero so the exit plane is
    // a line in the plot rather than the right-hand border.
    this.inHold = Math.max(-xlo * 1.08, this.inHold * 0.985, 3);
    this.outHold = Math.max(xhi, this.outHold * 0.985, this.inHold * 0.1);
    const py = Math.max(this.peakHold * 1.15, 10);
    const x0 = -this.inHold, x1 = this.outHold;

    const X = (v: number) => padL + ((v - x0) / (x1 - x0)) * (w - padL - padR);
    const Y = (v: number) => h - padB - (v / py) * (h - padT - padB);
    // shear uses its own, tighter scale on the right axis
    const tScale = Math.max(py * 0.35, 1);
    const YT = (v: number) => (h - padB + padT) / 2 - (v / tScale) * (h - padT - padB) / 2;

    ctx.font = FONT;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(190,206,230,0.55)';
    for (let i = 0; i <= 4; i++) {
      const v = (py * i) / 4;
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(0), padL - 5, y + 3);
    }
    ctx.textAlign = 'center';
    // entry edge, the middle of the bite, the exit plane, and the far margin
    for (const v of [x0, x0 / 2, 0, x1]) {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      // the far margin is a hair past the exit plane; two labels on top of each
      // other there would say nothing the "0" does not
      if (v !== x1 || X(x1) - X(0) > 24) {
        ctx.fillText(v.toFixed(Math.abs(v) < 3 && v !== 0 ? 1 : 0), x, h - 6);
      }
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(190,206,230,0.45)';
    ctx.fillText('MPa', 4, capY);
    ctx.textAlign = 'right';
    // clear of the far-margin tick, which now sits at the right edge of the plot
    ctx.fillText('mm', w - 4, h - 6);
    ctx.fillStyle = 'rgba(255,180,120,0.6)';
    ctx.fillText(`τ ±${tScale.toFixed(0)}`, w - 4, capY);
    ctx.textAlign = 'left';

    // flow stress and slab-method reference levels
    for (const [v, col, tag] of [
      [mk.flowStress, 'rgba(150,230,180,0.6)', 'kf'],
      [mk.slabMean, 'rgba(255,196,120,0.65)', 'スラブ法 p̄'],
    ] as [number, string, string][]) {
      if (v <= 0 || v > py) continue;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(tag, padL + 4, Y(v) - 3);
    }

    // The other stands first, under the selected one's fill. Named at the
    // exit end, where the reference lines are not, each tag dropping past
    // the one before if they would land on each other.
    const tagYs: number[] = [];
    for (const o of mk.others) {
      if (o.samples.length < 2) continue;
      ctx.beginPath();
      o.samples.forEach((s, i) => (i ? ctx.lineTo(X(s.x), Y(s.p)) : ctx.moveTo(X(s.x), Y(s.p))));
      ctx.strokeStyle = 'rgba(127,228,255,0.42)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      const tail = o.samples[o.samples.length - 1];
      let y = Y(tail.p) - 4;
      while (tagYs.some((t) => Math.abs(t - y) < 11)) y -= 11;
      tagYs.push(y);
      ctx.fillStyle = 'rgba(127,228,255,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(o.tag, X(tail.x) - 3, y);
      ctx.textAlign = 'left';
    }
    if (samples.length > 1) {
      const grad = ctx.createLinearGradient(0, Y(py), 0, Y(0));
      grad.addColorStop(0, 'rgba(96,214,255,0.5)');
      grad.addColorStop(1, 'rgba(96,214,255,0.04)');
      ctx.beginPath();
      ctx.moveTo(X(samples[0].x), Y(0));
      for (const s of samples) ctx.lineTo(X(s.x), Y(s.p));
      ctx.lineTo(X(samples[samples.length - 1].x), Y(0));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      samples.forEach((s, i) => (i ? ctx.lineTo(X(s.x), Y(s.p)) : ctx.moveTo(X(s.x), Y(s.p))));
      ctx.strokeStyle = '#7fe4ff';
      ctx.lineWidth = 1.9;
      ctx.stroke();

      ctx.beginPath();
      samples.forEach((s, i) => (i ? ctx.lineTo(X(s.x), YT(s.tau)) : ctx.moveTo(X(s.x), YT(s.tau))));
      ctx.strokeStyle = 'rgba(255,178,110,0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,178,110,0.25)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(padL, YT(0)); ctx.lineTo(w - padR, YT(0)); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(190,206,230,0.4)';
      ctx.textAlign = 'center';
      ctx.fillText('接触なし', w / 2, h / 2);
      ctx.textAlign = 'left';
    }

    // The resistance the load is built on, along the arc: rising through
    // the bite as the metal hardens, flat where the theory has a single
    // number for it. Solid, against the dashed mean it averages to.
    if (mk.kfCurve.length > 1) {
      ctx.beginPath();
      mk.kfCurve.forEach((k, i) => (i ? ctx.lineTo(X(k.x), Y(k.kf)) : ctx.moveTo(X(k.x), Y(k.kf))));
      ctx.strokeStyle = 'rgba(150,230,180,0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // named at the exit end, whichever way the profile was listed
      const head = mk.kfCurve.reduce((a, b) => (b.x > a.x ? b : a));
      ctx.fillStyle = 'rgba(150,230,180,0.95)';
      ctx.textAlign = 'right';
      ctx.fillText(`kf ${mk.kfLabel}`, X(head.x) - 3, Y(head.kf) - 4);
      ctx.textAlign = 'left';
    }

    if (mk.neutralFemX !== null && mk.neutralFemX >= x0 && mk.neutralFemX <= x1) {
      const x = Math.round(X(mk.neutralFemX)) + 0.5;
      ctx.strokeStyle = 'rgba(255,110,140,0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,140,165,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('FEM', x, h - padB - 4);
      ctx.textAlign = 'left';
    }
    if (mk.neutralX !== null && mk.neutralX >= x0 && mk.neutralX <= x1) {
      const x = Math.round(X(mk.neutralX)) + 0.5;
      ctx.strokeStyle = 'rgba(255,110,140,0.9)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,140,165,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText('中立点', x, padT + 10);
      ctx.textAlign = 'left';
    }
  }
}

export interface AgcSample {
  /** exit thickness actually measured [mm] */
  h1: number;
  /** reduction that implies, 100*(1 - h1/h0) [%] */
  reduction: number;
  /** roll separating force over the whole strip width [tonf] */
  load: number;
}

export interface AgcTargets {
  /** commanded exit thickness [mm] */
  h1: number;
  /** the reduction that implies [%] */
  reduction: number;
  /** load target [tonf]; only meaningful under load control */
  load: number;
  /** which of the two the loop is actually holding */
  mode: 'gauge' | 'force';
}

/** One stand's trail: everything the scatter needs to draw that stand alone. */
export interface AgcTrail {
  /** how the stand is captioned elsewhere in the UI - `#2`, `P3` */
  tag: string;
  samples: AgcSample[];
  /** what this stand's loop is holding; null when its screws are parked */
  target: AgcTargets | null;
  /**
   * The plastic-curve slope the loop has identified, dP/dh1 in tonf per
   * micron over the strip width - negative, thinner is heavier. Null until
   * two revisions have been far enough apart to read it. Drawn beside the
   * head of the trail with the stand's name.
   */
  slope: number | null;
}

/**
 * Where every stand's gap loop has been, over its last few dozen screw
 * revisions.
 *
 * Exit thickness on x, with the reduction on the left axis and the roll force
 * on the right. The reduction is an exact affine map of the thickness (h0 is
 * fixed), so that series is a straight line by construction - it is there to
 * read the axis against, and the information is in the load: the same picture
 * as a mill's plastic curve, traced out by the controller instead of assumed.
 *
 * Every controlled stand is drawn at once. They do not collide: a stand's
 * trail sits at the gauge that stand rolls to, so a tandem line reads
 * left-to-right as its own pass schedule, each cluster a loop settling at its
 * own exit thickness. Colour stays with the quantity so it keeps matching the
 * two axes; the stand is named at the head of its trail instead.
 *
 * Points fade with age and are joined in time order, so a converging loop
 * reads as a trail collapsing onto its target and a hunting one as a cluster
 * that will not close.
 */
export class AgcScatterChart {
  private canvas: HTMLCanvasElement;
  /**
   * Fixed axes, so the picture means the same thing from one run to the next.
   *
   * Fitting the box to the data made every settled loop look identical: the
   * cluster collapsed to the middle whatever gauge or load it had settled at,
   * and the only way to tell a 700 tonf pass from a 2000 tonf one was to read
   * the tick labels. Held still, the trail's *position* carries the schedule -
   * a thin-gauge pass sits left, a heavy one sits high - and two runs can be
   * compared by eye.
   *
   * Anything outside is clamped to the edge rather than dropped, and the edge
   * marker says so, so a run off the end of the scale is visible as one.
   */
  /**
   * The gauge axis follows the schedule rather than a constant: from the last
   * stand's target exit gauge minus a margin up to the line's entry gauge
   * plus the same margin, set by `setGaugeRange`. Fixed 0.15-2.0 mm put a
   * 0.25 mm schedule in the left tenth of the plot and a 6 mm one off the end.
   * The margin is what keeps the trails off the edges while they settle.
   */
  private x0 = 0.15;
  private x1 = 2.0;
  private static readonly R0 = 10;
  private static readonly R1 = 55;
  private static readonly P0 = 600;
  private static readonly P1 = 2400;

  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; }

  /**
   * Set the gauge axis [mm]. `lo` is the thinnest gauge the line is asked
   * for, `hi` the gauge it is fed; the axis runs `margin` past each. A range
   * that would come out inverted or degenerate is widened to a minimum span
   * around its own centre rather than rejected, so the chart never goes blank
   * on a half-typed schedule.
   */
  setGaugeRange(lo: number, hi: number, margin = 0.2): void {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    let a = Math.max(0, lo - margin);
    let b = hi + margin;
    const minSpan = 0.05;
    if (b - a < minSpan) {
      const c = 0.5 * (a + b);
      a = Math.max(0, c - minSpan / 2);
      b = a + minSpan;
    }
    this.x0 = a;
    this.x1 = b;
  }

  draw(trails: AgcTrail[]): void {
    const ctx = fit(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const padL = 40, padR = 44, padT = 12, padB = 19;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const live = trails.filter((t) => t.target && t.samples.length > 0);
    const slopeLabels: { x: number; y: number; toRight: boolean; text: string }[] = [];
    if (live.length === 0) {
      const anyControlled = trails.some((t) => t.target);
      ctx.fillStyle = 'rgba(190,206,230,0.4)';
      ctx.textAlign = 'center';
      ctx.fillText(anyControlled ? 'データ待ち' : '制御 OFF のとき散布図は出ない', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const { R0: r0, R1: r1, P0: p0, P1: p1 } = AgcScatterChart;
    const x0 = this.x0, x1 = this.x1;

    // Clamped, not clipped: a point off the scale is pinned to the edge and
    // marked there. Dropping it would leave the trail with a silent gap, which
    // reads as a converged loop rather than as one that has left the chart.
    let off = false;
    const clamp = (v: number, lo: number, hi: number) => {
      if (v < lo) { off = true; return lo; }
      if (v > hi) { off = true; return hi; }
      return v;
    };
    const X = (v: number) =>
      padL + ((clamp(v, x0, x1) - x0) / (x1 - x0)) * (w - padL - padR);
    const YR = (v: number) =>
      h - padB - ((clamp(v, r0, r1) - r0) / (r1 - r0)) * (h - padT - padB);
    const YP = (v: number) =>
      h - padB - ((clamp(v, p0, p1) - p0) / (p1 - p0)) * (h - padT - padB);

    // grid, left axis ticks in %, right axis ticks in tonf
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = Math.round(padT + ((h - padT - padB) * i) / 3) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const rv = r1 - ((r1 - r0) * i) / 3;
      const pv = p1 - ((p1 - p0) * i) / 3;
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(127,228,255,0.7)';
      ctx.fillText(rv.toFixed(0), padL - 5, y + 3);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,178,110,0.7)';
      ctx.fillText(pv.toFixed(0), w - padR + 5, y + 3);
    }
    ctx.fillStyle = 'rgba(190,206,230,0.55)';
    // The two ends are the schedule's own numbers and are labelled as such;
    // between them, round gauges at a 1-2-5 pitch chosen for about four
    // intervals, so the ticks stay numbers a schedule is written in whatever
    // span the line happens to have.
    const span = x1 - x0;
    const rawPitch = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawPitch)));
    const pitch = [1, 2, 5, 10].map((m) => m * mag).find((p) => p >= rawPitch) ?? mag * 10;
    // Inner ticks keep clear of the two end labels by pixels, not by a
    // fraction of the pitch: at 2.200 the end label is five characters wide
    // and a 2.00 tick a few pixels in from it printed as one smeared number.
    const dp = pitch >= 1 ? 1 : pitch >= 0.1 ? 2 : 3;
    // The end labels are left/right aligned to their ticks and the inner ones
    // centred, so an inner tick needs the whole end label plus half its own
    // clear - measured, not guessed: 34 px was under a five-digit end label
    // and 1.50 printed straight through 1.701.
    const endW = Math.max(ctx.measureText(x0.toFixed(3)).width, ctx.measureText(x1.toFixed(3)).width);
    const innerHalf = ctx.measureText((x0 + pitch).toFixed(dp)).width / 2;
    const clear = endW + innerHalf + 8;
    const inner: number[] = [];
    for (let v = Math.ceil(x0 / pitch) * pitch; v < x1; v += pitch) {
      if (X(v) - X(x0) > clear && X(x1) - X(v) > clear) inner.push(v);
    }
    const XT: [number, boolean][] = [[x0, true], ...inner.map((v): [number, boolean] => [v, false]), [x1, true]];
    XT.forEach(([v, end], i) => {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = end ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      // the end labels would hang off the plot if they were centred on the tick
      ctx.textAlign = i === 0 ? 'left' : i === XT.length - 1 ? 'right' : 'center';
      ctx.fillText(v.toFixed(end ? 3 : dp), x, h - 6);
    });
    ctx.textAlign = 'left';

    // A converged loop stacks every sample on the same spot, so say how many
    // are under there - otherwise 50 coincident points read as one stray dot.
    const total = live.reduce((a, t) => a + t.samples.length, 0);
    const many = live.length > 1;
    // Top left, not bottom left. On a fixed scale the floor of the plot is
    // where a light pass and its target both sit, and the caption was landing
    // on them; the high-reduction, high-load corner is empty in any schedule
    // this mill can actually run.
    ctx.fillStyle = 'rgba(190,206,230,0.4)';
    const caption = many ? `${live.length} 本 / 計 ${total} 点 ／ 横軸 h₁ mm`
                         : `${total} 点 ／ 横軸 h₁ mm`;
    ctx.fillText(caption, padL + 5, padT + 11);
    // The target labels take the line under the caption. With the axis
    // fitted to the schedule the whole line of stands can sit under the
    // caption's width, so sharing its baseline and dodging sideways was not
    // enough - every label still landed on it.
    const labelY = padT + 23;

    // The quantity each loop is holding, drawn as the line it is aiming at.
    //
    // A whole line usually runs to one force, and then there is one target, not
    // five stacked on the same pixel with five labels fighting over it - so an
    // agreed load is drawn once, full width. Only when the stands are actually
    // asked for different forces is the rule split into a segment per stand,
    // clipped to the span that stand occupies so it is clear whose it is.
    const forced = live.filter((t) => t.target!.mode === 'force');
    const oneLoad = forced.length > 0
      && forced.every((t) => Math.abs(t.target!.load - forced[0].target!.load) < 0.05);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.2;
    if (oneLoad) {
      const y = Math.round(YP(forced[0].target!.load)) + 0.5;
      ctx.strokeStyle = 'rgba(255,178,110,0.75)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      // Clear of the line by more than a marker's ring: a settled loop parks
      // its load markers *on* the target, and the right-hand end of the rule
      // is exactly where the newest one sits.
      ctx.fillStyle = 'rgba(255,178,110,0.9)';
      ctx.textAlign = 'right';
      ctx.fillText('目標 P*', w - padR - 3, Math.max(padT + 9, y - 12));
      ctx.textAlign = 'left';
    }
    // Gauge-target labels are placed left to right so each can see where the
    // previous one ended: to the left of its own line by preference (the
    // trail converges on the line from the right), to the right if the left
    // is taken or off the plot, and on the next row if both are - two stands
    // rolling within a label's width of each other is an ordinary schedule.
    const rowRight = [-Infinity, -Infinity];
    const gaugeTargets = live
      .filter((tr) => tr.target!.mode === 'gauge')
      .map((tr) => ({ tr, x: Math.round(X(tr.target!.h1)) + 0.5 }))
      .sort((a, b) => a.x - b.x);
    for (const { tr, x } of gaugeTargets) {
      ctx.strokeStyle = 'rgba(127,228,255,0.75)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.fillStyle = 'rgba(127,228,255,0.85)';
      const label = many ? `${tr.tag} h₁*` : '目標 h₁';
      const lw = ctx.measureText(label).width;
      let placed = false;
      for (let row = 0; row < rowRight.length && !placed; row++) {
        const y = labelY + row * 12;
        const leftOk = x - 4 - lw >= Math.max(padL, rowRight[row] + 6);
        const rightOk = x + 4 >= rowRight[row] + 6 && x + 4 + lw <= w - padR;
        if (leftOk) {
          ctx.textAlign = 'right'; ctx.fillText(label, x - 4, y);
          rowRight[row] = x - 4; placed = true;
        } else if (rightOk) {
          ctx.textAlign = 'left'; ctx.fillText(label, x + 4, y);
          rowRight[row] = x + 4 + lw; placed = true;
        }
      }
      if (!placed) {   // out of rows: right of the line on the last row, overlap and all
        ctx.textAlign = 'left'; ctx.fillText(label, x + 4, labelY + (rowRight.length - 1) * 12);
      }
      ctx.textAlign = 'left';
    }
    for (const tr of live) {
      const t = tr.target!;
      if (t.mode === 'gauge') {
        // drawn above
      } else if (!oneLoad) {
        let lo = Infinity, hi = -Infinity;
        for (const s of tr.samples) { lo = Math.min(lo, s.h1); hi = Math.max(hi, s.h1); }
        const xa = Math.max(padL, X(lo) - 10);
        const xb = Math.min(w - padR, X(hi) + 10);
        const y = Math.round(YP(t.load)) + 0.5;
        ctx.strokeStyle = 'rgba(255,178,110,0.75)';
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        // at the entry end of its own segment: the head of the trail, and every
        // marker with it, is at the other end
        ctx.fillStyle = 'rgba(255,178,110,0.9)';
        ctx.textAlign = 'right';
        ctx.fillText(`${tr.tag} P*`, xa - 3, y - 4);
        ctx.textAlign = 'left';
      }
    }
    ctx.setLineDash([]);

    // Trails, oldest first so the newest point lands on top.
    //
    // The two series get different marker shapes rather than relying on colour
    // alone: once the loop settles both collapse to the middle of their own
    // axis, which is the same pixel, and two circles there are one circle.
    for (const tr of live) {
      const samples = tr.samples;
      const n = samples.length;
      // Quadratic in age, floored near invisible: the oldest points are
      // context, not data, and at a linear 0.3 floor fifty of them read as a
      // cloud the newest could not be picked out of. Squared, the back half
      // of a trail sits under 0.3 and the last few samples own the eye.
      const age = (k: number) => (n < 2 ? 1 : 0.05 + 0.95 * (k / (n - 1)) ** 2);
      for (const [pick, Y, col, square] of [
        [(s: AgcSample) => s.reduction, YR, '127,228,255', false],
        [(s: AgcSample) => s.load, YP, '255,178,110', true],
      ] as [(s: AgcSample) => number, (v: number) => number, string, boolean][]) {
        // The joining line fades with the points it joins: one path at one
        // alpha put a bright thread through the faded tail and undid the fade.
        ctx.lineWidth = 1.2;
        for (let k = 1; k < n; k++) {
          ctx.strokeStyle = `rgba(${col},${0.45 * age(k)})`;
          ctx.beginPath();
          ctx.moveTo(X(samples[k - 1].h1), Y(pick(samples[k - 1])));
          ctx.lineTo(X(samples[k].h1), Y(pick(samples[k])));
          ctx.stroke();
        }
        samples.forEach((s, k) => {
          const last = k === n - 1;
          const x = X(s.h1), y = Y(pick(s));
          const r = last ? 3.4 : 2.1;
          ctx.fillStyle = `rgba(${col},${age(k)})`;
          if (square) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
          else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
          if (last) {
            ctx.strokeStyle = `rgba(${col},0.9)`;
            ctx.lineWidth = 1.4;
            if (square) ctx.strokeRect(x - 6, y - 6, 12, 12);
            else { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke(); }
          }
        });
      }
      // Name the stand at the head of its trail. Set beside the newest marker
      // rather than above it: a trail that settles near the top of the box has
      // no room above, and clamping the caption down puts it on the ring it is
      // supposed to be naming. With one stand there is nothing to tell apart
      // and the tag is pure noise.
      // The identified plastic-curve slope goes with it, on the line
      // below: the number is a property of the trail's own operating
      // point, so it belongs next to the trail, not in a legend. Collected
      // here and drawn after every trail, so that stands rolling close
      // together can dodge each other.
      {
        const s = samples[n - 1];
        const x = X(s.h1);
        const y = YR(s.reduction) + 4;
        const toRight = x < w - padR - 30;
        const tx = x + (toRight ? 10 : -10);
        if (many) {
          ctx.fillStyle = 'rgba(220,230,245,0.92)';
          ctx.textAlign = toRight ? 'left' : 'right';
          ctx.fillText(tr.tag, tx, y);
          ctx.textAlign = 'left';
        }
        if (tr.slope !== null) {
          slopeLabels.push({ x: tx, y: y + (many ? 12 : 0), toRight, text: `${tr.slope.toFixed(2)} tonf/µm` });
        }
      }
    }

    // The slope labels, after every trail is drawn, left to right, each dropping a row when the one
    // before ends where it would start - three stands within a label's
    // width of each other is an ordinary schedule.
    slopeLabels.sort((a, b) => a.x - b.x);
    const slopeRowRight = [-Infinity, -Infinity, -Infinity];
    ctx.fillStyle = 'rgba(255,178,110,0.9)';
    for (const l of slopeLabels) {
      const lw = ctx.measureText(l.text).width;
      // The stand's tag is short and sits on the side the marker left room
      // for; this label is wider, so it takes the other side when it would
      // otherwise run off the plot.
      const toRight = l.toRight && l.x + lw <= w - padR;
      const x = toRight ? l.x : (l.toRight ? l.x - 20 : l.x);
      const left = toRight ? x : x - lw;
      let row = 0;
      while (row < slopeRowRight.length - 1 && left < slopeRowRight[row] + 6) row++;
      ctx.textAlign = toRight ? 'left' : 'right';
      ctx.fillText(l.text, x, l.y + row * 12);
      slopeRowRight[row] = left + lw;
    }
    ctx.textAlign = 'left';

    // Said last, because it is only known once everything has been placed. On
    // a fixed scale a marker sitting on the frame is ambiguous - it could be a
    // value that happens to be there - so it is worth stating plainly that
    // something is outside the box rather than at its edge.
    if (off) {
      ctx.font = FONT;
      ctx.fillStyle = 'rgba(255,178,110,0.9)';
      ctx.textAlign = 'right';
      ctx.fillText('⚠ 目盛外あり', w - padR - 3, padT + 11);
      ctx.textAlign = 'left';
    }
  }
}

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
  /** plane strain flow stress [MPa], drawn as a reference line */
  flowStress: number;
  /** slab-method mean pressure [MPa] */
  slabMean: number;
  /** entry and exit edges of the contact arc [mm] */
  arcIn: number;
  arcOut: number;
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
  private static readonly X0 = 0.15;
  private static readonly X1 = 2.0;
  private static readonly R0 = 10;
  private static readonly R1 = 55;
  private static readonly P0 = 600;
  private static readonly P1 = 2400;

  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; }

  draw(trails: AgcTrail[]): void {
    const ctx = fit(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const padL = 40, padR = 44, padT = 12, padB = 19;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const live = trails.filter((t) => t.target && t.samples.length > 0);
    if (live.length === 0) {
      const anyControlled = trails.some((t) => t.target);
      ctx.fillStyle = 'rgba(190,206,230,0.4)';
      ctx.textAlign = 'center';
      ctx.fillText(anyControlled ? 'データ待ち' : '制御 OFF のとき散布図は出ない', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }

    const { X0: x0, X1: x1, R0: r0, R1: r1, P0: p0, P1: p1 } = AgcScatterChart;

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
    // Round gauges rather than even fractions of the span: the scale is fixed,
    // so the ticks can be the numbers a schedule is actually written in.
    const XT = [0.15, 0.5, 1.0, 1.5, 2.0];
    XT.forEach((v, i) => {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      // the end labels would hang off the plot if they were centred on the tick
      ctx.textAlign = i === 0 ? 'left' : i === XT.length - 1 ? 'right' : 'center';
      ctx.fillText(v.toFixed(2), x, h - 6);
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
    ctx.fillText(many ? `${live.length} 本 / 計 ${total} 点 ／ 横軸 h₁ mm`
                      : `${total} 点 ／ 横軸 h₁ mm`, padL + 5, padT + 11);

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
    for (const tr of live) {
      const t = tr.target!;
      if (t.mode === 'gauge') {
        const x = Math.round(X(t.h1)) + 0.5;
        ctx.strokeStyle = 'rgba(127,228,255,0.75)';
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
        ctx.fillStyle = 'rgba(127,228,255,0.85)';
        // to the left of its own line, where the trail converging on it is not
        ctx.textAlign = 'right';
        ctx.fillText(many ? `${tr.tag} h₁*` : '目標 h₁', x - 4, padT + 10);
        ctx.textAlign = 'left';
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
      const age = (k: number) => (n < 2 ? 1 : 0.3 + 0.7 * (k / (n - 1)));
      for (const [pick, Y, col, square] of [
        [(s: AgcSample) => s.reduction, YR, '127,228,255', false],
        [(s: AgcSample) => s.load, YP, '255,178,110', true],
      ] as [(s: AgcSample) => number, (v: number) => number, string, boolean][]) {
        ctx.strokeStyle = `rgba(${col},0.42)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        samples.forEach((s, k) => {
          const x = X(s.h1), y = Y(pick(s));
          if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
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
      if (many) {
        const s = samples[n - 1];
        const x = X(s.h1);
        const toRight = x < w - padR - 30;
        ctx.fillStyle = 'rgba(220,230,245,0.92)';
        ctx.textAlign = toRight ? 'left' : 'right';
        ctx.fillText(tr.tag, x + (toRight ? 10 : -10), YR(s.reduction) + 4);
        ctx.textAlign = 'left';
      }
    }

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

/**
 * The mill line, drawn end to end.
 *
 * This is the one view that shows the whole machine at once: the strip enters
 * at the left, thins through each stand, and leaves at the right, drawn to
 * scale so a pass schedule reads as a shape rather than a table of numbers.
 * Under each stand sits its load against its target, because on a tandem line
 * that is the number being scheduled.
 *
 * It doubles as the stand selector - clicking a stand is how you choose which
 * one the detailed view below is showing. A separate row of buttons for that
 * would be one more thing to look at that says nothing.
 */

const FONT = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const FONT_B = '600 12px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
/** the schedule rows: five lines under every stand, so they get their own size */
const FONT_S = '10px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

export interface StandView {
  /** entry and exit gauge [mm] */
  hIn: number;
  hOut: number;
  /**
   * The exit gauge the stand is asked for [mm]: the absolute target under
   * gauge control, the reduction converted to a gauge under ratio control or
   * with the loop off, NaN under load control where there is no gauge target.
   */
  hOutTarget: number;
  /** reduction actually taken here, 0..1 */
  reduction: number;
  /** reduction commanded here, 0..1 */
  reductionTarget: number;
  /** roll separating force over the strip width [tonf] */
  load: number;
  /** target load [tonf]; 0 when this stand is not under load control */
  target: number;
  /** entry (back) and exit (front) tension as typed in the table [MPa] */
  backTension: number;
  frontTension: number;
  /**
   * The same two as the line actually carries them [MPa], from the tension
   * model; NaN with the model off, where the inputs are the whole story.
   */
  backTensionActual: number;
  frontTensionActual: number;
  /** a gap this stand touches is still away from its target or its reaction */
  tensionHot: boolean;
  /** work roll radius [mm], for drawing the barrels to relative size */
  R: number;
  /** 'off' | 'lock' | 'work' | 'sat' | 'stall' | 'idle' | 'recalc' (just restarted after a NaN solve) | 'diverged' (given up) */
  state: 'off' | 'lock' | 'work' | 'sat' | 'stall' | 'idle' | 'recalc' | 'diverged';
  /** restarts after a NaN solve so far, for the recalc label */
  restarts: number;
  /** which quantity this stand's loop is holding; decides what is emphasised */
  mode: 'off' | 'gauge' | 'force';
  /**
   * Signed relative deviation of whatever the loop is holding, and the
   * deadband it is trying to get inside. Both zero when no loop is running.
   *
   * One number covers every mode because it is always the same question - how
   * far is this stand from what it was asked for - and it is scaled, so a
   * gauge loop and a load loop are directly comparable across the line.
   */
  agcError: number;
  deadband: number;
  /**
   * Plane-strain deformation resistance through the pass [MPa]: as the strip
   * arrives, averaged over the bite, and as it leaves.
   *
   * All three, because each answers a different question. Entry is what the
   * material is before this stand works it; the bite mean is what sets the
   * load; exit is what it leaves work-hardened to, and so what the next stand
   * receives. Entry against exit is the hardening this pass did.
   */
  kfEntry: number;
  kfMean: number;
  kfExit: number;
  /**
   * Hitchcock deformed roll radius [mm] - the radius the loaded barrel is
   * actually rolling with, against the ground radius it was cut to.
   *
   * This is the number a pass schedule is worked out with: every rolling load
   * formula wants R', not R, and on thin gauge R' runs half again the ground
   * radius or more. The ratio comes with it because R' alone says nothing
   * without the radius it grew from.
   */
  hitchR: number;
  hitchRatio: number;
  /**
   * Forward slip [%] - how much faster the strip leaves than the barrel turns.
   *
   * The one number that says where the neutral point is without drawing it,
   * and the quantity a tandem line's speed cone is set from.
   */
  forwardSlip: number;
  /**
   * Under the slab load `forwardSlip` is the theory's own (from its neutral
   * point, by volume constancy) and this is the FEM's measured value beside
   * it; NaN under the FEM load, where the two are one number. Kept in view
   * because they are different models and disagree - a theory with its
   * neutral point inside the arc next to a FEM that is skidding.
   */
  forwardSlipFem: number;
  /**
   * Screw revisions it took the gap loop to settle - frozen once it has, live
   * while it is still working. 0 with the loop off or the stand parked.
   */
  agcIters: number;
  /** roll torque and power at the real strip width, both rolls [kN·m], [kW] */
  torque: number;
  power: number;
  /** contact arc length [mm] */
  arc: number;
  /**
   * The two floors under the exit gauge [mm]: the thinnest the bite condition
   * will catch (mu >= tan alpha), and Stone's minimum rollable thickness.
   *
   * Shown beside h1 itself, because neither means anything alone - what a
   * schedule is read for is how much room is left above them.
   */
  biteLimit: number;
  stoneLimit: number;
  /** screw position as the stand would read it [mm]; negative with the housing stretch in */
  screw: number;
  /** strip temperature entering and leaving this stand [degC] */
  tempIn: number;
  tempOut: number;
  /** the deformation-heating model is on, so the temperature row is worth showing */
  heatOn: boolean;
  /** what this element is called - '#2' on a tandem line, 'P2' on a reverse mill */
  tag: string;
}

const STATE_COLOR: Record<StandView['state'], string> = {
  off: '150,168,192',
  lock: '110,231,165',
  work: '255,196,107',
  sat: '255,110,140',
  stall: '255,110,140',
  idle: '150,168,192',
  recalc: '255,196,107',
  diverged: '255,110,140',
};
// The same words the AGC panel uses for the same conditions - `stall` here and
// `agcStalled` there are one flag, and two names for it read as two states.
const STATE_LABEL: Record<StandView['state'], string> = {
  off: '—', lock: '収束', work: '調整中', sat: 'ギャップ端に張り付き',
  stall: '内側ループ待ち', idle: '保留（目標 ≥ 入側）',
  recalc: '再計算中（解が NaN）', diverged: '発散（再計算停止）',
};

export class MillLineView {
  private canvas: HTMLCanvasElement;
  private hit: { x0: number; x1: number }[] = [];
  private selected = 0;
  private onSelect: (i: number) => void;

  constructor(canvas: HTMLCanvasElement, onSelect: (i: number) => void) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      for (let i = 0; i < this.hit.length; i++) {
        if (x >= this.hit[i].x0 && x <= this.hit[i].x1) { this.onSelect(i); return; }
      }
    });
    canvas.style.cursor = 'pointer';
  }

  setSelected(i: number): void { this.selected = i; }

  draw(stands: StandView[]): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = c.clientWidth, H = c.clientHeight;
    ctx.clearRect(0, 0, W, H);
    this.hit = [];
    if (stands.length === 0) return;

    // Vertical budget, top to bottom: stand number, barrel, strip, barrel,
    // then the schedule block - reduction, load, tension - each as a target
    // against what the stand is actually doing. The strip gets a deliberately
    // small share: it is the thing being measured, but the barrels have to fit
    // around it and the numbers underneath are what a schedule is read from.
    // wide enough margins that the entry and exit gauge captions fit
    const padL = 96, padR = 96, padT = 15;
    // The schedule block grows a row when the heating model is on: with it off
    // every stand is at the entry temperature and a row of identical numbers
    // is worth less than the strip height it would cost.
    const anyHeat = stands.some((s) => s.heatOn);
    // How much of the block there is room for. The panel this sits in is
    // draggable, so the block is written to fit rather than to a fixed budget:
    // rows are dropped from the bottom, in reverse order of what a schedule is
    // read for, and the strip keeps a band worth looking at either way.
    const ROW = 13;
    const wanted = anyHeat ? 14 : 13;
    const BLOCK_EXTRA = 27;
    const rowsFit = Math.max(0, Math.min(wanted,
      Math.floor((H - padT - 34 - BLOCK_EXTRA) / ROW)));
    const padB = rowsFit * ROW + BLOCK_EXTRA;
    const n = stands.length;
    const slot = (W - padL - padR) / n;
    const bandH = Math.max(20, H - padT - padB);
    const yMid = padT + bandH / 2;
    const hMax = Math.max(stands[0].hIn, 1e-9);
    // to scale, but the thickest strip only claims part of the band so the
    // barrels have somewhere to sit; never so thin it stops being visible
    const halfMax = bandH * 0.22;
    const halfOf = (mm: number) => Math.max((mm / hMax) * halfMax, 0.7);
    // Sized from the room actually left between the thickest strip and the top
    // of the schedule block, not a fixed cap: the block grew a row when the
    // heating model arrived, and a constant here would have put the bottom
    // barrel through the first line of numbers.
    const rollRoom = (H - padB - 6 - (yMid + halfMax)) / 2;
    const rollR = Math.max(6, Math.min(bandH * 0.20, slot * 0.24, rollRoom, 19));

    // ── strip band, entry to exit ─────────────────────────────────────────
    const xEntry = padL - 26;
    const xExit = padL + n * slot + 26;
    const stationX = (i: number) => padL + (i + 0.5) * slot;
    const pts: [number, number][] = [[xEntry, halfOf(stands[0].hIn)]];
    for (let i = 0; i < n; i++) {
      const x = stationX(i);
      pts.push([x - slot * 0.16, halfOf(stands[i].hIn)]);
      pts.push([x + slot * 0.16, halfOf(stands[i].hOut)]);
    }
    pts.push([xExit, halfOf(stands[n - 1].hOut)]);

    // The gauge the commands ask for, drawn as an outline behind the strip.
    // The strip itself is the achieved thickness, so wherever the two separate
    // the mill spring is visible as a shape - which is the whole reason gauge
    // control exists. Skipped when they agree to less than the line width.
    // A stand with no gauge target (load control) draws its outline on the
    // achieved gauge, so the dashed line simply coincides with the strip there.
    const tgt = (s: StandView) => (Number.isFinite(s.hOutTarget) ? s.hOutTarget : s.hOut);
    const cmd: [number, number][] = [[xEntry, halfOf(stands[0].hIn)]];
    for (let i = 0; i < n; i++) {
      const x = stationX(i);
      cmd.push([x - slot * 0.16, halfOf(stands[i].hIn)]);
      cmd.push([x + slot * 0.16, halfOf(tgt(stands[i]))]);
    }
    cmd.push([xExit, halfOf(tgt(stands[n - 1]))]);
    const gaugeGap = cmd.some((c, i) => Math.abs(c[1] - pts[i][1]) > 0.75);
    if (gaugeGap) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(160,190,230,0.42)';
      ctx.lineWidth = 1;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        cmd.forEach(([cx, hh], i) => {
          const y = yMid + sgn * hh;
          if (i) ctx.lineTo(cx, y); else ctx.moveTo(cx, y);
        });
        ctx.stroke();
      }
      ctx.restore();
    }

    const grad = ctx.createLinearGradient(xEntry, 0, xExit, 0);
    grad.addColorStop(0, 'rgba(96,150,255,0.42)');
    grad.addColorStop(1, 'rgba(255,196,107,0.50)');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], yMid - pts[0][1]);
    for (const [x, hh] of pts) ctx.lineTo(x, yMid - hh);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], yMid + pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,225,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(xEntry, yMid); ctx.lineTo(xExit, yMid); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = FONT;
    if (gaugeGap) {
      // Along the top, clear of the strip: the dashed outline needs saying
      // once, and there is no room for it beside the exit caption.
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(160,190,230,0.6)';
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(160,190,230,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4, padT - 7.5); ctx.lineTo(20, padT - 7.5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('目標板厚', 24, padT - 4);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(190,206,230,0.75)';
    ctx.fillText(`${stands[0].hIn.toFixed(3)} mm`, xEntry - 6, yMid - 2);
    ctx.fillStyle = 'rgba(190,206,230,0.45)';
    ctx.fillText('入側', xEntry - 6, yMid + 12);

    // ── each stand ───────────────────────────────────────────────────────
    const rMax = Math.max(...stands.map((s) => s.R), 1e-9);
    for (let i = 0; i < n; i++) {
      const s = stands[i];
      const x = stationX(i);
      const sel = i === this.selected;
      this.hit.push({ x0: padL + i * slot, x1: padL + (i + 1) * slot });

      if (sel && n > 1) {
        ctx.fillStyle = 'rgba(120,190,255,0.10)';
        ctx.fillRect(padL + i * slot, 2, slot, H - 4);
        ctx.strokeStyle = 'rgba(120,190,255,0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(padL + i * slot) + 0.5, 2.5, Math.round(slot) - 1, H - 5);
      }

      // barrels. Sized by relative roll radius, but within a band that keeps
      // them inside the strip's own budget - a 400 mm roll drawn to scale next
      // to a 2 mm strip would be the only thing on screen.
      const gap = halfOf(s.hOut);
      const rr = rollR * (0.72 + 0.28 * (s.R / rMax));
      const col = STATE_COLOR[s.state];
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x, yMid + sgn * (gap + rr), rr, 0, Math.PI * 2);
        ctx.fillStyle = sel ? 'rgba(150,175,205,0.95)' : 'rgba(120,140,168,0.75)';
        ctx.fill();
        ctx.strokeStyle = `rgba(${col},${sel ? 0.95 : 0.6})`;
        ctx.lineWidth = sel ? 2 : 1.4;
        ctx.stroke();
      }

      // Exit gauge on the strip: what it is, and above that what it is asked
      // to be. Two lines, because one number here used to be read as the
      // target - it was the measurement - and the whole point of a gauge loop
      // is the gap between the two. The column at x + 0.3 slot is clear of
      // the barrel and the stand tag, so the only thing that can crowd the
      // upper line out is the canvas edge itself - not the band height, which
      // is what the schedule block leaves over and is usually small.
      ctx.textAlign = 'center';
      ctx.font = FONT;
      const lx = x + slot * 0.30;
      const ly = yMid - halfOf(s.hOut) - 5;
      ctx.fillStyle = 'rgba(226,238,255,0.9)';
      ctx.fillText(`${s.hOut.toFixed(4)} 実`, lx, ly);
      if (ly - 12 - 10 >= 0) {
        ctx.fillStyle = 'rgba(160,190,230,0.7)';
        ctx.fillText(Number.isFinite(s.hOutTarget)
          ? `${s.hOutTarget.toFixed(4)} 目標` : '目標なし', lx, ly - 12);
      }

      // stand label
      ctx.font = FONT_B;
      ctx.fillStyle = sel ? '#9fd4ff' : 'rgba(190,206,230,0.75)';
      ctx.fillText(s.tag, x, padT - 3);

      // ── the schedule block ─────────────────────────────────────────────
      //
      // One row per quantity, each as `commanded → measured`, because that
      // pair is the whole content of a pass schedule: what the stand was told
      // and what it actually did. The row belonging to the quantity the loop
      // is holding is the one that should read as settled, so it is drawn in
      // the loop's own state colour while the rest stay neutral - on a stand
      // under load control the reduction *should* miss its command, and
      // colouring it like an error says the opposite.
      const barW = Math.min(slot * 0.92, 196);
      const bx = x - barW / 2;
      let ry = H - padB + 11;
      let left = rowsFit;

      /**
       * One `label   commanded -> measured   unit` line.
       *
       * The label is left, the unit is right, and the numbers sit against the
       * unit - so down the block the values line up in a column and the units
       * in another, which is what makes five rows readable at 10px. The label
       * is clipped rather than allowed to run into the numbers: a truncated
       * word is recoverable, two overlapping strings are not.
       */
      const row = (
        label: string, target: string | null, actual: string, unit: string, hot: boolean,
        colour?: string,
      ) => {
        if (left-- <= 0) return;
        ctx.font = FONT_S;
        ctx.textAlign = 'right';
        const uw = unit ? ctx.measureText(unit).width + 4 : 0;
        ctx.fillStyle = 'rgba(150,168,192,0.45)';
        if (unit) ctx.fillText(unit, bx + barW, ry);
        const xr = bx + barW - uw;
        // `hot` paints in the loop's state colour (this row is what the loop
        // holds); `colour` is for a verdict of the row's own, independent of
        // the loop - a limit crossed is red whether or not the loop is happy.
        ctx.fillStyle = colour ?? (hot ? `rgba(${col},0.95)` : 'rgba(226,238,255,0.88)');
        ctx.fillText(actual, xr, ry);
        let lim = xr - ctx.measureText(actual).width - 5;
        if (target !== null) {
          ctx.fillStyle = 'rgba(150,168,192,0.5)';
          ctx.fillText(`${target} →`, lim, ry);
          lim -= ctx.measureText(`${target} →`).width + 5;
        }
        ctx.textAlign = 'left';
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx, ry - ROW, Math.max(0, lim - bx - 3), ROW + 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(150,168,192,0.62)';
        ctx.fillText(label, bx, ry);
        ctx.restore();
        ctx.textAlign = 'center';
        ry += ROW;
      };

      row('圧下', `${(s.reductionTarget * 100).toFixed(1)}`,
        `${(s.reduction * 100).toFixed(1)}`, '%', s.mode === 'gauge');
      row('荷重', s.target > 0 ? s.target.toFixed(0) : null,
        s.load.toFixed(0), 'tonf', s.mode === 'force');
      // Both ends of the pull, in the order the strip meets them. On a tandem
      // line the front tension of one stand is the back tension of the next,
      // so read across the line the row is continuous by construction.
      // With a tension model on, the table's numbers are targets and the line
      // carries its own: the target goes in the command slot, the carried pair
      // is the value, painted hot while a gap is still away from its target.
      const tOn = Number.isFinite(s.frontTensionActual) || Number.isFinite(s.backTensionActual);
      const tPair = (b: number, f: number) =>
        `${Number.isFinite(b) ? b.toFixed(1) : '—'} / ${Number.isFinite(f) ? f.toFixed(1) : '—'}`;
      row('張力 σb/σf', tOn ? tPair(s.backTension, s.frontTension) : null,
        tOn ? tPair(s.backTensionActual, s.frontTensionActual)
          : `${s.backTension.toFixed(0)} / ${s.frontTension.toFixed(0)}`,
        'MPa', tOn && s.tensionHot);
      // Deformation resistance: the bite mean is what sets the load, the exit
      // value is what the strip leaves work-hardened to. Both, because the gap
      // between them is the hardening the pass did.
      row('kf 入/均/出', null,
        `${s.kfEntry.toFixed(0)} / ${s.kfMean.toFixed(0)} / ${s.kfExit.toFixed(0)}`,
        'MPa', false);
      if (anyHeat) {
        row('温度', null,
          s.heatOn
            ? `${s.tempIn.toFixed(0)} → ${s.tempOut.toFixed(0)}`
            : s.tempIn.toFixed(0),
          '°C', s.heatOn && s.tempOut - s.tempIn > 1);
      }
      // What the barrel is actually rolling with. Sits next to kf because the
      // two together are the whole answer to "why is the strip thicker than
      // the gap": the metal resisted this hard, and the arc flattened that far.
      row("扁平ロール径 R'", null,
        `${s.hitchR.toFixed(1)} (×${s.hitchRatio.toFixed(2)})`, 'mm', false);
      // The exit gauge against the two floors under it. A limit that does not
      // constrain anything here comes out negative, and printing a negative
      // thickness invites reading it as one - so it is dashed instead.
      const lim = (v: number) => (v > 0 ? v.toFixed(3) : '—');
      row('h₁ 実/噛込', null, `${s.hOut.toFixed(3)} / ${lim(s.biteLimit)}`, 'mm', false);
      // The screw a stand would read, and the floor under the gauge. Both
      // used to be elsewhere - the screw in the stand table only, Stone's
      // limit packed into the h1 row as a third number - and both are what a
      // thin pass is actually about: how far the screws had to go, and
      // whether the gauge they made is one this roll can make at all.
      row('スクリュー S', null, s.screw.toFixed(4), 'mm', false,
        s.screw < 0 ? 'rgba(255,196,107,0.95)' : undefined);
      const stoneRatio = s.stoneLimit > 0 ? s.hOut / s.stoneLimit : Infinity;
      row('Stone 最小板厚', null, lim(s.stoneLimit), 'mm', false,
        stoneRatio < 1 ? 'rgba(255,110,140,0.95)'
          : stoneRatio < 2 ? 'rgba(255,196,107,0.95)' : undefined);
      row('接触弧長 L', null, s.arc.toFixed(2), 'mm', false);
      // What the stand costs to run, at the real strip width and for both
      // barrels - the numbers that size a drive rather than describe a bite.
      row('トルク (両ロール)', null, s.torque.toFixed(1), 'kN·m', false);
      row('動力 (両ロール)', null, s.power.toFixed(0), 'kW', false);
      // Under the slab load the theory's value is the result and the FEM's
      // sits in the commanded slot as 'FEM x.xx ->', so the two are read as
      // two answers and not one.
      row('先進率 f', Number.isFinite(s.forwardSlipFem) ? `FEM ${s.forwardSlipFem.toFixed(2)}` : null,
        Number.isFinite(s.forwardSlip) ? s.forwardSlip.toFixed(2) : '—', '%', false);
      // How many moves the loop needed - the one number that compares FEM
      // and スラブ法 as the thing the loop measures. Painted in the loop's
      // colour while it is still counting, so a stand that is stuck reads as
      // a number that keeps growing in amber rather than a finished result.
      const counting = s.state === 'work' || s.state === 'stall' || s.state === 'sat';
      row('収束 反復', null, s.state === 'off' || s.state === 'idle' ? '—' : String(s.agcIters),
        '回', counting);

      /*
       * How close this stand is to what it was asked for.
       *
       * The bar used to be load against target, which said nothing on the
       * three modes that are not holding a load and duplicated the 荷重 row on
       * the one that is. Convergence is the thing that is genuinely worth a
       * shape rather than a number: it is what you watch while a line settles,
       * and across several stands the question is always "which one is still
       * moving", which is a comparison of lengths.
       *
       * Logarithmic, from 10 % of the setpoint (empty) to the deadband (full).
       * The deviation crosses three or four decades on its way in, and on a
       * linear scale the entire approach happens in the last pixel.
       */
      const by = ry - 6;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(bx, by, barW, 5);
      if (s.mode !== 'off' && s.deadband > 0) {
        const e = Math.abs(s.agcError);
        const span = Math.log10(0.1 / s.deadband);
        // Settled reads full even if the deviation sits a hair inside the
        // deadband rather than at it - the loop has stopped either way.
        const f = s.state === 'lock' || s.state === 'idle' ? 1
          : e <= 0 ? 1
            : Math.max(0, Math.min(1, Math.log10(0.1 / e) / Math.max(span, 1e-9)));
        ctx.fillStyle = `rgba(${col},0.85)`;
        ctx.fillRect(bx, by, barW * f, 5);
        ctx.font = FONT;
        ctx.fillStyle = `rgba(${col},0.95)`;
        // The deviation and the word for it, on one line: the number says how
        // far, the word says why it is not closing when it is not.
        const pct = s.agcError * 100;
        const txt = s.state === 'idle' ? STATE_LABEL[s.state]
          : s.state === 'recalc' ? `再計算中（解が NaN、${s.restarts} 回目）`
          : s.state === 'diverged' ? `発散（${s.restarts} 回再計算しても NaN — 自動再計算停止、条件を見直す）`
          : `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(3)} %  ${STATE_LABEL[s.state]}`;
        ctx.fillText(txt, x, by + 17);
      } else {
        // No loop: nothing is converging, and an empty frame says so more
        // honestly than a bar measuring something nobody asked to hold.
        ctx.font = FONT;
        ctx.fillStyle = 'rgba(150,168,192,0.55)';
        ctx.fillText('制御なし', x, by + 17);
      }
    }

    ctx.textAlign = 'left';
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(190,206,230,0.75)';
    ctx.fillText(`${stands[n - 1].hOut.toFixed(3)} mm`, xExit + 6, yMid - 2);
    ctx.fillStyle = 'rgba(190,206,230,0.45)';
    ctx.fillText('出側', xExit + 6, yMid + 12);
  }
}

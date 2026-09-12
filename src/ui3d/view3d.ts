/**
 * The 3D tab: the roll-stack model of `sim3d`, its controls, and its
 * charts, living in `#view3d` beside the 2D tab's panels.
 *
 * Same conventions as the 2D tab: every input is a dial that takes effect at
 * once, the solve advances a little every frame so the picture is live, and
 * the charts are canvases that redraw while anything is moving and go quiet
 * once the solve has settled.
 */

import { StackSolver } from '../sim3d/solver';
import {
  defaultParams, MILL_LABEL, ASU_RACKS, type MillType, type Params3D,
} from '../sim3d/stack';
import { el, section, slider, select, buttonRow, StatGrid, numField, helpMark } from '../ui/controls';
import { LineChart, FrontView, EndView, ROLL_COLORS, STRIP_COLOR, type XYSeries } from './charts3d';

const TONF = 9.80665e3;
const MILLS: MillType[] = ['2hi', '4hi', '6hi', '12hi', '20hi'];
/** solve time allowed per frame [ms] */
const FRAME_BUDGET = 14;

export interface View3DHandle {
  setActive(on: boolean): void;
  relayout(): void;
  readonly active: boolean;
}

interface Dial {
  set(v: number): void;
}

export function installView3D(root: HTMLElement, opts: { initialMill?: MillType } = {}): View3DHandle {
  let params: Params3D = defaultParams(opts.initialMill ?? '4hi');
  const solver = new StackSolver(params);
  let active = false;
  let running = true;
  let magnify = 200;
  let dirty = true;

  /* ── DOM ── */
  const left = el('aside', 'panel v3-panel');
  left.id = 'v3-left';
  const centre = el('main', 'v3-centre');
  const right = el('aside', 'panel v3-panel');
  right.id = 'v3-right';
  root.append(left, centre, right);

  const cell = (id: string, title: string, sub: string) => {
    const c = el('div', 'chart-cell v3-cell');
    c.id = id;
    const head = el('div', 'chart-head');
    head.append(el('span', 'chart-title', title), el('span', 'chart-sub', sub));
    const canvas = el('canvas');
    c.append(head, canvas);
    return { root: c, canvas };
  };

  const front = cell('v3-front', 'ロールスタック 正面図', '上半分 ／ 撓みは倍率表示 ／ 胴の色 = その位置の接触線荷重 ／ ▲ = 支持点（赤 = 圧下スクリュー、黄 = サドル、緑 = ベンダー付きチョック）');
  const chartGrid = el('div', 'v3-charts');
  const cDefl = cell('v3-defl', 'ロール撓み', '各ロール軸の鉛直たわみ v(x)（支持点基準ではなく絶対値：スクリュー分の沈み込みを含む）');
  const cFlat = cell('v3-flat', '扁平量', '接触ごとの相互接近量（両ロールの弾性扁平の和）／ WR–板は WR 側の扁平');
  const cLoad = cell('v3-load', '接触線荷重', '接触ごとの単位幅荷重 q(x)');
  const cGauge = cell('v3-gauge', '板厚プロファイル', '出側 h₁（実線）と入側 h₀（破線）の平均からの偏差');
  const cEps = cell('v3-eps', '伸び率分布', '幅方向の伸び差 Δε（平均比）／ 実線 = 潜在形状（張力で押さえ込まれる分を含む）／ 塗り = 顕在化（波）');
  const cSig = cell('v3-sig', '前方張力分布', '各スライスの張力 σf(x) ／ 破線 = 設定平均 ／ 下限 = 座屈、上限 = 降伏で頭打ち');
  chartGrid.append(cDefl.root, cFlat.root, cLoad.root, cGauge.root, cEps.root, cSig.root);
  centre.append(front.root, chartGrid);

  const frontView = new FrontView(front.canvas);
  const charts = {
    defl: new LineChart(cDefl.canvas), flat: new LineChart(cFlat.canvas), load: new LineChart(cLoad.canvas),
    gauge: new LineChart(cGauge.canvas), eps: new LineChart(cEps.canvas), sig: new LineChart(cSig.canvas),
  };

  /* ── right panel: results ── */
  const statSec = section('計算結果', { open: true });
  const stats = new StatGrid();
  stats.add('force', '圧延荷重', 'tonf').add('screw', '圧下位置 S', 'mm').add('h1', '出側板厚 平均 / 中央', 'mm')
    .add('crown', 'クラウン C25', 'µm').add('wedge', 'ウェッジ', 'µm').add('edge', 'エッジドロップ L / R', 'µm')
    .add('latent', '潜在形状 (p-p)', 'I-unit').add('manifest', '顕在形状 (最大)', 'I-unit')
    .add('conv', '収束').add('iter', '反復 / 残差').add('ms', '解法時間', 'ms/frame').add('dof', '自由度 / 半バンド幅');
  statSec.body.append(stats.root);
  const contactSec = section('接触力・支持反力', { open: true });
  let contactGrid = new StatGrid();
  contactSec.body.append(contactGrid.root);
  const endSec = section('端面図（クラスタ配置）', { open: true });
  const endCanvas = el('canvas');
  endCanvas.id = 'v3-end';
  endSec.body.append(endCanvas);
  const endView = new EndView(endCanvas);
  right.append(statSec.root, endSec.root, contactSec.root);

  /* ── left panel: inputs ── */
  const dials = new Map<string, Dial>();
  let contactKeys: string[] = [];

  const apply = () => {
    solver.setParams(params);
    dirty = true;
    running = true;
  };
  /** a dial on a numeric field, in display units `scale` × SI */
  const num = (
    key: keyof Params3D, label: string, unit: string, min: number, max: number, step: number,
    scale: number, hint?: string, log = false,
  ) => {
    const h = slider({
      label, unit, min, max, step, log, value: (params[key] as number) / scale, hint,
      onInput: (v) => { (params as unknown as Record<string, number>)[key as string] = v * scale; apply(); },
    });
    dials.set(key as string, { set: (v) => h.set(v / scale) });
    h.root.dataset.key = key as string;
    return h.root;
  };

  const buildLeft = () => {
    left.replaceChildren();
    // mill type
    const millSec = section('ミル形式', { open: true, hint: '上半分のみをモデル化（パスラインについて対称）。形式を変えるとロール寸法と圧延条件はその形式の既定値に戻る。' });
    const millRow = buttonRow(MILLS.map((m) => ({
      text: MILL_LABEL[m],
      onClick: () => { params = defaultParams(m); solver.setParams(params); dirty = true; running = true; buildLeft(); },
    })));
    [...millRow.children].forEach((b, i) => b.classList.toggle('active', MILLS[i] === params.mill));
    millSec.body.append(millRow);
    millSec.body.append(el('div', 'ctrl-hint', millNote(params.mill)));
    left.append(millSec.root);

    // control
    const ctlSec = section('制御・目標', { open: true });
    ctlSec.body.append(select<'gauge' | 'force' | 'screw'>('制御モード', [
      { value: 'gauge', text: '出側板厚（圧下率）一定' }, { value: 'force', text: '圧延荷重一定' }, { value: 'screw', text: '圧下位置 手動' },
    ], params.mode, (v) => { params.mode = v; apply(); syncModeDials(); }, 'スクリュー位置は目標に合うようフレームごとに割線法で追い込む。').root);
    ctlSec.body.append(num('reduction', '圧下率', '%', 2, 60, 0.5, 0.01));
    ctlSec.body.append(num('targetForce', '目標荷重', 'tonf', 20, 4000, 10, TONF));
    ctlSec.body.append(num('screw', '圧下位置 S', 'mm', -2, 8, 0.005, 1e-3, '無負荷でロールが板に触れる位置を 0 とした締め込み量。負は開き（クラウンや AS-U でスタックが予圧されていると必要になる）。'));
    ctlSec.body.append(num('leveling', 'レベリング ΔS', 'µm', -300, 300, 5, 1e-6, '駆動側と作業側のスクリュー差。正で +x 側が締まる。'));
    ctlSec.body.append(num('housingK', 'ハウジング剛性（支持点あたり）', 'MN/mm', 1, 30, 0.5, 1e9, 'チョックまたはサドル 1 点あたりの剛性。ロールの曲げ・扁平はモデルが計算するので、ここはハウジングとチョックだけ。'));
    left.append(ctlSec.root);

    // actuators
    const actSec = section('アクチュエータ', { open: true });
    if (params.mill === '4hi' || params.mill === '6hi') {
      actSec.body.append(num('wrBender', 'WR ベンダー（チョックあたり）', 'tonf', -60, 200, 2, TONF, '正で上 WR のチョックを持ち上げる（インクリーズベンド）。等価的にロールクラウンを増やす。'));
    }
    if (params.mill === '6hi') {
      actSec.body.append(num('irBender', 'IR ベンダー（チョックあたり）', 'tonf', 0, 200, 2, TONF));
      actSec.body.append(num('irShift', 'IR シフト（胴端の板端からの位置）', 'mm', -150, 150, 5, 1e-3, '中間ロール胴端が板端より外側に出る量。負で板端より内側に引き込む（エッジ部の WR 支持を外す）。上下逆向きのシフトを半モデルでは両端対称に扱う。'));
    }
    if (params.mill === '20hi') {
      actSec.body.append(num('taperShift', '第1中間 テーパ位置（板端基準）', 'mm', -200, 200, 5, 1e-3, 'テーパ開始点の板端からの位置。負で板端より内側から細り始める。'));
      actSec.body.append(num('taperLen', 'テーパ長', 'mm', 50, 500, 10, 1e-3));
      actSec.body.append(num('taperDepth', 'テーパ深さ（半径）', 'µm', 0, 1000, 10, 1e-6));
    }
    if (params.mill === '12hi' || params.mill === '20hi') {
      const asuWrap = el('div', 'ctrl');
      const top = el('div', 'ctrl-top');
      const lab = el('label', 'ctrl-label', params.mill === '20hi' ? 'AS-U（B・C 軸 サドル押し込み）' : 'AS-U（B 軸 サドル押し込み）');
      lab.append(helpMark('バッキング軸を支えるサドルを個別に押し込む（正 = ワークロール側へ）。7 点のラックで胴長方向のクラウンを作る。'));
      top.append(lab);
      asuWrap.append(top);
      const row = el('div', 'v3-asu');
      params.asu.forEach((v, k) => {
        row.append(numField({
          value: v * 1e6, min: -500, max: 500, step: 10, digits: 0,
          onChange: (x) => { params.asu[k] = x * 1e-6; params.asu = [...params.asu]; apply(); },
        }).root);
      });
      asuWrap.append(row);
      const presets = buttonRow([
        { text: 'フラット', onClick: () => { params.asu = new Array(ASU_RACKS).fill(0); apply(); buildLeft(); } },
        { text: '山形 +200', onClick: () => { params.asu = asuShape(200e-6); apply(); buildLeft(); } },
        { text: '谷形 −200', onClick: () => { params.asu = asuShape(-200e-6); apply(); buildLeft(); } },
      ]);
      asuWrap.append(presets);
      actSec.body.append(asuWrap);
    }
    if (!actSec.body.children.length) actSec.body.append(el('div', 'ctrl-hint', '2Hi にはアクチュエータがない（圧下とレベリングのみ）。'));
    left.append(actSec.root);

    // profiles
    const profSec = section('ロールプロファイル', { open: true });
    profSec.body.append(num('wrCrown', 'WR 研削クラウン（直径）', 'µm', -400, 400, 5, 1e-6, '中央と胴端の直径差。正で中央が太い（放物線）。'));
    profSec.body.append(num('wrThermal', 'WR サーマルクラウン（直径）', 'µm', 0, 200, 5, 1e-6));
    if (params.mill === '6hi' || params.mill === '12hi' || params.mill === '20hi') {
      profSec.body.append(num('irCrown', params.mill === '20hi' ? '第1中間 クラウン（直径）' : 'IR クラウン（直径）', 'µm', -400, 400, 5, 1e-6));
    }
    if (params.mill === '4hi' || params.mill === '6hi') {
      profSec.body.append(num('burCrown', 'BUR クラウン（直径）', 'µm', -600, 1000, 10, 1e-6));
    }
    left.append(profSec.root);

    // strip
    const stripSec = section('板・圧延条件', { open: true });
    stripSec.body.append(num('width', '板幅', 'mm', 300, 1600, 10, 1e-3));
    stripSec.body.append(num('h0', '入側板厚 h₀', 'mm', 0.05, 6, 0.01, 1e-3, undefined, true));
    stripSec.body.append(num('entryCrown', '入側クラウン（板厚差）', 'µm', -100, 200, 2, 1e-6, '入側板厚の中央と板端の差。出側クラウン比が入側と一致すれば平坦。'));
    stripSec.body.append(num('backTension', '後方張力', 'MPa', 0, 300, 5, 1e6));
    stripSec.body.append(num('frontTension', '前方張力（平均）', 'MPa', 0, 300, 5, 1e6));
    stripSec.body.append(num('mu', '摩擦係数 μ', '', 0.01, 0.3, 0.005, 1));
    stripSec.body.append(num('lmnL', '変形抵抗 L（kf = L(ε+M)ⁿ）', 'MPa', 200, 3000, 10, 1e6));
    stripSec.body.append(num('lmnM', 'M', '', 0, 0.2, 0.005, 1));
    stripSec.body.append(num('lmnN', 'N', '', 0, 0.6, 0.005, 1));
    stripSec.body.append(num('entryStrain', '入側予ひずみ', '', 0, 2, 0.05, 1));
    stripSec.body.append(num('lateralLen', '横流れ 平滑長', 'mm', 0, 100, 1, 1e-3, '幅方向の伸び差を均す距離（板厚の数倍）。0 で平面ひずみ。'));
    stripSec.body.append(num('sigmaCr', '座屈限界（圧縮）', 'MPa', 0, 20, 0.5, 1e6, 'これ以上の圧縮を板は張力として支えられず、波（顕在形状）になる。'));
    left.append(stripSec.root);

    // roll geometry
    const geoSec = section('ロール寸法', { open: false });
    geoSec.body.append(num('wrD', 'WR 直径', 'mm', 30, 900, 5, 1e-3));
    geoSec.body.append(num('wrLb', 'WR 胴長', 'mm', 500, 2500, 10, 1e-3));
    geoSec.body.append(num('wrLs', 'WR 支持スパン', 'mm', 600, 3000, 10, 1e-3));
    geoSec.body.append(num('wrDn', 'WR ネック径', 'mm', 20, 700, 5, 1e-3));
    if (params.mill === '6hi' || params.mill === '12hi' || params.mill === '20hi') {
      geoSec.body.append(num('irD', params.mill === '20hi' ? '第1中間 直径' : 'IR 直径', 'mm', 50, 900, 5, 1e-3));
      geoSec.body.append(num('irLb', params.mill === '20hi' ? '第1中間 胴長' : 'IR 胴長', 'mm', 500, 2500, 10, 1e-3));
      geoSec.body.append(num('irLs', params.mill === '20hi' ? '第1中間 支持スパン' : 'IR 支持スパン', 'mm', 600, 3000, 10, 1e-3));
    }
    if (params.mill === '20hi') {
      geoSec.body.append(num('ir2D', '第2中間 直径', 'mm', 80, 400, 5, 1e-3));
      geoSec.body.append(num('ir2Lb', '第2中間 胴長', 'mm', 500, 2500, 10, 1e-3));
    }
    if (params.mill === '4hi' || params.mill === '6hi') {
      geoSec.body.append(num('burD', 'BUR 直径', 'mm', 400, 2000, 10, 1e-3));
      geoSec.body.append(num('burLb', 'BUR 胴長', 'mm', 500, 2500, 10, 1e-3));
      geoSec.body.append(num('burLs', 'BUR 支持スパン', 'mm', 600, 3200, 10, 1e-3));
      geoSec.body.append(num('burDn', 'BUR ネック径', 'mm', 200, 1400, 10, 1e-3));
    }
    if (params.mill === '12hi' || params.mill === '20hi') {
      geoSec.body.append(num('bbD', 'バッキングベアリング 外径', 'mm', 100, 600, 5, 1e-3));
      geoSec.body.append(num('bbShaft', 'バッキング軸 径', 'mm', 50, 400, 5, 1e-3));
      geoSec.body.append(num('bbLb', 'バッキング軸 支持長', 'mm', 500, 2500, 10, 1e-3));
      geoSec.body.append(num('angle1', '第1中間 配置角（鉛直から）', '°', 10, 45, 1, Math.PI / 180));
    }
    geoSec.body.append(num('Eroll', 'ロール ヤング率', 'GPa', 100, 300, 5, 1e9));
    left.append(geoSec.root);

    // numerics / display
    const numSec = section('解析・表示', { open: false });
    numSec.body.append(num('stations', '幅方向 分割点数', '', 21, 241, 2, 1, '全ロール共通の節点数。増やすと帯行列の解法時間が線形に伸びる。'));
    numSec.body.append(slider({ label: '撓み表示倍率', min: 10, max: 2000, step: 10, log: true, value: magnify, onInput: (v) => { magnify = v; dirty = true; } }).root);
    left.append(numSec.root);

    syncModeDials();
  };

  const syncModeDials = () => {
    const on = (key: string, yes: boolean) => {
      const rootEl = left.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
      if (rootEl) rootEl.classList.toggle('disabled', !yes);
    };
    on('reduction', params.mode === 'gauge');
    on('targetForce', params.mode === 'force');
    on('screw', params.mode === 'screw');
  };

  buildLeft();

  /* ── drawing ── */
  const drawAll = () => {
    const R = solver.result;
    const st = solver.stack;
    const halfWidth = -R.x[0];
    const strip = params.width / 2;
    frontView.draw(R, st, { magnify, width: params.width });
    endView.draw(R, st, params.width, TONF);

    const um = (a: Float64Array) => Float64Array.from(a, (v) => v * 1e6);
    charts.defl.draw(R.rolls.map((r, i): XYSeries => ({
      label: r.def.id, color: ROLL_COLORS[i % ROLL_COLORS.length], x: R.x, y: um(r.v),
    })), { unit: 'µm', halfWidth, strip, zero: true });

    const contactLabel = (c: { a: number; b: number }) => `${st.rolls[c.a].id}–${st.rolls[c.b].id}`;
    charts.flat.draw([
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: um(R.flat) },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: um(c.delta) })),
    ], { unit: 'µm', halfWidth, strip, zero: true });

    const kn = (a: Float64Array) => Float64Array.from(a, (v) => v / 1e6);
    charts.load.draw([
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: kn(R.q), fill: true },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: kn(c.q) })),
    ], { unit: 'kN/mm', halfWidth, strip, zero: true });

    const dev = (a: Float64Array) => {
      let s = 0, n = 0;
      for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { s += a[i]; n++; }
      const m = n ? s / n : 0;
      return Float64Array.from(a, (v) => (v - m) * 1e6);
    };
    charts.gauge.draw([
      { label: `h₁ − 平均 (${(R.h1Mean * 1e3).toFixed(4)} mm)`, color: STRIP_COLOR, x: R.x, y: dev(R.h1), width: 2 },
      { label: 'h₀ − 平均', color: '#8ea0bd', x: R.x, y: dev(R.h0), dash: true },
    ], { unit: 'µm', halfWidth: strip * 1.05, strip, zero: true });

    const iu = (a: Float64Array) => Float64Array.from(a, (v) => v * 1e5);
    charts.eps.draw([
      { label: '潜在 Δε', color: '#7fe4ff', x: R.x, y: iu(R.dEps) },
      { label: '顕在（波）', color: '#ff6b81', x: R.x, y: iu(R.manifest), fill: true },
    ], { unit: 'I-unit', halfWidth: strip * 1.05, strip, zero: true, symmetric: false });

    charts.sig.draw([
      { label: 'σf', color: '#96e6b4', x: R.x, y: Float64Array.from(R.sigmaF, (v) => v / 1e6), width: 2 },
    ], {
      unit: 'MPa', halfWidth: strip * 1.05, strip, zero: true,
      marks: [{ y: params.frontTension / 1e6, label: '設定平均', color: '#8ea0bd' }],
    });

    // stats
    stats.set('force', (R.force / TONF).toFixed(1));
    stats.set('screw', (R.screw * 1e3).toFixed(3));
    stats.set('h1', `${(R.h1Mean * 1e3).toFixed(4)} / ${(R.h1Centre * 1e3).toFixed(4)}`);
    stats.set('crown', (R.crown * 1e6).toFixed(1));
    stats.set('wedge', (R.wedge * 1e6).toFixed(1));
    stats.set('edge', `${(R.edgeDropL * 1e6).toFixed(1)} / ${(R.edgeDropR * 1e6).toFixed(1)}`);
    stats.set('latent', R.latentIU.toFixed(0), R.latentIU < 40 ? 'ok' : R.latentIU < 100 ? 'warn' : 'bad');
    stats.set('manifest', R.manifestIU.toFixed(0), R.manifestIU < 5 ? 'ok' : R.manifestIU < 40 ? 'warn' : 'bad');
    stats.set('conv', R.converged ? '収束' : running ? '反復中' : '停止', R.converged ? 'ok' : 'warn');
    stats.set('iter', `${R.iterations} / ${Number.isFinite(R.residual) ? R.residual.toExponential(1) : '—'}`);
    stats.set('ms', R.solveMs.toFixed(1));
    stats.set('dof', `${R.dof} / ${R.bandwidth}`);

    // contacts + reactions; the grid is rebuilt when the set changes (a new mill)
    const reactionLabel = (r: { def: { id: string; support: string } }) =>
      `${r.def.id} ${r.def.support === 'chock' ? 'ベンダー力' : '支持反力'}`;
    const keys = [
      ...R.contacts.map((c) => `c:${c.a}-${c.b}`),
      ...R.rolls.filter((r) => r.def.support !== 'free').map((r) => `r:${r.def.id}`),
    ];
    if (keys.join() !== contactKeys.join()) {
      const fresh = new StatGrid();
      R.contacts.forEach((c) => fresh.add(`c:${c.a}-${c.b}`, `${contactLabel(c)} 接触力`, 'tonf'));
      R.rolls.forEach((r) => { if (r.def.support !== 'free') fresh.add(`r:${r.def.id}`, reactionLabel(r), 'tonf'); });
      contactGrid.root.replaceWith(fresh.root);
      contactGrid = fresh;
      contactKeys = keys;
    }
    R.contacts.forEach((c) => contactGrid.set(`c:${c.a}-${c.b}`, (c.total / TONF).toFixed(1)));
    R.rolls.forEach((r) => {
      if (r.def.support !== 'free') contactGrid.set(`r:${r.def.id}`, r.reactions.map((v) => (v / TONF).toFixed(0)).join(' / '));
    });
  };

  /* ── loop ── */
  let raf = 0;
  let idleFrames = 0;
  const tick = () => {
    raf = 0;
    if (!active) return;
    let moved = false;
    if (running && !solver.isConverged) {
      moved = solver.advance(FRAME_BUDGET, 6);
    }
    if (moved || dirty) {
      drawAll();
      dirty = false;
      idleFrames = 0;
    } else {
      idleFrames++;
    }
    // once settled, keep a slow heartbeat so a resize or theme change is picked up cheaply
    raf = requestAnimationFrame(tick);
  };

  const handle: View3DHandle = {
    get active() { return active; },
    setActive(on: boolean) {
      active = on;
      root.hidden = !on;
      if (on) { dirty = true; if (!raf) raf = requestAnimationFrame(tick); }
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    relayout() { dirty = true; },
  };

  // keyboard: space pauses the solve on this tab too
  window.addEventListener('keydown', (e) => {
    if (!active || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Space') { e.preventDefault(); running = !running; dirty = true; }
    if (e.key === 'r' || e.key === 'R') { solver.setParams(params); solver.wake(); dirty = true; running = true; }
  });
  void idleFrames;
  // a hook for headless checks, like the 2D tab's
  (window as unknown as { __v3: unknown }).__v3 = { solver, get params() { return params; }, handle };
  return handle;
}

function millNote(m: MillType): string {
  switch (m) {
    case '2hi': return 'ワークロールを直接圧下する 2 段ミル。胴長に対して細いロールは大きく撓む（クラウン制御手段なし）。';
    case '4hi': return 'ワークロール + バックアップロール。WR ベンダーと BUR/WR クラウンで形状を作る。';
    case '6hi': return 'WR + 中間ロール + BUR。IR シフトで板端外の WR 支持を外し、IR/WR ベンダーと合わせて幅ごとの形状制御。';
    case '12hi': return '1-2-3 クラスタ（ゼンジミア型）。小径 WR を 2 本の中間ロールと 3 本のバッキング軸で支える。中央 B 軸に AS-U。';
    case '20hi': return '1-2-3-4 クラスタ（ゼンジミア 20 段）。第1中間のテーパ部シフトでエッジ、B・C 軸の AS-U で胴方向のクラウンを制御。';
  }
}

/** a parabolic AS-U setting: `amp` at the centre rack, 0 at the ends */
function asuShape(amp: number): number[] {
  return Array.from({ length: ASU_RACKS }, (_, k) => {
    const t = -1 + (2 * k) / (ASU_RACKS - 1);
    return amp * (1 - t * t);
  });
}

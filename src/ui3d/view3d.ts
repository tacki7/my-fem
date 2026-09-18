/**
 * The 3D tab: the roll-stack model of `sim3d`, its controls, and its
 * charts, living in `#view3d` beside the 2D tab's panels.
 *
 * Same conventions as the 2D tab: every input is a dial that takes effect at
 * once, the solve advances a little every frame so the picture is live, and
 * the charts are canvases that redraw while anything is moving and go quiet
 * once the solve has settled.
 *
 * The tab runs the 2Hi only (since 2026-09-19). `sim3d` still builds and
 * solves the 4Hi, 6Hi, 12Hi and 20Hi - the node checks under tools/sim3d
 * and the FrontISTR tools use them - but no control here reaches them.
 */

import { StackSolver, WARNING_TEXT, SETTINGS_WARNINGS, type Warning3D } from '../sim3d/solver';
import { RemainingTime, type Eta } from '../sim3d/eta';
import { defaultParams, MILL_LABEL, type Params3D } from '../sim3d/stack';
import { el, section, slider, select, toggle, buttonRow, StatGrid } from '../ui/controls';
import { LineChart, FrontView, EndView, SideView, SectionView, HeatChart, ROLL_COLORS, STRIP_COLOR, type XYSeries } from './charts3d';
import { StackView3D } from './stack3d';
import { ringCompliance } from '../sim3d/ring';
import { housingCompliance, halfStiffness, housingPlan, housingInScope } from '../sim3d/housing';
import { pingFrontistr, solveFrontistr, FistrError, type FistrResult } from './frontistr';

const TONF = 9.80665e3;
/** the screw dial's travel [m]; the solver itself allows −10 to 20 mm */
const SCREW_DIAL: [number, number] = [-2e-3, 8e-3];
/** the hints of the dials another dimension bounds (see `BOUNDS`) */
const NECK_HINT = 'ロール直径まで（スライダーの上限がロール直径。直径を細くするとネック径も追従する）。';
const SPAN_HINT = '軸受の中心間の距離。胴長より短くできない（スライダーの下限が胴長。胴長を支持スパンより長くすると支持スパンも伸びる）。';

/** solve time allowed per frame [ms] */
const FRAME_BUDGET = 14;
/** rows of the right panel's 板形状 and 解析 grids that the settings decide (the rest are results, faded when not this setting's) */
const SETTING_ROWS = new Set(['shape0', 'conv', 'dof', 'grid']);
/** a gap between solving frames longer than this is a pause or a hidden tab, not part of the solve [ms] */
const ETA_GAP_MS = 1000;

/** the remaining-time estimate as the status chip says it */
function etaText(e: Eta): string {
  switch (e.kind) {
    case 'remaining': {
      // whole seconds: the estimate is good to a few tens of percent, and a
      // tenth that changed every frame said more than it knew
      const s = e.ms / 1000;
      if (s < 1) return '残り 1 秒未満';
      if (s < 60) return `残り 約 ${Math.round(s)} 秒`;
      const m = Math.floor(Math.round(s) / 60);
      return `残り 約 ${m} 分 ${Math.round(s) - 60 * m} 秒`;
    }
    case 'estimating': return '残り 推定中';
    case 'stalled': return '残り 不明';
    default: return '';
  }
}

export interface View3DHandle {
  setActive(on: boolean): void;
  relayout(): void;
  readonly active: boolean;
}

interface Dial {
  /** show a parameter value (SI) */
  set(v: number): void;
  /** the travel the dial was built with, in its display units, and the factor from those to SI */
  min: number;
  max: number;
  scale: number;
  /** move the ends of its travel (display units) */
  setRange(min: number, max: number): void;
}

export function installView3D(root: HTMLElement, opts: { onMesh?: (text: string, detail: string) => void } = {}): View3DHandle {
  const params: Params3D = defaultParams('2hi');
  const solver = new StackSolver(params);
  let active = false;
  // The solve runs only when asked (計算開始 or Space) and stops once it has converged. Until
  // then a changed setting only rebuilds the stack, which takes milliseconds, so the 3D view and
  // the end and side views follow the dials while the results wait for the next solve.
  /** solving now */
  let running = false;
  /** the shown results are not the converged solution of the settings as they stand */
  let stale = true;
  /** the solve has iterated since the settings last changed (a stopped solve, not an unsolved one) */
  let iterated = false;
  let magnify = 200;
  let sectionMagnify = 200;
  let dirty = true;
  /* ── the FrontISTR cross-check: once a solve has converged, the same strip load on the work
     roll as a solid, solved by fistr1 through the dev server's bridge (frontistr.ts). Its
     deflection and indentation are drawn over the model's and set beside them. ── */
  /** the check is switched on (解析・表示 ▸ ロールの照合) */
  let fistrOn = false;
  /** the request in flight, so a changed setting can drop it */
  let fistrBusy: AbortController | null = null;
  let fistrT0 = 0;
  /** the last answer, for the settings the solve converged on; dropped when they change */
  let fistrShown: FistrResult | null = null;
  /** why there is no answer: the bridge's error, or nothing at the other end */
  let fistrNote = '';

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

  const front = cell('v3-front', 'ロールスタック', '3D: ドラッグ=回転 ／ ホイール=ズーム ／ ダブルクリック=視点リセット ／ 上半分を表示 ／ 胴の色 = 接触線荷重 ／ 板は厚さ偏差を倍率表示');
  // the stack is drawn either in 3D (WebGL, the default) or as the flat
  // front view; the cell holds both canvases and a label layer for the 3D one
  const stage = el('div', 'v3-stage');
  const glCanvas = el('canvas');
  glCanvas.className = 'v3-gl';
  const labelBox = el('div', 'v3-labels');
  front.canvas.replaceWith(stage);
  stage.append(glCanvas, labelBox, front.canvas);
  let frontMode: '3d' | '2d' = (() => { try { return localStorage.getItem('rollfem.v3.front') === '2d' ? '2d' : '3d'; } catch { return '3d'; } })();
  let stack3d: StackView3D | null = null;
  try { stack3d = new StackView3D(glCanvas, labelBox); } catch { frontMode = '2d'; }
  const modeBtns = buttonRow([
    { text: '3D', onClick: () => setFrontMode('3d') },
    { text: '正面図', onClick: () => setFrontMode('2d') },
  ]);
  modeBtns.classList.add('v3-front-mode');
  let colorBy: 'load' | 'stress' = (() => { try { return localStorage.getItem('rollfem.v3.color') === 'stress' ? 'stress' : 'load'; } catch { return 'load'; } })();
  const colorBtns = buttonRow([
    { text: '荷重', title: '胴の色 = 接触線荷重、板 = 顕在形状', onClick: () => setColor('load') },
    { text: '応力', title: 'ロール = 曲げ縁応力（青 圧縮／赤 引張）と接触線の Hertz 面圧、板 = 張力分布', onClick: () => setColor('stress') },
  ]);
  colorBtns.classList.add('v3-front-mode');
  const setColor = (c: 'load' | 'stress') => {
    colorBy = c;
    [...colorBtns.children].forEach((b, i) => b.classList.toggle('active', (i === 0) === (c === 'load')));
    try { localStorage.setItem('rollfem.v3.color', c); } catch { /* private mode */ }
    dirty = true;
  };
  setColor(colorBy);
  const legendBox = el('div', 'v3-legend');
  stage.append(legendBox);
  // over the stack while its colours and deflections are not the current settings' solution
  const staleTag = el('div', 'v3-stale-tag', '未計算: 形状は今の条件、変形と荷重は前回の計算（「計算開始」で解く）');
  // the discretisation at a glance, for the settings as they are now (not the last solve's):
  // the stations every roll is solved on, with the flattening's ring mesh when that model is
  // on, and the strip's slices, with the FEM's rows and layers when a FEM solves it
  const gridRoll = el('span'), gridStrip = el('span');
  const gridTag = el('div', 'v3-grid-tag');
  gridTag.append(el('span', 'v3-grid-title', '分割数'), el('span', '', 'ロール'), gridRoll, el('span', '', '材料'), gridStrip);
  // both along the stack's top edge; a narrow stage wraps the stale note under the counts
  const stageTop = el('div', 'v3-stage-top');
  stageTop.append(gridTag, staleTag);
  stage.append(stageTop);
  front.root.querySelector('.chart-head')!.append(colorBtns, modeBtns);
  const setFrontMode = (m: '3d' | '2d') => {
    if (m === '3d' && !stack3d) m = '2d';
    frontMode = m;
    stage.classList.toggle('flat', m === '2d');
    [...modeBtns.children].forEach((b, i) => b.classList.toggle('active', (i === 0) === (m === '3d')));
    try { localStorage.setItem('rollfem.v3.front', m); } catch { /* private mode */ }
    dirty = true;
  };
  setFrontMode(frontMode);
  const chartGrid = el('div', 'v3-charts');
  const cDefl = cell('v3-defl', 'ロール撓み', '各ロール軸の鉛直たわみ v(x)（支持点基準ではなく絶対値：スクリュー分の沈み込みを含む）');
  const cFlat = cell('v3-flat', '扁平量', '接触ごとの相互接近量（両ロールの弾性扁平の和）／ WR–板は WR 側の扁平');
  const cLoad = cell('v3-load', '接触線荷重', '接触ごとの単位幅荷重 q(x)');
  const cGauge = cell('v3-gauge', '板厚プロファイル', '板幅中央を 0 とした偏差');
  const cCrown = cell('v3-crown', 'クラウン比率', '板厚プロファイル ÷ 中央の板厚');
  const cCrownChange = cell('v3-crown-change', 'クラウン比率変化', '入側 − 出側 ／ 正 = 板端側が伸びる');
  const cEps = cell('v3-eps', '伸び率分布', '幅方向の伸び差 Δε（最も伸びの小さい位置を 0 とした値）／ 実線 = 潜在形状（張力で押さえ込まれる分を含む）／ 塗り = 顕在化（波）');
  const cSig = cell('v3-sig', '前方張力分布', '各スライスの張力 σf(x) ／ 破線 = 設定平均 ／ 下限 = 座屈、上限 = 降伏で頭打ち');
  const cPress = cell('v3-press', '噛み込み域の圧力 p(x, z)', '材料 FEM ／ 横 = 幅方向、縦 = 接触弧（上 = 入側、下 = 出側、弧長は列ごと）／ 摩擦丘が幅方向にどう変わるか');
  const cFlow = cell('v3-flow', '横流れ速度 u_x(x, z)', '材料 FEM ／ ロール周速比 [%] ／ 正 = +x 側へ（板端へ広がる流れ）');
  chartGrid.append(cDefl.root, cFlat.root, cLoad.root, cGauge.root, cCrown.root, cEps.root, cSig.root, cPress.root, cFlow.root, cCrownChange.root);

  // the headline numbers as chips over the front view, like the 2D top bar
  const status = el('div', 'v3-status');
  const chip = (unit: string, label?: string) => {
    const b = el('div', 'badge');
    b.innerHTML = `${label ? `<i>${label}</i>` : ''}<b>—</b><span>${unit}</span>`;
    return b;
  };
  const chips = {
    mill: chip('', 'ミル'), force: chip('tonf', '荷重'), h1: chip('mm', '平均板厚'),
    crown: chip('µm', 'C25'), manifest: chip('I-unit', '顕在形状'), conv: chip('', ''),
    res: chip('', '残差'), ms: chip('ms', '解法'), fistr: chip('', 'FrontISTR'),
  };
  chips.fistr.hidden = true;
  chips.fistr.title = 'ソリッド要素の FEM（FrontISTR）で解いた撓み・扁平の、このモデルとの差（板中央の差と、最大差のモデル最大値に対する比）。計算が収束するたびに解き直す（約 10 秒）。';
  chips.conv.innerHTML = '<i class="v3-dot"></i><b>—</b>';
  chips.conv.title = [
    '推定残り時間: ここまでの反復から外挿した、収束までの実時間（描画の時間も含む）。',
    '材料 FEM のときは、補正ラウンドの変化量の減り方（初回の比は除く）から残りのラウンド数を、ラウンドの間隔とその縮み方から 1 ラウンドの時間を出す。',
    'スラブ法は Newton の残差の減り方から。ダイヤルを動かすと解き直しなので推定もやり直す（同じメッシュなら前回のラウンド時間を使う）。',
    '「推定中」はまだ手がかりが無いとき、「不明」は残差が 80 反復下がらず補正ラウンドにも進めないとき（収束しない可能性が高い）。',
  ].join('\n');
  chips.res.title = '外側 Newton の相対残差（力の不釣り合い ÷ 最大の力、収束判定 2e-6）／ 材料 FEM のときはその補正の変化量（荷重比、収束判定 2e-3）';
  const runBtn = el('button', 'btn btn-primary v3-run', '▶ 計算開始');
  runBtn.type = 'button';
  runBtn.title = '今の条件で収束まで解く（Space でも同じ）。計算中に押すと止まる。条件を変えると計算は止まり、結果は「未計算」になる（上の 3D 図と右の端面図・側面図は条件どおりにすぐ描き変わる）。';
  status.append(runBtn, chips.mill, chips.force, chips.h1, chips.crown, chips.manifest, chips.conv, chips.res, chips.ms, chips.fistr);
  const warnBox = el('div', 'v3-warnings');
  status.append(warnBox);
  const setChip = (c: HTMLElement, text: string, tone?: 'ok' | 'warn' | 'bad') => {
    const b = c.querySelector('b')!;
    if (b.textContent !== text) b.textContent = text;
    // the tone only: 'busy' and 'v3-stale' are set by their own owners
    for (const t of ['ok', 'warn', 'bad'] as const) c.classList.toggle(t, t === tone);
  };
  const hint = el('div', 'v3-hint', 'Space=計算開始／停止 ／ R=再初期化 ／ チャート上にポインタで数値読み取り');
  centre.append(status, front.root, chartGrid, hint);

  const frontView = new FrontView(front.canvas);
  const charts = {
    defl: new LineChart(cDefl.canvas), flat: new LineChart(cFlat.canvas), load: new LineChart(cLoad.canvas),
    gauge: new LineChart(cGauge.canvas), crown: new LineChart(cCrown.canvas), eps: new LineChart(cEps.canvas), sig: new LineChart(cSig.canvas),
    press: new HeatChart(cPress.canvas), flow: new HeatChart(cFlow.canvas), crownChange: new LineChart(cCrownChange.canvas),
  };

  /* ── right panel: results ── */
  // One grid, three sections: the same `set` calls land wherever the row
  // lives, so the split is a matter of which body each row is appended to.
  const stats = new StatGrid();
  // A view in a folded section skips drawing (its canvas has no size); drawn again when opened.
  const redrawOnOpen = (open: boolean) => { if (open) dirty = true; };
  const loadSec = section('荷重・圧下', { open: true, onToggle: redrawOnOpen });
  const shapeSec = section('板形状', { open: true, onToggle: redrawOnOpen });
  const numSec2 = section('解析', { open: false, onToggle: redrawOnOpen, hint: '外側 Newton の反復回数と相対残差、1 フレームの解法時間、全体剛性の自由度と半バンド幅、幅方向の節点数（板上のスライス数と間隔 / 全ロール共通）。' });
  const grid = (sec: { body: HTMLElement }) => { const g = el('div', 'stat-grid'); sec.body.append(g); return g; };
  const gLoad = grid(loadSec), gShape = grid(shapeSec), gNum = grid(numSec2);
  // each row of the 板形状 and 解析 grids, to fade the results in them row by row (see `SETTING_ROWS`)
  const rowFade = new Map<string, HTMLElement>();
  const into = (g: HTMLElement, key: string, label: string, unit?: string) => {
    stats.add(key, label, unit);
    const row = stats.root.lastElementChild as HTMLElement;
    if (g !== gLoad) rowFade.set(key, row);
    g.append(row);
  };
  into(gLoad, 'force', '圧延荷重', 'tonf'); into(gLoad, 'screw', '圧下位置 S', 'mm'); into(gLoad, 'h1', '出側板厚 平均 / 中央', 'mm');
  into(gLoad, 'reduction', '圧下率 実績 中央 / 平均', '%');
  into(gLoad, 'relief', '張力による降伏緩和 σ̄t/k̄f', '%');
  into(gShape, 'crown', 'クラウン C25', 'µm'); into(gShape, 'wedge', 'ウェッジ', 'µm'); into(gShape, 'edge', 'エッジドロップ L / R', 'µm');
  into(gShape, 'shape0', '入側 C25 / エッジドロップ', 'µm');
  into(gShape, 'latent', '潜在形状 (p-p)', 'I-unit'); into(gShape, 'manifest', '顕在形状 (最大)', 'I-unit');
  into(gNum, 'conv', '収束'); into(gNum, 'fem', '材料 FEM 反復 / 質量収支'); into(gNum, 'iter', '反復 / 残差'); into(gNum, 'ms', '解法時間', 'ms/frame'); into(gNum, 'dof', '自由度 / 半バンド幅');
  into(gNum, 'grid', '幅方向 節点 板上 / 全');
  const fistrSec = section('FrontISTR 照合', {
    open: true, onToggle: redrawOnOpen,
    hint: 'このモデル（ティモシェンコ梁 ＋ Hertz の接触・扁平）と、上半分の WR をソリッド要素で解いた FrontISTR の解。板の荷重 q(x)（収束したスライスの値）を両方に同じだけ与えるので、違いはロールの力学だけ。'
      + '撓みは軸受に対する WR 軸の値（板中央）、扁平は板の下の局所的な沈み込み（FEM は下面 − 上面で読み、曲げのポアソン効果を除く）。「最大差」の括弧はモデルの最大値に対する比。'
      + '格子は関門と同じ 81 点・弧 8 分割。詳細は tools/frontistr/README.md。',
  });
  fistrSec.root.hidden = true;
  let fistrStats = new StatGrid();
  /** the rows follow the stack: one per roll, one per contact, then what the mill has (flattening on a 2Hi, the exit profile with contacts) */
  const buildFistrRows = () => {
    const R = solver.result, st = solver.stack;
    const g = new StatGrid();
    g.add('state', '状態');
    for (const r of R.rolls) g.add(`v:${r.def.id}`, `${r.def.id} 軸 撓み 中央 モデル / FEM`, 'µm');
    for (const c of R.contacts) g.add(`q:${st.rolls[c.a].id}–${st.rolls[c.b].id}`, `${st.rolls[c.a].id}–${st.rolls[c.b].id} 線荷重 中央 モデル / FEM`, 'kN/mm');
    if (R.contacts.length === 0) g.add('flat', '扁平 中央 モデル / FEM', 'µm');
    g.add('wv', '最大差 軸の撓み', 'µm');
    if (R.contacts.length) g.add('wq', '最大差 線荷重', 'kN/mm');
    g.add(R.contacts.length ? 'wexit' : 'wflat', R.contacts.length ? '最大差 出側プロファイル Δh₁/2' : '最大差 扁平', 'µm');
    // the strip load on the modelled part: a quarter of the roll (a symmetric half case) or half of it (a 6Hi's whole length)
    g.add('brg', '軸受反力 FEM / 板の荷重（モデル部分）', 'tonf');
    g.add('mesh', '節点 / 時間');
    fistrStats.root.replaceWith(g.root);
    fistrStats = g;
  };
  fistrSec.body.append(fistrStats.root);
  const contactSec = section('接触力・支持反力', { open: true, onToggle: redrawOnOpen });
  let contactGrid = new StatGrid();
  contactSec.body.append(contactGrid.root);
  const endSec = section('端面図', { open: true, onToggle: redrawOnOpen });
  const endCanvas = el('canvas');
  endCanvas.id = 'v3-end';
  endSec.body.append(endCanvas);
  const endView = new EndView(endCanvas);
  const sideSec = section('側面図（横から）', {
    open: true, onToggle: redrawOnOpen,
    hint: '端面図のロール配置を横（オペレータ側）から見た図。上の WR の胴・ネックを実寸の比で、支持（□ チョック、赤 ▼ 圧下）とパスラインの板幅とともに。ハウジング変形考慮モードではハウジング枠も。撓みは正面図、荷重は端面図。',
  });
  const sideCanvas = el('canvas');
  sideCanvas.id = 'v3-side';
  sideSec.body.append(sideCanvas);
  const sideView = new SideView(sideCanvas);
  const secSec = section('ワークロール断面（扁平メッシュ）', {
    open: true, onToggle: redrawOnOpen,
    hint: '扁平モデルが「断面 FEM」のときのロール断面リング。板中央の接触線荷重による変形を倍率表示。刻み数は「解析・表示」で。',
  });
  const secCanvas = el('canvas');
  secCanvas.id = 'v3-section';
  secSec.body.append(secCanvas);
  const sectionView = new SectionView(secCanvas);
  into(gNum, 'flatCmp', '扁平コンプライアンス 断面FEM / Hertz');
  // The housing deformation mode's frame and seats. In the panel only while the
  // solve has a housing result - with the mode off, or on a mill outside its
  // scope, the panel reads exactly as it did before the mode existed.
  const housingSec = section('ハウジング', {
    open: true, onToggle: redrawOnOpen,
    hint: 'ハウジング変形考慮モードの結果。左右（操作側 −x・駆動側 +x）のハウジング枠それぞれについて、枠が受ける荷重（上下チョック荷重の平均）と窓の開き（ポストの伸び + 上下クロスヘッドのたわみ）。圧下ロールの傾きは駆動側の支持点の鉛直変位 − 操作側。ミル剛性は圧延荷重 ÷ 左右の窓の開きの平均。',
  });
  const housingStats = new StatGrid();
  housingStats.add('hLoad', 'ハウジング荷重 操作側 / 駆動側', 'tonf')
    .add('hStretch', '窓の開き 操作側 / 駆動側', 'µm')
    .add('hPost', '　うち ポスト 操作側 / 駆動側', 'µm')
    .add('hTop', '　うち 上クロスヘッド 操作側 / 駆動側', 'µm')
    .add('hBottom', '　うち 下クロスヘッド 操作側 / 駆動側', 'µm')
    .add('hTilt', '圧下ロールの傾き（駆動側 − 操作側）', 'µm')
    .add('hModulus', 'ミル剛性（荷重 ÷ 窓の開き）', 'MN/mm');
  housingSec.body.append(housingStats.root);
  right.append(loadSec.root, fistrSec.root, shapeSec.root, endSec.root, sideSec.root, contactSec.root, secSec.root, numSec2.root);

  /* ── left panel: inputs ── */
  const dials = new Map<string, Dial>();
  let contactKeys: string[] = [];

  /**
   * Dimensions the other settings bound: the work roll's neck no thicker than the roll, its
   * support span no shorter than its barrel - a bearing inside the barrel is no mill. The
   * bounded dial's travel ends at the bound, so it cannot be dragged, typed or stepped past it;
   * when the bound moves past the value, the value follows. A bound is another setting's value
   * or a function of the settings [SI].
   */
  type Bound = { key: keyof Params3D; by: keyof Params3D | ((p: Params3D) => number); side: 'max' | 'min' };
  const BOUNDS: Bound[] = [
    { key: 'wrDn', by: 'wrD', side: 'max' },
    { key: 'wrLs', by: 'wrLb', side: 'min' },
  ];
  const boundOf = (p: Params3D, b: Bound) => (typeof b.by === 'function' ? b.by(p) : (p as unknown as Record<string, number>)[b.by as string]);
  /** the parameters held to their bounds, the upper bounds first */
  const clampBounds = (p: Params3D) => {
    const pr = p as unknown as Record<string, number>;
    for (const side of ['max', 'min'] as const) {
      for (const b of BOUNDS) {
        if (b.side !== side) continue;
        const v = pr[b.key as string], lim = boundOf(p, b);
        if (side === 'max' ? v > lim : v < lim) pr[b.key as string] = lim;
      }
    }
  };
  /** each bounded dial: its travel cut at its bounds (never to nothing), and the value as the parameter has it */
  const syncBounds = () => {
    const pr = params as unknown as Record<string, number>;
    const seen = new Set<string>();
    for (const b of BOUNDS) {
      const key = b.key as string;
      const d = dials.get(key);
      if (!d || seen.has(key)) continue;
      seen.add(key);
      let lo = d.min, hi = d.max;
      for (const c of BOUNDS) {
        if (c.key !== b.key) continue;
        const lim = boundOf(params, c) / d.scale;
        if (c.side === 'max') hi = Math.min(hi, lim); else lo = Math.max(lo, lim);
      }
      lo = Math.min(lo, d.max - 1e-9 * (d.max - d.min));
      hi = Math.max(hi, lo + 1e-9 * (d.max - d.min));
      d.setRange(lo, hi);
      d.set(pr[key]);
    }
  };
  /** the housing section's derived-stiffness line, rewritten on every change while the section is built */
  let refreshHousingHint: (() => void) | null = null;
  /** a changed setting: the stack follows at once, a running solve stops, the results go stale */
  const settingsChanged = () => {
    running = false;
    stale = true;
    iterated = false;
    dirty = true;
    dropFistr();
  };
  /** the check's answer and any request in flight go with the settings they were for */
  const dropFistr = () => {
    fistrBusy?.abort();
    fistrBusy = null;
    fistrShown = null;
  };
  /** a converged solve with the check on: ask the bridge (nothing while one is running) */
  const maybeRunFistr = () => {
    if (!fistrOn || stale || running || fistrBusy) return;
    const ctl = new AbortController();
    fistrBusy = ctl;
    fistrT0 = performance.now();
    fistrNote = '';
    // the chip counts the seconds while the solve runs: a frame a second is enough
    const ticker = setInterval(() => { dirty = true; }, 1000);
    solveFrontistr(params.mill, params, ctl.signal).then((r) => {
      if (fistrBusy !== ctl) return;
      fistrShown = r;
    }).catch((e: unknown) => {
      if (ctl.signal.aborted || fistrBusy !== ctl) return;
      fistrNote = e instanceof FistrError ? e.message : e instanceof Error ? e.message : String(e);
      if (e instanceof FistrError && e.log) console.warn('FrontISTR:', e.log);
    }).finally(() => {
      clearInterval(ticker);
      if (fistrBusy === ctl) fistrBusy = null;
      dirty = true;
    });
    dirty = true;
  };
  const setFistr = (on: boolean) => {
    fistrOn = on;
    chips.fistr.hidden = !fistrOn;
    fistrSec.root.hidden = !fistrOn;
    if (!fistrOn) { dropFistr(); fistrNote = ''; }
    else {
      buildFistrRows();
      void pingFrontistr().then((p) => {
        if (!fistrOn) return;
        if (!p) fistrNote = '接続なし（npm run dev の橋渡しが要る）';
        else if (!p.fistr1) fistrNote = 'fistr1 が無い（tools/frontistr/README.md）';
        dirty = true;
      });
      maybeRunFistr();
    }
    dirty = true;
  };
  const apply = () => {
    clampBounds(params);
    syncBounds();
    solver.setParams(params);
    refreshHousingHint?.();
    settingsChanged();
  };
  const startSolve = () => {
    if (running || !stale) return;
    running = true;
    dirty = true;
  };
  const stopSolve = () => {
    if (!running) return;
    running = false;
    dirty = true;
  };
  runBtn.addEventListener('click', () => {
    if (running) stopSolve(); else startSolve();
    // the key handler below owns Space; a focused button would take it as a click as well
    runBtn.blur();
  });
  /** a dial on a numeric field, in display units `scale` × SI */
  const num = (
    key: keyof Params3D, label: string, unit: string, min: number, max: number, step: number,
    scale: number, hint?: string, log = false, format?: (v: number) => string,
  ) => {
    const h = slider({
      label, unit, min, max, step, log, value: (params[key] as number) / scale, hint, format,
      onInput: (v) => { (params as unknown as Record<string, number>)[key as string] = v * scale; apply(); },
    });
    dials.set(key as string, { set: (v) => h.set(v / scale), min, max, scale, setRange: (lo, hi) => h.setRange(lo, hi) });
    h.root.dataset.key = key as string;
    return h.root;
  };

  const buildLeft = () => {
    left.replaceChildren();
    // control
    const ctlSec = section('制御・目標', { remember: false, open: false });
    ctlSec.body.append(select<'gauge' | 'force' | 'screw'>('制御モード', [
      { value: 'gauge', text: '出側板厚（圧下率）一定' }, { value: 'force', text: '圧延荷重一定' }, { value: 'screw', text: '圧下位置 手動' },
    ], params.mode, (v) => {
      // Bumpless into the manual mode: the screw dial takes the position the solve reached,
      // held to the dial's travel. It used to jump to whatever the dial last said (0.5 mm
      // against a solved 2.2 mm on the 4Hi defaults), and the load collapsed with it.
      if (v === 'screw' && params.mode !== 'screw' && Number.isFinite(solver.screw)) {
        params.screw = Math.max(SCREW_DIAL[0], Math.min(SCREW_DIAL[1], solver.screw));
        dials.get('screw')?.set(params.screw);
      }
      params.mode = v; apply(); syncModeDials();
    }, 'スクリュー位置 S は目標に乗るように Newton の中で一緒に解く（接触がまだ無い間だけ割線法）。「圧下位置 手動」に切り替えると、解いた S を圧下位置ダイヤルに引き継ぐ。').root);
    ctlSec.body.append(num('reduction', '圧下率', '%', 2, 60, 0.5, 0.01, '出側板厚一定の目標: 出側の幅平均の板厚 = (1 − 圧下率) × h₀（板幅中央の入側板厚）。入側クラウンがあると幅平均の入側は h₀ より薄いので、平均で見た圧下率は少し小さい（右の「荷重・圧下 ▸ 圧下率 実績」）。'));
    ctlSec.body.append(num('targetForce', '目標荷重', 'tonf', 20, 4000, 10, TONF));
    // the travel is written out: tools/ui/typed.mjs reads the dials from the source (SCREW_DIAL is the same numbers)
    ctlSec.body.append(num('screw', '圧下位置 S', 'mm', -2, 8, 0.005, 1e-3, '無負荷でロールが板に触れる位置を 0 とした締め込み量。負は開き（クラウンや AS-U でスタックが予圧されていると必要になる）。出側板厚一定／荷重一定のときは解いた S を表示し（灰色）、「圧下位置 手動」に切り替えるとその値から始まる（ダイヤルの範囲 −2〜8 mm に丸める）。'));
    ctlSec.body.append(num('leveling', 'レベリング ΔS', 'µm', -300, 300, 5, 1e-6, '駆動側と作業側のスクリュー差。正で +x 側が締まる。'));
    ctlSec.body.append(num('housingK', 'ハウジング剛性', 'MN/mm', 1, 30, 0.5, 1e9, '支持点（チョックまたはサドル）1 点あたりの剛性。ロールの曲げ・扁平はモデルが計算するので、ここはハウジングとチョックだけ。'));
    left.append(ctlSec.root);

    // housing deformation mode
    const hSec = section('ハウジング', {
      remember: false, open: false,
      hint: 'ハウジング変形考慮モード。OFF（既定）では圧下ロールの各チョックが独立したばね（「制御・目標」のハウジング剛性）に載る。ON では左右それぞれのハウジング枠（ポスト 2 本と上下のクロスヘッド）に載り、上下のチョックがポストでつながる。'
        + '枠の寸法の既定は桁を見積もった仮定で、実機の図面の値ではない（docs/validation.md「ハウジング変形考慮モード」）。',
    });
    const modeToggle = toggle('ハウジング変形考慮モード', params.housingMode, (v) => { params.housingMode = v; apply(); syncModeDials(); },
      'ON で圧下ロールのチョックをハウジング枠に載せる。枠の剛性は下の寸法から計算する（「ハウジング剛性」は圧下ロールには使わなくなる）。');
    hSec.body.append(modeToggle.root);
    hSec.body.append(num('housingPostArea', 'ポスト 断面積（1 本）', 'm²', 0.05, 1.5, 0.01, 1, '片側のハウジングのポスト 1 本の断面積。既定 0.35 m²（500 × 700 mm を仮定。図面の値ではない）。'));
    hSec.body.append(num('housingPostCount', 'ポスト 本数（片側）', '本', 1, 4, 1, 1, '片側のハウジングの窓を作るポストの数。ふつうは 2 本（入側・出側）。'));
    hSec.body.append(num('housingPostLength', 'ポスト 長さ', 'm', 1, 8, 0.1, 1, '上下のクロスヘッドの間のポストの長さ。既定 4.5 m（仮定）。'));
    hSec.body.append(num('housingPostWidth', 'ポスト 幅（ロール軸方向）', 'm', 0.1, 1.5, 0.01, 1, '操作側・駆動側それぞれのポストの、ロール軸方向の幅。ポストは圧下ロールのチョックを中心に立つので、板が通るポスト内面の間隔 = チョック間隔 − この幅。側面図の描画と、板幅がこの間隔を超えたときの警告だけに使い、剛性には使わない（剛性は断面積から）。既定 0.7 m（500 × 700 mm の 700 側を仮定）。'));
    hSec.body.append(num('housingCrossSpan', 'クロスヘッド スパン', 'm', 0.5, 4, 0.05, 1, 'ポスト中心の間隔（クロスヘッドはこの 2 点で支えられ、中央にチョック荷重を受ける梁）。既定 1.8 m（仮定）。'));
    hSec.body.append(num('housingCrossI', 'クロスヘッド 断面二次モーメント', 'm⁴', 1e-4, 5e-2, 1e-4, 1, '曲げのたわみ F S³ / (48 E I)。既定 4.5×10⁻³ m⁴（700 × 420 mm の断面を仮定）。', true, (v) => v.toExponential(2)));
    hSec.body.append(num('housingCrossShearArea', 'クロスヘッド せん断断面積', 'm²', 0.05, 1.5, 0.01, 1, 'せん断のたわみ F S / (4 G A_s)。既定 0.3 m²（仮定）。'));
    hSec.body.append(num('housingE', 'ハウジング ヤング率', 'GPa', 100, 250, 1, 1e9, '鋳鋼・鋼板のハウジング。既定 206 GPa。'));
    const derived = el('div', 'ctrl-hint');
    refreshHousingHint = () => {
      const c = housingCompliance(params);
      const k = halfStiffness(c);
      const screwRoll = solver.stack.rolls.find((r) => r.support === 'screw');
      const plan = screwRoll ? housingPlan(params, screwRoll) : null;
      derived.textContent = `片側の鉛直剛性（上下対称なときの 1 チョック）: ${(k / 1e9).toFixed(2)} MN/mm ／ `
        + `ポスト ${(c.post * 1e12).toFixed(2)} µm/MN・クロスヘッド ${(c.crosshead * 1e12).toFixed(2)} µm/MN（荷重あたりの伸び・たわみ）。`
        + '既定の寸法は、この値が OFF のときのハウジング剛性の既定（6.04 MN/mm）と揃うように選んである。'
        + (plan ? ` ポスト内面の間隔 ${((plan.inner[1] - plan.inner[0]) * 1e3).toFixed(0)} mm（板幅 ${(params.width * 1e3).toFixed(0)} mm${plan.stripOverlap > 0 ? '、⚠ 板がポストに当たる' : ''}）。` : '');
    };
    refreshHousingHint();
    hSec.body.append(derived);
    left.append(hSec.root);

    // profiles
    const profSec = section('ロールプロファイル', { remember: false, open: false });
    profSec.body.append(num('wrCrown', 'WR 研削クラウン', 'µm', -400, 400, 5, 1e-6, '直径クラウン: 中央と胴端の直径差。正で中央が太い（放物線）。'));
    profSec.body.append(num('wrThermal', 'WR サーマルクラウン', 'µm', 0, 200, 5, 1e-6, '熱膨張による直径クラウン（入力値。温度分布は解かない）。'));
    left.append(profSec.root);

    // strip
    const stripSec = section('板・圧延条件', { remember: false, open: false });
    stripSec.body.append(select<'slab' | 'fem' | 'fem3d'>('材料の変形計算', [
      { value: 'fem3d', text: '3 次元 FEM（幅 × 圧延方向 × 板厚、ロールと連成）' },
      { value: 'fem', text: '平面 FEM（幅 × 圧延方向、ロールと連成）' },
      { value: 'slab', text: 'スラブ法（幅方向スライス）' },
    ], params.stripModel, (v) => { params.stripModel = v; apply(); buildLeft(); },
    '3 次元 FEM: 板厚の上半分（中央面対称）を六面体で分割した剛塑性 FEM。ロール面は法線速度拘束＋クーロン摩擦、圧力はその反力。板厚方向の速度分布・横流れ・摩擦丘が結果として出る。平面 FEM: 板厚方向を一様速度とした薄板近似（速い）。スラブ法: 幅方向スライスごとの Bland & Ford（最速）。いずれもロールの撓み・扁平と連成。').root);
    stripSec.body.append(num('stripStations', '材料 幅方向 分割数', '', 0, 601, 1, 1, '板の上に置く節点（スライス）の数。0: ロールの節点に合わせる（「解析・表示 ▸ 幅方向 分割数」の等間隔の節点のうち板に掛かるもの。板端のセルは板幅しだいで欠ける）。1 以上: 板幅をこの数の等幅のセルでちょうど分け（奇数に丸める。中央に節点）、板の外はロールの分割数どおりの間隔。スラブ法のスライス、材料 FEM の幅方向の列、張力の再配分がこの点数で解ける。計算時間は板上の点数の 2〜3 乗で伸びる。実際の点数は右の「解析 ▸ 幅方向 節点」。'));
    if (params.stripModel === 'fem' || params.stripModel === 'fem3d') {
      stripSec.body.append(num('stripNz', '材料 FEM 圧延方向 分割数', '', 4, 32, 1, 1, '噛み込み弧に沿った要素数。幅方向の列は板上の節点ごと（「材料 幅方向 分割数」）。'));
    }
    if (params.stripModel === 'fem3d') {
      stripSec.body.append(num('stripNy', '材料 FEM 板厚方向 分割数', '', 1, 6, 1, 1, '板厚の上半分の層数（中央面は対称面）。結果は 1〜3 でほぼ変わらない。計算時間は層数に比例。'));
    }
    stripSec.body.append(num('width', '板幅', 'mm', 300, 1600, 10, 1e-3, 'WR の胴長を超えると警告が出る（胴からはみ出した板は圧延されず、計算にも入らない）。'));
    stripSec.body.append(num('h0', '入側板厚 h₀', 'mm', 0.05, 6, 0.01, 1e-3, undefined, true));
    stripSec.body.append(num('entryCrown', '入側クラウン', 'µm', -100, 200, 2, 1e-6, '入側板厚の中央と板端の差（放物線）。板端だけが急に薄くなる分は下の「入側エッジドロップ」で足す。出側クラウン比が入側と一致すれば平坦。入側の板厚は板幅のどこでも h₀ の 25 % で頭打ち（下回ると警告）。'));
    stripSec.body.append(num('entryEdgeDrop', '入側エッジドロップ', 'µm', -100, 200, 2, 1e-6, '板端での落ち込み: 板端が放物線（入側クラウン）よりどれだけ薄いか。板端から「エッジドロップ 範囲」の内側で 0、そこから板端へ距離の 2 乗で深くなる（範囲の内端で傾き 0、板端で最も急）。負は板端が厚い（エッジアップ）。出側と同じ読み方（板端から 100 mm と 15 mm の板厚の差、放物線の分を含む）の入側の値は右の「板形状 ▸ 入側 C25 / エッジドロップ」。入側の板厚は板幅のどこでも h₀ の 25 % で頭打ち（下回ると警告）。'));
    stripSec.body.append(num('entryEdgeDropWidth', 'エッジドロップ 範囲', 'mm', 5, 300, 5, 1e-3, '入側エッジドロップが始まる位置の板端からの距離（板幅の半分まで）。狭いほど板端で急に落ちる。板上の節点間隔（3D 図の左上「分割数」の材料の括弧内）の数倍はないと、落ち込みが数点でしか表せない。'));
    stripSec.body.append(num('backTension', '後方張力', 'MPa', 0, 300, 5, 1e6));
    stripSec.body.append(num('frontTension', '前方張力', 'MPa', 0, 300, 5, 1e6, '幅方向の平均値。分布は伸び差から決まる。'));
    stripSec.body.append(num('mu', '摩擦係数 μ', '', 0.01, 0.3, 0.005, 1));
    stripSec.body.append(num('lmnL', '変形抵抗 L', 'MPa', 200, 3000, 10, 1e6, 'kf = L (ε + M)ᴺ（平面ひずみ）。2D タブと同じ式。'));
    stripSec.body.append(num('lmnM', 'M', '', 0, 0.2, 0.005, 1));
    stripSec.body.append(num('lmnN', 'N', '', 0, 0.6, 0.005, 1));
    stripSec.body.append(num('entryStrain', '入側予ひずみ', '', 0, 2, 0.05, 1));
    stripSec.body.append(num('lateralLen', '横流れ 平滑長', 'mm', 0, 100, 1, 1e-3, '幅方向の伸び差を均す距離（板厚の数倍）。下限は板上の節点間隔（それより短いと隣接スライスが結合されず、市松状の数値モードが出る）。'));
    stripSec.body.append(toggle('張力フィードバック', params.tensionFeedback, (v) => { params.tensionFeedback = v; apply(); syncModeDials(); },
      'ON: 板の長手張力が降伏条件（p = kf − σt）と塑性変形の開始点（弾性圧下量）を下げ、幅方向の伸び差で張力が再配分され、材料 FEM の入出側トラクションにも入る。これが荷重を通じて WR の撓み・扁平に返る。OFF: 張力なしで圧延したときの挙動（比較用）。').root);
    const slabTensionSel = select<'mean' | 'split'>('荷重式の張力', [
      { value: 'mean', text: '前後の平均（Kármán・Siebel 型）' },
      { value: 'split', text: '前後を分ける（Nádai の解）' },
    ], params.slabTension, (v) => { params.slabTension = v; apply(); },
    'スライスの荷重式で後方張力 σb と前方張力 σf をどう効かせるか。前後の平均: (σb + σf)/2 を噛み込み弧全体の変形抵抗 k̄f から引く。前後を分ける（既定）: 前方張力は出口から中立点まで、後方張力は中立点から入口までにだけ効き、それぞれ摩擦の丘 e^{2μ√(R′/h₁)·θ} で増幅される（降伏応力一定の Kármán 方程式の Nádai の解の張力項。中立点は Bland & Ford の圧力の形で決める）。4Hi のパス（R′ 250 mm 固定）で荷重の張力感度 −∂q/∂σf・−∂q/∂σb は、平均 0.56 L・0.56 L、前後を分ける 0.36 L・0.90 L（L は接触弧長。2D タブのスラブ法 Orowan 0.34 L・0.91 L、2D FEM 0.27 L・0.92 L）。前方張力の幅方向の分布が荷重に返る強さ（張力帰還）が弱くなる。材料 FEM のときは荷重そのものは FEM が決め、この式は補正の基準と接線に効く。張力フィードバック OFF では効かない。docs/validation.md「スラブ法の張力 — 平均と前後別」。');
    slabTensionSel.root.dataset.key = 'slabTension';
    stripSec.body.append(slabTensionSel.root);
    stripSec.body.append(num('sigmaCr', '座屈限界（圧縮）', 'MPa', 0, 20, 0.5, 1e6, 'これ以上の圧縮を板は張力として支えられず、波（顕在形状）になる。座屈した後もいくらか圧縮を持たせるには下の「座屈後の剛性」。'));
    const postBucklingSel = select<'linear' | 'effectiveWidth'>('座屈後の構成則', [
      { value: 'linear', text: '一定の剛性比 β' },
      { value: 'effectiveWidth', text: '有効幅（von Kármán）' },
    ], params.postBucklingModel, (v) => {
      // keep the stiffness right after buckling: β = k/2
      const s = params.postBucklingStiffness;
      params.postBucklingStiffness = v === params.postBucklingModel ? s : v === 'effectiveWidth' ? Math.min(2, 2 * s) : s / 2;
      params.postBucklingModel = v; apply(); buildLeft();
    },
    '座屈限界に達したスライス（波の出る部分）が、その先の伸び差 ΔD をどれだけ圧縮応力として持つか。一定の剛性比: σ = −σcr − β·E′·ΔD。有効幅: |σ| = √(σcr² + k·σcr·E′·ΔD)（両縁を支えた板の von Kármán の有効幅から。座屈直後の傾きは E′ の k/2 で、波が深いほど寝る。片側が自由縁の板端の帯には余力を多めに見ている可能性がある）。持てなかった分が波（顕在形状）。既定は有効幅・k = 1。切り替えると座屈直後の傾きが同じになるよう β = k/2 で換算する。');
    postBucklingSel.root.dataset.key = 'postBucklingModel';
    stripSec.body.append(postBucklingSel.root);
    if (params.postBucklingModel === 'effectiveWidth') {
      stripSec.body.append(num('postBucklingStiffness', '座屈後の剛性 有効幅の係数 k', '', 0, 2, 0.05, 1, '既定は 1。0 で座屈限界の頭打ち（超過した伸びは全部波）。1 で両縁を支えた板の有効幅（座屈直後の傾きが E′ の 1/2）。両縁支持の値なので、片側が自由縁の板端の帯では余力を多めに見ている可能性がある（1 より小さいはずだが、どこまでかは未確認）。4Hi・301 点・局所扁平・前後の平均の張力で潜在形状 1481 → k 0.5: 918、1: 774 I-unit。'));
    } else {
      stripSec.body.append(num('postBucklingStiffness', '座屈後の剛性比 β', '', 0, 1, 0.01, 1, '0 で座屈限界の頭打ち（超過した伸びは全部波）。1 で座屈しない板と同じ。目安 0.01〜0.1（有効幅の式 ½√(σcr/σ) からの概算。片側が自由縁の板端ではさらに小さいはずで、実測との照合はしていない）。4Hi・301 点・局所扁平・前後の平均の張力で潜在形状 1481 → β 0.02: 972、0.05: 681、0.1: 478 I-unit、壁（座屈域の立ち上がり）1375 → 883 / 590 / 383。'));
    }
    left.append(stripSec.root);

    // roll geometry
    const geoSec = section('ロール寸法', { remember: false, open: false });
    geoSec.body.append(num('wrD', 'WR 直径', 'mm', 30, 900, 5, 1e-3));
    geoSec.body.append(num('wrLb', 'WR 胴長', 'mm', 500, 2500, 10, 1e-3));
    geoSec.body.append(num('wrLs', 'WR 支持スパン', 'mm', 600, 3000, 10, 1e-3, SPAN_HINT));
    geoSec.body.append(num('wrDn', 'WR ネック径', 'mm', 20, 700, 5, 1e-3, NECK_HINT));
    geoSec.body.append(num('Eroll', 'ロール ヤング率', 'GPa', 100, 300, 1, 1e9));
    left.append(geoSec.root);

    // numerics / display
    const numSec = section('解析・表示', { remember: false, open: false });
    numSec.body.append(num('stations', '幅方向 分割数', '', 21, 601, 1, 1, '全ロール共通の節点数（等間隔、偶数は 1 足して奇数にする。「板・圧延条件 ▸ 材料 幅方向 分割数」が 0 なら板上の点数もこれで決まる）。計算時間は点数より速く伸びる: 81 → 301 点で 1 反復あたり 7〜9 倍（張力の連成が板上の点数で効く）。'));
    numSec.body.append(select<'hertz' | 'ring'>('扁平モデル', [
      { value: 'hertz', text: 'Hertz 式（Johnson の円筒近似）' },
      { value: 'ring', text: '断面 FEM（リングメッシュ nt × nr）' },
    ], params.flatModel, (v) => { params.flatModel = v; apply(); buildLeft(); },
    'ロールが接触で扁平する量の求め方。Hertz 式は半無限体の閉形式、断面 FEM は剛体ハブと胴の間の平面ひずみリングを Q4 要素で解いた影響関数（2D タブと同じ要素）。').root);
    numSec.body.append(toggle('扁平の幅方向の広がり（非局所）', params.flatNonlocal, (v) => { params.flatNonlocal = v; apply(); },
      'ON: WR と板の扁平を、そのスライスの荷重だけでなく隣のスライスの荷重によるへこみも足して求める。半無限体の表面変位（Boussinesq、Johnson "Contact Mechanics" §3.2。板プロフィルの理論の戸澤・上田 1970 と同じ積分）をロール軸方向に重ね、一様な荷重では上の扁平モデルの値に戻るように |s| = 0.446 R で打ち切る。'
      + '板の外の胴は荷重を受けないので、板端から約 0.45 R の範囲で扁平が小さくなり、エッジドロップと板端の伸びが増える（4Hi・301 点・前後の平均の張力・座屈限界の頭打ちで、エッジドロップ 40 → 94 µm、C25 54 → 86 µm、潜在形状 1481 → 2847 I-unit。板の中央部は変わらない）。'
      + 'ON が既定。OFF: 各スライスが自分の荷重だけで扁平する。ON では外側の反復が 3〜5 割増える。').root);
    {
      if (fistrOn) buildFistrRows();
      const fs = select<'off' | 'on'>('ロールの照合', [
        { value: 'off', text: 'なし' },
        { value: 'on', text: 'FrontISTR（ソリッド要素）' },
      ], fistrOn ? 'on' : 'off', (v) => setFistr(v === 'on'),
      '収束のたびに、同じ板の荷重を上半分の WR（ソリッド要素）に載せて FrontISTR で解き、撓み・扁平をグラフに白の破線で重ね、右の「FrontISTR 照合」に並べる。'
        + 'npm run dev の橋渡し（tools/frontistr/bridge.mjs）と手元の fistr1 が要る。1 回 約 10 秒。');
      fs.root.dataset.key = 'fistr';
      numSec.body.append(fs.root);
    }
    if (params.flatModel === 'ring') {
      numSec.body.append(num('ringNt', 'ロール 周方向 分割 nt', '', 32, 1600, 16, 1, '断面リングの周方向分割。既定 800 × 半径方向 12。接触半幅（数 mm）を数節点で解像するには 400 以上。'));
      numSec.body.append(num('ringNr', 'ロール 半径方向 分割 nr', '', 2, 24, 1, 1));
      numSec.body.append(num('ringGrade', '半径方向グレーディング', '', 1, 5, 0.1, 1, '1 で等間隔、大きいほど胴表面に要素を寄せる。'));
      numSec.body.append(num('ringHub', '剛体ハブ半径 / R', '', 0.05, 0.85, 0.05, 1, 'ロール本体のうち軸として扱う部分。バッキングベアリングは軸径で決まる。'));
    }
    numSec.body.append(slider({ label: '撓み表示倍率', min: 10, max: 2000, step: 10, log: true, value: magnify, onInput: (v) => { magnify = v; dirty = true; } }).root);
    numSec.body.append(slider({ label: '断面変形 表示倍率', min: 10, max: 5000, step: 10, log: true, value: sectionMagnify, onInput: (v) => { sectionMagnify = v; dirty = true; } }).root);
    left.append(numSec.root);

    syncModeDials();
    syncBounds();
  };

  const syncModeDials = () => {
    const on = (key: string, yes: boolean) => {
      const rootEl = left.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
      if (rootEl) rootEl.classList.toggle('disabled', !yes);
    };
    on('reduction', params.mode === 'gauge');
    on('targetForce', params.mode === 'force');
    on('screw', params.mode === 'screw');
    // the housing frame's dimensions only mean something with the mode on, and
    // with it on the screw roll no longer sits on the per-support stiffness
    const housingOn = housingInScope(params);
    for (const k of ['housingPostArea', 'housingPostCount', 'housingPostLength', 'housingPostWidth', 'housingCrossSpan', 'housingCrossI', 'housingCrossShearArea', 'housingE']) on(k, params.housingMode);
    // the load formula's tension only acts with the tension feedback on
    on('slabTension', params.tensionFeedback);
    // without the feedback no slice buckles (the tension is the set one everywhere)
    on('postBucklingModel', params.tensionFeedback);
    on('postBucklingStiffness', params.tensionFeedback);
    on('housingK', !housingOn);
  };

  buildLeft();

  /* ── drawing ── */
  /** the screw position the greyed dial last showed [m] */
  let screwShown = NaN;
  const drawAll = () => {
    const R = solver.result;
    const st = solver.stack;
    const halfWidth = -R.x[0];
    const strip = params.width / 2;
    if (frontMode === '3d' && stack3d) {
      const um = (v: number) => `${(v * 1e6).toFixed(0)} µm`;
      const mpa = (v: number) => `${(v / 1e6).toFixed(0)} MPa`;
      stack3d.draw(R, st, {
        magnify, width: params.width, mirror: false, colorBy, backTension: params.backTension,
        labels: R.rolls.map((r) => colorBy === 'stress'
          ? `${r.def.id}\n曲げ σ ${mpa(r.bendMax)} 面圧 p₀ ${mpa(r.hertzMax)}`
          : `${r.def.id}\n撓み ${um(r.bow)} 扁平 ${um(r.flatMax)}`),
      });
      // the colour bars: rebuilt only when their text changes
      const sig = stack3d.bars.map((b) => `${b.title}|${b.gradient}|${b.lo}|${b.mid}|${b.hi}|${b.unit}`).join('\u0001');
      if (legendBox.dataset.sig !== sig) {
        legendBox.dataset.sig = sig;
        legendBox.replaceChildren(...stack3d.bars.map((b) => {
          const row = el('div', 'v3-bar');
          const title = el('span', 'v3-bar-title', b.title);
          const bar = el('span', 'v3-bar-ramp');
          bar.style.background = `linear-gradient(90deg, ${b.gradient})`;
          const ticks = el('span', 'v3-bar-ticks');
          ticks.append(el('span', '', b.lo), el('span', '', b.mid), el('span', '', b.hi));
          const unit = el('span', 'v3-bar-unit', b.unit);
          row.append(title, bar, ticks, unit);
          return row;
        }));
      }
    } else frontView.draw(R, st, { magnify, width: params.width });
    endView.draw(R, st, params.width, TONF);
    // the frame follows the mode, not the result, so the view keeps its height through a change
    sideCanvas.classList.toggle('with-housing', housingInScope(params));
    sideView.draw(st, params, R.housing, stale && !running);

    const um = (a: Float64Array) => Float64Array.from(a, (v) => v * 1e6);
    // A FrontISTR answer's stations: the x ≥ 0 half on a symmetric case, mirrored to draw
    // with the whole roll; the whole length on a 6Hi. `scale` takes the values to the chart's unit.
    const FISTR_COLOR = '#ffffff';
    const fistrXY = (f: FistrResult, x: number[], y: (number | null)[], scale: number): { x: Float64Array; y: Float64Array } => {
      const n = x.length, v = (i: number) => (y[i] === null || y[i] === undefined ? NaN : (y[i] as number) * scale);
      if (f.full) return { x: Float64Array.from(x), y: Float64Array.from(x, (_, i) => v(i)) };
      const xs = new Float64Array(2 * n - 1), ys = new Float64Array(2 * n - 1);
      for (let i = 0; i < n; i++) { xs[n - 1 - i] = -x[i]; xs[n - 1 + i] = x[i]; ys[n - 1 - i] = ys[n - 1 + i] = v(i); }
      return { x: xs, y: ys };
    };
    const deflSeries = R.rolls.map((r, i): XYSeries => ({
      label: r.def.id, color: ROLL_COLORS[i % ROLL_COLORS.length], x: R.x, y: um(r.v),
    }));
    if (fistrShown) {
      // The solids' axes are read against the held bearing (the screw roll's); the model's `v`
      // is absolute (the supports sit where the screw and the housing put them). Set on the
      // model's screw-roll bearings, so the curves lie on each other and the difference
      // between them is the check.
      const screwRoll = R.rolls.find((r) => r.def.support === 'screw') ?? R.rolls[st.wr];
      const sups = screwRoll.supports.filter((s) => Number.isFinite(screwRoll.v[s]));
      const onBearing = sups.length ? sups.reduce((a, s) => a + screwRoll.v[s], 0) / sups.length : 0;
      for (const r of fistrShown.rolls) {
        deflSeries.push({ label: `${r.id} FrontISTR`, color: FISTR_COLOR, dash: true, width: 2, ...fistrXY(fistrShown, r.x, r.vFem.map((v) => v + onBearing), 1e6) });
      }
    }
    charts.defl.draw(deflSeries, { unit: 'µm', halfWidth, strip, zero: true });

    const contactLabel = (c: { a: number; b: number }) => `${st.rolls[c.a].id}–${st.rolls[c.b].id}`;
    // an open gap is no flattening: zero where the contact carries no load,
    // and nothing at all where the barrels do not overlap
    const closed = (c: { delta: Float64Array; weight: Float64Array }) =>
      Float64Array.from(c.delta, (d, i) => (c.weight[i] > 0 ? Math.max(d, 0) * 1e6 : NaN));
    const flatSeries: XYSeries[] = [
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: um(R.flat) },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: closed(c) })),
    ];
    if (fistrShown?.flat) {
      // the solid's indentation where the strip loads it; off the strip the model shows nothing either
      const fl = fistrShown.flat;
      const on = fl.fem.map((v, i) => ((fistrShown!.q[i] ?? 0) > 0 ? v : null));
      flatSeries.push({ label: 'WR–板 FrontISTR', color: FISTR_COLOR, dash: true, width: 2, ...fistrXY(fistrShown, fistrShown.x, on, 1e6) });
    }
    charts.flat.draw(flatSeries, { unit: 'µm', halfWidth, strip, zero: true });

    const kn = (a: Float64Array) => Float64Array.from(a, (v) => v / 1e6);
    const onBarrels = (c: { q: Float64Array; weight: Float64Array }) =>
      Float64Array.from(c.q, (q, i) => (c.weight[i] > 0 ? q / 1e6 : NaN));
    const loadSeries: XYSeries[] = [
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: kn(R.q), fill: true },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: onBarrels(c) })),
    ];
    if (fistrShown) {
      for (const k of fistrShown.contacts) {
        loadSeries.push({ label: `${k.label} FrontISTR`, color: FISTR_COLOR, dash: true, width: 2, ...fistrXY(fistrShown, k.x, k.qFem, 1e-6) });
      }
    }
    charts.load.draw(loadSeries, { unit: 'kN/mm', halfWidth, strip, zero: true });

    // Entry and exit, each against its own thickness at the strip centre: the two
    // shapes on one scale, the entry crown the pass was given and the exit profile
    // it produced, and an edge reads as its crown with the sign turned.
    const centreOf = (a: Float64Array) => {
      for (let i = 1; i < a.length; i++) {
        const x0 = R.x[i - 1], x1 = R.x[i];
        if (x0 <= 0 && x1 >= 0 && Number.isFinite(a[i - 1]) && Number.isFinite(a[i])) {
          return a[i - 1] + (a[i] - a[i - 1]) * (-x0 / (x1 - x0));
        }
      }
      return NaN;
    };
    const h0c = centreOf(R.h0), h1c = centreOf(R.h1);
    const gaugeSeries: XYSeries[] = [
      { label: '入側 h₀', color: '#7fb2ff', x: R.x, y: Float64Array.from(R.h0, (v) => (v - h0c) * 1e6), dash: true, width: 2 },
      { label: '出側 h₁', color: STRIP_COLOR, x: R.x, y: Float64Array.from(R.h1, (v) => (v - h1c) * 1e6), width: 2 },
    ];
    if (fistrShown?.exit && fistrShown.contacts.length) {
      // the exit gauge the solid's surface would give, against its centre (Δh₁ = 2 × Δh₁/2), on the strip
      const ex = fistrShown.exit;
      const on = ex.fem.map((v, i) => (ex.model[i] === null ? null : v));
      gaugeSeries.push({ label: '出側 h₁ FrontISTR', color: FISTR_COLOR, dash: true, width: 2, ...fistrXY(fistrShown, fistrShown.x, on, 2e6) });
    }
    charts.gauge.draw(gaugeSeries, { unit: 'µm', halfWidth: strip * 1.05, strip, zero: true });
    // The same profiles over their centre thickness, the crown ratio. Where the exit's
    // follows the entry's the pass kept the shape; before lateral flow, entry minus
    // exit is the elongation relative to the centre (1 % = 1000 I-units).
    const r0 = Float64Array.from(R.h0, (v) => ((v - h0c) / h0c) * 100), r1 = Float64Array.from(R.h1, (v) => ((v - h1c) / h1c) * 100);
    charts.crown.draw([
      { label: '入側 h₀', color: '#7fb2ff', x: R.x, y: r0, dash: true, width: 2 },
      { label: '出側 h₁', color: STRIP_COLOR, x: R.x, y: r1, width: 2 },
    ], { unit: '%', halfWidth: strip * 1.05, strip, zero: true });
    // How far the pass moved the crown ratio, entry less exit: zero where the shape was
    // kept, positive where the edge was rolled thinner relative to the centre than it
    // came in - there the edge is the longer fibre (edge waves), negative the centre.
    // Before lateral flow it is the elongation relative to the centre (1 % = 1000 I-units).
    charts.crownChange.draw([
      { label: '入側 − 出側', color: '#ff8fa8', x: R.x, y: Float64Array.from(r0, (v, i) => v - r1[i]), width: 2, fill: true },
    ], { unit: '%', halfWidth: strip * 1.05, strip, zero: true });

    // Each curve shifted so its smallest value across the strip reads zero:
    // the shortest fibre is the reference, as a flatness profile is quoted,
    // and every other position is how much longer it is. (The solver keeps
    // the elongation relative to the width mean; the shift is display only.)
    const iuFromMin = (a: Float64Array) => {
      let m = Infinity;
      for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && a[i] < m) m = a[i];
      if (!Number.isFinite(m)) m = 0;
      return Float64Array.from(a, (v) => (v - m) * 1e5);
    };
    charts.eps.draw([
      { label: '潜在 Δε', color: '#7fe4ff', x: R.profile.x, y: iuFromMin(R.profile.latent) },
      { label: '顕在（波）', color: '#ff6b81', x: R.profile.x, y: iuFromMin(R.profile.wave), fill: true },
    ], { unit: 'I-unit', halfWidth: strip * 1.05, strip, zero: true, symmetric: false });

    charts.sig.draw([
      { label: 'σf', color: '#96e6b4', x: R.x, y: Float64Array.from(R.sigmaF, (v) => v / 1e6), width: 2 },
    ], {
      unit: 'MPa', halfWidth: strip * 1.05, strip, zero: true,
      marks: [{ y: params.frontTension / 1e6, label: '設定平均', color: '#8ea0bd' }],
    });

    {
      const f = R.fem;
      // the FEM's own grid: a column per slice, its node columns on the slices' edges
      if (f) {
        charts.press.draw(f.p, f.ncol, f.nrow, f.xNode, f.arcNode, { unit: 'MPa', scale: 1e-6, halfWidth: strip * 1.05 });
        charts.flow.draw(f.ux, f.ncol, f.nrow, f.xNode, f.arcNode, { unit: '%', scale: 100, halfWidth: strip * 1.05, symmetric: true });
      } else {
        // no field to draw: the slab model has none; a FEM has none until a solve has run its first correction round
        const note = params.stripModel === 'slab' ? '材料モデルが平面 FEM／3 次元 FEM のときに表示' : '「計算開始」で解くと表示';
        charts.press.draw(null, 0, 0, R.x, R.arc, { unit: 'MPa', scale: 1, halfWidth: strip, note });
        charts.flow.draw(null, 0, 0, R.x, R.arc, { unit: '%', scale: 1, halfWidth: strip, note });
      }
    }

    // stats: the result rows read "—" until the first iteration on this mesh (the empty result's
    // zeros - a 0 tonf load, h₁ = h₀, a green flatness of 0 - are not a result); the rows the
    // settings alone decide are shown from them at once
    const none = R.iterations === 0;
    const dash = (text: string) => (none ? '—' : text);
    stats.set('force', dash((R.force / TONF).toFixed(1)));
    stats.set('screw', params.mode === 'screw' ? (params.screw * 1e3).toFixed(3) : dash((R.screw * 1e3).toFixed(3)));
    // the greyed screw dial reads the position the solve is at, so a switch to the manual
    // mode starts from it (only rewritten when it moved: a DOM write a frame is not free)
    if (params.mode !== 'screw' && Number.isFinite(R.screw) && !(Math.abs(R.screw - screwShown) <= 1e-9)) {
      screwShown = R.screw;
      dials.get('screw')?.set(R.screw);
    }
    stats.set('relief', params.tensionFeedback ? dash((R.yieldRelief * 100).toFixed(1)) : 'OFF', undefined, params.tensionFeedback);
    stats.set('h1', dash(`${(R.h1Mean * 1e3).toFixed(4)} / ${(R.h1Centre * 1e3).toFixed(4)}`));
    {
      // the reduction the pass actually made: at the centre, h₁ centre against h₀ centre; across the
      // width, the means of both. The dial's r sets h₁ mean = (1 − r)·h₀ centre, so with an entry
      // crown the mean reduction reads a little under the dial (30 µm on a 0.1 mm foil: 11 % for 20 %)
      const entry = solver.entryReadings();
      const centre = 1 - R.h1Centre / entry.h0Centre, mean = 1 - R.h1Mean / entry.h0Mean;
      stats.set('reduction', dash(`${(centre * 100).toFixed(1)} / ${(mean * 100).toFixed(1)}`));
    }
    stats.set('crown', dash((R.crown * 1e6).toFixed(1)));
    stats.set('wedge', dash((R.wedge * 1e6).toFixed(1)));
    stats.set('edge', dash(`${(R.edgeDropL * 1e6).toFixed(1)} / ${(R.edgeDropR * 1e6).toFixed(1)}`));
    {
      // the entry profile is a setting: read from it now, not from the last solve
      const entry = solver.entryReadings();
      stats.set('shape0', `${(entry.crown0 * 1e6).toFixed(1)} / ${(entry.edgeDrop0 * 1e6).toFixed(1)}`);
    }
    stats.set('latent', dash(R.latentIU.toFixed(0)), none ? undefined : R.latentIU < 40 ? 'ok' : R.latentIU < 100 ? 'warn' : 'bad');
    stats.set('manifest', dash(R.manifestIU.toFixed(0)), none ? undefined : R.manifestIU < 5 ? 'ok' : R.manifestIU < 40 ? 'warn' : 'bad');
    stats.set('conv', running ? '反復中' : !stale ? '収束' : iterated ? '停止' : '未計算', running ? 'warn' : !stale ? 'ok' : undefined);
    // both from the result on show: after a change that keeps the mesh it is the last solve's, faded
    stats.set('iter', dash(`${R.solveIterations} / ${Number.isFinite(R.residual) ? R.residual.toExponential(1) : '—'}`));
    stats.set('ms', dash(R.solveMs.toFixed(1)));
    stats.set('dof', `${R.dof} / ${R.bandwidth}`);
    stats.set('grid', `${solver.slices.length}（${(solver.grid.dxStrip * 1e3).toFixed(1)} mm）/ ${R.x.length}`);
    {
      const ring = solver.ringFor(st.rolls[st.wr]);
      const rollText = `幅 ${solver.ns}${ring ? ` ／ 断面 ${2 * (ring.cols - 1)} × ${ring.rows - 1}` : ''}`;
      const stripText = `幅 ${solver.slices.length}（${(solver.grid.dxStrip * 1e3).toFixed(1)} mm）`
        + (params.stripModel === 'slab' ? '' : ` × 圧延 ${Math.round(params.stripNz)}`)
        + (params.stripModel === 'fem3d' ? ` × 板厚 ${Math.round(params.stripNy)}` : '');
      if (gridRoll.textContent !== rollText || gridStrip.textContent !== stripText) {
        gridRoll.textContent = rollText; gridStrip.textContent = stripText;
        // the same counts for the top bar's mesh readout, shorter
        opts.onMesh?.(`ロール ${solver.ns} ／ 材料 ${solver.slices.length}${params.stripModel === 'slab' ? '' : `×${Math.round(params.stripNz)}`}${params.stripModel === 'fem3d' ? `×${Math.round(params.stripNy)}` : ''}`,
          `3D: ロール ${rollText}（幅方向の節点${ring ? '、断面リングの周方向 × 半径方向' : ''}）／ 材料 ${stripText}`);
      }
    }
    // the prefix says which FEM the result came from, not which one is now selected
    stats.set('fem', R.fem ? `${R.fem.model === 'fem3d' ? '3D ' : ''}${R.fem.iterations} / ${R.fem.massRatio.toFixed(4)}` : params.stripModel === 'slab' ? '—（スラブ法）' : '—', R.fem && !R.fem.converged ? 'warn' : undefined);
    {
      const wr = st.rolls[st.wr];
      const inf = solver.ringFor(wr);
      const mid = solver.slices[Math.floor(solver.slices.length / 2)];
      const qc = mid?.q ?? 0;
      const b = Math.max(Math.sqrt(solver.wsLaw.bCoef * Math.max(qc, 1)), (mid?.arc ?? 0) / 2);
      // at the middle slice's load, which there is none of before a solve
      if (inf && !none) {
        const johnson = ((1 - wr.nu * wr.nu) / (Math.PI * wr.E)) * (2 * Math.log((4 * wr.D) / (2 * b)) - 1);
        stats.set('flatCmp', `${(ringCompliance(inf, b) / johnson).toFixed(3)} (b = ${(b * 1e3).toFixed(1)} mm)`);
      } else stats.set('flatCmp', '—');
      sectionView.draw(inf, qc, sectionMagnify, `WR ／ 板中央 q = ${(qc / 1e6).toFixed(2)} kN/mm`);
    }

    // housing
    if (R.housing) {
      const h = R.housing;
      if (!housingSec.root.isConnected) right.insertBefore(housingSec.root, contactSec.root);
      const pair = (f: (s: (typeof h.sides)[number]) => number, scale: number, digits: number) => h.sides.map((sd) => (f(sd) * scale).toFixed(digits)).join(' / ');
      housingStats.set('hLoad', pair((sd) => sd.force, 1 / TONF, 1));
      housingStats.set('hStretch', pair((sd) => sd.stretch, 1e6, 1));
      housingStats.set('hPost', pair((sd) => sd.post, 1e6, 1));
      housingStats.set('hTop', pair((sd) => sd.crossheadTop, 1e6, 1));
      housingStats.set('hBottom', pair((sd) => sd.crossheadBottom, 1e6, 1));
      housingStats.set('hTilt', (h.burTilt * 1e6).toFixed(1));
      housingStats.set('hModulus', (h.millModulus / 1e9).toFixed(2));
    } else if (housingSec.root.isConnected) {
      housingSec.root.remove();
    }

    // chips: nothing to show before the first iteration on this mesh, faded while not the current solution
    setChip(chips.mill, MILL_LABEL[params.mill]);
    setChip(chips.force, none ? '—' : (R.force / TONF).toFixed(0));
    setChip(chips.h1, none ? '—' : (R.h1Mean * 1e3).toFixed(3));
    setChip(chips.crown, none ? '—' : (R.crown * 1e6).toFixed(0));
    setChip(chips.manifest, none ? '—' : R.manifestIU.toFixed(0), none ? undefined : R.manifestIU < 5 ? 'ok' : R.manifestIU < 40 ? 'warn' : 'bad');
    setChip(chips.conv, running ? `反復中 ${etaText(eta)}` : !stale ? '収束' : iterated ? '停止' : '未計算', running ? 'warn' : !stale ? 'ok' : undefined);
    chips.conv.classList.toggle('busy', running);
    {
      const label = running ? '■ 停止' : !stale ? '✓ 計算済み' : iterated ? '▶ 計算再開' : '▶ 計算開始';
      if (runBtn.textContent !== label) runBtn.textContent = label;
      runBtn.disabled = !running && !stale;
      runBtn.classList.toggle('running', running);
      // results that are not this setting's solution are faded until a solve has run on it
      const faded = stale && !running;
      staleTag.hidden = !faded;
      const tagText = iterated ? '停止中: 今の条件を途中まで解いた変形と荷重（「計算再開」で続き）'
        : R.iterations === 0 ? '未計算: 条件どおりの形状を表示中（「計算開始」で解く）'
          : '未計算: 形状は今の条件、変形と荷重は前回の計算（「計算開始」で解く）';
      if (staleTag.textContent !== tagText) staleTag.textContent = tagText;
      for (const e of [chartGrid, loadSec.root, contactSec.root, housingSec.root]) e.classList.toggle('v3-stale', faded);
      // 板形状 and 解析 hold rows the settings decide as well: only the result rows fade
      for (const [key, row] of rowFade) row.classList.toggle('v3-stale', faded && !SETTING_ROWS.has(key));
    }
    {
      const res = Number.isFinite(R.residual) ? R.residual.toExponential(1) : '—';
      const fem = R.fem ? ` / 補正 ${solver.femLastChange.toExponential(1)}` : '';
      setChip(chips.res, none ? '—' : res + fem, none ? undefined : R.converged ? 'ok' : R.residual < 1e-3 ? 'warn' : 'bad');
    }
    setChip(chips.ms, none ? '—' : R.solveMs.toFixed(0));
    for (const c of [chips.force, chips.h1, chips.crown, chips.manifest, chips.res, chips.ms]) c.classList.toggle('v3-stale', stale && !running);
    if (fistrOn) {
      const f = fistrShown;
      const sec = ((performance.now() - fistrT0) / 1000).toFixed(0);
      const um1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : (v * 1e6).toFixed(1));
      const kn2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : (v / 1e6).toFixed(2));
      const signed = (v: number) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 1e6).toFixed(1)}`;
      const pct = (w: { rel: number }) => `${(w.rel * 100).toFixed(1)} %`;
      // at the strip centre: the station at x = 0 (the first on a half case)
      const centreOf = (x: number[]) => { let best = 0; for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) < Math.abs(x[best])) best = i; return best; };
      const state = fistrBusy ? `計算中 ${sec} s` : f ? '照合済み' : fistrNote ? fistrNote : stale || running ? '収束後に解く' : '—';
      const close = (w: { rel: number }) => w.rel < 0.05;
      const tone = fistrBusy ? 'warn' : f ? (f.rolls.every((r) => close(r.worst)) && f.contacts.every((k) => close(k.worst)) && (!f.flat || f.flat.worst.abs < 20e-6) ? 'ok' : 'warn') : fistrNote ? 'bad' : undefined;
      let chipText = fistrBusy ? `計算中 ${sec} s` : fistrNote ? '×' : '—';
      if (f && !fistrBusy) {
        const wr = f.rolls[0], i0 = centreOf(wr.x);
        chipText = `撓み ${signed(wr.vFem[i0] - (wr.vModel[i0] ?? 0))} µm（${pct(wr.worst)}）`;
        if (f.contacts.length) chipText += ` 接触 ${pct({ rel: Math.max(...f.contacts.map((k) => k.worst.rel)) })}`;
        if (f.flat) chipText += ` 扁平 ${signed(f.flat.fem[i0] - (f.flat.model[i0] ?? 0))} µm`;
      }
      setChip(chips.fistr, chipText, tone);
      chips.fistr.classList.toggle('busy', !!fistrBusy);
      chips.fistr.classList.toggle('v3-stale', !fistrBusy && !f);
      fistrStats.set('state', state, tone, false);
      if (f) {
        for (const r of f.rolls) { const i0 = centreOf(r.x); fistrStats.set(`v:${r.id}`, `${um1(r.vModel[i0])} / ${um1(r.vFem[i0])}`); }
        for (const k of f.contacts) { const i0 = centreOf(k.x); fistrStats.set(`q:${k.label}`, `${kn2(k.qModel[i0])} / ${kn2(k.qFem[i0])}`); }
        const i0 = centreOf(f.x);
        if (f.flat) fistrStats.set('flat', `${um1(f.flat.model[i0])} / ${um1(f.flat.fem[i0])}`);
        fistrStats.set('wv', f.rolls.map((r) => `${r.id} ${um1(r.worst.abs)}（${pct(r.worst)}）`).join('・'));
        if (f.contacts.length) fistrStats.set('wq', f.contacts.map((k) => `${k.label} ${kn2(k.worst.abs)}（${pct(k.worst)}）`).join('・'));
        if (f.flat) fistrStats.set('wflat', `${um1(f.flat.worst.abs)}`);
        if (f.exit && f.contacts.length) fistrStats.set('wexit', `${um1(f.exit.worst.abs)}`);
        // the reaction carries the load's sign turned; its size is what is checked against the strip load on the modelled part
        fistrStats.set('brg', `${(Math.abs(f.bearingReaction) / TONF).toFixed(1)} / ${(f.loadSumY / TONF).toFixed(1)}`);
        fistrStats.set('mesh', `${f.nodes.toLocaleString()}（${f.mesh.map((m) => `${m.name} ${m.stations}×${m.layers}×${m.angles}`).join('、')}）/ ${f.seconds.toFixed(0)} s`, undefined, false);
      } else {
        for (const key of ['wv', 'wq', 'wflat', 'wexit', 'flat', 'brg', 'mesh']) fistrStats.set(key, '—');
        for (const r of R.rolls) fistrStats.set(`v:${r.def.id}`, '—');
      }
      fistrSec.root.classList.toggle('v3-stale', !f && !fistrBusy);
    }
    {
      // Two kinds of warning. The settings' own (a strip wider than the barrel, the housing, the
      // layout, a floored entry profile, a tension near yield) come from the settings as they are
      // now - shown before a solve and gone as soon as the setting is put right. The solution's
      // come with the result and fade with it. A warning with numbers shows once, with them.
      const set = solver.settingsWarnings();
      const warns = [
        ...set.keys.map((w) => ({ text: set.details[w] ?? WARNING_TEXT[w], solved: false })),
        ...set.notes.map((text) => ({ text, solved: false })),
        ...R.warnings.filter((w: Warning3D) => !SETTINGS_WARNINGS.includes(w)).map((w: Warning3D) => ({ text: R.warningDetails[w] ?? WARNING_TEXT[w], solved: true })),
      ];
      const want = warns.map((w) => `${w.solved ? 1 : 0}${w.text}`).join('\u0001');
      if (warnBox.dataset.sig !== want) {
        warnBox.dataset.sig = want;
        warnBox.replaceChildren(...warns.map((w) => {
          const b = el('div', 'badge warn');
          b.innerHTML = `<b>⚠</b><span></span>`;
          b.querySelector('span')!.textContent = w.text;
          if (w.solved) b.dataset.solved = '';
          return b;
        }));
      }
      const fadedWarn = stale && !running;
      for (const b of warnBox.children) if ((b as HTMLElement).dataset.solved !== undefined) b.classList.toggle('v3-stale', fadedWarn);
    }

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
    R.contacts.forEach((c) => contactGrid.set(`c:${c.a}-${c.b}`, dash((c.total / TONF).toFixed(1))));
    R.rolls.forEach((r) => {
      if (r.def.support !== 'free') contactGrid.set(`r:${r.def.id}`, dash(r.reactions.map((v) => (v / TONF).toFixed(0)).join(' / ')));
    });
  };

  /* ── loop ── */
  let raf = 0;
  let idleFrames = 0;
  // The remaining-time estimate runs on its own clock, which only moves
  // while the solve does: from the end of the previous solving frame (the
  // page's drawing between frames is part of how long a solve takes), or
  // just this frame's solve after a pause or a hidden tab.
  const remaining = new RemainingTime();
  let eta: Eta = { kind: 'estimating' };
  let etaClock = 0;
  let lastSolveEnd = 0;
  const etaKey = () => `${params.stripModel}|${params.stripNz}|${params.stripNy}|${params.slabTension}|${solver.result.dof}|${solver.slices.length}`;
  /** messages already reported by `tick`, so a throw that repeats every frame is logged once */
  const tickErrors = new Set<string>();
  /**
   * The loop. Whatever one frame throws, the next one is still asked for, as on the 2D tab: a
   * throw from the drawing (a folded section's canvas gave the end view a negative radius) used
   * to skip the `requestAnimationFrame` at the end, and 計算開始 then did nothing at all.
   */
  const tick = () => {
    raf = 0;
    if (!active) return;
    try {
      tickBody();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!tickErrors.has(msg)) {
        tickErrors.add(msg);
        console.error('3D frame:', err);
      }
    } finally {
      // once settled, keep a slow heartbeat so a resize or theme change is picked up cheaply
      raf = requestAnimationFrame(tick);
    }
  };
  const tickBody = () => {
    let moved = false;
    if (running && !solver.isConverged) {
      const t0 = performance.now();
      moved = solver.advance(FRAME_BUDGET, 6);
      const t1 = performance.now();
      etaClock += lastSolveEnd > 0 && t0 - lastSolveEnd < ETA_GAP_MS ? t1 - lastSolveEnd : t1 - t0;
      lastSolveEnd = t1;
      eta = remaining.update(etaClock, solver.progress(), etaKey());
      iterated = true;
      // converged: the results are this setting's, and the solve waits for the next 計算開始
      if (solver.isConverged) { running = false; stale = false; dirty = true; maybeRunFistr(); }
    } else {
      lastSolveEnd = 0;
    }
    if (moved || dirty) {
      drawAll();
      dirty = false;
      idleFrames = 0;
    } else {
      idleFrames++;
    }
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

  // keyboard: Space starts or stops the solve, R starts over. A field that takes
  // typed text keeps its keys (Space and R are characters there). A button or a toggle
  // reached with Tab keeps them too - Space is how one presses or flips it from the keyboard - but
  // one the pointer clicked last only holds the focus Chrome leaves there: the keys are the view's,
  // with the browser's own action held back (Space used to flip a clicked toggle back instead of
  // starting the solve). The origin of the focus is tracked as on the 2D tab (`focusByPointer` in
  // src/main.ts): a pointer press sets it, Tab clears it, both in the capture phase.
  let focusByPointer = false;
  window.addEventListener('pointerdown', () => { focusByPointer = true; }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') focusByPointer = false; }, true);
  window.addEventListener('keydown', (e) => {
    if (!active || e.metaKey || e.ctrlKey || e.altKey || takesTyping(e.target)) return;
    if (!focusByPointer && pressable(e.target)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (running) stopSolve(); else startSolve();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      solver.reset();
      settingsChanged();
    }
  });
  void idleFrames;
  // a hook for headless checks, like the 2D tab's
  (window as unknown as { __v3: unknown }).__v3 = {
    solver, get params() { return params; }, get eta() { return eta; }, handle,
    // the 計算開始 button's actions and state, for checks that drive the page as a user would
    start: startSolve, stop: stopSolve, get running() { return running; }, get stale() { return stale; },
  };
  return handle;
}

/** the input types a key press does not type into: the view's keys still work with one of these focused */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** a control whose own key is Space: a button, a toggle, a radio */
function pressable(t: EventTarget | null): boolean {
  return t instanceof HTMLButtonElement || (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio'));
}

/** a field that takes typed text (a text or number box, a textarea, a select, an editable element) */
function takesTyping(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  return t instanceof HTMLElement && t.isContentEditable;
}

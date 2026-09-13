/**
 * The 3D tab: the roll-stack model of `sim3d`, its controls, and its
 * charts, living in `#view3d` beside the 2D tab's panels.
 *
 * Same conventions as the 2D tab: every input is a dial that takes effect at
 * once, the solve advances a little every frame so the picture is live, and
 * the charts are canvases that redraw while anything is moving and go quiet
 * once the solve has settled.
 */

import { StackSolver, WARNING_TEXT, type Warning3D } from '../sim3d/solver';
import {
  defaultParams, MILL_LABEL, ASU_RACKS, type MillType, type Params3D,
} from '../sim3d/stack';
import { el, section, slider, select, toggle, buttonRow, StatGrid, numField, helpMark } from '../ui/controls';
import { LineChart, FrontView, EndView, SectionView, HeatChart, ROLL_COLORS, STRIP_COLOR, type XYSeries } from './charts3d';
import { StackView3D } from './stack3d';
import { ringCompliance } from '../sim3d/ring';

const TONF = 9.80665e3;
const MILLS: MillType[] = ['2hi', '4hi', '6hi', '12hi', '20hi'];

/** ready-made setups, one click each; every one starts from its mill's defaults */
interface Preset3D { name: string; note: string; mill: MillType; patch: Partial<Params3D> }
const PRESETS: Preset3D[] = [
  {
    name: '冷間タンデム 4Hi', mill: '4hi',
    note: 'W 1000 ／ 2.0 mm → 25% ／ BUR クラウン 300 µm ／ WR ベンダー 60 tonf',
    patch: { width: 1.0, h0: 0.002, reduction: 0.25, burCrown: 300e-6, wrBender: 60 * TONF },
  },
  {
    name: '薄板 6Hi', mill: '6hi',
    note: '1.0 mm → 20% ／ IR 胴端 = 板端',
    patch: { h0: 0.001, reduction: 0.2, irShift: 0 },
  },
  {
    name: 'ステンレス 20Hi', mill: '20hi',
    note: '0.5 mm → 20% ／ 張力 100/120 MPa ／ テーパ −50 mm',
    patch: { h0: 0.0005, reduction: 0.2, backTension: 100e6, frontTension: 120e6, taperShift: -0.05 },
  },
  {
    name: '箔 20Hi', mill: '20hi',
    note: '0.1 mm → 20% ／ WR 径 40 mm',
    patch: { h0: 0.0001, reduction: 0.2, wrD: 0.04 },
  },
];
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

/**
 * The roll dimensions belong to a mill type, not to the pass: a 500 mm 4Hi
 * work roll cannot sit in a 20Hi cluster. Switching type swaps these and
 * nothing else, and each type remembers its own set - what the dials said
 * the last time it was the active type, its defaults the first time.
 */
const GEOMETRY_KEYS = [
  'wrD', 'wrLb', 'wrLs', 'wrDn', 'irD', 'irLb', 'irLs', 'irDn', 'ir2D', 'ir2Lb',
  'burD', 'burLb', 'burLs', 'burDn', 'bbD', 'bbShaft', 'bbLb', 'angle1',
] as const;
type GeometryKey = typeof GEOMETRY_KEYS[number];
const pickGeometry = (p: Params3D): Pick<Params3D, GeometryKey> =>
  Object.fromEntries(GEOMETRY_KEYS.map((k) => [k, p[k]])) as Pick<Params3D, GeometryKey>;

export function installView3D(root: HTMLElement, opts: { initialMill?: MillType } = {}): View3DHandle {
  let params: Params3D = defaultParams(opts.initialMill ?? '4hi');
  const solver = new StackSolver(params);
  let active = false;
  let running = true;
  let magnify = 200;
  let sectionMagnify = 200;
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

  const front = cell('v3-front', 'ロールスタック', '3D: ドラッグ=回転 ／ ホイール=ズーム ／ ダブルクリック=視点リセット ／ 上半分（モデル化した範囲） ／ 胴の色 = 接触線荷重 ／ 板は厚さ偏差を倍率表示');
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
  const cGauge = cell('v3-gauge', '板厚プロファイル', '出側 h₁（実線）と入側 h₀（破線）の平均からの偏差');
  const cEps = cell('v3-eps', '伸び率分布', '幅方向の伸び差 Δε（最も伸びの小さい位置を 0 とした値）／ 実線 = 潜在形状（張力で押さえ込まれる分を含む）／ 塗り = 顕在化（波）');
  const cSig = cell('v3-sig', '前方張力分布', '各スライスの張力 σf(x) ／ 破線 = 設定平均 ／ 下限 = 座屈、上限 = 降伏で頭打ち');
  const cPress = cell('v3-press', '噛み込み域の圧力 p(x, z)', '材料 FEM ／ 横 = 幅方向、縦 = 接触弧（上 = 入側、下 = 出側、弧長は列ごと）／ 摩擦丘が幅方向にどう変わるか');
  const cFlow = cell('v3-flow', '横流れ速度 u_x(x, z)', '材料 FEM ／ ロール周速比 [%] ／ 正 = +x 側へ（板端へ広がる流れ）');
  chartGrid.append(cDefl.root, cFlat.root, cLoad.root, cGauge.root, cEps.root, cSig.root, cPress.root, cFlow.root);

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
    res: chip('', '残差'), ms: chip('ms', '解法'),
  };
  chips.conv.innerHTML = '<i class="v3-dot"></i><b>—</b>';
  chips.res.title = '外側 Newton の相対残差（力の不釣り合い ÷ 最大の力、収束判定 2e-6）／ 材料 FEM のときはその補正の変化量（荷重比、収束判定 2e-3）';
  status.append(chips.mill, chips.force, chips.h1, chips.crown, chips.manifest, chips.conv, chips.res, chips.ms);
  const warnBox = el('div', 'v3-warnings');
  status.append(warnBox);
  const setChip = (c: HTMLElement, text: string, tone?: 'ok' | 'warn' | 'bad') => {
    const b = c.querySelector('b')!;
    if (b.textContent !== text) b.textContent = text;
    const want = tone ? `badge ${tone}` : 'badge';
    if (c.className !== want) c.className = want;
  };
  const hint = el('div', 'v3-hint', 'Space=一時停止 ／ R=再初期化 ／ 1–5=ミル形式（2Hi 4Hi 6Hi 12Hi 20Hi）／ チャート上にポインタで数値読み取り');
  centre.append(status, front.root, chartGrid, hint);

  const frontView = new FrontView(front.canvas);
  const charts = {
    defl: new LineChart(cDefl.canvas), flat: new LineChart(cFlat.canvas), load: new LineChart(cLoad.canvas),
    gauge: new LineChart(cGauge.canvas), eps: new LineChart(cEps.canvas), sig: new LineChart(cSig.canvas),
    press: new HeatChart(cPress.canvas), flow: new HeatChart(cFlow.canvas),
  };

  /* ── right panel: results ── */
  // One grid, three sections: the same `set` calls land wherever the row
  // lives, so the split is a matter of which body each row is appended to.
  const stats = new StatGrid();
  const loadSec = section('荷重・圧下', { open: true });
  const shapeSec = section('板形状', { open: true });
  const numSec2 = section('解析', { open: false, hint: '外側 Newton の反復回数と相対残差、1 フレームの解法時間、全体剛性の自由度と半バンド幅。' });
  const grid = (sec: { body: HTMLElement }) => { const g = el('div', 'stat-grid'); sec.body.append(g); return g; };
  const gLoad = grid(loadSec), gShape = grid(shapeSec), gNum = grid(numSec2);
  const into = (g: HTMLElement, key: string, label: string, unit?: string) => {
    stats.add(key, label, unit);
    g.append(stats.root.lastElementChild!);
  };
  into(gLoad, 'force', '圧延荷重', 'tonf'); into(gLoad, 'screw', '圧下位置 S', 'mm'); into(gLoad, 'h1', '出側板厚 平均 / 中央', 'mm');
  into(gLoad, 'relief', '張力による降伏緩和 σ̄t/k̄f', '%');
  into(gShape, 'crown', 'クラウン C25', 'µm'); into(gShape, 'wedge', 'ウェッジ', 'µm'); into(gShape, 'edge', 'エッジドロップ L / R', 'µm');
  into(gShape, 'latent', '潜在形状 (p-p)', 'I-unit'); into(gShape, 'manifest', '顕在形状 (最大)', 'I-unit');
  into(gNum, 'conv', '収束'); into(gNum, 'fem', '材料 FEM 反復 / 質量収支'); into(gNum, 'iter', '反復 / 残差'); into(gNum, 'ms', '解法時間', 'ms/frame'); into(gNum, 'dof', '自由度 / 半バンド幅');
  const contactSec = section('接触力・支持反力', { open: true });
  let contactGrid = new StatGrid();
  contactSec.body.append(contactGrid.root);
  const endSec = section('端面図（クラスタ配置）', { open: true });
  const endCanvas = el('canvas');
  endCanvas.id = 'v3-end';
  endSec.body.append(endCanvas);
  const endView = new EndView(endCanvas);
  const secSec = section('ワークロール断面（扁平メッシュ）', {
    open: true,
    hint: '扁平モデルが「断面 FEM」のときのロール断面リング。板中央の接触線荷重による変形を倍率表示。刻み数は「解析・表示」で。',
  });
  const secCanvas = el('canvas');
  secCanvas.id = 'v3-section';
  secSec.body.append(secCanvas);
  const sectionView = new SectionView(secCanvas);
  into(gNum, 'flatCmp', '扁平コンプライアンス 断面FEM / Hertz');
  right.append(loadSec.root, shapeSec.root, endSec.root, contactSec.root, secSec.root, numSec2.root);

  /* ── left panel: inputs ── */
  const dials = new Map<string, Dial>();
  let contactKeys: string[] = [];

  /** a neck (or a backing shaft) never wider than its barrel: whichever dial moved, the other follows */
  const NECKS: [keyof Params3D, keyof Params3D][] = [['wrDn', 'wrD'], ['irDn', 'irD'], ['burDn', 'burD'], ['bbShaft', 'bbD']];
  const clampNecks = () => {
    const pr = params as unknown as Record<string, number>;
    for (const [dn, d] of NECKS) {
      if (pr[dn as string] <= pr[d as string]) continue;
      pr[dn as string] = pr[d as string];
      dials.get(dn as string)?.set(pr[dn as string]);
    }
  };
  const apply = () => {
    clampNecks();
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

  const geometryByMill = new Map<MillType, Pick<Params3D, GeometryKey>>();
  /** a preset sets everything, by design - but the type it leaves keeps its remembered dimensions */
  const applyPreset = (pr: Preset3D) => {
    geometryByMill.set(params.mill, pickGeometry(params));
    params = { ...defaultParams(pr.mill), ...pr.patch, asu: [...(pr.patch.asu ?? defaultParams(pr.mill).asu)], asu2: [...(pr.patch.asu2 ?? defaultParams(pr.mill).asu2)] };
    solver.setParams(params); dirty = true; running = true; buildLeft();
  };
  /** a new mill type with every other setting kept: only the roll dimensions change */
  const switchMill = (m: MillType) => {
    if (m === params.mill) return;
    geometryByMill.set(params.mill, pickGeometry(params));
    const geometry = geometryByMill.get(m) ?? pickGeometry(defaultParams(m));
    params = { ...params, ...geometry, mill: m, asu: [...params.asu], asu2: [...params.asu2] };
    apply();
    buildLeft();
  };

  const buildLeft = () => {
    left.replaceChildren();
    // presets
    const preSec = section('プリセット', { remember: false, open: false, hint: 'よくある設定をひとまとめに。形式の既定値の上に条件を載せる。' });
    preSec.body.append(buttonRow(PRESETS.map((pr) => ({ text: pr.name, title: pr.note, onClick: () => applyPreset(pr) }))));
    left.append(preSec.root);
    // mill type
    const millSec = section('ミル形式', { remember: false, open: false, hint: '上半分のみをモデル化（パスラインについて対称）。形式を変えても板・圧延条件、制御、アクチュエータ、ロールプロファイル、解析の設定はそのまま。変わるのはロール寸法だけで、形式ごとに記憶される（初めて選ぶ形式は既定寸法）。その形式の典型条件にしたいときはプリセット。' });
    const millRow = buttonRow(MILLS.map((m) => ({ text: MILL_LABEL[m], onClick: () => switchMill(m) })));
    [...millRow.children].forEach((b, i) => b.classList.toggle('active', MILLS[i] === params.mill));
    millSec.body.append(millRow);
    millSec.body.append(el('div', 'ctrl-hint', millNote(params.mill)));
    left.append(millSec.root);

    // control
    const ctlSec = section('制御・目標', { remember: false, open: false });
    ctlSec.body.append(select<'gauge' | 'force' | 'screw'>('制御モード', [
      { value: 'gauge', text: '出側板厚（圧下率）一定' }, { value: 'force', text: '圧延荷重一定' }, { value: 'screw', text: '圧下位置 手動' },
    ], params.mode, (v) => { params.mode = v; apply(); syncModeDials(); }, 'スクリュー位置は目標に合うようフレームごとに割線法で追い込む。').root);
    ctlSec.body.append(num('reduction', '圧下率', '%', 2, 60, 0.5, 0.01));
    ctlSec.body.append(num('targetForce', '目標荷重', 'tonf', 20, 4000, 10, TONF));
    ctlSec.body.append(num('screw', '圧下位置 S', 'mm', -2, 8, 0.005, 1e-3, '無負荷でロールが板に触れる位置を 0 とした締め込み量。負は開き（クラウンや AS-U でスタックが予圧されていると必要になる）。'));
    ctlSec.body.append(num('leveling', 'レベリング ΔS', 'µm', -300, 300, 5, 1e-6, '駆動側と作業側のスクリュー差。正で +x 側が締まる。'));
    ctlSec.body.append(num('housingK', 'ハウジング剛性', 'MN/mm', 1, 30, 0.5, 1e9, '支持点（チョックまたはサドル）1 点あたりの剛性。ロールの曲げ・扁平はモデルが計算するので、ここはハウジングとチョックだけ。'));
    left.append(ctlSec.root);

    // actuators
    const actSec = section('アクチュエータ', { remember: false, open: false });
    if (params.mill === '4hi' || params.mill === '6hi') {
      actSec.body.append(num('wrBender', 'WR ベンダー', 'tonf/chock', -60, 200, 2, TONF, 'チョック 1 個あたりの力 [tonf/チョック]。正で上 WR のチョックを持ち上げる（インクリーズベンド）。等価的にロールクラウンを増やす。'));
    }
    if (params.mill === '6hi') {
      actSec.body.append(num('irBender', 'IR ベンダー', 'tonf/chock', 0, 200, 2, TONF, 'チョック 1 個あたりの力 [tonf/チョック]。正で上 IR のチョックを持ち上げる。'));
      actSec.body.append(num('irShift', 'IR シフト', 'mm', -150, 150, 5, 1e-3, '中間ロールの胴端の、板端からの位置。正で板端より外側、負で内側に引き込む（エッジ部の WR 支持を外す）。上下逆向きのシフトを半モデルでは両端対称に扱う。'));
    }
    if (params.mill === '20hi') {
      actSec.body.append(num('taperShift', '第1中間 テーパ位置', 'mm', -200, 200, 5, 1e-3, 'テーパ開始点の板端からの位置（板端基準）。正で板端より外側、負で板端より内側から細り始める。'));
      actSec.body.append(num('taperLen', 'テーパ長', 'mm', 50, 500, 10, 1e-3));
      actSec.body.append(num('taperDepth', 'テーパ深さ（半径）', 'µm', 0, 1000, 10, 1e-6));
    }
    if (params.mill === '12hi' || params.mill === '20hi') {
      // one rack row per AS-U: the 12Hi has one (B), the 20Hi two (A-B and C-D)
      const racks: { key: 'asu' | 'asu2'; label: string; hint: string }[] = params.mill === '20hi'
        ? [
          { key: 'asu', label: 'AS-U 1（A–B 軸）', hint: 'バッキング A・B 軸のサドル 7 点の押し込み [µm]（正 = ワークロール側へ）。ダブル AS-U の駆動側の組。' },
          { key: 'asu2', label: 'AS-U 2（C–D 軸）', hint: 'バッキング C・D 軸のサドル 7 点の押し込み [µm]。作業側の組。両組を同じにすれば従来の AS-U。' },
        ]
        : [{ key: 'asu', label: 'AS-U（B 軸）', hint: 'B 軸のバッキング軸を支えるサドルを個別に押し込む [µm]（正 = ワークロール側へ）。7 点のラックで胴長方向のクラウンを作る。' }];
      for (const rk of racks) {
        const asuWrap = el('div', 'ctrl');
        const top = el('div', 'ctrl-top');
        const lab = el('label', 'ctrl-label', rk.label);
        lab.append(helpMark(rk.hint));
        top.append(lab);
        asuWrap.append(top);
        const row = el('div', 'v3-asu');
        params[rk.key].forEach((v, k) => {
          row.append(numField({
            value: v * 1e6, min: -500, max: 500, step: 10, digits: 0,
            onChange: (x) => { params[rk.key][k] = x * 1e-6; params[rk.key] = [...params[rk.key]]; apply(); },
          }).root);
        });
        asuWrap.append(row);
        const set = (arr: number[]) => { params[rk.key] = arr; apply(); buildLeft(); };
        asuWrap.append(buttonRow([
          { text: 'フラット', onClick: () => set(new Array(ASU_RACKS).fill(0)) },
          { text: '山形 +200', onClick: () => set(asuShape(200e-6)) },
          { text: '谷形 −200', onClick: () => set(asuShape(-200e-6)) },
        ]));
        actSec.body.append(asuWrap);
      }
      if (params.mill === '20hi') {
        actSec.body.append(buttonRow([
          { text: '2 → 1 にコピー', title: 'AS-U 2 を AS-U 1 と同じにする', onClick: () => { params.asu2 = [...params.asu]; apply(); buildLeft(); } },
        ]));
      }
    }
    if (!actSec.body.children.length) actSec.body.append(el('div', 'ctrl-hint', '2Hi にはアクチュエータがない（圧下とレベリングのみ）。'));
    left.append(actSec.root);

    // profiles
    const profSec = section('ロールプロファイル', { remember: false, open: false });
    profSec.body.append(num('wrCrown', 'WR 研削クラウン', 'µm', -400, 400, 5, 1e-6, '直径クラウン: 中央と胴端の直径差。正で中央が太い（放物線）。'));
    profSec.body.append(num('wrThermal', 'WR サーマルクラウン', 'µm', 0, 200, 5, 1e-6, '熱膨張による直径クラウン（入力値。温度分布は解かない）。'));
    if (params.mill === '6hi' || params.mill === '12hi' || params.mill === '20hi') {
      profSec.body.append(num('irCrown', params.mill === '20hi' ? '第1中間 クラウン' : 'IR クラウン', 'µm', -400, 400, 5, 1e-6, '直径クラウン。'));
    }
    if (params.mill === '4hi' || params.mill === '6hi') {
      profSec.body.append(num('burCrown', 'BUR クラウン', 'µm', -600, 1000, 10, 1e-6, '直径クラウン。'));
    }
    left.append(profSec.root);

    // strip
    const stripSec = section('板・圧延条件', { remember: false, open: false });
    stripSec.body.append(select<'slab' | 'fem' | 'fem3d'>('材料の変形計算', [
      { value: 'fem3d', text: '3 次元 FEM（幅 × 圧延方向 × 板厚、ロールと連成）' },
      { value: 'fem', text: '平面 FEM（幅 × 圧延方向、ロールと連成）' },
      { value: 'slab', text: 'スラブ法（幅方向スライス）' },
    ], params.stripModel, (v) => { params.stripModel = v; apply(); buildLeft(); },
    '3 次元 FEM: 板厚の上半分（中央面対称）を六面体で分割した剛塑性 FEM。ロール面は法線速度拘束＋クーロン摩擦、圧力はその反力。板厚方向の速度分布・横流れ・摩擦丘が結果として出る。平面 FEM: 板厚方向を一様速度とした薄板近似（速い）。スラブ法: 幅方向スライスごとの Bland & Ford（最速）。いずれもロールの撓み・扁平と連成。').root);
    if (params.stripModel === 'fem' || params.stripModel === 'fem3d') {
      stripSec.body.append(num('stripNz', '材料 FEM 圧延方向 分割数', '', 4, 32, 1, 1, '噛み込み弧に沿った要素数。幅方向は「幅方向 分割数」の板上の点数に従う。'));
    }
    if (params.stripModel === 'fem3d') {
      stripSec.body.append(num('stripNy', '材料 FEM 板厚方向 分割数', '', 1, 6, 1, 1, '板厚の上半分の層数（中央面は対称面）。結果は 1〜3 でほぼ変わらない。計算時間は層数に比例。'));
    }
    stripSec.body.append(num('width', '板幅', 'mm', 300, 1600, 10, 1e-3, 'WR の胴長を超えると警告が出る（胴からはみ出した板は圧延されず、計算にも入らない）。'));
    stripSec.body.append(num('h0', '入側板厚 h₀', 'mm', 0.05, 6, 0.01, 1e-3, undefined, true));
    stripSec.body.append(num('entryCrown', '入側クラウン', 'µm', -100, 200, 2, 1e-6, '入側板厚の中央と板端の差。出側クラウン比が入側と一致すれば平坦。'));
    stripSec.body.append(num('backTension', '後方張力', 'MPa', 0, 300, 5, 1e6));
    stripSec.body.append(num('frontTension', '前方張力', 'MPa', 0, 300, 5, 1e6, '幅方向の平均値。分布は伸び差から決まる。'));
    stripSec.body.append(num('mu', '摩擦係数 μ', '', 0.01, 0.3, 0.005, 1));
    stripSec.body.append(num('lmnL', '変形抵抗 L', 'MPa', 200, 3000, 10, 1e6, 'kf = L (ε + M)ᴺ（平面ひずみ）。2D タブと同じ式。'));
    stripSec.body.append(num('lmnM', 'M', '', 0, 0.2, 0.005, 1));
    stripSec.body.append(num('lmnN', 'N', '', 0, 0.6, 0.005, 1));
    stripSec.body.append(num('entryStrain', '入側予ひずみ', '', 0, 2, 0.05, 1));
    stripSec.body.append(num('lateralLen', '横流れ 平滑長', 'mm', 0, 100, 1, 1e-3, '幅方向の伸び差を均す距離（板厚の数倍）。下限は幅方向の分割点間隔（それより短いと隣接スライスが結合されず、市松状の数値モードが出る）。'));
    stripSec.body.append(toggle('張力フィードバック', params.tensionFeedback, (v) => { params.tensionFeedback = v; apply(); },
      'ON: 板の長手張力が降伏条件（p = kf − σt）と塑性変形の開始点（弾性圧下量）を下げ、幅方向の伸び差で張力が再配分され、材料 FEM の入出側トラクションにも入る。これが荷重を通じて WR の撓み・扁平に返る。OFF: 張力なしで圧延したときの挙動（比較用）。').root);
    stripSec.body.append(num('sigmaCr', '座屈限界（圧縮）', 'MPa', 0, 20, 0.5, 1e6, 'これ以上の圧縮を板は張力として支えられず、波（顕在形状）になる。'));
    left.append(stripSec.root);

    // roll geometry
    const geoSec = section('ロール寸法', { remember: false, open: false });
    geoSec.body.append(num('wrD', 'WR 直径', 'mm', 30, 900, 5, 1e-3));
    geoSec.body.append(num('wrLb', 'WR 胴長', 'mm', 500, 2500, 10, 1e-3));
    geoSec.body.append(num('wrLs', 'WR 支持スパン', 'mm', 600, 3000, 10, 1e-3));
    geoSec.body.append(num('wrDn', 'WR ネック径', 'mm', 20, 700, 5, 1e-3, 'ロール直径を超えない（超える値は直径に丸められる）。'));
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
      geoSec.body.append(num('burDn', 'BUR ネック径', 'mm', 200, 1400, 10, 1e-3, 'ロール直径を超えない。'));
    }
    if (params.mill === '12hi' || params.mill === '20hi') {
      geoSec.body.append(num('bbD', 'バッキング 外径', 'mm', 100, 600, 5, 1e-3, 'バッキングベアリングの外径。'));
      geoSec.body.append(num('bbShaft', 'バッキング軸 径', 'mm', 50, 400, 5, 1e-3));
      geoSec.body.append(num('bbLb', 'バッキング軸 支持長', 'mm', 500, 2500, 10, 1e-3));
      geoSec.body.append(toggle('バッキング軸受を分割', params.bbSegmented, (v) => { params.bbSegmented = v; apply(); },
        'ON: 軸受はサドル間ごとの独立したリング（サドル幅の隙間では接触しない）。OFF: 一本の連続胴として扱う。').root);
      geoSec.body.append(num('bbGap', 'サドル幅（軸受間の隙間）', 'mm', 5, 120, 5, 1e-3, '隣り合う軸受リングの間で軸がむき出しになる幅。ここでは第 2 中間ロールと接触しない。'));
      geoSec.body.append(num('angle1', '第1中間 配置角', '°', 10, 60, 1, Math.PI / 180, '鉛直からの角度。左右の中間ロールが触れ合わない最小角より小さければ、その最小角に引き上げられる（端面図に実際の角を表示）。'));
      geoSec.body.append(num('clearance', '隣接ロールのクリアランス', 'mm', 0.5, 20, 0.5, 1e-3, '同じ段に並ぶロール同士（第1中間の左右、第2中間、バッキング）に空ける隙間。'));
    }
    geoSec.body.append(num('Eroll', 'ロール ヤング率', 'GPa', 100, 300, 5, 1e9));
    left.append(geoSec.root);

    // numerics / display
    const numSec = section('解析・表示', { remember: false, open: false });
    numSec.body.append(num('stations', '幅方向 分割数', '', 21, 241, 2, 1, '全ロール共通の節点数。増やすと帯行列の解法時間が線形に伸びる。'));
    numSec.body.append(select<'hertz' | 'ring'>('扁平モデル', [
      { value: 'hertz', text: 'Hertz 式（Johnson の円筒近似）' },
      { value: 'ring', text: '断面 FEM（リングメッシュ nt × nr）' },
    ], params.flatModel, (v) => { params.flatModel = v; apply(); buildLeft(); },
    'ロールが接触で扁平する量の求め方。Hertz 式は半無限体の閉形式、断面 FEM は剛体ハブと胴の間の平面ひずみリングを Q4 要素で解いた影響関数（2D タブと同じ要素）。').root);
    if (params.flatModel === 'ring') {
      numSec.body.append(num('ringNt', 'ロール 周方向 分割 nt', '', 32, 1600, 16, 1, '断面リングの周方向分割。接触半幅（数 mm）を数節点で解像するには 400 以上。'));
      numSec.body.append(num('ringNr', 'ロール 半径方向 分割 nr', '', 2, 24, 1, 1));
      numSec.body.append(num('ringGrade', '半径方向グレーディング', '', 1, 5, 0.1, 1, '1 で等間隔、大きいほど胴表面に要素を寄せる。'));
      numSec.body.append(num('ringHub', '剛体ハブ半径 / R', '', 0.05, 0.85, 0.05, 1, 'ロール本体のうち軸として扱う部分。バッキングベアリングは軸径で決まる。'));
    }
    numSec.body.append(slider({ label: '撓み表示倍率', min: 10, max: 2000, step: 10, log: true, value: magnify, onInput: (v) => { magnify = v; dirty = true; } }).root);
    numSec.body.append(slider({ label: '断面変形 表示倍率', min: 10, max: 5000, step: 10, log: true, value: sectionMagnify, onInput: (v) => { sectionMagnify = v; dirty = true; } }).root);
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

    const um = (a: Float64Array) => Float64Array.from(a, (v) => v * 1e6);
    charts.defl.draw(R.rolls.map((r, i): XYSeries => ({
      label: r.def.id, color: ROLL_COLORS[i % ROLL_COLORS.length], x: R.x, y: um(r.v),
    })), { unit: 'µm', halfWidth, strip, zero: true });

    const contactLabel = (c: { a: number; b: number }) => `${st.rolls[c.a].id}–${st.rolls[c.b].id}`;
    // an open gap is no flattening: zero where the contact carries no load,
    // and nothing at all where the barrels do not overlap
    const closed = (c: { delta: Float64Array; weight: Float64Array }) =>
      Float64Array.from(c.delta, (d, i) => (c.weight[i] > 0 ? Math.max(d, 0) * 1e6 : NaN));
    charts.flat.draw([
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: um(R.flat) },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: closed(c) })),
    ], { unit: 'µm', halfWidth, strip, zero: true });

    const kn = (a: Float64Array) => Float64Array.from(a, (v) => v / 1e6);
    const onBarrels = (c: { q: Float64Array; weight: Float64Array }) =>
      Float64Array.from(c.q, (q, i) => (c.weight[i] > 0 ? q / 1e6 : NaN));
    charts.load.draw([
      { label: 'WR–板', color: STRIP_COLOR, x: R.x, y: kn(R.q), fill: true },
      ...R.contacts.map((c, i): XYSeries => ({ label: contactLabel(c), color: ROLL_COLORS[(i + 1) % ROLL_COLORS.length], x: R.x, y: onBarrels(c) })),
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
      { label: '潜在 Δε', color: '#7fe4ff', x: R.x, y: iuFromMin(R.dEps) },
      { label: '顕在（波）', color: '#ff6b81', x: R.x, y: iuFromMin(R.manifest), fill: true },
    ], { unit: 'I-unit', halfWidth: strip * 1.05, strip, zero: true, symmetric: false });

    charts.sig.draw([
      { label: 'σf', color: '#96e6b4', x: R.x, y: Float64Array.from(R.sigmaF, (v) => v / 1e6), width: 2 },
    ], {
      unit: 'MPa', halfWidth: strip * 1.05, strip, zero: true,
      marks: [{ y: params.frontTension / 1e6, label: '設定平均', color: '#8ea0bd' }],
    });

    {
      const f = R.fem;
      const xs = R.x, arcs = R.arc;
      // the FEM's grid: its columns are between the loaded stations; hand
      // the heat map those stations' x and arcs
      if (f) {
        const idx: number[] = [];
        for (let s = 0; s < xs.length; s++) if (Number.isFinite(R.h1[s])) idx.push(s);
        const fx = idx.map((s) => xs[s]), fa = idx.map((s) => arcs[s]);
        charts.press.draw(f.p, f.ncol, f.nrow, fx, fa, { unit: 'MPa', scale: 1e-6, halfWidth: strip * 1.05 });
        charts.flow.draw(f.ux, f.ncol, f.nrow, fx, fa, { unit: '%', scale: 100, halfWidth: strip * 1.05, symmetric: true });
      } else {
        charts.press.draw(null, 0, 0, xs, arcs, { unit: 'MPa', scale: 1, halfWidth: strip });
        charts.flow.draw(null, 0, 0, xs, arcs, { unit: '%', scale: 1, halfWidth: strip });
      }
    }

    // stats
    stats.set('force', (R.force / TONF).toFixed(1));
    stats.set('screw', (R.screw * 1e3).toFixed(3));
    stats.set('relief', params.tensionFeedback ? (R.yieldRelief * 100).toFixed(1) : 'OFF');
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
    stats.set('fem', R.fem ? `${params.stripModel === 'fem3d' ? '3D ' : ''}${R.fem.iterations} / ${R.fem.massRatio.toFixed(4)}` : '—（スラブ法）', R.fem && !R.fem.converged ? 'warn' : undefined);
    {
      const wr = st.rolls[st.wr];
      const inf = solver.ringFor(wr);
      const mid = solver.slices[Math.floor(solver.slices.length / 2)];
      const qc = mid?.q ?? 0;
      const b = Math.max(Math.sqrt(solver.wsLaw.bCoef * Math.max(qc, 1)), (mid?.arc ?? 0) / 2);
      if (inf) {
        const johnson = ((1 - wr.nu * wr.nu) / (Math.PI * wr.E)) * (2 * Math.log((4 * wr.D) / (2 * b)) - 1);
        stats.set('flatCmp', `${(ringCompliance(inf, b) / johnson).toFixed(3)} (b = ${(b * 1e3).toFixed(1)} mm)`);
      } else stats.set('flatCmp', '—');
      sectionView.draw(inf, qc, sectionMagnify, `WR ／ 板中央 q = ${(qc / 1e6).toFixed(2)} kN/mm`);
    }

    // chips
    setChip(chips.mill, MILL_LABEL[params.mill]);
    setChip(chips.force, (R.force / TONF).toFixed(0));
    setChip(chips.h1, (R.h1Mean * 1e3).toFixed(3));
    setChip(chips.crown, (R.crown * 1e6).toFixed(0));
    setChip(chips.manifest, R.manifestIU.toFixed(0), R.manifestIU < 5 ? 'ok' : R.manifestIU < 40 ? 'warn' : 'bad');
    setChip(chips.conv, R.converged ? '収束' : running ? '反復中' : '停止', R.converged ? 'ok' : running ? 'warn' : undefined);
    chips.conv.classList.toggle('busy', !R.converged && running);
    {
      const res = Number.isFinite(R.residual) ? R.residual.toExponential(1) : '—';
      const fem = R.fem ? ` / 補正 ${solver.femLastChange.toExponential(1)}` : '';
      setChip(chips.res, res + fem, R.converged ? 'ok' : R.residual < 1e-3 ? 'warn' : 'bad');
    }
    setChip(chips.ms, R.solveMs.toFixed(0));
    const warns = [...R.warnings.map((w: Warning3D) => WARNING_TEXT[w]), ...R.notes];
    const want = warns.join('\u0001');
    if (warnBox.dataset.sig !== want) {
      warnBox.dataset.sig = want;
      warnBox.replaceChildren(...warns.map((w) => {
        const b = el('div', 'badge warn');
        b.innerHTML = `<b>⚠</b><span></span>`;
        b.querySelector('span')!.textContent = w;
        return b;
      }));
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
    const k = Number(e.key);
    if (k >= 1 && k <= MILLS.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
      switchMill(MILLS[k - 1]);
    }
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

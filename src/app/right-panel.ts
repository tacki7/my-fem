/**
 * The right panel's read-outs, built: every section's stat grid and hints, and
 * the resource section's budget chart and memory meters, appended to `right`
 * in the order the panel shows them.
 *
 * Only the building. `updateStats` in main.ts fills these every few frames and
 * reads almost all of the app's state, so it stays there and takes the handles
 * this returns, under the names it has always used.
 */
import { el, section, StatGrid } from '../ui/controls';
import { BudgetChart } from '../ui/charts';

export function buildRightPanel(right: HTMLElement) {
  const gMill = new StatGrid();
  gMill.add('mass', '質量収支 v₀h₀ / v₁h₁', '')
    .add('P', '圧延荷重 P', 'kN/mm').add('pm', '平均面圧 p̄', 'MPa')
    .add('pk', '最大面圧 p_max', 'MPa')
    // The strict bite limit and Stone's floor are under the stand in the mill
    // line, next to the gauge they bound. This is the looser criterion that
    // applies once rolling is under way, and it is usually not a number at all.
    .add('hbitec', '継続噛み込み限界 (μ ≥ tan α/2)', 'mm')
    .add('hrat', 'h₁ / h_min（余裕）', '');
  const gTotal = new StatGrid();
  gTotal.add('Pt', '圧延荷重 (実機)', 'MN');
  const rMill = section('圧延諸元');
  const loadModelHint = el('div', 'ctrl-hint');
  rMill.body.append(gMill.root);
  rMill.body.append(el('div', 'ctrl-hint', '↑ ここまで単位幅あたり（平面ひずみ）'));
  rMill.body.append(gTotal.root);
  const totalHint = el('div', 'ctrl-hint');
  rMill.body.append(totalHint, loadModelHint);

  const gAgc = new StatGrid();
  gAgc.add('S', 'ロールギャップ指令 S', 'mm')
    .add('tgt', '目標値', '').add('meas', '測定値 (平滑後)', '')
    .add('err', '偏差', '%').add('st', '状態', '')
    .add('spr', 'ミルスプリング h₁ − S', 'µm')
    .add('sprh', '　うち ハウジング伸び P/M', 'µm')
    .add('sprr', '　うち ロール扁平＋弾性回復', 'µm')
    .add('sens', '同定感度 d(測定)/d(S)', '');
  const rAgc = section('自動制御 (AGC / 定圧延荷重)');
  rAgc.body.append(gAgc.root);
  const agcReadHint = el('div', 'ctrl-hint');
  rAgc.body.append(agcReadHint);

  const gKin = new StatGrid();
  gKin.add('vr', 'ロール周速 v_R', 'm/s')
    .add('vin', '入側速度 v₀', 'm/s')
    .add('vout', '出側速度 v₁', 'm/s')
    .add('bs', '後進率 b = (v_R−v₀)/v_R', '%')
    .add('fsth', '　理論 f = x_n²/(R′h₁)', '%')
    .add('neut', '中立点位置 x_n', 'mm').add('nang', '中立角 φ_n', '°')
    .add('neutth', '　理論 x_n = −√(f R′h₁)', 'mm')
    .add('mb', '質量収支 v₁h₁/(v₀h₀)', '')
    .add('rx', '送り反力', 'kN/m').add('fres', '　同 残差 |R|/(μP)', '');
  const gElas = new StatGrid();
  gElas.add('eint', '入側弾性域 (幾何 Δh_e·R/|x_e|)', 'mm')
    .add('ein', '　FEM 実測 (解像度依存)', 'mm')
    .add('einh', '　教科書 √(R′Δh_e)', 'mm')
    .add('epl', '塑性域', 'mm').add('efrac', 'FEM 弾性域 / 接触弧', '%')
    .add('dhe', '入側 弾性圧縮 Δh_e', 'µm').add('dhp', '塑性圧下 Δh_p', 'µm')
    .add('sbmm', '出側 弾性回復 Δh_r', 'µm')
    .add('sb', '　同 ひずみ', '%').add('sbth', '　理論 kf/E′', '%')
    .add('hgap', 'ロールギャップ出口 h', 'mm');
  const rElas = section('入出側 弾性域');
  rElas.body.append(gElas.root);
  rElas.body.append(el('div', 'ctrl-hint',
    '板厚変化の内訳: h₀ →(弾性圧縮 Δh_e)→ 降伏 →(塑性圧下 Δh_p)→ ギャップ →(弾性回復 Δh_r)→ h₁。'
    + ' FEM 実測の入側弾性域は蓄積相当ひずみが弾性限 kf/E′ を超えるまでの区間（列内補間）だが、'
    + 'この区間は多くの条件で 1 要素列より短く解像できない。'
    + '上流の板は平坦なのでバレルは勾配 |x_e|/R で閉じてくる。よって弾性圧縮 Δh_e = h₀kf/E′ は '
    + 'Δh_e·R/|x_e| の弧で消費される。教科書の √(R′Δh_e) は孤立弾性接触の式で、'
    + '塑性ビットが長いときは過大評価になる。'));

  const rKin = section('速度・すべり');
  rKin.body.append(gKin.root);
  rKin.body.append(el('div', 'ctrl-hint',
    '自走モードでは送り反力が 0 に収束するよう入側速度を制御している。'
    + ' 先進率の理論式は板厚方向に速度一様（平面保持）を仮定して板の平均速度をロール周速に'
    + '等しく置いたもの。FEM の中立点は板 *表面* の速度で判定しており、表面は摩擦に引かれて'
    + '平均より遅れるため両者は一致しない（摩擦が強いほど差は縮む）。'
    + ' 質量収支が 1 からずれるのは出側の弾性回復ぶん（体積は弾性的に増える）。'));

  const gMat = new StatGrid();
  gMat.add('eps', '出側 相当ひずみ ε̄', '').add('epsIn', '　入側 ε̄ (前段から)', '')
    .add('epsT', '理論 ε̄_in + (2/√3)ln(h₀/h₁)', '')
    .add('epk', '最大 ひずみ', '').add('erate', '最大 ひずみ速度', '1/s')
    .add('sfm', '平均変形抵抗 σ̄f (ビット体積平均)', 'MPa')
    .add('sfmT', '　理論 σ_Y0+K·ε₁ⁿ/(n+1)', 'MPa')
    .add('sf', '出側 変形抵抗 σf', 'MPa').add('kf', 'スラブ法で使う kf', 'MPa');
  const rMat = section('材料状態');
  rMat.body.append(gMat.root);
  rMat.body.append(el('div', 'ctrl-hint',
    '圧延荷重を決めるのは出側値ではなく平均変形抵抗。材料はビット入口では未加工のままで、'
    + '出側の値に達するのは最後だけなので、出側値を使うと荷重を過大評価する。'));

  const gHeat = new StatGrid();
  gHeat.add('dt', '温度上昇 ΔT', 'K')
    .add('tpk', '最高温度 (表層)', '°C')
    .add('soft', '出側 軟化率 1−kf(T)/kf(T₀)', '%')
    .add('kfiso', '等温 kf (出側 ε̄)', 'MPa').add('kfhot', '発熱後 kf', 'MPa')
    .add('work', '塑性仕事 σ̄f·ε̄', 'MJ/m³');
  const rHeat = section('加工発熱');
  rHeat.body.append(gHeat.root);
  const heatStatHint = el('div', 'ctrl-hint');
  rHeat.body.append(heatStatHint);

  const gVal = new StatGrid();
  gVal.add('rr', '圧下達成率 (指令比)', '').add('cres', '連成残差 |Δh₁|/h₁', '')
    .add('rs', '連成 減衰係数', '')
    .add('slabP', 'スラブ法 荷重', 'kN/mm')
    .add('ratio', 'FEM / スラブ法', '').add('slabPm', 'スラブ法 平均面圧', 'MPa')
    .add('Qp', '摩擦丘係数 Qp', '')
    .add('flat', 'ロール扁平量', 'µm').add('rollvm', 'ロール最大応力', 'MPa');
  const rVal = section('理論照合・ロール');
  rVal.body.append(gVal.root);
  rVal.body.append(el('div', 'ctrl-hint',
    'スラブ法は上部で選んだ式（Kármán: Siebel 型 p̄ = kf*·(e^a−1)/a ／ Bland & Ford ／ Orowan）を'
    + '張力込みで、FEM と同じ R′ で評価した値。'
    + '圧下達成率が大きく 1 を下回るのはロール扁平が圧下量を食っている状態'
    + '（Stone の最小圧延可能板厚）で、数値的な破綻ではない。'));

  const rRes = section('リソース');
  const sparkCanvas = el('canvas', 'spark');
  const sparkLegend = el('div', 'spark-legend');
  const budget = new BudgetChart(sparkCanvas, [
    ['流れ解析', 'rgba(88,213,255,0.80)'],
    ['ロール弾性', 'rgba(255,196,107,0.80)'],
    ['ひずみ輸送', 'rgba(169,155,255,0.80)'],
    ['描画', 'rgba(110,231,165,0.80)'],
    ['その他', 'rgba(160,180,205,0.35)'],
  ]);
  for (const l of budget.legend()) {
    const s = el('span');
    const i = el('i'); i.style.background = l.color;
    s.append(i, document.createTextNode(l.label));
    sparkLegend.append(s);
  }
  const gRes = new StatGrid();
  gRes.add('solve', 'ソルバ計', 'ms').add('flow', '  ├ 流れ解析', 'ms')
    .add('rollms', '  ├ ロール弾性', 'ms').add('strain', '  └ ひずみ輸送', 'ms')
    .add('draw', '描画', 'ms').add('cg', 'CG 反復', '')
    .add('res', 'CG 残差', '').add('pd', 'Picard 変化率', '');
  const gMem = new StatGrid();
  gMem.add('selem', '板 要素数', '')
    .add('relem', 'ロール 要素数', '').add('nnzs', '板 非零', '')
    .add('band', '帯幅 (半)', '')
    // Split, because the three scale on different dials and one total figure only
    // ever goes up. The roll block is the big one: its elastic stiffness and the
    // band preconditioner are the largest arrays in the app.
    .add('memflow', 'ソルバ配列  流れ', '').add('memroll', '　　　　　　ロール', '')
    .add('memfield', '　　　　　　場・出力', '')
    .add('solmem', '　　　　　　選択スタンド計', '')
    .add('linemem', 'ライン合計 (全スタンド)', '')
    .add('heap', 'JS ヒープ 使用', '').add('heaptot', '　　　　　確保済み', '')
    .add('heapmax', '　　　　　上限', '');
  const heapMeter = el('div', 'meter');
  const heapFill = el('div');
  heapFill.style.background = 'linear-gradient(90deg,#58d5ff,#a99bff)';
  heapMeter.append(heapFill);
  const memHint = el('div', 'ctrl-hint');
  /**
   * Where the meter's two bands come from.
   *
   * The solver arrays are a slice of the heap, not a separate pool, so showing
   * them as a fraction of the same bar says how much of what the tab is holding
   * is the model itself - which is the number that decides whether a finer mesh
   * will fit.
   */
  const memMeter = el('div', 'meter');
  const memFill = el('div');
  memFill.style.background = 'linear-gradient(90deg,#6ee7a5,#ffc46b)';
  memMeter.append(memFill);
  const gHost = new StatGrid();
  gHost.add('gpu', 'GPU', '').add('cores', '論理コア', '')
    .add('dmem', 'デバイスメモリ', 'GB').add('dpr', 'DPR', '')
    .add('gl', 'WebGL', '').add('draws', '描画コール', '/frame');
  rRes.body.append(sparkCanvas, sparkLegend, gRes.root,
    el('div', 'ctrl-hint', 'メモリ'), gMem.root,
    memMeter, heapMeter, memHint,
    el('div', 'ctrl-hint', 'ホスト'), gHost.root);

  right.append(rMill.root, rAgc.root, rElas.root, rKin.root, rMat.root, rHeat.root,
    rVal.root, rRes.root);

  return {
    gMill, gTotal, loadModelHint, totalHint, gAgc, agcReadHint, gKin, gElas, gMat, gHeat,
    heatStatHint, gVal, budget, gRes, gMem, heapFill, memHint, memFill, gHost,
  };
}

// The 2D tab's pass as an elastic-plastic rolling analysis in FrontISTR:
//   node tools/build-esm.mjs sim2d && node tools/frontistr/strip2d.mjs [outdir] ['{"param":value}'] ['{"opt":value}']
//
// A plane-strain slice through the strip along the rolling direction: the upper half of the
// strip (symmetric about the pass line) as one element thick of 361 hexahedra with every node
// held in z, fed into the upper work roll, an elastic ring whose bore is turned by prescribed
// displacements (an amplitude table per bore node: a rotation about the fixed centre). The
// strip is elastic-plastic (von Mises, the app's kf = L (ε + M)^N as the uniaxial yield
// σ_f = (√3/2) kf against the equivalent plastic strain), the roll elastic, the contact
// Coulomb friction μ with finite sliding (augmented Lagrange). Two steps: the bite, with the
// tail pushed in at the entry speed; then rolling, the tail free under the back tension,
// until the head is well past the exit and the pass is steady.
//
// Writes roll.msh, roll.cnt, hecmw_ctrl.dat and reference.json (the app's parameters, the
// node lists, the roll's turning schedule) into outdir (default tools/frontistr/run/strip2d).
// run.sh solves it; compare2d.mjs reads the result against the app's slab method and strip FEM.
// Units SI throughout (FrontISTR has none of its own); forces per width are read by dividing
// by the slice's thickness `tz`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { defaultParams } from '../sim2d/params.mjs';

/** what the case is solved with: the mesh, the turn, the steps */
export const OPTS = {
  /** the strip's cell length along the rolling direction [m] and its layers through the half thickness */
  dx: 0.5e-3, ny: 3,
  /** the strip's length [m]: enough to feed the whole turn and keep the tail clear of the bite */
  len: 0.030,
  /** the slice's thickness in z [m] */
  tz: 1e-3,
  /** the roll ring: bore radius as a share of R, the surface cell along the contact zone [m], the coarse cell elsewhere [m], radial growth */
  bore: 0.7, surf: 1e-3, coarse: 30e-3, growth: 1.6,
  /** The roll's turn in the bite step and the rolling step [rad], and their substeps. The increments
      have to stay small against the cells all the way - 1/16 mrad, 12 µm of surface, a fortieth of a
      0.5 mm cell: at four times that the Newton loop needs cut-backs at every other increment and a
      cell is crushed sooner or later; 0.16 rad is 30 mm of surface, three contact lengths past the exit */
  theta1: 0.01, theta2: 0.16, sub1: 160, sub2: 2600,
  /** results every this many substeps */
  freq: 50,
  /** the strip's top starts this far under the roll surface through the bite [m] - clear of it, so the
      contact closes as the tail push feeds the wedge in (a node ring on the faceted roll surface would
      otherwise start a micron inside it, and the penalty makes that a kilonewton) - and its head this far past the exit [m] */
  gap0: 2e-6, gapEntry: 30e-6, headOut: 5e-3,
  /** The bite: the roll comes down by `screw` [m] over the first step while it starts to turn, pressing
      the wedge that fills the gap until the friction draws the strip; the tail is free. (A pushed tail
      buckles the thin strip and the Newton loop dies; a roll that only turns never touches a strip
      that sits a hair under it.) `pushRatio` > 0 pushes the tail as well, at that share of the entry speed. */
  screw: 40e-6, pushRatio: 0,
  /** The linear solver. The built-in DIRECT with the contact constraints eliminated (CONTACT_ELIM=1) solves
      this 6k-DOF system in milliseconds - 200 times faster than BiCGSTAB with BILU(2), which itself is 10
      times faster than SSOR on the nonsymmetric (friction) matrix. Without CONTACT_ELIM the direct solver
      stops at "set positive nrows". */
  solver: 'DIRECT', precond: 12,
  /** the Newton loop: relative residual, its iterations, the contact iterations, and the multiplier
      tolerance of the augmentation (0 leaves FrontISTR's default) */
  converg: 5e-3, maxiter: 100, maxcontiter: 5, convergLag: 0,
  /** FIXED increments (see stepLines); with AUTO, the increment may shrink to 1/minInc of the nominal and the step take capMul times the nominal count */
  incType: 'FIXED', minInc: 64, capMul: 6,
  /** the master surface smoothed (Nagata patches) - the roll's facets, when the strip's nodes are the slave */
  smoothing: '',
  /** the contact penalty against FrontISTR's own reference stiffness (its default when unset) */
  npenalty: 0,
  /** The roll's surface nodes on the strip's top faces (true), or the strip's nodes on the roll's faces.
      The strip's nodes on the faceted roll chatter between faces at every Newton iteration and the bite
      never converges; the roll's nodes sliding over the strip's flat top faces do not. */
  swap: true,
  /** the contact algorithm: ALAGRANGE (augmented, any solver) or SLAGRANGE (multipliers, DIRECT) */
  algo: 'ALAGRANGE',
  /** turn the whole ring as a rigid body (no roll flattening; the app's rollCoupling off) */
  rigidRoll: false,
  /** the strip's and the roll's nodes staggered so none lands exactly on another at the engagement */
  stagger: true,
  /** the roll ring inside the slice's thickness (its nodes off the strip faces' edges), its E scaled to keep the stiffness per width */
  rollInset: true,
  /** leave the slave (roll surface) nodes unconstrained in z */
  zFreeSlave: false,
  /** the sliding formulation: FSLID (finite) or SSLID (small, re-searched every increment) */
  sliding: 'FSLID',
};

export function buildStrip2d(patch = {}, out, o = {}) {
  const O = { ...OPTS, ...o };
  mkdirSync(out, { recursive: true });
  const p = defaultParams(patch);
  const R = p.R, h0 = p.h0, h1 = h0 * (1 - p.reduction), tz = O.tz;
  const yc = h1 / 2 + R;                       // the roll centre; the exit plane is x = 0
  const Lc = Math.sqrt(Math.max(0, R * R - (yc - h0 / 2) ** 2)); // where the roll surface meets the entry thickness
  // The strip starts in the gap: its top follows the roll surface through the bite, a hair
  // under it, and runs on at the exit thickness for `headOut` past the exit. Rolling then
  // starts at once, instead of a square head being bitten (which the contact iteration does
  // not survive). The head starts unstrained; after a contact length of rolling that is gone.
  // Staggered against the roll's surface nodes: a strip node under the roll's bottom node (both meshes
  // put one at x = 0) has a slave node come down exactly on a master node, and the first residual
  // after the contact engages is NaN. A fraction of a cell either way keeps every landing generic.
  const xHead = O.headOut + (O.stagger ? 0.29 * O.dx : 0);
  const rollY = (x) => yc - Math.sqrt(Math.max(0, R * R - x * x));
  // the whole top a `gap0` under the roll, the head included: the screw-down of the first step closes
  // exactly that, so the pass then runs at the nominal gap h1
  // The gap under the roll grows from `gap0` at the exit to `gapEntry` at the entry, so as the screw
  // comes down the contact closes from the exit backwards, a few nodes at a time, instead of the
  // whole arc at once (which the contact iteration does not survive).
  const gapAt = (x) => O.gap0 + (O.gapEntry - O.gap0) * Math.min(1, Math.max(0, -x / Lc));
  const topY = (x) => (x <= -Lc ? h0 / 2 : x >= 0 ? h1 / 2 - O.gap0 : Math.min(h0 / 2, rollY(x) - gapAt(x)));

  // ── the strip: nodes (i, j, k), i along x, j through the half thickness, k the two z faces ──
  const nx = Math.max(4, Math.round(O.len / O.dx)), ny = O.ny;
  const nodes = [];
  const push = (x, y, z) => { nodes.push([x, y, z]); return nodes.length; };
  const sid = new Map();
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k < 2; k++) {
    const x = xHead - O.len + (O.len * i) / nx;
    sid.set(`${i},${j},${k}`, push(x, topY(x) * (j / ny), k * tz));
  }
  const S = (i, j, k) => sid.get(`${i},${j},${k}`);
  const hexStrip = [], topFace = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    // 1-2-3-4 on z = 0 counter-clockwise seen from +z, 5-6-7-8 above: a positive volume
    hexStrip.push([S(i, j, 0), S(i + 1, j, 0), S(i + 1, j + 1, 0), S(i, j + 1, 0), S(i, j, 1), S(i + 1, j, 1), S(i + 1, j + 1, 1), S(i, j + 1, 1)]);
    // the strip's top: nodes 3-4-8-7 of the cell, face 5
    if (j === ny - 1) topFace.push([hexStrip.length, 5]);
  }

  // ── the roll ring: angle ψ from the bottom point, + towards the exit; fine where the strip will touch ──
  // The contact sits at ψ ∈ [−Lc/R, 0] at the start and walks backwards over the surface as the roll
  // turns forward: fine cells from −(Lc/R + θ1 + θ2) − margin to + margin, growing to `coarse` around the rest.
  const thetaTot = O.theta1 + O.theta2;
  const fineLo = -(Lc / R + thetaTot) - 0.03, fineHi = 0.03;
  const arcFine = []; { const span = (fineHi - fineLo) * R, n = Math.max(1, Math.round(span / O.surf)); for (let i = 0; i < n; i++) arcFine.push(span / n); }
  // the rest of the circumference: grow out from both ends of the fine zone and meet with coarse cells
  const rest = 2 * Math.PI * R - (fineHi - fineLo) * R;
  const ramp = []; { let h = O.surf * O.growth; while (h < O.coarse) { ramp.push(h); h *= O.growth; } }
  const rampLen = ramp.reduce((a, b) => a + b, 0);
  const mid = rest - 2 * rampLen;
  const nMid = Math.max(1, Math.round(mid / O.coarse));
  const arcCells = [...arcFine, ...ramp, ...Array.from({ length: nMid }, () => mid / nMid), ...ramp.slice().reverse()];
  const psi = [fineLo + (O.stagger ? (0.37 * O.surf) / R : 0)]; for (const h of arcCells) psi.push(psi[psi.length - 1] + h / R);
  psi.pop(); // periodic: the last point is the first
  const nPsi = psi.length;
  // radial layers from the surface inward
  const layers = []; { let t = O.surf, sum = 0; const depth = R * (1 - O.bore); while (sum + t < depth * 0.999) { layers.push(t); sum += t; t *= O.growth; } layers.push(depth - sum); }
  const rs = [R * O.bore]; for (let l = layers.length - 1; l >= 0; l--) rs.push(rs[rs.length - 1] + layers[l]); // bore … surface
  const nr = rs.length - 1;
  const rid = new Map();
  // The roll sits inside the slice's thickness: its nodes at z = tz/4 and 3tz/4, so a roll node
  // (slave) comes down on the inside of a strip face, never on the face's edge. Every slave node
  // on a master edge - which is what two bodies of the same thickness give - makes the first
  // residual after the engagement NaN. The ring's stiffness is kept per width by doubling its E.
  const zRoll = O.rollInset ? [tz / 4, (3 * tz) / 4] : [0, tz];
  const rollEScale = O.rollInset ? tz / (zRoll[1] - zRoll[0]) : 1;
  for (let m = 0; m < nPsi; m++) for (let l = 0; l <= nr; l++) for (let k = 0; k < 2; k++) {
    const a = -Math.PI / 2 + psi[m];
    rid.set(`${m},${l},${k}`, push(rs[l] * Math.cos(a), yc + rs[l] * Math.sin(a), zRoll[k]));
  }
  const Rn = (m, l, k) => rid.get(`${(m + nPsi) % nPsi},${l},${k}`);
  const hexRoll = [], outerFace = [];
  const P = (n) => nodes[n - 1];
  const vol = (a, b) => { const A = P(a[0]), B = P(a[1]), C = P(a[2]), D = P(b[0]); const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]], w = [D[0] - A[0], D[1] - A[1], D[2] - A[2]]; return (u[1] * v[2] - u[2] * v[1]) * w[0] + (u[2] * v[0] - u[0] * v[2]) * w[1] + (u[0] * v[1] - u[1] * v[0]) * w[2]; };
  let flip = null;
  const elemStartRoll = hexStrip.length + 1;
  for (let m = 0; m < nPsi; m++) for (let l = 0; l < nr; l++) {
    let a = [Rn(m, l, 0), Rn(m + 1, l, 0), Rn(m + 1, l + 1, 0), Rn(m, l + 1, 0)], b = [Rn(m, l, 1), Rn(m + 1, l, 1), Rn(m + 1, l + 1, 1), Rn(m, l + 1, 1)];
    if (flip === null) flip = vol(a, b) < 0;
    if (flip) { a = [a[0], a[3], a[2], a[1]]; b = [b[0], b[3], b[2], b[1]]; }
    hexRoll.push([...a, ...b]);
    // the surface cell's outer face: nodes 3-4-7-8 (face 5) unflipped, 2-3-7-6 (face 4) flipped
    if (l === nr - 1) outerFace.push([elemStartRoll + hexRoll.length - 1, flip ? 4 : 5]);
  }

  // ── groups ──
  const ng = {};
  ng.STRIP_SYM = []; ng.TAIL = []; ng.HEAD = []; ng.ZALL = []; ng.STRIP_TOP = []; ng.ROLL_SURF = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k < 2; k++) {
    const n = S(i, j, k); ng.ZALL.push(n);
    if (j === 0) ng.STRIP_SYM.push(n);
    if (i === 0) ng.TAIL.push(n);
    if (i === nx) ng.HEAD.push(n);
    if (j === ny) ng.STRIP_TOP.push(n);
  }
  ng.BORE = [];
  // the slave nodes may be left free in z (`zFreeSlave`): a node held by a boundary condition and by a contact constraint at once is a suspect for the NaN at the engagement
  for (let m = 0; m < nPsi; m++) for (let l = 0; l <= nr; l++) for (let k = 0; k < 2; k++) { const n = Rn(m, l, k); if (!(O.zFreeSlave && O.swap && l === nr)) ng.ZALL.push(n); if (l === 0) ng.BORE.push(n); if (l === nr) ng.ROLL_SURF.push(n); }
  // the contact pair: the strip's top nodes on the roll's surface faces, or the other way round (`swap`)
  ng.SLAVE = O.swap ? ng.ROLL_SURF : ng.STRIP_TOP;
  const sg = { MASTER: O.swap ? topFace : outerFace };

  // ── the mesh file ──
  const L = ['!HEADER', ' ROLL FEM LAB strip2d', '!NODE'];
  nodes.forEach((q, i) => L.push(` ${i + 1}, ${q[0].toPrecision(10)}, ${q[1].toPrecision(10)}, ${q[2].toPrecision(10)}`));
  L.push('!ELEMENT, TYPE=361, EGRP=STRIP'); hexStrip.forEach((c, i) => L.push(` ${i + 1}, ${c.join(', ')}`));
  L.push('!ELEMENT, TYPE=361, EGRP=ROLL'); hexRoll.forEach((c, i) => L.push(` ${elemStartRoll + i}, ${c.join(', ')}`));
  L.push('!MATERIAL, NAME=STRIP, ITEM=1', '!ITEM=1, SUBITEM=2', ` ${p.Estrip}, ${p.nuStrip}`);
  L.push('!MATERIAL, NAME=ROLL, ITEM=1', '!ITEM=1, SUBITEM=2', ` ${p.Eroll * rollEScale}, ${p.nuRoll}`);
  L.push('!SECTION, TYPE=SOLID, EGRP=STRIP, MATERIAL=STRIP', '!SECTION, TYPE=SOLID, EGRP=ROLL, MATERIAL=ROLL');
  for (const [name, ids] of Object.entries(ng)) { L.push(`!NGROUP, NGRP=${name}`); for (let i = 0; i < ids.length; i += 10) L.push(' ' + ids.slice(i, i + 10).join(', ')); }
  for (const [name, faces] of Object.entries(sg)) { L.push(`!SGROUP, SGRP=${name}`); for (let i = 0; i < faces.length; i += 5) L.push(' ' + faces.slice(i, i + 5).map(([e, f]) => `${e}, ${f}`).join(', ')); }
  L.push('!CONTACT PAIR, NAME=CP1', ' SLAVE, MASTER', '!END');
  writeFileSync(`${out}/roll.msh`, L.join('\n') + '\n');

  // ── the control file ──
  const C = ['!VERSION', ' 3', '!SOLUTION, TYPE=NLSTATIC', `!WRITE, RESULT, FREQUENCY=${O.freq}`,
    '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' CONTACT_NFORCE, ON', ' CONTACT_FRICTION, ON', ' CONTACT_RELVEL, ON', ' CONTACT_STATE, ON', ' PL_ESTRAIN, ON', ' NSTRAIN, OFF', ' NSTRESS, OFF', ' NMISES, OFF'];
  // the permanent holds: the pass line's symmetry, the slice's plane strain
  C.push('!BOUNDARY, GRPID=1', ' STRIP_SYM, 2, 2, 0.0', ' ZALL, 3, 3, 0.0');
  // the bore's turn: one amplitude per bore station and component per step, the value the displacement itself
  const NT = 12;
  // the bore's stations turn; with `rigidRoll` every station of the ring does (no elastic roll, no flattening)
  const boreStations = [];
  for (let m = 0; m < nPsi; m++) for (let l = 0; l <= (O.rigidRoll ? nr : 0); l++) { const n0 = Rn(m, l, 0), n1 = Rn(m, l, 1); const [x, y] = P(n0); boreStations.push({ nodes: [n0, n1], r: Math.hypot(x, y - yc), a: Math.atan2(y - yc, x) }); }
  // One step for the bite and the rolling: the screw comes down over the first `t1` of it while the
  // turn runs at one rate throughout (the bite's substeps and the rolling's have the same size). One
  // amplitude table per bore station and component covers the whole thing, with a point at the
  // screw's kink. Two steps with a second set of tables never survived the hand-over: whatever the
  // second step's tables held - totals, increments, times running on - its first substep crushed a cell.
  const subAll = O.sub1 + O.sub2, t1 = O.sub1 / subAll, thAll = O.theta1 + O.theta2;
  const times = [...new Set([...Array.from({ length: NT + 1 }, (_, t) => t / NT), t1, t1 * 0.5, t1 * 0.25, t1 * 0.75])].sort((a, b) => a - b);
  const amps = [], bcs = [];
  boreStations.forEach((b, m) => {
    for (const [dof, f] of [[1, (th) => b.r * Math.cos(b.a + th) - b.r * Math.cos(b.a)], [2, (th, sc) => b.r * Math.sin(b.a + th) - b.r * Math.sin(b.a) - sc]]) {
      const name = `B${m}D${dof}`;
      const pairs = times.map((t) => `${f(thAll * t, O.screw * Math.min(1, t / t1)).toPrecision(9)}, ${t.toFixed(6)}`);
      amps.push(`!AMPLITUDE, NAME=${name}, DEFINITION=TABULAR, TIME=STEP, VALUE=RELATIVE`);
      for (let k = 0; k < pairs.length; k += 4) amps.push(' ' + pairs.slice(k, k + 4).join(', '));
      bcs.push(`!BOUNDARY, GRPID=2, AMP=${name}`, ...b.nodes.map((n) => ` ${n}, ${dof}, ${dof}, 1.0`));
    }
  });
  C.push(...amps, ...bcs);
  // the bite: the tail pushed in at the entry speed (kinematic feed, a little slow), ramped over the step
  const uPush = O.pushRatio * R * O.theta1 * (h1 / h0);
  if (uPush > 0) C.push('!BOUNDARY, GRPID=3', ` TAIL, 1, 1, ${uPush.toPrecision(9)}`);
  // tensions as end loads: front on the head (the rolled thickness), back on the tail
  const cload = [];
  const spread = (ids, total) => { const w = (j) => (j === 0 || j === ny ? 0.5 : 1); const rows = []; let idx = 0; for (let j = 0; j <= ny; j++) for (let k = 0; k < 2; k++) { rows.push(` ${ids[idx++]}, 1, ${((total * w(j)) / ny / 2).toPrecision(9)}`); } return rows; };
  if (p.frontTension > 0) cload.push(...spread(ng.HEAD, p.frontTension * (h1 / 2) * tz));
  if (p.backTension > 0) cload.push(...spread(ng.TAIL, -p.backTension * (h0 / 2) * tz));
  if (cload.length) C.push('!CLOAD, GRPID=4', ...cload);
  C.push(`!CONTACT_ALGO, TYPE=${O.algo}`, `!CONTACT, GRPID=1, INTERACTION=${O.sliding}${O.npenalty ? `, NPENALTY=${O.npenalty}` : ''}${O.smoothing ? `, SMOOTHING=${O.smoothing}` : ''}`, ` CP1, ${p.mu}`);
  // SUBSTEPS counts every attempt, cut-back ones included, so the cap is a multiple of the nominal count
  // Fixed increments. INC_TYPE=AUTO with amplitude-driven displacements makes the first residual NaN
  // as soon as a node is in contact (without amplitudes, or with fixed increments, it is not).
  const stepLines = (sub, grps) => (O.incType === 'AUTO'
    ? [`!STEP, INC_TYPE=AUTO, SUBSTEPS=${sub * O.capMul}, CONVERG=${O.converg}, MAXITER=${O.maxiter}, MAXCONTITER=${O.maxcontiter}${O.convergLag ? `, CONVERG_LAG=${O.convergLag}` : ''}`, ` ${(1 / sub).toPrecision(6)}, 1.0, ${(1 / sub / O.minInc).toPrecision(6)}, ${(1 / sub).toPrecision(6)}`]
    : [`!STEP, SUBSTEPS=${sub}, CONVERG=${O.converg}, MAXITER=${O.maxiter}, MAXCONTITER=${O.maxcontiter}${O.convergLag ? `, CONVERG_LAG=${O.convergLag}` : ''}`, ` ${(1 / sub).toPrecision(6)}, 1.0`]
  ).concat(grps.map((g) => ` ${g}`), [' CONTACT, 1']);
  C.push(...stepLines(subAll, ['BOUNDARY, 1', 'BOUNDARY, 2', ...(uPush > 0 ? ['BOUNDARY, 3'] : []), ...(cload.length ? ['LOAD, 4'] : [])]));
  // materials: the strip's kf = L (ε + M)^N as the uniaxial yield against the equivalent plastic strain
  const sigma = (ep) => (Math.sqrt(3) / 2) * p.lmnL * Math.pow(ep + p.lmnM, p.lmnN);
  const eps = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.13, 0.16, 0.2, 0.25, 0.3, 0.4, 0.5, 0.65, 0.8, 1.0, 1.3, 1.6, 2.0];
  C.push('!MATERIAL, NAME=STRIP', '!ELASTIC', ` ${p.Estrip}, ${p.nuStrip}`, '!PLASTIC, YIELD=MISES, HARDEN=MULTILINEAR', ...eps.map((e) => ` ${sigma(e).toPrecision(8)}, ${e}`));
  C.push('!MATERIAL, NAME=ROLL', '!ELASTIC', ` ${p.Eroll * rollEScale}, ${p.nuRoll}`);
  // the element formulation stays FrontISTR's default for NLSTATIC (incompatible modes): a
  // `!SECTION, FORM361=FBAR` in the control file makes the first residual NaN here
  if (O.solver === 'DIRECT') C.push('!SOLVER, METHOD=DIRECT, CONTACT_ELIM=1, ITERLOG=NO, TIMELOG=YES');
  else C.push(`!SOLVER, METHOD=${O.solver}, PRECOND=${O.precond}, ITERLOG=NO, TIMELOG=YES`, ' 20000, 1', ' 1.0e-8, 1.0, 0.0');
  C.push('!END');
  writeFileSync(`${out}/roll.cnt`, C.join('\n') + '\n');
  writeFileSync(`${out}/hecmw_ctrl.dat`, ['!MESH, NAME=fstrMSH, TYPE=HECMW-ENTIRE', ' roll.msh', '!CONTROL, NAME=fstrCNT', ' roll.cnt', '!RESULT, NAME=fstrRES, IO=OUT', ' roll.res'].join('\n') + '\n');

  // ── what compare2d.mjs needs ──
  const ref = {
    params: { R, h0, h1, mu: p.mu, Estrip: p.Estrip, nuStrip: p.nuStrip, Eroll: p.Eroll, nuRoll: p.nuRoll, lmnL: p.lmnL, lmnM: p.lmnM, lmnN: p.lmnN, backTension: p.backTension, frontTension: p.frontTension, entryStrain: p.entryStrain ?? 0, reduction: p.reduction },
    patch, opts: O, yc, Lc, xHead, tz, nx, ny, x0: Array.from({ length: nx + 1 }, (_, i) => xHead - O.len + (O.len * i) / nx),
    // the slave stations: the strip's top nodes (both z), with their initial x
    slave: Array.from({ length: nx + 1 }, (_, i) => ({ i, nodes: [S(i, ny, 0), S(i, ny, 1)], x0: nodes[S(i, ny, 0) - 1][0] })),
    head: ng.HEAD, tail: ng.TAIL, bore: boreStations.map((b) => b.nodes),
    // the turn: substep counter → roll angle, so a result file's step maps to θ
    steps: [{ sub: subAll, th0: 0, dth: thAll, screw: O.screw, t1 }],
    freq: O.freq, uPush,
    mesh: { strip: { nodes: (nx + 1) * (ny + 1) * 2, hex: hexStrip.length }, roll: { nodes: nPsi * (nr + 1) * 2, hex: hexRoll.length, stations: nPsi, layers: nr } },
  };
  writeFileSync(`${out}/reference.json`, JSON.stringify(ref));
  const summary = `strip2d: R ${(R * 1e3).toFixed(0)} mm, ${(h0 * 1e3).toFixed(3)} → ${(h1 * 1e3).toFixed(3)} mm, μ ${p.mu}, contact ${(Lc * 1e3).toFixed(1)} mm; strip ${ref.mesh.strip.nodes} nodes (${nx} × ${ny}), roll ${ref.mesh.roll.nodes} nodes (${nPsi} × ${nr}); turn ${O.theta1} + ${O.theta2} rad = ${((thetaTot * R) * 1e3).toFixed(1)} mm of surface, ${subAll} substeps (the screw down over the first ${O.sub1}); ${boreStations.length * 2} amplitude tables → ${out}`;
  return { ref, summary, nodes: nodes.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? new URL('run/strip2d', import.meta.url).pathname;
  const patch = JSON.parse(process.argv[3] ?? '{}');
  const opts = JSON.parse(process.argv[4] ?? '{}');
  const { summary } = buildStrip2d(patch, out, opts);
  console.log(summary);
}

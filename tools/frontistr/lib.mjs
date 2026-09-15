// The FrontISTR cross-check as functions: build a case from the roll model's converged pass,
// read FrontISTR's result, and set the two side by side. case.mjs and compare.mjs are the
// command-line faces of these; bridge.mjs serves them to the app.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { halfCylinderMesh, meshText } from './mesh.mjs';

const B = new URL('../sim3d/build/', import.meta.url);
export const TONF = 9.80665e3;
/** the roll model's chock spring (solver.ts K_CHOCK_Y) [N/m] */
const K_CHOCK = 1e6;

/**
 * The roll model, from tools/sim3d/build (node tools/build-esm.mjs sim3d). Imported under the
 * build's own modification time, so a rebuilt solver is picked up by a long-running process.
 */
export async function loadModel() {
  const v = statSync(new URL('solver.js', B)).mtimeMs;
  const { StackSolver } = await import(new URL(`solver.js?v=${v}`, B));
  const { defaultParams, radiusProfile } = await import(new URL(`stack.js?v=${v}`, B));
  return { StackSolver, defaultParams, radiusProfile };
}

/**
 * Write a FrontISTR case for `mill` ('2hi' | '4hi') into `out`: roll.msh, roll.cnt,
 * hecmw_ctrl.dat and reference.json (the roll model's answer at the same stations).
 *
 * 2Hi: the work roll as a solid under the strip load the slab slices found, its bearing
 * cross-section held, symmetry on x = 0 and z = 0. 4Hi: the work roll and the backup roll,
 * touching at the centre line, in contact (the work roll's top nodes on the backup roll's
 * bottom faces, augmented Lagrange, no friction); the backup roll's bearing section held, the
 * work roll's chock a spring as soft as the roll model's (K_CHOCK_Y), the strip load ramped in
 * substeps.
 *
 * The strip load q(x) is prescribed to both models (the slab slices' converged load, over the
 * same Hertz half-width b(x) the roll model flattens with), so what differs is the roll
 * mechanics alone: Timoshenko beams with neck steps and point supports against solids, the
 * line-contact flattening and roll-to-roll contact laws against the solids' surfaces. The
 * bearing is the beam's - the whole cross-section at the support station held in y (a plane
 * section pinned, as a beam node is) - so deflections are read against the same support.
 *
 * `patch` overrides the mill's default parameters; the grid is the gate's (81 stations, the
 * strip on the roll's nodes, 8 elements along the arc) unless the patch says otherwise.
 */
export async function buildCase(mill, patch, out) {
  if (mill !== '2hi' && mill !== '4hi') throw new Error('mill: 2hi or 4hi');
  mkdirSync(out, { recursive: true });
  const { StackSolver, defaultParams, radiusProfile } = await loadModel();

  // ── the roll model's pass ──
  const p = { ...defaultParams(mill), stations: 81, stripStations: 0, stripNz: 8, ...patch, mill };
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 600; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  const R = sv.result, st = sv.stack;
  if (!R.converged) throw new Error('the roll model did not converge');
  const ns = R.x.length, c = (ns - 1) / 2;
  const wrDef = st.rolls[st.wr], wr = sv.rolls[st.wr];
  const burIdx = mill === '4hi' ? st.rolls.findIndex((r) => r.id === 'BUR') : -1;
  const burDef = burIdx >= 0 ? st.rolls[burIdx] : null, bur = burIdx >= 0 ? sv.rolls[burIdx] : null;

  /** the stations of a roll's mesh: the grid's from the centre out to the roll's last station, with the barrel step's transition */
  function stationsOf(def, roll) {
    const xs = [];
    for (let s = c; s <= roll.ib; s++) xs.push(R.x[s]);
    const eb = def.Lb / 2;
    for (const w of [eb, eb + 0.005]) if (!xs.some((v) => Math.abs(v - w) < 1e-9)) xs.push(w);
    xs.sort((a, b) => a - b);
    const station = xs.map((x) => { for (let s = c; s < ns; s++) if (Math.abs(R.x[s] - x) < 1e-9) return s; return -1; });
    const support = R.x[roll.supports[roll.supports.length - 1]];
    const iSupport = xs.findIndex((x) => Math.abs(x - support) < 1e-9);
    if (iSupport < 0) throw new Error(`${def.id}: the support station ${support} is not on the mesh`);
    return { xs, station, iSupport, support };
  }
  /** the roll's radius along x: the barrel with its ground and thermal crown, then the neck */
  const radiusOf = (def) => (x) => (x <= def.Lb / 2 + 1e-9 ? def.D / 2 + radiusProfile(def, x) : def.Dn / 2);
  const meshOpts = { arcCell: 1.0e-3, arcFine: 0.030, arcGrowth: 1.25, arcMax: 0.040, layer0: 1.5e-3, layerGrowth: 1.5 };

  // ── the work roll ──
  const W = stationsOf(wrDef, wr);
  const mW = halfCylinderMesh({ ...meshOpts, xs: W.xs, radiusAt: radiusOf(wrDef), R0: wrDef.D / 2, cy: 0, fineTop: mill === '4hi' });
  const bodies = [{ name: 'WR', mesh: mW }];
  // ── the backup roll, touching the work roll on the centre line ──
  let Bk = null, mB = null;
  if (burDef) {
    Bk = stationsOf(burDef, bur);
    const cy = radiusOf(wrDef)(0) + radiusOf(burDef)(0);
    mB = halfCylinderMesh({ ...meshOpts, layer0: 2e-3, layerGrowth: 1.6, xs: Bk.xs, radiusAt: radiusOf(burDef), R0: burDef.D / 2, cy, nodeStart: mW.nodeStart + mW.nodes.length, elemStart: mW.elemEnd + 1, fineTop: false });
    bodies.push({ name: 'BUR', mesh: mB });
  }

  // ── the strip load: the slices' q over the Hertz half-width b the roll model uses ──
  const law = sv.wsLaw;
  const bAt = (q, arc) => Math.max(Math.sqrt(law.bCoef * Math.max(q, 0)), arc / 2, 1e-6);
  const G = (u) => (u * Math.sqrt(Math.max(0, 1 - u * u)) + Math.asin(Math.max(-1, Math.min(1, u)))) / 2;
  const loads = [];
  let Fsum = 0;
  const RW = wrDef.D / 2;
  for (let i = 0; i < W.xs.length; i++) {
    const s = W.station[i];
    if (s < 0 || !Number.isFinite(R.q[s]) || R.q[s] <= 0) continue;
    const q = R.q[s], b = bAt(q, R.arc[s]);
    // the station's share of the strip along x: its cell's overlap with the strip (the slice
    // weight the roll model sums the force with), halved at x = 0 where only x ≥ 0 is modelled
    const dx = sv.sliceW[s] * (i === 0 ? 0.5 : 1);
    const p0 = (2 * q) / (Math.PI * b);
    for (let k = 0; k < mW.nk; k++) {
      const sk = mW.phi[k] * RW;
      const sLo = k === 0 ? 0 : 0.5 * (mW.phi[k - 1] + mW.phi[k]) * RW;
      const sHi = k + 1 < mW.nk ? 0.5 * (mW.phi[k] + mW.phi[k + 1]) * RW : sk;
      if (sLo >= b) break;
      const F = p0 * b * (G(Math.min(sHi, b) / b) - G(sLo / b)) * dx; // on this node's patch, into the roll
      if (F <= 0) continue;
      const ph = mW.phi[k];
      loads.push([mW.id(i, mW.nr, k), F * Math.cos(ph), -F * Math.sin(ph)]);
      Fsum += F * Math.cos(ph);
    }
  }

  // ── groups ──
  const ng = { XSYM: [], ZSYM: [] };
  const lists = {};
  const collect = (name, m, S) => {
    const L = { axis: [], bottom: [], top: [], support: [] };
    for (let i = 0; i < S.xs.length; i++) {
      L.axis.push(m.id(i, 0, 0));
      for (let j = 0; j <= m.nr; j++) {
        for (let k = 0; k < (j === 0 ? 1 : m.nk); k++) {
          const n = m.id(i, j, k);
          if (i === 0) ng.XSYM.push(n);
          if (j === 0 || k === 0 || k === m.nk - 1) ng.ZSYM.push(n);
          if (i === S.iSupport) L.support.push(n);
        }
      }
      L.bottom.push(m.id(i, m.nr, 0)); L.top.push(m.id(i, m.nr, m.nk - 1));
    }
    lists[name] = L;
  };
  collect('WR', mW, W);
  if (mB) collect('BUR', mB, Bk);
  const sg = {}, pairs = {};
  const slaveByStation = [];
  if (mB) {
    ng.BRG = lists.BUR.support;   // the backup roll's bearing section, held
    ng.CHOCK = lists.WR.support;  // the work roll's chock section, on the soft spring
    // the contact zone: the work roll's top within 40 mm of its top line, the backup roll's bottom faces within 60 mm of its bottom line
    const slave = [];
    for (let i = 0; i < W.xs.length; i++) {
      if (W.xs[i] > wrDef.Lb / 2 + 1e-9) break;
      const here = [];
      for (let k = 0; k < mW.nk; k++) if ((Math.PI - mW.phi[k]) * RW <= 0.040 + 1e-9) here.push(mW.id(i, mW.nr, k));
      slave.push(...here); slaveByStation.push(here);
    }
    ng.SLAVE = slave;
    const master = [];
    const RB = burDef.D / 2;
    for (let i = 0; i + 1 < Bk.xs.length; i++) {
      if (Bk.xs[i] > burDef.Lb / 2 - 1e-9) break;
      for (let k = 0; k + 1 < mB.nk; k++) if (mB.phi[k + 1] * RB <= 0.060 + 1e-9) master.push(mB.outerFace(i, k));
    }
    sg.MASTER = master;
    pairs.CP1 = ['SLAVE', 'MASTER'];
  } else {
    ng.BRG = lists.WR.support;
  }
  writeFileSync(`${out}/roll.msh`, meshText(bodies, { header: `ROLL FEM LAB ${mill.toUpperCase()}`, E: wrDef.E, nu: wrDef.nu, ngroups: ng, sgroups: sg, contactPairs: pairs }));

  // ── the control file ──
  const cnt = ['!VERSION', ' 3'];
  if (mB) {
    cnt.push('!SOLUTION, TYPE=NLSTATIC', '!WRITE, RESULT',
      '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' CONTACT_NFORCE, ON', ' NSTRESS, OFF', ' NMISES, OFF',
      '!BOUNDARY, GRPID=1', ' XSYM, 1, 1, 0.0', ' ZSYM, 3, 3, 0.0', ' BRG, 2, 2, 0.0',
      '!SPRING, GRPID=1', ...ng.CHOCK.map((n) => ` ${n}, 2, ${(K_CHOCK / ng.CHOCK.length).toPrecision(6)}`),
      '!CLOAD, GRPID=1', ...loads.flatMap(([n, fy, fz]) => [` ${n}, 2, ${fy.toPrecision(9)}`, ` ${n}, 3, ${fz.toPrecision(9)}`]),
      '!CONTACT_ALGO, TYPE=ALAGRANGE',
      '!CONTACT, GRPID=1', ' CP1, 0.0',
      '!STEP, SUBSTEPS=4, CONVERG=1.0e-5, MAXITER=50', ' BOUNDARY, 1', ' LOAD, 1', ' CONTACT, 1',
      '!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES', ' 30000, 1', ' 1.0e-7, 1.0, 0.0');
  } else {
    cnt.push('!SOLUTION, TYPE=STATIC', '!WRITE, RESULT',
      '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' NSTRESS, OFF', ' NMISES, OFF',
      '!BOUNDARY', ' XSYM, 1, 1, 0.0', ' ZSYM, 3, 3, 0.0', ' BRG, 2, 2, 0.0',
      '!CLOAD', ...loads.flatMap(([n, fy, fz]) => [` ${n}, 2, ${fy.toPrecision(9)}`, ` ${n}, 3, ${fz.toPrecision(9)}`]),
      '!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES', ' 20000, 1', ' 1.0e-8, 1.0, 0.0');
  }
  cnt.push('!END');
  writeFileSync(`${out}/roll.cnt`, cnt.join('\n') + '\n');
  writeFileSync(`${out}/hecmw_ctrl.dat`, ['!MESH, NAME=fstrMSH, TYPE=HECMW-ENTIRE', ' roll.msh', '!CONTROL, NAME=fstrCNT', ' roll.cnt', '!RESULT, NAME=fstrRES, IO=OUT', ' roll.res'].join('\n') + '\n');

  // ── the roll model's answer at the same stations, for compare ──
  const at = (arr, s) => (s >= 0 && Number.isFinite(arr[s]) ? arr[s] : null);
  const wrSup = wr.supports[wr.supports.length - 1], burSup = bur ? bur.supports[bur.supports.length - 1] : -1;
  const ref = {
    mill, params: patch, iterations: it, force: R.force, screw: R.screw, quarterForce: R.force / 4, loadSumY: Fsum,
    rolls: { WR: { D: wrDef.D, Dn: wrDef.Dn, Lb: wrDef.Lb, Ls: wrDef.Ls, support: W.support }, ...(burDef ? { BUR: { D: burDef.D, Dn: burDef.Dn, Lb: burDef.Lb, Ls: burDef.Ls, support: Bk.support } } : {}) },
    WR: {
      x: W.xs, station: W.station, iSupport: W.iSupport, nodes: lists.WR,
      // the work roll's axis against the held support: its own on a 2Hi, the backup roll's bearing on a 4Hi
      v: W.station.map((s) => (s >= 0 ? wr.v[s] - (bur ? bur.v[burSup] : wr.v[wrSup]) : null)),
      flat: W.station.map((s) => at(R.flat, s)), q: W.station.map((s) => at(R.q, s)),
      b: W.station.map((s) => (s >= 0 && Number.isFinite(R.q[s]) && R.q[s] > 0 ? bAt(R.q[s], R.arc[s]) : null)),
      h1: W.station.map((s) => at(R.h1, s)),
      // the barrel's radius deviation (ground and thermal crown) at each station: geometry the FEM's displacements leave out
      prof: W.xs.map((x) => (x <= wrDef.Lb / 2 + 1e-9 ? radiusProfile(wrDef, x) : 0)),
      dx: W.xs.map((x, i) => (i === 0 ? 0.5 * W.xs[1] : i + 1 < W.xs.length ? 0.5 * (W.xs[i + 1] - W.xs[i - 1]) : W.xs[i] - W.xs[i - 1])),
    },
    ...(bur ? {
      BUR: {
        x: Bk.xs, station: Bk.station, iSupport: Bk.iSupport, nodes: lists.BUR,
        v: Bk.station.map((s) => (s >= 0 ? bur.v[s] - bur.v[burSup] : null)),
      },
      contact: {
        q: W.station.map((s) => at(sv.contacts[0].q, s)), delta: W.station.map((s) => at(sv.contacts[0].delta, s)),
        slaveByStation,
      },
    } : {}),
    mesh: bodies.map((b) => ({ name: b.name, nodes: b.mesh.nodes.length, hex: b.mesh.hex.length, prism: b.mesh.prism.length, stations: b.mesh.ni, layers: b.mesh.nr, angles: b.mesh.nk - 1 })),
  };
  writeFileSync(`${out}/reference.json`, JSON.stringify(ref));
  const nn = bodies.reduce((a, b) => a + b.mesh.nodes.length, 0);
  const summary = `${mill}: ${it} iterations, F ${(R.force / TONF).toFixed(1)} tonf; ${ref.mesh.map((m) => `${m.name} ${m.nodes} nodes (${m.stations} × ${m.layers} × ${m.angles})`).join(', ')} = ${nn} nodes; strip load on the quarter ${(Fsum / TONF).toFixed(2)} tonf (F/4 = ${(R.force / 4 / TONF).toFixed(2)}); ${loads.length} loaded nodes${mB ? `; contact: ${ng.SLAVE.length} slave nodes, ${sg.MASTER.length} master faces` : ''} → ${out}`;
  return { ref, summary, nodes: nn, loadedNodes: loads.length };
}

/** the fstrresult 2.0 text: per node, the labelled vectors */
export function parseRes(text) {
  const L = text.split('\n');
  let i = L.indexOf('*data') + 1;
  const [nn] = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const [nNodeTypes] = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const sizes = L[i++].split(/\s+/).filter(Boolean).map(Number);
  const labels = [];
  for (let k = 0; k < nNodeTypes; k++) labels.push(L[i++].trim());
  const per = sizes.reduce((a, b) => a + b, 0);
  const node = new Map();
  for (let n = 0; n < nn; n++) {
    const id = Number(L[i++].trim());
    const vals = [];
    while (vals.length < per) vals.push(...L[i++].split(/\s+/).filter(Boolean).map(Number));
    const rec = {};
    let o = 0;
    labels.forEach((lab, k) => { rec[lab] = vals.slice(o, o + sizes[k]); o += sizes[k]; });
    node.set(id, rec);
  }
  return { node, labels };
}

/** the last roll.res.0.N in a case directory (fistr1 numbers the steps), and its parsed content */
export function readResult(dir) {
  const resFile = readdirSync(dir).filter((f) => /^roll\.res\.0\.\d+$/.test(f)).sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop())).pop();
  if (!resFile) throw new Error(`no roll.res.0.N in ${dir}`);
  return { resFile, res: parseRes(readFileSync(`${dir}/${resFile}`, 'utf8')) };
}

/**
 * 2Hi, per station: the work roll's axis deflection against its bearing and the indentation
 * under the strip, the roll model's and FrontISTR's. Indentation is read as the bottom
 * surface's rise against the top surface's: in a solid the bending's transverse (Poisson)
 * strain, −ν κ R²/2, moves both surfaces against the axis by the same amount, and that reading
 * cancels it (the roll model's flattening is the local part only). [m], [N/m]
 */
export function compare2hi(ref, res) {
  const W = ref.WR;
  const disp = (n) => res.node.get(n).DISPLACEMENT;
  const vB = disp(W.nodes.axis[W.iSupport])[1];
  let bearingReaction = 0;
  // fistr1 labels the reactions REACTION_FORCE (older results said REACTION)
  for (const n of W.nodes.support) { const r = res.node.get(n); bearingReaction += (r.REACTION_FORCE ?? r.REACTION)?.[1] ?? 0; }
  const x = [], q = [], b = [], vModel = [], vFem = [], flatModel = [], flatFem = [], flatAxis = [];
  const worst = { v: 0, vRel: 0, flat: 0 };
  for (let i = 0; i < W.x.length; i++) {
    const a = disp(W.nodes.axis[i]), s = disp(W.nodes.bottom[i]), t = disp(W.nodes.top[i]);
    const vF = a[1] - vB, fF = s[1] - t[1];
    const vM = W.v[i], fM = W.flat[i];
    x.push(W.x[i]); q.push(W.q[i]); b.push(W.b[i]);
    vModel.push(vM); vFem.push(vF); flatModel.push(fM); flatFem.push(fF); flatAxis.push(s[1] - a[1]);
    if (vM !== null) { worst.v = Math.max(worst.v, Math.abs(vF - vM)); if (Math.abs(vM) > 1e-4) worst.vRel = Math.max(worst.vRel, Math.abs(vF - vM) / Math.abs(vM)); }
    if (fM !== null && W.q[i] > 0) worst.flat = Math.max(worst.flat, Math.abs(fF - fM));
  }
  return { x, q, b, vModel, vFem, flatModel, flatFem, flatAxis, worst, bearingReaction, loadSumY: ref.loadSumY, force: ref.force, iterations: ref.iterations, nodes: ref.mesh.reduce((n, m) => n + m.nodes, 0) };
}

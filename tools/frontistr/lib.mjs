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
 * The coarser solid the app solves the 4Hi and 6Hi with: 2 mm cells at the contact lines
 * growing to 60 mm, 3 mm surface layers, half the roll model's stations, two load steps.
 * A 4Hi answers in ~1 min against ~26 min on the fine mesh, within 10 µm of it.
 */
const QUICK_MESH = { arcCell: 2.0e-3, arcFine: 0.020, arcGrowth: 1.4, arcMax: 0.060, layer0: 3e-3, layerGrowth: 1.8 };
export const QUICK = {
  '2hi': {},
  '4hi': { mesh: QUICK_MESH, substeps: 2 },
  // The 6Hi spans the whole length with three bodies: coarser still around the circumference
  // and through the radius, but not along the axis - with half the stations a barrel end
  // falls between two node rings and the contact load there is 20 % off.
  '6hi': { mesh: { arcCell: 3.0e-3, arcFine: 0.020, arcGrowth: 1.5, arcMax: 0.080, layer0: 4e-3, layerGrowth: 2.0 }, substeps: 2 },
};

/** the mills a case can be built for, and whether the case spans the whole roll length */
export const MILLS = { '2hi': { full: false }, '4hi': { full: false }, '6hi': { full: true } };

/**
 * Write a FrontISTR case for `mill` ('2hi' | '4hi' | '6hi') into `out`: roll.msh, roll.cnt,
 * hecmw_ctrl.dat and reference.json (the roll model's answer at the same stations).
 *
 * The rolls of the upper half as solids, each a stepped cylinder: barrel with its ground and
 * thermal crown, then the neck. 2Hi: the work roll under the strip load the slab slices found,
 * its bearing cross-section held. 4Hi / 6Hi: the rolls touching on the centre line, in contact
 * (the lower roll's top nodes on the upper roll's bottom faces, augmented Lagrange, no
 * friction); the screw roll's bearing sections held, the chocked rolls' chock sections on a
 * spring as soft as the roll model's (K_CHOCK_Y) with their bender forces (both halved: the
 * section is the z ≥ 0 half of the chock's), the strip load
 * ramped in substeps. 2Hi and 4Hi are symmetric about x = 0 and model the x ≥ 0 half; the 6Hi's
 * shifted intermediate roll is not, so its case spans the whole length. All model the z ≥ 0
 * half (symmetry about the plane of the roll axes).
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
 * `opts.mesh` overrides the mesh's cell sizes (a coarser solid for a quicker answer),
 * `opts.substeps` the contact's load steps (4), `opts.full` whether to span the whole length.
 */
export async function buildCase(mill, patch, out, opts = {}) {
  if (!MILLS[mill]) throw new Error(`mill: ${Object.keys(MILLS).join(', ')}`);
  const full = opts.full ?? MILLS[mill].full;
  const substeps = opts.substeps ?? 4;
  mkdirSync(out, { recursive: true });
  const { StackSolver, defaultParams, radiusProfile } = await loadModel();

  // ── the roll model's pass ──
  const p = { ...defaultParams(mill), stations: 81, stripStations: 0, stripNz: 8, ...patch, ...(opts.stations ? { stations: opts.stations } : {}), mill };
  const sv = new StackSolver(p);
  let it = 0;
  for (let f = 0; f < 600; f++) { sv.advance(1e9, 6); it += sv.result.iterations; if (sv.isConverged) break; }
  const R = sv.result, st = sv.stack;
  if (!R.converged) throw new Error('the roll model did not converge');
  const ns = R.x.length, c = (ns - 1) / 2;
  // the upper half's rolls, bottom up: the work roll first, the screw roll last
  const up = R.rolls.length;
  const defs = st.rolls.slice(0, up), rolls = sv.rolls.slice(0, up);
  const screwIdx = defs.findIndex((d) => d.support === 'screw');
  if (screwIdx < 0) throw new Error('no screw roll');
  // the contact pairs of the upper half, lower roll first
  const pairs = st.contacts.filter((k) => k.a < up && k.b < up).map((k) => (k.a < k.b ? [k.a, k.b] : [k.b, k.a]));

  /** where a roll's barrel ends, with the 5 mm step to its neck: the stations a mesh needs there */
  const barrelEnds = (def) => {
    const eb = def.Lb / 2;
    return full ? [def.shift - eb - 0.005, def.shift - eb, def.shift + eb, def.shift + eb + 0.005] : [eb, eb + 0.005];
  };
  /**
   * The stations of a roll's mesh: the grid's over the roll (from the centre out on a half
   * model), with the barrel ends' transitions - its own, and those of the rolls it touches, so
   * a contact ends on a node ring where the partner's barrel ends (a 6Hi's shifted intermediate
   * roll ends inside the work roll's barrel; without its ring the contact would stop a cell short).
   */
  function stationsOf(def, roll, partners) {
    const xs = [];
    for (let s = full ? roll.ia : c; s <= roll.ib; s++) xs.push(R.x[s]);
    const lo = xs[0], hi = xs[xs.length - 1];
    const ends = [...barrelEnds(def), ...partners.flatMap(barrelEnds)];
    for (const w of ends) if (w > lo - 1e-9 && w < hi + 1e-9 && !xs.some((v) => Math.abs(v - w) < 1e-9)) xs.push(w);
    xs.sort((a, b) => a - b);
    const station = xs.map((x) => { for (let s = roll.ia; s <= roll.ib; s++) if (Math.abs(R.x[s] - x) < 1e-9) return s; return -1; });
    const sups = full ? roll.supports : [roll.supports[roll.supports.length - 1]];
    const supports = sups.map((s) => R.x[s]);
    const iSupports = supports.map((x) => xs.findIndex((v) => Math.abs(v - x) < 1e-9));
    if (iSupports.some((i) => i < 0)) throw new Error(`${def.id}: a support station (${supports.join(', ')}) is not on the mesh`);
    return { xs, station, iSupports, supports, sups };
  }
  /** the roll's radius along x: the barrel with its ground and thermal crown, then the neck */
  const radiusOf = (def) => (x) => (Math.abs(x - def.shift) <= def.Lb / 2 + 1e-9 ? def.D / 2 + radiusProfile(def, x) : def.Dn / 2);
  const inBarrel = (def, x, tol = 1e-9) => Math.abs(x - def.shift) <= def.Lb / 2 + tol;
  const meshOpts = { arcCell: 1.0e-3, arcFine: 0.030, arcGrowth: 1.25, arcMax: 0.040, layer0: 1.5e-3, layerGrowth: 1.5, ...(opts.mesh ?? {}) };

  // ── the bodies, bottom up ──
  const S = [], M = [], bodies = [];
  let nodeStart = 1, elemStart = 1, cy = 0;
  for (let r = 0; r < up; r++) {
    const def = defs[r];
    S[r] = stationsOf(def, rolls[r], pairs.filter((q) => q.includes(r)).map((q) => defs[q[0] === r ? q[1] : q[0]]));
    // each roll touching the one below on the centre line, crowns included (the stack's own
    // `cy` is the nominal radii's; the model carries the crowns in the gap instead)
    if (r > 0) cy += radiusOf(defs[r - 1])(0) + radiusOf(def)(0);
    // a roll with another above it is fine-meshed at its top as well as its bottom; the
    // backup roll's layers a little coarser (it is the biggest body)
    const own = r === screwIdx && r > 0 ? { layer0: 2e-3, layerGrowth: 1.6, ...(opts.mesh ?? {}) } : {};
    M[r] = halfCylinderMesh({ ...meshOpts, ...own, xs: S[r].xs, radiusAt: radiusOf(def), R0: def.D / 2, cy, nodeStart, elemStart, fineTop: pairs.some((q) => q[0] === r) });
    nodeStart += M[r].nodes.length; elemStart = M[r].elemEnd + 1;
    bodies.push({ name: def.id, mesh: M[r] });
  }
  const wrDef = defs[0], mW = M[0], W = S[0];

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
    // weight the roll model sums the force with), halved at x = 0 on a half model
    const dx = sv.sliceW[s] * (!full && i === 0 ? 0.5 : 1);
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
  const ng = {};
  if (!full) ng.XSYM = [];
  ng.ZSYM = [];
  const lists = [];
  for (let r = 0; r < up; r++) {
    const m = M[r], Sr = S[r];
    const L = { axis: [], bottom: [], top: [], support: Sr.iSupports.map(() => []) };
    for (let i = 0; i < Sr.xs.length; i++) {
      L.axis.push(m.id(i, 0, 0));
      for (let j = 0; j <= m.nr; j++) {
        for (let k = 0; k < (j === 0 ? 1 : m.nk); k++) {
          const n = m.id(i, j, k);
          if (!full && i === 0) ng.XSYM.push(n);
          if (j === 0 || k === 0 || k === m.nk - 1) ng.ZSYM.push(n);
          Sr.iSupports.forEach((iS, q) => { if (i === iS) L.support[q].push(n); });
        }
      }
      L.bottom.push(m.id(i, m.nr, 0)); L.top.push(m.id(i, m.nr, m.nk - 1));
    }
    lists[r] = L;
  }
  // the screw roll's bearing sections held; the chocked rolls' chock sections on springs, with their benders
  ng.BRG = lists[screwIdx].support.flat();
  // A whole-length case has no symmetry plane to hold the rolls along x, and frictionless
  // contacts and y springs leave each free to slide: one node of each - its axis at the first
  // support station - is held axially (the half case's x = 0 plane does this). One node, not
  // the section: a plane section held in x cannot rotate, and that would clamp the bearing
  // and stop a chocked roll tilting.
  if (full) ng.XHOLD = M.map((m, r) => m.id(S[r].iSupports[0], 0, 0));
  // A chock section here is the z ≥ 0 half of the roll's: it takes half the chock's spring and
  // half its bender force, as the half arc takes half the strip load (q/2). The whole force on
  // the half section bent the solid with twice the model's bender (60 tonf/chock: 7.5 % more
  // load through the held bearing than the strip and the bender put in, T101).
  const springs = [], benders = [];
  let benderSumY = 0;
  for (let r = 0; r < up; r++) {
    if (defs[r].support !== 'chock') continue;
    const name = up === 2 ? 'CHOCK' : `CHOCK_${defs[r].id}`;
    ng[name] = lists[r].support.flat();
    for (const sec of lists[r].support) {
      for (const n of sec) springs.push([n, K_CHOCK / 2 / sec.length]);
      if (defs[r].benderForce) for (const n of sec) { benders.push([n, defs[r].benderForce / 2 / sec.length]); benderSumY += defs[r].benderForce / 2 / sec.length; }
    }
  }
  // the contact zones: the lower roll's top within 40 mm of its top line, the upper roll's
  // bottom faces within 60 mm of its bottom line, over the barrels
  const sg = {}, cpairs = {};
  const contacts = [];
  pairs.forEach(([a, b], q) => {
    const mA = M[a], mB = M[b], dA = defs[a], dB = defs[b], RA = dA.D / 2, RB = dB.D / 2;
    const slave = [], slaveByStation = [];
    for (let i = 0; i < S[a].xs.length; i++) {
      if (!inBarrel(dA, S[a].xs[i])) { slaveByStation.push(null); continue; }
      const here = [];
      for (let k = 0; k < mA.nk; k++) if ((Math.PI - mA.phi[k]) * RA <= 0.040 + 1e-9) here.push(mA.id(i, mA.nr, k));
      slave.push(...here); slaveByStation.push(here);
    }
    const master = [];
    for (let i = 0; i + 1 < S[b].xs.length; i++) {
      // the faces whose near end is on the barrel (the last one ends at the barrel end)
      if (!inBarrel(dB, S[b].xs[i], -1e-9) || !inBarrel(dB, S[b].xs[i + 1], 1e-9)) continue;
      for (let k = 0; k + 1 < mB.nk; k++) if (mB.phi[k + 1] * RB <= 0.060 + 1e-9) master.push(mB.outerFace(i, k));
    }
    const sName = pairs.length === 1 ? 'SLAVE' : `SLAVE${q + 1}`, mName = pairs.length === 1 ? 'MASTER' : `MASTER${q + 1}`;
    ng[sName] = slave; sg[mName] = master; cpairs[`CP${q + 1}`] = [sName, mName];
    contacts.push({ a, b, label: `${dA.id}–${dB.id}`, slaveByStation });
  });
  writeFileSync(`${out}/roll.msh`, meshText(bodies, { header: `ROLL FEM LAB ${mill.toUpperCase()}`, E: wrDef.E, nu: wrDef.nu, ngroups: ng, sgroups: sg, contactPairs: cpairs }));

  // ── the control file ──
  const cnt = ['!VERSION', ' 3'];
  const bc = [' ZSYM, 3, 3, 0.0', ' BRG, 2, 2, 0.0'];
  if (full) bc.push(' XHOLD, 1, 1, 0.0'); else bc.unshift(' XSYM, 1, 1, 0.0');
  const cload = [...loads.flatMap(([n, fy, fz]) => [` ${n}, 2, ${fy.toPrecision(9)}`, ` ${n}, 3, ${fz.toPrecision(9)}`]), ...benders.map(([n, fy]) => ` ${n}, 2, ${fy.toPrecision(9)}`)];
  if (pairs.length) {
    cnt.push('!SOLUTION, TYPE=NLSTATIC', '!WRITE, RESULT',
      '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' CONTACT_NFORCE, ON', ' NSTRESS, OFF', ' NMISES, OFF',
      '!BOUNDARY, GRPID=1', ...bc,
      '!SPRING, GRPID=1', ...springs.map(([n, k]) => ` ${n}, 2, ${k.toPrecision(6)}`),
      '!CLOAD, GRPID=1', ...cload,
      '!CONTACT_ALGO, TYPE=ALAGRANGE',
      '!CONTACT, GRPID=1', ...Object.keys(cpairs).map((name) => ` ${name}, 0.0`),
      `!STEP, SUBSTEPS=${substeps}, CONVERG=1.0e-5, MAXITER=50`, ' BOUNDARY, 1', ' LOAD, 1', ' CONTACT, 1',
      '!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES', ' 30000, 1', ' 1.0e-7, 1.0, 0.0');
  } else {
    cnt.push('!SOLUTION, TYPE=STATIC', '!WRITE, RESULT',
      '!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' NSTRESS, OFF', ' NMISES, OFF',
      '!BOUNDARY', ...bc,
      '!CLOAD', ...cload,
      '!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES', ' 20000, 1', ' 1.0e-8, 1.0, 0.0');
  }
  cnt.push('!END');
  writeFileSync(`${out}/roll.cnt`, cnt.join('\n') + '\n');
  writeFileSync(`${out}/hecmw_ctrl.dat`, ['!MESH, NAME=fstrMSH, TYPE=HECMW-ENTIRE', ' roll.msh', '!CONTROL, NAME=fstrCNT', ' roll.cnt', '!RESULT, NAME=fstrRES, IO=OUT', ' roll.res'].join('\n') + '\n');

  // ── the roll model's answer at the same stations, for compare ──
  const at = (arr, s) => (s >= 0 && Number.isFinite(arr[s]) ? arr[s] : null);
  // deflections against the held bearing: the screw roll's support(s) - the beam's own on a 2Hi
  const screw = rolls[screwIdx];
  const vRef = S[screwIdx].sups.reduce((a, s) => a + screw.v[s], 0) / S[screwIdx].sups.length;
  const refRolls = defs.map((def, r) => ({
    id: def.id, x: S[r].xs, station: S[r].station, iSupports: S[r].iSupports, supports: S[r].supports, nodes: lists[r],
    D: def.D, Dn: def.Dn, Lb: def.Lb, Ls: def.Ls, shift: def.shift, support: def.support, bender: def.benderForce,
    v: S[r].station.map((s) => (s >= 0 ? rolls[r].v[s] - vRef : null)),
    // the barrel's radius deviation (ground and thermal crown) at each station: geometry the FEM's displacements leave out
    prof: S[r].xs.map((x) => (inBarrel(def, x) ? radiusProfile(def, x) : 0)),
    dx: S[r].xs.map((x, i, xs) => (i === 0 ? (full ? xs[1] - xs[0] : 0.5 * xs[1]) : i + 1 < xs.length ? 0.5 * (xs[i + 1] - xs[i - 1]) : xs[i] - xs[i - 1])),
  }));
  const ref = {
    mill, full, params: patch, iterations: it, force: R.force, screw: R.screw, quarterForce: R.force / (full ? 2 : 4), loadSumY: Fsum, benderSumY,
    screwRoll: screwIdx,
    rolls: refRolls,
    WR: {
      ...refRolls[0],
      flat: W.station.map((s) => at(R.flat, s)), q: W.station.map((s) => at(R.q, s)),
      b: W.station.map((s) => (s >= 0 && Number.isFinite(R.q[s]) && R.q[s] > 0 ? bAt(R.q[s], R.arc[s]) : null)),
      h1: W.station.map((s) => at(R.h1, s)),
    },
    contacts: contacts.map((k, q) => ({
      ...k, q: S[k.a].station.map((s) => at(sv.contacts[q].q, s)), delta: S[k.a].station.map((s) => at(sv.contacts[q].delta, s)),
      // the station's cell lies wholly on both barrels: where it does not, the model's load per
      // width is that of a partial cell while the solid's node ring is on the barrel or off it
      whole: S[k.a].station.map((s) => s >= 0 && sv.contacts[q].weight[s] >= (R.x[1] - R.x[0]) * 0.999),
    })),
    mesh: bodies.map((b) => ({ name: b.name, nodes: b.mesh.nodes.length, hex: b.mesh.hex.length, prism: b.mesh.prism.length, stations: b.mesh.ni, layers: b.mesh.nr, angles: b.mesh.nk - 1 })),
  };
  writeFileSync(`${out}/reference.json`, JSON.stringify(ref));
  const nn = bodies.reduce((a, b) => a + b.mesh.nodes.length, 0);
  const share = full ? 'half' : 'quarter';
  const summary = `${mill}: ${it} iterations, F ${(R.force / TONF).toFixed(1)} tonf; ${ref.mesh.map((m) => `${m.name} ${m.nodes} nodes (${m.stations} × ${m.layers} × ${m.angles})`).join(', ')} = ${nn} nodes; strip load on the ${share} ${(Fsum / TONF).toFixed(2)} tonf (F/${full ? 2 : 4} = ${(ref.quarterForce / TONF).toFixed(2)}); ${loads.length} loaded nodes${contacts.length ? `; contact: ${contacts.map((k, q) => `${k.label} ${ng[cpairs[`CP${q + 1}`][0]].length} slave nodes, ${sg[cpairs[`CP${q + 1}`][1]].length} master faces`).join(', ')}` : ''} → ${out}`;
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
 * The roll model against FrontISTR, per station (lengths in m, loads in N/m):
 * - every roll's axis deflection against the held bearing (the screw roll's support sections;
 *   the work roll's own on a 2Hi)
 * - every contact's line load: the lower roll's slave nodes' normal forces per station over
 *   the station's length, doubled for the z < 0 half
 * - on a 2Hi, the indentation under the strip: the model's flattening against the solid's
 *   bottom surface's rise against its top surface's (in a solid the bending's transverse
 *   (Poisson) strain, −ν κ R²/2, moves both surfaces against the axis by the same amount, and
 *   that reading cancels it; the model's flattening is the local part only)
 * - the exit profile the strip would see, Δh₁/2 against the centre: the work roll's bottom
 *   node's displacement against the centre's, less the barrel's radius deviation. The strip
 *   load sits on one node ring per station, so the solid's surface under a ring is a local
 *   dimple: a rough check where the load changes fast (near the strip edge)
 */
export function compareStack(ref, res) {
  const disp = (n) => res.node.get(n).DISPLACEMENT;
  // fistr1 labels the reactions REACTION_FORCE (older results said REACTION)
  const react = (n) => { const r = res.node.get(n); return (r.REACTION_FORCE ?? r.REACTION)?.[1] ?? 0; };
  // the largest difference, and it against the model's largest value (not station by
  // station: where the model reads near zero any difference is a large ratio)
  const worstOf = (model, fem, keep = () => true) => {
    let w = 0, big = 0;
    for (let i = 0; i < model.length; i++) {
      const m = model[i], f = fem[i];
      if (m === null || f === null || !Number.isFinite(m) || !Number.isFinite(f) || !keep(i)) continue;
      w = Math.max(w, Math.abs(f - m));
      big = Math.max(big, Math.abs(m));
    }
    return { abs: w, rel: big > 0 ? w / big : 0 };
  };
  const screw = ref.rolls[ref.screwRoll];
  const vRef = screw.iSupports.reduce((a, i) => a + disp(screw.nodes.axis[i])[1], 0) / screw.iSupports.length;
  let bearingReaction = 0;
  for (const sec of screw.nodes.support) for (const n of sec) bearingReaction += react(n);
  const rolls = ref.rolls.map((r) => {
    const vFem = r.nodes.axis.map((n) => disp(n)[1] - vRef);
    return { id: r.id, x: r.x, shift: r.shift, Lb: r.Lb, vModel: r.v, vFem, worst: worstOf(r.v, vFem) };
  });
  const contacts = ref.contacts.map((k) => {
    const A = ref.rolls[k.a];
    const qFem = A.x.map((_, i) => {
      const here = k.slaveByStation[i];
      if (!here) return null;
      let f = 0;
      for (const n of here) { const cf = res.node.get(n).CONTACT_NFORCE; if (cf) f += Math.abs(cf[1]); }
      return (2 * f) / A.dx[i];
    });
    // the end of a barrel carries a concentration in the solid the model spreads over the
    // station's cell: judged where the cell lies wholly on both barrels
    const whole = (i) => k.whole[i];
    return { a: k.a, b: k.b, label: k.label, x: A.x, qModel: k.q, qFem, whole: k.whole, worst: worstOf(k.q, qFem, whole) };
  });
  const W = ref.WR;
  let flat = null;
  if (!ref.contacts.length) {
    const fem = W.nodes.bottom.map((n, i) => disp(n)[1] - disp(W.nodes.top[i])[1]);
    flat = { model: W.flat, fem, worst: worstOf(W.flat, fem, (i) => (W.q[i] ?? 0) > 0) };
  }
  let exit = null;
  const i0 = W.x.findIndex((x) => Math.abs(x) < 1e-9);
  if (i0 >= 0 && W.h1[i0] !== null) {
    const wb0 = disp(W.nodes.bottom[i0])[1];
    const model = W.h1.map((h1) => (h1 === null ? null : (h1 - W.h1[i0]) / 2));
    const surface = W.x.map((_, i) => disp(W.nodes.bottom[i])[1] - wb0 - (W.prof[i] - W.prof[i0]));
    // The gap the strip leaves through is between the upper work roll and the lower one, its
    // mirror image ((x, y, z) → (−x, −y, z) on a 6Hi with the intermediate rolls shifted
    // opposite ways): a tilt of the upper roll is cancelled by the lower's, and only the even
    // part of the surface's displacement is the profile. A half case is even already.
    const fem = ref.full
      ? W.x.map((x, i) => { const j = W.x.findIndex((v) => Math.abs(v + x) < 1e-9); return j < 0 ? null : (surface[i] + surface[j]) / 2; })
      : surface;
    exit = { model, fem, worst: worstOf(model, fem) };
  }
  return {
    mill: ref.mill, full: ref.full, x: W.x, q: W.q, b: W.b, rolls, contacts, flat, exit,
    bearingReaction, loadSumY: ref.loadSumY, force: ref.force, iterations: ref.iterations,
    nodes: ref.mesh.reduce((n, m) => n + m.nodes, 0), mesh: ref.mesh,
  };
}

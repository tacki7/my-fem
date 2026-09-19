// The rolls of a converged pass as FrontISTR solids, for the coupling (couple.mjs, the bridge's
// `roll-coupled` job): the load is the solver's own - whatever its grid, correction or strip
// model - put on a mesh with its own stations, and the answer read back as the work roll's
// surface where the strip leaves it.
//
// Unlike `buildCase` (the cross-check, lib.mjs), the mesh does not take the solver's stations:
// the app solves on 301 of them, which would make a 176k-node solid, and a load on one node ring
// per station dimples the surface ring by ring (the cross-check's exit profile is ±20-30 µm off
// next to the strip edge for that reason). Here the rings are `dxStrip` apart over the strip and
// `dxOff` beyond it, the load per unit width q(x) and the arc are interpolated between the
// solver's slices onto them, and each ring carries its own share of the strip.
//
// The rest is the cross-check's: the upper half's rolls as stepped half-cylinders (z ≥ 0, the
// plane of the roll axes a plane of symmetry; x ≥ 0), the rolls touching on the centre line in
// frictionless contact, the screw roll's bearing sections held, a chocked roll's chock sections
// on the model's chock spring with its bender force (halved with the section), the strip load as a Hertz ellipse over the
// half-width the model flattens with, ramped over `substeps`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { halfCylinderMesh, meshText } from './mesh.mjs';

const K_CHOCK = 1e6;

/** the solver's per-station value at x, linear between the stations where `ok` holds, the nearest one past the last */
function sampleAt(x, xs, vals, ok) {
  let lo = -1, hi = -1;
  for (let s = 0; s < xs.length; s++) {
    if (!ok(s)) continue;
    if (xs[s] <= x) lo = s;
    if (xs[s] >= x) { hi = s; break; }
  }
  if (lo < 0 && hi < 0) return NaN;
  if (lo < 0) return vals[hi];
  if (hi < 0 || hi === lo) return vals[lo];
  const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return vals[lo] + f * (vals[hi] - vals[lo]);
}

/**
 * Write the case for the converged solver `sv` into `out` (roll.msh, roll.cnt, hecmw_ctrl.dat,
 * case.json). `radiusProfile` is stack.ts's (the build's). Options: `dxStrip` (12.5 mm, the work
 * roll's rings over the strip), `dxEdge` (5 mm) within `edgeBand` (60 mm) either side of the strip
 * edge, `dxOther` (25 mm, the other rolls' over the strip), `dxOff` (40 mm), `mesh` (the solid's cell sizes), `substeps` (2), `solver` ('CG' | 'DIRECT'),
 * `mises` (write the nodal von Mises stress, true).
 */
export function buildRollCase(sv, radiusProfile, out, o = {}) {
  const dxStrip = o.dxStrip ?? 12.5e-3, dxOff = o.dxOff ?? 40e-3, substeps = o.substeps ?? 2;
  mkdirSync(out, { recursive: true });
  const R = sv.result, st = sv.stack, p = sv.p;
  if (!R.converged) throw new Error('the pass has not converged');
  const up = sv.upper;
  const defs = st.rolls.slice(0, up), rolls = sv.rolls.slice(0, up);
  const screwIdx = defs.findIndex((d) => d.support === 'screw');
  if (screwIdx < 0) throw new Error('no screw roll');
  if (defs.some((d) => Math.abs(d.shift) > 1e-12)) throw new Error('a shifted roll: this case is a symmetric half (x ≥ 0)');
  const pairs = st.contacts.filter((k) => k.a < up && k.b < up).map((k) => (k.a < k.b ? [k.a, k.b] : [k.b, k.a]));
  const halfW = p.width / 2;

  const inBarrel = (def, x, tol = 1e-9) => Math.abs(x - def.shift) <= def.Lb / 2 + tol;
  const radiusOf = (def) => (x) => (inBarrel(def, x) ? def.D / 2 + radiusProfile(def, x) : def.Dn / 2);
  const meshOpts = { arcCell: 2.0e-3, arcFine: 0.020, arcGrowth: 1.4, arcMax: 0.060, layer0: 3e-3, layerGrowth: 1.8, ...(o.mesh ?? {}) };

  /**
   * A roll's stations: fine over the strip, coarse beyond, with every edge the load or the geometry
   * changes at. The rolls above the work roll carry no strip load and only meet the one below,
   * whose nodes land on their faces: `dxOther` over the strip is enough for them.
   */
  function stationsOf(def, partners, isWR) {
    const end = def.Ls / 2;
    const dxS = isWR ? dxStrip : Math.max(dxStrip, o.dxOther ?? 25e-3);
    // the work roll's rings closer still where the load falls to nothing at the strip edge: at
    // 25 mm apart the surface there read +0.8 µm between −17 and −25 (the contact half-width is
    // 5-8 mm, a ring per 25 mm cannot follow it)
    const edgeBand = isWR ? (o.edgeBand ?? 60e-3) : 0, dxE = o.dxEdge ?? 5e-3;
    const keep = new Set([0, halfW, end, ...(isWR ? [halfW - (o.edgeBand ?? 60e-3)] : [])].filter((v) => v > 0));
    for (const d of [def, ...partners]) { keep.add(d.Lb / 2); keep.add(d.Lb / 2 + 0.005); }
    const xs = [0];
    let x = 0;
    while (x < end - 1e-9) {
      const h = x < halfW - edgeBand - 1e-9 ? dxS : x < halfW + edgeBand - 1e-9 && edgeBand > 0 ? dxE : x < halfW - 1e-9 ? dxS : dxOff;
      // the next marked point, if nearer than a whole cell
      let next = x + h;
      for (const k of keep) if (k > x + 1e-9 && k < next - 1e-9) next = Math.min(next, k);
      if (end - next < 0.3 * h) next = end;
      xs.push(Math.min(next, end));
      x = Math.min(next, end);
    }
    for (const k of keep) if (k <= end + 1e-9 && !xs.some((v) => Math.abs(v - k) < 1e-9)) xs.push(k);
    xs.sort((a, b) => a - b);
    return xs.filter((v, i) => i === 0 || v - xs[i - 1] > 1e-9);
  }

  // ── the bodies, bottom up ──
  const S = [], M = [], bodies = [];
  let nodeStart = 1, elemStart = 1, cy = 0;
  for (let r = 0; r < up; r++) {
    const def = defs[r];
    const partners = pairs.filter((q) => q.includes(r)).map((q) => defs[q[0] === r ? q[1] : q[0]]);
    const xs = stationsOf(def, partners, r === 0);
    const iSup = xs.findIndex((v) => Math.abs(v - def.Ls / 2) < 1e-9);
    S[r] = { xs, iSup };
    if (r > 0) cy += radiusOf(defs[r - 1])(0) + radiusOf(def)(0);
    const own = r === screwIdx && r > 0 ? { layer0: 2e-3, layerGrowth: 1.6, ...(o.mesh ?? {}) } : {};
    M[r] = halfCylinderMesh({ ...meshOpts, ...own, xs, radiusAt: radiusOf(def), R0: def.D / 2, cy, nodeStart, elemStart, fineTop: pairs.some((q) => q[0] === r) });
    nodeStart += M[r].nodes.length; elemStart = M[r].elemEnd + 1;
    bodies.push({ name: def.id, mesh: M[r] });
  }
  const wrDef = defs[0], mW = M[0], W = S[0];

  // ── the strip load, interpolated onto the work roll's rings ──
  const onStrip = (s) => R.q[s] > 0 && Number.isFinite(R.q[s]);
  const law = sv.wsLaw;
  const bAt = (q, arc) => Math.max(Math.sqrt(law.bCoef * Math.max(q, 0)), arc / 2, 1e-6);
  const G = (u) => (u * Math.sqrt(Math.max(0, 1 - u * u)) + Math.asin(Math.max(-1, Math.min(1, u)))) / 2;
  const RW = wrDef.D / 2;
  const loads = [];
  let Fsum = 0;
  for (let i = 0; i < W.xs.length; i++) {
    const x = W.xs[i];
    if (x > halfW + 1e-9) continue;
    // the ring's share of the strip: from the midpoint to its neighbour on each side, within the strip
    const a = i === 0 ? 0 : 0.5 * (W.xs[i - 1] + x), b = Math.min(halfW, i + 1 < W.xs.length ? 0.5 * (x + W.xs[i + 1]) : x);
    if (b <= a) continue;
    // the load there: the slices' q read at the middle of the share (at an edge ring, the share
    // lies inside the strip), the strip's edge slice past its last centre
    const xm = 0.5 * (a + b);
    const q = sampleAt(xm, sv.x, R.q, onStrip), arc = sampleAt(xm, sv.x, R.arc, onStrip);
    if (!(q > 0)) continue;
    const bb = bAt(q, arc), p0 = (2 * q) / (Math.PI * bb), dx = b - a;
    for (let k = 0; k < mW.nk; k++) {
      const sk = mW.phi[k] * RW;
      const sLo = k === 0 ? 0 : 0.5 * (mW.phi[k - 1] + mW.phi[k]) * RW;
      const sHi = k + 1 < mW.nk ? 0.5 * (mW.phi[k] + mW.phi[k + 1]) * RW : sk;
      if (sLo >= bb) break;
      const F = p0 * bb * (G(Math.min(sHi, bb) / bb) - G(sLo / bb)) * dx;
      if (F <= 0) continue;
      const ph = mW.phi[k];
      loads.push([mW.id(i, mW.nr, k), F * Math.cos(ph), -F * Math.sin(ph)]);
      Fsum += F * Math.cos(ph);
    }
  }

  // ── groups ──
  const ng = { XSYM: [], ZSYM: [] };
  const lists = [];
  for (let r = 0; r < up; r++) {
    const m = M[r], Sr = S[r];
    const L = { support: [], bottom: [] };
    for (let i = 0; i < Sr.xs.length; i++) {
      for (let j = 0; j <= m.nr; j++) {
        for (let k = 0; k < (j === 0 ? 1 : m.nk); k++) {
          const n = m.id(i, j, k);
          if (i === 0) ng.XSYM.push(n);
          if (j === 0 || k === 0 || k === m.nk - 1) ng.ZSYM.push(n);
          if (i === Sr.iSup) L.support.push(n);
        }
      }
      L.bottom.push(m.id(i, m.nr, 0));
    }
    lists[r] = L;
  }
  ng.BRG = lists[screwIdx].support;
  // the chock section is the z ≥ 0 half of the roll's: half the chock's spring and bender (lib.mjs)
  const springs = [], benders = [];
  let benderSumY = 0;
  for (let r = 0; r < up; r++) {
    if (defs[r].support !== 'chock') continue;
    const sec = lists[r].support;
    ng[up === 2 ? 'CHOCK' : `CHOCK_${defs[r].id}`] = sec;
    for (const n of sec) springs.push([n, K_CHOCK / 2 / sec.length]);
    if (defs[r].benderForce) for (const n of sec) { benders.push([n, defs[r].benderForce / 2 / sec.length]); benderSumY += defs[r].benderForce / 2 / sec.length; }
  }
  const sg = {}, cpairs = {};
  pairs.forEach(([a, b], q) => {
    const mA = M[a], mB = M[b], dA = defs[a], dB = defs[b], RA = dA.D / 2, RB = dB.D / 2;
    const slave = [];
    for (let i = 0; i < S[a].xs.length; i++) {
      if (!inBarrel(dA, S[a].xs[i])) continue;
      for (let k = 0; k < mA.nk; k++) if ((Math.PI - mA.phi[k]) * RA <= 0.040 + 1e-9) slave.push(mA.id(i, mA.nr, k));
    }
    const master = [];
    for (let i = 0; i + 1 < S[b].xs.length; i++) {
      if (!inBarrel(dB, S[b].xs[i], -1e-9) || !inBarrel(dB, S[b].xs[i + 1], 1e-9)) continue;
      for (let k = 0; k + 1 < mB.nk; k++) if (mB.phi[k + 1] * RB <= 0.060 + 1e-9) master.push(mB.outerFace(i, k));
    }
    const sName = pairs.length === 1 ? 'SLAVE' : `SLAVE${q + 1}`, mName = pairs.length === 1 ? 'MASTER' : `MASTER${q + 1}`;
    ng[sName] = slave; sg[mName] = master; cpairs[`CP${q + 1}`] = [sName, mName];
  });
  writeFileSync(`${out}/roll.msh`, meshText(bodies, { header: `ROLL FEM LAB coupled ${st.type.toUpperCase()}`, E: wrDef.E, nu: wrDef.nu, ngroups: ng, sgroups: sg, contactPairs: cpairs }));

  // ── the control file ──
  const bc = [' XSYM, 1, 1, 0.0', ' ZSYM, 3, 3, 0.0', ' BRG, 2, 2, 0.0'];
  const cload = [...loads.flatMap(([n, fy, fz]) => [` ${n}, 2, ${fy.toPrecision(9)}`, ` ${n}, 3, ${fz.toPrecision(9)}`]), ...benders.map(([n, fy]) => ` ${n}, 2, ${fy.toPrecision(9)}`)];
  const solver = (o.solver ?? 'CG') === 'DIRECT'
    ? ['!SOLVER, METHOD=DIRECT, CONTACT_ELIM=1, ITERLOG=NO, TIMELOG=YES']
    : ['!SOLVER, METHOD=CG, PRECOND=1, ITERLOG=NO, TIMELOG=YES', ' 30000, 1', ' 1.0e-7, 1.0, 0.0'];
  const outRes = ['!OUTPUT_RES', ' DISP, ON', ' REACTION, ON', ' NSTRESS, OFF', ` NMISES, ${o.mises === false ? 'OFF' : 'ON'}`];
  const cnt = ['!VERSION', ' 3'];
  if (pairs.length) {
    cnt.push('!SOLUTION, TYPE=NLSTATIC', '!WRITE, RESULT', ...outRes.slice(0, 3), ' CONTACT_NFORCE, ON', ...outRes.slice(3),
      '!BOUNDARY, GRPID=1', ...bc,
      ...(springs.length ? ['!SPRING, GRPID=1', ...springs.map(([n, k]) => ` ${n}, 2, ${k.toPrecision(6)}`)] : []),
      '!CLOAD, GRPID=1', ...cload,
      '!CONTACT_ALGO, TYPE=ALAGRANGE',
      '!CONTACT, GRPID=1', ...Object.keys(cpairs).map((name) => ` ${name}, 0.0`),
      `!STEP, SUBSTEPS=${substeps}, CONVERG=1.0e-5, MAXITER=50`, ' BOUNDARY, 1', ' LOAD, 1', ' CONTACT, 1', ...solver);
  } else {
    cnt.push('!SOLUTION, TYPE=STATIC', '!WRITE, RESULT', ...outRes, '!BOUNDARY', ...bc, '!CLOAD', ...cload, ...solver);
  }
  cnt.push('!END');
  writeFileSync(`${out}/roll.cnt`, cnt.join('\n') + '\n');
  writeFileSync(`${out}/hecmw_ctrl.dat`, ['!MESH, NAME=fstrMSH, TYPE=HECMW-ENTIRE', ' roll.msh', '!CONTROL, NAME=fstrCNT', ' roll.cnt', '!RESULT, NAME=fstrRES, IO=OUT', ' roll.res'].join('\n') + '\n');

  const nn = bodies.reduce((a, b) => a + b.mesh.nodes.length, 0);
  // The solids are stacked touching at their crowned centres (`cy` above takes each barrel's
  // radius at x = 0, crown included); the model stacks the nominal radii and carries the crowns
  // in the contacts' gaps, so its work roll sits the crowns' overlap further from the bearings
  // than the solids' does before any load. The surface is read against the model's stacking:
  // this is how much lower, against the held bearings, the solids' work roll starts. (Without it
  // a 300 µm BUR crown shifted the whole correction by 150 µm - a uniform offset the screw took
  // up at a held gauge, but a wrong gap at a held screw or load.)
  let stackOffset = 0;
  for (let r = 1; r <= screwIdx; r++) stackOffset += radiusProfile(defs[r - 1], 0) + radiusProfile(defs[r], 0);
  const ref = {
    mill: st.type, halfW, force: R.force, quarterForce: R.force / 4, loadSumY: Fsum, benderSumY, nodes: nn, loadedNodes: loads.length,
    wr: { x: W.xs, bottom: lists[0].bottom, D: wrDef.D }, stackOffset,
    mesh: bodies.map((b) => ({ name: b.name, nodes: b.mesh.nodes.length, stations: b.mesh.ni, layers: b.mesh.nr, angles: b.mesh.nk - 1 })),
  };
  writeFileSync(`${out}/case.json`, JSON.stringify(ref));
  return ref;
}

/**
 * The work roll's bottom surface line where the strip leaves it: its vertical displacement per
 * mesh station against the held bearings [m], + up (away from the strip), on the model's stacking
 * (less `stackOffset`, see above) - the quantity `modelRollSurface` gives for the model.
 */
export function readRollSurface(ref, res) {
  const lab = res.labels.find((l) => l.toUpperCase() === 'DISPLACEMENT');
  const off = ref.stackOffset ?? 0;
  return { x: ref.wr.x, v: ref.wr.bottom.map((n) => (res.node.get(n)?.[lab]?.[1] ?? NaN) - off) };
}

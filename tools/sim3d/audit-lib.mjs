// The invariants a converged 3D solve has to satisfy, recomputed from its state - shared by
// audit.mjs (prints them) and check.mjs (holds them to a tolerance). Not a check itself.
//
// Everything is read back from the solver as it stands: the displacements, the contact
// loads and approaches, the slices, and - for the strip - the FEM load ratio each slice was
// last solved with. Where the solver keeps a value private in TypeScript it is still an
// ordinary property at run time, and is read, never written.
import { StackSolver } from './build/solver.js';
import { loadAt, approach } from './build/contact.js';
import { sliceLoad, springback, kfExitOf } from './build/strip.js';

/** the slice's exit gauge never goes below this fraction of its entry (solver.ts H_MIN_FRAC) */
const H_MIN_FRAC = 0.05;

/** Solve to convergence the way the harnesses always have: 6 iterations per call, a frame cap. */
export function solve(p, frames = 400) {
  const sv = new StackSolver(p);
  let iterations = 0;
  for (let f = 0; f < frames; f++) { sv.advance(1e9, 6); iterations += sv.result.iterations; if (sv.isConverged) break; }
  return { sv, iterations };
}

/**
 * Vertical and lateral force balance of every solved roll, the lower half's too:
 * contact loads + the strip (on the work rolls) + the support reactions.
 */
export function equilibrium(sv) {
  const R = sv.result, st = sv.stack, rolls = sv.rolls, contacts = sv.contacts;
  const rows = [];
  for (let r = 0; r < sv.nr; r++) {
    let fy = 0, fz = 0;
    for (const c of contacts) {
      let F = 0; for (let s = 0; s < R.x.length; s++) F += c.q[s] * c.weight[s];
      if (c.a === r) { fy -= F * c.ny; fz -= F * c.nz; }
      if (c.b === r) { fy += F * c.ny; fz += F * c.nz; }
    }
    if (r === st.wr || r === sv.wrLower) fy += R.force;
    const roll = rolls[r];
    let support = 0;
    roll.reactions.forEach((v) => { support += roll.def.support === 'chock' ? v : -v; });
    rows.push({ id: roll.def.id, fy, fz, support, net: fy + support });
  }
  return rows;
}

/** Each contact's approach recomputed from the displacements and profiles, and its load from the contact law. */
export function contactKinematics(sv) {
  const R = sv.result, u = sv.u, rolls = sv.rolls;
  const idx = (s, r, d) => sv.idx(s, r, d);
  return sv.contacts.map((c) => {
    const A = rolls[c.a], B = rolls[c.b];
    let deltaMismatch = 0, qRelMismatch = 0, stations = 0, open = 0;
    for (let s = 0; s < R.x.length; s++) {
      if (c.weight[s] <= 0) continue;
      const gapChange = (u[idx(s, c.b, 0)] - u[idx(s, c.a, 0)]) * c.ny + (u[idx(s, c.b, 2)] - u[idx(s, c.a, 2)]) * c.nz;
      const delta = A.prof[s] + B.prof[s] - gapChange;
      const [q] = loadAt(c.law, delta, 0);
      deltaMismatch = Math.max(deltaMismatch, Math.abs(delta - c.delta[s]));
      qRelMismatch = Math.max(qRelMismatch, Math.abs(q - c.q[s]) / Math.max(c.q[s], 1));
      if (delta <= 0) open++;
      stations++;
    }
    return { a: A, b: B, c, stations, open, deltaMismatch, qRelMismatch };
  });
}

/**
 * The strip slices against the slice law as the solver applies it: the slab load scaled by
 * the FEM load ratio k the slice was solved with (1 on the slab model), and the exit gauge
 * from the flattened gap with the solver's own floor and springback.
 */
export function stripConsistency(sv, p) {
  const u = sv.u, st = sv.stack;
  const ratio = sv.femRatio;
  let h1Mismatch = 0, qRelMismatch = 0;
  sv.slices.forEach((sl, i) => {
    if (!(sl.q > 0)) return;
    const k = ratio ? ratio[i] : 1;
    const sigma = sv.sigmaF[sl.s];
    const g = sv.gapAt(sl.s);
    const [flat] = approach({ ...sv.wsLaw, bFloor: Math.max(0, sl.arc / 2) }, sl.q);
    const hRigid = Math.max(g + 2 * flat, H_MIN_FRAC * sl.h0);
    const h1 = hRigid + springback(sv.law, Math.min(hRigid, sl.h0), kfExitOf(sv.law, sl.h0, hRigid), sigma);
    const q = k * sliceLoad(sv.law, sl.h0, sl.h1, p.backTension, sigma, sl.q / k).q;
    h1Mismatch = Math.max(h1Mismatch, Math.abs(h1 - sl.h1));
    qRelMismatch = Math.max(qRelMismatch, Math.abs(q - sl.q) / Math.max(sl.q, 1));
  });
  const m = sv.slices[Math.floor(sv.slices.length / 2)];
  return { h1Mismatch, qRelMismatch, centre: m, vWR: u[sv.idx(m.s, st.wr, 0)], prof: sv.result.rolls[st.wr].prof[m.s], k: ratio ? ratio[sv.slices.indexOf(m)] : 1 };
}

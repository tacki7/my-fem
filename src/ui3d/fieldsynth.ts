/**
 * Made-up but plausible fields for the contour view's demo and checks: a 4Hi bite on the
 * common coordinates (x across the width, y up from the pass line, z along the rolling
 * direction, the roll axes at z = 0).
 *
 * - The strip: the material FEM's block (the same node order and faces as `StripField3D`),
 *   the full width, the upper half of the thickness, z from the entry (−L) to the exit (0).
 *   Thinner along the arc as the gap h(z) = h₁ + z²/R′ closes, strain rising from 0 to the
 *   homogeneous (2/√3) ln(h₀/h), a friction hill of pressure peaking at the neutral point,
 *   σ_zz from the back tension through compression in the bite to the front tension. `progress`
 *   0 … 1 walks it from a rigid-roll guess to the converged picture, the flattened radius R′
 *   (and so the bite length and the block's shape) changing on the way, as the coupled solve
 *   would.
 * - The rolls: WR and BUR as stepped half-cylinders (barrel, then neck) over x ≥ 0, z ≥ 0, the
 *   surface as the bridge sends FrontISTR's - the symmetry cuts included - so the cut through
 *   the axes shows the stress under the contacts. Mises with a Hertz-like maximum under each
 *   contact line, a pressure peak at the strip's edge, edge loading at the barrel end, bending
 *   on the necks; contact pressure on the contact bands; flattening and bending as the
 *   displacement. `load` 0 … 1 is the load ramp of FrontISTR's substeps.
 *
 * Nothing here is a solution of anything: it only has to look like one, so the drawing can be
 * judged on the kind of picture it will get.
 */
import { blockTris } from '../sim3d/stripfield';
import type { FieldPart, FieldValues, Symmetry } from './fieldframe';

export interface SynthMill {
  wrR: number; wrLb: number; wrLs: number; wrRn: number;
  burR: number; burLb: number; burLs: number; burRn: number;
  width: number; h0: number; h1: number;
  backTension: number; frontTension: number;
  /** exit speed [m/s] */
  v1: number;
}

/** the 4Hi default's sizes (src/sim3d/stack.ts) */
export const MILL_4HI: SynthMill = {
  wrR: 0.3, wrLb: 1.6, wrLs: 2.1, wrRn: 0.18,
  burR: 0.65, burLb: 1.6, burLs: 2.35, burRn: 0.4,
  width: 1.0, h0: 2e-3, h1: 1.5e-3,
  backTension: 50e6, frontTension: 75e6, v1: 5,
};

export interface SynthGrid {
  /** roll: segments around the half circumference, along the barrel, along the neck, across the cut */
  arc: number; barrel: number; neck: number; cut: number; ring: number;
  /** strip: node columns across the width, rows along the arc, layers through the half thickness */
  nx: number; rows: number; lay: number;
}

const grid = (d: number): SynthGrid => ({
  arc: Math.max(8, Math.round(96 * d)), barrel: Math.max(4, Math.round(40 * d)), neck: Math.max(2, Math.round(8 * d)),
  cut: Math.max(4, Math.round(40 * d)), ring: Math.max(2, Math.round(6 * d)),
  nx: 2 * Math.max(2, Math.round(40 * Math.sqrt(d))) + 1, rows: Math.max(4, Math.round(17 * Math.sqrt(d))), lay: 5,
});

/** a grid whose parts have about `nodes` nodes in all (at least the coarsest) */
export function synthGrid(nodes = 40000): SynthGrid {
  let lo = 0.05, hi = 40;
  for (let it = 0; it < 40; it++) {
    const d = Math.sqrt(lo * hi);
    if (countNodes(grid(d)) < nodes) lo = d; else hi = d;
  }
  return grid(hi);
}

export function countNodes(g: SynthGrid): number {
  const roll = (g.barrel + 1) * (g.arc + 1) + (g.neck + 1) * (g.arc + 1) + (g.ring + 1) * (g.arc + 1)
    + (g.ring * (g.arc + 1) + 1) * 2 + (g.barrel + 1) * (g.cut + 1) + (g.neck + 1) * (g.cut + 1);
  return 2 * roll + g.nx * g.rows * g.lay;
}

// ── the rolls ─────────────────────────────────────────────────────────────

class Surf {
  c: number[] = [];
  t: number[] = [];
  node(x: number, y: number, z: number): number { this.c.push(x, y, z); return this.c.length / 3 - 1; }
  /** a quadrilateral counter-clockwise seen from outside, as the bridge splits it */
  quad(a: number, b: number, c: number, d: number): void { this.t.push(a, b, c, a, c, d); }
}

/** φ from 0 (top) to π (bottom), bunched at both ends where the contacts are */
const arcAt = (u: number) => Math.PI * (u - (0.82 * Math.sin(2 * Math.PI * u)) / (2 * Math.PI));
/** −1 … 1 bunched at both ends */
const acrossAt = (u: number) => -Math.cos(Math.PI * u);

interface RollGeo { name: 'WR' | 'BUR'; R: number; Lb: number; Ls: number; Rn: number; cy: number }

function rollSurface(r: RollGeo, g: SynthGrid): { coords: Float32Array; tris: Uint32Array } {
  const s = new Surf();
  const xb = r.Lb / 2, xe = r.Ls / 2;
  const phis = Array.from({ length: g.arc + 1 }, (_, j) => arcAt(j / g.arc));
  const at = (x: number, rad: number, phi: number) => s.node(x, r.cy + rad * Math.cos(phi), rad * Math.sin(phi));
  // barrel and neck mantles, outward: (i, j) (i, j+1) (i+1, j+1) (i+1, j)
  const mantle = (x0: number, x1: number, n: number, rad: number) => {
    const ids: number[][] = [];
    for (let i = 0; i <= n; i++) ids.push(phis.map((ph) => at(x0 + ((x1 - x0) * i) / n, rad, ph)));
    for (let i = 0; i < n; i++) for (let j = 0; j < g.arc; j++) s.quad(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]);
  };
  mantle(0, xb, g.barrel, r.R);
  mantle(xb, xe, g.neck, r.Rn);
  // the shoulder at the barrel's end, facing +x
  {
    const ids: number[][] = [];
    for (let k = 0; k <= g.ring; k++) ids.push(phis.map((ph) => at(xb, r.Rn + ((r.R - r.Rn) * k) / g.ring, ph)));
    for (let k = 0; k < g.ring; k++) for (let j = 0; j < g.arc; j++) s.quad(ids[k][j], ids[k + 1][j], ids[k + 1][j + 1], ids[k][j + 1]);
  }
  // the neck's end (facing +x) and the cut at x = 0 (facing −x): half discs
  const disc = (x: number, rad: number, dir: 1 | -1) => {
    const c = s.node(x, r.cy, 0);
    const rings: number[][] = [];
    for (let k = 1; k <= g.ring; k++) rings.push(phis.map((ph) => at(x, (rad * k) / g.ring, ph)));
    for (let j = 0; j < g.arc; j++) {
      if (dir > 0) s.t.push(c, rings[0][j], rings[0][j + 1]); else s.t.push(c, rings[0][j + 1], rings[0][j]);
    }
    for (let k = 0; k + 1 < rings.length; k++) for (let j = 0; j < g.arc; j++) {
      if (dir > 0) s.quad(rings[k][j], rings[k + 1][j], rings[k + 1][j + 1], rings[k][j + 1]);
      else s.quad(rings[k][j], rings[k][j + 1], rings[k + 1][j + 1], rings[k + 1][j]);
    }
  };
  disc(xe, r.Rn, 1);
  disc(0, r.R, -1);
  // the cut through the axes, z = 0, facing −z: (i, m) (i, m+1) (i+1, m+1) (i+1, m)
  const cut = (x0: number, x1: number, n: number, rad: number) => {
    const ids: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      ids.push(Array.from({ length: g.cut + 1 }, (_, m) => s.node(x, r.cy + rad * acrossAt(m / g.cut), 0)));
    }
    for (let i = 0; i < n; i++) for (let m = 0; m < g.cut; m++) s.quad(ids[i][m], ids[i][m + 1], ids[i + 1][m + 1], ids[i + 1][m]);
  };
  cut(0, xb, g.barrel, r.R);
  cut(xb, xe, g.neck, r.Rn);
  return { coords: Float32Array.from(s.c), tris: Uint32Array.from(s.t) };
}

const ROLL_SYM: Symmetry = { x: true, y: true, z: true };
const STRIP_SYM: Symmetry = { x: false, y: true, z: false };

function rollGeos(m: SynthMill): RollGeo[] {
  const wrCy = m.h1 / 2 + m.wrR;
  return [
    { name: 'WR', R: m.wrR, Lb: m.wrLb, Ls: m.wrLs, Rn: m.wrRn, cy: wrCy },
    { name: 'BUR', R: m.burR, Lb: m.burLb, Ls: m.burLs, Rn: m.burRn, cy: wrCy + m.wrR + m.burR },
  ];
}

/** the two rolls' surfaces (the bridge's mesh.bin would carry the same) */
export function synthRolls(m: SynthMill = MILL_4HI, g: SynthGrid = synthGrid()): FieldPart[] {
  return rollGeos(m).map((r) => ({ name: r.name, kind: 'roll' as const, ...rollSurface(r, g), symmetry: ROLL_SYM }));
}

/**
 * The rolls' values at `load` (0 the initial state, 1 the full strip load), for parts made by
 * `synthRolls` with the same mill.
 */
export function synthRollValues(parts: FieldPart[], load: number, m: SynthMill = MILL_4HI): Record<string, Omit<FieldValues, 'label'>> {
  const out: Record<string, Omit<FieldValues, 'label'>> = {};
  const geos = rollGeos(m);
  const lam = Math.max(0, Math.min(1, load));
  const w2 = m.width / 2;
  // peak Hertz pressures and half-widths: the strip on the WR, the WR on the BUR
  const p0s = 720e6 * lam, as = 5.0e-3 * Math.sqrt(lam) + 1e-9;
  const p0r = 1050e6 * lam, ar = 3.8e-3 * Math.sqrt(lam) + 1e-9;
  const stripLoad = (x: number) => {
    const ax = Math.abs(x);
    if (ax <= w2) return 1 + 0.35 * (ax / w2) ** 12;
    return 1.35 * Math.exp(-(((ax - w2) / 0.004) ** 2));
  };
  const rollLoad = (x: number, Lb: number) => {
    const ax = Math.abs(x), e = Lb / 2;
    return ax > e + 1e-9 ? 0 : 1 + 0.55 * Math.exp(-(e - ax) / 0.025);
  };
  /** Mises under a line contact: the maximum 0.56 p₀ at 0.78 a deep, a shallower band at the surface */
  const hertz = (d: number, s: number, a: number, p0: number) => {
    if (d < -1e-6 || p0 <= 0) return 0;
    const dd = Math.max(d, 0);
    return p0 * (0.56 * Math.exp(-(((dd - 0.78 * a) / (0.62 * a)) ** 2) - (s / (0.95 * a)) ** 2)
      + 0.3 * Math.exp(-((s / (0.85 * a)) ** 2) - dd / (0.4 * a)));
  };
  for (const part of parts) {
    const r = geos.find((q) => q.name === part.name);
    if (!r) continue;
    const n = part.coords.length / 3;
    const mises = new Float32Array(n), cpress = new Float32Array(n), disp = new Float32Array(3 * n);
    const isWR = r.name === 'WR';
    for (let i = 0; i < n; i++) {
      const x = part.coords[3 * i], y = part.coords[3 * i + 1], z = part.coords[3 * i + 2];
      const dy = y - r.cy, rho = Math.hypot(dy, z);
      // (the coordinates are float32: 0.8 is 0.800000012)
      const onBarrel = x <= r.Lb / 2 + 1e-6;
      // on the barrel's surface (a real roll's is ground and crowned: tens of µm off the nominal radius)
      const surf = onBarrel ? Math.abs(rho - r.R) < 2e-4 * r.R : false;
      // below: the contact at the bottom (WR: the strip; BUR: the WR); above: the WR's top on the BUR
      const dBot = dy + r.R, dTop = r.R - dy;
      let sq = 0, cp = 0, flat = 0;
      if (onBarrel) {
        if (isWR) {
          const qs = stripLoad(x), qr = rollLoad(x, Math.min(r.Lb, m.burLb));
          sq += hertz(dBot, z, as, p0s * qs) ** 2 + hertz(dTop, z, ar, p0r * qr) ** 2;
          if (surf && dy < 0 && z < as) cp = p0s * qs * Math.sqrt(1 - (z / as) ** 2);
          if (surf && dy > 0 && z < ar) cp = p0r * qr * Math.sqrt(1 - (z / ar) ** 2);
          flat = dy < 0 ? 28e-6 * lam * qs * Math.exp(-((z / (2.5 * as)) ** 2) - Math.max(dBot, 0) / (4 * as))
            : 34e-6 * lam * qr * Math.exp(-((z / (2.5 * ar)) ** 2) - Math.max(dTop, 0) / (4 * ar));
        } else {
          const qr = rollLoad(x, Math.min(r.Lb, m.wrLb));
          sq += hertz(dBot, z, ar, p0r * qr) ** 2;
          if (surf && dy < 0 && z < ar) cp = p0r * qr * Math.sqrt(1 - (z / ar) ** 2);
          flat = dy < 0 ? 40e-6 * lam * qr * Math.exp(-((z / (2.5 * ar)) ** 2) - Math.max(dBot, 0) / (4 * ar)) : 0;
        }
        // barrel bending, fibre stress across the section
        const bend = (isWR ? 55e6 : 90e6) * lam * (dy / r.R) * (1 - (2 * x / r.Ls) ** 2);
        sq += bend * bend;
      } else {
        // the neck: bending, highest at the shoulder's fillet
        const lever = (x - r.Lb / 2) / (r.Ls / 2 - r.Lb / 2);
        const bend = lam * (isWR ? 140e6 : 110e6) * (Math.abs(dy) / r.Rn) * ((1 - lever) + 1.4 * Math.exp(-(((x - r.Lb / 2) / 0.02) ** 2)));
        sq += bend * bend;
      }
      mises[i] = Math.sqrt(sq);
      cpress[i] = cp;
      // flattening: inward, toward the axis; bending: the barrel's middle lifted (WR) or pushed up (BUR)
      const ux = 0, uy = rho > 0 ? (-dy / rho) * flat : 0, uz = rho > 0 ? (-z / rho) * flat : 0;
      const sag = lam * (isWR ? 45e-6 : 120e-6) * (1 - (2 * Math.min(x, r.Ls / 2) / r.Ls) ** 2) + lam * (isWR ? 180e-6 : 170e-6);
      disp[3 * i] = ux; disp[3 * i + 1] = uy + sag; disp[3 * i + 2] = uz;
    }
    out[part.name] = { disp, fields: { mises, cpress } };
  }
  return out;
}

// ── the strip ─────────────────────────────────────────────────────────────

/** how far the coupled solve has got: 0 the first guess, 1 converged (with a little overshoot on the way) */
export const settle = (progress: number): number => {
  const s = Math.max(0, progress);
  return 1 - Math.exp(-5 * s) * Math.cos(7 * s);
};

/**
 * The strip at `progress` (< 0: the initial state, before any solve - the rigid-roll gap and no
 * strain, no stress). Coordinates are its current shape, so the values carry no displacement.
 */
export function synthStrip(progress: number, m: SynthMill = MILL_4HI, g: SynthGrid = synthGrid()): { part: FieldPart; values: Omit<FieldValues, 'label'> } {
  const initial = progress < 0;
  const a = initial ? 0 : Math.min(1.08, settle(progress));
  const Rf = m.wrR * (1 + 0.28 * a);
  const dh = m.h0 - m.h1;
  const L = Math.sqrt(Rf * dh);
  const { nx, rows, lay } = g;
  const nn = nx * rows * lay;
  const coords = new Float32Array(3 * nn);
  const f = () => new Float32Array(nn);
  const fields = { eq: f(), eqRate: f(), p: f(), s_zz: f(), flow: f(), vx: f(), vy: f(), vz: f() };
  const K = 650e6, nExp = 0.22, pre = 0.4;
  const w2 = m.width / 2;
  const xiN = 0.62;
  for (let i = 0; i < nx; i++) {
    const x = -w2 + (m.width * i) / (nx - 1);
    const e = Math.abs(x) / w2;
    // the exit gauge drops a little at the edges once the rolls flatten
    const h1x = m.h1 * (1 - 0.012 * a * e ** 6);
    for (let j = 0; j < rows; j++) {
      // rows bunched toward the exit, where the gradients are
      const u = j / (rows - 1);
      const xi = 1 - (1 - u) ** 1.25;
      const z = -L + L * xi;
      const h = h1x + (z * z) / Rf;
      const hEntry = h1x + L * L / Rf;
      const vz = (m.v1 * h1x) / h;
      const eqHom = (2 / Math.sqrt(3)) * Math.log(hEntry / h);
      const rate = (2 / Math.sqrt(3)) * (Math.abs(2 * z / Rf) / h) * vz;
      const tension = m.backTension * (1 - xi) + m.frontTension * xi;
      const tent = xi < xiN ? xi / xiN : (1 - xi) / (1 - xiN);
      for (let k = 0; k < lay; k++) {
        const n = (i * rows + j) * lay + k;
        const yy = k / (lay - 1);
        coords[3 * n] = x; coords[3 * n + 1] = (h / 2) * yy; coords[3 * n + 2] = z;
        // the surface layers shear a little more than the middle, the edges more than the centre
        const eq = initial ? 0 : a * eqHom * (1 + 0.1 * yy * yy) * (1 + 0.05 * e ** 8);
        const flow = K * (pre + eq) ** nExp;
        const p = initial ? 0 : a * (1.155 * flow - tension) * (1 + 0.45 * tent ** 1.3) * (1 - 0.12 * e ** 16);
        fields.eq[n] = eq;
        fields.eqRate[n] = initial ? 0 : a * rate * (1 + 0.1 * yy * yy);
        fields.flow[n] = flow;
        fields.p[n] = p;
        fields.s_zz[n] = initial ? 0 : -p + a * 1.155 * flow;
        fields.vz[n] = initial ? 0 : vz;
        fields.vy[n] = initial ? 0 : -vz * (z / Rf) * yy;
        fields.vx[n] = initial ? 0 : 0.004 * m.v1 * (x / w2) * xi;
      }
    }
  }
  return {
    part: { name: 'strip', kind: 'strip', coords, tris: blockTris(nx, rows, lay), symmetry: STRIP_SYM },
    values: { disp: null, fields },
  };
}

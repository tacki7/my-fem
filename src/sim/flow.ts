/**
 * Steady-state rigid-viscoplastic flow formulation for the strip in a roll bite.
 *
 * This is the classical metal-forming "flow formulation" (Kobayashi, Oh &
 * Altan): the workpiece is treated as an incompressible rigid-plastic
 * continuum, elastic strains are neglected, and the unknown is the steady
 * velocity field rather than a displacement history. Markov's variational
 * principle,
 *
 *     Pi(v) = INT sigma_f * eps_eff(v) dV + (K/2) INT (div v)^2 dV - INT t.v dS
 *
 * is stationary at the true field. Freezing the effective viscosity
 *
 *     mu_eff = sigma_f / (3 * sqrt(eps_eff^2 + eps0^2))
 *
 * from the previous iterate turns each step into a linear Stokes-like solve
 * (direct / Picard iteration), which is what makes this affordable in real
 * time: no time stepping, no contact search, no streaming mesh. The regulariser
 * eps0 keeps the viscosity finite in the rigid zones ahead of and behind the
 * bite.
 *
 * The mesh conforms to the roll gap, so the interface is a boundary condition
 * rather than a contact problem: normal velocity is penalised to zero on the
 * arc and friction enters as a tangential traction.
 */

import {
  buildCsrPattern, spmv, makePcgWorkspace, pcgFiltered, patternBytes, workspaceBytes,
  type CsrPattern, type PcgWorkspace,
} from './sparse';
import { BandPreconditioner } from './band';

const G = 1 / Math.sqrt(3);
const GP: [number, number][] = [[-G, -G], [G, -G], [G, G], [-G, G]];

export interface FlowMesh {
  nx: number;
  ny: number;
  rows: number;
  nn: number;
  ne: number;
  /** nodal coordinates, xy interleaved (updated when the gap profile moves) */
  X: Float64Array;
  quads: Int32Array;
  tris: Uint32Array;
  edges: Uint32Array;
  /** x station of each column */
  xs: Float64Array;
  topNodes: Int32Array;
  bottomNodes: Int32Array;
}

export function buildFlowMesh(nx: number, ny: number): FlowMesh {
  const rows = ny + 1;
  const cols = nx + 1;
  const nn = cols * rows;
  const ne = nx * ny;
  const quads = new Int32Array(4 * ne);
  let q = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      quads[q++] = i * rows + j;
      quads[q++] = (i + 1) * rows + j;
      quads[q++] = (i + 1) * rows + j + 1;
      quads[q++] = i * rows + j + 1;
    }
  }
  const tris = new Uint32Array(6 * ne);
  for (let e = 0; e < ne; e++) {
    const a = quads[4 * e], b = quads[4 * e + 1], c = quads[4 * e + 2], d = quads[4 * e + 3];
    tris[6 * e] = a; tris[6 * e + 1] = b; tris[6 * e + 2] = c;
    tris[6 * e + 3] = a; tris[6 * e + 4] = c; tris[6 * e + 5] = d;
  }
  const edgeList: number[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (i < nx) edgeList.push(i * rows + j, (i + 1) * rows + j);
      if (j < ny) edgeList.push(i * rows + j, i * rows + j + 1);
    }
  }
  const topNodes = new Int32Array(cols);
  const bottomNodes = new Int32Array(cols);
  for (let i = 0; i < cols; i++) {
    topNodes[i] = i * rows + ny;
    bottomNodes[i] = i * rows;
  }
  return {
    nx, ny, rows, nn, ne, X: new Float64Array(2 * nn), quads, tris,
    edges: new Uint32Array(edgeList), xs: new Float64Array(cols),
    topNodes, bottomNodes,
  };
}

export interface FlowInput {
  /** flow stress at each node [Pa], from the hardening law and strain history */
  sigmaF: Float64Array;
  /** entry speed [m/s], prescribed on the upstream face */
  vIn: number;
  /** roll surface speed [m/s] */
  vRoll: number;
  /** roll centre, for the interface tangent/normal directions */
  rollCx: number;
  rollCy: number;
  /** columns i where the strip touches the barrel */
  contactFrom: number;
  contactTo: number;
  /**
   * Fraction of each column's tributary length that actually lies inside the
   * contact arc, 0..1.
   *
   * Without it a column joins or leaves the arc in one jump, and with only a
   * couple of dozen columns spanning the bite that quantises the rolling load
   * by several percent - which reads as a permanent oscillation once the roll
   * flattening loop starts chasing it.
   */
  contactWeight: Float64Array;
  /** constrain the entry node along the mean slope of its two facets rather than radially - see `applyInterface` */
  entryBisector: boolean;
  /** Coulomb friction coefficient */
  mu: number;
  /** friction regularisation velocity [m/s] */
  vSlip0: number;
  /**
   * Bulk viscosity used for the volumetric response [Pa s].
   *
   * A rigid-plastic body is incompressible and this is only a penalty. With the
   * elastic overlay on it is the physical bulk modulus times the bite transit
   * time, so the volumetric response over one pass through the roll is the
   * material's true elastic one - which is what lets the strip compress on the
   * way in and spring back on the way out.
   */
  kBulk: number;
  /** normal velocity penalty on the barrel, same units as the bulk penalty */
  normalPenalty: number;
  /** strain-rate regulariser [1/s] */
  eps0: number;
  /**
   * Upper limit on the effective viscosity [Pa s].
   *
   * Away from the plastic zone the flow formulation has nothing to stop the
   * viscosity running away, and clamping it at an arbitrary multiple of the
   * plastic value makes the entry and exit zones arbitrarily rigid. The
   * physical ceiling is the elastic shear response over the transit time,
   * G * t_transit: a material point cannot be stiffer than its own elasticity
   * while it is inside the bite.
   */
  muCap: number;
  /**
   * Reference viscosity [Pa s], sigma_f / (3 * nominal bite strain rate).
   *
   * The penalties are scaled off this rather than off the mean viscosity of the
   * field: the rigid zones upstream and downstream carry a viscosity two orders
   * of magnitude higher, and letting them set the penalty would make the system
   * unsolvable.
   */
  muRef: number;
  /** back / front tension [Pa] */
  backTension: number;
  frontTension: number;
  maxIter: number;
  tol: number;
}

export interface FlowResult {
  iterations: number;
  residual: number;
  /** L2 change of the velocity field between the last two Picard iterates */
  picardDelta: number;
}

export class FlowSolver {
  mesh: FlowMesh;
  pattern: CsrPattern;
  private ws: PcgWorkspace;
  private pre: BandPreconditioner;

  /** nodal velocity field, xy interleaved */
  v: Float64Array;
  private vPrev: Float64Array;
  private free: Uint8Array;
  private vals: Float64Array;
  private b: Float64Array;
  private dv: Float64Array;
  private tmp: Float64Array;
  private vFix: Float64Array;

  /** per element, per Gauss point: effective strain rate [1/s] */
  epsRate: Float64Array;
  /** per element, per Gauss point: effective viscosity [Pa s] */
  private muEff: Float64Array;
  /** per Gauss point: 1 where the point sits on the elastic branch */
  elasticGp: Uint8Array;
  /** per element stress, averaged over Gauss points: xx, yy, xy, hydrostatic */
  elemStress: Float64Array;

  /** interface pressure [Pa] and shear traction [Pa] per top-surface column */
  ifPressure: Float64Array;
  ifShear: Float64Array;
  ifSlip: Float64Array;
  ifActive: Uint8Array;
  private ifSmooth: Float64Array;

  lastAssembleMs = 0;
  lastSolveMs = 0;
  lastFactorMs = 0;

  // scratch
  private dxi = new Float64Array(4);
  private det = new Float64Array(4);
  private Bs = new Float64Array(4 * 24);
  private detJ = new Float64Array(4);
  private Bv = new Float64Array(8);
  private Ke = new Float64Array(64);
  private xe = new Float64Array(8);
  private ve = new Float64Array(8);

  constructor(nx: number, ny: number) {
    this.mesh = buildFlowMesh(nx, ny);
    this.pattern = buildCsrPattern(this.mesh.nn, this.mesh.quads);
    this.ws = makePcgWorkspace(this.pattern.n);
    this.pre = new BandPreconditioner(this.pattern.n, 2 * (this.mesh.rows + 1) + 1);
    const n = this.pattern.n;
    this.v = new Float64Array(n);
    this.vPrev = new Float64Array(n);
    this.free = new Uint8Array(n).fill(1);
    this.vals = new Float64Array(this.pattern.nnz);
    this.b = new Float64Array(n);
    this.dv = new Float64Array(n);
    this.tmp = new Float64Array(n);
    this.vFix = new Float64Array(n);
    this.epsRate = new Float64Array(4 * this.mesh.ne);
    this.muEff = new Float64Array(4 * this.mesh.ne);
    this.elasticGp = new Uint8Array(4 * this.mesh.ne);
    this.elemStress = new Float64Array(4 * this.mesh.ne);
    this.ifPressure = new Float64Array(nx + 1);
    this.ifShear = new Float64Array(nx + 1);
    this.ifSlip = new Float64Array(nx + 1);
    this.ifActive = new Uint8Array(nx + 1);
    this.ifSmooth = new Float64Array(nx + 1);

    // symmetry plane and the prescribed entry face
    for (const nd of this.mesh.bottomNodes) this.free[2 * nd + 1] = 0;
    for (let j = 0; j < this.mesh.rows; j++) {
      this.free[2 * j] = 0;
      this.free[2 * j + 1] = 0;
    }
  }

  /**
   * Longitudinal reaction the prescribed feed face has to supply [N/m].
   *
   * K v = f + R at the constrained rows. A free-running stand has nothing to
   * push against, so the outer loop drives this to zero by adjusting the feed
   * speed; what is left over is the equivalent of a pinch-roll force.
   */
  feedReaction(): number {
    spmv(this.pattern, this.vals, this.v, this.tmp);
    let r = 0;
    for (let j = 0; j < this.mesh.rows; j++) r += this.tmp[2 * j] - this.b[2 * j];
    return r;
  }

  /**
   * Height of the prescribed feed face [m]: half the entry thickness in this
   * symmetric model. A pull of σ on that face is a force σ times this, per unit
   * width - the same conversion `applyTensions` makes - so a reaction divided
   * by it is the pull the face is standing in for.
   */
  feedFaceHeight(): number {
    const m = this.mesh;
    return m.X[2 * m.ny + 1] - m.X[1];
  }

  /**
   * Everything this solver is holding.
   *
   * Counted array by array rather than by multiplying one length by a
   * remembered count: the previous version did that and had drifted two arrays
   * out of date, under-reporting by about a megabyte on a fine mesh - which is
   * the opposite of useful in a readout whose whole job is to say how much a
   * finer mesh will cost.
   */
  byteLength(): number {
    let t = 0;
    for (const a of [
      this.v, this.vPrev, this.b, this.dv, this.tmp, this.vFix, this.free,
      this.vals,
      this.epsRate, this.muEff, this.elemStress, this.elasticGp,
      this.ifPressure, this.ifShear, this.ifSlip, this.ifSmooth, this.ifActive,
      this.mesh.X, this.mesh.quads, this.mesh.tris, this.mesh.edges,
      this.mesh.xs, this.mesh.topNodes, this.mesh.bottomNodes,
    ]) t += a.byteLength;
    return t + patternBytes(this.pattern) + workspaceBytes(this.ws) + this.pre.byteLength();
  }

  /**
   * Seed with the one-dimensional volume-constant field: vx from h(x)*v = const
   * and vy from the surface slope, so the starting guess is already nearly
   * divergence free and the incompressibility penalty does not fire a huge
   * spurious force on the first iteration.
   */
  seed(vIn: number, halfIn: number): void {
    const m = this.mesh;
    for (let i = 0; i <= m.nx; i++) {
      const top = m.X[2 * m.topNodes[i] + 1];
      const vx = (vIn * halfIn) / Math.max(top, 1e-9);
      const ia = Math.max(0, i - 1), ib = Math.min(m.nx, i + 1);
      const slope = (m.X[2 * m.topNodes[ib] + 1] - m.X[2 * m.topNodes[ia] + 1])
        / Math.max(m.xs[ib] - m.xs[ia], 1e-12);
      for (let j = 0; j < m.rows; j++) {
        const nd = i * m.rows + j;
        this.v[2 * nd] = vx;
        this.v[2 * nd + 1] = vx * slope * (j / m.ny);
      }
    }
  }

  /**
   * One Picard iteration: freeze the viscosity and the friction slope, then
   * solve the resulting linear Stokes-like system for the *total* velocity
   * field. `relax` under-relaxes the update, which is what keeps the iteration
   * contractive while the rigid zones are still finding their viscosity.
   */
  solve(inp: FlowInput, relax: number): FlowResult {
    const m = this.mesh;
    const n = this.pattern.n;
    this.vPrev.set(this.v);

    const tA = performance.now();
    this.updateViscosity(inp);
    this.assemble(inp);
    this.lastAssembleMs = performance.now() - tA;

    // prescribed entry face: uniform feed, no transverse motion
    this.vFix.fill(0);
    for (let j = 0; j < m.rows; j++) {
      this.vFix[2 * j] = inp.vIn;
      this.vFix[2 * j + 1] = 0;
    }
    spmv(this.pattern, this.vals, this.vFix, this.tmp);
    for (let i = 0; i < n; i++) if (this.free[i]) this.b[i] -= this.tmp[i];

    // warm start from the previous field, with the constrained part removed
    for (let i = 0; i < n; i++) this.dv[i] = this.free[i] ? this.v[i] : 0;

    const tF = performance.now();
    this.pre.factor(this.pattern, this.vals, this.free);
    this.lastFactorMs = performance.now() - tF;

    const tS = performance.now();
    const r = pcgFiltered(this.pattern, this.vals, this.b, this.free, this.dv,
      this.ws, inp.maxIter, inp.tol, true, this.pre);
    this.lastSolveMs = performance.now() - tS;

    let delta = 0, scale = 0;
    for (let i = 0; i < n; i++) {
      const target = this.free[i] ? this.dv[i] : this.vFix[i];
      const nv = this.vPrev[i] + relax * (target - this.vPrev[i]);
      this.v[i] = nv;
      const d = nv - this.vPrev[i];
      delta += d * d;
      scale += nv * nv;
    }
    this.recoverStress(inp);
    return {
      iterations: r.iterations,
      residual: r.residual,
      picardDelta: Math.sqrt(delta / Math.max(scale, 1e-30)),
    };
  }

  /** Effective strain rate and viscosity at every Gauss point. */
  private updateViscosity(inp: FlowInput): number {
    const m = this.mesh;
    const muLo = inp.muRef * 0.05;
    const muHi = inp.muCap;
    let sum = 0;
    for (let e = 0; e < m.ne; e++) {
      this.gather(e);
      this.shapeAt(e);
      // element flow stress from the nodal values
      let sf = 0;
      for (let k = 0; k < 4; k++) sf += inp.sigmaF[m.quads[4 * e + k]];
      sf *= 0.25;
      for (let g = 0; g < 4; g++) {
        const bo = 24 * g;
        let exx = 0, eyy = 0, gxy = 0;
        for (let a = 0; a < 8; a++) {
          exx += this.Bs[bo + a] * this.ve[a];
          eyy += this.Bs[bo + 8 + a] * this.ve[a];
          gxy += this.Bs[bo + 16 + a] * this.ve[a];
        }
        const ev = exx + eyy;
        const dxx = exx - ev / 3, dyy = eyy - ev / 3, dzz = -ev / 3;
        const eff = Math.sqrt((2 / 3) * (dxx * dxx + dyy * dyy + dzz * dzz + gxy * gxy / 2));
        this.epsRate[4 * e + g] = eff;
        let mu = sf / (3 * Math.sqrt(eff * eff + inp.eps0 * inp.eps0));
        // clamping keeps the rigid zones stiff without wrecking the condition
        // number of the linear system
        // hitting the ceiling means the point is riding the elastic branch:
        // stressed but not yet flowing
        let elastic = 0;
        if (mu < muLo) mu = muLo;
        else if (mu > muHi) { mu = muHi; elastic = 1; }
        this.elasticGp[4 * e + g] = elastic;
        this.muEff[4 * e + g] = mu;
        sum += mu;
      }
    }
    return sum / (4 * m.ne);
  }

  private gather(e: number): void {
    const m = this.mesh;
    for (let k = 0; k < 4; k++) {
      const nd = m.quads[4 * e + k];
      this.xe[2 * k] = m.X[2 * nd];
      this.xe[2 * k + 1] = m.X[2 * nd + 1];
      this.ve[2 * k] = this.v[2 * nd];
      this.ve[2 * k + 1] = this.v[2 * nd + 1];
    }
  }

  /** Fill Bs / detJ / Bv (centroid dilatation row) for element `e`. */
  private shapeAt(_e: number): void {
    for (let g = 0; g < 4; g++) {
      const xi = GP[g][0], eta = GP[g][1];
      this.fillDeriv(xi, eta);
      let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
      for (let k = 0; k < 4; k++) {
        J00 += this.dxi[k] * this.xe[2 * k]; J01 += this.dxi[k] * this.xe[2 * k + 1];
        J10 += this.det[k] * this.xe[2 * k]; J11 += this.det[k] * this.xe[2 * k + 1];
      }
      const dj = J00 * J11 - J01 * J10;
      const inv = 1 / dj;
      this.detJ[g] = dj;
      const bo = 24 * g;
      for (let k = 0; k < 4; k++) {
        const gx = inv * (J11 * this.dxi[k] - J01 * this.det[k]);
        const gy = inv * (-J10 * this.dxi[k] + J00 * this.det[k]);
        this.Bs[bo + 2 * k] = gx;      this.Bs[bo + 2 * k + 1] = 0;
        this.Bs[bo + 8 + 2 * k] = 0;   this.Bs[bo + 8 + 2 * k + 1] = gy;
        this.Bs[bo + 16 + 2 * k] = gy; this.Bs[bo + 16 + 2 * k + 1] = gx;
      }
    }
    // centroid, for the reduced volumetric term
    this.fillDeriv(0, 0);
    let J00 = 0, J01 = 0, J10 = 0, J11 = 0;
    for (let k = 0; k < 4; k++) {
      J00 += this.dxi[k] * this.xe[2 * k]; J01 += this.dxi[k] * this.xe[2 * k + 1];
      J10 += this.det[k] * this.xe[2 * k]; J11 += this.det[k] * this.xe[2 * k + 1];
    }
    const dj = J00 * J11 - J01 * J10;
    const inv = 1 / dj;
    for (let k = 0; k < 4; k++) {
      this.Bv[2 * k] = inv * (J11 * this.dxi[k] - J01 * this.det[k]);
      this.Bv[2 * k + 1] = inv * (-J10 * this.dxi[k] + J00 * this.det[k]);
    }
  }

  private fillDeriv(xi: number, eta: number): void {
    this.dxi[0] = -0.25 * (1 - eta); this.dxi[1] = 0.25 * (1 - eta);
    this.dxi[2] = 0.25 * (1 + eta);  this.dxi[3] = -0.25 * (1 + eta);
    this.det[0] = -0.25 * (1 - xi);  this.det[1] = -0.25 * (1 + xi);
    this.det[2] = 0.25 * (1 + xi);   this.det[3] = 0.25 * (1 - xi);
  }

  private assemble(inp: FlowInput): void {
    const m = this.mesh;
    const { scatter, diagIdx } = this.pattern;
    const vals = this.vals;
    vals.fill(0);
    this.b.fill(0);
    const Kpen = inp.kBulk;

    for (let e = 0; e < m.ne; e++) {
      this.gather(e);
      this.shapeAt(e);
      const Ke = this.Ke;
      Ke.fill(0);

      for (let g = 0; g < 4; g++) {
        const bo = 24 * g;
        const w = this.detJ[g];
        const mu2 = 2 * this.muEff[4 * e + g] * w;
        for (let a = 0; a < 8; a++) {
          const b0 = this.Bs[bo + a], b1 = this.Bs[bo + 8 + a], b2 = this.Bs[bo + 16 + a];
          for (let bb = a; bb < 8; bb++) {
            const c0 = this.Bs[bo + bb], c1 = this.Bs[bo + 8 + bb], c2 = this.Bs[bo + 16 + bb];
            // D_dev = 2 mu [[2/3,-1/3,0],[-1/3,2/3,0],[0,0,1/2]]
            const val = mu2 * (
              b0 * ((2 / 3) * c0 - (1 / 3) * c1) +
              b1 * (-(1 / 3) * c0 + (2 / 3) * c1) +
              b2 * (0.5 * c2)
            );
            Ke[a * 8 + bb] += val;
            if (bb !== a) Ke[bb * 8 + a] += val;
          }
        }
      }
      // volumetric penalty, one point at the centroid: the standard cure for
      // the locking a fully integrated Q4 would otherwise show at div v = 0
      {
        let area = 0;
        for (let g = 0; g < 4; g++) area += this.detJ[g];
        const cw = Kpen * area;
        for (let a = 0; a < 8; a++) {
          for (let bb = a; bb < 8; bb++) {
            const val = cw * this.Bv[a] * this.Bv[bb];
            Ke[a * 8 + bb] += val;
            if (bb !== a) Ke[bb * 8 + a] += val;
          }
        }
      }

      const sb = 64 * e;
      for (let a = 0; a < 8; a++) {
        for (let bb = 0; bb < 8; bb++) {
          vals[scatter[sb + a * 8 + bb]] += Ke[a * 8 + bb];
        }
      }
    }

    this.applyInterface(inp, diagIdx, vals);
    this.applyTensions(inp);
  }

  /**
   * Barrel interface: normal velocity penalised to zero, friction applied as a
   * regularised Coulomb traction using the pressure from the previous iterate.
   *
   * The normal is the *mesh surface's*, not the radial direction from the
   * roll centre. The strip's top nodes are laid on the deformed, low-passed,
   * monotone-clamped barrel profile (see `updateGap`), and with the roll
   * flattened to R' = 1.4 R that surface is nowhere tangent to the undeformed
   * circle: its slope is 4 % shallower mid-arc and still −0.4 % at the exit
   * plane where the circle is flat. Pinning the velocity tangent to the circle
   * made the surface leak - v_y − v_x·s' reached 0.5 % of v_x, volume crossed
   * the top of the mesh into the bite over the entry half (+0.8 % of the
   * throughput mid-arc on the default pass, +1.6 % on the third stand) and
   * back out at the exit, and each stand delivered 0.4-0.8 % less volume than
   * it took in, more on finer meshes rather than less. Tangent to the surface
   * it sits on, the top is a streamline and the flux is conserved.
   *
   * The same pass also closes the *free* part of the top surface. Off the arc
   * the surface y = s(x) is steady, so it is a streamline:
   *
   *     v . n_s = 0,     n_s ∝ (-s', 1)
   *
   * which upstream, where the strip is flat, is just v_y = 0. Nothing used to
   * enforce that, and it is not a detail: the run-in is only "rigid" through a
   * capped viscosity, so under the pressure the bite pushes back upstream the
   * material simply squeezes out through the top of the mesh. At 25% reduction
   * the leak is 3e-6 of the axial speed and invisible; at 93% it is 4.5e-2, and
   * half the incoming flux never reaches the roll at all.
   */
  private applyInterface(
    inp: FlowInput, diagIdx: Int32Array, vals: Float64Array,
  ): void {
    const m = this.mesh;
    const kN = inp.normalPenalty * inp.muRef;
    this.ifActive.fill(0);
    this.ifShear.fill(0);
    this.ifSlip.fill(0);

    // add w * (d outer d) into the 2x2 diagonal block of node `nd`
    const addBlock = (nd: number, dx: number, dy: number, w: number) => {
      const r0 = diagIdx[2 * nd], r1 = diagIdx[2 * nd + 1];
      vals[r0] += w * dx * dx;
      vals[r0 + 1] += w * dx * dy;
      vals[r1 - 1] += w * dy * dx;
      vals[r1] += w * dy * dy;
    };

    for (let i = inp.contactFrom; i <= inp.contactTo; i++) {
      const nd = m.topNodes[i];
      const w = inp.contactWeight[i];
      // The surface normal from the mean slope of the node's two facets -
      // the same streamline condition the free surface gets, with the normal
      // pointing down into the strip and the tangent along +x. At the bite
      // entry this is also the bisector the entry node always needed (pinned
      // radially there it was sent downward across a facet still horizontal,
      // 1.1 % of the throughput in through the top and a pressure spike).
      const { sp } = this.surfaceSlope(i);
      const L = Math.hypot(sp, 1);
      const nx = sp / L, ny = -1 / L;
      // for omega > 0 the barrel material runs along +t at the bite
      const tx = -ny, ty = nx;
      const iPrev = Math.max(inp.contactFrom, i - 1);
      const iNext = Math.min(inp.contactTo, i + 1);
      const seg = Math.max(
        (m.X[2 * m.topNodes[iNext]] - m.X[2 * m.topNodes[iPrev]]) / (iNext - iPrev), 1e-9);
      // the length of this node's tributary that is actually on the roll -
      // half a column at either end of the arc, the whole column between
      const onRoll = Math.max(seg * Math.min(1, Math.max(w, 0)), 1e-12);
      this.ifActive[i] = 1;

      // No penetration through the barrel. The penalty is a multiple of the
      // reference viscosity, which is also the scale of the bulk stiffness, so
      // normalPenalty is directly "how many times stiffer than the material".
      addBlock(nd, nx, ny, kN);

      // regularised Coulomb friction against the barrel surface speed
      const vTan = this.v[2 * nd] * tx + this.v[2 * nd + 1] * ty;
      const slip = vTan - inp.vRoll;
      this.ifSlip[i] = slip;
      const cap = inp.mu * Math.max(this.ifPressure[i], 0) * onRoll;
      const fT = -cap * (2 / Math.PI) * Math.atan(slip / inp.vSlip0);
      this.ifShear[i] = fT / onRoll;
      const dfd = (cap * (2 / Math.PI)) / (inp.vSlip0 * (1 + (slip / inp.vSlip0) ** 2));
      addBlock(nd, tx, ty, dfd);
      const c = fT + dfd * vTan;
      this.b[2 * nd] += c * tx;
      this.b[2 * nd + 1] += c * ty;
    }

    // Free surface off the arc, blended against the contact coverage so the
    // two conditions hand over smoothly at the bite entry instead of both
    // acting at full strength on the same node.
    for (let i = 0; i <= m.nx; i++) {
      // Strictly outside the arc. Blending the two conditions by contact
      // coverage instead sounds tidier and is much worse: a partially covered
      // node then carries the barrel constraint at full strength *and* a free
      // surface it is not on, which pins the bite entry and drives the forward
      // slip to nonsense (-53% at every reduction).
      if (i >= inp.contactFrom && i <= inp.contactTo) continue;
      const nd = m.topNodes[i];
      const { sp } = this.surfaceSlope(i);
      const L = Math.hypot(sp, 1);
      addBlock(nd, -sp / L, 1 / L, kN);
    }
  }

  /** Slope of the top surface at column i, from its two neighbours. */
  private surfaceSlope(i: number): { sp: number } {
    const m = this.mesh;
    const ip = Math.min(m.nx, i + 1);
    const im = Math.max(0, i - 1);
    const dx = m.X[2 * m.topNodes[ip]] - m.X[2 * m.topNodes[im]];
    const ds = m.X[2 * m.topNodes[ip] + 1] - m.X[2 * m.topNodes[im] + 1];
    return { sp: Math.abs(dx) > 1e-12 ? ds / dx : 0 };
  }

  private applyTensions(inp: FlowInput): void {
    const m = this.mesh;
    const push = (col: number, sigma: number, sign: number) => {
      if (sigma === 0) return;
      const base = col * m.rows;
      const t = m.X[2 * (base + m.ny) + 1] - m.X[2 * base + 1];
      const total = sign * sigma * t;
      for (let j = 0; j < m.rows; j++) {
        const w = j === 0 || j === m.ny ? 0.5 : 1;
        this.b[2 * (base + j)] += (total * w) / m.ny;
      }
    };
    push(0, inp.backTension, -1);
    push(m.nx, inp.frontTension, +1);
  }

  /** Element stresses and the interface pressure implied by the new field. */
  private recoverStress(inp: FlowInput): void {
    const m = this.mesh;
    const Kpen = inp.kBulk;
    for (let e = 0; e < m.ne; e++) {
      this.gather(e);
      this.shapeAt(e);
      let sxx = 0, syy = 0, sxy = 0, hyd = 0;
      let dil = 0;
      for (let a = 0; a < 8; a++) dil += this.Bv[a] * this.ve[a];
      for (let g = 0; g < 4; g++) {
        const bo = 24 * g;
        let exx = 0, eyy = 0, gxy = 0;
        for (let a = 0; a < 8; a++) {
          exx += this.Bs[bo + a] * this.ve[a];
          eyy += this.Bs[bo + 8 + a] * this.ve[a];
          gxy += this.Bs[bo + 16 + a] * this.ve[a];
        }
        const ev = exx + eyy;
        const mu = this.muEff[4 * e + g];
        sxx += 2 * mu * (exx - ev / 3);
        syy += 2 * mu * (eyy - ev / 3);
        sxy += mu * gxy;
      }
      sxx *= 0.25; syy *= 0.25; sxy *= 0.25;
      // The penalty term (K/2) INT (div v)^2 contributes sigma_pen = K (div v) I,
      // so the mean stress follows the dilatation with a *positive* sign:
      // material being squeezed has div v < 0 and is therefore in compression.
      hyd = Kpen * dil;
      const o = 4 * e;
      this.elemStress[o] = sxx + hyd;
      this.elemStress[o + 1] = syy + hyd;
      this.elemStress[o + 2] = sxy;
      this.elemStress[o + 3] = hyd;
    }

    // Interface pressure from the surface elements. The first and last columns
    // of the arc sit on a partially loaded element, so they are reconstructed
    // from their neighbour instead of being trusted directly.
    for (let i = inp.contactFrom; i <= inp.contactTo; i++) {
      if (inp.contactWeight[i] <= 1e-6) { this.ifPressure[i] = 0; continue; }
      // The same surface normal the constraint uses, so the pressure is the
      // traction normal to the surface the strip actually sits on.
      const { sp } = this.surfaceSlope(i);
      const L = Math.hypot(sp, 1);
      const nx = sp / L, ny = -1 / L;
      const ei = Math.min(m.nx - 1, Math.max(0, i - 1)) * m.ny + (m.ny - 1);
      const o = 4 * ei;
      const sxx = this.elemStress[o], syy = this.elemStress[o + 1], sxy = this.elemStress[o + 2];
      const snn = sxx * nx * nx + 2 * sxy * nx * ny + syy * ny * ny;
      this.ifPressure[i] = Math.max(0, -snn);
    }
    const lo = inp.contactFrom, hi = inp.contactTo;
    if (hi - lo >= 3) {
      this.ifPressure[lo] = this.ifPressure[lo + 1];
      this.ifPressure[hi] = this.ifPressure[hi - 1];
      // one pass of 1-2-1 smoothing tames the checkerboard the reduced
      // volumetric integration leaves in the recovered pressure
      const tmp = this.ifSmooth;
      for (let i = lo; i <= hi; i++) {
        const a = this.ifPressure[Math.max(lo, i - 1)];
        const b = this.ifPressure[i];
        const c = this.ifPressure[Math.min(hi, i + 1)];
        tmp[i] = 0.25 * a + 0.5 * b + 0.25 * c;
      }
      for (let i = lo; i <= hi; i++) this.ifPressure[i] = tmp[i];
    }
  }
}

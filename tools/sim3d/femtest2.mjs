import { StripFem } from './build/stripfem.js';
import { kfAt } from './build/strip.js';
const law = { lmnL: 1200e6, lmnM: 0.01, lmnN: 0.255, E: 206e9, nu: 0.3, entryStrain: 0, mu: 0.06, R: 0.25, Eroll: 206e9, nuRoll: 0.3 };
const nx = 9, nz = 8, mu = +(process.argv[2] ?? 0), tens = +(process.argv[3] ?? 0), KF = process.argv[4] === "const", tensF = +(process.argv[5] ?? tens);
const W = 1.0, h0 = 2e-3, h1 = 1.5e-3, Larc = 16.5e-3;
const x = new Float64Array(nx), w = new Float64Array(nx), H0 = new Float64Array(nx), H1 = new Float64Array(nx), L = new Float64Array(nx), sB = new Float64Array(nx), sF = new Float64Array(nx);
for (let i = 0; i < nx; i++) { x[i] = -W / 2 + (W * (i + 0.5)) / nx; w[i] = W / nx; H0[i] = h0; H1[i] = h1; L[i] = Larc; sB[i] = tens; sF[i] = tensF; }
const fem = new StripFem();
const r = fem.solve({ x, w, h0: H0, h1: H1, L, kf: (i, e) => (KF ? 740e6 : kfAt(law, e)), mu, sigmaB: sB, sigmaF: sF, nz, vRoll: 1 });
const mid = Math.floor(nx / 2);
console.log(`mu ${mu} tension ${tens / 1e6} MPa kf ${KF ? 'const 740' : 'LMN'}: its ${r.iterations} q centre ${(r.q[mid] / 1e6).toFixed(2)} kN/mm (kf·L = ${(740e6 * Larc / 1e6).toFixed(2)}) vIn ${r.vIn.toFixed(4)} vExit ${r.vExit[mid].toFixed(4)} mass ${r.massRatio.toFixed(4)}`);
const prof = []; for (let j = 0; j < nz; j++) prof.push((r.p[mid * nz + j] / 1e6).toFixed(0)); console.log('  p(z) [MPa]:', prof.join(' '));
const kfs = []; for (let j = 0; j < nz; j++) { const t = 1 - (j + 0.5) / nz; const h = h1 + (h0 - h1) * t * t; kfs.push((kfAt(law, 1.1547 * Math.log(h0 / h)) / 1e6).toFixed(0)); } console.log('  kf(z) [MPa]:', kfs.join(' '));
const d = r.debug; const row = (a, f = 0) => { const o = []; for (let j = 0; j < nz; j++) o.push((a[mid * nz + j] / (f || 1)).toFixed(f ? 0 : 3)); return o.join(' '); };
console.log('  s_y [MPa]:', row(d.sy, 1e6)); console.log('  s_z [MPa]:', row(d.sz, 1e6)); console.log('  σ_m [MPa]:', row(d.sm, 1e6)); console.log('  σ_z = s_z+σ_m:', (() => { const o = []; for (let j = 0; j < nz; j++) o.push(((d.sz[mid*nz+j] + d.sm[mid*nz+j]) / 1e6).toFixed(0)); return o.join(' '); })());
console.log('  div(hu)/h [1/s]:', row(d.div)); console.log('  eps_eq [1/s]:', row(d.eq));

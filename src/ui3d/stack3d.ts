/**
 * The roll stack in three dimensions: shaded steel cylinders along the
 * width, bent by the solved deflections (magnified), coloured by the
 * contact load under the barrel, chocks at the supports, the strip as a
 * plate through the pass line with its thickness profile magnified and its
 * manifest shape defect drawn as the wave it is, the lower half mirrored
 * from the upper so the whole mill is seen. Orbit with the mouse, zoom with
 * the wheel, double-click to reset.
 *
 * Deflection is shown as bending only: each roll's rigid translation (the
 * sink under the screw, which is the same for the whole stack) is taken out
 * before magnifying, so rolls that touch in the solution still touch in the
 * picture at any magnification. Magnified absolute displacement pushed
 * tangent rolls tens of millimetres into each other.
 *
 * WebGL2 with nothing else, like the 2D tab's renderer: three small
 * programs (background, lit mesh, lines), one interleaved buffer rebuilt
 * when the solution moves. Labels are DOM nodes placed by projecting a point
 * on each roll, so they stay crisp.
 */

import type { Result3D } from '../sim3d/solver';
import type { Stack } from '../sim3d/stack';
import { onBarrel } from '../sim3d/stack';

const HDR = '#version 300 es\nprecision highp float;\n';

const BG_VS = `${HDR}
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() { vUv = P[gl_VertexID] * 0.5 + 0.5; gl_Position = vec4(P[gl_VertexID], 0.999, 1.0); }`;
const BG_FS = `${HDR}
in vec2 vUv; out vec4 o;
void main() {
  vec3 top = vec3(0.075, 0.10, 0.155), bot = vec3(0.022, 0.03, 0.05);
  float r = length(vUv - vec2(0.5, 0.62));
  vec3 c = mix(top, bot, smoothstep(0.0, 0.95, r));
  o = vec4(c, 1.0);
}`;

const MESH_VS = `${HDR}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aCol;
uniform mat4 uProj, uView;
out vec3 vPos; out vec3 vNrm; out vec4 vCol;
void main() { vPos = aPos; vNrm = aNrm; vCol = aCol; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
// aCol.a = metalness: 1 = steel with an environment sheen, 0 = matte
const MESH_FS = `${HDR}
in vec3 vPos; in vec3 vNrm; in vec4 vCol;
uniform vec3 uEye, uKey, uFill;
out vec4 o;
vec3 env(vec3 d) {
  // a procedural sky: bright band above the horizon, dark ground, a soft key highlight
  float h = d.y;
  vec3 sky = mix(vec3(0.16, 0.19, 0.25), vec3(0.62, 0.70, 0.82), smoothstep(-0.1, 0.6, h));
  vec3 ground = vec3(0.06, 0.07, 0.09);
  vec3 c = mix(ground, sky, smoothstep(-0.25, 0.05, h));
  float lamp = pow(max(dot(d, normalize(uKey)), 0.0), 24.0);
  return c + vec3(0.9, 0.92, 1.0) * lamp * 0.5;
}
void main() {
  vec3 n = normalize(vNrm);
  vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 k = normalize(uKey), f = normalize(uFill);
  float dk = max(dot(n, k), 0.0), df = max(dot(n, f), 0.0);
  vec3 hk = normalize(k + v);
  float spec = pow(max(dot(n, hk), 0.0), 60.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 base = vCol.rgb;
  float metal = vCol.a;
  vec3 diffuse = base * (0.20 + 0.55 * dk + 0.22 * df);
  vec3 refl = env(reflect(-v, n)) * base * (0.55 + 0.45 * fres);
  vec3 c = mix(diffuse, refl, metal * 0.55) + vec3(0.6) * spec * (0.5 + 0.5 * metal) + vec3(0.10, 0.13, 0.18) * fres;
  o = vec4(c, 1.0);
}`;

const LINE_VS = `${HDR}
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uView;
void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const LINE_FS = `${HDR}
uniform vec4 uCol; out vec4 o;
void main() { o = uCol; }`;

type M4 = Float32Array;
const perspective = (fovy: number, aspect: number, near: number, far: number): M4 => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
};
const lookAt = (eye: number[], at: number[], up: number[]): M4 => {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
};
const mul = (a: M4, b: M4): M4 => {
  const m = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    m[i * 4 + j] = s;
  }
  return m;
};

type Col = [number, number, number, number];
const STEEL: Col = [0.60, 0.64, 0.70, 1];
const NECK: Col = [0.42, 0.46, 0.52, 1];
const CHOCK: Col = [0.22, 0.25, 0.30, 0.2];
/** load share t in [0, 1] as a colour on steel */
function heat(t: number): Col {
  const c = Math.max(0, Math.min(1, t));
  if (c <= 0.002) return STEEL;
  const warm = [0.95, 0.82, 0.32], hot = [1.0, 0.42, 0.10];
  const mix = (a: number[], b: number[], u: number) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  const m = c < 0.5 ? mix(STEEL, warm, c * 2) : mix(warm, hot, (c - 0.5) * 2);
  return [m[0], m[1], m[2], 1 - 0.5 * c];
}

const SEG = 48;
const STRIDE = 10;
/** rows along the rolling direction the strip plate is cut into (for the waves) */
const STRIP_ROWS = 64;

export interface Stack3DOpts {
  /** deflection magnification */
  magnify: number;
  /** strip width [m] */
  width: number;
  /** draw the lower half as the mirror of the upper */
  mirror: boolean;
  /** label text per roll index */
  labels: string[];
}

class Builder {
  v: number[] = [];
  i: number[] = [];
  n = 0;
  vertex(p: number[], n: number[], c: Col): number {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], c[3]);
    return this.n++;
  }
  pos(id: number): number[] { return [this.v[id * STRIDE], this.v[id * STRIDE + 1], this.v[id * STRIDE + 2]]; }
  tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.i.push(a, b, c, a, c, d); }
}

function box(b: Builder, lo: number[], hi: number[], col: Col): void {
  const f = (n: number[], pts: number[][]) => {
    const ids = pts.map((p) => b.vertex(p, n, col));
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  };
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  f([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  f([0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]);
  f([1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]);
  f([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  f([0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
  f([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}

export class StackView3D {
  private gl: WebGL2RenderingContext;
  private progBg: WebGLProgram;
  private progMesh: WebGLProgram;
  private progLine: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private lineVao: WebGLVertexArrayObject;
  private lineVbo: WebGLBuffer;
  private count = 0;
  private lineCount = 0;
  private uMesh: Record<string, WebGLUniformLocation | null> = {};
  private uLine: Record<string, WebGLUniformLocation | null> = {};
  /** orbit */
  yaw = 0.42;
  pitch = 0.3;
  dist = 1;
  private target = [0, 0, 0];
  private extent = 1;
  private labelPts: { x: number; y: number; z: number; text: string }[] = [];
  private drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
  private labelNodes: HTMLElement[] = [];

  constructor(private canvas: HTMLCanvasElement, private labelBox: HTMLElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 がありません');
    this.gl = gl;
    const link = (vs: string, fs: string, name: string) => {
      const mk = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(sh)}`);
        return sh;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
      return p;
    };
    this.progBg = link(BG_VS, BG_FS, 'stack3d bg');
    this.progMesh = link(MESH_VS, MESH_FS, 'stack3d mesh');
    this.progLine = link(LINE_VS, LINE_FS, 'stack3d line');
    for (const n of ['uProj', 'uView', 'uEye', 'uKey', 'uFill']) this.uMesh[n] = gl.getUniformLocation(this.progMesh, n);
    for (const n of ['uProj', 'uView', 'uCol']) this.uLine[n] = gl.getUniformLocation(this.progLine, n);

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const B = 4 * STRIDE;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, B, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, B, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);

    this.lineVao = gl.createVertexArray()!;
    this.lineVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      // dragging right turns the stack to the right (the eye goes left)
      this.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.008;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.drag.pitch + (e.clientY - this.drag.y) * 0.008));
      this.render();
    });
    const end = () => { this.drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(0.35, Math.min(6, this.dist * Math.exp(e.deltaY * 0.0015)));
      this.render();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { this.yaw = 0.42; this.pitch = 0.3; this.dist = 1; this.render(); });
  }

  /** rebuild the geometry from a solution and draw it */
  draw(R: Result3D, stack: Stack, o: Stack3DOpts): void {
    const b = new Builder();
    const rolls = R.rolls;
    const mag = o.magnify;
    const dx = R.x[1] - R.x[0];

    const loadOn = (ri: number): Float64Array => {
      const acc = new Float64Array(R.x.length);
      for (const c of R.contacts) {
        if (c.a !== ri && c.b !== ri) continue;
        for (let s = 0; s < acc.length; s++) acc[s] += c.q[s];
      }
      if (ri === stack.wr) for (let s = 0; s < acc.length; s++) acc[s] += Number.isFinite(R.q[s]) ? R.q[s] : 0;
      return acc;
    };
    const loads = rolls.map((_, i) => loadOn(i));
    let qmax = 1e-9;
    for (const l of loads) for (let s = 0; s < l.length; s++) qmax = Math.max(qmax, l[s]);

    let top = 0, zext = 0, xext = 0;
    for (const r of rolls) {
      top = Math.max(top, r.def.cy + r.def.D / 2);
      zext = Math.max(zext, Math.abs(r.def.cz) + r.def.D / 2);
      xext = Math.max(xext, r.def.Ls / 2 + Math.abs(r.def.shift));
    }

    // bending only: the rigid part of each roll's displacement is its mean
    // over the barrel, taken out before magnifying
    const rel = (r: Result3D['rolls'][number]) => {
      const d = r.def;
      let sv = 0, sw = 0, n = 0;
      for (let s = r.ia; s <= r.ib; s++) {
        if (!onBarrel(d, R.x[s]) || !Number.isFinite(r.v[s])) continue;
        sv += r.v[s]; sw += r.w[s]; n++;
      }
      const mv = n ? sv / n : 0, mw = n ? sw / n : 0;
      return {
        v: (s: number) => (Number.isFinite(r.v[s]) ? r.v[s] - mv : 0),
        w: (s: number) => (Number.isFinite(r.w[s]) ? r.w[s] - mw : 0),
      };
    };

    const addRoll = (ri: number, sign: 1 | -1) => {
      const r = rolls[ri];
      const d = r.def;
      const { v: vAt, w: wAt } = rel(r);
      const x0 = d.shift - d.Lb / 2, x1 = d.shift + d.Lb / 2;
      const profMag = Math.min(mag, 40);
      type Ring = { x: number; rad: number; s: number; col: Col; nx: number };
      const rings: Ring[] = [];
      const barrelRad = (s: number) => d.D / 2 + r.prof[s] * profMag;
      const chamfer = Math.min(0.012, d.D * 0.03);
      for (let s = r.ia; s <= r.ib; s++) {
        const x = R.x[s];
        const share = loads[ri][s] / qmax;
        if (s > r.ia && x0 > R.x[s - 1] && x0 <= x) {
          rings.push({ x: x0, rad: d.Dn / 2, s, col: NECK, nx: 0 });
          rings.push({ x: x0, rad: barrelRad(s) - chamfer, s, col: STEEL, nx: -1 });
          rings.push({ x: x0 + chamfer, rad: barrelRad(s), s, col: heat(share), nx: 0 });
        }
        if (s > r.ia && x1 >= R.x[s - 1] && x1 < x) {
          rings.push({ x: x1 - chamfer, rad: barrelRad(s), s, col: heat(share), nx: 0 });
          rings.push({ x: x1, rad: barrelRad(s) - chamfer, s, col: STEEL, nx: 1 });
          rings.push({ x: x1, rad: d.Dn / 2, s, col: NECK, nx: 0 });
        }
        const onB = onBarrel(d, x);
        rings.push({ x, rad: onB ? barrelRad(s) : d.Dn / 2, s, col: onB ? heat(share) : NECK, nx: 0 });
      }
      const centre = (rg: Ring) => {
        const t = (rg.x - R.x[rg.s]) / dx;
        const s2 = Math.max(r.ia, Math.min(r.ib, rg.s + (t < 0 ? -1 : 1)));
        const v = vAt(rg.s) + Math.abs(t) * (vAt(s2) - vAt(rg.s));
        const w = wAt(rg.s) + Math.abs(t) * (wAt(s2) - wAt(rg.s));
        return [rg.x, sign * (d.cy + v * mag), d.cz + w * mag];
      };
      let prev: number[] | null = null;
      let first: number[] = [];
      for (const rg of rings) {
        const c = centre(rg);
        const ids: number[] = [];
        for (let k = 0; k < SEG; k++) {
          const th = (2 * Math.PI * k) / SEG;
          const ny = Math.cos(th), nz = Math.sin(th);
          // a chamfer ring leans its normal along the axis
          const nl = Math.hypot(1, rg.nx * 0.8);
          ids.push(b.vertex([c[0], c[1] + rg.rad * ny, c[2] + rg.rad * nz], [rg.nx * 0.8 / nl, ny / nl, nz / nl], rg.col));
        }
        if (prev) for (let k = 0; k < SEG; k++) { const k2 = (k + 1) % SEG; b.quad(prev[k], ids[k], ids[k2], prev[k2]); }
        if (!prev) first = ids;
        prev = ids;
      }
      const cap = (ids: number[], c: number[], nx: number) => {
        const cid = b.vertex(c, [nx, 0, 0], NECK);
        const ring = ids.map((id) => b.vertex(b.pos(id), [nx, 0, 0], NECK));
        for (let k = 0; k < SEG; k++) { const k2 = (k + 1) % SEG; if (nx < 0) b.tri(cid, ring[k2], ring[k]); else b.tri(cid, ring[k], ring[k2]); }
      };
      cap(first, centre(rings[0]), -1);
      cap(prev!, centre(rings[rings.length - 1]), 1);
      // supports: a bearing chock around the neck (screw / chock rolls), or
      // a small saddle bracket on the far side of a backing shaft
      for (const s of r.supports) {
        const c = [R.x[s], sign * (d.cy + vAt(s) * mag), d.cz + wAt(s) * mag];
        const mark: Col = d.support === 'saddle' ? [1, 0.77, 0.42, 0] : d.support === 'screw' ? [1, 0.42, 0.5, 0] : [0.43, 0.9, 0.65, 0];
        if (d.support === 'saddle') {
          // outward from the work roll through this shaft's centre
          const oy = sign * d.cy, oz = d.cz;
          const on = Math.hypot(oy, oz) || 1;
          const uy = oy / on, uz = oz / on;
          const r0 = d.D / 2 * 0.98, r1 = d.D / 2 * 1.12, hw = Math.max(0.01, dx * 0.5), t = d.D * 0.16;
          const p0 = [c[0], c[1] + uy * r0, c[2] + uz * r0], p1 = [c[0], c[1] + uy * r1, c[2] + uz * r1];
          // an axis-aligned block spanning the two points, thin across
          box(b, [p0[0] - hw, Math.min(p0[1], p1[1]) - t * Math.abs(uz), Math.min(p0[2], p1[2]) - t * Math.abs(uy)],
            [p1[0] + hw, Math.max(p0[1], p1[1]) + t * Math.abs(uz), Math.max(p0[2], p1[2]) + t * Math.abs(uy)], CHOCK);
          box(b, [p1[0] - hw, p1[1] - t * 0.5, p1[2] - t * 0.5], [p1[0] + hw, p1[1] + t * 0.5, p1[2] + t * 0.5], mark);
        } else {
          const h = d.Dn / 2 * 1.2, hw = Math.max(0.012, dx * 0.9);
          box(b, [c[0] - hw, c[1] - h, c[2] - h * 0.9], [c[0] + hw, c[1] + h, c[2] + h * 0.9], CHOCK);
          const capY = sign > 0 ? [c[1] + h, c[1] + h * 1.2] : [c[1] - h * 1.2, c[1] - h];
          box(b, [c[0] - hw, capY[0], c[2] - h * 0.5], [c[0] + hw, capY[1], c[2] + h * 0.5], mark);
        }
      }
    };
    for (let ri = 0; ri < rolls.length; ri++) {
      addRoll(ri, 1);
      if (o.mirror) addRoll(ri, -1);
    }

    // the strip: a plate through the pass line, thickness profile magnified,
    // the manifest shape defect drawn as a wave on the exit side
    {
      const wr = rolls[stack.wr];
      const base = 0.025 * wr.def.D;
      let hm = 0, n = 0;
      for (let s = 0; s < R.x.length; s++) if (Number.isFinite(R.h1[s])) { hm += R.h1[s]; n++; }
      hm = n ? hm / n : 0;
      const xs: number[] = [];
      for (let s = 0; s < R.x.length; s++) if (Number.isFinite(R.h1[s])) xs.push(s);
      const zl = Math.max(zext, top) * (o.mirror ? 1.7 : 1.15);
      if (xs.length > 1) {
        // a wave of wavelength λ and amplitude A carries an elongation (πA/λ)²
        const lambda = 0.55 * zl;
        const amp = (s: number) => {
          const m = Number.isFinite(R.manifest[s]) ? R.manifest[s] : 0;
          return (lambda * Math.sqrt(Math.max(m, 0))) / Math.PI;
        };
        const half = (s: number) => base + 0.5 * ((Number.isFinite(R.h1[s]) ? R.h1[s] : hm) - hm) * mag;
        const colAt = (s: number): Col => {
          const m = Number.isFinite(R.manifest[s]) ? R.manifest[s] : 0;
          const t = Math.min(1, m / 4e-3);
          return [0.93, 0.78 - 0.3 * t, 0.36 - 0.2 * t, 0.35];
        };
        // grid of the mid-surface: rows along z, columns at the slices
        const mid = (s: number, z: number) => {
          const ramp = z <= 0 ? 0 : Math.min(1, z / (0.12 * zl));
          return amp(s) * ramp * Math.sin((2 * Math.PI * z) / lambda);
        };
        const topIds: number[][] = [], botIds: number[][] = [];
        for (let j = 0; j <= STRIP_ROWS; j++) {
          const z = -zl + (2 * zl * j) / STRIP_ROWS;
          const rowT: number[] = [], rowB: number[] = [];
          for (let k = 0; k < xs.length; k++) {
            const s = xs[k];
            const x = Math.max(-o.width / 2, Math.min(o.width / 2, R.x[s]));
            const y = mid(s, z), h = half(s);
            // normal from the wave slope along z
            const dz = 1e-4 * zl;
            const slope = (mid(s, z + dz) - mid(s, z - dz)) / (2 * dz);
            const nl = Math.hypot(slope, 1);
            const c = colAt(s);
            rowT.push(b.vertex([x, y + h, z], [0, 1 / nl, -slope / nl], c));
            rowB.push(b.vertex([x, y - h, z], [0, -1 / nl, slope / nl], c));
          }
          topIds.push(rowT); botIds.push(rowB);
        }
        for (let j = 1; j <= STRIP_ROWS; j++) {
          for (let k = 1; k < xs.length; k++) {
            b.quad(topIds[j - 1][k - 1], topIds[j - 1][k], topIds[j][k], topIds[j][k - 1]);
            b.quad(botIds[j][k - 1], botIds[j][k], botIds[j - 1][k], botIds[j - 1][k - 1]);
          }
        }
        // side faces along the edges and the two ends
        const edgeCol: Col = [0.8, 0.66, 0.3, 0.35];
        const side = (kA: number, nx: number) => {
          for (let j = 1; j <= STRIP_ROWS; j++) {
            const q = [topIds[j - 1][kA], topIds[j][kA], botIds[j][kA], botIds[j - 1][kA]].map((id) => b.vertex(b.pos(id), [nx, 0, 0], edgeCol));
            if (nx < 0) b.quad(q[0], q[1], q[2], q[3]); else b.quad(q[3], q[2], q[1], q[0]);
          }
        };
        side(0, -1); side(xs.length - 1, 1);
        const end = (j: number, nz: number) => {
          for (let k = 1; k < xs.length; k++) {
            const q = [topIds[j][k - 1], topIds[j][k], botIds[j][k], botIds[j][k - 1]].map((id) => b.vertex(b.pos(id), [0, 0, nz], edgeCol));
            if (nz > 0) b.quad(q[0], q[1], q[2], q[3]); else b.quad(q[3], q[2], q[1], q[0]);
          }
        };
        end(STRIP_ROWS, 1); end(0, -1);
      }
    }

    // a floor grid under the mill, for depth
    const lines: number[] = [];
    {
      const yf = -(o.mirror ? top : 0.12 * top) - 0.05;
      const ext = Math.max(xext, zext, top) * 1.6;
      const step = ext / 8;
      for (let i = -8; i <= 8; i++) {
        lines.push(-ext, yf, i * step, ext, yf, i * step);
        lines.push(i * step, yf, -ext, i * step, yf, ext);
      }
    }

    // labels at the barrel ends, alternating sides so rolls at one height
    // do not put theirs on top of each other
    this.labelPts = rolls.map((r, ri) => {
      const d = r.def;
      const side = ri % 2 === 0 ? 1 : -1;
      const x = d.shift + side * (d.Lb / 2 - 0.08 * d.Lb);
      const s = Math.max(r.ia, Math.min(r.ib, Math.round((x - R.x[0]) / dx)));
      const { v, w } = rel(r);
      return { x, y: d.cy + v(s) * mag + d.D / 2 * 0.3, z: d.cz + w(s) * mag + d.D / 2, text: o.labels[ri] ?? d.id };
    });

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.v), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(b.i), gl.DYNAMIC_DRAW);
    this.count = b.i.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW);
    this.lineCount = lines.length / 3;
    this.target = [0, o.mirror ? 0 : top * 0.4, 0];
    this.extent = Math.max(xext * 1.1, top * (o.mirror ? 2 : 2.2), zext * 1.8);
    this.render();
  }

  render(): void {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.progBg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    if (!this.count) return;
    const aspect = w / h;
    const dist = this.extent * 2.3 * this.dist;
    const t = this.target;
    const eye = [t[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw), t[1] + dist * Math.sin(this.pitch), t[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw)];
    const view = lookAt(eye, t, [0, 1, 0]);
    const proj = perspective(0.55, aspect, dist * 0.05, dist * 12);

    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(this.uLine.uProj, false, proj);
    gl.uniformMatrix4fv(this.uLine.uView, false, view);
    gl.uniform4f(this.uLine.uCol, 0.35, 0.42, 0.55, 0.28);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.LINES, 0, this.lineCount);
    gl.disable(gl.BLEND);

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(this.progMesh);
    gl.uniformMatrix4fv(this.uMesh.uProj, false, proj);
    gl.uniformMatrix4fv(this.uMesh.uView, false, view);
    gl.uniform3f(this.uMesh.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(this.uMesh.uKey, 0.45, 0.85, 0.6);
    gl.uniform3f(this.uMesh.uFill, -0.7, 0.25, -0.5);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    const mvp = mul(proj, view);
    const cw = c.clientWidth, ch = c.clientHeight;
    while (this.labelNodes.length < this.labelPts.length) {
      const n = document.createElement('div');
      n.className = 'v3-label';
      this.labelBox.append(n);
      this.labelNodes.push(n);
    }
    // project, then push labels apart vertically within each side so a
    // cluster's ten rolls do not write over one another
    const placed = this.labelPts.map((p, i) => {
      const cx = mvp[0] * p.x + mvp[4] * p.y + mvp[8] * p.z + mvp[12];
      const cy = mvp[1] * p.x + mvp[5] * p.y + mvp[9] * p.z + mvp[13];
      const cwc = mvp[3] * p.x + mvp[7] * p.y + mvp[11] * p.z + mvp[15];
      return { i, ok: cwc > 0, x: ((cx / cwc) * 0.5 + 0.5) * cw, y: (0.5 - (cy / cwc) * 0.5) * ch, side: i % 2 };
    });
    const GAP = 30;
    for (const side of [0, 1]) {
      const col = placed.filter((p) => p.ok && p.side === side).sort((a, b) => a.y - b.y);
      for (let k = 1; k < col.length; k++) if (col[k].y < col[k - 1].y + GAP) col[k].y = col[k - 1].y + GAP;
      // and back up from the bottom of the picture
      for (let k = col.length - 1; k >= 0; k--) {
        const lim = k === col.length - 1 ? ch - 6 : col[k + 1].y - GAP;
        if (col[k].y > lim) col[k].y = lim;
      }
    }
    this.labelNodes.forEach((n, i) => {
      const p = this.labelPts[i], q = placed[i];
      if (!p || !q.ok) { n.hidden = true; return; }
      n.hidden = false;
      n.style.left = `${q.x}px`;
      n.style.top = `${q.y}px`;
      if (n.textContent !== p.text) n.textContent = p.text;
    });
  }
}


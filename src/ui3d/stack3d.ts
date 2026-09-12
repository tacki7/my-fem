/**
 * The roll stack in three dimensions: shaded cylinders along the width,
 * bent and shifted by the solved deflections (magnified), coloured by the
 * contact load under the barrel, the strip as a plate between the work
 * rolls with its thickness profile magnified, the lower half mirrored from
 * the upper so the whole mill is seen. Orbit with the mouse, zoom with the
 * wheel, double-click to reset.
 *
 * WebGL2 with nothing else, like the 2D tab's renderer: one program, one
 * interleaved buffer rebuilt when the solution moves, Blinn-Phong with a
 * key light, a fill light and a rim. Labels are DOM nodes placed by
 * projecting a point on each roll, so they stay crisp and selectable.
 */

import type { Result3D } from '../sim3d/solver';
import type { Stack } from '../sim3d/stack';
import { onBarrel } from '../sim3d/stack';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
uniform mat4 uProj, uView;
out vec3 vPos; out vec3 vNrm; out vec3 vCol;
void main() {
  vPos = aPos; vNrm = aNrm; vCol = aCol;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNrm; in vec3 vCol;
uniform vec3 uEye;
uniform vec3 uKey, uFill;
out vec4 o;
void main() {
  vec3 n = normalize(vNrm);
  vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 k = normalize(uKey), f = normalize(uFill);
  float dk = max(dot(n, k), 0.0), df = max(dot(n, f), 0.0);
  vec3 hk = normalize(k + v);
  float spec = pow(max(dot(n, hk), 0.0), 48.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 c = vCol * (0.22 + 0.62 * dk + 0.22 * df) + vec3(0.35) * spec + vec3(0.12, 0.16, 0.22) * rim;
  o = vec4(c, 1.0);
}`;

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

/** load share t in [0, 1] as a colour on steel */
function heat(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  const steel: [number, number, number] = [0.58, 0.62, 0.68];
  const hot: [number, number, number] = [1.0, 0.45, 0.12];
  const warm: [number, number, number] = [0.95, 0.85, 0.3];
  if (c <= 0.001) return steel;
  const mix = (a: number[], b: number[], u: number) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u] as [number, number, number];
  return c < 0.5 ? mix(steel, warm, c * 2) : mix(warm, hot, (c - 0.5) * 2);
}

const SEG = 36;
const STRIDE = 9;

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
  vertex(p: number[], n: number[], c: number[]): number {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2]);
    return this.n++;
  }
  tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.i.push(a, b, c, a, c, d); }
}

export class StackView3D {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private count = 0;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  /** orbit */
  yaw = 0.38;
  pitch = 0.26;
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
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`stack3d: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`stack3d link: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    for (const n of ['uProj', 'uView', 'uEye', 'uKey', 'uFill']) this.uni[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const B = 4 * STRIDE;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, B, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, B, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.008;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.drag.pitch + (e.clientY - this.drag.y) * 0.008));
      this.render();
    });
    const end = () => { this.drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist *= Math.exp(e.deltaY * 0.0015);
      this.dist = Math.max(0.4, Math.min(6, this.dist));
      this.render();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { this.yaw = 0.38; this.pitch = 0.26; this.dist = 1; this.render(); });
  }

  /** rebuild the geometry from a solution and draw it */
  draw(R: Result3D, stack: Stack, o: Stack3DOpts): void {
    const b = new Builder();
    const rolls = R.rolls;
    const mag = o.magnify;
    const dx = R.x[1] - R.x[0];

    // the load under each roll, for the colour
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

    const addRoll = (ri: number, sign: 1 | -1) => {
      const r = rolls[ri];
      const d = r.def;
      const x0 = d.shift - d.Lb / 2, x1 = d.shift + d.Lb / 2;
      const vAt = (s: number) => (Number.isFinite(r.v[s]) ? r.v[s] : 0);
      const wAt = (s: number) => (Number.isFinite(r.w[s]) ? r.w[s] : 0);
      // rings: one per station, plus a pair at each barrel end for the step
      type Ring = { x: number; rad: number; s: number; load: number };
      const rings: Ring[] = [];
      const radAt = (x: number, s: number) => (onBarrel(d, x) ? d.D / 2 + r.prof[s] * Math.min(mag, 50) : d.Dn / 2);
      for (let s = r.ia; s <= r.ib; s++) {
        const x = R.x[s];
        const share = loads[ri][s] / qmax;
        if (x0 > R.x[s - 1] && x0 <= x && s > r.ia) {
          rings.push({ x: x0, rad: d.Dn / 2, s, load: 0 });
          rings.push({ x: x0, rad: d.D / 2 + r.prof[s] * Math.min(mag, 50), s, load: share });
        }
        if (x1 >= R.x[s - 1] && x1 < x && s > r.ia) {
          rings.push({ x: x1, rad: d.D / 2 + r.prof[s] * Math.min(mag, 50), s, load: share });
          rings.push({ x: x1, rad: d.Dn / 2, s, load: 0 });
        }
        rings.push({ x, rad: radAt(x, s), s, load: onBarrel(d, x) ? share : 0 });
      }
      const centre = (rg: Ring) => {
        const t = (rg.x - R.x[rg.s]) / dx;
        const s2 = Math.max(r.ia, Math.min(r.ib, rg.s + (t < 0 ? -1 : 1)));
        const v = vAt(rg.s) + Math.abs(t) * (vAt(s2) - vAt(rg.s));
        const w = wAt(rg.s) + Math.abs(t) * (wAt(s2) - wAt(rg.s));
        return [rg.x, sign * (d.cy + v * mag), d.cz + w * mag];
      };
      const first: number[] = [];
      let prev: number[] | null = null;
      for (const rg of rings) {
        const c = centre(rg);
        const col = heat(rg.load);
        const ids: number[] = [];
        for (let k = 0; k < SEG; k++) {
          const th = (2 * Math.PI * k) / SEG;
          const ny = Math.cos(th), nz = Math.sin(th);
          ids.push(b.vertex([c[0], c[1] + rg.rad * ny, c[2] + rg.rad * nz], [0, ny, nz], col));
        }
        if (prev) for (let k = 0; k < SEG; k++) {
          const k2 = (k + 1) % SEG;
          // x increases along the roll: wind so the outside faces out
          b.quad(prev[k], ids[k], ids[k2], prev[k2]);
        }
        if (!prev) first.push(...ids);
        prev = ids;
      }
      // end caps
      const cap = (ids: number[], c: number[], nx: number) => {
        const centreId = b.vertex(c, [nx, 0, 0], [0.5, 0.54, 0.6]);
        const ring = ids.map((id) => b.vertex([b.v[id * STRIDE], b.v[id * STRIDE + 1], b.v[id * STRIDE + 2]], [nx, 0, 0], [0.5, 0.54, 0.6]));
        for (let k = 0; k < SEG; k++) {
          const k2 = (k + 1) % SEG;
          if (nx < 0) b.tri(centreId, ring[k2], ring[k]); else b.tri(centreId, ring[k], ring[k2]);
        }
      };
      cap(first, centre(rings[0]), -1);
      cap(prev!, centre(rings[rings.length - 1]), 1);
      // supports as small blocks
      for (const s of r.supports) {
        const c = [R.x[s], sign * (d.cy + vAt(s) * mag), d.cz + wAt(s) * mag];
        const h = d.Dn / 2 * 0.45, hw = Math.max(0.01, dx * 0.45);
        const col: [number, number, number] = d.support === 'saddle' ? [1, 0.77, 0.42] : d.support === 'screw' ? [1, 0.42, 0.5] : [0.43, 0.9, 0.65];
        box(b, [c[0] - hw, c[1] - h, c[2] - h], [c[0] + hw, c[1] + h, c[2] + h], col);
      }
    };
    for (let ri = 0; ri < rolls.length; ri++) {
      addRoll(ri, 1);
      if (o.mirror) addRoll(ri, -1);
    }

    // the strip: a plate through the pass line, thickness profile magnified
    {
      const wr = rolls[stack.wr];
      const base = 0.03 * wr.def.D;
      let hm = 0, n = 0;
      for (let s = 0; s < R.x.length; s++) if (Number.isFinite(R.h1[s])) { hm += R.h1[s]; n++; }
      hm = n ? hm / n : 0;
      const half = (s: number) => base + 0.5 * ((Number.isFinite(R.h1[s]) ? R.h1[s] : hm) - hm) * mag;
      const zl = Math.max(zext, top) * 1.6;
      const xs: number[] = [];
      for (let s = 0; s < R.x.length; s++) if (Number.isFinite(R.h1[s])) xs.push(s);
      if (xs.length > 1) {
        const stripCol = (s: number): [number, number, number] => {
          const man = Number.isFinite(R.manifest[s]) ? R.manifest[s] : 0;
          const t = Math.min(1, man / 5e-4);
          return [0.98, 0.82 - 0.4 * t, 0.4 - 0.25 * t];
        };
        const rows: { top: number[]; bot: number[] }[] = [];
        for (const s of xs) {
          const x = Math.max(-o.width / 2, Math.min(o.width / 2, R.x[s]));
          const h = half(s), c = stripCol(s);
          const t = [b.vertex([x, h, -zl], [0, 1, 0], c), b.vertex([x, h, zl], [0, 1, 0], c)];
          const bt = [b.vertex([x, -h, -zl], [0, -1, 0], c), b.vertex([x, -h, zl], [0, -1, 0], c)];
          rows.push({ top: t, bot: bt });
        }
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1], c = rows[i];
          b.quad(a.top[0], c.top[0], c.top[1], a.top[1]);
          b.quad(a.bot[1], c.bot[1], c.bot[0], a.bot[0]);
        }
        // edges and ends
        const edge = (i0: number, i1: number, nx: number) => {
          const a = rows[i0], c = rows[i1];
          const col: [number, number, number] = [0.85, 0.7, 0.3];
          const p = (id: number) => [b.v[id * STRIDE], b.v[id * STRIDE + 1], b.v[id * STRIDE + 2]];
          const q = [b.vertex(p(a.top[0]), [nx, 0, 0], col), b.vertex(p(a.top[1]), [nx, 0, 0], col), b.vertex(p(a.bot[1]), [nx, 0, 0], col), b.vertex(p(a.bot[0]), [nx, 0, 0], col)];
          void c;
          if (nx < 0) b.quad(q[0], q[1], q[2], q[3]); else b.quad(q[3], q[2], q[1], q[0]);
        };
        edge(0, 0, -1); edge(rows.length - 1, rows.length - 1, 1);
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1], c = rows[i];
          const col: [number, number, number] = [0.85, 0.7, 0.3];
          const p = (id: number) => [b.v[id * STRIDE], b.v[id * STRIDE + 1], b.v[id * STRIDE + 2]];
          const f = [b.vertex(p(a.top[1]), [0, 0, 1], col), b.vertex(p(c.top[1]), [0, 0, 1], col), b.vertex(p(c.bot[1]), [0, 0, 1], col), b.vertex(p(a.bot[1]), [0, 0, 1], col)];
          b.quad(f[0], f[1], f[2], f[3]);
          const g = [b.vertex(p(a.top[0]), [0, 0, -1], col), b.vertex(p(c.top[0]), [0, 0, -1], col), b.vertex(p(c.bot[0]), [0, 0, -1], col), b.vertex(p(a.bot[0]), [0, 0, -1], col)];
          b.quad(g[3], g[2], g[1], g[0]);
        }
      }
    }

    // labels: one per roll, over the barrel at its centre
    // labels: one per roll on its barrel, spread along the width so they do
    // not stack up in the middle of the picture
    const nl = rolls.length;
    this.labelPts = rolls.map((r, ri) => {
      const d = r.def;
      const frac = nl > 1 ? -0.38 + (0.76 * ri) / (nl - 1) : 0;
      const x = d.shift + frac * d.Lb;
      const s = Math.max(r.ia, Math.min(r.ib, Math.round((x - R.x[0]) / dx)));
      const v = Number.isFinite(r.v[s]) ? r.v[s] : 0, w = Number.isFinite(r.w[s]) ? r.w[s] : 0;
      return { x, y: d.cy + v * mag + d.D / 2 * 0.2, z: d.cz + w * mag + d.D / 2, text: o.labels[ri] ?? d.id };
    });

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.v), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(b.i), gl.DYNAMIC_DRAW);
    this.count = b.i.length;
    this.target = [0, o.mirror ? 0 : top / 2, 0];
    this.extent = Math.max(xext, top * (o.mirror ? 2 : 1.2), zext * 1.5);
    this.render();
  }

  render(): void {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.027, 0.039, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.count) return;
    const aspect = w / h;
    const dist = this.extent * 2.1 * this.dist;
    const t = this.target;
    const eye = [t[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw), t[1] + dist * Math.sin(this.pitch), t[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw)];
    const view = lookAt(eye, t, [0, 1, 0]);
    const proj = perspective(0.6, aspect, dist * 0.05, dist * 10);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uni.uProj, false, proj);
    gl.uniformMatrix4fv(this.uni.uView, false, view);
    gl.uniform3f(this.uni.uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(this.uni.uKey, 0.5, 0.9, 0.7);
    gl.uniform3f(this.uni.uFill, -0.7, 0.3, -0.4);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    // labels
    const mvp = mul(proj, view);
    const cw = c.clientWidth, ch = c.clientHeight;
    while (this.labelNodes.length < this.labelPts.length) {
      const n = document.createElement('div');
      n.className = 'v3-label';
      this.labelBox.append(n);
      this.labelNodes.push(n);
    }
    this.labelNodes.forEach((n, i) => {
      const p = this.labelPts[i];
      if (!p) { n.hidden = true; return; }
      const cx = mvp[0] * p.x + mvp[4] * p.y + mvp[8] * p.z + mvp[12];
      const cy = mvp[1] * p.x + mvp[5] * p.y + mvp[9] * p.z + mvp[13];
      const cwc = mvp[3] * p.x + mvp[7] * p.y + mvp[11] * p.z + mvp[15];
      if (cwc <= 0) { n.hidden = true; return; }
      n.hidden = false;
      n.style.left = `${((cx / cwc) * 0.5 + 0.5) * cw}px`;
      n.style.top = `${(0.5 - (cy / cwc) * 0.5) * ch}px`;
      if (n.textContent !== p.text) n.textContent = p.text;
    });
  }
}

function box(b: Builder, lo: number[], hi: number[], col: [number, number, number]): void {
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

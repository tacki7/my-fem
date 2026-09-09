/**
 * WebGL2 renderer for the rolling stand.
 *
 * Only the upper half of the stand is simulated, so everything is drawn twice:
 * once as modelled and once mirrored about the strip centre line. What the user
 * sees is the whole two-high stand.
 *
 * Roll displacements are elastic and micrometre sized, so they are drawn with a
 * user controlled magnification - the same convention every FE post-processor
 * uses. The strip's deformation is real and is never magnified.
 */

import type { RollingSim } from '../sim/solver';
import { rampTexels } from './colormap';
import {
  BG_VS, BG_FS, MESH_VS, MESH_FS, LINE_VS, LINE_FS,
  RIBBON_VS, RIBBON_FS, CORE_VS, CORE_FS,
} from './shaders';

export interface Camera { cx: number; cy: number; zoom: number }

export interface RenderOptions {
  range: { min: number; max: number };
  showWire: boolean;
  showMarks: boolean;
  showGrid: boolean;
  showPressure: boolean;
  showMirror: boolean;
  showContact: boolean;
  /** magnification applied to the roll's elastic displacement */
  rollMagnify: number;
  /** depth of the roll surface shading, 0 = off */
  markAmount: number;
  /** cycles of surface shading per revolution */
  markCount: number;
  /** false when the active field is a strip-only quantity */
  rollUseField: boolean;
  /** false when the active field is a roll-only quantity */
  stripUseField: boolean;
  /** draw the neutral plane through the strip */
  showNeutral: boolean;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, name: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'VS' : 'FS'}: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

type Uni = Record<string, WebGLUniformLocation | null>;
function unis(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uni {
  const o: Uni = {};
  for (const n of names) o[n] = gl.getUniformLocation(p, n);
  return o;
}

/** GPU buffers for one FE body. */
class Body {
  vaoTri!: WebGLVertexArrayObject;
  vaoWire!: WebGLVertexArrayObject;
  bufPos!: WebGLBuffer;
  bufVal!: WebGLBuffer;
  bufRef!: WebGLBuffer;
  bufTri!: WebGLBuffer;
  bufEdge!: WebGLBuffer;
  nn = 0;
  triCount = 0;
  edgeCount = 0;
  pos = new Float32Array(0);
  val = new Float32Array(0);

  constructor(private gl: WebGL2RenderingContext) {
    this.bufPos = gl.createBuffer()!;
    this.bufVal = gl.createBuffer()!;
    this.bufRef = gl.createBuffer()!;
    this.bufTri = gl.createBuffer()!;
    this.bufEdge = gl.createBuffer()!;
    this.vaoTri = gl.createVertexArray()!;
    this.vaoWire = gl.createVertexArray()!;
  }

  upload(nn: number, ref: Float32Array, tris: Uint32Array, edges: Uint32Array): void {
    const gl = this.gl;
    this.nn = nn;
    this.triCount = tris.length;
    this.edgeCount = edges.length;
    this.pos = new Float32Array(2 * nn);
    this.val = new Float32Array(nn);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, 8 * nn, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufVal);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * nn, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRef);
    gl.bufferData(gl.ARRAY_BUFFER, ref, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufTri);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tris, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufEdge);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);

    for (const [vao, idx] of [[this.vaoTri, this.bufTri], [this.vaoWire, this.bufEdge]] as
      [WebGLVertexArrayObject, WebGLBuffer][]) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufVal);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRef);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    }
    gl.bindVertexArray(null);
  }

  sync(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufVal);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.val);
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;

  private progBg: WebGLProgram; private uBg: Uni;
  private progMesh: WebGLProgram; private uMesh: Uni;
  private progLine: WebGLProgram; private uLine: Uni;
  private progRib: WebGLProgram; private uRib: Uni;
  private progCore: WebGLProgram; private uCore: Uni;

  private roll!: Body;
  private strip!: Body;

  private vaoRib!: WebGLVertexArrayObject;
  private bufRibPos!: WebGLBuffer;
  private bufRibSide!: WebGLBuffer;
  private vaoCore!: WebGLVertexArrayObject;
  private coreVerts = 0;
  private vaoEmpty!: WebGLVertexArrayObject;

  private lut: WebGLTexture;
  private lutName = '';
  private ribPos = new Float32Array(1024);
  private ribSide = new Float32Array(512);
  private rim = new Float32Array(0);
  private topLine = new Float32Array(0);
  private patch = new Float32Array(0);
  private prof = new Float32Array(0);

  lastDrawMs = 0;
  drawCalls = 0;
  /** world pitch of the fine background grid, chosen from the zoom [m] */
  gridPitch = 0.002;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.progBg = compile(gl, BG_VS, BG_FS, 'bg');
    this.uBg = unis(gl, this.progBg, ['uCenter', 'uScale', 'uGrid', 'uPxPerM', 'uTop', 'uBottom', 'uGridAlpha']);
    this.progMesh = compile(gl, MESH_VS, MESH_FS, 'mesh');
    this.uMesh = unis(gl, this.progMesh, ['uCenter', 'uScale', 'uFlipY', 'uRange', 'uRadii',
      'uLut', 'uMarks', 'uMarkAmount', 'uShade', 'uPhase', 'uNeutral', 'uUseField']);
    this.progLine = compile(gl, LINE_VS, LINE_FS, 'line');
    this.uLine = unis(gl, this.progLine, ['uCenter', 'uScale', 'uFlipY', 'uColor']);
    this.progRib = compile(gl, RIBBON_VS, RIBBON_FS, 'ribbon');
    this.uRib = unis(gl, this.progRib, ['uCenter', 'uScale', 'uFlipY', 'uColor', 'uSoft']);
    this.progCore = compile(gl, CORE_VS, CORE_FS, 'core');
    this.uCore = unis(gl, this.progCore, ['uCenter', 'uScale', 'uFlipY', 'uOrigin', 'uRadius', 'uAngle', 'uTint']);

    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setColormap('inferno');

    this.vaoEmpty = gl.createVertexArray()!;
    this.roll = new Body(gl);
    this.strip = new Body(gl);
    this.initRibbon();
    this.initCore();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setColormap(name: string): void {
    if (name === this.lutName) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampTexels(name));
    this.lutName = name;
  }

  setMesh(sim: RollingSim): void {
    const rm = sim.roll;
    const rref = new Float32Array(2 * rm.nn);
    for (let i = 0; i < rm.nn; i++) {
      rref[2 * i] = rm.theta0[i];
      rref[2 * i + 1] = rm.radius0[i];
    }
    this.roll.upload(rm.nn, rref, rm.tris, rm.edges);
    this.rim = new Float32Array(2 * rm.nt);

    const sm = sim.flow.mesh;
    this.strip.upload(sm.nn, new Float32Array(2 * sm.nn), sm.tris, sm.edges);
    this.topLine = new Float32Array(2 * (sm.nx + 1));
    this.patch = new Float32Array(2 * (sm.nx + 1));
    this.prof = new Float32Array(2 * (sm.nx + 3));
  }

  private ribCap = 0;

  /** Grow the ribbon GPU buffers, which are then written with bufferSubData. */
  private ensureRibbon(verts: number): void {
    if (verts <= this.ribCap) return;
    const gl = this.gl;
    this.ribCap = Math.max(verts, this.ribCap * 2, 4096);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibPos);
    gl.bufferData(gl.ARRAY_BUFFER, this.ribCap * 8, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibSide);
    gl.bufferData(gl.ARRAY_BUFFER, this.ribCap * 4, gl.DYNAMIC_DRAW);
  }

  private initRibbon(): void {
    const gl = this.gl;
    this.bufRibPos = gl.createBuffer()!;
    this.bufRibSide = gl.createBuffer()!;
    this.vaoRib = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoRib);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibPos);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibSide);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private initCore(): void {
    const gl = this.gl;
    const seg = 128;
    const v = new Float32Array((seg + 2) * 2);
    for (let i = 0; i <= seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      v[2 * (i + 1)] = Math.cos(a);
      v[2 * (i + 1) + 1] = Math.sin(a);
    }
    this.coreVerts = seg + 2;
    const buf = gl.createBuffer()!;
    this.vaoCore = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoCore);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  resize(dpr: number): boolean {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  private scaleFor(cam: Camera): [number, number] {
    return [(2 * cam.zoom) / this.canvas.width, (2 * cam.zoom) / this.canvas.height];
  }

  /** Public so the host can overlay tracer lines in world coordinates. */
  strokePolyline(
    pts: Float32Array, count: number, closed: boolean, widthPx: number,
    cam: Camera, color: [number, number, number, number], soft: number, flip: number,
  ): void {
    if (count < 2) return;
    const gl = this.gl;
    const half = widthPx / (2 * cam.zoom);
    const n = closed ? count + 1 : count;
    if (this.ribPos.length < n * 4) {
      this.ribPos = new Float32Array(n * 8);
      this.ribSide = new Float32Array(n * 4);
    }
    const P = this.ribPos, S = this.ribSide;
    for (let i = 0; i < n; i++) {
      const i0 = i % count;
      const ip = closed || i0 > 0 ? (i0 - 1 + count) % count : i0;
      const inx = closed || i0 < count - 1 ? (i0 + 1) % count : i0;
      let tx = pts[2 * inx] - pts[2 * ip];
      let ty = pts[2 * inx + 1] - pts[2 * ip + 1];
      const L = Math.hypot(tx, ty) || 1;
      tx /= L; ty /= L;
      const nx = -ty * half, ny = tx * half;
      P[4 * i] = pts[2 * i0] + nx; P[4 * i + 1] = pts[2 * i0 + 1] + ny;
      P[4 * i + 2] = pts[2 * i0] - nx; P[4 * i + 3] = pts[2 * i0 + 1] - ny;
      S[2 * i] = 1; S[2 * i + 1] = -1;
    }
    gl.bindVertexArray(this.vaoRib);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibPos);
    gl.bufferData(gl.ARRAY_BUFFER, P.subarray(0, n * 4), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibSide);
    gl.bufferData(gl.ARRAY_BUFFER, S.subarray(0, n * 2), gl.DYNAMIC_DRAW);
    gl.useProgram(this.progRib);
    const sc = this.scaleFor(cam);
    gl.uniform2f(this.uRib.uCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uRib.uScale, sc[0], sc[1]);
    gl.uniform1f(this.uRib.uFlipY, flip);
    gl.uniform4fv(this.uRib.uColor, color);
    gl.uniform1f(this.uRib.uSoft, soft);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2);
    this.drawCalls++;
  }

  /**
   * Stroke many polylines in one draw. Each line becomes a ribbon and the
   * ribbons are stitched together with degenerate triangles, which turns what
   * would be dozens of draw calls (and as many buffer uploads, each of which
   * can stall the pipeline) into a single one.
   */
  /** Filled band between two matching polylines, e.g. the arc and its hill. */
  private fillBetween(
    a: Float32Array, b: Float32Array, count: number, cam: Camera,
    color: [number, number, number, number], flip: number,
  ): void {
    if (count < 2) return;
    const gl = this.gl;
    if (this.ribPos.length < count * 4) {
      this.ribPos = new Float32Array(count * 8);
      this.ribSide = new Float32Array(count * 4);
    }
    const P = this.ribPos, S = this.ribSide;
    for (let i = 0; i < count; i++) {
      P[4 * i] = a[2 * i]; P[4 * i + 1] = a[2 * i + 1];
      P[4 * i + 2] = b[2 * i]; P[4 * i + 3] = b[2 * i + 1];
      S[2 * i] = 0; S[2 * i + 1] = 1;
    }
    this.ensureRibbon(count * 2);
    gl.bindVertexArray(this.vaoRib);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, P.subarray(0, count * 4));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufRibSide);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.subarray(0, count * 2));
    gl.useProgram(this.progRib);
    const sc = this.scaleFor(cam);
    gl.uniform2f(this.uRib.uCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uRib.uScale, sc[0], sc[1]);
    gl.uniform1f(this.uRib.uFlipY, flip);
    gl.uniform4fv(this.uRib.uColor, color);
    gl.uniform1f(this.uRib.uSoft, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, count * 2);
    this.drawCalls++;
  }

  private drawBody(
    body: Body, cam: Camera, opts: RenderOptions, flip: number,
    isRoll: boolean, sim: RollingSim,
  ): void {
    const gl = this.gl;
    const sc = this.scaleFor(cam);
    gl.useProgram(this.progMesh);
    gl.bindVertexArray(body.vaoTri);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.uMesh.uLut, 0);
    gl.uniform2f(this.uMesh.uCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uMesh.uScale, sc[0], sc[1]);
    gl.uniform1f(this.uMesh.uFlipY, flip);
    gl.uniform2f(this.uMesh.uRange, opts.range.min, opts.range.max);
    gl.uniform2f(this.uMesh.uRadii,
      isRoll ? sim.roll.Rhub : 0, isRoll ? sim.roll.R : 1);
    gl.uniform1f(this.uMesh.uMarks, isRoll && opts.showMarks ? opts.markCount : 0);
    gl.uniform1f(this.uMesh.uMarkAmount, opts.markAmount);
    gl.uniform1f(this.uMesh.uShade, isRoll ? 0.34 : 0.10);
    // The mirror flips y, which already reverses the apparent sense of
    // rotation - exactly what the lower roll of a two-high stand does. Negating
    // the phase as well would cancel that and spin both rolls the same way.
    gl.uniform1f(this.uMesh.uPhase, isRoll ? sim.phase : 0);
    gl.uniform3f(this.uMesh.uNeutral,
      isRoll ? 0.30 : 0.34, isRoll ? 0.335 : 0.355, isRoll ? 0.395 : 0.40);
    const useField = isRoll ? opts.rollUseField : opts.stripUseField;
    gl.uniform1f(this.uMesh.uUseField, useField ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, body.triCount, gl.UNSIGNED_INT, 0);
    this.drawCalls++;

    if (opts.showWire) {
      gl.useProgram(this.progLine);
      gl.bindVertexArray(body.vaoWire);
      gl.uniform2f(this.uLine.uCenter, cam.cx, cam.cy);
      gl.uniform2f(this.uLine.uScale, sc[0], sc[1]);
      gl.uniform1f(this.uLine.uFlipY, flip);
      gl.uniform4f(this.uLine.uColor, 0.02, 0.03, 0.05, isRoll ? 0.18 : 0.34);
      gl.drawElements(gl.LINES, body.edgeCount, gl.UNSIGNED_INT, 0);
      this.drawCalls++;
    }
  }

  draw(sim: RollingSim, cam: Camera, opts: RenderOptions): void {
    const t0 = performance.now();
    const gl = this.gl;
    this.drawCalls = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const sc = this.scaleFor(cam);

    // ---- background --------------------------------------------------------
    gl.useProgram(this.progBg);
    gl.bindVertexArray(this.vaoEmpty);
    gl.uniform2f(this.uBg.uCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uBg.uScale, sc[0], sc[1]);
    // Pick a 1-2-5 grid pitch that lands near 60 px on screen. The model spans
    // four decades of thickness, so a fixed pitch is either invisible or a wall.
    {
      const raw = 60 / cam.zoom;
      const decade = Math.pow(10, Math.floor(Math.log10(raw)));
      const mant = raw / decade;
      const pitch = (mant < 2 ? 1 : mant < 5 ? 2 : 5) * decade;
      this.gridPitch = pitch;
      gl.uniform1f(this.uBg.uGrid, pitch);
    }
    gl.uniform1f(this.uBg.uPxPerM, 1 / cam.zoom);
    gl.uniform1f(this.uBg.uGridAlpha, opts.showGrid ? 1 : 0);
    gl.uniform3f(this.uBg.uTop, 0.043, 0.055, 0.086);
    gl.uniform3f(this.uBg.uBottom, 0.020, 0.026, 0.043);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;

    // ---- CPU side vertex update -------------------------------------------
    const mag = opts.rollMagnify;
    const rp = this.roll.pos, rX = sim.roll.X, ru = sim.rollUrel;
    for (let i = 0; i < 2 * this.roll.nn; i++) rp[i] = rX[i] + mag * ru[i];
    this.roll.val.set(sim.nodeField.subarray(0, this.roll.nn));
    this.roll.sync();

    // the strip is solved in an Eulerian frame, so its mesh is its geometry
    const off = sim.stripOff;
    const sX = sim.flow.mesh.X;
    const sp = this.strip.pos;
    for (let i = 0; i < 2 * this.strip.nn; i++) sp[i] = sX[i];
    this.strip.val.set(sim.nodeField.subarray(off, off + this.strip.nn));
    this.strip.sync();

    const flips = opts.showMirror ? [1, -1] : [1];

    for (const f of flips) this.drawBody(this.roll, cam, opts, f, true, sim);
    for (const f of flips) this.drawBody(this.strip, cam, opts, f, false, sim);

    // ---- barrel rim and strip outline -------------------------------------
    const nt = sim.roll.nt;
    const rim = this.rim;
    for (let i = 0; i < nt; i++) {
      const nd = sim.roll.surfNodes[i];
      rim[2 * i] = rX[2 * nd] + mag * ru[2 * nd];
      rim[2 * i + 1] = rX[2 * nd + 1] + mag * ru[2 * nd + 1];
    }
    for (const f of flips) {
      this.strokePolyline(rim, nt, true, 7, cam, [0.62, 0.78, 1.0, 0.14], 1, f);
      this.strokePolyline(rim, nt, true, 1.6, cam, [0.82, 0.90, 1.0, 0.8], 0, f);
    }

    const sm = sim.flow.mesh;
    const nxs = sm.nx;
    const top = this.topLine;
    for (let i = 0; i <= nxs; i++) {
      const nd = sm.topNodes[i];
      top[2 * i] = sX[2 * nd];
      top[2 * i + 1] = sX[2 * nd + 1];
    }
    for (const f of flips) {
      this.strokePolyline(top, nxs + 1, false, 2.0, cam, [1.0, 0.94, 0.82, 0.9], 0, f);
    }

    // ---- contact patch and interface pressure ------------------------------
    let m = 0;
    const patch = this.patch;
    const prof = this.prof;
    const pk = Math.max(sim.diag.peakPressure, 1e5);
    const hScale = (sim.params.h0 * 0.85) / pk;
    for (let i = 0; i <= nxs; i++) {
      if (!sim.flow.ifActive[i]) continue;
      const nd = sm.topNodes[i];
      patch[2 * m] = sX[2 * nd];
      patch[2 * m + 1] = sX[2 * nd + 1];
      // offset along the surface normal so the hill sits on the arc
      let ux = sX[2 * nd] - sim.roll.cx, uy = sX[2 * nd + 1] - sim.cy;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul; uy /= ul;
      const hgt = sim.flow.ifPressure[i] * hScale;
      prof[2 * m] = sX[2 * nd] - ux * hgt;
      prof[2 * m + 1] = sX[2 * nd + 1] - uy * hgt;
      m++;
    }
    if (m > 1) {
      if (opts.showContact) {
        for (const f of flips) {
          this.strokePolyline(patch.subarray(0, 2 * m), m, false, 11, cam, [1.0, 0.82, 0.35, 0.30], 1, f);
          this.strokePolyline(patch.subarray(0, 2 * m), m, false, 2.6, cam, [1.0, 0.92, 0.6, 0.95], 0, f);
        }
      }
      if (opts.showPressure) {
        // Friction hill drawn on the arc itself, the way a rolling text draws
        // it: the ordinate is measured normal to the contact from the surface.
        const A = patch.subarray(0, 2 * m), B = prof.subarray(0, 2 * m);
        for (const f of flips) {
          this.fillBetween(A, B, m, cam, [0.36, 0.86, 1.0, 0.22], f);
          this.strokePolyline(B, m, false, 2.0, cam, [0.72, 0.97, 1.0, 0.95], 0, f);
        }
      }
    }

    // ---- neutral plane -----------------------------------------------------
    // Where the strip and the barrel run at the same speed the interface shear
    // changes sign. Upstream of it the roll drags the strip forward, downstream
    // the strip outruns the roll. Drawn through the thickness because that is
    // how a rolling diagram marks it, and in the same colour as the marker on
    // the friction hill so the two views read as one.
    if (opts.showNeutral && sim.diag.neutralFound) {
      const xn = sim.diag.neutralX;
      const t = ((xn - sim.winIn) / (sim.winOut - sim.winIn)) * sm.nx;
      const i = Math.max(0, Math.min(sm.nx - 1, Math.floor(t)));
      const fr = Math.max(0, Math.min(1, t - i));
      const ya = sX[2 * sm.topNodes[i] + 1];
      const yb = sX[2 * sm.topNodes[i + 1] + 1];
      const yTop = ya + (yb - ya) * fr;
      const seg = new Float32Array([xn, 0, xn, yTop]);
      for (const f of flips) {
        // dark halo first: the plane has to stay readable over both ends of
        // whichever colour ramp the strip is carrying
        this.strokePolyline(seg, 2, false, 4.4, cam, [0.05, 0.02, 0.04, 0.65], 0, f);
        this.strokePolyline(seg, 2, false, 2.0, cam, [1.0, 0.52, 0.64, 1.0], 0, f);
      }
      // a tick above the surface so the plane is findable at any zoom
      const tick = new Float32Array([xn, yTop, xn, yTop + sim.params.h0 * 0.28]);
      this.strokePolyline(tick, 2, false, 2.0, cam, [1.0, 0.52, 0.64, 0.85], 0, 1);
    }

    // ---- symmetry plane ----------------------------------------------------
    // Mirrored, it is just a centre line. Unmirrored it is the boundary of the
    // solved domain, so it is drawn as a proper constraint edge.
    {
      const halfW = this.canvas.width / (2 * cam.zoom) + Math.abs(cam.cx);
      const line = new Float32Array([cam.cx - halfW, 0, cam.cx + halfW, 0]);
      if (opts.showMirror) {
        this.strokePolyline(line, 2, false, 1, cam, [0.55, 0.68, 0.9, 0.30], 0, 1);
      } else {
        this.strokePolyline(line, 2, false, 7, cam, [0.35, 0.60, 0.95, 0.18], 1, 1);
        this.strokePolyline(line, 2, false, 1.6, cam, [0.62, 0.80, 1.0, 0.85], 0, 1);
      }
    }

    // ---- hubs --------------------------------------------------------------
    gl.useProgram(this.progCore);
    gl.bindVertexArray(this.vaoCore);
    gl.uniform2f(this.uCore.uCenter, cam.cx, cam.cy);
    gl.uniform2f(this.uCore.uScale, sc[0], sc[1]);
    gl.uniform2f(this.uCore.uOrigin, sim.roll.cx, sim.cy);
    gl.uniform1f(this.uCore.uRadius, sim.roll.Rhub);
    gl.uniform3f(this.uCore.uTint, 0.55, 0.60, 0.70);
    for (const f of flips) {
      gl.uniform1f(this.uCore.uFlipY, f);
      gl.uniform1f(this.uCore.uAngle, sim.phase);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, this.coreVerts);
      this.drawCalls++;
    }

    gl.bindVertexArray(null);
    this.lastDrawMs = performance.now() - t0;
  }
}

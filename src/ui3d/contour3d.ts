/**
 * Contour plots on the bodies of the bite in three dimensions: the strip from the app's
 * material FEM, the work and backup rolls from FrontISTR, each coloured by a nodal field.
 *
 * What it is for: to read at a glance where the strip deforms plastically and where the rolls'
 * stress gathers. So the colours are the values' and nothing else's - the strip on a warm ramp
 * (`ember`), the rolls on a cool one (`steel`), a signed field on a diverging one centred on 0 -
 * cut into bands with a thin line at each band edge (the finite-element post-processors'
 * habit), and the largest value of each body is pointed at with its number.
 *
 * The two bodies come from different places at different rates (fieldframe.ts): `setPart`
 * places a body (again when its shape changes - the strip's does every solve), `update` swaps
 * its values (and displacement) in. Each body's colour bar spans its own group (strip, rolls),
 * so the rolls' frame arriving leaves the strip's colours alone.
 *
 * WebGL2 and nothing else, like stack3d.ts, with its handling: drag to turn, wheel to zoom
 * (here toward the point under the pointer), double-click to go back to the whole view; and a
 * right- or shift-drag to move. Labels, legends and the readout are DOM over the canvas.
 *
 * The values are turned into t = (v − lo) / (hi − lo) on the CPU (contourmath.ts) and the
 * shader only bands t and looks it up in the ramp, so the legend and the picture cannot
 * disagree. A body drawn several times over its symmetry planes is one buffer drawn with a
 * mirror per copy.
 */
import { rampTexels, rampCss, COLORMAP_NAMES } from '../gfx/colormap';
import type { FieldPart, FieldValues, LabelState, PartKind } from './fieldframe';
import {
  FIELD_ORDER, fieldInfo, rangeFor, normalizeInto, bandCentre, rampCoord, RAMP_FLOOR, argExtreme,
  splitCreases, vertexNormals, meshEdges, fmt,
  type Range, type RangeMode, type NormalizeCounts,
} from './contourmath';
import './contour3d.css';

const HDR = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

const BG_VS = `${HDR}
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() { vUv = P[gl_VertexID] * 0.5 + 0.5; gl_Position = vec4(P[gl_VertexID], 0.999, 1.0); }`;
// the 3D tab's screen (stack3d.ts), a step darker: the ramps' low ends are dark too, and the
// bodies have to stand off it before any value has coloured them
const BG_FS = `${HDR}
in vec2 vUv; out vec4 o;
void main() {
  vec3 top = vec3(0.042, 0.056, 0.086), bot = vec3(0.012, 0.016, 0.026);
  float r = length(vUv - vec2(0.5, 0.62));
  o = vec4(mix(top, bot, smoothstep(0.0, 0.95, r)), 1.0);
}`;

const PART_VS = `${HDR}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aDisp;
layout(location=2) in vec3 aNrm;
layout(location=3) in vec2 aVal;
uniform mat4 uProj, uView;
uniform vec3 uMirror;
uniform float uScale;
out vec3 vPos; out vec3 vNrm; out vec2 vVal;
void main() {
  vec3 p = (aPos + uScale * aDisp) * uMirror;
  vPos = p; vNrm = aNrm * uMirror; vVal = aVal;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

// vVal = (t, has a value). Bands: t cut into uBands, each read at its middle; uBands 0 is the
// continuous ramp. A line where t crosses a band edge, a pixel or so wide at any zoom (fwidth).
// Outside a fixed range: the end colour, striped (above the automatic range's 99.5 % point: the
// end colour only - the viewer did not choose that range). No value: grey, hatched the other way.
const PART_FS = `${HDR}
in vec3 vPos; in vec3 vNrm; in vec2 vVal;
uniform sampler2D uRamp;
uniform float uBands, uFloor, uIso, uHasField, uMetal, uStripe, uShade;
uniform vec3 uEye, uKey, uFill;
out vec4 o;
void main() {
  vec3 n = normalize(vNrm);
  vec3 v = normalize(uEye - vPos);
  if (dot(n, v) < 0.0) n = -n;
  vec3 base;
  if (uHasField < 0.5 || vVal.y < 0.999) {
    float h = mod(gl_FragCoord.x + gl_FragCoord.y, 9.0);
    base = h < 1.7 ? vec3(0.19, 0.21, 0.25) : vec3(0.29, 0.32, 0.38);
  } else {
    float t = vVal.x, tc = clamp(t, 0.0, 1.0);
    float u = uBands > 0.5 ? (min(floor(tc * uBands), uBands - 1.0) + 0.5) / uBands : tc;
    base = texture(uRamp, vec2(uFloor + (1.0 - uFloor) * u, 0.5)).rgb;
    if (uBands > 0.5) {
      float f = tc * uBands, fw = fwidth(f), w = max(fw, 1e-4);
      float d = abs(fract(f + 0.5) - 0.5);
      // a flat patch sitting exactly on an edge crosses nothing: no line over the whole of it
      float line = (1.0 - smoothstep(0.5 * w, 1.5 * w, d)) * step(1e-6, fw);
      // not on the range's own ends (0 and 1 are the bar's edges, not contours)
      line *= step(0.5 * w, f) * step(0.5 * w, uBands - f);
      base = mix(base, base * 0.3, line * uIso);
    }
    if (uStripe > 0.5 && (t < 0.0 || t > 1.0)) {
      float h = mod(gl_FragCoord.x - gl_FragCoord.y, 7.0);
      if (h < 2.0) base = t < 0.0 ? base * 0.35 : mix(base, vec3(1.0), 0.6);
    }
  }
  // light: enough to read the shape, not so much that a shadow reads as a lower value
  vec3 k = normalize(uKey), f = normalize(uFill);
  float lit = 0.52 + 0.52 * max(dot(n, k), 0.0) + 0.12 * max(dot(n, f), 0.0);
  float spec = pow(max(dot(n, normalize(k + v)), 0.0), 48.0) * uMetal;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  o = uShade > 0.5 ? vec4(base * lit + vec3(0.30 * spec) + vec3(0.42, 0.52, 0.66) * 0.16 * rim, 1.0) : vec4(base, 1.0);
}`;

const LINE_FS = `${HDR}
uniform vec4 uCol; out vec4 o;
void main() { o = uCol; }`;

// which body, which mirror copy and which vertex is under a pixel (the triangle's provoking,
// i.e. last, vertex; the readout finds the triangle among that vertex's)
const PICK_VS = `${HDR}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aDisp;
uniform mat4 uProj, uView;
uniform vec3 uMirror;
uniform float uScale;
uniform uint uTag;
flat out uint vId;
void main() {
  vId = uTag | uint(gl_VertexID);
  gl_Position = uProj * uView * vec4((aPos + uScale * aDisp) * uMirror, 1.0);
}`;
const PICK_FS = `${HDR}
flat in uint vId; out uint o;
void main() { o = vId; }`;

type M4 = Float32Array;
const perspective = (fovy: number, aspect: number, near: number, far: number): M4 => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
};
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(eye: V3, at: V3, up: V3): { m: M4; x: V3; y: V3; z: V3 } {
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
  return { m, x, y, z };
}
const mul = (a: M4, b: M4): M4 => {
  const m = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    m[i * 4 + j] = s;
  }
  return m;
};

const FOV = 0.55;
const GROUPS: PartKind[] = ['roll', 'strip'];
const GROUP_NAME: Record<PartKind, string> = { strip: '板', roll: 'ロール' };
const DEFAULT_RAMP: Record<PartKind, string> = { strip: 'ember', roll: 'steel' };
const DEFAULT_FIELD: Record<PartKind, string[]> = { strip: ['eq', 'peeq', 'eqRate', 'mises'], roll: ['mises', 'cpress'] };
const SIGNED_RAMP = 'coolwarm';
const DEFORM_STEPS = [1, 10, 100, 300, 1000, 3000];
const BAND_STEPS = [0, 6, 8, 10, 12, 16];

export type ViewPreset = 'all' | 'bite' | 'end' | 'front';
const PRESETS: { id: ViewPreset; text: string; title: string }[] = [
  { id: 'all', text: '全体', title: 'ロールと板の全体（ダブルクリックでも戻る）' },
  { id: 'bite', text: '噛み込み', title: '入側の上から板の端の噛み込み域に寄る（全体図では板は線にしか見えない）。板はロールに挟まれて外から見えないので、鏡映を切って解いた範囲（ロールは z ≥ 0 の上半分）だけにする — ロール軸の面の断面に接触の下の応力が出る' },
  { id: 'end', text: '端面', title: 'ロール軸の方向から（端面図と同じ向き）' },
  { id: 'front', text: '正面', title: '出側から圧延方向に逆らって見る（幅方向が横）' },
];

export interface ContourOptions {
  /** colour bands (0 = continuous) */
  bands: number;
  /** element edges drawn */
  mesh: boolean;
  /** displacement × this (the strip has none: its coordinates are its shape) */
  deform: number;
  /** draw the copies over the symmetry planes (off: only what was solved, the cuts showing) */
  mirror: boolean;
  /** point at each group's largest value (and a signed field's smallest) */
  extremes: boolean;
  /** light the bodies (off: each band exactly its legend colour, flat) */
  shading: boolean;
  /** where each group's values come from, for the status plate */
  sources: Record<PartKind, string>;
  /** the built-in controls, legends and readout (off: a bare picture, for a host that has its own) */
  controls: boolean;
}

const DEFAULTS: ContourOptions = {
  bands: 10, mesh: false, deform: 1, mirror: true, extremes: true, shading: true,
  sources: { strip: '材料 FEM', roll: 'FrontISTR' }, controls: true,
};

interface GroupState {
  field: string;
  ramp: string;
  mode: RangeMode;
  fixed: { lo: number; hi: number } | null;
  range: Range;
  full: Range;
  counts: NormalizeCounts;
  /** the extremes (max, and min for a signed field): body and node */
  top: { part: string; node: number; value: number } | null;
  bottom: { part: string; node: number; value: number } | null;
  label: FieldValues['label'] | null;
  labelAt: number;
  tex: WebGLTexture;
  texRamp: string;
}

interface GpuPart {
  part: FieldPart;
  index: number;
  visible: boolean;
  nodes: number;
  /** drawn vertex → node, and whether that is the identity (no crease split) */
  src: Uint32Array;
  identity: boolean;
  tris: Uint32Array;
  vao: WebGLVertexArrayObject;
  pickVao: WebGLVertexArrayObject;
  bufPos: WebGLBuffer;
  bufDisp: WebGLBuffer;
  bufNrm: WebGLBuffer;
  bufVal: WebGLBuffer;
  ibo: WebGLBuffer;
  lineIbo: WebGLBuffer;
  lineCount: number;
  /** CPU copies per drawn vertex */
  pos: Float32Array;
  disp: Float32Array;
  nrm: Float32Array;
  val: Float32Array;
  hasDisp: boolean;
  maxDisp: number;
  /** normals of the displaced shape, for the magnification they were made for */
  nrmScale: number;
  values: FieldValues | null;
  lo: V3;
  hi: V3;
  /** vertex → triangles (CSR), for the readout; built on the first pick */
  adj: { start: Uint32Array; tri: Uint32Array } | null;
  mirrors: V3[];
}

export interface PickResult {
  part: string;
  kind: PartKind;
  node: number;
  field: string;
  value: number;
  /** the point hit, in the scene's coordinates [m] */
  point: V3;
}

/** a body as the page names it */
const bodyName = (name: string) => (name === 'strip' ? '板' : name);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ContourView3D {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private progBg: WebGLProgram;
  private progPart: WebGLProgram;
  private progLine: WebGLProgram;
  private progPick: WebGLProgram;
  private u: Record<string, Record<string, WebGLUniformLocation | null>> = {};
  private parts = new Map<string, GpuPart>();
  private order: string[] = [];
  private groups: Record<PartKind, GroupState>;
  readonly opts: ContourOptions;
  private yaw = 0.62;
  private pitch = 0.32;
  private dist = 1;
  private target: V3 = [0, 0, 0];
  private cam: { eye: V3; x: V3; y: V3; z: V3; proj: M4; view: M4; w: number; h: number } | null = null;
  private frameReq = 0;
  private pickFbo: { fb: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; w: number; h: number } | null = null;
  private drag: { x: number; y: number; yaw: number; pitch: number; target: V3; pan: boolean } | null = null;
  private hover: { x: number; y: number } | null = null;
  private hoverReq = 0;
  private ro: ResizeObserver;
  /** fit the scene as bodies arrive (to this view), until the viewer (or the host, once there is something to see) picks one */
  private autoView = true;
  private autoPreset: ViewPreset = 'all';
  /** timings [ms] of the last update(), of the normals it made, of the groups' colouring (once per drawn frame) and of the last frame's draw calls */
  readonly stats = { updateMs: 0, normalsMs: 0, groupsMs: 0, renderMs: 0, vertices: 0, triangles: 0 };
  /** groups whose colours are out of date; coloured once before the next frame, however many bodies changed */
  private dirty = new Set<PartKind>();
  /** scratch for the displaced positions the normals are made from */
  private scratch = new Float32Array(0);
  // DOM
  private overlay: HTMLElement;
  private statusBox!: HTMLElement;
  private legendBox!: HTMLElement;
  private toolbar!: HTMLElement;
  private readout!: HTMLElement;
  private markBox!: HTMLElement;
  private legends = new Map<PartKind, { root: HTMLElement; select: HTMLSelectElement; ramp: HTMLSelectElement; scale: HTMLElement; bar: HTMLElement; ticks: HTMLElement; note: HTMLElement; mode: HTMLSelectElement; lo: HTMLInputElement; hi: HTMLInputElement; unit: HTMLElement; body: HTMLElement }>();
  private partButtons = new Map<string, HTMLButtonElement>();
  private partRow!: HTMLElement;
  private marks: HTMLElement[] = [];

  constructor(private host: HTMLElement, opts: Partial<ContourOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts, sources: { ...DEFAULTS.sources, ...(opts.sources ?? {}) } };
    host.classList.add('ct3');
    this.canvas = el('canvas', 'ct3-canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '板とロールの 3D コンター図（ドラッグで回転、ホイールで拡大、右ドラッグで移動、ダブルクリックで全体）');
    host.append(this.canvas);
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
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
    this.progBg = link(BG_VS, BG_FS, 'contour3d bg');
    this.progPart = link(PART_VS, PART_FS, 'contour3d part');
    this.progLine = link(PART_VS, LINE_FS, 'contour3d line');
    this.progPick = link(PICK_VS, PICK_FS, 'contour3d pick');
    const uni = (p: WebGLProgram, key: string, names: string[]) => {
      this.u[key] = {};
      for (const n of names) this.u[key][n] = gl.getUniformLocation(p, n);
    };
    uni(this.progPart, 'part', ['uProj', 'uView', 'uMirror', 'uScale', 'uRamp', 'uBands', 'uFloor', 'uIso', 'uHasField', 'uMetal', 'uStripe', 'uShade', 'uEye', 'uKey', 'uFill']);
    uni(this.progLine, 'line', ['uProj', 'uView', 'uMirror', 'uScale', 'uCol']);
    uni(this.progPick, 'pick', ['uProj', 'uView', 'uMirror', 'uScale', 'uTag']);

    const group = (k: PartKind): GroupState => ({
      field: DEFAULT_FIELD[k][0], ramp: DEFAULT_RAMP[k], mode: 'auto', fixed: null,
      range: { lo: 0, hi: 1, uniform: true, count: 0 }, full: { lo: 0, hi: 1, uniform: true, count: 0 },
      counts: { missing: 0, below: 0, above: 0, total: 0 }, top: null, bottom: null, label: null, labelAt: 0,
      tex: gl.createTexture()!, texRamp: '',
    });
    this.groups = { strip: group('strip'), roll: group('roll') };

    this.overlay = el('div', 'ct3-overlay');
    host.append(this.overlay);
    this.buildOverlay();
    this.bindPointer();
    // a new size may change the legends' room for labels too
    this.ro = new ResizeObserver(() => { for (const k of GROUPS) this.dirty.add(k); this.requestRender(); });
    this.ro.observe(host);
    this.requestRender();
  }

  // ── data ───────────────────────────────────────────────────────────────

  /** place a body, or replace its shape (the strip's changes every solve); its values stay until the next update */
  setPart(part: FieldPart): void {
    const gl = this.gl;
    const nodes = part.coords.length / 3;
    let g = this.parts.get(part.name);
    let added = false;
    const sameTopology = !!g && g.nodes === nodes && g.part.tris.length === part.tris.length && sameArray(g.part.tris, part.tris);
    if (!g || !sameTopology) {
      if (g) this.dropGpu(g);
      const split = splitCreases(part.coords, part.tris);
      const nv = split.src.length;
      const identity = nv === nodes;
      const vao = gl.createVertexArray()!, pickVao = gl.createVertexArray()!;
      const mk = () => gl.createBuffer()!;
      g = {
        part, index: g?.index ?? this.freeIndex(), visible: g?.visible ?? true, nodes, src: split.src, identity, tris: split.tris,
        vao, pickVao, bufPos: mk(), bufDisp: mk(), bufNrm: mk(), bufVal: mk(), ibo: mk(), lineIbo: mk(), lineCount: 0,
        pos: new Float32Array(3 * nv), disp: new Float32Array(3 * nv), nrm: new Float32Array(3 * nv), val: new Float32Array(2 * nv),
        hasDisp: false, maxDisp: 0, nrmScale: 0, values: g?.values ?? null, lo: [0, 0, 0], hi: [0, 0, 0], adj: null, mirrors: [],
      };
      const edges = meshEdges(part.tris);
      // the edges are over nodes; draw them on each node's first vertex (its own number)
      g.lineCount = edges.length;
      gl.bindVertexArray(vao);
      const attrib = (loc: number, buf: WebGLBuffer, size: number, data: Float32Array) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      attrib(0, g.bufPos, 3, g.pos);
      attrib(1, g.bufDisp, 3, g.disp);
      attrib(2, g.bufNrm, 3, g.nrm);
      attrib(3, g.bufVal, 2, g.val);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.tris, gl.STATIC_DRAW);
      gl.bindVertexArray(pickVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufPos);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufDisp);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.lineIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);
      if (!this.parts.has(part.name)) { this.order.push(part.name); added = true; }
      this.parts.set(part.name, g);
    }
    g.part = part;
    // positions per drawn vertex
    const { src, pos } = g;
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < src.length; v++) {
      const s = 3 * src[v];
      for (let a = 0; a < 3; a++) {
        const c = part.coords[s + a];
        pos[3 * v + a] = c;
        if (c < lo[a]) lo[a] = c;
        if (c > hi[a]) hi[a] = c;
      }
    }
    g.lo = lo; g.hi = hi;
    const sym = part.symmetry;
    g.mirrors = [];
    for (const sx of sym.x ? [1, -1] : [1]) for (const sy of sym.y ? [1, -1] : [1]) for (const sz of sym.z ? [1, -1] : [1]) g.mirrors.push([sx, sy, sz]);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bufPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    this.refreshNormals(g, true);
    // a strip whose shape changed keeps its values only while they still fit
    if (g.values && !valuesFit(g.values, nodes)) g.values = null;
    this.dirty.add(g.part.kind);
    this.syncPartButtons();
    if (added && this.autoView) this.fit(this.autoPreset);
    this.requestRender();
  }

  /** a body's values (and displacement) swapped in */
  update(name: string, values: FieldValues): void {
    const t0 = performance.now();
    const g = this.parts.get(name);
    if (!g) throw new Error(`contour3d: 部品 ${name} が置かれていない（先に setPart）`);
    if (!valuesFit(values, g.nodes)) throw new Error(`contour3d: ${name} の値の長さが節点 ${g.nodes} と合わない`);
    g.values = values;
    const gl = this.gl;
    if (values.disp) {
      const d = values.disp, { src, disp } = g;
      if (g.identity) disp.set(d);
      else {
        for (let v = 0; v < src.length; v++) {
          const s = 3 * src[v];
          disp[3 * v] = d[s]; disp[3 * v + 1] = d[s + 1]; disp[3 * v + 2] = d[s + 2];
        }
      }
      // a node the result lacks (NaN) stays where it was placed rather than taking its triangles to infinity
      let m = 0;
      for (let i = 0; i < disp.length; i++) {
        const a = Math.abs(disp[i]);
        if (!(a < Infinity)) disp[i] = 0; else if (a > m) m = a;
      }
      g.hasDisp = true; g.maxDisp = m;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufDisp);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.disp);
    } else if (g.hasDisp) {
      g.hasDisp = false; g.maxDisp = 0; g.disp.fill(0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufDisp);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.disp);
    }
    this.refreshNormals(g, false);
    const grp = this.groups[g.part.kind];
    grp.label = values.label; grp.labelAt = performance.now();
    this.dirty.add(g.part.kind);
    this.stats.updateMs = performance.now() - t0;
    this.requestRender();
  }

  /** a body's status label changed with no new values (a calculation reached another stage) */
  relabel(name: string, label: FieldValues['label']): void {
    const g = this.parts.get(name);
    if (!g?.values) return;
    g.values = { ...g.values, label };
    const grp = this.groups[g.part.kind];
    grp.label = label; grp.labelAt = performance.now();
    this.drawStatus();
  }

  /** take a body away */
  removePart(name: string): void {
    const g = this.parts.get(name);
    if (!g) return;
    this.dropGpu(g);
    this.parts.delete(name);
    this.order = this.order.filter((n) => n !== name);
    this.dirty.add(g.part.kind);
    this.syncPartButtons();
    this.requestRender();
  }

  /** the field a group is coloured by */
  setField(kind: PartKind, field: string): void {
    this.groups[kind].field = field;
    this.dirty.add(kind);
    this.requestRender();
  }

  /** the colour bar's range: automatic (min … 99.5 % point), full (min … max) or fixed [SI units] */
  setRange(kind: PartKind, mode: RangeMode, fixed?: { lo: number; hi: number }): void {
    const grp = this.groups[kind];
    grp.mode = mode;
    if (fixed) grp.fixed = fixed;
    this.dirty.add(kind);
    this.requestRender();
  }

  /** the ramp a group's unsigned fields are drawn on (a signed field always takes the diverging one) */
  setRamp(kind: PartKind, ramp: string): void {
    this.groups[kind].ramp = ramp;
    this.dirty.add(kind);
    this.requestRender();
  }

  setOptions(o: Partial<Omit<ContourOptions, 'sources' | 'controls'>>): void {
    Object.assign(this.opts, o);
    if (o.deform !== undefined) for (const g of this.parts.values()) this.refreshNormals(g, false);
    for (const k of GROUPS) this.dirty.add(k);
    this.syncToolbar();
    this.requestRender();
  }

  setPartVisible(name: string, visible: boolean): void {
    const g = this.parts.get(name);
    if (!g) return;
    g.visible = visible;
    this.dirty.add(g.part.kind);
    this.syncPartButtons();
    this.requestRender();
  }

  /** colour what changed now rather than before the next frame (for measuring, and before reading groupState) */
  flush(): void {
    if (!this.dirty.size) return;
    const t0 = performance.now();
    for (const k of GROUPS) if (this.dirty.has(k)) this.refreshGroup(k);
    this.dirty.clear();
    this.stats.groupsMs = performance.now() - t0;
  }

  /** what a group shows now (for a host's own controls and for tests) */
  groupState(kind: PartKind): { field: string; ramp: string; mode: RangeMode; range: Range; full: Range; counts: NormalizeCounts; top: GroupState['top']; bottom: GroupState['bottom'] } {
    this.flush();
    const g = this.groups[kind];
    return { field: g.field, ramp: this.rampOf(kind), mode: g.mode, range: g.range, full: g.full, counts: g.counts, top: g.top, bottom: g.bottom };
  }

  partNames(): string[] { return [...this.order]; }

  /** the smallest body number not in use (the pick buffer tags a body with 5 bits) */
  private freeIndex(): number {
    const used = new Set([...this.parts.values()].map((q) => q.index));
    let i = 0;
    while (used.has(i)) i++;
    if (i > 31) throw new Error('contour3d: 部品は 32 個まで');
    return i;
  }

  private dropGpu(g: GpuPart): void {
    const gl = this.gl;
    gl.deleteVertexArray(g.vao); gl.deleteVertexArray(g.pickVao);
    for (const b of [g.bufPos, g.bufDisp, g.bufNrm, g.bufVal, g.ibo, g.lineIbo]) gl.deleteBuffer(b);
  }

  /** smooth normals of the drawn shape: the displaced one when the magnified displacement shows, else the placed one */
  private refreshNormals(g: GpuPart, placed: boolean): void {
    const t0 = performance.now();
    // A magnified displacement under 0.2 % of the body's size does not turn the shading
    // visibly (and most of a roll's is the rigid sink, which turns nothing): the placed
    // shape's normals do, and a frame then costs no normals at all.
    const ext = Math.max(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1], g.hi[2] - g.lo[2], 1e-9);
    const s = g.hasDisp && g.maxDisp * this.opts.deform > 2e-3 * ext ? this.opts.deform : 0;
    if (!placed && s === 0 && g.nrmScale === 0) { this.stats.normalsMs = 0; return; }
    if (s === 0) vertexNormals(g.pos, g.tris, g.nrm);
    else {
      if (this.scratch.length < g.pos.length) this.scratch = new Float32Array(g.pos.length);
      const p = this.scratch;
      for (let i = 0; i < g.pos.length; i++) p[i] = g.pos[i] + s * g.disp[i];
      vertexNormals(p.subarray(0, g.pos.length), g.tris, g.nrm);
    }
    g.nrmScale = s;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.bufNrm);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.nrm);
    this.stats.normalsMs = performance.now() - t0;
  }

  private rampOf(kind: PartKind): string {
    const grp = this.groups[kind];
    return fieldInfo(grp.field).signed ? SIGNED_RAMP : grp.ramp;
  }

  /** a group's range over its visible bodies, their t, its extremes, its legend */
  private refreshGroup(kind: PartKind): void {
    const grp = this.groups[kind];
    const gl = this.gl;
    const info = fieldInfo(grp.field);
    const members = this.order.map((n) => this.parts.get(n)!).filter((g) => g.part.kind === kind);
    const shown = members.filter((g) => g.visible);
    const arrays: Float32Array[] = [];
    for (const g of shown) { const a = g.values?.fields[grp.field]; if (a) arrays.push(a); }
    grp.full = rangeFor(arrays, info.signed, 'full');
    grp.range = rangeFor(arrays, info.signed, grp.mode, grp.fixed ?? undefined);
    const counts: NormalizeCounts = { missing: 0, below: 0, above: 0, total: 0 };
    let top: GroupState['top'] = null, bottom: GroupState['bottom'] = null;
    for (const g of members) {
      const a = g.values?.fields[grp.field];
      if (!a) { g.val.fill(0); }
      else {
        // per drawn vertex straight from its node's value
        const nodeT = g.identity ? null : new Float32Array(g.nodes), nodeV = g.identity ? null : new Float32Array(g.nodes);
        const tt = g.identity ? new Float32Array(g.nodes) : nodeT!, vv = g.identity ? new Float32Array(g.nodes) : nodeV!;
        const c = normalizeInto(tt, vv, a, grp.range.lo, grp.range.hi);
        if (g.visible) { counts.missing += c.missing; counts.below += c.below; counts.above += c.above; counts.total += c.total; }
        const { src, val } = g;
        for (let v = 0; v < src.length; v++) { const s = src[v]; val[2 * v] = tt[s]; val[2 * v + 1] = vv[s]; }
        if (g.visible) {
          const iMax = argExtreme(a, true), iMin = argExtreme(a, false);
          if (iMax >= 0 && (!top || a[iMax] > top.value)) top = { part: g.part.name, node: iMax, value: a[iMax] };
          if (iMin >= 0 && (!bottom || a[iMin] < bottom.value)) bottom = { part: g.part.name, node: iMin, value: a[iMin] };
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.bufVal);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.val);
    }
    grp.counts = counts; grp.top = top; grp.bottom = bottom;
    const ramp = this.rampOf(kind);
    if (grp.texRamp !== ramp) {
      gl.bindTexture(gl.TEXTURE_2D, grp.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampTexels(ramp));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      grp.texRamp = ramp;
    }
    this.drawLegend(kind);
    this.drawStatus();
  }

  // ── view ───────────────────────────────────────────────────────────────

  /** the bounds of what is drawn, mirror copies included */
  private sceneBounds(filter?: (g: GpuPart) => boolean): { lo: V3; hi: V3 } | null {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const g of this.parts.values()) {
      if (!g.visible || (filter && !filter(g))) continue;
      for (const m of this.opts.mirror ? g.mirrors : [[1, 1, 1] as V3]) {
        for (let a = 0; a < 3; a++) {
          const p = g.lo[a] * m[a], q = g.hi[a] * m[a];
          lo[a] = Math.min(lo[a], p, q); hi[a] = Math.max(hi[a], p, q);
        }
      }
      any = true;
    }
    return any ? { lo, hi } : null;
  }

  /** go to a view: the whole mill, the strip's bite (at its edge), along the roll axes, from the exit */
  setView(v: ViewPreset): void {
    if (!this.sceneBounds()) { this.autoPreset = v; this.autoView = true; this.syncViewButtons(v); return; }
    this.autoView = false;
    this.fit(v);
  }

  private fit(v: ViewPreset): void {
    // the strip lies between the rolls: seen only with the mirror copies out of the way
    const mirror = v !== 'bite';
    if (mirror !== this.opts.mirror) { this.opts.mirror = mirror; this.syncToolbar(); }
    const b = this.sceneBounds();
    if (!b) return;
    const c: V3 = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
    const ext = Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2;
    const fit = (r: number) => (r / Math.tan(FOV / 2)) * 1.08;
    if (v === 'bite') {
      const s = this.sceneBounds((g) => g.part.kind === 'strip');
      if (s) {
        const len = Math.max(s.hi[2] - s.lo[2], 1e-4);
        // the strip's edge on the +x side, from above the entry: its top face, its edge, and
        // the work roll's cut (z = 0, facing the entry) standing over the exit
        this.target = [s.hi[0] - 0.6 * len, 0.2 * len, -0.35 * len];
        this.yaw = Math.PI - 0.75; this.pitch = 0.5; this.dist = fit(1.7 * len);
      } else {
        this.target = [c[0], 0, 0]; this.yaw = 0.6; this.pitch = 0.3; this.dist = fit(0.1 * ext);
      }
    } else if (v === 'end') {
      this.target = [0, c[1], c[2]]; this.yaw = Math.PI / 2; this.pitch = 0; this.dist = fit(Math.max(b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) * 0.56);
    } else if (v === 'front') {
      this.target = [c[0], c[1], 0]; this.yaw = 0; this.pitch = 0; this.dist = fit(Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1]) * 0.56);
    } else {
      this.target = c; this.yaw = 0.62; this.pitch = 0.32; this.dist = fit(ext * 1.02);
    }
    this.syncViewButtons(v);
    this.requestRender();
  }

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      const pan = e.button === 2 || e.shiftKey;
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, target: [...this.target] as V3, pan };
      c.setPointerCapture(e.pointerId);
      this.autoView = false;
      this.syncViewButtons(null);
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (this.drag.pan && this.cam) {
          // move the target in the screen's plane, a pixel per pixel at the target's depth
          const k = (2 * this.dist * Math.tan(FOV / 2)) / Math.max(1, this.cam.h);
          const t = this.drag.target, x = this.cam.x, y = this.cam.y;
          this.target = [t[0] - k * (dx * x[0] - dy * y[0]), t[1] - k * (dx * x[1] - dy * y[1]), t[2] - k * (dx * x[2] - dy * y[2])];
        } else {
          // as stack3d: dragging right turns the scene right
          this.yaw = this.drag.yaw - dx * 0.008;
          this.pitch = Math.max(-1.4, Math.min(1.4, this.drag.pitch + dy * 0.008));
        }
        this.requestRender();
      } else {
        this.requestHover();
      }
    });
    const end = () => { this.drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.hover = null; this.showReadout(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0015);
      const b = this.sceneBounds();
      const ext = b ? Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) : 1;
      const d2 = Math.max(ext * 1e-4, Math.min(ext * 12, this.dist * f));
      // toward the point under the pointer: it stays under the pointer as the view closes in
      const r = c.getBoundingClientRect();
      const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (hit) {
        const k = d2 / this.dist;
        this.target = [hit.point[0] + (this.target[0] - hit.point[0]) * k, hit.point[1] + (this.target[1] - hit.point[1]) * k, hit.point[2] + (this.target[2] - hit.point[2]) * k];
      }
      this.dist = d2;
      this.autoView = false;
      this.syncViewButtons(null);
      this.requestRender();
    }, { passive: false });
    c.addEventListener('dblclick', () => this.setView('all'));
  }

  // ── drawing ────────────────────────────────────────────────────────────

  requestRender(): void {
    if (this.frameReq) return;
    this.frameReq = requestAnimationFrame(() => { this.frameReq = 0; this.render(); });
  }

  private requestHover(): void {
    if (this.hoverReq) return;
    this.hoverReq = requestAnimationFrame(() => {
      this.hoverReq = 0;
      this.showReadout(this.hover ? this.pick(this.hover.x, this.hover.y) : null);
    });
  }

  /** draw now (normally on the next animation frame by itself) */
  render(): void {
    this.flush();
    const t0 = performance.now();
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.progBg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.setCamera(w, h, c.clientWidth, c.clientHeight);
    const cam = this.cam!;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    let verts = 0, tris = 0;

    gl.useProgram(this.progPart);
    const U = this.u.part;
    gl.uniformMatrix4fv(U.uProj, false, cam.proj);
    gl.uniformMatrix4fv(U.uView, false, cam.view);
    gl.uniform3f(U.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
    // the key light over the viewer's right shoulder, so the lit side faces the eye
    const key = norm([cam.x[0] * 0.5 + cam.y[0] * 0.8 + cam.z[0] * 0.6, cam.x[1] * 0.5 + cam.y[1] * 0.8 + cam.z[1] * 0.6, cam.x[2] * 0.5 + cam.y[2] * 0.8 + cam.z[2] * 0.6]);
    gl.uniform3f(U.uKey, key[0], key[1], key[2]);
    gl.uniform3f(U.uFill, -cam.x[0] * 0.7 - cam.y[0] * 0.2, -cam.x[1] * 0.7 - cam.y[1] * 0.2, -cam.x[2] * 0.7 - cam.y[2] * 0.2);
    gl.uniform1f(U.uBands, this.opts.bands);
    gl.uniform1f(U.uIso, 1);
    gl.uniform1f(U.uShade, this.opts.shading ? 1 : 0);
    gl.uniform1i(U.uRamp, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    for (const name of this.order) {
      const g = this.parts.get(name)!;
      if (!g.visible) continue;
      const grp = this.groups[g.part.kind];
      gl.bindTexture(gl.TEXTURE_2D, grp.tex);
      gl.uniform1f(U.uFloor, fieldInfo(grp.field).signed ? 0 : RAMP_FLOOR);
      gl.uniform1f(U.uStripe, grp.mode === 'fixed' ? 1 : 0);
      gl.uniform1f(U.uHasField, g.values?.fields[grp.field] ? 1 : 0);
      gl.uniform1f(U.uMetal, g.part.kind === 'roll' ? 1 : 0.25);
      gl.uniform1f(U.uScale, g.hasDisp ? this.opts.deform : 0);
      gl.bindVertexArray(g.vao);
      for (const m of this.opts.mirror ? g.mirrors : [[1, 1, 1] as V3]) {
        gl.uniform3f(U.uMirror, m[0], m[1], m[2]);
        gl.drawElements(gl.TRIANGLES, g.tris.length, gl.UNSIGNED_INT, 0);
        verts += g.src.length; tris += g.tris.length / 3;
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    if (this.opts.mesh) {
      gl.useProgram(this.progLine);
      const L = this.u.line;
      gl.uniformMatrix4fv(L.uProj, false, cam.proj);
      gl.uniformMatrix4fv(L.uView, false, cam.view);
      gl.uniform4f(L.uCol, 0.0, 0.0, 0.0, 0.3);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const name of this.order) {
        const g = this.parts.get(name)!;
        if (!g.visible || !g.lineCount) continue;
        gl.uniform1f(L.uScale, g.hasDisp ? this.opts.deform : 0);
        gl.bindVertexArray(g.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.lineIbo);
        for (const m of this.opts.mirror ? g.mirrors : [[1, 1, 1] as V3]) {
          gl.uniform3f(L.uMirror, m[0], m[1], m[2]);
          gl.drawElements(gl.LINES, g.lineCount, gl.UNSIGNED_INT, 0);
        }
        // the VAO keeps its own element buffer: put it back
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    this.stats.vertices = verts; this.stats.triangles = tris;
    this.placeMarks();
    this.stats.renderMs = performance.now() - t0;
  }

  private setCamera(w: number, h: number, cw: number, ch: number): void {
    const t = this.target, d = this.dist;
    const eye: V3 = [t[0] + d * Math.cos(this.pitch) * Math.sin(this.yaw), t[1] + d * Math.sin(this.pitch), t[2] + d * Math.cos(this.pitch) * Math.cos(this.yaw)];
    const la = lookAt(eye, t, [0, 1, 0]);
    // near and far from the scene's extent around the eye, so a close-up of the bite keeps its depth resolution
    const b = this.sceneBounds();
    let far = d * 4, near = d * 0.02;
    if (b) {
      const cx = (b.lo[0] + b.hi[0]) / 2, cy = (b.lo[1] + b.hi[1]) / 2, cz = (b.lo[2] + b.hi[2]) / 2;
      const rad = Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2;
      const de = Math.hypot(eye[0] - cx, eye[1] - cy, eye[2] - cz);
      far = de + rad * 1.05;
      near = Math.max(far * 2e-5, Math.min(d * 0.5, de - rad * 1.05));
    }
    this.cam = { eye, x: la.x, y: la.y, z: la.z, view: la.m, proj: perspective(FOV, w / h, near, far), w: cw, h: ch };
  }

  /** screen position [CSS px] of a scene point (as last drawn), null behind the eye */
  project(p: V3): { x: number; y: number } | null {
    const cam = this.cam;
    if (!cam) return null;
    const m = mul(cam.proj, cam.view);
    const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const cwv = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cwv <= 0) return null;
    return { x: ((cx / cwv) * 0.5 + 0.5) * cam.w, y: (0.5 - (cy / cwv) * 0.5) * cam.h };
  }

  /** a node's drawn position in a mirror copy */
  private nodePoint(g: GpuPart, node: number, m: V3): V3 {
    const s = g.hasDisp ? this.opts.deform : 0;
    const c = g.part.coords, d = g.values?.disp;
    const p: V3 = [c[3 * node], c[3 * node + 1], c[3 * node + 2]];
    if (d && s) { p[0] += s * d[3 * node]; p[1] += s * d[3 * node + 1]; p[2] += s * d[3 * node + 2]; }
    return [p[0] * m[0], p[1] * m[1], p[2] * m[2]];
  }

  // ── picking ────────────────────────────────────────────────────────────

  /** the body, node and value under a point of the canvas [CSS px], null over the background */
  pick(x: number, y: number): PickResult | null {
    const gl = this.gl, cam = this.cam;
    if (!cam || !this.parts.size) return null;
    const dpr = this.canvas.width / Math.max(1, cam.w);
    const W = this.canvas.width, H = this.canvas.height;
    const px = Math.floor(x * dpr), py = Math.floor(H - 1 - y * dpr);
    if (px < 0 || py < 0 || px >= W || py >= H) return null;
    if (!this.pickFbo || this.pickFbo.w !== W || this.pickFbo.h !== H) {
      if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo.fb); gl.deleteTexture(this.pickFbo.tex); gl.deleteRenderbuffer(this.pickFbo.depth); }
      const fb = gl.createFramebuffer()!, tex = gl.createTexture()!, depth = gl.createRenderbuffer()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, W, H, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      this.pickFbo = { fb, tex, depth, w: W, h: H };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo.fb);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, 1, 1);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0xffffffff, 0, 0, 0]));
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.progPick);
    const P = this.u.pick;
    gl.uniformMatrix4fv(P.uProj, false, cam.proj);
    gl.uniformMatrix4fv(P.uView, false, cam.view);
    const mirrorsOf = (g: GpuPart) => (this.opts.mirror ? g.mirrors : [[1, 1, 1] as V3]);
    for (const name of this.order) {
      const g = this.parts.get(name)!;
      if (!g.visible) continue;
      gl.uniform1f(P.uScale, g.hasDisp ? this.opts.deform : 0);
      gl.bindVertexArray(g.pickVao);
      mirrorsOf(g).forEach((m, mi) => {
        gl.uniform3f(P.uMirror, m[0], m[1], m[2]);
        gl.uniform1ui(P.uTag, ((g.index & 31) << 27) | ((mi & 7) << 24));
        gl.drawElements(gl.TRIANGLES, g.tris.length, gl.UNSIGNED_INT, 0);
      });
    }
    gl.bindVertexArray(null);
    const out = new Uint32Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const id = out[0];
    if (id === 0xffffffff) return null;
    const pi = id >>> 27, mi = (id >>> 24) & 7, vert = id & 0xffffff;
    const g = [...this.parts.values()].find((q) => q.index === pi);
    if (!g) return null;
    const m = mirrorsOf(g)[mi];
    if (!m || vert >= g.src.length) return null;
    // the ray through the pixel, in the body's own frame (a mirror is its own inverse)
    const ndx = (2 * (x + 0.5)) / cam.w - 1, ndy = 1 - (2 * (y + 0.5)) / cam.h;
    const th = Math.tan(FOV / 2), asp = cam.w / cam.h;
    const dir = norm([
      -cam.z[0] + cam.x[0] * ndx * th * asp + cam.y[0] * ndy * th,
      -cam.z[1] + cam.x[1] * ndx * th * asp + cam.y[1] * ndy * th,
      -cam.z[2] + cam.x[2] * ndx * th * asp + cam.y[2] * ndy * th,
    ]);
    const o: V3 = [cam.eye[0] * m[0], cam.eye[1] * m[1], cam.eye[2] * m[2]], dl: V3 = [dir[0] * m[0], dir[1] * m[1], dir[2] * m[2]];
    const s = g.hasDisp ? this.opts.deform : 0;
    const P3 = (v: number): V3 => [g.pos[3 * v] + s * g.disp[3 * v], g.pos[3 * v + 1] + s * g.disp[3 * v + 1], g.pos[3 * v + 2] + s * g.disp[3 * v + 2]];
    if (!g.adj) g.adj = adjacency(g.tris, g.src.length);
    let best = Infinity, bestTri = -1, bu = 0, bv = 0;
    for (let q = g.adj.start[vert]; q < g.adj.start[vert + 1]; q++) {
      const f = g.adj.tri[q];
      const a = P3(g.tris[3 * f]), b = P3(g.tris[3 * f + 1]), cc = P3(g.tris[3 * f + 2]);
      const hit = rayTri(o, dl, a, b, cc);
      if (hit && hit.t < best) { best = hit.t; bestTri = f; bu = hit.u; bv = hit.v; }
    }
    // a hit on a neighbour just outside (the pixel's centre against its footprint): the provoking vertex itself
    let vtx = vert;
    let point: V3 = P3(vert);
    if (bestTri >= 0) {
      const w0 = 1 - bu - bv;
      const cand = [[w0, g.tris[3 * bestTri]], [bu, g.tris[3 * bestTri + 1]], [bv, g.tris[3 * bestTri + 2]]].sort((p, q) => q[0] - p[0]);
      vtx = cand[0][1];
      point = [o[0] + best * dl[0], o[1] + best * dl[1], o[2] + best * dl[2]];
    }
    const node = g.src[vtx];
    const grp = this.groups[g.part.kind];
    const vals = g.values?.fields[grp.field];
    return {
      part: g.part.name, kind: g.part.kind, node, field: grp.field,
      value: vals ? vals[node] : NaN,
      point: [point[0] * m[0], point[1] * m[1], point[2] * m[2]],
    };
  }

  // ── DOM ────────────────────────────────────────────────────────────────

  private buildOverlay(): void {
    const o = this.overlay;
    this.markBox = el('div', 'ct3-marks');
    o.append(this.markBox);
    this.statusBox = el('div', 'ct3-status ct3-plate');
    o.append(this.statusBox);
    if (!this.opts.controls) { this.legendBox = el('div'); this.toolbar = el('div'); this.readout = el('div'); this.partRow = el('div'); return; }

    const right = el('div', 'ct3-right');
    const views = el('div', 'ct3-views ct3-seg');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', '視点');
    for (const p of PRESETS) {
      const b = el('button', 'ct3-btn', p.text);
      b.type = 'button'; b.dataset.view = p.id; b.title = p.title;
      b.addEventListener('click', () => this.setView(p.id));
      views.append(b);
    }
    right.append(views);
    this.legendBox = el('div', 'ct3-legends');
    right.append(this.legendBox);
    o.append(right);
    for (const k of GROUPS) this.legends.set(k, this.buildLegend(k));

    this.toolbar = el('div', 'ct3-toolbar ct3-plate');
    this.partRow = el('div', 'ct3-seg ct3-parts');
    this.partRow.setAttribute('role', 'group');
    this.partRow.setAttribute('aria-label', '表示する部品');
    this.toolbar.append(this.partRow);
    const toggle = (text: string, title: string, key: 'mesh' | 'mirror' | 'extremes' | 'shading') => {
      const b = el('button', 'ct3-btn', text);
      b.type = 'button'; b.title = title; b.dataset.opt = key;
      b.addEventListener('click', () => this.setOptions({ [key]: !this.opts[key] }));
      return b;
    };
    this.toolbar.append(
      toggle('網目', '要素の辺を描く', 'mesh'),
      toggle('鏡映', '対称面で鏡映して全周・全幅・下ロールまで描く。切ると解いた範囲だけになり、対称面の断面（ロール内部の応力）が見える', 'mirror'),
      toggle('最大値', '表示中の場の最大点（符号つきの場は最小点も）を指す', 'extremes'),
      toggle('陰影', '光を当てて形を読みやすくする。切ると各段が凡例の色そのままになる（色で値を読むとき）', 'shading'),
    );
    const sel = (label: string, title: string, items: [number, string][], get: () => number, set: (v: number) => void) => {
      const w = el('label', 'ct3-field');
      w.title = title;
      const s = el('select', 'ct3-select');
      for (const [v, t] of items) { const op = el('option', undefined, t); op.value = String(v); s.append(op); }
      s.value = String(get());
      s.addEventListener('change', () => set(Number(s.value)));
      w.append(el('span', 'ct3-field-label', label), s);
      return w;
    };
    this.toolbar.append(
      sel('色', '色の段の数（連続 = 段なし）。段の境目に等値線を引く', BAND_STEPS.map((b) => [b, b ? `${b} 段` : '連続']), () => this.opts.bands, (v) => this.setOptions({ bands: v })),
      sel('変形', '変位の倍率（ロールの変位。板は今の形そのものなので倍率によらない）', DEFORM_STEPS.map((d) => [d, `× ${d}`]), () => this.opts.deform, (v) => this.setOptions({ deform: v })),
    );
    o.append(this.toolbar);

    this.readout = el('div', 'ct3-readout ct3-plate');
    this.readout.setAttribute('aria-live', 'polite');
    o.append(this.readout);
    this.showReadout(null);
    this.syncToolbar();
  }

  private buildLegend(kind: PartKind) {
    const root = el('section', 'ct3-legend ct3-plate');
    root.dataset.group = kind;
    // shown once a body of the group is placed
    root.hidden = true;
    const head = el('div', 'ct3-legend-head');
    const body = el('span', 'ct3-legend-body', GROUP_NAME[kind]);
    const select = el('select', 'ct3-select ct3-legend-field');
    select.title = `${GROUP_NAME[kind]}を塗る場`;
    select.addEventListener('change', () => this.setField(kind, select.value));
    const ramp = el('select', 'ct3-select ct3-ramp');
    ramp.title = `${GROUP_NAME[kind]}の色図（符号つきの場は青〜赤のまま）`;
    for (const n of COLORMAP_NAMES) { const op = el('option', undefined, n); op.value = n; ramp.append(op); }
    ramp.value = this.groups[kind].ramp;
    ramp.addEventListener('change', () => this.setRamp(kind, ramp.value));
    head.append(body, select);
    const scale = el('div', 'ct3-scale');
    const bar = el('div', 'ct3-bar');
    const ticks = el('div', 'ct3-ticks');
    scale.append(bar, ticks);
    const foot = el('div', 'ct3-legend-foot');
    const unit = el('span', 'ct3-unit');
    const mode = el('select', 'ct3-select ct3-mode');
    mode.title = '色の範囲: 自動は最小〜99.5 % 点（一点の集中に引っぱられない）、最小〜最大は全部、固定は下の値';
    for (const [v, t] of [['auto', '自動'], ['full', '最小〜最大'], ['fixed', '固定']] as const) { const op = el('option', undefined, t); op.value = v; mode.append(op); }
    const lo = el('input', 'ct3-num'), hi = el('input', 'ct3-num');
    for (const [inp, t] of [[lo, '下端'], [hi, '上端']] as const) { inp.type = 'number'; inp.step = 'any'; inp.title = `固定の範囲の${t}（表示の単位で）`; inp.setAttribute('aria-label', `${GROUP_NAME[kind]} ${t}`); }
    const applyFixed = () => {
      const info = fieldInfo(this.groups[kind].field);
      const a = Number(lo.value) / info.scale, b = Number(hi.value) / info.scale;
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) this.setRange(kind, 'fixed', { lo: a, hi: b });
    };
    mode.addEventListener('change', () => {
      const grp = this.groups[kind];
      if (mode.value === 'fixed') {
        // start the fixed range from what is shown now
        const info = fieldInfo(grp.field);
        lo.value = String(+(grp.range.lo * info.scale).toPrecision(4)); hi.value = String(+(grp.range.hi * info.scale).toPrecision(4));
        applyFixed();
      } else this.setRange(kind, mode.value as RangeMode);
    });
    lo.addEventListener('change', applyFixed);
    hi.addEventListener('change', applyFixed);
    const fixedRow = el('span', 'ct3-fixed');
    fixedRow.append(lo, el('span', 'ct3-dash', '〜'), hi);
    foot.append(unit, ramp, mode, fixedRow);
    const note = el('div', 'ct3-note');
    root.append(head, scale, foot, note);
    this.legendBox.append(root);
    return { root, select, ramp, scale, bar, ticks, note, mode, lo, hi, unit, body };
  }

  private drawLegend(kind: PartKind): void {
    const L = this.legends.get(kind);
    if (!L) return;
    const grp = this.groups[kind];
    const members = this.order.map((n) => this.parts.get(n)!).filter((g) => g.part.kind === kind);
    L.root.hidden = members.length === 0;
    if (!members.length) return;
    // the fields any body has, the known ones first
    const names = new Set<string>();
    for (const g of this.parts.values()) for (const n of Object.keys(g.values?.fields ?? {})) names.add(n);
    names.add(grp.field);
    const list = [...FIELD_ORDER.filter((n) => names.has(n)), ...[...names].filter((n) => !FIELD_ORDER.includes(n)).sort()];
    const want = list.join(',');
    if (L.select.dataset.list !== want) {
      L.select.replaceChildren(...list.map((n) => { const op = el('option', undefined, fieldInfo(n).label); op.value = n; return op; }));
      L.select.dataset.list = want;
    }
    L.select.value = grp.field;
    const info = fieldInfo(grp.field);
    L.ramp.value = info.signed ? SIGNED_RAMP : grp.ramp;
    L.ramp.disabled = info.signed;
    const ramp = this.rampOf(kind);
    const floor = info.signed ? 0 : RAMP_FLOOR;
    const bands = this.opts.bands;
    // the bar, bottom up, from the same band centres the shader reads
    const stops: string[] = [];
    if (bands > 0) {
      for (let b = 0; b < bands; b++) {
        const col = rampCss(ramp, rampCoord(bandCentre(b, bands), floor));
        stops.push(`${col} ${((100 * b) / bands).toFixed(2)}%`, `${col} ${((100 * (b + 1)) / bands).toFixed(2)}%`);
      }
    } else {
      for (let i = 0; i <= 16; i++) stops.push(`${rampCss(ramp, rampCoord(i / 16, floor))} ${((100 * i) / 16).toFixed(1)}%`);
    }
    L.bar.style.background = `linear-gradient(to top, ${stops.join(', ')})`;
    const has = members.some((g) => g.visible && g.values?.fields[grp.field]);
    L.root.classList.toggle('is-empty', !has);
    const unitText = info.unit ? info.unit : '無次元';
    L.unit.textContent = unitText;
    const r = grp.range;
    const nT = bands > 0 ? bands : 4;
    // a label every 13 px at least: a short bar (a small stage) labels every other edge or fewer
    const px = L.scale.clientHeight || 190;
    const every = Math.max(bands > 12 ? 2 : 1, Math.ceil(nT / Math.max(1, Math.floor(px / 13))));
    L.ticks.replaceChildren();
    if (has && !r.uniform) {
      // a label at every band edge (every other one on a tall stack), the top always
      const at: number[] = [];
      for (let i = 0; i <= nT; i += every) at.push(i);
      if (at[at.length - 1] !== nT) at.push(nT);
      for (const i of at) {
        let v = r.lo + ((r.hi - r.lo) * i) / nT;
        // a float's leftover at the bottom of a stress range (1.9e-12 Pa) reads as 0
        if (Math.abs(v) < 1e-6 * (r.hi - r.lo)) v = 0;
        const t = el('span', 'ct3-tick', fmt(v * info.scale));
        t.style.bottom = `${(100 * i) / nT}%`;
        L.ticks.append(t);
      }
    } else {
      // one value everywhere: the label beside the band it is drawn in (the bottom one, the middle for a signed field)
      const t = el('span', 'ct3-tick ct3-tick-mid', has ? `一様 ${fmt((info.signed ? 0 : r.lo) * info.scale)}` : 'この場は無い');
      const at = !has ? 0.5 : info.signed ? 0.5 : bands > 0 ? 0.5 / bands : 0.02;
      t.style.bottom = `${100 * at}%`;
      L.ticks.append(t);
    }
    L.root.classList.toggle('is-uniform', has && r.uniform);
    L.mode.value = grp.mode;
    L.root.classList.toggle('is-fixed', grp.mode === 'fixed');
    if (grp.mode === 'fixed') {
      for (const [inp, v] of [[L.lo, r.lo], [L.hi, r.hi]] as const) if (document.activeElement !== inp) inp.value = String(+(v * info.scale).toPrecision(4));
    }
    // what the bar does not show
    const notes: string[] = [];
    const missingBodies = members.filter((g) => g.visible && !g.values?.fields[grp.field]).map((g) => bodyName(g.part.name));
    if (missingBodies.length && has) notes.push(`${missingBodies.join('・')} にこの場は無い（斜線）`);
    if (!has && members.length) notes.push(`${members.map((g) => bodyName(g.part.name)).join('・')} にこの場は無い（斜線の灰色）`);
    const c = grp.counts;
    if (has && c.total) {
      const pct = (n: number) => (100 * n / (c.total - c.missing || 1));
      const nb = (t: string) => t.replace(/ /g, '\u00a0');
      if (grp.mode === 'auto' && c.above > 0 && grp.full.hi > r.hi) notes.push(`上端は 99.5\u00a0% 点。${nb(`超える ${pct(c.above).toFixed(1)} %`)}、${nb(`最大 ${fmt(grp.full.hi * info.scale)}${info.unit ? ` ${info.unit}` : ''}`)}`);
      else if (grp.mode === 'fixed' && (c.above || c.below)) notes.push(`範囲外 ${pct(c.above + c.below).toFixed(1)} %（縞）`);
      if (info.signed) notes.push('青 圧縮／赤 引張');
    }
    L.note.textContent = notes.join('。');
    L.note.hidden = notes.length === 0;
    L.root.classList.toggle('has-over', grp.mode !== 'full' && c.above > 0);
    L.root.classList.toggle('has-under', grp.mode === 'fixed' && c.below > 0);
  }

  private drawStatus(): void {
    const rows: { name: string; src: string; state: LabelState; text: string }[] = [];
    for (const k of ['strip', 'roll'] as PartKind[]) {
      if (![...this.parts.values()].some((g) => g.part.kind === k)) continue;
      const lab = this.groups[k].label;
      const state: LabelState = lab?.state ?? 'initial';
      rows.push({ name: GROUP_NAME[k], src: this.opts.sources[k], state, text: lab?.text ?? (state === 'initial' ? '計算前' : '') });
    }
    const all = (s: LabelState) => rows.length > 0 && rows.every((r) => r.state === s);
    const head = all('initial') ? '初期状態' : all('steady') ? '定常' : rows.some((r) => r.state === 'running') ? '計算中' : rows.some((r) => r.state === 'stale') ? '古い値あり' : '計算中';
    const overall = all('initial') ? 'initial' : all('steady') ? 'steady' : rows.some((r) => r.state === 'running') ? 'running' : 'stale';
    const box = this.statusBox;
    box.hidden = rows.length === 0;
    box.dataset.state = overall;
    const h = el('div', 'ct3-status-head');
    h.append(el('span', 'ct3-dot'), el('span', 'ct3-status-title', head));
    if (overall === 'initial') h.append(el('span', 'ct3-status-sub', '計算前の形と値'));
    const table = el('table', 'ct3-status-rows');
    for (const r of rows) {
      const tr = el('tr');
      tr.dataset.state = r.state;
      const stateText = { initial: '計算前', running: '計算中', steady: '定常', stale: '古い値' }[r.state];
      tr.append(el('th', undefined, r.name), el('td', 'ct3-src', r.src), el('td', 'ct3-state', stateText), el('td', 'ct3-text', r.text === stateText ? '' : r.text));
      table.append(tr);
    }
    box.replaceChildren(h, table);
  }

  private syncToolbar(): void {
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-opt]')) {
      const on = !!this.opts[b.dataset.opt as 'mesh' | 'mirror' | 'extremes' | 'shading'];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const sels = this.toolbar.querySelectorAll<HTMLSelectElement>('select');
    if (sels[0]) sels[0].value = String(this.opts.bands);
    if (sels[1]) sels[1].value = String(this.opts.deform);
  }

  private syncPartButtons(): void {
    if (!this.opts.controls) return;
    for (const name of this.order) {
      let b = this.partButtons.get(name);
      if (!b) {
        b = el('button', 'ct3-btn', bodyName(name));
        b.type = 'button';
        b.title = `${bodyName(name)} を表示する／隠す`;
        b.addEventListener('click', () => this.setPartVisible(name, !this.parts.get(name)?.visible));
        this.partButtons.set(name, b);
        this.partRow.append(b);
      }
      const on = !!this.parts.get(name)?.visible;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const [name, b] of this.partButtons) if (!this.parts.has(name)) { b.remove(); this.partButtons.delete(name); }
  }

  private syncViewButtons(v: ViewPreset | null): void {
    for (const b of this.overlay.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      b.classList.toggle('is-on', b.dataset.view === v);
      b.setAttribute('aria-pressed', String(b.dataset.view === v));
    }
  }

  private showReadout(p: PickResult | null): void {
    if (!this.opts.controls) return;
    const r = this.readout;
    if (!p) {
      r.classList.add('is-idle');
      r.replaceChildren(el('span', 'ct3-hint', 'ポインタを当てると値を読む'));
      return;
    }
    r.classList.remove('is-idle');
    const info = fieldInfo(p.field);
    const v = Number.isFinite(p.value) ? `${fmt(p.value * info.scale)}${info.unit ? ` ${info.unit}` : ''}` : 'この場は無い';
    const pos = `x ${(p.point[0] * 1e3).toFixed(1)}　y ${(p.point[1] * 1e3).toFixed(2)}　z ${(p.point[2] * 1e3).toFixed(2)} mm`;
    r.replaceChildren(
      el('span', 'ct3-read-part', bodyName(p.part)),
      el('span', 'ct3-read-node', `節点 ${p.node}`),
      el('span', 'ct3-read-field', info.label),
      el('strong', 'ct3-read-value', v),
      el('span', 'ct3-read-pos', pos),
    );
  }

  /** the extremes' markers: a ring on the point, a short leader, the number */
  private placeMarks(): void {
    const want: { at: { x: number; y: number }; text: string; kind: PartKind; low: boolean }[] = [];
    if (this.opts.extremes && this.cam) {
      for (const k of GROUPS) {
        const grp = this.groups[k];
        const info = fieldInfo(grp.field);
        const ext = info.signed ? [grp.top, grp.bottom] : [grp.top];
        for (const [i, e] of ext.entries()) {
          if (!e) continue;
          const g = this.parts.get(e.part);
          if (!g || !g.visible) continue;
          if (grp.range.uniform) continue;
          // the copy nearest the eye
          let best: V3 | null = null, bd = Infinity;
          for (const m of this.opts.mirror ? g.mirrors : [[1, 1, 1] as V3]) {
            const p = this.nodePoint(g, e.node, m);
            const d = Math.hypot(p[0] - this.cam.eye[0], p[1] - this.cam.eye[1], p[2] - this.cam.eye[2]);
            if (d < bd) { bd = d; best = p; }
          }
          const s = best && this.project(best);
          if (!s || s.x < 0 || s.y < 0 || s.x > this.cam.w || s.y > this.cam.h) continue;
          const body = bodyName(e.part);
          const word = info.signed ? (i === 0 ? '最大（引張）' : '最小（圧縮）') : '最大';
          want.push({ at: s, text: `${body} ${word} ${fmt(e.value * info.scale)}${info.unit ? ` ${info.unit}` : ''}`, kind: k, low: i === 1 });
        }
      }
    }
    while (this.marks.length < want.length) {
      const m = el('div', 'ct3-mark');
      m.append(el('span', 'ct3-mark-ring'), el('span', 'ct3-mark-lead'), el('span', 'ct3-mark-text'));
      this.markBox.append(m);
      this.marks.push(m);
    }
    this.marks.forEach((m, i) => {
      const w = want[i];
      if (!w) { m.hidden = true; return; }
      m.hidden = false;
      m.dataset.group = w.kind;
      // the label leans away from the nearer vertical edge so it stays on the canvas
      const cam = this.cam!;
      const left = w.at.x > cam.w - 220;
      const up = w.at.y > 70;
      m.classList.toggle('to-left', left);
      m.classList.toggle('to-down', !up);
      m.style.transform = `translate(${w.at.x.toFixed(1)}px, ${w.at.y.toFixed(1)}px)`;
      const t = m.querySelector('.ct3-mark-text')!;
      if (t.textContent !== w.text) t.textContent = w.text;
    });
  }

  /** stop listening and let go of the GPU objects and the DOM */
  destroy(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.frameReq);
    cancelAnimationFrame(this.hoverReq);
    for (const g of this.parts.values()) this.dropGpu(g);
    this.parts.clear();
    const gl = this.gl;
    for (const k of GROUPS) gl.deleteTexture(this.groups[k].tex);
    for (const p of [this.progBg, this.progPart, this.progLine, this.progPick]) gl.deleteProgram(p);
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo.fb); gl.deleteTexture(this.pickFbo.tex); gl.deleteRenderbuffer(this.pickFbo.depth); this.pickFbo = null; }
    this.canvas.remove();
    this.overlay.remove();
    this.host.classList.remove('ct3');
  }
}

function valuesFit(v: FieldValues, nodes: number): boolean {
  if (v.disp && v.disp.length !== 3 * nodes) return false;
  for (const a of Object.values(v.fields)) if (a.length !== nodes) return false;
  return true;
}

function sameArray(a: Uint32Array, b: Uint32Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function adjacency(tris: Uint32Array, nv: number): { start: Uint32Array; tri: Uint32Array } {
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < tris.length; i++) start[tris[i] + 1]++;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nv), tri = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) tri[fill[tris[i]]++] = (i / 3) | 0;
  return { start, tri };
}

/** Möller–Trumbore: the ray's parameter and the barycentric (u, v) of b and c, or null */
function rayTri(o: V3, d: V3, a: V3, b: V3, c: V3): { t: number; u: number; v: number } | null {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-30) return null;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  // a little slack: the pixel's centre may fall just past the edge of the provoking vertex's triangles
  if (u < -0.02 || u > 1.02) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < -0.02 || u + v > 1.02) return null;
  const t = dot(e2, q) * inv;
  return t > 0 ? { t, u: Math.max(0, u), v: Math.max(0, v) } : null;
}

/**
 * The fieldframe format on the page: the parts the contour view draws, and their values.
 *
 * Two sources feed it at their own pace. The strip comes from the app's material FEM in the
 * browser (`StripField3D`, a new shape and new values every solve); the rolls from a FrontISTR
 * job on the bridge (tools/frontistr/fieldframe.mjs writes them; fistrjob.ts fetches the
 * buffers), a surface once and a frame per substep. Both end up as a `FieldPart` placed once
 * (again when its shape changes) and `FieldValues` swapped in as they come.
 *
 * The binary layout (little-endian, SI units):
 *
 *   mesh.bin:  u32 headerBytes, header JSON, 0-3 zero bytes to a 4-byte boundary,
 *              f32 coords[3·nodeCount], u32 tris[3·triCount]
 *   frame:     u32 headerBytes, header JSON, padding, f32 disp[3·nodeCount], then one
 *              f32[nodeCount] per name in header.fields
 *
 * A buffer that does not add up is refused with the reason (`FieldFrameError`), not read as
 * whatever its bytes happen to say: a frame from another mesh, a truncated download, an
 * index outside its part.
 */

export type PartKind = 'strip' | 'roll';

/** mirror planes through the origin: x = 0 (the width's centre), y = 0 (the pass line), z = 0 (the plane of the roll axes) */
export interface Symmetry {
  x: boolean;
  y: boolean;
  z?: boolean;
}

export interface FieldPart {
  /** 'strip' | 'WR' | 'BUR' */
  name: string;
  kind: PartKind;
  /** 3 × nodes, the initial (or, for the strip, the current) coordinates [m] */
  coords: Float32Array;
  /** triangles over this part's own nodes (0-based), counter-clockwise seen from outside */
  tris: Uint32Array;
  symmetry: Symmetry;
}

export type LabelState = 'initial' | 'running' | 'steady' | 'stale';

export interface FieldValues {
  /** 3 × nodes from `coords`; null when the coordinates are already the current shape */
  disp: Float32Array | null;
  /** nodal values by name; NaN where the part has none */
  fields: Record<string, Float32Array>;
  label: { state: LabelState; text?: string };
}

export interface MeshPartHeader {
  name: string;
  kind: PartKind;
  nodeStart: number;
  nodeCount: number;
  triStart: number;
  triCount: number;
}

export interface MeshHeader {
  format: 'fieldframe-mesh/1';
  nodeCount: number;
  triCount: number;
  parts: MeshPartHeader[];
  symmetry: Symmetry;
  source?: Record<string, unknown>;
}

export interface FrameHeader {
  format: 'fieldframe/1';
  k: number;
  increment?: number;
  time?: number;
  /** distance rolled since the bite closed [m] */
  travel?: number;
  fields: string[];
  metrics?: Record<string, unknown>;
}

export interface DecodedMesh {
  header: MeshHeader;
  /** coordinates of all nodes, and triangles with the file's global node numbers */
  coords: Float32Array;
  tris: Uint32Array;
  /** the parts cut out, each with its own node numbering (views, not copies, where the numbering allows) */
  parts: FieldPart[];
}

export interface DecodedFrame {
  header: FrameHeader;
  disp: Float32Array;
  fields: Record<string, Float32Array>;
}

export class FieldFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldFrameError';
  }
}

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** header JSON and where the arrays start, with the checks every buffer gets */
function readHead(buf: ArrayBuffer, what: string): { json: Record<string, unknown>; start: number } {
  if (!(buf instanceof ArrayBuffer)) throw new FieldFrameError(`${what}: ArrayBuffer ではない`);
  if (buf.byteLength < 4) throw new FieldFrameError(`${what}: ${buf.byteLength} バイトしかない（見出しの長さの 4 バイトが無い）`);
  const len = new DataView(buf).getUint32(0, true);
  if (4 + len > buf.byteLength) throw new FieldFrameError(`${what}: 見出しの長さ ${len} バイトが全体 ${buf.byteLength} バイトを超える`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buf, 4, len)));
  } catch (e) {
    throw new FieldFrameError(`${what}: 見出しの JSON が読めない（${(e as Error).message}）`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new FieldFrameError(`${what}: 見出しがオブジェクトでない`);
  const start = 4 + len + ((4 - ((4 + len) % 4)) % 4);
  // the padding is zeros; anything else means the arrays were not written where we are about to read them
  const pad = new Uint8Array(buf, 4 + len, Math.min(start, buf.byteLength) - 4 - len);
  if (pad.some((b) => b !== 0)) throw new FieldFrameError(`${what}: 見出しの後の詰め物が 0 でない（配列の位置がずれている）`);
  return { json: json as Record<string, unknown>, start };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function f32(buf: ArrayBuffer, offset: number, n: number): Float32Array {
  if (LITTLE) return new Float32Array(buf, offset, n);
  const dv = new DataView(buf), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(offset + 4 * i, true);
  return out;
}

function u32(buf: ArrayBuffer, offset: number, n: number): Uint32Array {
  if (LITTLE) return new Uint32Array(buf, offset, n);
  const dv = new DataView(buf), out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(offset + 4 * i, true);
  return out;
}

function readSymmetry(v: unknown, what: string): Symmetry {
  if (v === undefined) return { x: false, y: false, z: false };
  if (!v || typeof v !== 'object') throw new FieldFrameError(`${what}: symmetry がオブジェクトでない`);
  const s = v as Record<string, unknown>;
  for (const k of ['x', 'y', 'z']) {
    if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new FieldFrameError(`${what}: symmetry.${k} が真偽値でない`);
  }
  return { x: s.x === true, y: s.y === true, z: s.z === true };
}

/** mesh.bin → the parts, each with its own node numbering */
export function decodeMesh(buf: ArrayBuffer): DecodedMesh {
  const { json, start } = readHead(buf, 'mesh');
  if (json.format !== 'fieldframe-mesh/1') throw new FieldFrameError(`mesh: 形式が ${JSON.stringify(json.format)}（fieldframe-mesh/1 を期待）`);
  const { nodeCount, triCount } = json;
  if (!isCount(nodeCount) || !isCount(triCount)) throw new FieldFrameError('mesh: nodeCount・triCount が 0 以上の整数でない');
  const want = start + 12 * nodeCount + 12 * triCount;
  if (buf.byteLength !== want) {
    throw new FieldFrameError(`mesh: 長さが ${buf.byteLength} バイト（見出しの節点 ${nodeCount}・三角形 ${triCount} なら ${want}）`);
  }
  if (!Array.isArray(json.parts) || json.parts.length === 0) throw new FieldFrameError('mesh: parts が無い');
  const symmetry = readSymmetry(json.symmetry, 'mesh');
  const coords = f32(buf, start, 3 * nodeCount);
  const tris = u32(buf, start + 12 * nodeCount, 3 * triCount);

  const heads: MeshPartHeader[] = [];
  const parts: FieldPart[] = [];
  let nodeEnd = 0, triEnd = 0;
  for (const [i, raw] of (json.parts as unknown[]).entries()) {
    const p = raw as Record<string, unknown>;
    const at = `mesh: parts[${i}]`;
    if (!p || typeof p.name !== 'string' || !p.name) throw new FieldFrameError(`${at}: name が無い`);
    if (p.kind !== 'strip' && p.kind !== 'roll') throw new FieldFrameError(`${at} (${p.name}): kind が ${JSON.stringify(p.kind)}（strip か roll）`);
    const { nodeStart, triStart } = p;
    const nc = p.nodeCount, tc = p.triCount;
    if (!isCount(nodeStart) || !isCount(nc) || !isCount(triStart) || !isCount(tc)) throw new FieldFrameError(`${at} (${p.name}): 区間が 0 以上の整数でない`);
    // the parts follow one another: each starts where the one before ended
    if (nodeStart !== nodeEnd || triStart !== triEnd) {
      throw new FieldFrameError(`${at} (${p.name}): 節点 ${nodeStart}・三角形 ${triStart} から始まる（前の部品の終わりは ${nodeEnd}・${triEnd}）`);
    }
    nodeEnd = nodeStart + nc; triEnd = triStart + tc;
    if (nodeEnd > nodeCount || triEnd > triCount) throw new FieldFrameError(`${at} (${p.name}): 区間が全体（節点 ${nodeCount}・三角形 ${triCount}）を超える`);
    const local = new Uint32Array(3 * tc);
    for (let t = 0; t < 3 * tc; t++) {
      const g = tris[3 * triStart + t];
      if (g < nodeStart || g >= nodeEnd) {
        throw new FieldFrameError(`${at} (${p.name}): 三角形 ${triStart + Math.floor(t / 3)} の節点 ${g} が部品の節点 ${nodeStart}〜${nodeEnd - 1} の外`);
      }
      local[t] = g - nodeStart;
    }
    heads.push({ name: p.name, kind: p.kind, nodeStart, nodeCount: nc, triStart, triCount: tc });
    parts.push({ name: p.name, kind: p.kind, coords: coords.subarray(3 * nodeStart, 3 * nodeEnd), tris: local, symmetry });
  }
  if (nodeEnd !== nodeCount || triEnd !== triCount) {
    throw new FieldFrameError(`mesh: 部品が節点 ${nodeEnd}・三角形 ${triEnd} までしか覆わない（全体は ${nodeCount}・${triCount}）`);
  }
  const names = new Set(heads.map((h) => h.name));
  if (names.size !== heads.length) throw new FieldFrameError('mesh: 部品の名前が重なっている');
  return {
    header: { format: 'fieldframe-mesh/1', nodeCount, triCount, parts: heads, symmetry, source: json.source as Record<string, unknown> | undefined },
    coords, tris, parts,
  };
}

/** frames/<k>.bin of a mesh with `nodeCount` nodes → displacement and fields over all nodes */
export function decodeFrame(buf: ArrayBuffer, nodeCount: number): DecodedFrame {
  const { json, start } = readHead(buf, 'frame');
  if (json.format !== 'fieldframe/1') throw new FieldFrameError(`frame: 形式が ${JSON.stringify(json.format)}（fieldframe/1 を期待）`);
  if (!isCount(json.k)) throw new FieldFrameError('frame: k が 0 以上の整数でない');
  const names = json.fields;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !n)) throw new FieldFrameError('frame: fields が名前の配列でない');
  if (new Set(names).size !== names.length) throw new FieldFrameError('frame: fields の名前が重なっている');
  const want = start + 4 * nodeCount * (3 + names.length);
  if (buf.byteLength !== want) {
    throw new FieldFrameError(`frame ${json.k}: 長さが ${buf.byteLength} バイト（節点 ${nodeCount}・場 ${names.length} なら ${want}。別の mesh の frame か、途中で切れた）`);
  }
  for (const k of ['increment', 'time', 'travel'] as const) {
    if (json[k] !== undefined && typeof json[k] !== 'number') throw new FieldFrameError(`frame ${json.k}: ${k} が数でない`);
  }
  const disp = f32(buf, start, 3 * nodeCount);
  const fields: Record<string, Float32Array> = {};
  let o = start + 12 * nodeCount;
  for (const n of names as string[]) { fields[n] = f32(buf, o, nodeCount); o += 4 * nodeCount; }
  const metrics = json.metrics && typeof json.metrics === 'object' && !Array.isArray(json.metrics) ? (json.metrics as Record<string, unknown>) : undefined;
  return {
    header: {
      format: 'fieldframe/1', k: json.k, fields: names as string[], metrics,
      increment: json.increment as number | undefined, time: json.time as number | undefined, travel: json.travel as number | undefined,
    },
    disp, fields,
  };
}

/** the headline of a FrontISTR frame for the status plate */
export function frameLabel(h: FrameHeader): FieldValues['label'] {
  const steady = h.metrics?.steady === true;
  if (h.k === 0) return { state: 'initial', text: '計算前' };
  const parts = [`増分 ${h.increment ?? h.k}`];
  if (typeof h.travel === 'number' && h.travel > 0) parts.push(`進んだ距離 ${(h.travel * 1e3).toFixed(1)} mm`);
  return { state: steady ? 'steady' : 'running', text: parts.join('　') };
}

/** one part's share of a decoded frame (views into the frame's arrays, no copies) */
export function partValues(mesh: DecodedMesh, frame: DecodedFrame, name: string): FieldValues {
  const h = mesh.header.parts.find((p) => p.name === name);
  if (!h) throw new FieldFrameError(`frame: 部品 ${name} は mesh に無い`);
  const a = h.nodeStart, b = a + h.nodeCount;
  const fields: Record<string, Float32Array> = {};
  for (const [n, v] of Object.entries(frame.fields)) fields[n] = v.subarray(a, b);
  return { disp: frame.disp.subarray(3 * a, 3 * b), fields, label: frameLabel(frame.header) };
}

/**
 * The parts' buffers written the way the bridge writes them (for the demo and the checks:
 * the synthetic data goes through the same decoding as FrontISTR's).
 */
export function encodeMesh(parts: FieldPart[], symmetry: Symmetry, source: Record<string, unknown> = {}): ArrayBuffer {
  let nodes = 0, tris = 0;
  const heads = parts.map((p) => {
    const h = { name: p.name, kind: p.kind, nodeStart: nodes, nodeCount: p.coords.length / 3, triStart: tris, triCount: p.tris.length / 3 };
    nodes += h.nodeCount; tris += h.triCount;
    return h;
  });
  const coords = new Float32Array(3 * nodes), all = new Uint32Array(3 * tris);
  parts.forEach((p, i) => {
    coords.set(p.coords, 3 * heads[i].nodeStart);
    for (let t = 0; t < p.tris.length; t++) all[3 * heads[i].triStart + t] = p.tris[t] + heads[i].nodeStart;
  });
  return pack({ format: 'fieldframe-mesh/1', nodeCount: nodes, triCount: tris, parts: heads, symmetry, source }, [coords, all]);
}

/** one frame over all the mesh's nodes (the parts' values laid end to end) */
export function encodeFrame(header: Omit<FrameHeader, 'format' | 'fields'>, disp: Float32Array, fields: Record<string, Float32Array>): ArrayBuffer {
  const names = Object.keys(fields);
  // the bridge's key order and defaults, so the two writers make the same bytes
  const h = { format: 'fieldframe/1', k: header.k, increment: header.increment ?? header.k, time: header.time ?? 0, travel: header.travel ?? 0, fields: names, metrics: header.metrics ?? {} };
  return pack(h, [disp, ...names.map((n) => fields[n])]);
}

function pack(header: object, arrays: (Float32Array | Uint32Array)[]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = 4 + json.length;
  const pad = (4 - (head % 4)) % 4;
  const size = head + pad + arrays.reduce((s, a) => s + a.byteLength, 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, json.length, true);
  new Uint8Array(buf, 4, json.length).set(json);
  let o = head + pad;
  for (const a of arrays) {
    if (a instanceof Float32Array) for (let i = 0; i < a.length; i++, o += 4) dv.setFloat32(o, a[i], true);
    else for (let i = 0; i < a.length; i++, o += 4) dv.setUint32(o, a[i], true);
  }
  return buf;
}

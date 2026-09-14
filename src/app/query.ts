/**
 * The query string, read into a plain object.
 *
 * Every measurement recipe in the docs starts from a URL, so what a parameter
 * does has to be something a test can pin down without a browser. This file
 * only reads: it takes the string and the names each list accepts, and hands
 * back what was asked for and valid. Writing it into the app's state is
 * `main.ts`'s job - and the order that happens in (after a settings file has
 * been restored, so the URL wins) is decided there.
 *
 * No imports, so the node checks under tools/app can build it on its own.
 */

/** The names a parameter may take where the list lives elsewhere in the app. */
export interface QueryVocabulary {
  /** scalar fields (`?field=`) */
  fields: readonly string[];
  /** colour maps (`?cmap=`) */
  colormaps: readonly string[];
  /** mesh presets (`?mesh=`) */
  meshes: readonly string[];
  /** 3D mill types (`?mill=`, matched lower-cased) */
  mills: readonly string[];
}

export interface QueryOverrides {
  /** `?debug`: `window.__lab` and the frame breakdown in the title */
  debug: boolean;
  nowire: boolean;
  notrace: boolean;
  nomirror: boolean;
  nosolve: boolean;
  nogrid: boolean;
  field?: string;
  cmap?: string;
  mesh?: string;
  agc?: 'off' | 'ratio' | 'gauge' | 'force';
  tension?: 'off' | 'rigid' | 'simple' | 'dist';
  tctl?: boolean;
  /** tension time scale, (0, 1] */
  tscale?: number;
  /** exit gauge target of the first stand [m] (the URL gives mm) */
  h1?: number;
  mode?: 'tandem' | 'reverse';
  loadmodel?: 'fem' | 'slab';
  slab?: 'karman' | 'orowan' | 'blandford';
  flat?: 'hitchcock' | 'roberts';
  /** stand count, rounded, 1..maxStands */
  stands?: number;
  /** total load target [tonf] */
  load?: number;
  /** 3D mill type, lower-cased */
  mill?: string;
  /**
   * `?tab=` as given, or null when absent. Only '3d' opens the 3D tab; any
   * other value, '2d' included, forces the 2D tab over the remembered one
   * (see `startIn3d`).
   */
  tab: string | null;
}

/** Membership by value, never by property lookup: `'constructor' in {}` is true. */
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

export function parseQuery(
  search: string | URLSearchParams, vocab: QueryVocabulary, maxStands: number,
): QueryOverrides {
  const qs = typeof search === 'string' ? new URLSearchParams(search) : search;
  const num = (key: string) => Number(qs.get(key));
  const out: QueryOverrides = {
    debug: qs.has('debug'),
    nowire: qs.has('nowire'),
    notrace: qs.has('notrace'),
    nomirror: qs.has('nomirror'),
    nosolve: qs.has('nosolve'),
    nogrid: qs.has('nogrid'),
    tab: qs.get('tab'),
  };
  const field = oneOf(qs.get('field'), vocab.fields);
  if (field) out.field = field;
  const cmap = oneOf(qs.get('cmap'), vocab.colormaps);
  if (cmap) out.cmap = cmap;
  const mesh = oneOf(qs.get('mesh'), vocab.meshes);
  if (mesh) out.mesh = mesh;
  const agc = oneOf(qs.get('agc'), ['off', 'ratio', 'gauge', 'force'] as const);
  if (agc) out.agc = agc;
  const tension = oneOf(qs.get('tension'), ['off', 'rigid', 'simple', 'dist'] as const);
  if (tension) out.tension = tension;
  const tctl = qs.get('tctl');
  if (tctl === '1' || tctl === '0') out.tctl = tctl === '1';
  const tscale = num('tscale');
  if (Number.isFinite(tscale) && tscale > 0 && tscale <= 1) out.tscale = tscale;
  const h1 = num('h1');
  if (Number.isFinite(h1) && h1 > 0) out.h1 = h1 / 1000;
  const mode = oneOf(qs.get('mode'), ['tandem', 'reverse'] as const);
  if (mode) out.mode = mode;
  const loadmodel = oneOf(qs.get('loadmodel'), ['fem', 'slab'] as const);
  if (loadmodel) out.loadmodel = loadmodel;
  const slab = oneOf(qs.get('slab'), ['karman', 'orowan', 'blandford'] as const);
  if (slab) out.slab = slab;
  const flat = oneOf(qs.get('flat'), ['hitchcock', 'roberts'] as const);
  if (flat) out.flat = flat;
  const stands = num('stands');
  if (Number.isFinite(stands) && stands >= 1) out.stands = Math.min(maxStands, Math.round(stands));
  const load = num('load');
  if (Number.isFinite(load) && load > 0) out.load = load;
  const mill = oneOf((qs.get('mill') ?? '').toLowerCase(), vocab.mills);
  if (mill) out.mill = mill;
  return out;
}

/**
 * Which tab to open: `?tab=3d`, or no `tab` at all and 3D remembered from the
 * last visit. Any other `tab` value opens 2D whatever was remembered.
 */
export function startIn3d(tab: string | null, remembered: string | null): boolean {
  return tab === '3d' || (tab === null && remembered === '3d');
}

/**
 * Exit gauge targets down the line when the first stand's is set to `h1`:
 * each stand after it takes its own reduction from the one before, which is
 * the same rule the default schedule is seeded by (h0 (1 - r)^(k+1) is this
 * with h1 = h0 (1 - r)). A downstream target is therefore never thicker than
 * the gauge it is handed.
 */
export function gaugeSchedule(h1: number, reductions: readonly number[]): number[] {
  const out: number[] = [];
  let h = h1;
  reductions.forEach((r, k) => {
    if (k > 0) h *= 1 - r;
    out.push(h);
  });
  return out;
}

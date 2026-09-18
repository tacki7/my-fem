/**
 * The FrontISTR cross-check from the app: the converged pass's strip load, put on the upper
 * half's rolls as solids and solved by fistr1 through the dev server's bridge
 * (tools/frontistr/bridge.mjs). The bridge is on the page's own origin under `/__frontistr`
 * with `npm run dev`; `?fistr=http://host:port` names a stand-alone one (serve.mjs).
 */
import type { Params3D, MillType } from '../sim3d/stack';

/** the largest difference over the stations, and it against the model's largest value */
export interface Worst { abs: number; rel: number }

/** lib.mjs `compareStack`, plus what the bridge adds; lengths in m, loads in N/m */
export interface FistrResult {
  mill: MillType;
  /** the case spans the whole roll length (a 6Hi); otherwise the x ≥ 0 half, to mirror */
  full: boolean;
  /** the work roll's stations */
  x: number[];
  q: (number | null)[];
  /** every roll of the upper half, bottom up: its axis against the held bearing */
  rolls: { id: string; x: number[]; shift: number; Lb: number; vModel: (number | null)[]; vFem: number[]; worst: Worst }[];
  /** every contact, lower roll first: the line load, on the lower roll's stations */
  contacts: { a: number; b: number; label: string; x: number[]; qModel: (number | null)[]; qFem: (number | null)[]; worst: Worst }[];
  /** the indentation under the strip (a 2Hi): the model's flattening, the solid's bottom − top surface */
  flat: { model: (number | null)[]; fem: number[]; worst: Worst } | null;
  /** the exit profile the strip would see, Δh₁/2 against the centre (rough near the strip edge) */
  exit: { model: (number | null)[]; fem: number[]; worst: Worst } | null;
  bearingReaction: number;
  loadSumY: number;
  force: number;
  iterations: number;
  nodes: number;
  mesh: { name: string; nodes: number; stations: number; layers: number; angles: number }[];
  seconds: number;
  solveSeconds: number | null;
}

const base = (): string => {
  try {
    const q = new URLSearchParams(location.search).get('fistr');
    if (q) return q.replace(/\/$/, '') + '/__frontistr';
  } catch { /* no location (tests) */ }
  return '/__frontistr';
};

export interface FistrPing { ok: boolean; fistr1: boolean; busy: boolean }

/** null when nothing answers (a built app without the bridge) */
export async function pingFrontistr(): Promise<FistrPing | null> {
  try {
    const r = await fetch(`${base()}/ping`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as FistrPing;
  } catch {
    return null;
  }
}

export class FistrError extends Error {
  constructor(message: string, readonly log = '') { super(message); }
}

/** the comparison for these settings; throws FistrError with the bridge's message */
export async function solveFrontistr(mill: MillType, params: Params3D, signal: AbortSignal): Promise<FistrResult> {
  let r: Response;
  try {
    r = await fetch(`${base()}/solve`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mill, params }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new FistrError('接続なし（npm run dev の橋渡しが要る）');
  }
  const body = (await r.json().catch(() => ({}))) as Partial<FistrResult> & { error?: string; log?: string };
  if (!r.ok) throw new FistrError(body.error ?? `HTTP ${r.status}`, body.log ?? '');
  return body as FistrResult;
}

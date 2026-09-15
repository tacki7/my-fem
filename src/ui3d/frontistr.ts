/**
 * The FrontISTR cross-check from the app: the converged pass's strip load, put on the work
 * roll as a solid and solved by fistr1 through the dev server's bridge
 * (tools/frontistr/bridge.mjs). The bridge is on the page's own origin under `/__frontistr`
 * with `npm run dev`; `?fistr=http://host:port` names a stand-alone one (serve.mjs).
 */
import type { Params3D } from '../sim3d/stack';

/** lib.mjs `compare2hi`, plus what the bridge adds; lengths in m, loads in N/m */
export interface FistrResult {
  mill: '2hi';
  /** the stations from the centre out (x ≥ 0) */
  x: number[];
  q: (number | null)[];
  /** the work roll's axis against its bearing */
  vModel: (number | null)[];
  vFem: number[];
  /** the indentation under the strip: the model's flattening, the solid's bottom − top surface */
  flatModel: (number | null)[];
  flatFem: number[];
  worst: { v: number; vRel: number; flat: number };
  bearingReaction: number;
  loadSumY: number;
  force: number;
  iterations: number;
  nodes: number;
  seconds: number;
  solveSeconds: number | null;
  grid: { stations: number; layers: number; angles: number };
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

/** the 2Hi comparison for these settings; throws FistrError with the bridge's message */
export async function solveFrontistr2hi(params: Params3D, signal: AbortSignal): Promise<FistrResult> {
  let r: Response;
  try {
    r = await fetch(`${base()}/solve`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mill: '2hi', params }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new FistrError('接続なし（npm run dev の橋渡しが要る）');
  }
  const body = (await r.json().catch(() => ({}))) as Partial<FistrResult> & { error?: string; log?: string };
  if (!r.ok) throw new FistrError(body.error ?? `HTTP ${r.status}`, body.log ?? '');
  return body as FistrResult;
}

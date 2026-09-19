/**
 * A FrontISTR job from the app: start it on the bridge (tools/frontistr/jobs.mjs through
 * bridge.mjs), hear its server-sent events, fetch its surface and its frames as they are
 * written, stop it. The buffers are the fieldframe format (tools/frontistr/fieldframe.mjs);
 * this file does not decode them - that is the drawing's (fieldframe.ts).
 */
import { bridgeBase, FistrError } from './frontistr';

export type JobState = 'queued' | 'meshing' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobStatus {
  id: string;
  kind: string;
  state: JobState;
  message: string;
  /** frames written so far (frame k exists for k < frames) */
  frames: number;
  seconds: number;
  /** the tail of fistr1's output, when it failed */
  log?: string;
}

export interface JobBody {
  /** the 3D tab's parameters */
  params: object;
  /** the strip load to put on the rolls, when the case builder takes one */
  load?: object;
  /** result files over the load ramp */
  substeps?: number;
  /** the surface and the initial state only, no solve */
  dryRun?: boolean;
  /** kept with the job (request.json) and not used by the case: what the page compares the answer with */
  record?: object;
}

export interface JobHandlers {
  onState?(s: { state: JobState; message: string; frames: number }): void;
  onMesh?(m: { nodes: number; tris: number; parts: { name: string; kind: string; nodeCount: number; triCount: number }[] }): void;
  onFrame?(k: number, info: { time?: number; metrics?: Record<string, unknown> }): void;
  onProgress?(p: { sta?: string; warning?: string }): void;
  /**
   * The bridge stayed out of reach (`LOST_MS`) or no longer knows the job (the dev server was
   * restarted). A cut it comes back from - a sleep, a network change - is ridden out: the events
   * resume where the job stands (the bridge replays them all).
   */
  onDisconnect?(): void;
}

const ENDED: JobState[] = ['done', 'failed', 'cancelled'];
/** out of reach this long (awake time) before a job is given up for lost */
const LOST_MS = 5 * 60_000;
/** a fetch that fails for want of a connection is tried again, this often, this long */
const RETRY_MS = 2000;
const RETRY_FOR_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FistrJob {
  private source: EventSource | null = null;
  state: JobState = 'queued';
  /** since when the events have been cut off (0: connected), and the check that it is still cut */
  private lostAt = 0;
  private lostTimer = 0;

  private constructor(readonly id: string, private readonly root: string) {}

  /** start a job and listen to it; throws FistrError when the bridge says no (409 while another runs) */
  static async start(kind: string, body: JobBody, handlers: JobHandlers = {}): Promise<FistrJob> {
    const root = bridgeBase();
    let r: Response;
    try {
      r = await fetch(`${root}/jobs`, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...body }),
      });
    } catch {
      throw new FistrError('接続なし（npm run dev の橋渡しが要る）');
    }
    const answer = (await r.json().catch(() => ({}))) as { job?: JobStatus; error?: string; running?: unknown };
    if (!r.ok || !answer.job) throw new FistrError(r.status === 409 ? '別の FrontISTR の計算が動いている' : answer.error ?? `HTTP ${r.status}`);
    const job = new FistrJob(answer.job.id, root);
    job.listen(handlers);
    return job;
  }

  /**
   * Hear the job's events. On a reconnection the bridge sends every event again from the start, so
   * the handlers see some twice: a state, a frame, the mesh (each is taken as it stands).
   */
  private listen(h: JobHandlers): void {
    const es = new EventSource(`${this.root}/jobs/${this.id}/events`);
    this.source = es;
    const on = <T>(type: string, f: (d: T) => void) => es.addEventListener(type, (e) => f(JSON.parse((e as MessageEvent).data) as T));
    on<{ state: JobState; message: string; frames: number }>('state', (d) => {
      this.state = d.state;
      h.onState?.(d);
      if (ENDED.includes(d.state)) this.close();
    });
    on<Parameters<NonNullable<JobHandlers['onMesh']>>[0]>('mesh', (d) => h.onMesh?.(d));
    on<{ k: number; time?: number; metrics?: Record<string, unknown> }>('frame', (d) => h.onFrame?.(d.k, d));
    on<{ sta?: string; warning?: string }>('progress', (d) => h.onProgress?.(d));
    es.onopen = () => this.found();
    // A cut is not the end of the job: the browser reconnects the stream by itself, and when it has
    // given up (the connection refused while the machine woke), the stream is opened again. The job
    // is lost only when the bridge stays out of reach or no longer knows it.
    es.onerror = () => {
      if (ENDED.includes(this.state) || this.source !== es) return;
      if (!this.lostAt) this.lostAt = performance.now();
      if (!this.lostTimer) this.lostTimer = window.setInterval(() => { void this.stillThere(h); }, 3000);
    };
  }

  /** the events are back */
  private found(): void {
    this.lostAt = 0;
    clearInterval(this.lostTimer);
    this.lostTimer = 0;
  }

  /** while the events are cut off: open them again once the bridge answers, give the job up if it will not */
  private async stillThere(h: JobHandlers): Promise<void> {
    const es = this.source;
    if (!es || ENDED.includes(this.state)) { this.found(); return; }
    if (es.readyState === EventSource.OPEN) { this.found(); return; }
    let known: boolean | null = null;
    try {
      const r = await fetch(`${this.root}/jobs/${this.id}`, { cache: 'no-store' });
      known = r.status !== 404;
    } catch { /* still out of reach */ }
    if (this.source !== es) return;
    if (known === false) { this.close(); h.onDisconnect?.(); return; }
    if (known && es.readyState === EventSource.CLOSED) { es.close(); this.listen(h); return; }
    if (performance.now() - this.lostAt > LOST_MS) { this.close(); h.onDisconnect?.(); }
  }

  /** a file of the job; a fetch that fails for want of a connection (a cut, a sleep) is tried again for a while */
  private async bytes(path: string): Promise<ArrayBuffer> {
    const t0 = performance.now();
    for (;;) {
      let r: Response;
      try {
        r = await fetch(`${this.root}/jobs/${this.id}/${path}`, { cache: 'no-store' });
      } catch (e) {
        if (performance.now() - t0 > RETRY_FOR_MS) throw e;
        await sleep(RETRY_MS);
        continue;
      }
      if (!r.ok) throw new FistrError(`${path}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }
  }

  /** the surface (mesh.bin) */
  mesh(): Promise<ArrayBuffer> { return this.bytes('mesh.bin'); }

  /** frame k (0 the initial state) */
  frame(k: number): Promise<ArrayBuffer> { return this.bytes(`frames/${k}.bin`); }

  /** what the kind read off the finished case (result.json; `roll-coupled`: the work roll's surface) */
  async result<T = unknown>(): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.bytes('result.json'))) as T;
  }

  /** the job's state now */
  async status(): Promise<JobStatus> {
    const r = await fetch(`${this.root}/jobs/${this.id}`, { cache: 'no-store' });
    if (!r.ok) throw new FistrError(`status: HTTP ${r.status}`);
    return (await r.json()) as JobStatus;
  }

  /** stop the job's fistr1; the 'cancelled' state follows on the events */
  async cancel(): Promise<void> {
    await fetch(`${this.root}/jobs/${this.id}/cancel`, { method: 'POST', cache: 'no-store' }).catch(() => undefined);
  }

  /** stop listening (the job runs on) */
  close(): void {
    this.source?.close();
    this.source = null;
    this.found();
  }
}

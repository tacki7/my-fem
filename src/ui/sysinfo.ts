/** Host capability probing for the resource panel. */

export interface SysInfo {
  gpu: string;
  cores: number;
  deviceMemoryGB: number | null;
  maxTextureSize: number;
  glVersion: string;
  dpr: number;
}

export function probe(gl: WebGL2RenderingContext): SysInfo {
  let gpu = 'unknown';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  } catch { /* some browsers block this for fingerprinting */ }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    gpu: gpu.replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 64),
    cores: nav.hardwareConcurrency || 0,
    deviceMemoryGB: nav.deviceMemory ?? null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    glVersion: String(gl.getParameter(gl.VERSION)),
    dpr: window.devicePixelRatio || 1,
  };
}

export interface HeapInfo { used: number; total: number; limit: number }

/** Chrome-only JS heap counters; null elsewhere. */
export function heap(): HeapInfo | null {
  const p = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };
  if (!p.memory) return null;
  return {
    used: p.memory.usedJSHeapSize,
    total: p.memory.totalJSHeapSize,
    limit: p.memory.jsHeapSizeLimit,
  };
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * Gent's empirical relation between Shore A durometer and Young's modulus,
 * inverted numerically so the material panel can label a modulus in the units
 * a rubber roll is actually specified in.
 */
export function shoreAFromE(E_Pa: number): number {
  const f = (S: number) =>
    (0.0981 * (56 + 7.62336 * S)) / (0.137505 * (254 - 2.54 * S)) * 1e6;
  let lo = 5, hi = 95;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < E_Pa) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

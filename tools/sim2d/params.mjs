// The app's default RollingParams, read out of src/main.ts.
//
// They live as an object literal in main.ts, which imports the DOM and cannot be
// loaded in node. Rather than keep a second copy that drifts, the literal is sliced
// out of the source and evaluated: it only references TONF and MN_PER_MM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

export function defaultParams(patch = {}) {
  const src = readFileSync(MAIN, 'utf8');
  const start = src.indexOf('const params: RollingParams = {');
  if (start < 0) throw new Error('src/main.ts: `const params: RollingParams = {` not found');
  const end = src.indexOf('\n};', start);
  const literal = src.slice(src.indexOf('{', start), end + 2);
  const params = new Function('TONF', 'MN_PER_MM', `return (${literal});`)(9.80665e3, 1e9);
  return { ...params, ...patch };
}

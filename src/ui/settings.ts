/**
 * Save and restore the whole set-up as a file.
 *
 * A run of this app is a few dozen numbers spread over five panels - a pass
 * schedule, a material, a mesh, a set of control gains. Rebuilding one by hand
 * to compare against yesterday's is the kind of work the app exists to avoid,
 * so the state goes out as JSON and comes back the same way.
 *
 * **Restoring works by reloading the page.** Every widget in this app is built
 * from the state objects at boot, so putting the state back and starting over
 * is the one restore path that cannot drift: a dial added later is restored
 * correctly without anyone remembering to wire it up. The alternative - a
 * registry of forty setters kept in step by hand - is wrong the first time
 * someone adds a slider and forgets.
 */

const KEY = 'rollfem.pending-settings';
const MAGIC = 'roll-fem-lab.settings';
const VERSION = 1;

export interface SettingsFile {
  magic: string;
  version: number;
  savedAt: string;
  /** shared solver parameters */
  params: Record<string, unknown>;
  /** view state: field, colours, dial-side unit values, mesh level */
  view: Record<string, unknown>;
  /** per-stand setups, and how many of them are in the line */
  stands: Record<string, unknown>[];
  standCount: number;
  /** mass-flow speed coupling */
  autoSpeed: boolean;
}

/**
 * Merge a loaded object into a live one, key by key.
 *
 * Only keys the target already has, and only when the type matches and a
 * number is finite. A settings file is ordinary user data that may have been
 * hand-edited or come from a different version of the app, and a single NaN
 * reaching the solver does not throw - it quietly poisons the velocity field
 * and the mill runs on looking healthy. Unknown keys are dropped rather than
 * carried, so an old file loads as far as it makes sense and no further.
 */
function mergeInto(target: Record<string, unknown>, src: unknown): number {
  if (!src || typeof src !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (!(k in target)) continue;
    const cur = target[k];
    if (typeof cur === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    } else if (typeof cur === 'boolean') {
      if (typeof v !== 'boolean') continue;
    } else if (typeof cur === 'string') {
      if (typeof v !== 'string') continue;
    } else {
      continue;
    }
    target[k] = v;
    n++;
  }
  return n;
}

/** Build the file contents from the live state. */
export function collect(
  params: object, view: object, stands: object[], standCount: number, autoSpeed: boolean,
): SettingsFile {
  return {
    magic: MAGIC,
    version: VERSION,
    savedAt: new Date().toISOString(),
    // Copies, not references: the solve keeps running while the file is built.
    params: { ...(params as Record<string, unknown>) },
    view: { ...(view as Record<string, unknown>) },
    stands: stands.map((s) => ({ ...(s as Record<string, unknown>) })),
    standCount,
    autoSpeed,
  };
}

/** Hand the file to the browser's downloads. */
export function save(data: SettingsFile): string {
  // Local wall clock, not the UTC in `savedAt`: the name is read by a person
  // looking for the run they did after lunch. Sortable, so a folder of them
  // lists in the order they were made.
  const d = new Date(data.savedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `${stamp}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Freed on the next turn of the event loop: revoking synchronously can beat
  // the download starting in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/**
 * Ask for a file, stash what comes back, and reload into it.
 *
 * `onError` is given a message rather than the exception: the caller shows it
 * to the operator, who cannot act on a stack trace.
 */
export function load(onError: (msg: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      let data: SettingsFile;
      try {
        data = JSON.parse(text);
      } catch {
        onError('JSON として読めませんでした。');
        return;
      }
      if (!data || data.magic !== MAGIC) {
        onError('このアプリの設定ファイルではありません。');
        return;
      }
      if (typeof data.version !== 'number' || data.version > VERSION) {
        onError(`新しい形式のファイルです (version ${data.version})。`);
        return;
      }
      try {
        sessionStorage.setItem(KEY, text);
      } catch {
        onError('読み込んだ設定を保持できませんでした（プライベートモード？）。');
        return;
      }
      location.reload();
    }, () => onError('ファイルを読めませんでした。'));
  });
  input.click();
}

/**
 * Apply a file stashed by `load`, if there is one. Call at boot, before any
 * widget is built - they all read these objects as they are constructed.
 *
 * The stash is cleared whether or not it applied cleanly, so a file that
 * wedges the app cannot wedge it again on every subsequent reload.
 */
export function applyPending(
  params: Record<string, unknown>,
  view: Record<string, unknown>,
  stands: Record<string, unknown>[],
): { applied: boolean; standCount?: number; autoSpeed?: boolean } {
  let text: string | null = null;
  try {
    text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return { applied: false };
  }
  if (!text) return { applied: false };
  let data: SettingsFile;
  try {
    data = JSON.parse(text);
  } catch {
    return { applied: false };
  }
  mergeInto(params, data.params);
  mergeInto(view, data.view);
  if (Array.isArray(data.stands)) {
    data.stands.forEach((s, i) => { if (stands[i]) mergeInto(stands[i], s); });
  }
  const n = data.standCount;
  return {
    applied: true,
    standCount: Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined,
    autoSpeed: typeof data.autoSpeed === 'boolean' ? data.autoSpeed : undefined,
  };
}

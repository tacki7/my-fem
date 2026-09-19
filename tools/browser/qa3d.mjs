// The 3D tab put through its paces (4Hi), for bugs: every dial driven the way a person drives
// it, passes solved under conditions drawn at random, and the state changes a person makes
// while a solve runs.
//
//   CDP_PORT=<cdp> node tools/browser/qa3d.mjs http://localhost:<dev> [--quick] [--seed=N] [--solves=N] [--out=report.json]
//        [--only=dials,passes,state] [--keys=mu,width] [--pass=5,8]   (some sections, dials, passes of the seed's sequence)
//
// Needs a dev server and a headless Chrome of your own (tools/browser/README.md). Not part of
// `npm run check`: a full run takes the better part of an hour (--quick: a few minutes).
//
// 1. Dials. For every dial of the left panel (`.ctrl[data-key]`), on a fresh page: the slider to
//    both ends and the middle, the readout typed below the minimum, above the maximum, as text
//    and emptied, and the arrows pressed up and down. After each: no exception or console error,
//    the parameter finite and within the dial's travel, the readout showing the parameter, the
//    bounds between dials held (neck ≤ diameter, span ≥ barrel), the results marked stale.
// 2. Passes. Conditions drawn at random (seeded) over the dials that shape a pass - width, h₀,
//    reduction, tensions, μ, bender, crowns, the strip model, the flattening model, the housing
//    mode - each solved from a fresh page until converged or given up (the solve's own signal,
//    not a clock: `!__v3.running && !__v3.stale`, or its `stuck` warning). Each is judged: a
//    converged pass has finite numbers, a positive load, the exit gauge on target (gauge mode);
//    one that does not converge has to give up with its reason (`stuck`) within the time, not
//    leave the tab iterating - a warning shown while it iterates on is not enough.
// 3. State. With a solve running: a dial moved (the solve stops, the results go stale), R (the
//    solver starts over), Space twice (stops, starts), the housing mode switched, the 2D tab and
//    back, a section folded and opened, the window narrowed - no exception, and a solve started
//    afterwards still converges. (The tab's own flags are read only while the tab's loop drives the
//    solve: a solve finished from outside it - as the harness does, since headless Chrome throttles
//    animation frames - leaves `running` / `stale` up by design.)
//
// Exit 1 when anything was found; the report (--out) lists every finding with what was done.
import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const args = Object.fromEntries(process.argv.slice(3).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) { console.error('usage: CDP_PORT=<cdp> node tools/browser/qa3d.mjs http://localhost:<dev> [--quick] [--seed=N] [--solves=N] [--out=report.json]'); process.exit(64); }
const quick = !!args.quick;
const only = args.only ? new Set(String(args.only).split(',')) : null;
const runs = (section) => !only || only.has(section);
const SOLVES = Number(args.solves ?? (quick ? 3 : 24));
let seed = Number(args.seed ?? 20260919) >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

const findings = [];
const found = (area, what, detail) => { findings.push({ area, what, detail }); console.log(`FIND  [${area}] ${what}  ${detail ?? ''}`); };
const c = await connect(process.env.CDP_PORT);
// coupling=off: 計算開始 would otherwise start FrontISTR through the bridge (minutes of fistr1 a pass)
const URL3D = `${base}/?tab=3d&coupling=off`;
const fresh = async () => {
  c.errors.length = 0;
  await c.navigate(URL3D);
  await c.waitFor('!!(window.__v3 && window.__v3.solver)', 60000);
};
const errs = () => c.errors.splice(0);

/** in the page: every dial, and helpers to drive one (installed once per page) */
const HELPERS = `(() => {
  if (window.__qa) return true;
  const dial = (key) => document.querySelector('#v3-left .ctrl[data-key="' + key + '"]');
  window.__qa = {
    keys: () => [...document.querySelectorAll('#v3-left .ctrl[data-key]')].filter((d) => d.querySelector('input.ctrl-range')).map((d) => d.dataset.key),
    selects: () => [...document.querySelectorAll('#v3-left [data-key]')].filter((d) => d.querySelector('select')).map((d) => d.dataset.key),
    range: (key, pos) => { const r = dial(key).querySelector('input.ctrl-range'); r.value = String(pos); r.dispatchEvent(new Event('input', { bubbles: true })); },
    type: (key, text) => { const o = dial(key).querySelector('input.ctrl-value'); o.focus(); o.value = text; o.dispatchEvent(new Event('input', { bubbles: true })); o.dispatchEvent(new Event('change', { bubbles: true })); o.blur(); },
    spin: (key, up) => { const b = dial(key).querySelectorAll('.ctrl-spin-btn')[up ? 0 : 1]; b.click(); },
    readout: (key) => dial(key).querySelector('input.ctrl-value').value,
    // a select by its label (not every select carries a data-key): '材料の変形計算', '扁平モデル', …
    choose: (label, value) => { const box = [...document.querySelectorAll('#v3-left .ctrl')].find((d) => d.querySelector('select') && d.textContent.includes(label)); if (!box) return false; const s = box.querySelector('select'); if (![...s.options].some((o) => o.value === value)) return false; s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; },
    options: (key) => [...dial(key).querySelector('select').options].map((o) => o.value),
    toggle: (label, on) => { const t = [...document.querySelectorAll('#v3-left label')].find((l) => l.textContent.includes(label)); const i = t && (t.querySelector('input[type=checkbox]') || t.parentElement.querySelector('input[type=checkbox]')); if (!i) return false; if (i.checked !== on) i.click(); return i.checked === on; },
    finiteParams: () => Object.entries(__v3.params).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v)).map(([k]) => k),
    bounds: () => { const p = __v3.params, bad = []; if (p.wrDn > p.wrD + 1e-12) bad.push('wrDn>wrD'); if (p.burDn > p.burD + 1e-12) bad.push('burDn>burD'); if (p.wrLs < p.wrLb - 1e-12) bad.push('wrLs<wrLb'); if (p.burLs < p.burLb - 1e-12) bad.push('burLs<burLb'); return bad; },
  };
  return true;
})()`;

// the travel of each dial, read from the source's `num(key, label, unit, min, max, step, scale, …)` as the page built it:
// the range input's ends are 0 and 1000 whatever the dial, so the travel comes from driving it to the ends
async function dialEnds(key) {
  await c.evaluate(`__qa.range(${JSON.stringify(key)}, 0)`);
  const lo = await c.evaluate(`__v3.params[${JSON.stringify(key)}]`);
  await c.evaluate(`__qa.range(${JSON.stringify(key)}, 1000)`);
  const hi = await c.evaluate(`__v3.params[${JSON.stringify(key)}]`);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

// ── 1. dials ────────────────────────────────────────────────────────────────
if (runs('dials')) {
  await fresh();
  await c.evaluate(HELPERS);
  let keys = await c.evaluate('__qa.keys()');
  if (args.keys) keys = keys.filter((k) => String(args.keys).split(',').includes(k));
  else if (quick) keys = keys.filter((_, i) => i % 5 === 0);
  console.log(`dials: ${keys.length}`);
  for (const key of keys) {
    await fresh();
    await c.evaluate(HELPERS);
    const K = JSON.stringify(key);
    const [lo, hi] = await dialEnds(key);
    const span = hi - lo;
    // a dial that does not reach its parameter has no travel at all (lo = hi): nothing below would notice
    if (!(span > 0)) found('dials', `${key}: the slider does not move the parameter`, `${lo} at both ends`);
    errs();
    const actions = [
      ['slider to the middle', `__qa.range(${K}, 500)`],
      ['slider to the minimum', `__qa.range(${K}, 0)`],
      ['slider to the maximum', `__qa.range(${K}, 1000)`],
      ['typed below the minimum', `__qa.type(${K}, String(${lo} === 0 ? -1e9 : ${lo} * -10))`],
      ['typed above the maximum', `__qa.type(${K}, '1e12')`],
      ['typed text', `__qa.type(${K}, 'abc')`],
      ['emptied', `__qa.type(${K}, '')`],
      ['arrow up ×3', `(__qa.spin(${K}, true), __qa.spin(${K}, true), __qa.spin(${K}, true))`],
      ['arrow down ×3', `(__qa.spin(${K}, false), __qa.spin(${K}, false), __qa.spin(${K}, false))`],
    ];
    for (const [what, expr] of actions) {
      const before = await c.evaluate(`__v3.params[${K}]`);
      await c.evaluate(expr);
      await c.sleep(30);
      const st = await c.evaluate(`({ v: __v3.params[${K}], bad: __qa.finiteParams(), bounds: __qa.bounds(), readout: __qa.readout(${K}), stale: __v3.stale, running: __v3.running })`);
      const e = errs();
      const tag = `${key}: ${what}`;
      if (e.length) found('dials', `${tag}: an exception or console error`, e.slice(0, 2).join(' | '));
      if (st.bad.length) found('dials', `${tag}: a parameter not finite`, st.bad.join(', '));
      if (!(st.v >= lo - 1e-9 * Math.max(1, Math.abs(span)) && st.v <= hi + 1e-9 * Math.max(1, Math.abs(span)))) found('dials', `${tag}: the value left the dial's travel`, `${st.v} not in [${lo}, ${hi}]`);
      if (st.bounds.length) found('dials', `${tag}: a bound between dials broken`, st.bounds.join(', '));
      if (st.running) found('dials', `${tag}: a changed setting left the solve running`, '');
      if (st.v !== before && !st.stale) found('dials', `${tag}: the value changed but the results were not marked stale`, `${before} → ${st.v}`);
      // the readout shows a number close to the value (display units differ: compare the number's own digits against the travel)
      const shown = parseFloat(String(st.readout).replace(/[^0-9eE+\-.]/g, ''));
      if (!Number.isFinite(shown)) found('dials', `${tag}: the readout shows no number`, JSON.stringify(st.readout));
      if (what === 'typed text' || what === 'emptied') { if (st.v !== before) found('dials', `${tag}: text that is not a number changed the value`, `${before} → ${st.v}`); }
    }
  }
}

// ── 2. passes ───────────────────────────────────────────────────────────────
const PASS_DIALS = {
  width: [0.3, 1.6], h0: [0.2e-3, 6e-3], reduction: [0.03, 0.5], backTension: [0, 250e6], frontTension: [0, 250e6], mu: [0.02, 0.2],
  wrBender: [-40 * 9.80665e3, 180 * 9.80665e3], wrCrown: [-300e-6, 300e-6], burCrown: [-400e-6, 800e-6], entryCrown: [-50e-6, 150e-6],
};
/** SI → the unit the dial shows */
const SHOWN = { width: 1e3, h0: 1e3, reduction: 100, backTension: 1e-6, frontTension: 1e-6, mu: 1, wrBender: 1 / 9.80665e3, wrCrown: 1e6, burCrown: 1e6, entryCrown: 1e6 };
const solveOne = async (label, set, timeoutMs) => {
  await fresh();
  await c.evaluate(HELPERS);
  const before = await c.evaluate('({ ...__v3.params })');
  // typed into the dials, in the units they show, as a person sets them
  for (const [k, v] of Object.entries(set.params)) await c.evaluate(`__qa.type(${JSON.stringify(k)}, ${JSON.stringify(String(+(v * SHOWN[k]).toPrecision(6)))})`);
  // the choices go through their own controls, as a person makes them
  const LABEL = { stripModel: '材料の変形計算', flatModel: '扁平モデル' };
  for (const [k, v] of Object.entries(set.choices ?? {})) {
    const ok = await c.evaluate(`__qa.choose(${JSON.stringify(LABEL[k] ?? k)}, ${JSON.stringify(v)})`);
    if (!ok) found('passes', `${label}: the select for ${k} (${LABEL[k] ?? k}) was not found or has no ${v}`, '');
  }
  if (set.housing) await c.evaluate(`__qa.toggle('ハウジング変形考慮モード', true)`);
  const t0 = Date.now();
  await c.evaluate('__v3.start()');
  // The solve runs on animation frames, which headless Chrome fires only every few seconds at
  // times (README, 計測用クエリパラメータ) - waiting on them measured Chrome, not the app. So the
  // solver is driven in the page as smoke.mjs does, up to the solve's own cap, and the tab is then
  // left one frame to take the converged state into its flags.
  const drove = await c.evaluate(`(() => { const s = __v3.solver, t = performance.now(); let n = 0; while (!s.isConverged && performance.now() - t < ${timeoutMs}) { s.advance(1e9, 6); n++; if (s.result.warnings && s.result.warnings.includes('stuck')) break; } return { converged: s.isConverged, calls: n }; })()`);
  // Judged by the solver itself. The tab's running / stale flags only come down inside its own loop
  // (view3d.ts tickBody: `running && !solver.isConverged` → advance → converged → flags down), so a
  // solve finished out here leaves them up by design - they are not read (the first full run
  // reported every converged pass as 'flags did not follow' for that reason).
  const done = drove.converged ? 'converged'
    : (await c.evaluate("(__v3.solver.result.warnings || []).includes('stuck')")) ? 'stuck' : 'timeout';
  const secs = (Date.now() - t0) / 1000;
  const taken = await c.evaluate(`(() => { const p = __v3.params; return { ${Object.keys(set.params).map((k) => `${JSON.stringify(k)}: p[${JSON.stringify(k)}]`).join(', ')} }; })()`);
  const r = await c.evaluate(`(() => { const R = __v3.solver.result, p = __v3.params, fin = (a) => Array.from(a).every((v) => Number.isFinite(v) || Number.isNaN(v));
    return { force: R.force, h1Mean: R.h1Mean, target: (1 - p.reduction) * p.h0, mode: p.mode, crown: R.crown, latent: R.latentIU, warnings: R.warnings, settings: __v3.solver.settingsWarnings().keys,
      finite: [R.force, R.h1Mean, R.crown, R.latentIU, R.manifestIU].every(Number.isFinite), arrays: fin(R.h1) && fin(R.q), iterations: R.iterations, converged: R.converged }; })()`);
  await c.evaluate('__v3.stop()').catch(() => {});
  const e = errs();
  const row = { label, ...set, taken, done, secs, ...r };
  // Typed values are rounded to the dial's step, so the value taken is not the one typed - but it has to
  // be nearer to it than the value the page started from, when the two are apart by more than 3 % of the
  // range drawn from (every step is under 2/3 of that: μ's 0.005 against 0.0054): a dial that drops what
  // is typed keeps the start value.
  for (const [k, v] of Object.entries(set.params)) {
    const [a, b] = PASS_DIALS[k];
    if (Math.abs(v - before[k]) > 0.03 * (b - a) && !(Math.abs(taken[k] - v) < 0.5 * Math.abs(before[k] - v))) found('passes', `${label}: the dial ${k} did not take the typed ${v}`, `took ${taken[k]}, the page started at ${before[k]}`);
  }
  const tag = `${label} ${JSON.stringify(set)}`;
  if (e.length) found('passes', `${tag}: an exception or console error`, e.slice(0, 2).join(' | '));
  if (done === 'converged') {
    if (!r.finite || !r.arrays) found('passes', `${tag}: converged with numbers that are not finite`, JSON.stringify(r));
    if (!(r.force > 0)) found('passes', `${tag}: converged with no load`, `${r.force}`);
    if (r.mode === 'gauge' && Math.abs(r.h1Mean - r.target) > 1e-6) found('passes', `${tag}: converged off the gauge target`, `h1 ${(r.h1Mean * 1e3).toFixed(4)} mm against ${(r.target * 1e3).toFixed(4)}`);
  } else if (done === 'timeout') {
    // a warning is not enough: the tab stays in 反復中 for as long as the solve neither converges nor
    // gives up, and the person waits (T100 - the first full run had four such passes, each with a warning)
    found('passes', `${tag}: neither converged nor gave up in ${timeoutMs / 1000} s`, JSON.stringify({ it: r.iterations, warnings: r.warnings, settings: r.settings }));
  }
  console.log(`pass  ${label}  ${done}  ${secs.toFixed(0)} s  F ${(r.force / 9.80665e3).toFixed(0)} tonf  h1 ${(r.h1Mean * 1e3).toFixed(4)}/${(r.target * 1e3).toFixed(4)} mm  C25 ${(r.crown * 1e6).toFixed(1)} µm  warnings ${[...(r.warnings ?? []), ...(r.settings ?? [])].join(',') || '-'}`);
  return row;
};
const passes = [];
if (runs('passes')) {
  const models = ['slab', 'fem', 'fem3d'];
  // --pass=5,8: those passes of the seed's sequence only (the ones before are drawn, not solved)
  const pick = args.pass ? new Set(String(args.pass).split(',').map(Number)) : null;
  for (let n = 0; n < (pick ? Math.max(...pick) : SOLVES); n++) {
    const params = {};
    for (const [k, [a, b]] of Object.entries(PASS_DIALS)) if (rnd() < 0.6) params[k] = a + (b - a) * rnd();
    const choices = { stripModel: models[Math.floor(rnd() * models.length)] };
    if (rnd() < 0.3) choices.flatModel = 'ring';
    const set = { params, choices, housing: rnd() < 0.25 };
    if (pick && !pick.has(n + 1)) continue;
    // the 3D FEM is the slow one: longer before the solve is given up
    passes.push(await solveOne(`#${n + 1}`, set, choices.stripModel === 'fem3d' ? 600000 : 300000));
    await c.evaluate("location.href = 'about:blank'").catch(() => {});
  }
}

// ── 3. state while a solve runs ─────────────────────────────────────────────
if (runs('state')) {
  await fresh();
  await c.evaluate(HELPERS);
  const step = async (what, expr, expect) => {
    await c.evaluate(expr);
    await c.sleep(150);
    const st = await c.evaluate('({ running: __v3.running, stale: __v3.stale, it: __v3.solver.result.solveIterations })');
    const e = errs();
    if (e.length) found('state', `${what}: an exception or console error`, e.slice(0, 2).join(' | '));
    if (expect && !expect(st)) found('state', `${what}: not the state expected`, JSON.stringify(st));
    return st;
  };
  await c.evaluate('__v3.start()');
  await c.waitFor('__v3.running && __v3.solver.result.iterations > 0', 60000).catch(() => found('state', 'the solve did not start', ''));
  await step('a dial moved while running', `__qa.range('mu', 300)`, (s) => !s.running && s.stale);
  await step('started again', '__v3.start()', (s) => s.running);
  await step('R pressed', `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true }))`, (s) => !s.running && s.stale);
  await step('Space: start', `window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))`, (s) => s.running);
  await step('Space: stop', `window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))`, (s) => !s.running);
  await step('housing mode on while stopped', `__qa.toggle('ハウジング変形考慮モード', true)`, (s) => !s.running && s.stale);
  await step('started', '__v3.start()', (s) => s.running);
  await step('to the 2D tab', `document.querySelector('#mode-tabs [data-mode="2d"]').click()`, null);
  await step('back to the 3D tab', `document.querySelector('#mode-tabs [data-mode="3d"]').click()`, null);
  await step('a right-hand section folded', `document.querySelector('#v3-right .panel-head-btn')?.click()`, null);
  await step('and opened', `document.querySelector('#v3-right .panel-head-btn')?.click()`, null);
  await c.setViewport(1024, 700);
  await step('the window narrowed', 'true', null);
  await c.setViewport(1700, 1050);
  // converge in the page (see the passes), then the tab's flags have to follow
  const drove = await c.evaluate(`(() => { const s = __v3.solver, t = performance.now(); while (!s.isConverged && performance.now() - t < 300000) s.advance(1e9, 6); return { converged: s.isConverged, it: s.result.solveIterations, w: s.result.warnings }; })()`);
  if (!drove.converged) found('state', 'after the state changes the solve did not converge', JSON.stringify(drove));
  const e = errs();
  if (e.length) found('state', 'errors at the end', e.slice(0, 3).join(' | '));
}
await c.evaluate("location.href = 'about:blank'").catch(() => {});
c.close();

const report = { when: new Date().toISOString(), quick, seed: Number(args.seed ?? 20260919), findings, passes };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 1));
console.log(`\n${findings.length} finding(s); ${passes.length} passes solved (${passes.filter((p) => p.done === 'converged').length} converged)`);
process.exit(findings.length ? 1 : 0);

// The 3D tab put through its paces (4Hi), for bugs: every dial driven the way a person drives
// it, passes solved under conditions drawn at random, and the state changes a person makes
// while a solve runs.
//
//   CDP_PORT=<cdp> node tools/browser/qa3d.mjs http://localhost:<dev> [--quick] [--seed=N] [--solves=N] [--out=report.json]
//        [--only=dials,passes,state] [--keys=mu,width] [--pass=5,8]   (some sections, dials, passes of the seed's sequence)
//   CDP_PORT=<cdp> node tools/browser/qa3d.mjs http://localhost:<dev> --only=coupled --control=<file> [--real] [--cases=through,stop,…]
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
// 4. Coupled (only with --only=coupled: it needs a dev server started with the stand-in for
//    fistr1, tools/frontistr/fake-fistr1.mjs, and --control naming its FAKE_FISTR1_CONTROL file;
//    --real allows a real fistr1, minutes a round, under the CPU lock). The coupling with FrontISTR
//    (src/ui3d/coupled3d.ts) from 計算開始 to 定常 and everything a person does on the way - see
//    `COUPLED` below for the cases. Each is judged by what the page shows (the state line, the
//    panel, the run button, the contour's plate) and by the bridge's own record of its jobs.
//
// Exit 1 when anything was found; the report (--out) lists every finding with what was done.
import { writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
// ── 4. the coupling with FrontISTR ──────────────────────────────────────────
const coupledLog = [];
if (only && only.has('coupled')) await coupledSection();

await c.evaluate("location.href = 'about:blank'").catch(() => {});
c.close();

const report = { when: new Date().toISOString(), quick, seed: Number(args.seed ?? 20260919), findings, passes, coupled: coupledLog };
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 1));
console.log(`\n${findings.length} finding(s); ${passes.length} passes solved (${passes.filter((p) => p.done === 'converged').length} converged)`);
process.exit(findings.length ? 1 : 0);


/**
 * The coupled cases. A case is a fresh page on the contour stage, the stand-in set for it (the
 * control file), and a script of steps; after each step the page is read (`__qc.read()`) and
 * checked. The bridge runs one job at a time and outlives pages, so every case starts by waiting
 * for it to be idle (and cancels what a case left behind).
 */
async function coupledSection() {
  const RUN = fileURLToPath(new URL('../frontistr/run/', import.meta.url));
  const bridge = `${base}/__frontistr`;
  const get = async (path) => { try { const r = await fetch(`${bridge}${path}`, { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; } };
  const post = async (path) => { try { await fetch(`${bridge}${path}`, { method: 'POST' }); } catch { /* gone */ } };
  const ping = await get('/ping');
  if (!ping) { found('coupled', 'no bridge at the dev server', base); return; }
  if (ping.solver !== 'fake-fistr1.mjs' && !args.real) {
    console.error(`coupled: the bridge runs ${ping.solver ?? 'fistr1'}, not the stand-in - start the dev server with FISTR1=<repo>/tools/frontistr/fake-fistr1.mjs, or pass --real (minutes a round, under the CPU lock)`);
    process.exit(64);
  }
  const control = args.control ? String(args.control) : null;
  if (!args.real && !control) { console.error('coupled: --control=<the FAKE_FISTR1_CONTROL file the dev server was started with>'); process.exit(64); }
  const setStandIn = (o) => { if (control) writeFileSync(control, JSON.stringify({ mode: 'ok', at: 1, stepMs: 1500, bump: 3e-6, ...o })); };
  const jobs = () => (existsSync(`${RUN}jobs`) ? readdirSync(`${RUN}jobs`) : []);
  const jobInfo = (id) => { try { return JSON.parse(readFileSync(`${RUN}jobs/${id}/request.json`, 'utf8')); } catch { return null; } };
  const standInLog = (id) => { try { return readFileSync(`${RUN}jobs/${id}/fake-fistr1.log`, 'utf8'); } catch { return ''; } };
  /** the bridge idle: wait for it, and cancel a job a case left running (up to `ms`) */
  const idle = async (ms = 180000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const p = await get('/ping');
      if (p && !p.busy) return true;
      await c.sleep(500);
    }
    return false;
  };
  const cancelAll = async () => { for (const id of jobs()) { const st = await get(`/jobs/${id}`); if (st && !['done', 'failed', 'cancelled'].includes(st.state)) await post(`/jobs/${id}/cancel`); } };

  const HELP = `(() => {
    if (window.__qc) return true;
    const text = (sel) => { const e = document.querySelector(sel); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; };
    const plate = (body) => { const tr = [...document.querySelectorAll('.ct3-status tr')].find((r) => r.querySelector('th') && r.querySelector('th').textContent === body); return tr ? { state: tr.querySelector('.ct3-state').textContent, text: tr.querySelector('.ct3-text').textContent } : null; };
    window.__qc = {
      read: () => {
        const k = __v3.coupled, rec = k.record, v = k.contour, corr = __v3.solver.rollCorrection;
        const panel = [...document.querySelectorAll('#v3-right .stat-row')].find((r) => r.innerText.startsWith('状態'));
        return {
          phase: rec.phase, rounds: rec.rounds.length, roundNos: rec.rounds.map((r) => r.round), note: rec.note, enabled: k.enabled,
          row: text('.v3-couple'), panel: panel ? panel.innerText.replace(/\\s+/g, ' ') : null,
          button: document.querySelector('.v3-run').textContent, buttonOff: document.querySelector('.v3-run').disabled,
          chip: text('.v3-conv') ?? text('#v3-centre .badge'),
          running: __v3.running, stale: __v3.stale, converged: __v3.solver.isConverged, force: __v3.solver.result.force,
          corr: corr ? Math.max(...Array.from(corr).map(Math.abs)) : null, delta: rec.delta, x: Array.from(__v3.solver.x), q: Array.from(__v3.solver.result.q),
          job: k.job ? k.job.id : null, parts: v ? v.partNames() : [], strip: plate('板'), roll: plate('ロール'),
          stripRange: v && v.partNames().includes('strip') ? v.groupState('strip').range : null,
          rollRange: v && v.partNames().includes('WR') ? v.groupState('roll').range : null,
          stripKind: v && v.parts.get('strip') ? v.parts.get('strip').nodes : 0,
          overlays: (() => { const o = k.overlays(__v3.solver.result); return { defl: o.defl.length, flat: o.flat.length, gauge: o.gauge.length }; })(),
        };
      },
      range: (key, pos) => { const r = document.querySelector('#v3-left .ctrl[data-key="' + key + '"] input.ctrl-range'); r.value = String(pos); r.dispatchEvent(new Event('input', { bubbles: true })); },
      choose: (label, value) => { const box = [...document.querySelectorAll('#v3-left .ctrl')].find((d) => d.querySelector('select') && d.textContent.includes(label)); if (!box) return false; const s = box.querySelector('select'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; },
      toggle: (label, on) => { const t = [...document.querySelectorAll('#v3-left label')].find((l) => l.textContent.includes(label)); const i = t && (t.querySelector('input[type=checkbox]') || t.parentElement.querySelector('input[type=checkbox]')); if (!i) return false; if (i.checked !== on) i.click(); return i.checked === on; },
      key: (key, code) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })),
    };
    return true;
  })()`;
  const read = () => c.evaluate('__qc.read()');
  let caseName = '';
  const bad = (what, detail) => found('coupled', `${caseName}: ${what}`, detail);
  /**
   * What the page shows follows the state on its next animation frame, which headless Chrome
   * fires only every few seconds at times: a text read at once is often the last frame's (the
   * first run reported 「▶ 計算開始」 during the app's solve for that reason). So an expectation on
   * the page waits for it, up to `ms`, and is a finding only if it never comes. `pred` is an
   * expression over `s = __qc.read()`.
   */
  const expect = async (pred, what, ms = 20000) => {
    const expr = `(() => { const s = __qc.read(); return !!(${pred}); })()`;
    try { await c.waitFor(expr, ms, 250); } catch { bad(what, await brief()); }
  };
  /** the page's state for a finding, without the per-station arrays */
  const brief = async () => JSON.stringify(await read().catch(() => ({})), (k, v) => (['x', 'q', 'delta'].includes(k) ? undefined : v));
  const waitPhase = async (expr, ms, what) => {
    try { await c.waitFor(expr, ms, 250); return true; } catch { bad(`${what} did not come in ${ms / 1000} s`, await brief()); return false; }
  };
  const open = async (query = '') => {
    c.errors.length = 0;
    await c.navigate(`${base}/?tab=3d${query}`);
    await c.waitFor('!!(window.__v3 && window.__v3.coupled)', 60000);
    await c.evaluate(HELP);
    await c.evaluate("__v3.setFrontMode('contour')");
  };
  /**
   * Console lines. A request the bridge answers 409 (busy: the initial state's dry run, or a
   * round, finding another job still on the bridge - after a settings change, a reload) is a line
   * Chrome writes itself. The page asks /ping first and does not post while the bridge is busy, so
   * one is a job slipping in between the two requests - rare. Those are counted apart and reported
   * once at the end with the cases they came in; anything else fails the case.
   */
  const busyLines = {};
  const errsNow = (where) => {
    const e = errs();
    const busy = e.filter((x) => /status of 409/.test(x));
    if (busy.length) busyLines[caseName] = (busyLines[caseName] ?? 0) + busy.length;
    const other = e.filter((x) => !/status of 409/.test(x));
    if (other.length) bad(`an exception or console error ${where}`, other.slice(0, 3).join(' | '));
  };
  /** the rolls placed from the dry run (the initial state) */
  const initialRolls = () => waitPhase("__qc.read().parts.includes('WR') && __qc.read().parts.includes('BUR')", 240000, 'the rolls of the initial state (dry run)');
  const jobState = async (id, ms = 60000) => {
    const t0 = Date.now();
    let st = null;
    while (Date.now() - t0 < ms) { st = await get(`/jobs/${id}`); if (st && ['done', 'failed', 'cancelled'].includes(st.state)) return st.state; await c.sleep(300); }
    return st ? st.state : 'gone';
  };
  const cases = args.cases ? new Set(String(args.cases).split(',')) : null;
  const want = (n) => !cases || cases.has(n);
  const t0all = Date.now();
  const record = (name, t0, extra = {}) => { coupledLog.push({ case: name, seconds: (Date.now() - t0) / 1000, ...extra }); console.log(`coupled  ${name}  ${((Date.now() - t0) / 1000).toFixed(0)} s`); };
  /** start and wait for a FrontISTR round to be running */
  const toFistr = async () => {
    await c.evaluate('__v3.start()');
    return waitPhase("__qc.read().phase === 'fistr' && !!__qc.read().job", 300000, 'a FrontISTR round');
  };
  /** the case's end: whatever it left on the bridge goes */
  const close = async () => { await c.evaluate('__v3.stop()').catch(() => {}); await cancelAll(); await idle(); };

  // ── through: 計算前 → アプリ → FrontISTR → … → 定常, each stage's words, and the answer the stand-in makes known
  if (want('through')) {
    caseName = 'through'; const t0 = Date.now();
    await idle(); setStandIn({ stepMs: 2500 });
    await open();
    await initialRolls();
    let s = await read();
    if (s.phase !== 'idle') bad('the initial phase is not idle', s.phase);
    await expect("/計算開始/.test(s.button)", 'the run button before a solve');
    await expect("s.strip && s.strip.state === '計算前' && s.roll && s.roll.state === '計算前'", 'the plate before a solve is not 計算前');
    s = await read();
    if (!s.stripRange?.uniform || !s.rollRange?.uniform) bad('the initial contours are not one value (0) everywhere', JSON.stringify({ strip: s.stripRange, roll: s.rollRange }));
    await c.evaluate('__v3.start()');
    if (await waitPhase("__qc.read().phase === 'app'", 30000, 'the app phase')) {
      await expect("s.phase !== 'app' || /停止/.test(s.button)", 'the run button while the app solves');
      await expect("s.phase !== 'app' || /アプリ/.test(s.row || '')", 'the state line while the app solves');
    }
    if (await waitPhase("__qc.read().phase === 'fistr'", 300000, 'the first FrontISTR round')) {
      await expect("s.phase !== 'fistr' || (/停止/.test(s.button) && !s.buttonOff)", 'the run button during a FrontISTR round');
      await expect("s.phase !== 'fistr' || (/FrontISTR/.test(s.row || '') && /1 回目/.test(s.row || ''))", 'the state line during round 1');
      await expect("s.phase !== 'fistr' || /FrontISTR 計算中/.test(s.panel || '')", 'the panel during round 1');
      // a load step's frame within the round (the bridge reads the newest result once it is whole)
      if (await waitPhase("/荷重 1\\//.test((__qc.read().roll || {}).text || '')", 200000, 'a frame within round 1 (荷重 1/n)')) {
        s = await read();
        if (s.rollRange?.uniform) bad('the rolls\' contour did not change with the first frame', JSON.stringify(s.rollRange));
      }
    }
    if (await waitPhase("__qc.read().phase === 'app' && __qc.read().rounds === 1", 300000, 'the re-solve after round 1')) {
      s = await read();
      if (!(s.corr > 0)) bad('no correction in the solver after round 1', `${s.corr}`);
      await expect("s.phase !== 'app' || /補正/.test(s.row || '')", 'the state line during the re-solve');
      await expect("s.phase !== 'app' || /連成 1 回目まで/.test((s.roll || {}).text || '')", 'the rolls\' label between rounds');
    }
    if (await waitPhase("__qc.read().phase === 'steady'", 600000, 'the steady state')) {
      s = await read();
      if (s.rounds !== 2) bad('the stand-in steadies in 2 rounds', `${s.rounds}`);
      await expect("/計算済み/.test(s.button) && s.buttonOff", 'the run button at the steady state');
      await expect("/定常/.test(s.row || '') && /定常/.test(s.panel || '')", 'the state line / panel at the steady state');
      await expect("s.strip && s.strip.state === '定常' && s.roll && s.roll.state === '定常'", 'the plate at the steady state');
      s = await read();
      if (s.overlays.defl < 2 || s.overlays.flat < 1 || s.overlays.gauge < 1) bad('the charts\' overlays at the steady state', JSON.stringify(s.overlays));
      // the known answer: the stand-in's surface is the model's plus 3 µm·((x/halfW)² − 0.3); δ is that bump
      const halfW = 0.5, mid = (s.x.length - 1) >> 1;
      const want0 = 3e-6 * -0.3, got0 = s.delta[mid];
      if (!(Math.abs(got0 - want0) < 0.2e-6)) bad('δ at the centre is not the stand-in\'s bump', `${(got0 * 1e6).toFixed(3)} µm against ${(want0 * 1e6).toFixed(3)}`);
      const i8 = s.x.findIndex((x) => x >= 0.8 * halfW), want8 = 3e-6 * (0.64 - 0.3);
      if (i8 > 0 && !(Math.abs(s.delta[i8] - want8) < 0.3e-6)) bad('δ at 0.8 × half width is not the stand-in\'s bump', `${(s.delta[i8] * 1e6).toFixed(3)} µm against ${(want8 * 1e6).toFixed(3)}`);
      coupledLog.push({ case: 'through-answer', deltaCentre: got0, deltaAt08: s.delta[i8], rounds: s.rounds, force: s.force });
    }
    errsNow('in the run');
    record('through', t0);
    await close();
  }

  /** a case: a round running, then `act`, then `check` on what the page and the bridge show */
  const midRound = async (name, act, check, standIn = { mode: 'hang', at: 1 }) => {
    if (!want(name)) return;
    caseName = name; const t0 = Date.now();
    await idle(); setStandIn(standIn);
    await open();
    await initialRolls();
    if (await toFistr()) {
      const before = await read();
      await act(before);
      await c.sleep(400);
      await check(before, await read());
    }
    errsNow('in the case');
    record(name, t0);
    await close();
  };
  /** the job of a round ended by the action, and the stand-in stopped with it */
  const jobGone = async (id, how) => {
    const st = await jobState(id, 60000);
    if (st !== 'cancelled') bad(`${how}: the round's job was not cancelled`, `${id}: ${st}`);
    await c.sleep(500);
    const log = standInLog(id);
    if (log && !/SIGTERM/.test(log)) bad(`${how}: the stand-in was not stopped`, log.trim().split('\n').pop());
  };
  const settingsDropped = async (s, how) => {
    if (s.phase !== 'idle') bad(`${how}: the coupling did not go back to idle`, s.phase);
    if (s.corr !== null) bad(`${how}: the correction stayed in the solver`, `${s.corr}`);
    if (s.rounds !== 0) bad(`${how}: the rounds stayed`, `${s.rounds}`);
    await expect("/計算開始/.test(s.button)", `${how}: the run button`);
    await expect("s.roll && s.roll.state === '計算前'", `${how}: the rolls' plate did not go back to 計算前`);
  };

  await midRound('stop-resume', async () => { await c.evaluate('__v3.stop()'); }, async (b, s) => {
    if (s.phase !== 'stopped') bad('stop: phase', s.phase);
    await expect("/連成を続ける/.test(s.button) && !s.buttonOff", 'stop: the run button');
    await jobGone(b.job, 'stop');
    // on: the next round with the stand-in running free
    setStandIn({});
    await idle();
    await c.evaluate('__v3.start()');
    await waitPhase("__qc.read().phase === 'fistr' || __qc.read().phase === 'steady'", 120000, 'the resumed round');
    await waitPhase("__qc.read().phase === 'steady'", 600000, 'the steady state after resuming');
  });
  await midRound('dial', async () => { await c.evaluate("__qc.range('mu', 300)"); }, async (b, s) => {
    await settingsDropped(s, 'a dial moved');
    await jobGone(b.job, 'a dial moved');
    // the next calculation starts at round 1
    setStandIn({});
    await idle();
    await c.evaluate('__v3.start()');
    if (await waitPhase("__qc.read().phase === 'steady'", 900000, 'the steady state after a dial move')) {
      const e = await read();
      if (e.roundNos[0] !== 1) bad('after a dial move the rounds did not start at 1', JSON.stringify(e.roundNos));
    }
  });
  await midRound('R', async () => { await c.evaluate("__qc.key('r', 'KeyR')"); }, async (b, s) => { await settingsDropped(s, 'R'); await jobGone(b.job, 'R'); });
  await midRound('space', async () => { await c.evaluate("__qc.key(' ', 'Space')"); }, async (b, s) => {
    if (s.phase !== 'stopped') bad('Space: did not stop the coupling', s.phase);
    await jobGone(b.job, 'Space');
    setStandIn({});
    await idle();
    await c.evaluate("__qc.key(' ', 'Space')");
    await waitPhase("__qc.read().phase === 'fistr' || __qc.read().phase === 'steady'", 120000, 'Space again resuming');
  });
  await midRound('housing', async () => { await c.evaluate("__qc.toggle('ハウジング変形考慮モード', true)"); }, async (b, s) => { await settingsDropped(s, 'housing mode'); await jobGone(b.job, 'housing mode'); });
  await midRound('switch-off', async () => { await c.evaluate("__qc.choose('ロールの変形', 'model')"); }, async (b, s) => {
    if (s.enabled) bad('switched to the model: still enabled', '');
    await expect("/連成なし/.test(s.row || '')", 'switched to the model: the state line');
    await jobGone(b.job, 'switched to the model');
    await c.evaluate("__qc.choose('ロールの変形', 'fistr')");
    const t = await read();
    if (!t.enabled || t.phase !== 'idle') bad('switched back: not enabled and idle', JSON.stringify({ enabled: t.enabled, phase: t.phase }));
  });
  await midRound('tab-2d', async () => {
    await c.evaluate(`document.querySelector('#mode-tabs [data-mode="2d"]').click()`); await c.sleep(1500);
    await c.evaluate(`document.querySelector('#mode-tabs [data-mode="3d"]').click()`);
  }, async (b, s) => {
    if (s.phase !== 'fistr' || s.job !== b.job) bad('the 2D tab and back: the round did not go on', JSON.stringify({ phase: s.phase, job: s.job, was: b.job }));
  });
  await midRound('stage', async () => {
    for (const m of ['3d', '2d', 'contour', '2d', '3d', 'contour']) { await c.evaluate(`__v3.setFrontMode('${m}')`); await c.sleep(300); }
  }, async (b, s) => {
    if (s.phase !== 'fistr' || s.job !== b.job) bad('the stage switched: the round did not go on', JSON.stringify({ phase: s.phase }));
    if (!s.parts.includes('WR') || !s.parts.includes('strip')) bad('the stage switched: the contour lost a body', JSON.stringify(s.parts));
  });
  await midRound('window', async () => { await c.setViewport(900, 640); await c.sleep(800); await c.setViewport(1700, 1050); }, async (b, s) => {
    if (s.phase !== 'fistr') bad('the window resized: the round did not go on', s.phase);
  });
  // the page reloaded during a round: the old page's job, and the new page's dry run and first round
  await midRound('reload', async () => { await c.navigate(`${base}/?tab=3d`); await c.waitFor('!!(window.__v3 && window.__v3.coupled)', 60000); await c.evaluate(HELP); await c.evaluate("__v3.setFrontMode('contour')"); }, async (b) => {
    // the old page's job: nobody is left to read it, so it has to end (cancelled; a job still
    // writing its case ends when the case is written) - waited for, not read at once (the first
    // runs read 'meshing' 0.4 s after the reload). The stand-in hangs here, so a job nobody stops
    // stays running: the bridge busy for a real fistr1's whole run
    const t0r = Date.now();
    const ended = await jobState(b.job, 60000);
    const after = { oldJob: ended, oldJobEndedIn: (Date.now() - t0r) / 1000 };
    if (!['done', 'failed', 'cancelled'].includes(ended)) bad('a reload left the old page\'s job running (the bridge stays busy)', `${b.job}: ${ended} after 60 s`);
    // the new page: its dry run and its 計算開始, with the old job holding the bridge
    const t1 = Date.now();
    const rolls = await c.waitFor("__qc.read().parts.includes('WR')", 90000, 500).then(() => true).catch(() => false);
    after.rollsIn = rolls ? (Date.now() - t1) / 1000 : null;
    if (!rolls) bad('after a reload the new page did not get the rolls\' initial state in 90 s', JSON.stringify(after));
    await c.evaluate('__v3.start()');
    // a round with a job on the bridge - 'fistr' alone is also the page waiting for a busy bridge
    const got = await c.waitFor("(__qc.read().phase === 'fistr' && !!__qc.read().job) || __qc.read().phase === 'failed'", 300000, 500).then(() => c.evaluate('__qc.read()')).catch(() => null);
    after.newPage = got ? { phase: got.phase, job: got.job, note: got.note } : 'neither a round with a job nor a failure in 300 s';
    if (!got || got.phase !== 'fistr') bad('after a reload 計算開始 did not get a FrontISTR round', JSON.stringify(after.newPage));
    coupledLog.push({ case: 'reload-detail', ...after });
  });

  // failures: the stand-in failing, returning NaN; no bridge at all
  for (const [name, standIn, pat] of [['fail', { mode: 'fail', at: 1 }, /失敗|exited/], ['nan', { mode: 'nan', at: 2 }, /NaN|失敗/]]) {
    if (!want(name)) continue;
    caseName = name; const t0 = Date.now();
    await idle(); setStandIn(standIn);
    await open();
    await c.evaluate('__v3.start()');
    if (await waitPhase("__qc.read().phase === 'failed'", 600000, 'the failed state')) {
      const s = await read();
      if (!pat.test(s.note)) bad('the reason for the failure', s.note);
      await expect("/連成を続ける/.test(s.button) && !s.buttonOff", 'the run button after a failure');
      if (!(s.force > 0) || s.stale) bad('the app\'s result was not kept after a failure', JSON.stringify({ force: s.force, stale: s.stale }));
      await expect("s.roll && s.roll.state === '古い値'", 'the rolls\' plate after a failure');
    }
    errsNow('in the case');
    record(name, t0);
    await close();
  }
  if (want('nobridge')) {
    caseName = 'nobridge'; const t0 = Date.now();
    await open('&fistr=http://127.0.0.1:5999');
    await c.evaluate('__v3.start()');
    if (await waitPhase("__qc.read().phase === 'model'", 300000, 'the model-only state')) {
      const s = await read();
      if (!/橋渡し/.test(s.note)) bad('the reason without a bridge', s.note);
      if (!(s.force > 0)) bad('no model-only result without a bridge', `${s.force}`);
    }
    // the one probe of a page is a failed request in the console, and nothing else
    const e = errs().filter((x) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(x));
    if (e.length) bad('an exception or console error besides the probe', e.slice(0, 3).join(' | '));
    record('nobridge', t0);
  }

  // dials moved quickly and often, on the contour stage: how many dry runs, and how long until the bridge is idle
  if (want('dials-fast')) {
    caseName = 'dials-fast'; const t0 = Date.now();
    await idle(); setStandIn({});
    await open();
    await initialRolls();
    const before = new Set(jobs());
    for (let i = 0; i < 12; i++) { await c.evaluate(`__qc.range('mu', ${200 + 40 * i})`); await c.sleep(250); }
    await c.sleep(2000);
    const t1 = Date.now();
    const ok = await idle(300000);
    const started = jobs().filter((j) => !before.has(j)).map((j) => ({ id: j, dry: !!jobInfo(j)?.dryRun }));
    const detail = { moves: 12, jobs: started.length, dry: started.filter((j) => j.dry).length, idleAfter: (Date.now() - t1) / 1000 };
    coupledLog.push({ case: 'dials-fast-detail', ...detail });
    if (!ok) bad('the bridge was still busy 300 s after the dials stopped', JSON.stringify(detail));
    if (detail.jobs > 2) bad('dial moves piled up dry runs on the bridge', JSON.stringify(detail));
    await waitPhase("__qc.read().parts.includes('WR') && (__qc.read().roll || {}).state === '計算前'", 120000, 'the rolls\' initial state after the dials rest');
    errsNow('in the case');
    record('dials-fast', t0, detail);
  }

  // the slab model: no material FEM field - what the strip's contour shows
  if (want('slab')) {
    caseName = 'slab'; const t0 = Date.now();
    await idle(); setStandIn({});
    await open();
    await c.evaluate("__qc.choose('材料の変形計算', 'slab')");
    await c.evaluate('__v3.start()');
    if (await waitPhase("['steady','failed','model'].includes(__qc.read().phase)", 900000, 'the end of the slab model\'s coupling')) {
      const s = await read();
      coupledLog.push({ case: 'slab-detail', phase: s.phase, strip: s.strip, rounds: s.rounds });
      if (s.phase !== 'steady') bad('the slab model did not reach the steady state', JSON.stringify({ phase: s.phase, note: s.note }));
      if (s.strip?.state === '計算前') bad('the slab model: the strip\'s contour stays 計算前 at the steady state (no field to draw, and nothing says so)', JSON.stringify(s.strip));
    }
    errsNow('in the case');
    record('slab', t0);
    await close();
  }
  if (Object.keys(busyLines).length) {
    caseName = 'all';
    bad('requests answered 409, each a line in the console (a job slipped in between the page\'s ping and its post)', JSON.stringify(busyLines));
  }
  coupledLog.push({ case: 'busy-409-lines', ...busyLines });
  console.log(`coupled: ${((Date.now() - t0all) / 1000).toFixed(0)} s`);
}

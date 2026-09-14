// 最小の CDP クライアント（Node 22+ の組み込み WebSocket / fetch）。使い方は README.md。
//
// ポートは必須。既定値（9222 など）を持たせると、同じマシンで別の作業が立てた Chrome に
// 繋いでしまう。繋ぐのはそのポートの最初のページ — browser.sh で自分専用に立てた Chrome を
// 前提にしている（人が使っている Chrome のタブを掴まないため、ポートを共有しない）。
import { writeFileSync } from 'node:fs';

export async function connect(port) {
  if (!port) throw new Error('CDP_PORT が未指定（browser.sh で自分用に起動した Chrome のポートを渡す）');
  const base = `http://127.0.0.1:${port}`;
  const list = await (await fetch(`${base}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
    } else if (d.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
    } else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) {
      errors.push(`console.${d.params.type}: ` + d.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
      errors.push('log: ' + d.params.entry.text);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 固定 sleep ではなく「信号」で待つ（CLAUDE.md「検証の基本 1」）
  const waitFor = async (expr, timeout = 120000, interval = 100) => {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeout) {
      try { const v = await evaluate(expr); if (v) return v; } catch (e) { lastErr = e; }
      await sleep(interval);
    }
    throw new Error(`timeout ${timeout} ms: ${expr}${lastErr ? ' / ' + lastErr.message : ''}`);
  };
  const navigate = async (url) => {
    // 前の文書の readyState を拾わないよう、新しい文書になったことを確かめてから待つ
    await evaluate('window.__navMark = 1').catch(() => {});
    await send('Page.navigate', { url });
    await waitFor('!window.__navMark && document.readyState === "complete"', 60000);
  };
  const setViewport = (w, h, scale = 1) =>
    send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  const screenshot = async (path, clip) => {
    const params = { format: 'png' };
    if (clip) params.clip = clip;
    const r = await send('Page.captureScreenshot', params);
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  };
  return { send, evaluate, waitFor, navigate, setViewport, screenshot, errors, sleep, close: () => ws.close() };
}

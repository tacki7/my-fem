import { defineConfig, type Plugin } from 'vite';
import { frontistrHandler } from './tools/frontistr/bridge.mjs';

/** the FrontISTR cross-check's endpoints on the dev server (tools/frontistr/bridge.mjs); dev only */
const frontistrBridge = (): Plugin => ({
  name: 'frontistr-bridge',
  configureServer(server) { server.middlewares.use(frontistrHandler()); },
});

/**
 * The vite client reloads the page once the server answers again after its socket dropped - across a
 * sleep (the lid shut), a network change. That throws away a coupled calculation with FrontISTR of
 * half an hour. A page that says it is computing (`window.__rollfemHoldReload()`, the 3D tab) keeps
 * itself instead, and says so; its hot updates stop until it is reloaded by hand. Dev only.
 */
const holdReloadWhileComputing = (): Plugin => ({
  name: 'rollfem-hold-reload',
  apply: 'serve',
  enforce: 'post',
  transform(code, id) {
    if (!/vite\/dist\/client\/client\.mjs$/.test(id)) return null;
    const find = /(await waitForSuccessfulPing\([^)]*\);\s*)location\.reload\(\);/;
    if (!find.test(code)) {
      this.warn('rollfem-hold-reload: the client reload after a lost connection was not found - a sleep will reload a computing page');
      return null;
    }
    return code.replace(find, '$1if (window.__rollfemHoldReload?.()) { console.info("[rollfem] 計算中なので、接続が戻ったときのページの再読み込みを保留した（このページのホットリロードは止まる。計算の後に再読み込みすれば戻る）"); return; }\n      location.reload();');
  },
});

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  plugins: [frontistrBridge(), holdReloadWhileComputing()],
});

import { defineConfig, type Plugin } from 'vite';
import { frontistrHandler } from './tools/frontistr/bridge.mjs';

/** the FrontISTR cross-check's endpoints on the dev server (tools/frontistr/bridge.mjs); dev only */
const frontistrBridge = (): Plugin => ({
  name: 'frontistr-bridge',
  configureServer(server) { server.middlewares.use(frontistrHandler()); },
});

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  plugins: [frontistrBridge()],
});

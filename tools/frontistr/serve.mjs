// The FrontISTR bridge on its own, for a built app (npm run preview) or another origin:
//   node tools/frontistr/serve.mjs [port=5181]
// then open the app with ?fistr=http://localhost:5181. `npm run dev` serves the same
// endpoints itself (vite.config.ts), so this is not needed there.
import { createServer } from 'node:http';
import { frontistrHandler } from './bridge.mjs';

const port = Number(process.argv[2] ?? 5181);
const handler = frontistrHandler();
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  handler(req, res);
}).listen(port, '127.0.0.1', () => console.log(`FrontISTR bridge: http://localhost:${port}/__frontistr/ping`));

// 使い方: CDP_PORT=<自分の CDP ポート> node tools/browser/cdp-cli.mjs <コマンド> ...（README.md）
//   nav  <url> [settleMs=2000]              開く。読み込み〜settle 中の例外・console.error/warn を表示（あれば exit 2）
//   eval '<式>'                              ページ内で評価（await 可）し JSON で表示
//   wait '<式>' [timeoutMs=120000]           式が truthy になるまで待つ。値を表示。時間切れは exit 1
//   shot <out.png> [w=1700] [h=1050]         表示範囲のスクショ
//   crop <out.png> <x> <y> <w> <h> [scale=2] CSS px の矩形を拡大して切り出し
import { connect } from './cdp.mjs';

const [cmd, ...args] = process.argv.slice(2);
const port = process.env.CDP_PORT;
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
let code = 0;
let c;
try {
  c = await connect(port);
  switch (cmd) {
    case 'nav': {
      const [url, settle = '2000'] = args;
      await c.navigate(url);
      await c.sleep(+settle);
      out({ url: await c.evaluate('location.href'), errors: c.errors });
      if (c.errors.length) code = 2;
      break;
    }
    case 'eval':
      out(await c.evaluate(`(async () => (${args[0]}))()`));
      break;
    case 'wait':
      out(await c.waitFor(`(async () => (${args[0]}))()`, +(args[1] ?? 120000)));
      break;
    case 'shot': {
      const [path, w = '1700', h = '1050'] = args;
      await c.setViewport(+w, +h);
      await c.sleep(300);
      out(await c.screenshot(path));
      break;
    }
    case 'crop': {
      const [path, x, y, w, h, scale = '2'] = args;
      out(await c.screenshot(path, { x: +x, y: +y, width: +w, height: +h, scale: +scale }));
      break;
    }
    default:
      console.error('commands: nav | eval | wait | shot | crop');
      code = 64;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  code = 1;
} finally {
  c?.close();
}
process.exit(code);

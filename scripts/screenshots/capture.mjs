// Takes one screenshot with headless Chrome over the DevTools protocol.
// Usage: node capture.mjs <url> <out.png> <width> <height> [js to run before the shot]
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const [url, out, width, height, js] = process.argv.slice(2);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9300 + Math.floor(Math.random() * 600); // a fresh port, in case an earlier Chrome is still exiting
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'git-viewer-shot-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${width},${height}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  } catch {
    // Chrome is still starting
  }
}
if (!target) {
  chrome.kill();
  throw new Error('Chrome did not start. Set CHROME to the path of its binary.');
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
await send('Page.navigate', { url });
await sleep(2500);
if (js) {
  await send('Runtime.evaluate', { expression: js, awaitPromise: true });
  await sleep(1200);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
chrome.kill();
await new Promise((r) => chrome.once('exit', r));
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);

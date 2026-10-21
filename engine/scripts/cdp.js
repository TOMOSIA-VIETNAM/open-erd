// Dev-only: headless Chrome driven over the DevTools protocol, with Node's
// built-in WebSocket, for the scripts that check a rendered erd.svg in a real
// browser. CHROME_PATH overrides the binary.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Starts Chrome on about:blank with a throwaway profile (one shared with the
 * user's Chrome can hang on its lock) and connects to its page.
 * Returns { send(method, params), once(method), listeners, close() };
 * `listeners` receive every protocol event.
 */
export async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'open-erd-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank']);
  // A failed step throws; Chrome must not outlive the script.
  process.on('exit', () => chrome.kill());
  const port = await new Promise((done, fail) => {
    let text = '';
    chrome.stderr.on('data', (chunk) => {
      text += chunk;
      const m = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) done(m[1]);
    });
    chrome.on('exit', () => fail(new Error(`chrome exited before listening:\n${text}`)));
  });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { done, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(`${msg.error.message}`));
      else done(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++;
      pending.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const once = (method) => new Promise((done) => listeners.push((m) => m.method === method && done(m.params)));
  const close = async () => {
    socket.close();
    // Chrome writes into its profile until it has exited.
    const exited = new Promise((done) => chrome.once('exit', done));
    chrome.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  };
  return { send, once, listeners, close };
}

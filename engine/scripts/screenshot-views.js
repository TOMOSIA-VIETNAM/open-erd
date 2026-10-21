// Dev-only: screenshot every view of a rendered erd.svg with headless Chrome,
// so each view can be checked by eye. Only the overview is visible in the
// file itself; for each view this writes a copy where that view is the
// visible one and the root viewBox is the view's data-bounds, then
// screenshots the copy. The embedded viewer script is left out of the copies:
// it would take over the page and show its own toolbar and fitted view.
// Usage: node scripts/screenshot-views.js <erd.svg> <out dir>   (CHROME_PATH overrides the binary)
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('Usage: node scripts/screenshot-views.js <erd.svg> <out dir>');
  process.exit(1);
}

/** Copy of `svg` showing only view `name`, sized to that view. */
function showView(svg, name) {
  const views = [...svg.matchAll(/<g class="view" data-view="([^"]+)" data-bounds="([^"]+)"/g)];
  const match = views.find((m) => m[1] === name);
  if (!match) throw new Error(`no view "${name}"`);
  const [x, y, w, h] = match[2].split(' ');
  // The root's class (diff-mode in a diff drawing) carries styles.
  const rootClass = /^<svg [^>]*?( class="[^"]*")/.exec(svg)?.[1] ?? '';
  return svg
    .replace(/<script[\s\S]*?<\/script>\n?/g, '')
    .replace(/<svg [^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg"${rootClass} width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`)
    .replace(/(<g class="view" data-view="([^"]+)" data-bounds="[^"]+")( style="display:none")?>/g, (_, head, view) =>
      view === name ? `${head}>` : `${head} style="display:none">`,
    );
}

const svg = await readFile(input, 'utf8');
await mkdir(outDir, { recursive: true });
// A throwaway profile: headless Chrome sharing the user's profile can hang on
// its lock.
const profile = await mkdtemp(join(tmpdir(), 'open-erd-chrome-'));
for (const [, name, bounds] of svg.matchAll(/<g class="view" data-view="([^"]+)" data-bounds="([^"]+)"/g)) {
  const [, , w, h] = bounds.split(' ');
  const base = join(resolve(outDir), name.replace(/[:/]/g, '-'));
  await writeFile(`${base}.svg`, showView(svg, name));
  await promisify(execFile)(CHROME, [
    '--headless=new',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`,
    `--screenshot=${base}.png`,
    pathToFileURL(`${base}.svg`).href,
  ], { timeout: 60000 });
  console.log(`${base}.png  ${w}x${h}`);
}
await rm(profile, { recursive: true, force: true });

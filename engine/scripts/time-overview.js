// Dev-only: how long a rendered erd.svg takes to show its overview in headless
// Chrome. Each run navigates to the file from about:blank and waits until the
// overview view has a size on screen and the viewer toolbar exists, then two
// animation frames (the second one starts after the first paint). Reports the
// page-side time since navigation start for each run and the median.
// Usage: node scripts/time-overview.js <erd.svg> [runs]   (CHROME_PATH overrides the binary)
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './cdp.js';

const [input, runs = '5'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/time-overview.js <erd.svg> [runs]');
  process.exit(1);
}

const { send, once, close } = await launchChrome();
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

const painted = `new Promise((done) => {
  const ready = () => {
    const v = document.querySelector('g.view[data-view="overview"]');
    return v && v.style.display !== 'none' && v.getBoundingClientRect().width > 0 && document.querySelector('.oe-toolbar');
  };
  const wait = () => (ready() ? requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now()))) : setTimeout(wait, 5));
  wait();
})`;

const times = [];
for (let i = 0; i < Number(runs); i++) {
  const blank = once('Page.loadEventFired');
  await send('Page.navigate', { url: 'about:blank' });
  await blank;
  // The page polls from its DOMContentLoaded on until the overview is up.
  const parsed = once('Page.domContentEventFired');
  await send('Page.navigate', { url: pathToFileURL(resolve(input)).href });
  await parsed;
  const { result } = await send('Runtime.evaluate', { expression: painted, awaitPromise: true, returnByValue: true });
  times.push(Math.round(result.value));
  console.log(`run ${i + 1}: overview painted ${times.at(-1)} ms after navigation start`);
}
await close();
const sorted = [...times].sort((a, b) => a - b);
console.log(`median ${sorted[Math.floor(sorted.length / 2)]} ms`);

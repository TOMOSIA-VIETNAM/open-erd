// Dev-only: render sample strings as SVG <text> in headless Chrome with the
// embedded Inter subset and record the browser's widths into a test fixture, so
// unit tests can check measureText against a real browser without Chrome.
// Usage: node scripts/measure-chrome.js   (CHROME_PATH overrides the binary)
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { FONT_FAMILY, TEXT_STYLE_CSS, fontFaceCss } from '../src/text/font.js';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = fileURLToPath(new URL('../test/fixtures/chrome-text-widths.json', import.meta.url));
const SIZES = [12, 16];
const WEIGHTS = [400, 700];
// Identifiers, labels and kerning-prone pairs (AV, To, Yo, WA) that would expose
// any mismatch between summed advances and browser shaping.
const STRINGS = [
  'users',
  'created_by',
  'billing.public.invoices',
  'AVATAR',
  'Today You Wait',
  'WAVY Typography',
  'id',
  'bigint',
  'varchar(255)',
  'timestamp with time zone',
  'Payment confirmed by gateway',
  'One invoice per customer per billing cycle.',
  'tenant_id → users ×3',
  'ORDER_LINE_ITEMS',
  'snake_case_identifier_with_numbers_0123456789',
  'camelCaseIdentifier',
  'Mixed: (a, b) [c] {d} <e> "f" \'g\'',
  '«commentable»',
  'n-1 · optional',
  'Possibly renamed',
];

const samples = SIZES.flatMap((size) => WEIGHTS.flatMap((weight) => STRINGS.map((text) => ({ text, size, weight }))));

const html = `<!doctype html><meta charset="utf-8">
<style>${fontFaceCss()}
text { font-family: '${FONT_FAMILY}'; ${TEXT_STYLE_CSS} }</style>
<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"></svg>
<pre id="out"></pre>
<script>
const samples = ${JSON.stringify(samples)};
(async () => {
  for (const w of ${JSON.stringify(WEIGHTS)}) await document.fonts.load(w + " 16px ${FONT_FAMILY}");
  const svg = document.querySelector('svg');
  const results = samples.map((s) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('y', '50');
    t.style.fontSize = s.size + 'px';
    t.style.fontWeight = s.weight;
    t.textContent = s.text;
    svg.appendChild(t);
    const width = t.getComputedTextLength();
    t.remove();
    return { ...s, width };
  });
  const loaded = ${JSON.stringify(WEIGHTS)}.every((w) => document.fonts.check(w + " 16px ${FONT_FAMILY}"));
  document.getElementById('out').textContent = JSON.stringify({ loaded, userAgent: navigator.userAgent, results });
})();
</script>`;

const dir = await mkdtemp(join(tmpdir(), 'open-erd-measure-'));
try {
  const page = join(dir, 'measure.html');
  await writeFile(page, html);
  const { stdout } = await promisify(execFile)(
    CHROME,
    ['--headless=new', '--disable-gpu', '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(page).href],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const json = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1];
  if (!json) throw new Error('Chrome produced no measurements');
  const out = JSON.parse(json.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  if (!out.loaded) throw new Error('Inter did not load in Chrome; widths would come from a fallback font');
  const chrome = out.userAgent.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0] ?? out.userAgent;
  await writeFile(FIXTURE, `${JSON.stringify({ chrome, samples: out.results }, null, 1)}\n`);
  console.log(`wrote ${out.results.length} samples from ${chrome}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

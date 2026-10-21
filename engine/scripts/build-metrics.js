// Dev-only: regenerate the Inter metrics table and the embedded font from the
// pinned @fontsource/inter package. Run after upgrading that package; commit both
// outputs. Fontsource's `latin` files are already a Latin-only subset, so no
// subsetter is needed.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@fontsource/inter/package.json'));
const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
const outDir = fileURLToPath(new URL('../src/text/', import.meta.url));
const WEIGHTS = ['400', '700'];

const advances = {};
const fonts = {};
let unitsPerEm;
for (const weight of WEIGHTS) {
  const woff = await readFile(join(pkgDir, `files/inter-latin-${weight}-normal.woff`));
  const font = opentype.parse(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength));
  if (unitsPerEm !== undefined && unitsPerEm !== font.unitsPerEm) throw new Error('unitsPerEm differs between weights');
  unitsPerEm = font.unitsPerEm;
  const table = {};
  const codepoints = Object.keys(font.tables.cmap.glyphIndexMap).map(Number).sort((a, b) => a - b);
  for (const cp of codepoints) table[cp] = font.glyphs.get(font.tables.cmap.glyphIndexMap[cp]).advanceWidth;
  advances[weight] = table;
  // Browsers get WOFF2 (smaller); opentype.js only parses WOFF, hence two files per weight.
  fonts[weight] = (await readFile(join(pkgDir, `files/inter-latin-${weight}-normal.woff2`))).toString('base64');
}

const source = `${pkg.name}@${pkg.version} latin subset`;
await writeFile(join(outDir, 'inter-metrics.json'), `${JSON.stringify({ source, unitsPerEm, advances }, null, 1)}\n`);
const license = await readFile(join(pkgDir, 'LICENSE'), 'utf8');
await writeFile(join(outDir, 'inter-subset.json'), `${JSON.stringify({ source, license, woff2: fonts }, null, 1)}\n`);
console.log(`wrote inter-metrics.json and inter-subset.json from ${source}`);

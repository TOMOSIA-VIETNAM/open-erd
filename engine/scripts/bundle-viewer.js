// Bundles the viewer (src/render/svg/viewer/) into one script string and
// writes it to src/render/svg/viewer-bundle.json, which the renderer inlines
// into every erd.svg. Generated once per change and committed, like the font
// metrics: the engine has no file access to its own sources once bundled.
// test/viewer.test.js fails when the committed bundle is stale.
// Usage: node scripts/bundle-viewer.js
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isMain } from '../is-main.js';
import { build } from 'esbuild';

export const ENTRY = fileURLToPath(new URL('../src/render/svg/viewer/index.js', import.meta.url));
export const OUTPUT = fileURLToPath(new URL('../src/render/svg/viewer-bundle.json', import.meta.url));

/** The viewer as one IIFE script, the exact text embedded in the SVG. */
export async function bundleViewer() {
  const result = await build({
    entryPoints: [ENTRY],
    // Source path comments in the output are relative to this directory;
    // pinning it keeps the bundle identical whichever cwd runs the script.
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    bundle: true,
    format: 'iife',
    // Browsers that open a standalone SVG with script: current Chrome and Safari.
    target: ['chrome100', 'safari15'],
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export const serializeBundle = (source) => `${JSON.stringify({ source }, null, 2)}\n`;

if (isMain(import.meta.url)) {
  await writeFile(OUTPUT, serializeBundle(await bundleViewer()));
  console.log(`wrote ${OUTPUT}`);
}

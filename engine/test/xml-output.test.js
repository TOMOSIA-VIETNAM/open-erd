import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeLayout } from '../src/layout/index.js';
import { renderDrawio } from '../src/render/drawio/render.js';
import { renderSvg } from '../src/render/svg/render.js';
import { escapeXml } from '../src/render/xml.js';
import { loadMulti } from './helpers/shop.js';
import { parseXml } from './helpers/xml.js';

const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

test('escapeXml escapes markup and drops control characters XML cannot hold', () => {
  assert.equal(escapeXml('a<b>&"c"\x01\x0B\x1F\t\n'), 'a&lt;b&gt;&amp;&quot;c&quot;\t\n');
});

test('a control character in a table name or note leaves valid SVG and draw.io XML', async () => {
  const model = JSON.parse(JSON.stringify(await loadMulti()).replaceAll('shop._.brands', 'shop._.br\\u0001ands').replaceAll('Brand', 'Br\\u0002and'));
  assert.ok(JSON.stringify(model).includes('br\\u0001ands'));
  const { layout } = await computeLayout(model);
  for (const xml of [renderSvg(model, layout), renderDrawio(model, layout)]) {
    assert.ok(!CONTROL.test(xml));
    // The viewer script is CDATA, which the test parser does not read.
    parseXml(xml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  }
});

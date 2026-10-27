import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHash, parseHash } from '../src/render/svg/viewer/deep-link.js';

test('deep link: key, decoded value, and the value as a list of ids', () => {
  const one = parseHash('#table=shop._.orders');
  assert.deepEqual([one.key, one.value, one.ids, one.view], ['table', 'shop._.orders', ['shop._.orders'], null]);
  // Dotted ids, encoded or not; spaces trimmed, empty items and repeats dropped.
  assert.deepEqual(parseHash('#tables=shop._.orders,%20auth.public.users,,shop._.orders,').ids, ['shop._.orders', 'auth.public.users']);
  assert.deepEqual(parseHash('#path=a.b.c%2Cd,e.f.g').ids, ['a.b.c,d', 'e.f.g']);
  // Only the first = splits key from value.
  const view = parseHash('#view=domain:shop/x=y');
  assert.deepEqual([view.key, view.value, view.view], ['view', 'domain:shop/x=y', null]);
  assert.deepEqual(parseHash('tables=a.b.c').ids, ['a.b.c']);
});

test('deep link: the view a selection is seen in, written and read back', () => {
  // `=` and `&` stay separators; inside a value they are encoded.
  const hash = formatHash([['view', 'domain:shop/Billing & Tax'], ['table', 'shop._.orders']]);
  assert.equal(hash, '#view=domain:shop/Billing%20%26%20Tax&table=shop._.orders');
  const back = parseHash(hash);
  assert.deepEqual([back.key, back.value, back.view], ['table', 'shop._.orders', 'domain:shop/Billing & Tax']);
  assert.equal(formatHash([['column', 'shop._.orders.status']]), '#column=shop._.orders.status');
  // An address copied from an older viewer, its = encoded.
  assert.equal(parseHash('#table%3Dshop.public.assets').value, 'shop.public.assets');
});

test('deep link: every pair of a link, as the viewer writes it', () => {
  const hash = formatHash([['related', 'shop._.orders'], ['hops', '2'], ['table', 'shop._.payments'], ['highlight', 'pii,health']]);
  assert.equal(hash, '#related=shop._.orders&hops=2&table=shop._.payments&highlight=pii,health');
  const { params, key } = parseHash(hash);
  assert.equal(key, 'related');
  assert.deepEqual(Object.keys(params), ['related', 'hops', 'table', 'highlight']);
  assert.deepEqual(params.highlight.ids, ['pii', 'health']);
  // A diff's link with no mode on still says so; a key written twice keeps its first value.
  assert.deepEqual(parseHash('#view=all&highlight=').params.highlight, { value: '', ids: [] });
  assert.equal(parseHash('#path=a.b.c,d.e.f&option=2&option=3').params.option.value, '2');
});

test('deep link: no key, no hash or broken encoding is no link', () => {
  for (const hash of ['', '#', '#tables', '#=a.b.c', '#tables=%E0%A4%A', null, undefined]) assert.equal(parseHash(hash), null, String(hash));
  assert.deepEqual(parseHash('#tables=').ids, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHash } from '../src/render/svg/viewer/deep-link.js';

test('deep link: key, decoded value, and the value as a list of ids', () => {
  assert.deepEqual(parseHash('#table=shop._.orders'), { key: 'table', value: 'shop._.orders', ids: ['shop._.orders'] });
  // Dotted ids, encoded or not; spaces trimmed, empty items and repeats dropped.
  assert.deepEqual(parseHash('#tables=shop._.orders,%20auth.public.users,,shop._.orders,').ids, ['shop._.orders', 'auth.public.users']);
  assert.deepEqual(parseHash('#path=a.b.c%2Cd,e.f.g').ids, ['a.b.c,d', 'e.f.g']);
  // Only the first = splits key from value.
  assert.deepEqual(parseHash('#view=domain:shop/x=y'), { key: 'view', value: 'domain:shop/x=y', ids: ['domain:shop/x=y'] });
  assert.deepEqual(parseHash('tables=a.b.c').ids, ['a.b.c']);
});

test('deep link: no key, no hash or broken encoding is no link', () => {
  for (const hash of ['', '#', '#tables', '#=a.b.c', '#tables=%E0%A4%A', null, undefined]) assert.equal(parseHash(hash), null, String(hash));
  assert.deepEqual(parseHash('#tables=').ids, []);
});

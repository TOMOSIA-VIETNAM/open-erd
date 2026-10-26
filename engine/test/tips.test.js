import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTip, tipList } from '../src/render/svg/viewer/tips.js';

test('tips: unseen first, then round the list after the last one shown', () => {
  const tips = tipList('⌘');
  assert.equal(new Set(tips.map((t) => t.id)).size, tips.length);
  assert.deepEqual(tips[0].parts[0], { key: '⌘K' });
  assert.equal(nextTip(tips, [], null).id, tips[0].id);
  assert.equal(nextTip(tips, [tips[0].id], tips[0].id).id, tips[1].id);
  const all = tips.map((t) => t.id);
  assert.equal(nextTip(tips, all, tips[2].id).id, tips[3].id);
  assert.equal(nextTip(tips, all, tips.at(-1).id).id, tips[0].id);
  assert.equal(nextTip([], [], null), null);
});

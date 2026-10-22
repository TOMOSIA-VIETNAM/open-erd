import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyHistory, goBack, goForward, tableTrail, visit } from '../src/render/svg/viewer/history.js';

const at = (view, table = null) => ({ view, table });

test('history: visit, back twice, forward, and a new visit drops the way forward', () => {
  let h = emptyHistory();
  h = visit(h, at('all', 'a'));
  h = visit(h, at('all', 'b'));
  // Now on c.
  let step = goBack(h, at('all', 'c'));
  assert.deepEqual(step.target, at('all', 'b'));
  step = goBack(step.history, step.target);
  assert.deepEqual(step.target, at('all', 'a'));
  assert.equal(goBack(step.history, step.target).target, null);
  const fwd = goForward(step.history, step.target);
  assert.deepEqual(fwd.target, at('all', 'b'));
  assert.deepEqual(goForward(fwd.history, fwd.target).target, at('all', 'c'));
  // Somewhere new from b: c is no longer ahead.
  const branched = visit(fwd.history, fwd.target);
  assert.deepEqual(branched.forward, []);
  assert.deepEqual(branched.back.map((s) => s.table), ['a', 'b']);
  assert.equal(goForward(branched, at('overview')).target, null);
});

test('history: kept to a limit; the table trail is the last tables, repeats once', () => {
  let h = emptyHistory();
  for (let i = 0; i < 60; i++) h = visit(h, at('all', `t${i}`), 50);
  assert.equal(h.back.length, 50);
  assert.equal(h.back[0].table, 't10');
  let t = emptyHistory();
  for (const step of [at('overview'), at('domain:x', 'a'), at('domain:x', 'b'), at('domain:x', 'b'), at('all'), at('all', 'c')]) t = visit(t, step);
  assert.deepEqual(tableTrail(t, at('all', 'd')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tableTrail(t, at('all', 'd'), 2), ['c', 'd']);
  assert.deepEqual(tableTrail(emptyHistory(), at('all', 'a')), ['a']);
});

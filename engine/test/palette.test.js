import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFirst, matchCommands, parseJoinQuery } from '../src/render/svg/viewer/palette.js';

test('a join path query is two names around >, -> or →', () => {
  assert.deepEqual(parseJoinQuery('users > orders'), { from: 'users', to: 'orders' });
  assert.deepEqual(parseJoinQuery('users->orders'), { from: 'users', to: 'orders' });
  assert.deepEqual(parseJoinQuery(' users → orders '), { from: 'users', to: 'orders' });
  // While typed, either side may still be empty.
  assert.deepEqual(parseJoinQuery('users >'), { from: 'users', to: '' });
  assert.equal(parseJoinQuery('users'), null);
  assert.equal(parseJoinQuery('user-id'), null);
});

const COMMANDS = [{ label: 'Join path…' }, { label: 'Tour' }, { label: 'Personal data (PII)', keywords: ['privacy'] }, { label: 'Download as PNG', keywords: ['export'] }];
const labels = (matches) => matches.map((m) => m.command.label);

test('commands match on a word start first, then inside the label or a keyword', () => {
  assert.deepEqual(labels(matchCommands('', COMMANDS)), COMMANDS.map((c) => c.label));
  assert.deepEqual(labels(matchCommands('pii', COMMANDS)), ['Personal data (PII)']);
  assert.deepEqual(labels(matchCommands('png', COMMANDS)), ['Download as PNG']);
  assert.deepEqual(labels(matchCommands('priv', COMMANDS)), ['Personal data (PII)']);
  assert.equal(matchCommands('priv', COMMANDS)[0].score, 1);
  // A word start ("as") before matches inside a label, which keep their order.
  assert.deepEqual(labels(matchCommands('a', COMMANDS)), ['Download as PNG', 'Join path…', 'Personal data (PII)']);
  assert.deepEqual(matchCommands('zzz', COMMANDS), []);
});

test('commands go first only when no table or column name starts with the text', () => {
  const tour = matchCommands('tour', COMMANDS);
  assert.equal(commandsFirst('tour', tour, ['user_tours', 'tour_id']), false);
  assert.equal(commandsFirst('tour', tour, ['user_tours']), true);
  assert.equal(commandsFirst('tour', tour, []), true);
  // A match inside a label never jumps ahead of the tables.
  assert.equal(commandsFirst('priv', matchCommands('priv', COMMANDS), []), false);
  assert.equal(commandsFirst('', matchCommands('', COMMANDS), []), false);
});

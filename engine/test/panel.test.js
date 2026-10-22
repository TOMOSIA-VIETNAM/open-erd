import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnBadges, panelTabs } from '../src/render/svg/viewer/panel-parts.js';

const texts = (c) => columnBadges(c).map((b) => b.text);

test('column chips: NULL only when nullable, the default, generated, enum count, PII', () => {
  assert.deepEqual(texts({ name: 'id', type: 'bigint', pk: true, autoIncrement: true, nullable: false }), ['= auto']);
  assert.deepEqual(texts({ name: 'note', type: 'text' }), []);
  assert.deepEqual(texts({ name: 'deleted_at', type: 'datetime', nullable: true }), ['NULL']);
  assert.deepEqual(texts({ name: 'status', type: 'varchar', nullable: false, default: 'draft', enum: { draft: 'Not sent', paid: '' } }), ['= draft', '2 values']);
  assert.deepEqual(texts({ name: 'kind', type: 'int', enum: { 1: '' } }), ['1 value']);
  assert.deepEqual(texts({ name: 'total', type: 'numeric', nullable: true, generated: 'a + b' }), ['NULL', 'generated']);
  assert.deepEqual(texts({ name: 'email', type: 'varchar', nullable: true, pii: true }), ['NULL', 'PII']);
  // A default wins over the auto-increment chip; the default's value is in the tooltip.
  const [d] = columnBadges({ name: 'n', type: 'int', default: '0', autoIncrement: true });
  assert.deepEqual([d.kind, d.text, d.title], ['default', '= 0', 'Default value: 0']);
});

test('panel tabs: Columns, Relations, Indexes with counts; empty ones left out', () => {
  const node = { columns: [{ name: 'id' }, { name: 'a' }], indexes: [{ columns: ['a'] }] };
  assert.deepEqual(panelTabs(node, 3).map((t) => `${t.id}:${t.count}`), ['columns:2', 'relations:3', 'indexes:1']);
  assert.deepEqual(panelTabs({ columns: [{ name: 'id' }] }, 0).map((t) => t.id), ['columns']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiagram } from '../src/layout/diagram.js';
import { viewerData } from '../src/render/svg/render.js';
import { IMPACT_DEPTH, impactRings, referencedColumns } from '../src/render/svg/viewer/impact.js';
import { loadMulti } from './helpers/shop.js';

const dataOf = (model) => viewerData(model, buildDiagram(model));
// Ring by ring, each table with the edges that put it there.
const ids = (rings) => rings.map((r) => r.map((t) => t.id));
const edgesOf = (rings, id) => rings.flat().find((t) => t.id === id).edges.map((e) => e.id);

test('rings walk the references backwards: polymorphic owners and cross-DB tables included', async () => {
  const data = dataOf(await loadMulti());
  const rings = impactRings(data, 'shop._.orders');
  assert.deepEqual(ids(rings), [
    // notifications is in another database; attachments and comments point at orders through their polymorphic association.
    ['activity._.notifications', 'shop._.attachments', 'shop._.comments', 'shop._.order_items', 'shop._.payments'],
    ['shop._.refunds'],
  ]);
  assert.deepEqual(edgesOf(rings, 'shop._.attachments'), ['shop._.attachments(attachable_id)->«attachable»->shop._.orders']);
  assert.deepEqual(edgesOf(rings, 'shop._.refunds'), ['shop._.refunds(payment_id)->shop._.payments(id)']);
});

test('a table is listed once, in its smallest ring, with every edge reaching that ring', async () => {
  const data = dataOf(await loadMulti());
  const rings = impactRings(data, 'auth.public.users');
  const all = rings.flat().map((t) => t.id);
  assert.equal(all.length, new Set(all).size);
  // products references users twice (created_by, updated_by): ring 1, both relations.
  assert.ok(rings[0].some((t) => t.id === 'shop._.products'));
  assert.deepEqual(edgesOf(rings, 'shop._.products'), ['shop._.products(created_by)->auth.public.users(id)', 'shop._.products(updated_by)->auth.public.users(id)']);
  // orders references users (ring 1) and organizations (ring 1 too): never again in ring 2.
  assert.ok(!rings[1].some((t) => t.id === 'shop._.orders'));
  // A further ring follows the earliest table of the previous ring it hangs off.
  const parents = rings[1].map((t) => Math.min(...t.edges.map((e) => rings[0].findIndex((p) => p.id === e.b))));
  assert.deepEqual(parents, [...parents].sort((a, b) => a - b));
});

test('a column counts only the relations keyed on it; deeper rings take whole tables', async () => {
  const data = dataOf(await loadMulti());
  assert.deepEqual(ids(impactRings(data, 'auth.public.organizations', 'id')), [
    ['activity._.audit_logs', 'auth.public.invitations', 'auth.public.memberships', 'shop._.orders'],
    ['activity._.notifications', 'shop._.attachments', 'shop._.comments', 'shop._.order_items', 'shop._.payments'],
    ['shop._.refunds'],
  ]);
  assert.deepEqual(impactRings(data, 'auth.public.organizations', 'name'), []);
  assert.deepEqual([...referencedColumns(data, 'auth.public.organizations')], ['id']);
  assert.deepEqual([...referencedColumns(data, 'activity._.audit_logs')], []);
});

test('self-references add nothing; a collapsed join table is a referencing table of its own', async () => {
  const data = dataOf(await loadMulti());
  // categories references itself (parent_id): ring 1 is products only.
  assert.deepEqual(ids(impactRings(data, 'shop._.categories', null, 1)), [['shop._.products']]);
  assert.deepEqual([...referencedColumns(data, 'shop._.categories')], ['id']);
  // tags <- product_tags -> products: the join table depends on tags, products does not.
  assert.deepEqual(ids(impactRings(data, 'shop._.tags')), [['shop._.product_tags']]);
});

test('depth caps the rings; a table nothing references has none', async () => {
  const data = dataOf(await loadMulti());
  assert.equal(IMPACT_DEPTH, 3);
  assert.equal(impactRings(data, 'auth.public.users').length, 3);
  assert.deepEqual(ids(impactRings(data, 'auth.public.users', null, 2)), ids(impactRings(data, 'auth.public.users')).slice(0, 2));
  assert.equal(impactRings(data, 'auth.public.users', null, 1).length, 1);
  assert.deepEqual(impactRings(data, 'activity._.audit_logs'), []);
});

test('a hub table is a full target, but met in a ring it is not walked further', () => {
  const link = (from, to) => ({ id: `${from}->${to}`, from, to, fromColumns: [`${to}_id`], toColumns: ['id'], cardinality: 'n-1', kind: 'db_fk', review: 'reviewed' });
  const data = {
    nodes: {},
    links: [link('companies', 'plans')],
    hubLinks: [link('orders', 'companies'), link('invoices', 'companies')],
  };
  assert.deepEqual(ids(impactRings(data, 'companies')), [['invoices', 'orders']]);
  const rings = impactRings(data, 'plans');
  assert.deepEqual(ids(rings), [['companies']]);
  assert.equal(rings[0][0].hub, true);
});

test('a view reading a table depends on it, for the table only', () => {
  const data = {
    nodes: {},
    links: [{ id: 'report=>orders', from: 'report', to: 'orders', kind: 'view_source', review: 'reviewed' }],
    hubLinks: [],
  };
  assert.deepEqual(ids(impactRings(data, 'orders')), [['report']]);
  assert.deepEqual(impactRings(data, 'orders', 'id'), []);
});

test('the same rings whatever order the data lists relations in', async () => {
  const data = dataOf(await loadMulti());
  const shuffled = { ...data, links: [...data.links].reverse(), hubLinks: [...data.hubLinks].reverse() };
  for (const target of ['auth.public.users', 'shop._.orders', 'auth.public.organizations']) {
    const strip = (rings) => rings.map((r) => r.map((t) => [t.id, t.hub, t.edges.map((e) => e.id)]));
    assert.deepEqual(strip(impactRings(shuffled, target)), strip(impactRings(data, target)), target);
  }
});

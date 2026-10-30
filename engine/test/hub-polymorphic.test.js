import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffModels } from '../src/diff/changes.js';
import { diffMarks, unionModel } from '../src/diff/union.js';
import { buildDiagram, domainPairs, factText, polyLinkId, polyNodeId } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { healthFindings } from '../src/model/health.js';
import { normalizeModel } from '../src/model/load.js';
import { missingRelations } from '../src/model/missing.js';
import { applyProfile } from '../src/model/profile.js';
import { renderDrawio } from '../src/render/drawio/render.js';
import { buildScene, renderSvg, viewerData } from '../src/render/svg/render.js';
import { loadMulti } from './helpers/shop.js';

// Audit and ownership associations on two tables of two domains, whose id
// columns are hub columns: each is a badge on its owner, never a node.
const USERS = 'auth.public.users';
const ORGS = 'auth.public.organizations';
const OWNERS = ['shop._.orders', 'shop._.products'];
const association = (table, name) => ({
  name,
  table,
  type_column: `${name}_type`,
  id_column: `${name}_id`,
  optional: true,
  targets: [USERS, ORGS],
  evidence: ['shop-api:app/models/concerns/audited.rb#Audited'],
  review: 'reviewed',
});

function audited(model, { hub = true, owners = OWNERS, names = ['edited_by', 'owner'] } = {}) {
  const columns = names.flatMap((n) => [
    { name: `${n}_type`, type: 'varchar' },
    { name: `${n}_id`, type: 'bigint' },
  ]);
  const hubColumns = hub ? names.flatMap((n) => [`${n}_type`, `${n}_id`]) : [];
  return normalizeModel({
    ...model,
    config: { ...model.config, hub: { ...model.config.hub, columns: [...(model.config.hub?.columns ?? []), ...hubColumns] } },
    tables: model.tables.map((t) => (owners.includes(t.id) ? { ...t, columns: [...t.columns, ...columns] } : t)),
    polymorphic: [...model.polymorphic, ...owners.flatMap((t) => names.map((n) => association(t, n)))],
  });
}

test('a hub association is a badge line on its owner: no virtual node, no line, in any view', async () => {
  const model = audited(await loadMulti());
  const { layout } = await computeLayout(model);
  const diagram = buildDiagram(model);
  for (const t of OWNERS) {
    for (const name of ['edited_by', 'owner']) {
      const a = model.polymorphic.find((x) => x.table === t && x.name === name);
      assert.ok(!diagram.nodes.has(polyNodeId(a)), `${polyNodeId(a)} is a node`);
      assert.ok(!diagram.links.some((l) => l.id === polyLinkId(a)), `${polyLinkId(a)} is a line`);
    }
  }
  // Business associations are untouched.
  assert.ok(diagram.nodes.has('shop._.comments«commentable»'));
  assert.deepEqual(
    diagram.hubAssociations.map((a) => `${a.table}«${a.name}»`),
    ['shop._.orders«edited_by»', 'shop._.orders«owner»', 'shop._.products«edited_by»', 'shop._.products«owner»'],
  );
  for (const view of ['all', 'domain:shop/Orders', 'domain:shop/Catalog']) {
    const scene = buildScene(model, layout, view, diagram);
    assert.ok(!scene.nodes.some((n) => n.kind === 'poly' && n.node.association.name !== 'commentable' && n.node.association.name !== 'attachable'), view);
    assert.ok(!scene.relations.some((r) => r.link.kind === 'polymorphic' && !/«(commentable|attachable)»/.test(r.link.id)), view);
  }
  // The overview leaves them out, like hub relations.
  for (const pair of domainPairs(diagram)) assert.ok(!pair.relations.some((r) => r.association === 'edited_by' || r.association === 'owner'), pair.id);
});

test('two hub associations on one table are two distinct badge lines naming each one', async () => {
  const model = audited(await loadMulti());
  const diagram = buildDiagram(model);
  const box = diagram.nodes.get('shop._.products').box;
  const lines = box.badges.map((b) => `${b.name ? `${b.name.text} → ` : '→ '}${b.label.text}`);
  // The plain hub relation badge comes first, unchanged.
  assert.deepEqual(lines, ['→ users ×2', '«edited_by» → organizations | users', '«owner» → organizations | users']);
  assert.equal(new Set(box.badges.map((b) => b.centerY)).size, 3);
  for (const b of box.badges) assert.ok(b.labelX + b.label.width <= box.w, `${b.label.text} overflows`);
  const svg = renderSvg(model, (await computeLayout(model)).layout);
  assert.match(svg, /<g class="hub-badge" data-association="edited_by" data-targets="\[&quot;auth\.public\.organizations&quot;,&quot;auth\.public\.users&quot;\]" data-columns="\[&quot;edited_by_type&quot;,&quot;edited_by_id&quot;\]"><title>«edited_by» \(edited_by_type \/ edited_by_id\) → auth\.public\.organizations \| auth\.public\.users<\/title>/);
});

test('a long target list is cut to the box width, the association name kept', async () => {
  const multi = await loadMulti();
  const many = multi.tables.filter((t) => t.id.startsWith('shop.')).map((t) => t.id);
  const model = audited(multi, { owners: ['shop._.orders'], names: ['edited_by'] });
  const wide = normalizeModel({ ...model, polymorphic: model.polymorphic.map((a) => (a.name === 'edited_by' ? { ...a, targets: many } : a)) });
  const box = buildDiagram(wide).nodes.get('shop._.orders').box;
  const badge = box.badges.find((b) => b.association === 'edited_by');
  assert.equal(badge.name.text, '«edited_by»');
  assert.ok(badge.label.truncated);
  assert.ok(badge.labelX + badge.label.width <= box.w - 12);
});

test('targets of a hub association get no "polymorphic from" line; the viewer lists the association on owner and targets', async () => {
  const model = audited(await loadMulti());
  const diagram = buildDiagram(model);
  for (const id of [USERS, ORGS]) {
    assert.ok(!(diagram.nodes.get(id).facts ?? []).some((f) => factText(f).includes('edited_by_id') || factText(f).includes('owner_id')), id);
  }
  const data = viewerData(model, diagram);
  assert.deepEqual(
    data.hubAssociations.map((a) => [a.table, a.name, a.typeColumn, a.idColumn, a.targets]),
    OWNERS.flatMap((t) => ['edited_by', 'owner'].map((n) => [t, n, `${n}_type`, `${n}_id`, [ORGS, USERS]])),
  );
  assert.ok(!Object.values(data.nodes).some((n) => n.kind === 'poly' && (n.name === 'edited_by' || n.name === 'owner')));
});

test('hub columns never look like a missing relation; a table linked only through hub associations is no orphan', async () => {
  const multi = await loadMulti();
  // A hub column pair no association uses yet.
  const bare = audited(multi, { owners: [] });
  const withColumns = {
    ...bare,
    tables: bare.tables.map((t) => (t.id === 'shop._.orders' ? { ...t, columns: [...t.columns, { name: 'edited_by_type', type: 'varchar' }, { name: 'edited_by_id', type: 'bigint' }] } : t)),
  };
  assert.deepEqual(missingRelations(withColumns), []);
  // The same pair without the hub is a polymorphic warning, as before.
  const plain = { ...withColumns, config: multi.config };
  assert.deepEqual(missingRelations(plain).map((w) => [w.kind, w.column]), [['polymorphic', 'edited_by_id']]);

  const lonely = { id: 'shop._.settings', domain: 'Catalog', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'value', type: 'text' }] };
  const alone = audited({ ...multi, tables: [...multi.tables, lonely] }, { owners: ['shop._.settings'], names: ['edited_by'] });
  assert.deepEqual(missingRelations(alone), []);
  assert.ok(!healthFindings(alone).some((f) => f.kind === 'orphan_table'));
  assert.deepEqual(buildDiagram(alone).nodes.get('shop._.settings').box.badges.map((b) => b.association), ['edited_by']);
});

test('diff: an added or removed hub association marks its owner table, with no virtual node', async () => {
  const multi = await loadMulti();
  const from = audited(multi);
  const to = normalizeModel({ ...from, polymorphic: from.polymorphic.filter((a) => !(a.table === 'shop._.orders' && a.name === 'owner')) });
  for (const [a, b, kind] of [
    [from, to, 'polymorphic_removed'],
    [to, from, 'polymorphic_added'],
  ]) {
    const result = diffModels(a, b);
    assert.deepEqual(result.changes.map((c) => c.kind), [kind]);
    const union = unionModel(a, b, result);
    const marks = diffMarks(union, result.changes);
    assert.equal(marks.nodes.get('shop._.orders'), 'changed');
    assert.ok(![...marks.nodes.keys()].some((id) => id.includes('«')), kind);
    assert.equal(marks.links.size, 0);
    assert.equal(marks.sentences.nodes.get('shop._.orders').length, 1);
    // The removed association is drawn back as a badge on the owner.
    assert.ok(buildDiagram(union).nodes.get('shop._.orders').box.badges.some((x) => x.association === 'owner'), kind);
  }
});

test('profiles: a hidden target leaves the badge, a badge whose targets are all hidden goes', async () => {
  const model = audited(await loadMulti());
  const hideOrgs = { ...model, config: { ...model.config, hidden: { tables: [ORGS] } } };
  const shared = applyProfile(hideOrgs, 'public');
  const badge = buildDiagram(shared).nodes.get('shop._.orders').box.badges.find((b) => b.association === 'owner');
  assert.deepEqual(badge.targets, [USERS]);
  assert.equal(badge.label.text, 'users');
  const hideBoth = { ...model, config: { ...model.config, hidden: { tables: [ORGS, USERS] } } };
  const none = buildDiagram(applyProfile(hideBoth, 'public'));
  assert.deepEqual(none.hubAssociations, []);
  assert.ok(!none.nodes.get('shop._.orders').box.badges.some((b) => b.association));
});

test('associations that become hub: render stops on the old layout, layout drops their virtual nodes', async () => {
  const before = audited(await loadMulti(), { hub: false });
  const { layout: old } = await computeLayout(before);
  const nodeIds = (layout) => Object.values(layout.views.all.clusters).flatMap((members) => Object.keys(members));
  assert.ok(nodeIds(old).includes('shop._.orders«owner»'));
  const after = audited(await loadMulti());
  assert.throws(() => renderSvg(after, old), /out of date/);
  const { layout } = await computeLayout(after, old);
  assert.ok(!nodeIds(layout).some((id) => /«(edited_by|owner)»/.test(id)));
  renderSvg(after, layout);
});

test('draw.io: a hub association is a badge row naming it, and no polymorphic node', async () => {
  const model = audited(await loadMulti());
  const { layout } = await computeLayout(model);
  const xml = renderDrawio(model, layout);
  assert.ok(xml.includes('«owner» → organizations | users'));
  assert.ok(!xml.includes('shop._.orders«owner»'));
});

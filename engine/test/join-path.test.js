import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiagram } from '../src/layout/diagram.js';
import { applyProfile } from '../src/model/profile.js';
import { viewerData } from '../src/render/svg/render.js';
import { HUB_COST, MAX_PATHS, MAX_TIED_PATHS, SHARED_PARENT_COST,describeHop, findJoinPaths, hopCondition, pathNames, pathThrough, sqlNames, sqlSkeleton } from '../src/render/svg/viewer/join-path.js';
import { fk, loadMulti, table } from './helpers/shop.js';

// The conditions of a path, one hop per line, as the panel lists them.
const conditionsText = (path) => {
  const name = pathNames(path.nodes);
  return path.hops
    .map((h) => {
      const poly = h.flags.find((f) => f.type === 'polymorphic');
      return `${hopCondition(h, name)}${poly ? ` (filter by ${name(poly.table)}.${poly.column})` : ''}`;
    })
    .join('\n');
};

const dataOf = (model) => viewerData(model, buildDiagram(model));
const route = (p) => p.nodes.join(' > ');
const flagTypes = (hop) => hop.flags.map((f) => f.text ?? f.type);

test('a join table collapsed into one line is walked as two hops, with its key columns', async () => {
  const data = dataOf(await loadMulti());
  const [best] = findJoinPaths(data, 'shop._.tags', 'shop._.order_items');
  assert.equal(route(best), 'shop._.tags > shop._.product_tags > shop._.products > shop._.order_items');
  assert.equal(conditionsText(best), ['tags.id = product_tags.tag_id', 'product_tags.product_id = products.id', 'products.id = order_items.product_id'].join('\n'));
  // tags -> product_tags is one tag to many rows, and pending inference.
  assert.deepEqual(flagTypes(best.hops[0]), ['inferred', 'multiplies']);
  assert.deepEqual(flagTypes(best.hops[1]), []);
});

test('three paths for this pair, cheapest first, the same list on every call', async () => {
  const data = dataOf(await loadMulti());
  const a = findJoinPaths(data, 'shop._.refunds', 'auth.public.users');
  assert.equal(a.length, 3);
  assert.ok(a.every((p, i) => i === 0 || a[i - 1].cost <= p.cost));
  assert.deepEqual(findJoinPaths(data, 'shop._.refunds', 'auth.public.users'), a);
  assert.deepEqual(findJoinPaths(data, 'shop._.refunds', 'shop._.refunds'), []);
});

test('equal costs are ordered by table ids, whatever order the data lists them in', async () => {
  const data = dataOf(await loadMulti());
  // comments reaches order_items through orders or products, both two
  // trusted-free polymorphic + db_fk hops: orders sorts first.
  const paths = findJoinPaths(data, 'shop._.comments', 'shop._.order_items');
  assert.equal(paths[0].cost, paths[1].cost);
  assert.deepEqual(paths.slice(0, 2).map(route), ['shop._.comments > shop._.orders > shop._.order_items', 'shop._.comments > shop._.products > shop._.order_items']);
  const shuffled = { ...data, links: [...data.links].reverse(), hubLinks: [...data.hubLinks].reverse() };
  assert.deepEqual(findJoinPaths(shuffled, 'shop._.comments', 'shop._.order_items').map(route), paths.map(route));
  assert.deepEqual(flagTypes(paths[0].hops[0]), ['polymorphic']);
  assert.match(conditionsText(paths[0]), /^comments\.commentable_id = orders\.id \(filter by comments\.commentable_type\)$/m);
});

test('never through a polymorphic owner from one of its targets to another', async () => {
  const data = dataOf(await loadMulti());
  for (const p of findJoinPaths(data, 'shop._.products', 'shop._.orders')) {
    for (let i = 1; i < p.hops.length; i++) {
      const [x, y] = [p.hops[i - 1].edge.line, p.hops[i].edge.line];
      assert.ok(!(x.type === 'poly' && x.id === y.id), route(p));
    }
  }
});

test('trust ranks paths of equal length; a hub table costs several hops', async () => {
  const multi = await loadMulti();
  // roles -> organizations: through memberships (inferred role_id) or, one
  // hop longer, through the hub table users.
  const paths = findJoinPaths(dataOf(multi), 'auth.public.roles', 'auth.public.organizations');
  assert.equal(route(paths[0]), 'auth.public.roles > auth.public.memberships > auth.public.organizations');
  assert.ok(paths.slice(1).every((p) => p.nodes.includes('auth.public.users') && p.cost >= HUB_COST));
  // Two routes of two hops between categories and brands: the reviewed
  // foreign keys win over the pending inference.
  const t = (id) => ({ id, domain: 'Catalog', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'category_id', type: 'bigint' }, { name: 'brand_id', type: 'bigint' }] });
  const guess = { ...fk('shop._.zz_guess', 'brand_id', 'shop._.brands'), kind: 'inferred', review: 'pending' };
  const model = {
    ...multi,
    tables: [...multi.tables, t('shop._.aa_link'), t('shop._.zz_guess')],
    relations: [...multi.relations, fk('shop._.aa_link', 'category_id', 'shop._.categories'), fk('shop._.aa_link', 'brand_id', 'shop._.brands'), fk('shop._.zz_guess', 'category_id', 'shop._.categories'), guess],
  };
  const found = findJoinPaths(dataOf(model), 'shop._.categories', 'shop._.brands').map(route);
  const [sure, guessed] = ['aa_link', 'zz_guess'].map((t) => found.indexOf(`shop._.categories > shop._.${t} > shop._.brands`));
  assert.ok(sure === 0 && (guessed === -1 || guessed > sure), JSON.stringify(found));
});

test('a chain through the rows ranks above a detour up to a shared parent and back down', async () => {
  const multi = await loadMulti();
  // notices and rules both point at a company (two hops through it), but a
  // notice's rule is reached through its targets and their setting: three hops.
  const id = (n) => `shop._.${n}`;
  const model = {
    ...multi,
    tables: [
      ...multi.tables,
      table(id('companies'), 'Catalog', []),
      table(id('notices'), 'Catalog', [['company_id', 'bigint']]),
      table(id('notice_targets'), 'Catalog', [['notice_id', 'bigint'], ['setting_id', 'bigint']]),
      table(id('settings'), 'Catalog', [['rule_id', 'bigint']]),
      table(id('rules'), 'Catalog', [['company_id', 'bigint']]),
    ],
    relations: [
      ...multi.relations,
      fk(id('notices'), 'company_id', id('companies')),
      fk(id('rules'), 'company_id', id('companies')),
      fk(id('notice_targets'), 'notice_id', id('notices')),
      fk(id('notice_targets'), 'setting_id', id('settings')),
      fk(id('settings'), 'rule_id', id('rules')),
    ],
  };
  const paths = findJoinPaths(dataOf(model), id('notices'), id('rules'));
  assert.deepEqual(paths.slice(0, 2).map(route), ['shop._.notices > shop._.notice_targets > shop._.settings > shop._.rules', 'shop._.notices > shop._.companies > shop._.rules']);
  assert.ok(paths[0].hops.every((h) => !flagTypes(h).includes('shared_parent')));
  const [up, down] = paths[1].hops;
  assert.deepEqual([flagTypes(up), flagTypes(down)], [[], ['multiplies', 'shared_parent']]);
  assert.equal(paths[1].cost, 2 * 10 + SHARED_PARENT_COST);
});

test('a detour found from a parent the previous path came up to costs its shared parent too', async () => {
  const multi = await loadMulti();
  // x -> p -> t is cheapest. Leaving p another way, p -> r -> s -> t (three
  // hops up) beats p <- c -> t (two hops, but down from the parent x came up to).
  const id = (n) => `shop._.${n}`;
  const model = {
    ...multi,
    tables: [
      ...multi.tables,
      table(id('x'), 'Catalog', [['p_id', 'bigint']]),
      table(id('p'), 'Catalog', [['t_id', 'bigint'], ['r_id', 'bigint']]),
      table(id('c'), 'Catalog', [['p_id', 'bigint'], ['t_id', 'bigint']]),
      table(id('r'), 'Catalog', [['s_id', 'bigint']]),
      table(id('s'), 'Catalog', [['t_id', 'bigint']]),
      table(id('t'), 'Catalog', []),
    ],
    relations: [
      ...multi.relations,
      fk(id('x'), 'p_id', id('p')),
      fk(id('p'), 't_id', id('t')),
      fk(id('p'), 'r_id', id('r')),
      fk(id('c'), 'p_id', id('p')),
      fk(id('c'), 't_id', id('t')),
      fk(id('r'), 's_id', id('s')),
      fk(id('s'), 't_id', id('t')),
    ],
  };
  const paths = findJoinPaths(dataOf(model), id('x'), id('t'));
  assert.deepEqual(
    paths.map((p) => [route(p), p.cost]),
    [
      ['shop._.x > shop._.p > shop._.t', 20],
      ['shop._.x > shop._.p > shop._.r > shop._.s > shop._.t', 40],
      ['shop._.x > shop._.p > shop._.c > shop._.t', 30 + SHARED_PARENT_COST],
    ],
  );
});

test('composite keys keep their column order; tables of the same name print their full ids', async () => {
  const multi = await loadMulti();
  const lines = { id: 'shop._.order_lines', domain: 'Orders', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'org_id', type: 'bigint' }, { name: 'order_no', type: 'bigint' }] };
  const orders = multi.tables.find((t) => t.id === 'shop._.orders');
  const users = { id: 'shop._.users', domain: 'Orders', columns: [{ name: 'id', type: 'bigint', pk: true }] };
  const model = {
    ...multi,
    tables: [...multi.tables.map((t) => (t === orders ? { ...t, columns: [...t.columns, { name: 'number', type: 'bigint' }] } : t)), lines, users],
    relations: [
      ...multi.relations,
      { ...fk('shop._.order_lines', 'org_id', 'shop._.orders'), from: { table: 'shop._.order_lines', columns: ['order_no', 'org_id'] }, to: { table: 'shop._.orders', columns: ['number', 'organization_id'] } },
      fk('shop._.users', 'id', 'auth.public.users'),
    ],
  };
  const [p] = findJoinPaths(dataOf(model), 'shop._.order_lines', 'shop._.orders');
  assert.equal(conditionsText(p), 'order_lines.order_no = orders.number AND order_lines.org_id = orders.organization_id');
  const [q] = findJoinPaths(dataOf(model), 'shop._.users', 'auth.public.memberships');
  assert.equal(conditionsText(q).split('\n')[0], 'shop._.users.id = auth.public.users.id');
  assert.ok(q.hops[0].flags.some((f) => f.type === 'cross_db'));
});

test('profile public: paths never use a hidden table or a pii column', async () => {
  const multi = await loadMulti();
  const model = { ...multi, config: { ...multi.config, hidden: { tables: ['shop._.payments'] } } };
  const full = findJoinPaths(dataOf(multi), 'shop._.refunds', 'shop._.orders');
  assert.ok(full[0].nodes.includes('shop._.payments'));
  const shared = dataOf(applyProfile(model, 'public'));
  // refunds reached orders only through payments (attachments joins its
  // targets to each other never), so there is no path left.
  assert.deepEqual(findJoinPaths(shared, 'shop._.refunds', 'shop._.orders'), []);
  assert.ok(findJoinPaths(shared, 'shop._.order_items', 'auth.public.users').every((p) => !p.nodes.includes('shop._.payments')));
  // A relation over a pii column is gone with the column.
  const pii = { ...multi, tables: multi.tables.map((t) => (t.id === 'shop._.orders' ? { ...t, columns: t.columns.map((c) => (c.name === 'user_id' ? { ...c, pii: true } : c)) } : t)) };
  const text = findJoinPaths(dataOf(applyProfile(pii, 'public')), 'shop._.orders', 'auth.public.users').map(conditionsText).join('\n');
  assert.doesNotMatch(text, /user_id/);
});

test('SQL skeleton: inner joins in path order, a comment above every risky hop', async () => {
  const data = dataOf(await loadMulti());
  const [best] = findJoinPaths(data, 'shop._.tags', 'shop._.order_items');
  assert.equal(
    sqlSkeleton(best).sql,
    [
      '-- Generated from the ERD: review before running',
      'SELECT *',
      'FROM tags',
      '-- verify: inferred',
      '-- rows repeat: one tags row matches many product_tags rows',
      'JOIN product_tags ON tags.id = product_tags.tag_id',
      'JOIN products ON product_tags.product_id = products.id',
      '-- rows repeat: one products row matches many order_items rows',
      'JOIN order_items ON products.id = order_items.product_id',
    ].join('\n'),
  );
  // A polymorphic hop names the type column to filter on, never a value.
  const [poly] = findJoinPaths(data, 'shop._.comments', 'shop._.order_items');
  assert.match(sqlSkeleton(poly).sql, /^-- add filter on comments\.commentable_type\nJOIN orders ON comments\.commentable_id = orders\.id$/m);
  assert.doesNotMatch(sqlSkeleton(poly).sql, /LEFT|deleted/);
});

test('SQL skeleton: composite keys joined with AND; a cross-DB path is refused', async () => {
  const multi = await loadMulti();
  const lines = { id: 'shop._.order_lines', domain: 'Orders', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'org_id', type: 'bigint' }, { name: 'order_no', type: 'bigint' }] };
  const model = {
    ...multi,
    tables: [...multi.tables.map((t) => (t.id === 'shop._.orders' ? { ...t, columns: [...t.columns, { name: 'number', type: 'bigint' }] } : t)), lines],
    relations: [...multi.relations, { ...fk('shop._.order_lines', 'org_id', 'shop._.orders'), from: { table: 'shop._.order_lines', columns: ['order_no', 'org_id'] }, to: { table: 'shop._.orders', columns: ['number', 'organization_id'] } }],
  };
  const [p] = findJoinPaths(dataOf(model), 'shop._.order_lines', 'shop._.orders');
  assert.equal(sqlSkeleton(p).sql.split('\n').at(-1), 'JOIN orders ON order_lines.order_no = orders.number AND order_lines.org_id = orders.organization_id');
  const [cross] = findJoinPaths(dataOf(multi), 'activity._.page_views', 'shop._.products');
  assert.ok(cross.hops.some((h) => h.flags.some((f) => f.type === 'cross_db')));
  const refused = sqlSkeleton(cross);
  assert.equal(refused.sql, undefined);
  assert.match(refused.blocked, /^The path spans 2 databases \(activity, shop\): it cannot be one query/);
});

test('SQL names: the table name, schema-qualified only when two tables share it', () => {
  const name = sqlNames(['billing.public.users', 'billing.audit.users', 'billing.public.orders']);
  assert.deepEqual(['billing.public.users', 'billing.audit.users', 'billing.public.orders'].map(name), ['public.users', 'audit.users', 'orders']);
  assert.equal(sqlNames(['shop._.orders'])('shop._.orders'), 'orders');
});

test('a hop flags its review state for the viewer to show as an icon; inferred stays a word', () => {
  const edge = (kind, review) => ({ a: 'db._.a', b: 'db._.b', aColumns: ['b_id'], bColumns: ['id'], cardinality: 'n-1', kind, review });
  const flags = (kind, review) => describeHop(edge(kind, review), 'db._.a').flags.filter((f) => f.type === 'trust');
  assert.deepEqual(flags('declared', 'pending'), [{ type: 'trust', text: 'pending review', review: 'pending' }]);
  assert.deepEqual(flags('db_fk', 'stale'), [{ type: 'trust', text: 'stale', review: 'stale' }]);
  assert.deepEqual(flags('inferred', 'pending'), [{ type: 'trust', text: 'inferred' }]);
  assert.deepEqual(flags('db_fk', 'reviewed'), []);
});

test('a path through several tables: the cheapest path between each pair of neighbours, end to end', async () => {
  const data = dataOf(await loadMulti());
  const [first] = findJoinPaths(data, 'shop._.tags', 'shop._.products');
  const [second] = findJoinPaths(data, 'shop._.products', 'shop._.order_items');
  const { path } = pathThrough(data, ['shop._.tags', 'shop._.products', 'shop._.order_items']);
  assert.equal(route(path), [...first.nodes, ...second.nodes.slice(1)].join(' > '));
  assert.deepEqual(path.hops, [...first.hops, ...second.hops]);
  assert.equal(path.cost, first.cost + second.cost);
  // Two tables: the same as the join panel's best path.
  assert.deepEqual(pathThrough(data, ['shop._.tags', 'shop._.order_items']).path, findJoinPaths(data, 'shop._.tags', 'shop._.order_items')[0]);
});

test('a path through tables some pair of which nothing joins names that pair', async () => {
  const model = await loadMulti();
  const data = dataOf(model);
  const lone = Object.keys(data.nodes).find((id) => data.nodes[id].kind === 'table' && findJoinPaths(data, id, 'shop._.orders').length === 0);
  assert.ok(lone, 'the fixture has a table no relation reaches');
  assert.deepEqual(pathThrough(data, ['shop._.products', 'shop._.orders', lone]), { gap: ['shop._.orders', lone] });
});

// s and t joined through `middles` tables m1, m2, ... (m.s_id -> s and
// m.t_id -> t: two hops of the same cost each), plus `relations`.
const tiedModel = (multi, middles, relations = []) => {
  const id = (n) => `shop._.${n}`;
  const names = Array.from({ length: middles }, (_, i) => `m${i + 1}`);
  return {
    ...multi,
    tables: [
      ...multi.tables,
      table(id('s'), 'Catalog', [['a_id', 'bigint'], ['b_id', 'bigint']]),
      table(id('t'), 'Catalog', []),
      ...names.map((m) => table(id(m), 'Catalog', [['s_id', 'bigint'], ['t_id', 'bigint'], ['note', 'text']])),
    ],
    relations: [...multi.relations, ...names.flatMap((m) => [fk(id(m), 's_id', id('s')), fk(id(m), 't_id', id('t'))]), ...relations],
  };
};
const shuffledOf = (data) => ({ ...data, links: [...data.links].reverse(), hubLinks: [...data.hubLinks].reverse() });

test('paths as short as the third are listed too, in a stable order, up to MAX_TIED_PATHS', async () => {
  const multi = await loadMulti();
  const data = dataOf(tiedModel(multi, 4));
  const paths = findJoinPaths(data, 'shop._.s', 'shop._.t');
  assert.deepEqual(paths.map(route), ['m1', 'm2', 'm3', 'm4'].map((m) => `shop._.s > shop._.${m} > shop._.t`));
  assert.ok(paths.every((p) => p.cost === 20));
  // The first three are the list without ties, so option=n links keep their path.
  assert.deepEqual(paths.slice(0, MAX_PATHS), findJoinPaths(data, 'shop._.s', 'shop._.t', MAX_PATHS, MAX_PATHS));
  assert.deepEqual(findJoinPaths(shuffledOf(data), 'shop._.s', 'shop._.t'), paths);
  // A tie of ten stops at the cap.
  const many = findJoinPaths(dataOf(tiedModel(multi, 10)), 'shop._.s', 'shop._.t');
  assert.equal(many.length, MAX_TIED_PATHS);
  assert.deepEqual(many.slice(0, 3).map(route), ['m1', 'm10', 'm2'].map((m) => `shop._.s > shop._.${m} > shop._.t`));
});

test('relations joining the same two tables make one path, the others listed on its hop', async () => {
  const multi = await loadMulti();
  // s points at t twice (like created_by and updated_by), and three tables
  // join them in two hops.
  const data = dataOf(tiedModel(multi, 3, [fk('shop._.s', 'a_id', 'shop._.t'), fk('shop._.s', 'b_id', 'shop._.t')]));
  const paths = findJoinPaths(data, 'shop._.s', 'shop._.t');
  // The variant over b_id takes no slot: the two-hop routes follow, m3 tied
  // with m2.
  assert.deepEqual(paths.map(route), ['shop._.s > shop._.t', ...['m1', 'm2', 'm3'].map((m) => `shop._.s > shop._.${m} > shop._.t`)]);
  // Without ties too: the slot the variant took goes to the next route.
  assert.deepEqual(findJoinPaths(data, 'shop._.s', 'shop._.t', MAX_PATHS, MAX_PATHS).map(route), paths.slice(0, 3).map(route));
  const [direct] = paths;
  assert.equal(conditionsText(direct), 's.a_id = t.id');
  assert.deepEqual(direct.hops[0].alternatives.map((h) => hopCondition(h, pathNames(direct.nodes))), ['s.b_id = t.id']);
  assert.ok(paths.slice(1).every((p) => p.hops.every((h) => h.alternatives.length === 0)));
  // The SQL joins on the kept relation only.
  assert.match(sqlSkeleton(direct).sql, /^JOIN t ON s\.a_id = t\.id$/m);
  assert.deepEqual(findJoinPaths(shuffledOf(data), 'shop._.s', 'shop._.t'), paths);
});

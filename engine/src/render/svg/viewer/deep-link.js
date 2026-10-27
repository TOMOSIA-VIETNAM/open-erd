// The address an erd.svg opens on: `#<key>=<value>&<key>=<value>…`. The
// viewer writes it from what is on screen and opens it back. Keys, in the
// order the viewer writes them:
//   view       a view: all, overview, ranking, domain:<db>/<domain>
//   folded     the domains folded in that view: <db>/<domain>,...
//   related    the table (or polymorphic node) a view of related tables is
//              built around, with `hops` (1 or 2)
//   path       a join path through the tables listed, with `option` (the
//              n-th path found between two tables, from 1)
//   tables     tables lit together
//   table      the selected table (or polymorphic node)
//   column     the selected table and its open column: <table id>.<column>
//   line       the selected relation line, by its id
//   between    the two domains whose relations the panel lists (an overview
//              connector clicked): <db>/<domain>,<db>/<domain>
//   severity   the severity the schema health list is filtered to
//   at         where the reader panned or zoomed to: x,y of the drawing at
//              the middle of the screen, then the scale
//   highlight  the highlight modes on: changes, review, pii, health, central
// Pure and DOM-free: the viewer acts on the result, node:test checks the
// parsing.

// Characters a value keeps as they are in the address; everything else is
// percent-encoded, so `&` and `=` inside a value (a domain named
// "Billing & Tax") never read as separators.
const encodeValue = (value) => value.replace(/[^A-Za-z0-9_./:,-]/g, encodeURIComponent);
// An item of a list value: its own commas encoded too.
const encodeItem = (item) => item.replace(/[^A-Za-z0-9_./:-]/g, encodeURIComponent);

/**
 * The hash for `pairs` ([key, value], in order), e.g. `#view=all&table=a.b.c`.
 * A value given as an array is written as a list, each item encoded.
 */
export function formatHash(pairs) {
  return `#${pairs.map(([key, value]) => `${key}=${Array.isArray(value) ? value.map(encodeItem).join(',') : encodeValue(value)}`).join('&')}`;
}

// A comma-separated value as a list: each item decoded on its own (so an
// encoded comma stays inside its item), trimmed, without empty items or
// repeats, in the order written.
const listOf = (raw) => [...new Set(raw.split(',').map((s) => decodeURIComponent(s).trim()).filter(Boolean))];

/**
 * The link in `hash` as { params, key, value, ids, view }:
 *   params  every pair, key -> { value (decoded), ids (the value as a list) };
 *           a key written twice keeps its first value
 *   key, value, ids  the first pair that is not `view` (or the `view` pair
 *           when it is alone), for links naming one thing
 *   view    the decoded `view` value when another pair follows it, else null
 * Null when a part has no key or a value is not valid URL encoding. An `=`
 * written as `%3D` after the first key (addresses copied from an older
 * viewer) still splits key from value.
 */
export function parseHash(hash) {
  const text = (hash ?? '').replace(/^#/, '').replace(/^([A-Za-z]+)%3D/i, '$1=');
  const pairs = [];
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at <= 0) return null;
    pairs.push([part.slice(0, at), part.slice(at + 1)]);
  }
  try {
    const params = {};
    for (const [key, raw] of pairs) if (!(key in params)) params[key] = { value: decodeURIComponent(raw), ids: listOf(raw) };
    const main = pairs.find(([key]) => key !== 'view') ?? pairs[0];
    const view = main[0] === 'view' ? null : (params.view?.value ?? null);
    return { params, key: main[0], value: params[main[0]].value, ids: params[main[0]].ids, view };
  } catch {
    return null;
  }
}

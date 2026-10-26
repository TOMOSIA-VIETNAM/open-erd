// The address an erd.svg opens on: `#<key>=<value>` (#table=, #column=,
// #view=, #tables=, #path=), optionally with the view to open it in before
// it: `#view=<view>&table=<id>`. Pure and DOM-free: the viewer acts on the
// result, node:test checks the parsing.

// Characters a value keeps as they are in the address; everything else is
// percent-encoded, so `&` and `=` inside a value (a domain named
// "Billing & Tax") never read as separators.
const encodeValue = (value) => value.replace(/[^A-Za-z0-9_./:,-]/g, encodeURIComponent);

/** The hash for `pairs` ([key, value], in order), e.g. `#view=all&table=a.b.c`. */
export function formatHash(pairs) {
  return `#${pairs.map(([key, value]) => `${key}=${encodeValue(value)}`).join('&')}`;
}

/**
 * `#key=value` as { key, value, ids, view }: `value` URL-decoded, `ids` the
 * value read as a comma-separated list (each item decoded on its own, so an
 * encoded comma stays inside its item), trimmed, without empty items or
 * repeats, in the order written. `view` is the decoded value of a `view=`
 * pair written before another pair (`#view=…&table=…`), else null; a hash
 * that is only `view=…` has it as its key. Null when there is no key or a
 * value is not valid URL encoding. An `=` written as `%3D` after the key
 * (addresses copied from an older viewer) still splits key from value.
 */
export function parseHash(hash) {
  const text = (hash ?? '').replace(/^#/, '').replace(/^([A-Za-z]+)%3D/i, '$1=');
  const pairs = [];
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at <= 0) return null;
    pairs.push([part.slice(0, at), part.slice(at + 1)]);
  }
  const main = pairs.find(([key]) => key !== 'view') ?? pairs[0];
  const view = main[0] === 'view' ? null : (pairs.find(([key]) => key === 'view')?.[1] ?? null);
  try {
    const ids = [...new Set(main[1].split(',').map((s) => decodeURIComponent(s).trim()).filter(Boolean))];
    return { key: main[0], value: decodeURIComponent(main[1]), ids, view: view === null ? null : decodeURIComponent(view) };
  } catch {
    return null;
  }
}

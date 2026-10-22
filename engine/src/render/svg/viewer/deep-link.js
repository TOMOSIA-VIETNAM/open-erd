// The address an erd.svg opens on: `#<key>=<value>` (#table=, #column=,
// #view=, #impact=, #tables=, #path=). Pure and DOM-free: the viewer acts on
// the result, node:test checks the parsing.

/**
 * `#key=value` as { key, value, ids }: `value` URL-decoded, `ids` the value
 * read as a comma-separated list (each item decoded on its own, so an
 * encoded comma stays inside its item), trimmed, without empty items or
 * repeats, in the order written. Null when there is no key or the value is
 * not valid URL encoding.
 */
export function parseHash(hash) {
  const text = (hash ?? '').replace(/^#/, '');
  const at = text.indexOf('=');
  if (at <= 0) return null;
  const raw = text.slice(at + 1);
  try {
    const ids = [...new Set(raw.split(',').map((s) => decodeURIComponent(s).trim()).filter(Boolean))];
    return { key: text.slice(0, at), value: decodeURIComponent(raw), ids };
  } catch {
    return null;
  }
}

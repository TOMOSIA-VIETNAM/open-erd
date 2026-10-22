// Strict, minimal XML parser for tests: elements, attributes, text, the
// XML declaration and comments. Throws on anything not well-formed
// (mismatched or unclosed tags, duplicate or unquoted attributes, a raw '<'
// or '&' outside an entity), so parsing a file is its well-formedness check.
// Returns the root element as { name, attrs, children }.

const NAME = /^[A-Za-z_:][\w.:-]*/;
const ENTITY = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
const decode = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

function checkText(text, at) {
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    if (!ENTITY.test(text.slice(i))) throw new Error(`bad entity at ${at + i}`);
  }
  if (text.includes('<')) throw new Error(`raw < at ${at}`);
}

export function parseXml(xml) {
  let i = 0;
  const fail = (msg) => {
    throw new Error(`${msg} at ${i}: ${JSON.stringify(xml.slice(i, i + 40))}`);
  };
  const skipSpace = () => {
    while (/\s/.test(xml[i] ?? '')) i++;
  };
  if (xml.startsWith('<?xml')) i = xml.indexOf('?>') + 2;
  const stack = [{ name: '#document', attrs: {}, children: [] }];
  while (i < xml.length) {
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i);
      if (end === -1) fail('unclosed comment');
      i = end + 3;
    } else if (xml.startsWith('</', i)) {
      i += 2;
      const name = xml.slice(i).match(NAME)?.[0] ?? fail('bad closing tag');
      i += name.length;
      skipSpace();
      if (xml[i] !== '>') fail('bad closing tag');
      i++;
      const open = stack.pop();
      if (open.name !== name) fail(`</${name}> closes <${open.name}>`);
    } else if (xml[i] === '<') {
      i++;
      const name = xml.slice(i).match(NAME)?.[0] ?? fail('bad tag name');
      i += name.length;
      const el = { name, attrs: {}, children: [] };
      for (;;) {
        const before = i;
        skipSpace();
        if (xml[i] === '>' || xml.startsWith('/>', i)) break;
        if (i === before) fail('missing space before attribute');
        const attr = xml.slice(i).match(NAME)?.[0] ?? fail('bad attribute name');
        i += attr.length;
        if (xml[i] !== '=' || xml[i + 1] !== '"') fail('attribute value must be ="..."');
        const end = xml.indexOf('"', i + 2);
        if (end === -1) fail('unclosed attribute');
        const raw = xml.slice(i + 2, end);
        checkText(raw, i + 2);
        if (Object.hasOwn(el.attrs, attr)) fail(`duplicate attribute ${attr}`);
        el.attrs[attr] = decode(raw);
        i = end + 1;
      }
      stack.at(-1).children.push(el);
      if (xml[i] === '/') i += 2;
      else {
        i++;
        stack.push(el);
      }
    } else {
      const end = xml.indexOf('<', i) === -1 ? xml.length : xml.indexOf('<', i);
      const text = xml.slice(i, end);
      checkText(text, i);
      if (stack.length === 1 && text.trim()) fail('text outside the root element');
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack.at(-1).name}>`);
  const roots = stack[0].children;
  if (roots.length !== 1) throw new Error(`expected one root element, found ${roots.length}`);
  return roots[0];
}

/** Every element below `el`, depth first. */
export function descendants(el) {
  return el.children.flatMap((c) => [c, ...descendants(c)]);
}

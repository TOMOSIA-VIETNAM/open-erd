// XML 1.0 has no place for most control characters, not even as a character
// reference; a model text holding one (a pasted note) would make the file
// unreadable, so they are dropped.
const INVALID_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** `text` safe inside XML text and double-quoted attributes. */
export function escapeXml(text) {
  return String(text)
    .replace(INVALID_XML, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

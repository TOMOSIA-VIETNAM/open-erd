import { inflateRawSync } from 'node:zlib';
import { zipEntries } from '../../src/render/xlsx/zip.js';

/** `{ entry name: text }` of every part inside an .xlsx buffer. */
export function xlsxParts(buffer) {
  return Object.fromEntries(
    zipEntries(buffer).map((e) => {
      const data = buffer.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
      return [e.name, (e.method === 8 ? inflateRawSync(data) : data).toString('utf8')];
    }),
  );
}

const unescape = (text) => text.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * In-workbook links per sheet name: `{ sheet: Map(cell ref -> { location,
 * display }) }`, read from the XML because exceljs only reads back links
 * stored as relationships.
 */
export function xlsxLinks(buffer) {
  const parts = xlsxParts(buffer);
  const links = {};
  for (const m of parts['xl/workbook.xml'].matchAll(/<sheet sheetId="(\d+)" name="([^"]*)"/g)) {
    const sheet = parts[`xl/worksheets/sheet${m[1]}.xml`];
    links[unescape(m[2])] = new Map(
      [...sheet.matchAll(/<hyperlink ref="([^"]+)" location="([^"]+)" display="([^"]*)"\/>/g)].map((h) => [h[1], { location: unescape(h[2]), display: unescape(h[3]) }]),
    );
  }
  return links;
}

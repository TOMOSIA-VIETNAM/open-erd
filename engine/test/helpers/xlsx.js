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

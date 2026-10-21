// Minimal reader for the parts of a zip archive needed to make it
// reproducible: exceljs packs through JSZip, which stamps every entry with
// the current time. Entry order and compressed bytes are already a function
// of the input, so only the time fields have to be rewritten.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// Smallest end-of-central-directory record: 22 bytes, plus a comment of up
// to 65535 bytes that has to be scanned over to find it.
const EOCD_SIZE = 22;

function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_SIZE - 0xffff);
  for (let i = buf.length - EOCD_SIZE; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('not a zip archive: end of central directory not found');
}

/**
 * Entries in central-directory order: `{ name, method, compressedSize,
 * centralOffset, localOffset, dataOffset }`. Offsets are into `buf`.
 */
export function zipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error(`bad central directory entry at ${at}`);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`bad local header at ${localOffset}`);
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      centralOffset: at,
      localOffset,
      dataOffset: localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 1980-01-01 00:00:00, the earliest MS-DOS date a zip entry can carry.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** Copy of `buf` with every entry's modification time set to one constant. */
export function withFixedEntryTimes(buf) {
  const out = Buffer.from(buf);
  for (const e of zipEntries(out)) {
    out.writeUInt16LE(DOS_TIME, e.centralOffset + 12);
    out.writeUInt16LE(DOS_DATE, e.centralOffset + 14);
    out.writeUInt16LE(DOS_TIME, e.localOffset + 10);
    out.writeUInt16LE(DOS_DATE, e.localOffset + 12);
  }
  return out;
}

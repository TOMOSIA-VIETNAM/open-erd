import { inflateRawSync } from 'node:zlib';

// Minimal zip reader and writer for the post-processing exceljs output
// needs: JSZip stamps every entry with the current time, and a few parts
// have to be corrected after exceljs wrote them (see serializeWorkbook).

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// Smallest end-of-central-directory record: 22 bytes, plus a comment of up
// to 65535 bytes that has to be scanned over to find it.
const EOCD_SIZE = 22;
const STORED = 0;
const DEFLATED = 8;
// General purpose flag bits kept when an entry is rewritten: 11 says the name
// is UTF-8. Bit 3 (sizes in a trailing data descriptor) is dropped because
// the rewritten local header carries the sizes itself.
const UTF8_FLAG = 1 << 11;

function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_SIZE - 0xffff);
  for (let i = buf.length - EOCD_SIZE; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('not a zip archive: end of central directory not found');
}

/**
 * Entries in central-directory order: `{ name, method, flags, crc,
 * compressedSize, size, centralOffset, localOffset, dataOffset }`. Offsets
 * are into `buf`.
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
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      centralOffset: at,
      localOffset,
      dataOffset: localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Uncompressed bytes of entry `e` of `buf`. */
export function entryData(buf, e) {
  const raw = buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
  if (e.method === STORED) return raw;
  if (e.method === DEFLATED) return inflateRawSync(raw);
  throw new Error(`${e.name}: unsupported zip compression method ${e.method}`);
}

// zlib.crc32 needs Node 20.15; the engine supports 20.10.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00, the earliest MS-DOS date a zip entry can carry.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * A new archive with the entries of `buf` in the same order, every entry
 * stamped with one constant time. `change(name, read)` decides per entry:
 * undefined keeps it byte for byte, null drops it, a string replaces its
 * content; `read(name)` returns the original text of any entry.
 * ponytail: replaced entries are stored uncompressed. Node's zlib may
 * compress differently across CPU architectures, which would break the
 * byte-identical output; compress them deterministically if file size
 * starts to matter.
 */
export function rebuildZip(buf, change = () => undefined) {
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name) => {
    const e = byName.get(name);
    return e ? entryData(buf, e).toString('utf8') : undefined;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const replaced = change(e.name, read);
    if (replaced === null) continue;
    let fields;
    if (replaced === undefined) {
      fields = { flags: e.flags & UTF8_FLAG, method: e.method, crc: e.crc, size: e.size, data: buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize) };
    } else {
      const data = Buffer.from(replaced, 'utf8');
      fields = { flags: e.flags & UTF8_FLAG, method: STORED, crc: crc32(data), size: data.length, data };
    }
    const name = Buffer.from(e.name, 'utf8');
    // Header fields shared by the local and the central record, from
    // "version needed" up to the name length.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(fields.flags, 2);
    common.writeUInt16LE(fields.method, 4);
    common.writeUInt16LE(DOS_TIME, 6);
    common.writeUInt16LE(DOS_DATE, 8);
    common.writeUInt32LE(fields.crc, 10);
    common.writeUInt32LE(fields.data.length, 14);
    common.writeUInt32LE(fields.size, 18);
    common.writeUInt16LE(name.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.alloc(4);
    local.writeUInt32LE(LOCAL, 0);
    locals.push(local, common, name, fields.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    common.copy(central, 6);
    // Comment length, disk number, attributes stay 0.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + fields.data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

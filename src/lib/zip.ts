/**
 * A ZIP archive, written without compression ("stored"). Documents are PDFs
 * and photos that are already compressed, and a stored archive opens in
 * every unzip tool there is — Finder, Windows Explorer, unzip. Names are
 * UTF-8 (flag bit 11) so "Société Générale.pdf" arrives as itself.
 *
 * The result is a list of chunks to hand to a Blob, so a large archive is
 * never copied into one buffer. No ZIP64: an archive is limited to 4 GB and
 * 65,535 files, far beyond a small team's documents; past that it refuses
 * rather than writing a broken file.
 */

export interface ZipEntry {
  path: string;
  data: Uint8Array;
  /** When the file was last changed; the archive's own time when missing. */
  modified?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what ZIP records; local time, two-second steps. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const LIMIT = 0xffffffff;

export function zip(entries: ZipEntry[], now = new Date()): Uint8Array[] {
  if (entries.length > 0xffff) throw new Error('Too many files for one archive');
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`Two files named ${entry.path}`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    if (size > LIMIT || offset > LIMIT) throw new Error('The archive would be larger than 4 GB');
    const { time, date } = dosTime(entry.modified ?? now);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, entry.data);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 0x031e, true); // made by: Unix, 3.0
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true);
    record.setUint16(32, 0, true);
    record.setUint16(34, 0, true);
    record.setUint16(36, 0, true);
    record.setUint32(38, 0o100644 << 16, true); // a plain file, rw-r--r--
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  if (offset > LIMIT || offset + centralSize > LIMIT) throw new Error('The archive would be larger than 4 GB');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...chunks, ...central, new Uint8Array(end.buffer)];
}

/**
 * Reads back what zip() wrote — stored entries only — checking each file's
 * checksum. For tests, and for checking a package before handing it over.
 */
export function unzip(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a ZIP archive');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: { path: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Damaged central directory');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`${path} is compressed`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${path} is damaged`);
    out.push({ path, data });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

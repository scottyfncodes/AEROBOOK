/**
 * A plain ZIP file: every entry stored as it is, uncompressed, which any
 * operating system opens without extra software. Documents (PDFs, photos,
 * Office files) are compressed already, so storing them costs little, and a
 * stored entry is one CRC away from being checked. Pure, for the browser and
 * Node alike.
 *
 * Kept small on purpose: no ZIP64, so an archive and each entry must stay
 * under 4 GB — far beyond what AEROBOOK holds (documents are 25 MB at most).
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: Uint8Array;
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
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LIMIT = 0xffffffff;

/** DOS date and time, which is what ZIP keeps. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function writeZip(entries: ZipEntry[], at = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(at);
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`Two entries named ${entry.name}`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const size = entry.data.length;
    if (size >= LIMIT || offset >= LIMIT) throw new Error('The archive is too large for a plain ZIP file');
    const crc = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (entries.length > 0xffff || offset + centralSize >= LIMIT) throw new Error('The archive is too large for a plain ZIP file');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at2 = 0;
  for (const p of parts) {
    out.set(p, at2);
    at2 += p.length;
  }
  return out;
}

export interface ReadEntry extends ZipEntry {
  /** False when the bytes no longer match the checksum stored with them. */
  crcOk: boolean;
}

/** Reads a ZIP made by writeZip (stored entries). Throws on anything it cannot read. */
export function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a ZIP file');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (method !== 0) throw new Error(`${name} is compressed; this reader only reads stored entries`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    entries.push({ name, data, crcOk: data.length === size && crc32(data) === crc });
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}

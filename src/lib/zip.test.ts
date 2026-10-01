import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, unzip, zip } from './zip';

const join8 = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

function hasUnzip(): boolean {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips files, including UTF-8 names, empty files and binary data', () => {
    const binary = new Uint8Array(256).map((_, i) => i);
    const files = [
      { path: 'README.txt', data: text('hello') },
      { path: 'documents/Société Générale — 報告.pdf', data: binary },
      { path: 'empty.csv', data: new Uint8Array() },
    ];
    const back = unzip(join8(zip(files)));
    expect(back.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect([...back[1].data]).toEqual([...binary]);
    expect(back[2].data.length).toBe(0);
  });

  it('writes an empty archive that is still an archive', () => {
    expect(unzip(join8(zip([])))).toEqual([]);
  });

  it('refuses two files at the same path', () => {
    expect(() => zip([{ path: 'a', data: text('1') }, { path: 'a', data: text('2') }])).toThrow(/Two files/);
  });

  it('notices a damaged file', () => {
    const bytes = join8(zip([{ path: 'a.txt', data: text('abc') }]));
    bytes[30 + 5] ^= 0xff; // a byte of the file itself
    expect(() => unzip(bytes)).toThrow(/damaged/);
  });

  it.skipIf(!hasUnzip())('opens in the standard unzip tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerobook-zip-'));
    const file = join(dir, 'export.zip');
    writeFileSync(file, join8(zip([
      { path: 'AEROBOOK-Company-Export/contacts.csv', data: text('Name\r\nRenée') },
      { path: 'AEROBOOK-Company-Export/documents/binder.pdf', data: text('%PDF-1.4') },
    ])));
    expect(execFileSync('unzip', ['-tq', file]).toString()).toMatch(/No errors detected/);
    execFileSync('unzip', ['-q', file, '-d', dir]);
    expect(readFileSync(join(dir, 'AEROBOOK-Company-Export/contacts.csv'), 'utf8')).toBe('Name\r\nRenée');
  });
});

/**
 * The company data export's manifest: the SHA-256 of every file in the
 * package, so a copy can be checked — complete, nothing added, every byte as
 * exported — long after it was made, by `npm run verify:export` or by hand
 * with any SHA-256 tool. The ZIP's own CRC-32 per file still applies; this is
 * a second, cryptographic layer on top.
 *
 * Deterministic: files sorted by path (code point), keys in a fixed order,
 * two-space JSON with a trailing newline. It holds paths, sizes and digests
 * only, never contents. It cannot list itself.
 */
import { EXPORT_FOLDER } from './companyExport';
import type { ZipEntry } from './zip';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_FORMAT = 'aerobook-company-export-manifest';
export const MANIFEST_VERSION = 1;

export interface ManifestFile {
  /** Relative to the export folder, e.g. "documents/fil_x/Binder.pdf". */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  format: typeof MANIFEST_FORMAT;
  version: number;
  algorithm: 'SHA-256';
  exportedAt: string;
  files: ManifestFile[];
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const PREFIX = `${EXPORT_FOLDER}/`;

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function buildManifest(entries: ZipEntry[], exportedAt: string): Promise<ExportManifest> {
  const files: ManifestFile[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(PREFIX)) throw new Error(`${e.path} is outside ${EXPORT_FOLDER}`);
    files.push({ path: e.path.slice(PREFIX.length), bytes: e.data.length, sha256: await sha256Hex(e.data) });
  }
  files.sort((a, b) => byCodePoint(a.path, b.path));
  return { format: MANIFEST_FORMAT, version: MANIFEST_VERSION, algorithm: 'SHA-256', exportedAt, files };
}

export function manifestBytes(manifest: ExportManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The package with its manifest added, second after the README. Computed
 * over the exact bytes that go into the ZIP.
 */
export async function withManifest(entries: ZipEntry[], exportedAt: string): Promise<ZipEntry[]> {
  if (entries.some((e) => e.path === PREFIX + MANIFEST_NAME)) throw new Error('The package already has a manifest');
  const manifest = await buildManifest(entries, exportedAt);
  const entry: ZipEntry = { path: PREFIX + MANIFEST_NAME, data: manifestBytes(manifest), modified: new Date(exportedAt) };
  return [...entries.slice(0, 1), entry, ...entries.slice(1)];
}

/**
 * Checks a complete archive (Settings → Export complete archive) on its own,
 * without AEROBOOK or any account: every file's checksum, every document's
 * SHA-256 and size, every record against the manifest, and every link.
 *
 *   npm run verify:archive -- aerobook-complete-archive-2026-10-02.zip
 *
 * Prints counts and the collection fingerprints, which can be compared with
 * the live_ids_sha256 column of scripts/recovery-fingerprint.sql run against
 * the database. Exits 1 when anything is missing or wrong. Prints no customer
 * data: counts, IDs of problem records, and hashes only.
 */
import { readFile } from 'node:fs/promises';
import { verifyArchive, type Manifest } from '../src/lib/archive.js';
import { readZip } from '../src/lib/zip.js';

const path = process.argv[2];
if (!path) {
  console.log('Usage: npm run verify:archive -- <archive.zip>');
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(path));
const report = await verifyArchive(bytes);
const manifest = JSON.parse(
  new TextDecoder().decode(readZip(bytes).find((e) => e.name === 'manifest.json')!.data),
) as Manifest;

console.log(`Archive made ${report.exportedAt}`);
for (const [name, summary] of Object.entries(manifest.collections)) {
  console.log(`  ${name.padEnd(17)} ${String(report.counts[name] ?? summary.count).padStart(6)}  ids sha256 ${summary.idsSha256}`);
}
console.log(`  documents: ${report.documents.present} of ${report.documents.expected} files present, ${report.documents.corrupted.length} not matching`);
console.log(`  links: ${report.links.total}, ${report.links.broken} broken`);
if (report.documents.missing.length) console.log(`  missing document IDs: ${report.documents.missing.join(', ')}`);
if (report.documents.corrupted.length) console.log(`  damaged document IDs: ${report.documents.corrupted.join(', ')}`);
if (report.ok) {
  console.log('COMPLETE: everything in the manifest is present and intact.');
} else {
  console.log('NOT COMPLETE:');
  for (const p of report.problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

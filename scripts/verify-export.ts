/**
 * Checks a company data export ZIP (Settings → Data export) on its own. See
 * src/lib/exportVerify.ts for what is checked.
 *
 *   npm run verify:export -- <export.zip> [--expect expected.json] [--allow-no-manifest]
 *
 * --expect: what the source database held, as { "counts": {...},
 *   "documents": [{ "id", "size" }] } — see docs/disaster-recovery.md for the
 *   read-only query that produces it.
 * --allow-no-manifest: accept an export made before manifests existed.
 *
 * Prints counts, document IDs, sizes and SHA-256s only. Exit 0 = PASS,
 * 1 = FAIL, 2 = usage.
 */
import { readFile } from 'node:fs/promises';
import { verifyCompanyExport, type Expected } from '../src/lib/exportVerify.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--expect');
const expectAt = args.indexOf('--expect');
if (!path || (expectAt >= 0 && !args[expectAt + 1])) {
  console.log('Usage: npm run verify:export -- <export.zip> [--expect expected.json] [--allow-no-manifest]');
  process.exit(2);
}

const expected = expectAt >= 0 ? (JSON.parse(await readFile(args[expectAt + 1], 'utf8')) as Expected) : undefined;
const report = await verifyCompanyExport(new Uint8Array(await readFile(path)), {
  expected,
  allowNoManifest: args.includes('--allow-no-manifest'),
});

console.log(`Export: ${report.members} files in the ZIP; manifest ${report.manifest}`);
console.log(`Counts: ${Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Links: ${report.links.checked} checked, ${report.links.broken} broken`);
console.log('Documents:');
for (const d of report.documents) {
  console.log(`  ${d.id}  ${String(d.bytes ?? '-').padStart(10)} bytes  sha256 ${d.sha256 ?? '-'}  ${d.status}`);
}
const ok = report.documents.filter((d) => d.status === 'ok').length;
console.log(`Documents verified: ${ok}/${expected?.documents?.length ?? report.documents.length}`);
if (report.ok) {
  console.log('RESULT: PASS');
} else {
  console.log('RESULT: FAIL');
  for (const p of report.problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}

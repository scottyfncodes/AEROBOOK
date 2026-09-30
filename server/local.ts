/**
 * The whole app on one port, the way Vercel serves it: the built page from
 * dist/, and /api from the same handler the Vercel Function runs.
 *
 *   npm run build && npm run serve
 *
 * Needs DATABASE_URL and BETTER_AUTH_SECRET; creates the tables on start.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { handle } from './app.js';
import { migrate } from './auth.js';
import { sendResponse, toRequest } from './node.js';

const PORT = Number(process.env.PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIST = resolve(import.meta.dirname, '../dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

process.env.APP_ORIGINS ??= `${ORIGIN},http://localhost:${PORT}`;
// Documents go to a folder here; on Vercel they go to Blob storage.
process.env.FILES_DIR ??= resolve(import.meta.dirname, '../.local-files');

async function staticFile(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const path = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!path.startsWith(DIST)) return null;
  try {
    if (!(await stat(path)).isFile()) return null;
    return { body: await readFile(path), type: TYPES[extname(path)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

await migrate();

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    await sendResponse(res, await handle(await toRequest(req, `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`)));
    return;
  }
  const file = (await staticFile(url.pathname)) ?? (extname(url.pathname) ? null : await staticFile('/index.html'));
  if (!file) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.setHeader('content-type', file.type);
  res.end(file.body);
}).listen(PORT, '127.0.0.1', () => console.log(`AEROBOOK on ${ORIGIN}`));

/**
 * Where documents live: private Vercel Blob storage in production, a folder
 * on disk for tests and local runs. Files are never public — every read goes
 * through /api/files/content, which checks the session first.
 *
 * The browser uploads straight to Blob (so a large scan never has to fit
 * through a function's request limit); the server only hands out a
 * short-lived token for one path under files/, and only to someone signed in.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { del as blobDel, get as blobGet } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

export type StorageMode = 'blob' | 'local' | 'none';

/** The largest document accepted, the same limit the app has always had. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** files/<record id>/<name>, with nothing that could climb out of files/. */
const PATH_RE = /^files\/fil_[a-z0-9]{4,40}\/[^/\\]{1,200}$/;

export function isFilePath(path: string): boolean {
  return PATH_RE.test(path) && !path.includes('..');
}

export function storageMode(): StorageMode {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  if (process.env.FILES_DIR) return 'local';
  return 'none';
}

export interface StoredFile {
  body: ReadableStream<Uint8Array> | Uint8Array;
}

// ------------------------------------------------------------------ blob

/** Answers the browser's request for an upload token. The caller has checked the session. */
export async function blobUploadToken(request: Request, body: HandleUploadBody): Promise<unknown> {
  return handleUpload({
    request,
    body,
    onBeforeGenerateToken: async (pathname) => {
      if (!isFilePath(pathname)) throw new Error('Documents are stored under files/');
      return {
        maximumSizeInBytes: MAX_FILE_BYTES,
        // An unguessable name on top of the path the app chose.
        addRandomSuffix: true,
      };
    },
  });
}

// ----------------------------------------------------------------- local

function localPath(path: string): string {
  const root = normalize(process.env.FILES_DIR ?? '');
  const full = normalize(join(root, path));
  if (!full.startsWith(root)) throw new Error('Bad document path');
  return full;
}

export async function putLocal(path: string, bytes: Uint8Array): Promise<void> {
  const full = localPath(path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

// ----------------------------------------------------------------- both

export async function readStored(path: string): Promise<StoredFile | null> {
  if (storageMode() === 'blob') {
    const result = await blobGet(path, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return { body: result.stream };
  }
  if (storageMode() === 'local') {
    try {
      return { body: new Uint8Array(await readFile(localPath(path))) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Best-effort: a file that is already gone is not an error. */
export async function deleteStored(paths: string[]): Promise<void> {
  const valid = paths.filter(isFilePath);
  if (valid.length === 0) return;
  try {
    if (storageMode() === 'blob') await blobDel(valid);
    else if (storageMode() === 'local') await Promise.all(valid.map((p) => rm(localPath(p), { force: true })));
  } catch (error) {
    console.error('Could not delete stored documents', error);
  }
}

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
import { del as blobDel, get as blobGet, issueSignedToken } from '@vercel/blob';
import { handleUpload, handleUploadPresigned, type HandleUploadBody } from '@vercel/blob/client';
import { ensureAppSchema, getPool } from './db.js';

export type StorageMode = 'blob' | 'local' | 'none';

/** The largest document accepted, the same limit the app has always had. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** files/<record id>/<name>, with nothing that could climb out of files/. */
const PATH_RE = /^files\/fil_[a-z0-9]{4,40}\/[^/\\]{1,200}$/;

export function isFilePath(path: string): boolean {
  return PATH_RE.test(path) && !path.includes('..');
}

/**
 * A Blob store connected to the project either hands over a read-write token
 * (BLOB_READ_WRITE_TOKEN) or only its id (BLOB_STORE_ID), with the deployment
 * proving who it is through Vercel's OIDC token. The two sign uploads
 * differently; reading and deleting work the same either way.
 */
export function storageMode(): StorageMode {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return 'blob';
  if (process.env.FILES_DIR) return 'local';
  return 'none';
}

export type UploadFlavor = 'token' | 'presigned';

export function uploadFlavor(): UploadFlavor {
  return process.env.BLOB_READ_WRITE_TOKEN ? 'token' : 'presigned';
}

export interface StoredFile {
  body: ReadableStream<Uint8Array> | Uint8Array;
}

// ------------------------------------------------------------------ blob

/** Answers the browser's request for an upload token. The caller has checked the session. */
export async function blobUploadToken(request: Request, body: HandleUploadBody): Promise<unknown> {
  if (uploadFlavor() === 'presigned') {
    return handleUploadPresigned({
      request,
      body: body as never,
      getSignedToken: async (pathname) => {
        if (!isFilePath(pathname)) throw new Error('Documents are stored under files/');
        // Good for this one path, for writing only, for ten minutes. The path
        // already carries the record's unique id, so no suffix is needed.
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          maximumSizeInBytes: MAX_FILE_BYTES,
          validUntil: Date.now() + 10 * 60 * 1000,
        });
        return { token, urlOptions: { maximumSizeInBytes: MAX_FILE_BYTES } };
      },
    });
  }
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

/** A file that is already gone is not an error; failing to reach storage is. */
export async function deleteStored(paths: string[]): Promise<void> {
  const valid = paths.filter(isFilePath);
  if (valid.length === 0) return;
  if (storageMode() === 'blob') await blobDel(valid);
  else if (storageMode() === 'local') await Promise.all(valid.map((p) => rm(localPath(p), { force: true })));
}

// ----------------------------------------------------------------- trash

/** How long a deleted document's file is kept, so it can still be restored. */
export const TRASH_DAYS = 30;
const PURGE_BATCH = 500;

/**
 * Remove the files of documents deleted more than TRASH_DAYS ago. A file some
 * document record points at again — one restored from the history — is taken
 * out of the trash instead, whoever deleted it and whenever.
 */
export async function purgeTrash(): Promise<{ removed: number }> {
  await ensureAppSchema();
  const pool = getPool();
  await pool.query(
    `delete from app_file_trash t where exists (
       select 1 from app_record r
        where r.collection = 'files' and r.data is not null and r.data->>'blobPath' = t.path)`,
  );
  const { rows } = await pool.query<{ path: string }>(
    `select path from app_file_trash
      where deleted_at < now() - make_interval(days => $1)
      order by deleted_at limit $2`,
    [TRASH_DAYS, PURGE_BATCH],
  );
  const paths = rows.map((r) => r.path);
  if (paths.length === 0) return { removed: 0 };
  // Should storage fail, the rows stay and the next run tries again.
  await deleteStored(paths);
  await pool.query('delete from app_file_trash where path = any($1)', [paths]);
  return { removed: paths.length };
}

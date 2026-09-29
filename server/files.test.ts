/**
 * Documents: who may upload and read them, and that a document goes when its
 * record does. Runs the local-disk store; the Blob store is the same routes
 * with Vercel's SDK behind them, and its token route is checked here too.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';

const PATH = 'files/fil_abc123/binder.pdf';
const PDF = new TextEncoder().encode('%PDF-1.4 test binder');

describe.skipIf(!TEST_DB)('documents', () => {
  let dir: string;
  let cookie: string;

  const putLocal = (path: string, body: Uint8Array, auth = cookie) =>
    handle(new Request(`${ORIGIN}/api/files/local?path=${encodeURIComponent(path)}`, {
      method: 'PUT', body: body as BodyInit, headers: { origin: ORIGIN, cookie: auth, 'content-type': 'application/pdf' },
    }));
  const record = (id: string, path: string | null, baseVersion = 0) => api('/api/sync', {
    cookie,
    body: {
      changes: [{
        collection: 'files', id, baseVersion,
        data: path === null ? null : { id, name: 'Binder.pdf', mimeType: 'application/pdf', size: PDF.length, blobPath: path },
      }],
    },
  });
  const content = (path: string, auth = cookie) => api(`/api/files/content?path=${encodeURIComponent(path)}`, { cookie: auth });

  beforeEach(async () => {
    await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'aerobook-files-'));
    process.env.FILES_DIR = dir;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await createUser('Alice', 'alice@example.com', 'admin');
    cookie = await signIn('alice@example.com');
  });

  afterEach(async () => {
    delete process.env.FILES_DIR;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await rm(dir, { recursive: true, force: true });
  });

  it('is closed to anyone signed out', async () => {
    expect((await api('/api/files/config')).status).toBe(401);
    expect((await content(PATH, '')).status).toBe(401);
    expect((await putLocal(PATH, PDF, '')).status).toBe(401);
    expect((await readdir(dir)).length).toBe(0);
  });

  it('says where documents are stored', async () => {
    expect(await (await api('/api/files/config', { cookie })).json()).toEqual({ mode: 'local', maxBytes: 25 * 1024 * 1024 });
    delete process.env.FILES_DIR;
    expect((await (await api('/api/files/config', { cookie })).json()).mode).toBe('none');
  });

  it('stores a document and gives it back, as a download', async () => {
    expect((await putLocal(PATH, PDF)).status).toBe(200);
    await record('fil_abc123', PATH);
    const r = await content(PATH);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="Binder.pdf"/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reads only files a document record points at', async () => {
    await putLocal(PATH, PDF);
    expect((await content(PATH)).status).toBe(404);
  });

  it('refuses paths outside the documents folder', async () => {
    for (const bad of ['../secret', 'files/../../etc/passwd', 'files/fil_abc123/../x', 'other/fil_abc123/a.pdf']) {
      expect((await content(bad)).status).toBe(400);
      expect((await putLocal(bad, PDF)).status).toBe(400);
    }
  });

  it('deletes the stored file when its document is deleted', async () => {
    await putLocal(PATH, PDF);
    await record('fil_abc123', PATH);
    await record('fil_abc123', null, 1);
    expect(await readdir(join(dir, 'files/fil_abc123'))).toEqual([]);
    expect((await content(PATH)).status).toBe(404);
  });

  describe('with Vercel Blob', () => {
    const tokenRequest = (pathname: string, auth = cookie) => api('/api/files/upload', {
      cookie: auth,
      body: { type: 'blob.generate-client-token', payload: { pathname, multipart: false, clientPayload: null } },
    });

    beforeEach(() => {
      process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_secretsecretsecretsecret';
    });

    it('hands an upload token only to someone signed in, only for the documents folder', async () => {
      expect((await tokenRequest(PATH, '')).status).toBe(401);
      expect((await tokenRequest('elsewhere/x.pdf')).status).toBe(400);
      const ok = await tokenRequest(PATH);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.type).toBe('blob.generate-client-token');
      expect(body.clientToken).toMatch(/^vercel_blob_client_/);
    });

    it('has no local upload route', async () => {
      expect((await putLocal(PATH, PDF)).status).toBe(404);
    });
  });
});

/**
 * What an upload may be: only the kinds of file AEROBOOK keeps, and never a
 * replacement for a file already stored. Both are signed into what the
 * server hands the browser, so the browser cannot loosen them; Vercel Blob
 * enforces them. And a stored document is only served as its own type when
 * that is a kind AEROBOOK keeps.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Presigned uploads ask Vercel for a signed token first. Stand in for Vercel
// with a token whose scope is exactly what the server asked for.
vi.mock('@vercel/blob', async (original) => ({
  ...(await original<typeof import('@vercel/blob')>()),
  issueSignedToken: vi.fn(async (scope: Record<string, unknown>) => ({
    delegationToken: `${Buffer.from(JSON.stringify(scope)).toString('base64url')}.signature`,
    clientSigningToken: 'test-signing-key',
    storeId: 'store_test123',
    validUntil: scope.validUntil,
  })),
}));

import { issueSignedToken } from '@vercel/blob';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { ALLOWED_DOCUMENT_TYPES } from '../src/lib/documents.js';

const PATH = 'files/fil_abc123/binder.pdf';
const WEBHOOK_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKIoaw+q2rs/eKk+dMXwNEYVfOiC9R6l6jIEtgtwfMVc=\n-----END PUBLIC KEY-----\n';

describe.skipIf(!TEST_DB)('upload limits', () => {
  let cookie: string;

  beforeEach(async () => {
    await freshDatabase();
    await createUser('Alice', 'alice@example.com', 'admin');
    cookie = await signIn('alice@example.com');
  });

  afterEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    delete process.env.BLOB_WEBHOOK_PUBLIC_KEY;
    delete process.env.FILES_DIR;
  });

  it('signs the kinds of file and no overwriting into a browser upload token', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_secretsecretsecretsecret';
    const r = await api('/api/files/upload', {
      cookie,
      body: { type: 'blob.generate-client-token', payload: { pathname: PATH, multipart: false, clientPayload: null } },
    });
    expect(r.status).toBe(200);
    const { clientToken } = await r.json();
    // vercel_blob_client_<store>_<base64 of "<signature>.<base64 of the constraints>">
    const signed = Buffer.from(clientToken.split('_').slice(4).join('_'), 'base64').toString();
    const constraints = JSON.parse(Buffer.from(signed.split('.')[1], 'base64').toString());
    expect(constraints).toMatchObject({ allowedContentTypes: ALLOWED_DOCUMENT_TYPES, allowOverwrite: false, pathname: PATH });
  });

  it('signs the kinds of file and no overwriting into a presigned upload', async () => {
    process.env.BLOB_STORE_ID = 'store_test123';
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = WEBHOOK_KEY;
    const r = await api('/api/files/upload', {
      cookie,
      body: { type: 'blob.generate-presigned-url', payload: { pathname: PATH, multipart: false, clientPayload: null } },
    });
    expect(r.status).toBe(200);
    expect(vi.mocked(issueSignedToken)).toHaveBeenCalledWith(expect.objectContaining({
      pathname: PATH, operations: ['put'], allowedContentTypes: ALLOWED_DOCUMENT_TYPES,
    }));
    const { params } = (await r.json()).presignedUrlPayload as { params: Record<string, string> };
    expect(params['vercel-blob-allowed-content-types'].split(',').sort()).toEqual([...ALLOWED_DOCUMENT_TYPES].sort());
    expect(params['vercel-blob-allow-overwrite']).toBe('false');
  });

  describe('serving a stored document', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'aerobook-files-'));
      process.env.FILES_DIR = dir;
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const storeAs = async (mimeType: string) => {
      await handle(new Request(`${ORIGIN}/api/files/local?path=${encodeURIComponent(PATH)}`, {
        method: 'PUT', body: new TextEncoder().encode('<html>hi</html>') as BodyInit, headers: { origin: ORIGIN, cookie },
      }));
      await api('/api/sync', {
        cookie,
        body: { changes: [{ collection: 'files', id: 'fil_abc123', baseVersion: 0, data: { id: 'fil_abc123', name: 'page.html', mimeType, size: 15, blobPath: PATH } }] },
      });
      return api(`/api/files/content?path=${encodeURIComponent(PATH)}`, { cookie });
    };

    it('serves a kind of file AEROBOOK keeps as itself', async () => {
      expect((await storeAs('application/pdf')).headers.get('content-type')).toBe('application/pdf');
    });

    it('serves anything else as a plain download, whatever the record claims', async () => {
      for (const claimed of ['text/html', 'image/svg+xml', 'application/javascript']) {
        await freshDatabase();
        await createUser('Alice', 'alice@example.com', 'admin');
        cookie = await signIn('alice@example.com');
        const r = await storeAs(claimed);
        expect(r.headers.get('content-type')).toBe('application/octet-stream');
        expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
      }
    });
  });
});

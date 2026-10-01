import { describe, expect, it } from 'vitest';
import { attachmentProblem, attachmentsProblem, documentType, renamedDocument, servedType } from './documents';

describe('documentType', () => {
  it('keeps PDFs, photos and office documents', () => {
    expect(documentType('binder.pdf', 'application/pdf')).toBe('application/pdf');
    expect(documentType('IMG_0001.JPG', 'image/jpeg')).toBe('image/jpeg');
    expect(documentType('logbook.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(documentType('quote.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('goes by the name when the browser gives no type', () => {
    expect(documentType('IMG_0002.HEIC', '')).toBe('image/heic');
    expect(documentType('policy.pdf', undefined)).toBe('application/pdf');
    expect(documentType('old.doc', 'application/octet-stream')).toBe('application/msword');
  });

  it('refuses web pages, images that can carry script, programs and archives', () => {
    expect(documentType('page.html', 'text/html')).toBeNull();
    expect(documentType('logo.svg', 'image/svg+xml')).toBeNull();
    expect(documentType('setup.exe', 'application/x-msdownload')).toBeNull();
    expect(documentType('bundle.zip', 'application/zip')).toBeNull();
    expect(documentType('script.js', '')).toBeNull();
    expect(documentType('no-extension', '')).toBeNull();
  });

  it('refuses a type it does not keep even under a harmless-looking name', () => {
    expect(documentType('invoice.pdf', 'text/html')).toBeNull();
  });
});

describe('servedType', () => {
  it('serves a kept type as itself and anything else as a plain download', () => {
    expect(servedType('application/pdf')).toBe('application/pdf');
    expect(servedType('IMAGE/JPEG')).toBe('image/jpeg');
    expect(servedType('text/html')).toBe('application/octet-stream');
    expect(servedType('image/svg+xml')).toBe('application/octet-stream');
    expect(servedType(null)).toBe('application/octet-stream');
  });
});

describe('renamedDocument', () => {
  it('keeps the original extension, whether or not it was typed', () => {
    expect(renamedDocument('IMG_2041.pdf', 'N123AB insurance binder')).toBe('N123AB insurance binder.pdf');
    expect(renamedDocument('IMG_2041.pdf', 'Binder.PDF')).toBe('Binder.pdf');
    expect(renamedDocument('scan.jpeg', 'Logbook page 3')).toBe('Logbook page 3.jpeg');
  });

  it('tidies spaces and leaves out slashes and control characters', () => {
    expect(renamedDocument('a.pdf', '  Hull / liability\nquote  ')).toBe('Hull liability quote.pdf');
  });

  it('refuses a name with nothing in it', () => {
    expect(renamedDocument('a.pdf', '   ')).toBeNull();
    expect(renamedDocument('a.pdf', '.pdf')).toBeNull();
  });

  it('keeps a name within 200 characters', () => {
    expect(renamedDocument('a.pdf', 'x'.repeat(300))).toHaveLength(200);
  });
});

describe('attachmentProblem', () => {
  const MB = 1024 * 1024;
  const stored = { name: 'binder.pdf', mimeType: 'application/pdf', size: MB, blobPath: 'files/fil_abcd/binder.pdf' };

  it('lets a stored document of a kept kind go', () => {
    expect(attachmentProblem(stored, 25 * MB)).toBeNull();
    expect(attachmentProblem({ ...stored, mimeType: 'image/jpeg' }, 25 * MB)).toBeNull();
  });

  it('says why one cannot', () => {
    expect(attachmentProblem({ ...stored, blobPath: undefined }, 25 * MB)).toMatch(/only on the device/);
    expect(attachmentProblem({ ...stored, mimeType: 'text/html' }, 25 * MB)).toMatch(/Not a kind of file/);
    expect(attachmentProblem({ ...stored, size: 26 * MB }, 25 * MB)).toBe('Too large to email');
  });
});

describe('attachmentsProblem', () => {
  const limits = { maxFiles: 2, maxBytes: 10 * 1024 * 1024 };

  it('allows what fits on one email', () => {
    expect(attachmentsProblem([], limits)).toBeNull();
    expect(attachmentsProblem([{ size: 4 * 1024 * 1024 }, { size: 6 * 1024 * 1024 }], limits)).toBeNull();
  });

  it('says when there are too many or they are too large together', () => {
    expect(attachmentsProblem([{ size: 1 }, { size: 1 }, { size: 1 }], limits)).toMatch(/at most 2 documents/);
    expect(attachmentsProblem([{ size: 6 * 1024 * 1024 }, { size: 6 * 1024 * 1024 }], limits)).toMatch(/more than 10 MB/);
  });
});

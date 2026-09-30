import { describe, expect, it } from 'vitest';
import { documentType, servedType } from './documents';

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

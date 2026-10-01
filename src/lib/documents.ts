/**
 * The kinds of file AEROBOOK keeps as documents: PDFs, photos and scans, and
 * office documents. Anything else (web pages, SVG, scripts, programs,
 * archives) is refused on upload, by the browser and again by the storage
 * token the server issues. Shared by the app and the server, so it imports
 * nothing.
 */
export const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

export const ALLOWED_DOCUMENT_TYPES: string[] = [...new Set(Object.values(DOCUMENT_TYPES))];

/** For the file picker's accept attribute. */
export const DOCUMENT_ACCEPT = Object.keys(DOCUMENT_TYPES).map((ext) => `.${ext}`).join(',');

export const DOCUMENT_TYPES_HINT = 'PDF, photo (JPEG, PNG, HEIC and similar), Word, Excel, or plain text';

/**
 * The media type to store a file as, or null when AEROBOOK does not keep that
 * kind of file. The browser's own type wins when it is one we keep; when the
 * browser gives none (it often does not for HEIC or Office files), the
 * extension decides.
 */
export function documentType(name: string, browserType?: string | null): string | null {
  const given = (browserType ?? '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_DOCUMENT_TYPES.includes(given)) return given;
  // A type the browser named that we do not keep is refused whatever the
  // name says: a web page renamed to .pdf is still a web page.
  if (given && given !== 'application/octet-stream') return null;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return DOCUMENT_TYPES[ext] ?? null;
}

/** The type to serve a stored document as: a kept type, or a plain download. */
export function servedType(recorded: string | null | undefined): string {
  const t = (recorded ?? '').split(';')[0].trim().toLowerCase();
  return ALLOWED_DOCUMENT_TYPES.includes(t) ? t : 'application/octet-stream';
}

/**
 * A new name for a stored document, or null when there is nothing usable.
 * The original extension stays on, so the download still opens in the right
 * app: the stored type does not change with the name.
 */
export function renamedDocument(original: string, input: string): string | null {
  let name = input.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const ext = /\.([a-z0-9]+)$/i.exec(original)?.[0] ?? '';
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) name = name.slice(0, -ext.length).trim();
  if (!name) return null;
  return `${name.slice(0, 200 - ext.length)}${ext}`;
}

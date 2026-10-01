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

/**
 * Why a document cannot be sent as an email attachment, in words for the
 * person sending it; null when it can. The server checks all of this again.
 */
export function attachmentProblem(
  file: { name: string; mimeType: string; size: number; blobPath?: string },
  maxFileBytes: number,
): string | null {
  if (!file.blobPath) return 'Still only on the device it was added from, so it cannot be sent yet';
  if (!ALLOWED_DOCUMENT_TYPES.includes((file.mimeType ?? '').split(';')[0].trim().toLowerCase())) {
    return 'Not a kind of file AEROBOOK sends';
  }
  if (file.size > maxFileBytes) return 'Too large to email';
  return null;
}

/** Why these documents together cannot go on one email; null when they can. */
export function attachmentsProblem(
  files: { size: number }[],
  limits: { maxFiles: number; maxBytes: number },
): string | null {
  if (files.length > limits.maxFiles) return `One email can carry at most ${limits.maxFiles} documents. Remove some, or send them in two emails.`;
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (total > limits.maxBytes) {
    return `These documents come to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB, too much for one email. Remove some, or send them in two emails.`;
  }
  return null;
}

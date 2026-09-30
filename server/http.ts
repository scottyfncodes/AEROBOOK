/**
 * Replies and request checks shared by every route: the one-function API in
 * app.ts, and the messaging routes in messaging.ts.
 */
import { BadRequest } from './sync.js';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const error = (status: number, message: string) => json({ error: message }, status);

/**
 * A refusal with its status, thrown from deep inside a route and turned into
 * a reply by handle(). "Not found" is used for anything the person may not
 * see, so an id they are not allowed near looks like one that does not exist.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Writes must be same-origin JSON. A page on another site can make a
 * browser send cookies with a form post, but not with this content type
 * without asking first, and not with this site's Origin.
 */
export function checkWrite(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error(403, 'Cross-origin request refused');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return error(415, 'Expected application/json');
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return error(413, 'Request too large');
  return null;
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest('Request too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('Invalid JSON');
  }
}

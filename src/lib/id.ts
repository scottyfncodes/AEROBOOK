/** Stable, sortable-ish ids. Prefixed so a loose id is self-describing in exports. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomPart(len: number): string {
  const bytes = new Uint8Array(len);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomPart(8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

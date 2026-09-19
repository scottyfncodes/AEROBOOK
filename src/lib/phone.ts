/** Digits only, with a leading US country code dropped so 15595551212 == 5595551212. */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function formatPhone(raw: string | null | undefined): string {
  const d = normalizePhone(raw);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return raw ? String(raw).trim() : '';
}

export function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(raw: string | null | undefined): boolean {
  return EMAIL_RE.test(normalizeEmail(raw));
}

/** FAA ZIPs arrive as ZIP+4 with no hyphen (931051947). Show them properly. */
export function formatZip(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return String(raw).trim();
}

export function zip5(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(0, 5);
}

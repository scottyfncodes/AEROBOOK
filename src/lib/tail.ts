/**
 * Tail-number handling. US registrations arrive in every shape imaginable:
 * "n917jh", "N-917JH", "917JH", " N917JH ". They all mean the same aircraft.
 */

/** Uppercase, strip everything that isn't A-Z/0-9, and drop a leading N. */
export function normalizeTail(raw: string | null | undefined): string {
  if (!raw) return '';
  const stripped = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!stripped) return '';
  return stripped.startsWith('N') ? stripped.slice(1) : stripped;
}

/** The display form: an N-number with its N, otherwise the cleaned original. */
export function formatTail(raw: string | null | undefined): string {
  if (!raw) return '';
  const stripped = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!stripped) return '';
  if (stripped.startsWith('N')) return stripped;
  // A bare US registration is digits-then-optional-letters (917JH, 3011).
  if (/^\d/.test(stripped)) return `N${stripped}`;
  return stripped;
}

/** True when both strings point at the same aircraft. */
export function sameTail(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTail(a);
  const nb = normalizeTail(b);
  return na !== '' && na === nb;
}

/** Looks like a US N-number we can hand to the FAA registry. */
export function isUsRegistration(raw: string | null | undefined): boolean {
  return /^\d{1,5}[A-Z]{0,2}$/.test(normalizeTail(raw));
}

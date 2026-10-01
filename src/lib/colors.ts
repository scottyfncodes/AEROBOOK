/**
 * The colors someone can pick for their name. The server keeps who has which
 * (server/people.ts, same keys); each is a mid tone that reads on both the
 * dark and the light theme. A color is never the only way to tell who:
 * the name is always beside it.
 */
export const PROFILE_COLORS: { key: string; label: string; hex: string }[] = [
  { key: 'red', label: 'Red', hex: '#e5484d' },
  { key: 'orange', label: 'Orange', hex: '#f76b15' },
  { key: 'yellow', label: 'Yellow', hex: '#d9b100' },
  { key: 'green', label: 'Green', hex: '#30a46c' },
  { key: 'teal', label: 'Teal', hex: '#12a594' },
  { key: 'sky', label: 'Sky', hex: '#2f9bd6' },
  { key: 'blue', label: 'Blue', hex: '#3e63dd' },
  { key: 'purple', label: 'Purple', hex: '#8e4ec6' },
  { key: 'pink', label: 'Pink', hex: '#d6409f' },
  { key: 'brown', label: 'Brown', hex: '#a07553' },
];

export function colorHex(key: string | null | undefined): string | undefined {
  return PROFILE_COLORS.find((c) => c.key === key)?.hex;
}

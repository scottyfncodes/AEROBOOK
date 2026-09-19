import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('parses headers and rows', () => {
    const t = parseCsv('Tail,Owner\nN917JH,Heine John\nN441FP,Humphrey Marlon\n');
    expect(t.headers).toEqual(['Tail', 'Owner']);
    expect(t.rows).toEqual([
      ['N917JH', 'Heine John'],
      ['N441FP', 'Humphrey Marlon'],
    ]);
    expect(t.warnings).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const t = parseCsv('Tail,Owner\r\nN917JH,Heine John\r\n');
    expect(t.rows).toEqual([['N917JH', 'Heine John']]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const t = parseCsv('﻿Tail,Owner\nN1,X\n');
    expect(t.headers[0]).toBe('Tail');
  });

  it('handles quoted fields with commas, quotes and newlines', () => {
    const t = parseCsv('Owner,Notes\n"Heine, John","Said ""call me"" later"\n"A","line1\nline2"\n');
    expect(t.rows[0]).toEqual(['Heine, John', 'Said "call me" later']);
    expect(t.rows[1]).toEqual(['A', 'line1\nline2']);
  });

  it('skips blank rows and says so', () => {
    const t = parseCsv('Tail,Owner\nN1,A\n\n\nN2,B\n');
    expect(t.rows).toHaveLength(2);
    expect(t.warnings.join(' ')).toMatch(/blank/i);
  });

  it('pads short rows and reports ragged ones', () => {
    const t = parseCsv('A,B,C\n1,2\n1,2,3,4\n');
    expect(t.rows[0]).toEqual(['1', '2', '']);
    expect(t.rows[1]).toEqual(['1', '2', '3']);
    expect(t.warnings.join(' ')).toMatch(/different number of columns/i);
  });

  it('renames duplicate headers instead of losing a column', () => {
    const t = parseCsv('Email,Email\na@b.com,c@d.com\n');
    expect(t.headers).toEqual(['Email', 'Email (2)']);
    expect(t.rows[0]).toEqual(['a@b.com', 'c@d.com']);
  });

  it('names blank headers', () => {
    const t = parseCsv('Tail,,Owner\nN1,x,A\n');
    expect(t.headers).toEqual(['Tail', 'Column 2', 'Owner']);
  });

  it('does not throw on an unterminated quote', () => {
    const t = parseCsv('A,B\n"unterminated,B\n');
    expect(t.warnings.join(' ')).toMatch(/quoted value/i);
    expect(t.rows.length).toBeGreaterThan(0);
  });

  it('reports an empty file rather than crashing', () => {
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('').warnings.join(' ')).toMatch(/no rows/i);
    expect(parseCsv('\n\n\n').headers).toEqual([]);
  });

  it('handles a header-only file', () => {
    const t = parseCsv('Tail,Owner\n');
    expect(t.headers).toEqual(['Tail', 'Owner']);
    expect(t.rows).toEqual([]);
  });

  it('keeps a quote that appears mid-value', () => {
    const t = parseCsv('A\n6" prop\n');
    expect(t.rows[0]).toEqual(['6" prop']);
  });
});

describe('detectDelimiter', () => {
  it('finds tabs and semicolons', () => {
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });

  it('ignores delimiters inside quotes', () => {
    expect(parseCsv('A;B\n"x;y";z\n').rows[0]).toEqual(['x;y', 'z']);
  });
});

describe('toCsv', () => {
  it('quotes values that need it', () => {
    expect(toCsv(['A', 'B'], [['plain', 'has,comma']])).toBe('A,B\r\nplain,"has,comma"');
    expect(toCsv(['A'], [['say "hi"']])).toBe('A\r\n"say ""hi"""');
  });

  it('round-trips through the parser', () => {
    const text = toCsv(['Owner', 'Notes'], [['Heine, John', 'line1\nline2']]);
    expect(parseCsv(text).rows[0]).toEqual(['Heine, John', 'line1\nline2']);
  });
});

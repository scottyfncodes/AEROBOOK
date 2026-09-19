import { describe, expect, it } from 'vitest';
import { formatTail, isUsRegistration, normalizeTail, sameTail } from './tail';

describe('normalizeTail', () => {
  it('uppercases, strips punctuation and drops the leading N', () => {
    expect(normalizeTail('n917jh')).toBe('917JH');
    expect(normalizeTail('N917JH')).toBe('917JH');
    expect(normalizeTail('  n-917-jh  ')).toBe('917JH');
    expect(normalizeTail('N3011')).toBe('3011');
  });

  it('is empty for empty input', () => {
    expect(normalizeTail('')).toBe('');
    expect(normalizeTail(null)).toBe('');
    expect(normalizeTail(undefined)).toBe('');
    expect(normalizeTail('   ')).toBe('');
    expect(normalizeTail('---')).toBe('');
  });
});

describe('formatTail', () => {
  it('always shows the N', () => {
    expect(formatTail('n917jh')).toBe('N917JH');
    expect(formatTail('917jh')).toBe('N917JH');
    expect(formatTail('N-441FP')).toBe('N441FP');
  });

  it('leaves a non-US registration alone', () => {
    expect(formatTail('C-GABC')).toBe('CGABC');
  });
});

describe('sameTail', () => {
  it('matches across formatting', () => {
    expect(sameTail('n917jh', 'N917JH')).toBe(true);
    expect(sameTail('N-917JH', '917jh')).toBe(true);
  });

  it('never matches nothing against nothing', () => {
    expect(sameTail('', '')).toBe(false);
    expect(sameTail('N917JH', 'N441FP')).toBe(false);
  });
});

describe('isUsRegistration', () => {
  it('recognises N-numbers', () => {
    expect(isUsRegistration('N917JH')).toBe(true);
    expect(isUsRegistration('N3011')).toBe(true);
    expect(isUsRegistration('C-GABC')).toBe(false);
  });
});

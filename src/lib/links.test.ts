import { describe, expect, it } from 'vitest';
import { LAYOVER_CATEGORIES, airportLinks, faaRegistryLink, layoverLink, mapsLink, marketLinks, telLink, webSearchLink } from './links';

describe('faaRegistryLink', () => {
  it('builds the FAA N-Number inquiry URL from any spelling', () => {
    expect(faaRegistryLink('n917jh')!.url).toBe('https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=917JH');
    expect(faaRegistryLink('N-917-JH')!.url).toContain('nNumberTxt=917JH');
    expect(faaRegistryLink('N917JH')!.isSearch).toBe(false);
  });

  it('returns nothing rather than a broken link for a non-US registration', () => {
    expect(faaRegistryLink('C-GABC')).toBeNull();
    expect(faaRegistryLink('')).toBeNull();
  });
});

describe('other links', () => {
  it('encodes map and search queries', () => {
    expect(mapsLink(['1308 Santa Teresita Dr', 'Santa Barbara', 'CA'])!.url)
      .toBe('https://www.google.com/maps/search/?api=1&query=1308%20Santa%20Teresita%20Dr%2C%20Santa%20Barbara%2C%20CA');
    expect(webSearchLink('Cirrus SR22T value')!.url).toContain('q=Cirrus%20SR22T%20value');
  });

  it('returns nothing when there is nothing to search for', () => {
    expect(mapsLink([undefined, '', undefined])).toBeNull();
    expect(webSearchLink('   ')).toBeNull();
  });

  it('strips formatting from a tel: link', () => {
    expect(telLink('(781) 891-7648')).toBe('tel:7818917648');
  });

  it('marks market listings as searches', () => {
    const links = marketLinks('Cirrus', 'SR22T', 'N917JH');
    expect(links.filter((l) => l.isSearch).length).toBeGreaterThan(0);
    expect(links.every((l) => l.url.startsWith('https://'))).toBe(true);
    expect(marketLinks('', '')).toEqual([]);
  });

  it('builds airport links from an identifier', () => {
    const links = airportLinks('ksba');
    expect(links.map((l) => l.url)).toEqual([
      'https://www.airnav.com/airport/KSBA',
      'https://skyvector.com/airport/KSBA',
      'https://aviationweather.gov/data/metar/?ids=KSBA&decoded=yes',
    ]);
    expect(airportLinks('')).toEqual([]);
  });
});

describe('layover categories', () => {
  it('covers the categories the brief asks for', () => {
    const keys = LAYOVER_CATEGORIES.map((c) => c.key);
    for (const k of ['michelin', 'dinner', 'coffee', 'brewery', 'bars', 'interesting', 'outdoors', 'attractions', 'gear', 'transport']) {
      expect(keys).toContain(k);
    }
  });

  it('builds a live search for the destination, never a stored business', () => {
    for (const category of LAYOVER_CATEGORIES) {
      const link = layoverLink(category, 'Santa Barbara');
      expect(link.url.startsWith('https://')).toBe(true);
      expect(link.url).toContain('Santa%20Barbara');
      expect(link.isSearch).toBe(true);
    }
  });

  it('sends Michelin queries to the Michelin Guide', () => {
    const link = layoverLink(LAYOVER_CATEGORIES.find((c) => c.key === 'michelin')!, 'Chicago');
    expect(link.url).toContain('guide.michelin.com');
  });
});

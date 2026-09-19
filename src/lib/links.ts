/**
 * External links.
 *
 * Every link here is built from a documented, stable search endpoint and the
 * user's own data — nothing is a remembered URL for a specific business or
 * aircraft. Where a link is a *search* rather than a verified destination, the
 * UI says so, because a broker following a dead link in front of a client is
 * worse than no link at all.
 */
import { isUsRegistration, normalizeTail } from './tail';

export interface ExternalLink {
  label: string;
  url: string;
  /** True when the destination is a search, not a verified single page. */
  isSearch: boolean;
  note?: string;
}

function q(value: string): string {
  return encodeURIComponent(value.trim());
}

/** FAA aircraft registry lookup by N-number. Exact record, not a search. */
export function faaRegistryLink(tail: string): ExternalLink | null {
  const key = normalizeTail(tail);
  if (!key || !isUsRegistration(tail)) return null;
  return {
    label: 'FAA registry',
    url: `https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=${q(key)}`,
    isSearch: false,
    note: 'Official FAA N-Number Inquiry',
  };
}

export function mapsLink(parts: (string | undefined)[], label = 'Map'): ExternalLink | null {
  const query = parts.filter(Boolean).join(', ').trim();
  if (!query) return null;
  return { label, url: `https://www.google.com/maps/search/?api=1&query=${q(query)}`, isSearch: true };
}

export function webSearchLink(query: string, label = 'Search the web'): ExternalLink | null {
  if (!query.trim()) return null;
  return { label, url: `https://www.google.com/search?q=${q(query)}`, isSearch: true };
}

export function telLink(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

export function smsLink(phone: string): string {
  return `sms:${phone.replace(/[^\d+]/g, '')}`;
}

/** Aircraft-market listings. Searches, deliberately — listings come and go. */
export function marketLinks(make: string, model: string, tail?: string): ExternalLink[] {
  const links: ExternalLink[] = [];
  const terms = [make, model].filter(Boolean).join(' ');
  if (terms) {
    links.push({
      label: `Controller — ${terms}`,
      url: `https://www.controller.com/listings/search?Keywords=${q(terms)}`,
      isSearch: true,
    });
    links.push({
      label: `Trade-A-Plane — ${terms}`,
      url: `https://www.trade-a-plane.com/search?s-type=aircraft&search=${q(terms)}`,
      isSearch: true,
    });
  }
  if (tail) {
    const t = normalizeTail(tail);
    if (t) {
      links.push({ label: `FlightAware — N${t}`, url: `https://www.flightaware.com/live/flight/N${q(t)}`, isSearch: false, note: 'Live flight tracking, if the aircraft is tracked' });
    }
  }
  return links;
}

export interface LayoverCategory {
  key: string;
  label: string;
  hint: string;
  /** Built at click time from the destination the user typed. */
  query: (place: string) => string;
  provider?: 'maps' | 'web' | 'michelin';
}

/**
 * Layover categories. Each one opens a live search for the destination — the
 * app never ships a list of restaurants, because a hard-coded list is stale
 * the moment a place closes.
 */
export const LAYOVER_CATEGORIES: LayoverCategory[] = [
  { key: 'michelin', label: 'Michelin', hint: 'Starred and Bib Gourmand', query: (p) => p, provider: 'michelin' },
  { key: 'dinner', label: 'Excellent dinner', hint: 'Worth the cab fare', query: (p) => `best restaurants in ${p}`, provider: 'web' },
  { key: 'datenight', label: 'Date-night quality', hint: 'Book ahead', query: (p) => `romantic fine dining ${p}`, provider: 'web' },
  { key: 'steak', label: 'Steak', hint: '', query: (p) => `steakhouse near ${p}`, provider: 'maps' },
  { key: 'seafood', label: 'Seafood', hint: '', query: (p) => `seafood restaurant near ${p}`, provider: 'maps' },
  { key: 'local', label: 'Local favorite', hint: 'Where locals actually eat', query: (p) => `where locals eat in ${p}`, provider: 'web' },
  { key: 'fastgood', label: 'Fast but good', hint: 'Between legs', query: (p) => `quick casual food near ${p}`, provider: 'maps' },
  { key: 'breakfast', label: 'Breakfast', hint: 'Early gate', query: (p) => `breakfast near ${p}`, provider: 'maps' },
  { key: 'coffee', label: 'Coffee', hint: 'Third wave', query: (p) => `specialty coffee near ${p}`, provider: 'maps' },
  { key: 'brewery', label: 'Breweries', hint: '', query: (p) => `brewery near ${p}`, provider: 'maps' },
  { key: 'bars', label: 'Bars', hint: 'Cocktails', query: (p) => `cocktail bar near ${p}`, provider: 'maps' },
  { key: 'interesting', label: 'Interesting food', hint: 'The reason to leave the hotel', query: (p) => `most interesting food in ${p}`, provider: 'web' },
  { key: 'airportfood', label: 'Quick airport meal', hint: 'Landside and airside', query: (p) => `best food at ${p} airport`, provider: 'web' },
  { key: 'outdoors', label: 'Outdoor activities', hint: 'Hike, run, water', query: (p) => `hiking and outdoor activities near ${p}`, provider: 'web' },
  { key: 'attractions', label: 'Local attractions', hint: '', query: (p) => `things to do in ${p}`, provider: 'web' },
  { key: 'gear', label: 'Gear', hint: 'Outdoor and pilot shops', query: (p) => `outdoor gear store near ${p}`, provider: 'maps' },
  { key: 'transport', label: 'Airport transportation', hint: 'Rideshare, rental, transit', query: (p) => `${p} airport ground transportation`, provider: 'web' },
  { key: 'fbo', label: 'FBOs', hint: 'If you are flying in yourself', query: (p) => `${p} airport FBO`, provider: 'web' },
];

export function layoverLink(category: LayoverCategory, place: string): ExternalLink {
  const query = category.query(place);
  if (category.provider === 'michelin') {
    return {
      label: `Michelin Guide — ${place}`,
      url: `https://guide.michelin.com/en/search?q=${q(query)}`,
      isSearch: true,
      note: 'Michelin Guide site search',
    };
  }
  if (category.provider === 'maps') {
    return { label: category.label, url: `https://www.google.com/maps/search/?api=1&query=${q(query)}`, isSearch: true };
  }
  return { label: category.label, url: `https://www.google.com/search?q=${q(query)}`, isSearch: true };
}

/** Airport information. AirNav keys off the identifier directly. */
export function airportLinks(identifier: string): ExternalLink[] {
  const id = identifier.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!id) return [];
  return [
    { label: `AirNav — ${id}`, url: `https://www.airnav.com/airport/${q(id)}`, isSearch: false, note: 'Fuel, FBOs, runways, frequencies' },
    { label: `SkyVector — ${id}`, url: `https://skyvector.com/airport/${q(id)}`, isSearch: false, note: 'Charts and airport diagram' },
    { label: `Aviation Weather — ${id}`, url: `https://aviationweather.gov/data/metar/?ids=${q(id)}&decoded=yes`, isSearch: false, note: 'Official NWS METAR/TAF' },
  ];
}

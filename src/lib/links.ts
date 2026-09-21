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

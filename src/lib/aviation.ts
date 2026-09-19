/**
 * Aviation math.
 *
 * Standard, checkable formulas only — ISA atmosphere, the wind triangle, and
 * arithmetic. Nothing here invents aircraft performance data: every number the
 * user sees comes from a number the user typed.
 */

export const KT_PER_MPH = 0.868976;
export const NM_PER_SM = 0.868976;
export const NM_PER_KM = 0.539957;
export const FT_PER_M = 3.28084;
export const L_PER_GAL = 3.78541;
export const KG_PER_LB = 0.453592;

/** Standard planning weights. Actual density varies with temperature. */
export const FUEL_WEIGHTS: Record<string, number> = {
  '100LL': 6.0,
  'Jet A': 6.7,
  'Mogas': 6.0,
};

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function normalizeHeading(deg: number): number {
  const n = deg % 360;
  return n < 0 ? n + 360 : n;
}

export interface WindComponents {
  /** Positive = headwind, negative = tailwind. */
  headwind: number;
  /** Absolute magnitude of the crosswind. */
  crosswind: number;
  /** 'left' or 'right' — which side the crosswind comes from. */
  crosswindFrom: 'left' | 'right' | 'none';
  /** Wind angle off the nose, 0–180. */
  angle: number;
}

/** Runway heading and wind direction are both degrees magnetic (or both true). */
export function windComponents(runwayHeading: number, windDirection: number, windSpeed: number): WindComponents {
  const delta = normalizeHeading(windDirection - runwayHeading);
  const rad = toRad(delta);
  const headwind = windSpeed * Math.cos(rad);
  const signed = windSpeed * Math.sin(rad);
  const angle = delta > 180 ? 360 - delta : delta;
  return {
    headwind,
    crosswind: Math.abs(signed),
    crosswindFrom: Math.abs(signed) < 0.05 ? 'none' : signed > 0 ? 'right' : 'left',
    angle,
  };
}

/** Pressure altitude from field elevation and an altimeter setting in inHg. */
export function pressureAltitude(fieldElevation: number, altimeterInHg: number): number {
  return fieldElevation + (29.92 - altimeterInHg) * 1000;
}

/** ISA temperature in °C at a pressure altitude in feet. */
export function isaTemp(pressureAlt: number): number {
  return 15 - 1.98 * (pressureAlt / 1000);
}

/** Density altitude in feet. The standard 118.8 ft per °C deviation. */
export function densityAltitude(pressureAlt: number, oatCelsius: number): number {
  return pressureAlt + 118.8 * (oatCelsius - isaTemp(pressureAlt));
}

/** Density ratio σ from a density altitude, per the ISA model. */
export function densityRatio(densityAlt: number): number {
  return Math.pow(1 - 6.8755856e-6 * densityAlt, 4.2558797);
}

/** True airspeed from calibrated airspeed and density altitude. */
export function trueAirspeed(cas: number, densityAlt: number): number {
  const sigma = densityRatio(densityAlt);
  if (sigma <= 0) return cas;
  return cas / Math.sqrt(sigma);
}

export interface WindTriangle {
  /** Degrees to add to the course to hold it — signed. */
  windCorrectionAngle: number;
  /** The heading to fly. */
  heading: number;
  groundSpeed: number;
  /** True when the wind is stronger than the aircraft can correct for. */
  unflyable: boolean;
}

export function windTriangle(
  trueAirspeedKt: number,
  trueCourse: number,
  windDirection: number,
  windSpeed: number,
): WindTriangle {
  if (trueAirspeedKt <= 0) {
    return { windCorrectionAngle: 0, heading: trueCourse, groundSpeed: 0, unflyable: true };
  }
  const windAngle = toRad(windDirection - trueCourse);
  const sinWca = (windSpeed * Math.sin(windAngle)) / trueAirspeedKt;
  if (Math.abs(sinWca) > 1) {
    return { windCorrectionAngle: 0, heading: trueCourse, groundSpeed: 0, unflyable: true };
  }
  const wca = Math.asin(sinWca);
  const groundSpeed = trueAirspeedKt * Math.cos(wca) - windSpeed * Math.cos(windAngle);
  return {
    windCorrectionAngle: toDeg(wca),
    heading: normalizeHeading(trueCourse + toDeg(wca)),
    groundSpeed,
    unflyable: groundSpeed <= 0,
  };
}

export interface TripPlan {
  timeHours: number;
  fuelBurned: number;
  reserveFuel: number;
  totalFuelRequired: number;
  /** Null when no usable fuel figure was supplied. */
  remaining: number | null;
  enoughFuel: boolean | null;
}

export function planTrip(input: {
  distanceNm: number;
  groundSpeedKt: number;
  burnGph: number;
  reserveMinutes: number;
  usableFuelGal?: number;
}): TripPlan {
  const { distanceNm, groundSpeedKt, burnGph, reserveMinutes, usableFuelGal } = input;
  const timeHours = groundSpeedKt > 0 ? distanceNm / groundSpeedKt : 0;
  const fuelBurned = timeHours * burnGph;
  const reserveFuel = (reserveMinutes / 60) * burnGph;
  const totalFuelRequired = fuelBurned + reserveFuel;
  const remaining = usableFuelGal && usableFuelGal > 0 ? usableFuelGal - totalFuelRequired : null;
  return {
    timeHours,
    fuelBurned,
    reserveFuel,
    totalFuelRequired,
    remaining,
    enoughFuel: remaining === null ? null : remaining >= 0,
  };
}

export function formatHoursMinutes(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export interface Station {
  label: string;
  weight: number;
  arm: number;
}

export interface WeightBalance {
  totalWeight: number;
  totalMoment: number;
  /** Null when there is no weight on board. */
  cg: number | null;
  overGross: boolean | null;
  withinCgLimits: boolean | null;
}

export function weightAndBalance(
  stations: Station[],
  limits?: { maxGrossWeight?: number; forwardCgLimit?: number; aftCgLimit?: number },
): WeightBalance {
  let totalWeight = 0;
  let totalMoment = 0;
  for (const s of stations) {
    const w = Number.isFinite(s.weight) ? s.weight : 0;
    const a = Number.isFinite(s.arm) ? s.arm : 0;
    totalWeight += w;
    totalMoment += w * a;
  }
  const cg = totalWeight > 0 ? totalMoment / totalWeight : null;
  const overGross = limits?.maxGrossWeight ? totalWeight > limits.maxGrossWeight : null;
  let withinCgLimits: boolean | null = null;
  if (cg !== null && (limits?.forwardCgLimit !== undefined || limits?.aftCgLimit !== undefined)) {
    const fwdOk = limits.forwardCgLimit === undefined || cg >= limits.forwardCgLimit;
    const aftOk = limits.aftCgLimit === undefined || cg <= limits.aftCgLimit;
    withinCgLimits = fwdOk && aftOk;
  }
  return { totalWeight, totalMoment, cg, overGross, withinCgLimits };
}

export function gallonsToPounds(gallons: number, fuelType: keyof typeof FUEL_WEIGHTS | string): number {
  return gallons * (FUEL_WEIGHTS[fuelType] ?? 6.0);
}

export function poundsToGallons(pounds: number, fuelType: keyof typeof FUEL_WEIGHTS | string): number {
  const w = FUEL_WEIGHTS[fuelType] ?? 6.0;
  return w > 0 ? pounds / w : 0;
}

// ------------------------------------------------------------ insurance math

/** Hull premium from a declared value and a rate expressed as a percentage. */
export function hullPremium(hullValue: number, ratePercent: number): number {
  return hullValue * (ratePercent / 100);
}

/** The implied rate, as a percentage, from a hull value and a premium. */
export function impliedRate(hullValue: number, premium: number): number {
  return hullValue > 0 ? (premium / hullValue) * 100 : 0;
}

export interface DeductibleComparison {
  annualSaving: number;
  extraExposure: number;
  /** Years of the saving needed to cover one extra-deductible claim. */
  breakEvenYears: number | null;
}

export function compareDeductibles(input: {
  premiumA: number;
  deductibleA: number;
  premiumB: number;
  deductibleB: number;
}): DeductibleComparison {
  const annualSaving = input.premiumA - input.premiumB;
  const extraExposure = input.deductibleB - input.deductibleA;
  const breakEvenYears = annualSaving > 0 ? extraExposure / annualSaving : null;
  return { annualSaving, extraExposure, breakEvenYears };
}

export function convert(value: number, from: string, to: string): number | null {
  const table: Record<string, number> = {
    // length / distance, base = nautical miles
    nm: 1,
    sm: NM_PER_SM,
    km: NM_PER_KM,
    // speed, base = knots
    kt: 1,
    mph: KT_PER_MPH,
    kph: NM_PER_KM,
    // volume, base = gallons
    gal: 1,
    l: 1 / L_PER_GAL,
    // weight, base = pounds
    lb: 1,
    kg: 1 / KG_PER_LB,
    // altitude, base = feet
    ft: 1,
    m: FT_PER_M,
  };
  const a = table[from];
  const b = table[to];
  if (a === undefined || b === undefined) return null;
  return (value * a) / b;
}

export function celsiusToFahrenheit(c: number): number {
  return c * 1.8 + 32;
}

export function fahrenheitToCelsius(f: number): number {
  return (f - 32) / 1.8;
}

export function inHgToHpa(inHg: number): number {
  return inHg * 33.8639;
}

export function hpaToInHg(hpa: number): number {
  return hpa / 33.8639;
}

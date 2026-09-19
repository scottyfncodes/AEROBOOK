import { describe, expect, it } from 'vitest';
import {
  compareDeductibles, convert, densityAltitude, densityRatio, formatHoursMinutes, gallonsToPounds,
  hullPremium, impliedRate, isaTemp, normalizeHeading, planTrip, poundsToGallons, pressureAltitude,
  trueAirspeed, weightAndBalance, windComponents, windTriangle,
} from './aviation';

const near = (a: number, b: number, tol = 0.5) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('windComponents', () => {
  it('is all headwind when the wind is down the runway', () => {
    const w = windComponents(360, 360, 20);
    near(w.headwind, 20);
    near(w.crosswind, 0);
    expect(w.crosswindFrom).toBe('none');
  });

  it('is all tailwind from behind', () => {
    near(windComponents(360, 180, 20).headwind, -20);
  });

  it('is a pure crosswind at 90 degrees, from the correct side', () => {
    const right = windComponents(360, 90, 15);
    near(right.headwind, 0);
    near(right.crosswind, 15);
    expect(right.crosswindFrom).toBe('right');
    expect(windComponents(360, 270, 15).crosswindFrom).toBe('left');
  });

  it('splits a 45-degree wind evenly', () => {
    const w = windComponents(90, 45, 20);
    near(w.headwind, 14.14, 0.05);
    near(w.crosswind, 14.14, 0.05);
    expect(w.angle).toBe(45);
  });

  it('normalises headings across 360', () => {
    expect(normalizeHeading(370)).toBe(10);
    expect(normalizeHeading(-10)).toBe(350);
    near(windComponents(10, 350, 10).crosswind, windComponents(10, 30, 10).crosswind, 0.01);
  });
});

describe('atmosphere', () => {
  it('computes pressure altitude', () => {
    near(pressureAltitude(5000, 29.92), 5000);
    near(pressureAltitude(5000, 29.42), 5500);
    near(pressureAltitude(0, 30.42), -500);
  });

  it('knows the ISA lapse rate', () => {
    near(isaTemp(0), 15);
    near(isaTemp(5000), 5.1, 0.05);
  });

  it('computes density altitude', () => {
    near(densityAltitude(0, 15), 0);
    // A hot day at sea level pushes DA well above field elevation.
    near(densityAltitude(0, 35), 2376);
    near(densityAltitude(5000, 30), 7958, 1);
  });

  it('gives a density ratio of 1 at sea level and less above it', () => {
    near(densityRatio(0), 1, 0.001);
    expect(densityRatio(8000)).toBeLessThan(1);
  });

  it('computes true airspeed above calibrated', () => {
    near(trueAirspeed(120, 0), 120, 0.1);
    expect(trueAirspeed(120, 8000)).toBeGreaterThan(130);
  });
});

describe('windTriangle', () => {
  it('leaves heading alone in calm air', () => {
    const t = windTriangle(150, 90, 0, 0);
    near(t.windCorrectionAngle, 0);
    near(t.groundSpeed, 150);
    expect(t.unflyable).toBe(false);
  });

  it('subtracts a direct headwind from ground speed', () => {
    const t = windTriangle(150, 360, 360, 30);
    near(t.groundSpeed, 120);
    near(t.windCorrectionAngle, 0);
  });

  it('crabs into a crosswind', () => {
    const t = windTriangle(150, 90, 180, 30);
    expect(t.windCorrectionAngle).toBeGreaterThan(0);
    near(t.heading, 101.5, 0.5);
    expect(t.groundSpeed).toBeLessThan(150);
  });

  it('takes the full benefit of a direct tailwind', () => {
    const t = windTriangle(50, 360, 180, 90);
    near(t.groundSpeed, 140);
    expect(t.unflyable).toBe(false);
  });

  it('reports an unflyable leg rather than a nonsense number', () => {
    // A headwind stronger than the aircraft's true airspeed.
    expect(windTriangle(50, 360, 360, 90).unflyable).toBe(true);
    expect(windTriangle(0, 360, 0, 0).unflyable).toBe(true);
    // A crosswind the aircraft cannot out-crab.
    expect(windTriangle(50, 360, 90, 90).unflyable).toBe(true);
  });
});

describe('planTrip', () => {
  it('computes time, burn and reserve', () => {
    const p = planTrip({ distanceNm: 450, groundSpeedKt: 180, burnGph: 17, reserveMinutes: 45, usableFuelGal: 92 });
    near(p.timeHours, 2.5, 0.001);
    near(p.fuelBurned, 42.5, 0.01);
    near(p.reserveFuel, 12.75, 0.01);
    near(p.totalFuelRequired, 55.25, 0.01);
    near(p.remaining!, 36.75, 0.01);
    expect(p.enoughFuel).toBe(true);
  });

  it('says so when the fuel does not reach', () => {
    const p = planTrip({ distanceNm: 900, groundSpeedKt: 150, burnGph: 17, reserveMinutes: 45, usableFuelGal: 92 });
    expect(p.enoughFuel).toBe(false);
  });

  it('is undecided when no fuel quantity is given', () => {
    expect(planTrip({ distanceNm: 100, groundSpeedKt: 150, burnGph: 17, reserveMinutes: 45 }).enoughFuel).toBeNull();
  });

  it('does not divide by zero', () => {
    const p = planTrip({ distanceNm: 100, groundSpeedKt: 0, burnGph: 17, reserveMinutes: 45 });
    expect(p.timeHours).toBe(0);
    expect(formatHoursMinutes(p.timeHours)).toBe('—');
  });

  it('formats hours and minutes', () => {
    expect(formatHoursMinutes(2.5)).toBe('2h 30m');
    expect(formatHoursMinutes(0.25)).toBe('0h 15m');
  });
});

describe('weightAndBalance', () => {
  it('computes total weight, moment and CG', () => {
    const wb = weightAndBalance([
      { label: 'Empty', weight: 2300, arm: 138 },
      { label: 'Front', weight: 340, arm: 143 },
      { label: 'Fuel', weight: 552, arm: 153.75 },
    ]);
    near(wb.totalWeight, 3192);
    near(wb.totalMoment, 2300 * 138 + 340 * 143 + 552 * 153.75, 0.01);
    near(wb.cg!, 141.256, 0.01);
  });

  it('flags over gross and out-of-envelope', () => {
    const wb = weightAndBalance([{ label: 'All', weight: 3700, arm: 150 }], {
      maxGrossWeight: 3600, forwardCgLimit: 137.8, aftCgLimit: 148.1,
    });
    expect(wb.overGross).toBe(true);
    expect(wb.withinCgLimits).toBe(false);
  });

  it('is undecided when no limits are supplied', () => {
    const wb = weightAndBalance([{ label: 'All', weight: 100, arm: 10 }]);
    expect(wb.overGross).toBeNull();
    expect(wb.withinCgLimits).toBeNull();
  });

  it('has no CG with nothing on board', () => {
    expect(weightAndBalance([]).cg).toBeNull();
  });
});

describe('fuel and unit conversion', () => {
  it('converts gallons to pounds by fuel type', () => {
    near(gallonsToPounds(92, '100LL'), 552);
    near(gallonsToPounds(100, 'Jet A'), 670);
    near(poundsToGallons(552, '100LL'), 92);
  });

  it('converts distances, speeds, volumes and weights', () => {
    near(convert(100, 'nm', 'sm')!, 115.08, 0.05);
    near(convert(100, 'kt', 'mph')!, 115.08, 0.05);
    near(convert(10, 'gal', 'l')!, 37.85, 0.05);
    near(convert(100, 'lb', 'kg')!, 45.36, 0.05);
    near(convert(1000, 'ft', 'm')!, 304.8, 0.5);
    expect(convert(1, 'nm', 'parsecs')).toBeNull();
  });
});

describe('insurance math', () => {
  it('computes premium and implied rate', () => {
    near(hullPremium(850000, 1.2), 10200);
    near(impliedRate(850000, 10200), 1.2, 0.0001);
    expect(impliedRate(0, 5000)).toBe(0);
  });

  it('compares two deductible options', () => {
    const c = compareDeductibles({ premiumA: 10200, deductibleA: 2500, premiumB: 9200, deductibleB: 10000 });
    near(c.annualSaving, 1000);
    near(c.extraExposure, 7500);
    near(c.breakEvenYears!, 7.5, 0.01);
  });

  it('will not divide by a zero saving', () => {
    expect(compareDeductibles({ premiumA: 9000, deductibleA: 2500, premiumB: 9000, deductibleB: 5000 }).breakEvenYears).toBeNull();
  });
});

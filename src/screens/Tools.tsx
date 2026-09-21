/**
 * Aviation and insurance tools.
 *
 * Every number here is computed from a number the user typed, using a standard
 * published formula. Nothing pretends to know an aircraft's performance data.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconExternal, IconPlane, IconPlus, IconShield, IconTrash } from '../components/Icons';
import { Banner, Chip, KeyValue, NumberField, SelectField, TextField } from '../components/ui';
import { useDatabase } from '../data/useStore';
import {
  FUEL_WEIGHTS, celsiusToFahrenheit, compareDeductibles, convert, densityAltitude, fahrenheitToCelsius,
  formatHoursMinutes, gallonsToPounds, hpaToInHg, hullPremium, impliedRate, inHgToHpa, isaTemp, planTrip,
  pressureAltitude, trueAirspeed, weightAndBalance, windComponents, windTriangle, type Station,
} from '../lib/aviation';
import { airportLinks, faaRegistryLink } from '../lib/links';
import { normalizeTail } from '../lib/tail';

type Tool = 'wind' | 'atmosphere' | 'trip' | 'wb' | 'convert' | 'insurance' | 'lookup';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'wind', label: 'Wind components', hint: 'Crosswind and headwind for a runway' },
  { id: 'atmosphere', label: 'Density altitude', hint: 'Pressure altitude, DA and true airspeed' },
  { id: 'trip', label: 'Trip & fuel', hint: 'Time, burn, reserve and the wind triangle' },
  { id: 'wb', label: 'Weight & balance', hint: 'Your stations, your limits' },
  { id: 'convert', label: 'Conversions', hint: 'Distance, speed, fuel, weight, temperature' },
  { id: 'insurance', label: 'Insurance', hint: 'Premium, rate and deductible trade-offs' },
  { id: 'lookup', label: 'Lookups', hint: 'FAA registry and airport information' },
];

export default function Tools() {
  const [tool, setTool] = useState<Tool>('wind');

  return (
    <>
      <AppBar title="Tools" back="/settings" />
      <main className="page stack">
        <div className="filter-bar">
          {TOOLS.map((t) => (
            <button key={t.id} className={`filter-chip${tool === t.id ? ' is-active' : ''}`} onClick={() => setTool(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="small muted">{TOOLS.find((t) => t.id === tool)?.hint}</div>

        {tool === 'wind' ? <WindTool /> : null}
        {tool === 'atmosphere' ? <AtmosphereTool /> : null}
        {tool === 'trip' ? <TripTool /> : null}
        {tool === 'wb' ? <WeightBalanceTool /> : null}
        {tool === 'convert' ? <ConvertTool /> : null}
        {tool === 'insurance' ? <InsuranceTool /> : null}
        {tool === 'lookup' ? <LookupTool /> : null}
      </main>
    </>
  );
}

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function Result({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}

// -------------------------------------------------------------------- wind

function WindTool() {
  const [runway, setRunway] = useState('36');
  const [direction, setDirection] = useState('310');
  const [speed, setSpeed] = useState('18');
  const [gust, setGust] = useState('');
  const [limit, setLimit] = useState('21');

  // A runway designator (36, 09L) is tens of degrees; a heading is degrees.
  const runwayHeading = useMemo(() => {
    const digits = runway.replace(/\D/g, '');
    if (digits.length <= 2 && digits !== '') return num(digits) * 10;
    return num(digits);
  }, [runway]);

  const steady = windComponents(runwayHeading, num(direction), num(speed));
  const peak = gust ? windComponents(runwayHeading, num(direction), num(gust)) : null;
  const limitKt = num(limit);
  const worstCross = peak ? Math.max(steady.crosswind, peak.crosswind) : steady.crosswind;
  const overLimit = limitKt > 0 && worstCross > limitKt;

  return (
    <div className="stack">
      <div className="card form-grid">
        <TextField label="Runway" value={runway} onChange={setRunway} inputMode="numeric" hint={`${runwayHeading}°`} />
        <NumberField label="Wind from" value={direction} onChange={setDirection} suffix="°" />
        <NumberField label="Wind speed" value={speed} onChange={setSpeed} suffix="kt" />
        <NumberField label="Gusting to" value={gust} onChange={setGust} suffix="kt" />
        <NumberField label="Your crosswind limit" value={limit} onChange={setLimit} suffix="kt" />
      </div>

      <Result>
        <KeyValue k="Headwind">
          {steady.headwind >= 0
            ? `${steady.headwind.toFixed(1)} kt headwind`
            : `${Math.abs(steady.headwind).toFixed(1)} kt TAILWIND`}
        </KeyValue>
        <KeyValue k="Crosswind">
          {steady.crosswind.toFixed(1)} kt {steady.crosswindFrom !== 'none' ? `from the ${steady.crosswindFrom}` : ''}
        </KeyValue>
        <KeyValue k="Wind angle">{steady.angle.toFixed(0)}° off the nose</KeyValue>
        {peak ? <KeyValue k="Crosswind in gusts">{peak.crosswind.toFixed(1)} kt</KeyValue> : null}
      </Result>

      {steady.headwind < 0 ? <Banner tone="warn">That is a tailwind component on this runway.</Banner> : null}
      {overLimit ? (
        <Banner tone="danger">
          {worstCross.toFixed(1)} kt of crosswind exceeds the {limitKt} kt limit you entered.
        </Banner>
      ) : null}
      <p className="xsmall muted">
        Runway heading and wind direction must both be magnetic, or both true. Reported surface winds are magnetic;
        forecast winds aloft are true.
      </p>
    </div>
  );
}

// -------------------------------------------------------------- atmosphere

function AtmosphereTool() {
  const [elevation, setElevation] = useState('5000');
  const [altimeter, setAltimeter] = useState('29.92');
  const [oat, setOat] = useState('30');
  const [cas, setCas] = useState('160');

  const pa = pressureAltitude(num(elevation), num(altimeter));
  const da = densityAltitude(pa, num(oat));
  const isa = isaTemp(pa);
  const tas = trueAirspeed(num(cas), da);

  return (
    <div className="stack">
      <div className="card form-grid">
        <NumberField label="Field elevation" value={elevation} onChange={setElevation} suffix="ft" />
        <NumberField label="Altimeter" value={altimeter} onChange={setAltimeter} suffix="inHg" step="0.01" />
        <NumberField label="Temperature" value={oat} onChange={setOat} suffix="°C" />
        <NumberField label="Calibrated airspeed" value={cas} onChange={setCas} suffix="kt" />
      </div>

      <Result>
        <KeyValue k="Pressure altitude">{Math.round(pa).toLocaleString()} ft</KeyValue>
        <KeyValue k="ISA temperature">{isa.toFixed(1)} °C</KeyValue>
        <KeyValue k="ISA deviation">{(num(oat) - isa >= 0 ? '+' : '')}{(num(oat) - isa).toFixed(1)} °C</KeyValue>
        <KeyValue k="Density altitude"><strong>{Math.round(da).toLocaleString()} ft</strong></KeyValue>
        <KeyValue k="True airspeed">{Math.round(tas)} kt</KeyValue>
      </Result>

      {da > num(elevation) + 2000 ? (
        <Banner tone="warn">
          Density altitude is {Math.round(da - num(elevation)).toLocaleString()} ft above field elevation. Check your
          performance charts before you plan on book numbers.
        </Banner>
      ) : null}
      <p className="xsmall muted">
        Standard ISA model: 1.98 °C per 1,000 ft lapse rate, 118.8 ft of density altitude per °C of deviation. True
        airspeed uses the ISA density ratio. These are planning figures, not a substitute for the POH.
      </p>
    </div>
  );
}

// -------------------------------------------------------------------- trip

function TripTool() {
  const [distance, setDistance] = useState('450');
  const [tas, setTas] = useState('180');
  const [course, setCourse] = useState('270');
  const [windDir, setWindDir] = useState('300');
  const [windSpeed, setWindSpeed] = useState('25');
  const [burn, setBurn] = useState('17');
  const [reserve, setReserve] = useState('45');
  const [usable, setUsable] = useState('92');
  const [fuelType, setFuelType] = useState('100LL');

  const triangle = windTriangle(num(tas), num(course), num(windDir), num(windSpeed));
  const plan = planTrip({
    distanceNm: num(distance),
    groundSpeedKt: triangle.groundSpeed,
    burnGph: num(burn),
    reserveMinutes: num(reserve),
    usableFuelGal: num(usable),
  });

  return (
    <div className="stack">
      <div className="card form-grid">
        <NumberField label="Distance" value={distance} onChange={setDistance} suffix="nm" />
        <NumberField label="True airspeed" value={tas} onChange={setTas} suffix="kt" />
        <NumberField label="True course" value={course} onChange={setCourse} suffix="°" />
        <NumberField label="Wind from" value={windDir} onChange={setWindDir} suffix="°" />
        <NumberField label="Wind speed" value={windSpeed} onChange={setWindSpeed} suffix="kt" />
        <NumberField label="Fuel burn" value={burn} onChange={setBurn} suffix="gph" />
        <NumberField label="Reserve" value={reserve} onChange={setReserve} suffix="min" />
        <NumberField label="Usable fuel" value={usable} onChange={setUsable} suffix="gal" />
      </div>

      {triangle.unflyable ? (
        <Banner tone="danger">
          The wind is stronger than the aircraft can make good on this course. Check the numbers.
        </Banner>
      ) : (
        <Result>
          <KeyValue k="Heading to fly">{Math.round(triangle.heading)}° ({triangle.windCorrectionAngle >= 0 ? '+' : ''}{triangle.windCorrectionAngle.toFixed(1)}° correction)</KeyValue>
          <KeyValue k="Ground speed">{Math.round(triangle.groundSpeed)} kt</KeyValue>
          <KeyValue k="Time en route"><strong>{formatHoursMinutes(plan.timeHours)}</strong></KeyValue>
          <KeyValue k="Fuel to destination">{plan.fuelBurned.toFixed(1)} gal</KeyValue>
          <KeyValue k="Reserve fuel">{plan.reserveFuel.toFixed(1)} gal</KeyValue>
          <KeyValue k="Total required">{plan.totalFuelRequired.toFixed(1)} gal</KeyValue>
          {plan.remaining !== null ? (
            <KeyValue k="Remaining on landing">
              <span style={{ color: plan.enoughFuel ? 'var(--success)' : 'var(--danger)' }}>
                {plan.remaining.toFixed(1)} gal
              </span>
            </KeyValue>
          ) : null}
          <KeyValue k="Fuel weight">
            {Math.round(gallonsToPounds(plan.totalFuelRequired, fuelType))} lb of {fuelType}
          </KeyValue>
        </Result>
      )}

      <SelectField label="Fuel type" value={fuelType} options={Object.keys(FUEL_WEIGHTS)} onChange={setFuelType} />

      {plan.enoughFuel === false ? (
        <Banner tone="danger">This leg needs more fuel than you have on board. Plan a stop.</Banner>
      ) : null}
      <p className="xsmall muted">
        Fuel weights are standard planning figures ({Object.entries(FUEL_WEIGHTS).map(([k, v]) => `${k} ${v} lb/gal`).join(', ')}).
        Actual density varies with temperature.
      </p>
    </div>
  );
}

// -------------------------------------------------------- weight & balance

const DEFAULT_STATIONS: Station[] = [
  { label: 'Empty weight', weight: 2300, arm: 138 },
  { label: 'Front seats', weight: 340, arm: 143 },
  { label: 'Rear seats', weight: 0, arm: 180 },
  { label: 'Fuel', weight: 552, arm: 153.75 },
  { label: 'Baggage', weight: 50, arm: 208 },
];

function WeightBalanceTool() {
  const [stations, setStations] = useState<Station[]>(DEFAULT_STATIONS);
  const [maxGross, setMaxGross] = useState('3600');
  const [fwd, setFwd] = useState('137.8');
  const [aft, setAft] = useState('148.1');

  const result = weightAndBalance(stations, {
    maxGrossWeight: maxGross ? num(maxGross) : undefined,
    forwardCgLimit: fwd ? num(fwd) : undefined,
    aftCgLimit: aft ? num(aft) : undefined,
  });

  const update = (i: number, patch: Partial<Station>) =>
    setStations(stations.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="stack">
      <Banner tone="info">
        Enter your own aircraft's numbers from its weight and balance sheet. AEROBOOK does not carry aircraft data and
        will not guess it.
      </Banner>

      <div className="stack stack--sm">
        {stations.map((s, i) => (
          <div className="card card--tight" key={i}>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input grow"
                value={s.label}
                onChange={(e) => update(i, { label: e.target.value })}
                aria-label={`Station ${i + 1} name`}
              />
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => setStations(stations.filter((_, idx) => idx !== i))}
                aria-label={`Remove ${s.label}`}
              >
                <IconTrash />
              </button>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <NumberField label="Weight" suffix="lb" value={String(s.weight)} onChange={(v) => update(i, { weight: num(v) })} />
              <NumberField label="Arm" suffix="in" value={String(s.arm)} onChange={(v) => update(i, { arm: num(v) })} step="0.01" />
            </div>
          </div>
        ))}
        <button
          className="btn btn--ghost btn--block"
          onClick={() => setStations([...stations, { label: 'New station', weight: 0, arm: 0 }])}
        >
          <IconPlus /> Add a station
        </button>
      </div>

      <div className="card form-grid">
        <NumberField label="Max gross" value={maxGross} onChange={setMaxGross} suffix="lb" />
        <NumberField label="Forward CG limit" value={fwd} onChange={setFwd} suffix="in" step="0.01" />
        <NumberField label="Aft CG limit" value={aft} onChange={setAft} suffix="in" step="0.01" />
      </div>

      <Result>
        <KeyValue k="Total weight"><strong>{result.totalWeight.toFixed(0)} lb</strong></KeyValue>
        <KeyValue k="Total moment">{result.totalMoment.toFixed(0)} lb·in</KeyValue>
        <KeyValue k="Centre of gravity">{result.cg === null ? '—' : `${result.cg.toFixed(2)} in`}</KeyValue>
        <KeyValue k="Weight">
          {result.overGross === null ? <span className="muted">No limit set</span>
            : result.overGross ? <span style={{ color: 'var(--danger)' }}>Over gross by {(result.totalWeight - num(maxGross)).toFixed(0)} lb</span>
            : <span style={{ color: 'var(--success)' }}>Within gross</span>}
        </KeyValue>
        <KeyValue k="CG">
          {result.withinCgLimits === null ? <span className="muted">No limits set</span>
            : result.withinCgLimits ? <span style={{ color: 'var(--success)' }}>Within limits</span>
            : <span style={{ color: 'var(--danger)' }}>Outside the envelope</span>}
        </KeyValue>
      </Result>

      <p className="xsmall muted">
        This computes the arithmetic. It does not know your aircraft's envelope shape — a CG that is legal at one weight
        may not be at another. Always confirm against the aircraft's own chart.
      </p>
    </div>
  );
}

// ------------------------------------------------------------- conversions

const UNIT_GROUPS = [
  { label: 'Distance', units: ['nm', 'sm', 'km'] },
  { label: 'Speed', units: ['kt', 'mph', 'kph'] },
  { label: 'Volume', units: ['gal', 'l'] },
  { label: 'Weight', units: ['lb', 'kg'] },
  { label: 'Altitude', units: ['ft', 'm'] },
];

function ConvertTool() {
  const [group, setGroup] = useState(0);
  const [value, setValue] = useState('100');
  const [from, setFrom] = useState('nm');
  const [to, setTo] = useState('sm');
  const [celsius, setCelsius] = useState('15');
  const [inHg, setInHg] = useState('29.92');

  const units = UNIT_GROUPS[group].units;
  const converted = convert(num(value), from, to);

  return (
    <div className="stack">
      <div className="filter-bar">
        {UNIT_GROUPS.map((g, i) => (
          <button
            key={g.label}
            className={`filter-chip${group === i ? ' is-active' : ''}`}
            onClick={() => { setGroup(i); setFrom(UNIT_GROUPS[i].units[0]); setTo(UNIT_GROUPS[i].units[1]); }}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="card stack stack--sm">
        <NumberField label="Value" value={value} onChange={setValue} />
        <div className="form-grid">
          <SelectField label="From" value={from} options={units} onChange={setFrom} />
          <SelectField label="To" value={to} options={units} onChange={setTo} />
        </div>
        <div className="metric">
          <span className="metric__value">{converted === null ? '—' : converted.toFixed(2)}</span>
          <span className="metric__label">{to}</span>
        </div>
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Temperature</div>
        <NumberField label="Celsius" value={celsius} onChange={setCelsius} />
        <KeyValue k="Fahrenheit">{celsiusToFahrenheit(num(celsius)).toFixed(1)} °F</KeyValue>
        <KeyValue k="From Fahrenheit">{fahrenheitToCelsius(num(celsius)).toFixed(1)} °C</KeyValue>
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Altimeter setting</div>
        <NumberField label="inHg" value={inHg} onChange={setInHg} step="0.01" />
        <KeyValue k="Hectopascals">{inHgToHpa(num(inHg)).toFixed(1)} hPa</KeyValue>
        <KeyValue k="If that were hPa">{hpaToInHg(num(inHg)).toFixed(2)} inHg</KeyValue>
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Fuel weight</div>
        {Object.entries(FUEL_WEIGHTS).map(([type, weight]) => (
          <KeyValue key={type} k={type}>
            {num(value).toFixed(0)} gal = {(num(value) * weight).toFixed(0)} lb ({weight} lb/gal)
          </KeyValue>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- insurance

function InsuranceTool() {
  const [hullValue, setHullValue] = useState('850000');
  const [rate, setRate] = useState('1.2');
  const [premium, setPremium] = useState('');
  const [liability, setLiability] = useState('2500');

  const [premiumA, setPremiumA] = useState('10200');
  const [deductibleA, setDeductibleA] = useState('2500');
  const [premiumB, setPremiumB] = useState('9200');
  const [deductibleB, setDeductibleB] = useState('10000');

  const hullFromRate = hullPremium(num(hullValue), num(rate));
  const rateFromPremium = premium ? impliedRate(num(hullValue), num(premium)) : null;
  const total = hullFromRate + num(liability);
  const comparison = compareDeductibles({
    premiumA: num(premiumA), deductibleA: num(deductibleA),
    premiumB: num(premiumB), deductibleB: num(deductibleB),
  });

  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  return (
    <div className="stack">
      <div className="card stack stack--sm">
        <div className="section-title">Hull premium</div>
        <div className="form-grid">
          <NumberField label="Declared hull value" value={hullValue} onChange={setHullValue} suffix="$" />
          <NumberField label="Hull rate" value={rate} onChange={setRate} suffix="%" step="0.01" />
          <NumberField label="Liability premium" value={liability} onChange={setLiability} suffix="$" />
        </div>
        <KeyValue k="Hull premium">{money(hullFromRate)}</KeyValue>
        <KeyValue k="Total annual premium"><strong>{money(total)}</strong></KeyValue>
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Working backwards</div>
        <NumberField label="Quoted hull premium" value={premium} onChange={setPremium} suffix="$" />
        <KeyValue k="Implied rate">
          {rateFromPremium === null ? <span className="muted">Enter a premium</span> : `${rateFromPremium.toFixed(3)} %`}
        </KeyValue>
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Deductible trade-off</div>
        <div className="form-grid">
          <NumberField label="Option A premium" value={premiumA} onChange={setPremiumA} suffix="$" />
          <NumberField label="Option A deductible" value={deductibleA} onChange={setDeductibleA} suffix="$" />
          <NumberField label="Option B premium" value={premiumB} onChange={setPremiumB} suffix="$" />
          <NumberField label="Option B deductible" value={deductibleB} onChange={setDeductibleB} suffix="$" />
        </div>
        <KeyValue k="Annual saving with B">{money(comparison.annualSaving)}</KeyValue>
        <KeyValue k="Extra exposure per claim">{money(comparison.extraExposure)}</KeyValue>
        <KeyValue k="Break-even">
          {comparison.breakEvenYears === null
            ? <span className="muted">Option B costs more, so there is nothing to make back</span>
            : <strong>{comparison.breakEvenYears.toFixed(1)} claim-free years</strong>}
        </KeyValue>
      </div>

      <p className="xsmall muted">
        Arithmetic only. Rates, eligibility and terms come from the carrier — this is for talking a client through the
        shape of a decision, not for quoting.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- lookups

function LookupTool() {
  const db = useDatabase();
  const [tail, setTail] = useState('');
  const [airport, setAirport] = useState('');

  const faa = faaRegistryLink(tail);
  const airports = airportLinks(airport);
  const known = normalizeTail(tail)
    ? db.aircraft.find((a) => a.tailKey === normalizeTail(tail))
    : undefined;

  return (
    <div className="stack">
      <div className="card stack stack--sm">
        <div className="section-title">Aircraft registration</div>
        <TextField label="Tail number" value={tail} onChange={setTail} placeholder="N917JH" />
        {known ? (
          <Link className="tile" to={`/aircraft/${known.id}`}>
            <div className="row row--between">
              <span className="tail strong">{known.tailNumber}</span>
              <Chip tone="accent">In your book</Chip>
            </div>
            <div className="small muted">{[known.year, known.make, known.model].filter(Boolean).join(' ')}</div>
          </Link>
        ) : null}
        {faa ? (
          <a className="btn btn--block" href={faa.url} target="_blank" rel="noopener noreferrer">
            <IconExternal /> Look up on the FAA registry
          </a>
        ) : (
          <p className="small muted">Enter a US N-number to search the FAA registry.</p>
        )}
      </div>

      <div className="card stack stack--sm">
        <div className="section-title">Airport</div>
        <TextField label="Identifier" value={airport} onChange={setAirport} placeholder="KSBA" />
        {airports.length === 0 ? (
          <p className="small muted">Enter an airport identifier for charts, fuel, FBOs and official weather.</p>
        ) : (
          <div className="list list--flush">
            {airports.map((l) => (
              <a className="link-row" key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
                <div className="grow">
                  <div className="small">{l.label}</div>
                  <div className="xsmall muted">{l.note}</div>
                </div>
                <IconExternal className="muted" style={{ width: 16, height: 16 }} />
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="card small muted row">
        <IconShield style={{ width: 16, height: 16, flex: 'none' }} />
        <span>
          These open the authoritative source in a new tab. AEROBOOK does not copy aviation data into itself, so what
          you see there is what is current.
        </span>
      </div>

      <div className="card small muted row">
        <IconPlane style={{ width: 16, height: 16, flex: 'none' }} />
        <span>Weather and chart links are for planning awareness. Get your official briefing before you fly.</span>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';

/**
 * The AEROBOOK brand: the wordmark.
 *
 * AEROBOOK shares its house style — palette and Montserrat — with OPTISKY,
 * but is its own product, so it carries no emblem or tagline of OPTISKY's.
 * `Wordmark` is the widely spaced name, inline (app bar, Settings) or large
 * and centred (splash, sign-in).
 */
export function Wordmark({ large = false }: { large?: boolean }) {
  return <span className={`wordmark ${large ? 'wordmark--large' : ''}`.trim()}>AEROBOOK</span>;
}

/**
 * The launch screen: the wordmark alone, centred on the whole screen. It
 * covers everything, tab bar included, so the checking-your-session step
 * and the loading-your-data step read as one steady screen rather than two
 * layouts that jump.
 */
export function Splash({ leaving = false }: { leaving?: boolean }) {
  return (
    <div className={`splash ${leaving ? 'splash--leaving' : ''}`.trim()} role="status" aria-label="Loading AEROBOOK">
      <Wordmark large />
    </div>
  );
}

/** How long the launch screen holds, at least, before it fades. */
const INTRO_HOLD_MS = 3000;
/** Matches the `.splash--leaving` transition. */
const INTRO_FADE_MS = 400;

/**
 * The launch screen, held for a beat on every cold start so the app opens
 * with its name rather than a flash of it. It sits over the app, which
 * signs in and loads underneath the whole time — the hold never adds to a
 * slow load, since the screen beneath is the same splash until the data is
 * ready — then fades away once.
 */
export function IntroSplash() {
  const [phase, setPhase] = useState<'hold' | 'leaving' | 'gone'>('hold');

  useEffect(() => {
    const leave = setTimeout(() => setPhase('leaving'), INTRO_HOLD_MS);
    const gone = setTimeout(() => setPhase('gone'), INTRO_HOLD_MS + INTRO_FADE_MS);
    return () => { clearTimeout(leave); clearTimeout(gone); };
  }, []);

  return phase === 'gone' ? null : <Splash leaving={phase === 'leaving'} />;
}

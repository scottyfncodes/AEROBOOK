/**
 * The AEROBOOK brand: the wordmark and the owner's signature.
 *
 * AEROBOOK shares its house style — palette and Montserrat — with OPTISKY,
 * but is its own product, so it carries no emblem or tagline of OPTISKY's.
 * `Wordmark` is the widely spaced name, inline (app bar, Settings) or large
 * and centred (splash, sign-in). `Signature` is the owner's full hand, used
 * only where there is room for it to actually read as a signature: the
 * quiet sign-off at the foot of the dashboard. It is decorative — screen
 * readers skip it and read the wordmark beside it instead.
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
export function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading AEROBOOK">
      <Wordmark large />
    </div>
  );
}

function Signature({ width, className = '' }: { width?: number; className?: string }) {
  return (
    <span
      className={`signature ${className}`.trim()}
      aria-hidden="true"
      style={width ? ({ '--signature-width': `${width}px` } as React.CSSProperties) : undefined}
    />
  );
}

/** The quiet sign-off at the foot of the dashboard. */
export function Colophon() {
  return (
    <div className="colophon">
      <Signature />
      <span className="colophon__line">Aerobook</span>
    </div>
  );
}

/**
 * The AEROBOOK mark.
 *
 * Takes its asymmetry from the owner's own signature: a capital "A" whose
 * left downstroke sweeps hard past the baseline into a small hook, while the
 * right stroke is short and steep. Drawn the rest of the way into a
 * paper-airplane silhouette — the long stroke is a swept wing with its
 * wingtip hook, the short stroke is a tail, and the crossbar is the wing's
 * leading edge, landing on both legs rather than spanning past them.
 *
 * Inline SVG so it inherits the surrounding text colour. Decorative — screen
 * readers skip it and read the wordmark beside it instead.
 */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size * (70.2 / 57.6)}
      viewBox="15 13.4 57.6 70.2"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M56 16 L18 76 Q16.5 80 21 81" strokeWidth="5.6" />
      <path d="M56 16 L70 52" strokeWidth="5.6" />
      <path d="M32.5 63.5 L52 51 L67 59" strokeWidth="3.8" />
    </svg>
  );
}

/** The quiet sign-off at the foot of the dashboard. */
export function Colophon() {
  return (
    <div className="colophon">
      <Mark size={26} />
      <span className="colophon__line">Aerobook</span>
    </div>
  );
}

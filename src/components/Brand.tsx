/**
 * The AEROBOOK mark: an "A" whose crossbar runs past both legs. Drawn inline
 * so it inherits the surrounding text colour. Decorative — screen readers
 * skip it and read the wordmark beside it instead.
 */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size * (68 / 80)}
      viewBox="10 17 80 68"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M26 80 L58 22 L72 80" strokeWidth="5" />
      <path d="M15 62 H85" strokeWidth="3.4" />
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

/**
 * The owner's signature, drawn as a CSS mask so it inherits the surrounding
 * text colour. Purely decorative — screen readers skip it.
 */
export function Signature({ width, className = '' }: { width?: number; className?: string }) {
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

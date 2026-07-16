/**
 * The Seltra mark: two routes converging into one filled order, flowing left.
 * Vector recreation of the brand PNGs (images/seltra-mark-size-sheet-*).
 * Draws in currentColor so it follows the surrounding theme.
 */
export function SeltraMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M2 19 H18 C25 19 25 7 32 7 H46" stroke="currentColor" strokeWidth="5" />
      <path d="M2 29 H18 C25 29 25 41 32 41 H46" stroke="currentColor" strokeWidth="5" />
      <path d="M33 24 H46" stroke="currentColor" strokeWidth="5" />
      <path d="M21 24 L33 18 V30 Z" fill="currentColor" />
    </svg>
  );
}

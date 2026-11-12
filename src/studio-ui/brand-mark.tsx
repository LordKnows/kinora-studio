import { BRAND_COLORS, MARK } from "@/brand";

/** The Stave mark (src/brand.ts): bare, in the text colour, on the interface; on its ink plate for icons. */
export function BrandMark({ size = 20, plate = false, className }: { size?: number; plate?: boolean; className?: string }) {
  return (
    <svg className={className} viewBox={MARK.viewBox} width={size} height={size} aria-hidden="true" focusable="false">
      {plate && <rect width="32" height="32" rx={MARK.plateRadius} fill={BRAND_COLORS.ink} />}
      <g shapeRendering="crispEdges" fill="none" strokeWidth={MARK.stroke}>
        <path d={MARK.staves} stroke={plate ? BRAND_COLORS.card : "currentColor"} />
        <path d={MARK.here} stroke={`var(--accent, ${BRAND_COLORS.tally})`} />
      </g>
    </svg>
  );
}

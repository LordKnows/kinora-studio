import { BRAND, BRAND_COLORS, MARK } from "@/brand";

/** The Kinora mark (src/brand.ts): three cards making a K, the red one at the stop. `ink`: on its ink plate, for light grounds; `night`: on the plate raised one step above a dark ground, with its edge. */
export function BrandMark({ size = 22, ground = "ink", className }: { size?: number; ground?: "ink" | "night"; className?: string }) {
  const night = ground === "night";
  return (
    <svg className={className} viewBox={MARK.viewBox} width={size} height={size} aria-hidden="true" focusable="false">
      {night ? (
        <rect x="1" y="1" width="62" height="62" rx={MARK.plateRadius} fill={BRAND_COLORS.nightPlate} stroke={BRAND_COLORS.nightEdge} strokeWidth="2" />
      ) : (
        <rect width="64" height="64" rx={MARK.plateRadius} fill={BRAND_COLORS.ink} />
      )}
      {MARK.cards.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} rx={MARK.cardRadius} fill={c.red ? `var(--accent, ${BRAND_COLORS.tally})` : night ? BRAND_COLORS.night : BRAND_COLORS.card} transform={c.rotate ? `rotate(${c.rotate})` : undefined} />
      ))}
    </svg>
  );
}

/** The wordmark: "kinora" with the i's dot as the red card, then "Studio". Visual only: the link around it carries the name. */
export function BrandWord({ className }: { className?: string }) {
  const [before, after] = [BRAND.word.slice(0, BRAND.word.indexOf("i")), BRAND.word.slice(BRAND.word.indexOf("i") + 1)];
  return (
    <span className={className} aria-hidden="true">
      <span className="st-brand-word">
        {before}
        <span className="st-brand-i">ı</span>
        {after}
      </span>
      <span className="st-brand-suffix">{BRAND.suffix}</span>
    </span>
  );
}

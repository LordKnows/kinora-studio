import { BRAND, BRAND_COLORS, MARK } from "@/brand";

/** The Kinora mark (src/brand.ts): three cards making a K, the red one at the stop. On its ink plate by default; `bare` is the cards alone, in the text colour, for dark grounds. */
export function BrandMark({ size = 22, bare = false, className }: { size?: number; bare?: boolean; className?: string }) {
  const [, , w, h] = MARK.bareViewBox.split(" ").map(Number);
  return (
    <svg className={className} viewBox={bare ? MARK.bareViewBox : MARK.viewBox} width={bare ? (size * w!) / h! : size} height={size} aria-hidden="true" focusable="false">
      {!bare && <rect width="64" height="64" rx={MARK.plateRadius} fill={BRAND_COLORS.ink} />}
      {MARK.cards.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} rx={MARK.cardRadius} fill={c.red ? `var(--accent, ${BRAND_COLORS.tally})` : bare ? "currentColor" : BRAND_COLORS.card} transform={c.rotate ? `rotate(${c.rotate})` : undefined} />
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

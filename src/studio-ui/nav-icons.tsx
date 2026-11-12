/* The project bar's icons (docs/brand.md): a 24-unit grid, a 1.75 stroke,
   round caps and joins, built from rounded cards like the K. Each icon has one
   accent, its "now" card: drawn in ink like the rest, filled red when its page
   is the current one (or, for the Director, while takes are rolling), the
   same red as the mark's card. Every icon is drawn in five layers, back to
   front: strokes, shapes filled with the ground (so the card in front hides
   the one behind), solid dots, the accent, and a pin over the accent. The
   colours come from studio.css (.ni), so they follow the light and dark grounds. */

type Layers = { stroke?: string; ground?: string; dots?: string; accent: string; pin?: string };

export type NavIconName = "reel" | "story" | "design" | "board" | "cut" | "screen" | "director" | "settings";

const ICONS: Record<NavIconName, Layers> = {
  /* a film reel, the film running off it; its last card is the frame at the lens */
  reel: {
    stroke: "M2.75 11A7.25 7.25 0 1 0 17.25 11A7.25 7.25 0 1 0 2.75 11ZM10 18.25H17.25",
    dots: "M8.85 11A1.15 1.15 0 1 0 11.15 11A1.15 1.15 0 1 0 8.85 11ZM8.75 6.8A1.25 1.25 0 1 0 11.25 6.8A1.25 1.25 0 1 0 8.75 6.8ZM12.74 9.7A1.25 1.25 0 1 0 15.24 9.7A1.25 1.25 0 1 0 12.74 9.7ZM11.22 14.4A1.25 1.25 0 1 0 13.72 14.4A1.25 1.25 0 1 0 11.22 14.4ZM6.28 14.4A1.25 1.25 0 1 0 8.78 14.4A1.25 1.25 0 1 0 6.28 14.4ZM4.76 9.7A1.25 1.25 0 1 0 7.26 9.7A1.25 1.25 0 1 0 4.76 9.7Z",
    accent: "M18.45 15.6L20.3 15.6A1.2 1.2 0 0 1 21.5 16.8L21.5 19.7A1.2 1.2 0 0 1 20.3 20.9L18.45 20.9A1.2 1.2 0 0 1 17.25 19.7L17.25 16.8A1.2 1.2 0 0 1 18.45 15.6Z",
  },
  /* a page of script; the bar is the lined script's tramline */
  story: {
    stroke: "M6.5 2.75L17.5 2.75A2 2 0 0 1 19.5 4.75L19.5 19.25A2 2 0 0 1 17.5 21.25L6.5 21.25A2 2 0 0 1 4.5 19.25L4.5 4.75A2 2 0 0 1 6.5 2.75ZM11 8H16M11 12H16M11 16H14",
    accent: "M8.2 6.9L8.2 6.9A0.8 0.8 0 0 1 9 7.7L9 13.5A0.8 0.8 0 0 1 8.2 14.3L8.2 14.3A0.8 0.8 0 0 1 7.4 13.5L7.4 7.7A0.8 0.8 0 0 1 8.2 6.9Z",
  },
  /* a fan of colour swatches */
  design: {
    ground: "M18.85 7.59L20.13 9.12A1.5 1.5 0 0 1 19.95 11.24L9.61 19.92A1.5 1.5 0 0 1 7.49 19.73L6.21 18.2A1.5 1.5 0 0 1 6.39 16.08L16.73 7.41A1.5 1.5 0 0 1 18.85 7.59ZM13.43 3.98L15.25 4.83A1.5 1.5 0 0 1 15.97 6.82L10.27 19.06A1.5 1.5 0 0 1 8.27 19.78L6.46 18.94A1.5 1.5 0 0 1 5.73 16.94L11.44 4.71A1.5 1.5 0 0 1 13.43 3.98Z",
    accent: "M7 3L9 3A1.5 1.5 0 0 1 10.5 4.5L10.5 18A1.5 1.5 0 0 1 9 19.5L7 19.5A1.5 1.5 0 0 1 5.5 18L5.5 4.5A1.5 1.5 0 0 1 7 3Z",
    pin: "M7.1 16.5A0.9 0.9 0 1 0 8.9 16.5A0.9 0.9 0 1 0 7.1 16.5Z",
  },
  /* four panels; the first is the shot under the playhead */
  board: {
    stroke: "M14.5 4.5L19.5 4.5A1.5 1.5 0 0 1 21 6L21 9.5A1.5 1.5 0 0 1 19.5 11L14.5 11A1.5 1.5 0 0 1 13 9.5L13 6A1.5 1.5 0 0 1 14.5 4.5ZM4.5 13L9.5 13A1.5 1.5 0 0 1 11 14.5L11 18A1.5 1.5 0 0 1 9.5 19.5L4.5 19.5A1.5 1.5 0 0 1 3 18L3 14.5A1.5 1.5 0 0 1 4.5 13ZM14.5 13L19.5 13A1.5 1.5 0 0 1 21 14.5L21 18A1.5 1.5 0 0 1 19.5 19.5L14.5 19.5A1.5 1.5 0 0 1 13 18L13 14.5A1.5 1.5 0 0 1 14.5 13Z",
    accent: "M4.5 4.5L9.5 4.5A1.5 1.5 0 0 1 11 6L11 9.5A1.5 1.5 0 0 1 9.5 11L4.5 11A1.5 1.5 0 0 1 3 9.5L3 6A1.5 1.5 0 0 1 4.5 4.5Z",
  },
  /* two clips and the cut between them */
  cut: {
    stroke: "M4 7.5L8.5 7.5A1.5 1.5 0 0 1 10 9L10 15A1.5 1.5 0 0 1 8.5 16.5L4 16.5A1.5 1.5 0 0 1 2.5 15L2.5 9A1.5 1.5 0 0 1 4 7.5ZM15.5 7.5L20 7.5A1.5 1.5 0 0 1 21.5 9L21.5 15A1.5 1.5 0 0 1 20 16.5L15.5 16.5A1.5 1.5 0 0 1 14 15L14 9A1.5 1.5 0 0 1 15.5 7.5Z",
    accent: "M12 3.5L12 3.5A0.8 0.8 0 0 1 12.8 4.3L12.8 19.7A0.8 0.8 0 0 1 12 20.5L12 20.5A0.8 0.8 0 0 1 11.2 19.7L11.2 4.3A0.8 0.8 0 0 1 12 3.5Z",
  },
  /* a screen and its play button */
  screen: {
    stroke: "M4.5 3.75L19.5 3.75A2 2 0 0 1 21.5 5.75L21.5 14.25A2 2 0 0 1 19.5 16.25L4.5 16.25A2 2 0 0 1 2.5 14.25L2.5 5.75A2 2 0 0 1 4.5 3.75ZM12 16.25V20.25M8.5 20.25H15.5",
    accent: "M10.4 7.6L14.9 10L10.4 12.4Z",
  },
  /* the director's chair; its back is the accent */
  director: {
    stroke: "M7.5 8.5V12.75M16.5 8.5V12.75M4.75 12.75H19.25M7.5 12.75L16.5 21M16.5 12.75L7.5 21",
    accent: "M7 3L17 3A1.5 1.5 0 0 1 18.5 4.5L18.5 7A1.5 1.5 0 0 1 17 8.5L7 8.5A1.5 1.5 0 0 1 5.5 7L5.5 4.5A1.5 1.5 0 0 1 7 3Z",
  },
  /* three faders */
  settings: {
    stroke: "M3.5 6.5H20.5M3.5 12H20.5M3.5 17.5H20.5",
    ground: "M7.2 9.75L8.3 9.75A1.2 1.2 0 0 1 9.5 10.95L9.5 13.05A1.2 1.2 0 0 1 8.3 14.25L7.2 14.25A1.2 1.2 0 0 1 6 13.05L6 10.95A1.2 1.2 0 0 1 7.2 9.75ZM15.2 15.25L16.3 15.25A1.2 1.2 0 0 1 17.5 16.45L17.5 18.55A1.2 1.2 0 0 1 16.3 19.75L15.2 19.75A1.2 1.2 0 0 1 14 18.55L14 16.45A1.2 1.2 0 0 1 15.2 15.25Z",
    accent: "M13.2 4.25L14.3 4.25A1.2 1.2 0 0 1 15.5 5.45L15.5 7.55A1.2 1.2 0 0 1 14.3 8.75L13.2 8.75A1.2 1.2 0 0 1 12 7.55L12 5.45A1.2 1.2 0 0 1 13.2 4.25Z",
  },
};

export const NAV_ICON_NAMES = Object.keys(ICONS) as NavIconName[];

/** One of the project bar's icons; `on` fills its accent red. */
export function NavIcon({ name, on = false, size = 20 }: { name: NavIconName; on?: boolean; size?: number }) {
  const l = ICONS[name];
  return (
    <svg className={on ? "ni ni--on" : "ni"} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {l.stroke && <path className="ni-s" d={l.stroke} />}
      {l.ground && <path className="ni-g" d={l.ground} />}
      {l.dots && <path className="ni-d" d={l.dots} />}
      <path className="ni-a" d={l.accent} />
      {l.pin && <path className="ni-p" d={l.pin} />}
    </svg>
  );
}

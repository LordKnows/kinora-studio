import localFont from "next/font/local";

/* Archivo for the UI (one variable file: weight 100–900, width 62–125 % —
   wide for the film's name, condensed for slate numbers), IBM Plex Mono for
   everything measured. Both are SIL OFL and self-hosted from ./fonts, so the
   build never has to reach Google Fonts (the Workers Builds environment
   cannot). Script text uses the system Songti (--font-song in studio.css):
   a CJK webfont is megabytes. The variables the studio tokens use. */
const archivo = localFont({
  src: "./fonts/archivo-latin-wdth-normal.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-archivo",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-plex-mono",
});

export const fontClass = `${archivo.variable} ${plexMono.variable}`;

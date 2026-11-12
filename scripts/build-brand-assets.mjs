/* Builds every brand asset from the one mark in src/brand.ts.

   The favicon (src/app/icon.svg) is written as SVG; Apple, the web app
   manifest and Open Graph need rasters, so this script draws the same 32-unit
   field in a headless Chromium and screenshots it at each size.

     node scripts/build-brand-assets.mjs

   Node 22.18 or later reads src/brand.ts as TypeScript. Chromium: CHROME_BIN,
   else Playwright's or a system Chrome. The Open Graph card loads its fonts
   from Google Fonts. Outputs are committed: this runs when the mark changes,
   not on every build. docs/brand.md describes the mark. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BRAND, BRAND_COLORS, MARK, markSvg } from "../src/brand.ts";

const { ink: INK, card: CARD, tally: TALLY } = BRAND_COLORS;

/* ---------- the mark ---------- */

/** The mark on a full-bleed square, scaled inside it: Apple and the maskable spec cut their own shape. */
const bleed = (size, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="${size}" height="${size}">
  <rect width="32" height="32" fill="${INK}"/>
  <g transform="translate(16 16) scale(${scale}) translate(-16 -16)" shape-rendering="crispEdges">
    <path d="${MARK.staves}" stroke="${CARD}" stroke-width="${MARK.stroke}" fill="none"/>
    <path d="${MARK.here}" stroke="${TALLY}" stroke-width="${MARK.stroke}" fill="none"/>
  </g>
</svg>`;

/* ---------- renderer ---------- */

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/opt/pw-browsers/chromium",
    ...["1243", "1237", "1228"].flatMap((build) => [
      join(homedir(), "Library/Caches/ms-playwright", `chromium-${build}/chrome-mac-arm64`, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
      join(homedir(), ".cache/ms-playwright", `chromium-${build}/chrome-linux64/chrome`),
    ]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  throw new Error("No Chrome found. Install one, or set CHROME_BIN to a Chrome/Chromium binary.");
}

const CHROME = findChrome();
const ROOT = resolve(import.meta.dirname, "..");
const WORK = mkdtempSync(join(tmpdir(), "stave-brand-"));

function shoot(out, html, width, height, { transparent = false } = {}) {
  const page = join(WORK, `${width}x${height}-${Math.abs(hash(out))}.html`);
  writeFileSync(page, html);
  mkdirSync(resolve(out, ".."), { recursive: true });
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      /* Chromium refuses to run as root with its sandbox on (containers, CI) */
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=8000",
      ...(transparent ? ["--default-background-color=00000000"] : []),
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  console.log(`  ${out.replace(`${ROOT}/`, "")}  ${width}×${height}`);
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  return h;
}

const shell = (body, bg = "transparent") =>
  `<!doctype html><meta charset="utf-8"><style>
   *{margin:0;padding:0;box-sizing:border-box}
   html,body{width:100%;height:100%;background:${bg};overflow:hidden}
   body{display:flex}
   </style>${body}`;

/* ---------- favicon ---------- */

console.log("favicon");
writeFileSync(join(ROOT, "src/app/icon.svg"), `${markSvg({ size: 32, plate: true })}\n`);
console.log("  src/app/icon.svg");

/* ---------- app icons ---------- */

console.log("app icons");
shoot(join(ROOT, "public/icon-512.png"), shell(markSvg({ size: 512 })), 512, 512, { transparent: true });
shoot(join(ROOT, "public/icon-192.png"), shell(markSvg({ size: 192 })), 192, 192, { transparent: true });
// Maskable keeps the mark inside the 80%-diameter safe circle.
shoot(join(ROOT, "public/icon-maskable-512.png"), shell(bleed(512, 0.78)), 512, 512);
shoot(join(ROOT, "src/app/apple-icon.png"), shell(bleed(180, 0.9)), 180, 180);

/* ---------- open graph card ----------
   The card is a page of the score: the name and what it is, above four
   staves of shots crossed by the red line that marks now. No stand-in
   pictures of work we do not have. */

const staves = [
  { label: "SCRIPT", cuts: [0, 0.16, 0.41, 0.58, 0.83, 1] },
  { label: "BOARD", cuts: [0, 0.09, 0.27, 0.36, 0.52, 0.71, 0.79, 1] },
  { label: "TAKES", cuts: [0, 0.14, 0.33, 0.47, 0.62, 0.9, 1] },
  { label: "CUT", cuts: [0, 0.22, 0.31, 0.55, 0.68, 1] },
];
const HERE = 0.62;
const staveRows = staves
  .map(
    (s) => `<div class="stave"><span class="lab">${s.label}</span><div class="line">${s.cuts
      .slice(0, -1)
      .map((a, i) => `<i style="left:calc(${a * 100}% + 3px);width:calc(${(s.cuts[i + 1] - a) * 100}% - 6px)"></i>`)
      .join("")}</div></div>`,
  )
  .join("");

const og = `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@400;500&family=Noto+Serif+SC:wght@600;700&display=block" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{background:${CARD};color:${INK};font-family:Archivo,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:64px 72px 56px;display:flex;flex-direction:column}
  .head{display:flex;align-items:center;gap:28px}
  .name{font-size:112px;font-weight:800;font-stretch:125%;letter-spacing:.06em;line-height:1;text-transform:uppercase}
  .zh{font-family:"Noto Serif SC",serif;font-size:92px;font-weight:700;line-height:1;color:#4a4a47;margin-left:6px}
  .what{margin-top:26px;font-family:"IBM Plex Mono",monospace;font-size:17px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:#5b5b58}
  .what b{color:${INK};font-weight:500}
  .tag{margin-top:14px;font-size:26px;line-height:1.35;letter-spacing:-.005em;color:#2b2b29;max-width:900px}
  .score{position:relative;margin-top:auto;border-top:1px solid ${INK}}
  .stave{display:flex;align-items:center;height:30px;border-bottom:1px solid rgba(18,18,18,.18)}
  .lab{width:92px;flex:none;font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.16em;color:#6b6b68}
  .line{position:relative;flex:1;height:100%}
  .line i{position:absolute;top:13px;height:4px;background:${INK}}
  .here{position:absolute;top:-14px;bottom:-6px;left:calc(92px + (100% - 92px) * ${HERE});width:3px;background:${TALLY}}
  .tc{position:absolute;top:-36px;left:calc(92px + (100% - 92px) * ${HERE} + 10px);font-family:"IBM Plex Mono",monospace;font-size:14px;font-weight:500;color:${TALLY}}
</style>
<div class="head">${markSvg({ size: 96 })}<span class="name">${BRAND.name}</span><span class="zh">${BRAND.zh}</span></div>
<div class="what"><b>${BRAND.descriptor}</b> · ${BRAND.descriptorZh}</div>
<div class="tag">${BRAND.tagline}</div>
<div class="score">${staveRows}<span class="here"></span><span class="tc">0:31.5</span></div>`;

console.log("open graph");
// public/, not app/opengraph-image.png — see the OG_IMAGE note in src/site.ts.
shoot(join(ROOT, "public/og.png"), og, 1200, 630);

rmSync(WORK, { recursive: true, force: true });

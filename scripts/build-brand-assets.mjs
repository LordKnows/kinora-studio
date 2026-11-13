/* Builds every brand asset from the one mark in src/brand.ts.

   The favicon (src/app/icon.svg) is written as SVG; favicon.ico, Apple, the
   web app manifest and Open Graph need rasters, so this script draws the same
   64-unit field in a headless Chromium and screenshots it at each size.

     node scripts/build-brand-assets.mjs

   Node 22.18 or later reads src/brand.ts as TypeScript. Chromium: CHROME_BIN,
   else Playwright's or a system Chrome. The Open Graph card loads its fonts
   from Google Fonts. Outputs are committed: this runs when the mark changes,
   not on every build. docs/brand.md describes the mark. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BRAND, BRAND_COLORS, FAVICON_SIZES, MARK, faviconSvg, markSvg } from "../src/brand.ts";

const { ink: INK, card: CARD, tally: TALLY } = BRAND_COLORS;

/* ---------- the mark ---------- */

const cards = (fg) =>
  MARK.cards
    .map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${MARK.cardRadius}" fill="${c.red ? TALLY : fg}"${c.rotate ? ` transform="rotate(${c.rotate})"` : ""}/>`)
    .join("");

/** The mark on a full-bleed ink square, scaled inside it: Apple and the maskable spec cut their own shape. */
const bleed = (size, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="${size}" height="${size}">
  <rect width="64" height="64" fill="${INK}"/>
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${cards(CARD)}</g>
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
const WORK = mkdtempSync(join(tmpdir(), "kinora-brand-"));

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
writeFileSync(join(ROOT, "src/app/icon.svg"), `${faviconSvg()}\n`);
console.log("  src/app/icon.svg");

/* favicon.ico, for whoever asks the origin for it and reads no <link>: an MCP
   client's list of connectors, a feed reader, a favicon service. PNG frames
   in an ICO directory. It is the ink plate at every size: an .ico cannot
   follow the colour scheme, which is why browsers are still given the SVG. */
function ico(out, sizes) {
  const frames = sizes.map((size) => {
    const png = join(WORK, `favicon-${size}.png`);
    shoot(png, shell(markSvg({ size })), size, size, { transparent: true });
    return { size, data: readFileSync(png) };
  });
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(1, 2); // an icon
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size, at);
    head.writeUInt8(size, at + 1);
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  writeFileSync(out, Buffer.concat([head, ...frames.map((f) => f.data)]));
  console.log(`  ${out.replace(`${ROOT}/`, "")}  ${sizes.join(", ")}`);
}

ico(join(ROOT, "src/app/favicon.ico"), FAVICON_SIZES);

/* ---------- app icons ---------- */

console.log("app icons");
shoot(join(ROOT, "public/icon-512.png"), shell(markSvg({ size: 512 })), 512, 512, { transparent: true });
shoot(join(ROOT, "public/icon-192.png"), shell(markSvg({ size: 192 })), 192, 192, { transparent: true });
// Maskable keeps the mark inside the 80%-diameter safe circle.
shoot(join(ROOT, "public/icon-maskable-512.png"), shell(bleed(512, 0.74)), 512, 512);
shoot(join(ROOT, "src/app/apple-icon.png"), shell(bleed(180, 0.86)), 180, 180);

/* ---------- open graph card ----------
   The name and what it is, above a row of cards flicking past the stop: the
   Kinora's reel laid flat, the red card standing upright where the lens is.
   No stand-in pictures of work we do not have. */

const reel = Array.from({ length: 23 }, (_, i) => {
  const here = 14;
  const lean = Math.max(-38, Math.min(38, (i - here) * -7));
  const red = i === here;
  const fade = red ? 1 : Math.max(0.14, 0.9 - Math.abs(i - here) * 0.06);
  return `<i style="transform:rotate(${lean}deg);background:${red ? TALLY : INK};opacity:${fade.toFixed(2)}"></i>`;
}).join("");

const word = (() => {
  const at = BRAND.word.indexOf("i");
  return `${BRAND.word.slice(0, at)}<span class="i">ı</span>${BRAND.word.slice(at + 1)}`;
})();

const og = `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@400;500&family=Noto+Serif+SC:wght@700&display=block" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{background:${BRAND_COLORS.paper};color:${INK};font-family:Archivo,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:72px 80px 0;display:flex;flex-direction:column}
  .head{display:flex;align-items:center;gap:30px}
  .word{font-size:118px;font-weight:800;letter-spacing:-.03em;line-height:1.2;white-space:nowrap}
  .word .i{position:relative;display:inline-block;letter-spacing:0;margin-right:-.03em}
  .word .i::after{content:"";position:absolute;left:50%;top:.12em;width:.12em;height:.19em;transform:translateX(-50%);border-radius:.025em;background:${TALLY}}
  .suffix{font-weight:400;color:#5b5b58;margin-left:.22em}
  .zh{font-family:"Noto Serif SC",serif;font-size:64px;font-weight:700;color:#4a4a47;margin-left:14px}
  .what{margin-top:20px;font-family:"IBM Plex Mono",monospace;font-size:18px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#5b5b58}
  .what b{color:${INK};font-weight:500}
  .tag{margin-top:12px;font-size:26px;line-height:1.4;color:#2b2b29;max-width:940px}
  .reel{margin-top:auto;height:150px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 6px}
  .reel i{display:block;width:22px;height:96px;border-radius:5px;transform-origin:50% 100%;margin-bottom:-14px}
</style>
<div class="head">${markSvg({ size: 132 })}<span class="word">${word}<span class="suffix">${BRAND.suffix}</span></span><span class="zh">${BRAND.zh}</span></div>
<div class="what"><b>${BRAND.descriptor}</b> · ${BRAND.descriptorZh}</div>
<div class="tag">${BRAND.tagline}</div>
<div class="reel">${reel}</div>`;

console.log("open graph");
// public/, not app/opengraph-image.png — see the OG_IMAGE note in src/site.ts.
shoot(join(ROOT, "public/og.png"), og, 1200, 630);

rmSync(WORK, { recursive: true, force: true });

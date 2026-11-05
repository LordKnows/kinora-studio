import { Geist, Geist_Mono } from "next/font/google";

/* Geist for the UI, Geist Mono for every number (durations, costs, steps,
   seeds) so columns of figures line up. Both expose a CSS variable that the
   studio tokens resolve to. */
export const geist = Geist({ subsets: ["latin"], variable: "--font-studio-sans", display: "swap" });
export const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-studio-mono", display: "swap" });

export const fontClass = `${geist.variable} ${geistMono.variable}`;

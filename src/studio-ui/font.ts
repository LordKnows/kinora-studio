import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

/* Geist for the UI, Geist Mono for every number, self-hosted from the
   `geist` package so the build never has to reach Google Fonts (the
   Workers Builds environment cannot). The variables the studio tokens use. */
export const fontClass = `${GeistSans.variable} ${GeistMono.variable}`;

import { Inter } from "next/font/google";

/* The same face and variable the playground uses, so both surfaces share one
   typeface and the studio tokens resolve to it. */
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-ohf-inter",
  display: "swap",
});

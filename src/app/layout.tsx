import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL, STUDIO_BG, openGraphFor, twitterFor } from "@/site";
import { fontClass } from "@/studio-ui/font";

import "./base.css";
import "@/studio-ui/studio.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: `%s — ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  creator: SITE_NAME,
  publisher: SITE_NAME,
  referrer: "origin-when-cross-origin",
  formatDetection: { telephone: false, address: false, email: false },
  appleWebApp: { title: SITE_NAME },
  openGraph: openGraphFor({ path: "/" }),
  twitter: twitterFor(),
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
};

/* Lights up by default (the grey card), so the browser chrome follows the studio ground. */
export const viewport: Viewport = { colorScheme: "light", themeColor: STUDIO_BG };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontClass}>
      <body className="studio">{children}</body>
    </html>
  );
}

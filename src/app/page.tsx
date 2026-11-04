import type { Metadata } from "next";

import { ProjectsPage } from "@/studio-ui/projects-page";
import { inter } from "@/studio-ui/font";

import "@/openhiggsfield/openhiggsfield.css";
import "@/studio-ui/studio.css";

/* Title, description and the Open Graph block all come from the root. Only the
   canonical link is route-specific. */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <div className={`ohf ${inter.variable}`} style={{ minHeight: "100dvh" }}>
      <ProjectsPage />
    </div>
  );
}

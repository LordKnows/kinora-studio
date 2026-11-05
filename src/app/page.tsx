import type { Metadata } from "next";

import { ProjectsPage } from "@/studio-ui/projects-page";
import { GlobalShell } from "@/studio-ui/shell";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function HomePage() {
  return (
    <GlobalShell>
      <ProjectsPage />
    </GlobalShell>
  );
}

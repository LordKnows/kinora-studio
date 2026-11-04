import type { ReactNode } from "react";

import { ProjectShell } from "@/studio-ui/shell";
import { inter } from "@/studio-ui/font";

import "@/openhiggsfield/openhiggsfield.css";
import "@/studio-ui/studio.css";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className={`ohf ${inter.variable}`}>
      <ProjectShell projectId={id}>{children}</ProjectShell>
    </div>
  );
}

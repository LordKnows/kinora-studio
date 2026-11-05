import type { ReactNode } from "react";

import { ProjectShell } from "@/studio-ui/shell";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectShell projectId={id}>{children}</ProjectShell>;
}

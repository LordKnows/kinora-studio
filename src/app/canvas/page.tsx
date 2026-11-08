import type { Metadata } from "next";

import { CanvasPage } from "@/studio-ui/canvas-page";
import { GlobalShell } from "@/studio-ui/shell";

export const metadata: Metadata = { title: "Canvas", alternates: { canonical: "/canvas" } };

export default function CanvasRoute() {
  return (
    <GlobalShell>
      <CanvasPage />
    </GlobalShell>
  );
}

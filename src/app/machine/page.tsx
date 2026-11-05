import type { Metadata } from "next";

import { MachinePage } from "@/studio-ui/machine-page";
import { GlobalShell } from "@/studio-ui/shell";

export const metadata: Metadata = { title: "Machine", alternates: { canonical: "/machine" } };

export default function MachineRoute() {
  return (
    <GlobalShell>
      <MachinePage />
    </GlobalShell>
  );
}

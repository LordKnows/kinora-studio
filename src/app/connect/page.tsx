import type { Metadata } from "next";

import { ConnectPage } from "@/studio-ui/connect-page";
import { GlobalShell } from "@/studio-ui/shell";

export const metadata: Metadata = { title: "Connect", alternates: { canonical: "/connect" } };

export default function ConnectRoute() {
  return (
    <GlobalShell>
      <ConnectPage />
    </GlobalShell>
  );
}

import type { Metadata } from "next";

import { ScriptPage } from "@/studio-ui/script-page";

export const metadata: Metadata = { title: "Script" };

export default function Page() {
  return <ScriptPage />;
}

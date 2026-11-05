import type { Metadata } from "next";

import { LibraryPage } from "@/studio-ui/library-page";
import { GlobalShell } from "@/studio-ui/shell";

export const metadata: Metadata = { title: "Library", alternates: { canonical: "/library" } };

export default function LibraryRoute() {
  return (
    <GlobalShell>
      <LibraryPage />
    </GlobalShell>
  );
}

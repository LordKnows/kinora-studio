import type { Metadata } from "next";

import { FinalsPage } from "@/studio-ui/finals-page";

export const metadata: Metadata = { title: "Finals" };

export default function Page() {
  return <FinalsPage />;
}

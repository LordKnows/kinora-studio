import type { Metadata } from "next";

import { LookPage } from "@/studio-ui/look-page";

export const metadata: Metadata = { title: "Look" };

export default function Page() {
  return <LookPage />;
}

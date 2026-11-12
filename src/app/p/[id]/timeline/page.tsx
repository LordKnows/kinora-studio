import type { Metadata } from "next";

import { TimelinePage } from "@/studio-ui/timeline-page";

export const metadata: Metadata = { title: "Cut" };

export default function Page() {
  return <TimelinePage />;
}

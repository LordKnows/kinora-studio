import type { Metadata } from "next";

import { TimelinePage } from "@/studio-ui/timeline-page";

export const metadata: Metadata = { title: "Timeline" };

export default function Page() {
  return <TimelinePage />;
}

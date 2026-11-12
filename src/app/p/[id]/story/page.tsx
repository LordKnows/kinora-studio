import type { Metadata } from "next";

import { StoryPage } from "@/studio-ui/script-page";

export const metadata: Metadata = { title: "Story" };

export default function Page() {
  return <StoryPage />;
}

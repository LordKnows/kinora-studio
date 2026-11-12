import type { Metadata } from "next";

import { ReelPage } from "@/studio-ui/score-page";

export const metadata: Metadata = { title: "Reel" };

/* A project's home is its Reel: the whole film on one time axis, what waits
   for you, and every problem the checks found. */
export default function Page() {
  return <ReelPage />;
}

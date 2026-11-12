import type { Metadata } from "next";

import { ScorePage } from "@/studio-ui/score-page";

export const metadata: Metadata = { title: "Score" };

/* A project's home is its Score: the whole film on one time axis. */
export default function Page() {
  return <ScorePage />;
}

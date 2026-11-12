import type { Metadata } from "next";

import { DirectorPage } from "@/studio-ui/director-page";

export const metadata: Metadata = { title: "Director" };

export default function Page() {
  return <DirectorPage />;
}

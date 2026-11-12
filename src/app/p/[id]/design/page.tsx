import type { Metadata } from "next";

import { DesignPage } from "@/studio-ui/design-page";

export const metadata: Metadata = { title: "Design" };

export default function Page() {
  return <DesignPage />;
}

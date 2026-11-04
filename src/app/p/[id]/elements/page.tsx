import type { Metadata } from "next";

import { ElementsPage } from "@/studio-ui/elements-page";

export const metadata: Metadata = { title: "Elements" };

export default function Page() {
  return <ElementsPage />;
}

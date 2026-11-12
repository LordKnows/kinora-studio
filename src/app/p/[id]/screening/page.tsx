import type { Metadata } from "next";

import { ScreeningPage } from "@/studio-ui/screening-page";

export const metadata: Metadata = { title: "Screening" };

export default function Page() {
  return <ScreeningPage />;
}

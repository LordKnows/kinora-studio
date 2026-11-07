import type { Metadata } from "next";

import { PicturesPage } from "@/studio-ui/pictures";

export const metadata: Metadata = { title: "Pictures" };

export default function Page() {
  return <PicturesPage />;
}

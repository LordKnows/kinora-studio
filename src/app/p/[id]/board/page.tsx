import type { Metadata } from "next";

import { BoardPage } from "@/studio-ui/board-page";

export const metadata: Metadata = { title: "Board" };

export default function Page() {
  return <BoardPage />;
}

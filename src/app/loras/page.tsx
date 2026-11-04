import type { Metadata } from "next";

import { LorasPage } from "@/studio-ui/loras-page";
import { inter } from "@/studio-ui/font";

import "@/openhiggsfield/openhiggsfield.css";
import "@/studio-ui/studio.css";

export const metadata: Metadata = {
  title: "LoRAs",
  alternates: { canonical: "/loras" },
};

export default function LorasRoute() {
  return (
    <div className={`ohf ${inter.variable}`} style={{ minHeight: "100dvh" }}>
      <LorasPage />
    </div>
  );
}

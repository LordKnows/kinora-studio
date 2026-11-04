import type { Metadata } from "next";

import { OpenHiggsfieldApp } from "@/openhiggsfield/openhiggsfield-app";
import { inter } from "@/studio-ui/font";

import "@/openhiggsfield/openhiggsfield.css";

/* The original single-shot composer and gallery, kept as a playground for
   trying models and prompts outside a project. */

export const metadata: Metadata = {
  title: "Playground",
  alternates: { canonical: "/playground" },
};

export default function PlaygroundPage() {
  return <OpenHiggsfieldApp fontClassName={inter.variable} />;
}

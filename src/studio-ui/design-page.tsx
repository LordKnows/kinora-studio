"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { ElementsPage } from "./elements-page";
import { useT } from "./i18n";
import { LookPage } from "./look-page";
import { PicturesPage } from "./pictures";

/* The Design page: the art department. Three tabs, kept in the address
   (?tab=): the Look every shot inherits, the Elements (characters, locations,
   props and their sheets), and every Picture the project has (review, where
   each is used, clearing out drafts). */

export const DESIGN_TABS = [
  { id: "look", label: "Look||design tab" },
  { id: "elements", label: "Elements" },
  { id: "pictures", label: "Pictures" },
] as const;

export type DesignTab = (typeof DESIGN_TABS)[number]["id"];

export function DesignPage() {
  return (
    <Suspense fallback={null}>
      <DesignPageInner />
    </Suspense>
  );
}

function DesignPageInner() {
  const t = useT();
  const pathname = usePathname();
  const asked = useSearchParams().get("tab");
  const tab: DesignTab = DESIGN_TABS.some((x) => x.id === asked) ? (asked as DesignTab) : "look";
  return (
    <>
      <div className="dz-tabs-row">
        <nav className="dz-tabs" aria-label={t("Design")}>
          {DESIGN_TABS.map((x) => (
            <Link key={x.id} className="dz-tab" href={x.id === "look" ? pathname : `${pathname}?tab=${x.id}`} aria-current={tab === x.id ? "page" : undefined}>
              {t(x.label)}
            </Link>
          ))}
        </nav>
      </div>
      {tab === "look" ? <LookPage /> : tab === "elements" ? <ElementsPage /> : <PicturesPage />}
    </>
  );
}

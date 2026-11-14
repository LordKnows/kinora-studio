"use client";

import { useState, type ReactNode } from "react";

import { Modal } from "./common";
import { useT } from "./i18n";
import { ExpandIcon } from "./icons";

/* A picture shown large, in a popup: a small button in the corner of every
   picture (a thumbnail in a grid, a shot's poster, a frame slot) opens it,
   whatever a click on the picture itself does there (pick it, open the
   shot). The popup shows the whole picture and links to the file. */

export function ZoomButton({ url, title, facts }: { url: string; title?: string; facts?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="st-zoom"
        aria-label={t("Show large")}
        title={t("Show large")}
        data-no-drag="true"
        /* the picture under it may be a button, or a card that can be picked up: neither hears this press */
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      >
        <ExpandIcon size={13} />
      </button>
      {open && (
        <Modal title={title || t("Picture")} size="full" onClose={() => setOpen(false)} head={<a className="st-btn st-btn--sm st-btn--quiet" href={url} target="_blank" rel="noreferrer">{t("Open original")}</a>}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="st-lightbox-img" src={url} alt={title ?? ""} />
          {facts && <p className="st-muted st-num" style={{ marginTop: 8 }}>{facts}</p>}
        </Modal>
      )}
    </>
  );
}

/** A picture's frame with the button in its corner. `children` is the picture as the page draws it. */
export function Zoomable({ url, title, facts, children }: { url?: string; title?: string; facts?: string; children: ReactNode }) {
  return (
    <span className="st-zoomable">
      {children}
      {url && <ZoomButton url={url} title={title} facts={facts} />}
    </span>
  );
}

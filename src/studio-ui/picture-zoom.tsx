"use client";

import { useState, type ReactNode } from "react";

import { Modal } from "./common";
import { useT } from "./i18n";
import { ExpandIcon } from "./icons";

/* A picture shown large, in a popup: a small button in the corner of every
   picture (a thumbnail in a grid, a shot's poster, a frame slot) opens it,
   whatever a click on the picture itself does there (pick it, open the
   shot). The popup takes the picture's own shape: as wide as the picture can
   be shown whole, so a 16:9 frame fills it from edge to edge and an upright
   one makes a narrow popup, with nothing empty beside either. */

/** The popup itself. Sized for 16:9 until the picture has loaded and told its own shape. */
export function PicturePopup({ url, title, facts, onClose }: { url: string; title?: string; facts?: string; onClose: () => void }) {
  const t = useT();
  const [ratio, setRatio] = useState(16 / 9);
  return (
    <Modal title={title || t("Picture")} fit={ratio} onClose={onClose} head={<a className="st-btn st-btn--sm st-btn--quiet" href={url} target="_blank" rel="noreferrer">{t("Open original")}</a>}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="st-lightbox-img" src={url} alt={title ?? ""} onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setRatio(w / h); }} />
      {facts && <p className="st-muted st-num st-lightbox-facts">{facts}</p>}
    </Modal>
  );
}

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
      {open && <PicturePopup url={url} title={title} facts={facts} onClose={() => setOpen(false)} />}
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

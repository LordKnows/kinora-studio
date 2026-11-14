"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/* Sorting the shots of a scene by hand: press a card and hold, then drag it
   to its place. A finger has to hold (a swipe scrolls the page as before); a
   mouse may also just press and drag. While a card is held the grid shows the
   order it would leave: the card takes the slot of the one the pointer is
   over, and the rest close up. Letting go keeps that order; Escape puts the
   card back. Cards carry data-shot-id and data-scene-id; a press that starts
   on something marked data-no-drag (a button over the picture) is left alone. */

export type ShotDrag = { sceneId: string; id: string; order: string[]; dropped?: boolean };

const HOLD_MS = 350;
const SLOP_PX = 8;
/* near the top (under the sticky bars) or the bottom of the window, a held card scrolls the page */
const EDGE_TOP = 150;
const EDGE_BOTTOM = 70;

export function useShotSort(commit: (sceneId: string, ids: string[]) => Promise<void>) {
  const [drag, setDrag] = useState<ShotDrag | null>(null);
  const live = useRef<ShotDrag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const press = useCallback((sceneId: string, ids: string[], shotId: string) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || ids.length < 2 || live.current) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const finger = e.pointerType !== "mouse";
    let held = false;

    const begin = () => {
      held = true;
      const d: ShotDrag = { sceneId, id: shotId, order: ids };
      live.current = d;
      setDrag(d);
      document.body.style.cursor = "grabbing";
      window.getSelection()?.removeAllRanges();
    };
    const timer = window.setTimeout(begin, HOLD_MS);

    const stop = () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", abort);
      document.removeEventListener("touchmove", noScroll);
      document.removeEventListener("contextmenu", noMenu);
      document.removeEventListener("keydown", key);
      document.body.style.cursor = "";
      cleanup.current = null;
    };
    const abort = () => {
      stop();
      live.current = null;
      setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      if (!held) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= SLOP_PX) return;
        if (finger) return abort(); /* a swipe: the page scrolls and nothing is picked up */
        window.clearTimeout(timer);
        begin();
      }
      if (ev.clientY < EDGE_TOP) window.scrollBy(0, -18);
      else if (ev.clientY > window.innerHeight - EDGE_BOTTOM) window.scrollBy(0, 18);
      const d = live.current;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-shot-id]");
      const overId = over?.dataset.shotId;
      if (!d || !over || !overId || overId === d.id || over.dataset.sceneId !== d.sceneId) return;
      const at = d.order.indexOf(overId);
      const order = d.order.filter((id) => id !== d.id);
      order.splice(at, 0, d.id);
      const next = { ...d, order };
      live.current = next;
      setDrag(next);
    };
    const up = () => {
      const d = live.current;
      stop();
      if (!held || !d) return;
      /* the release would also be a click on the card under the pointer, which opens the shot */
      const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 80);
      if (d.order.join() === ids.join()) {
        live.current = null;
        setDrag(null);
        return;
      }
      setDrag({ ...d, dropped: true });
      void commit(d.sceneId, d.order).finally(() => {
        live.current = null;
        setDrag(null);
      });
    };
    /* a held card must not scroll the page under the finger, nor open the long-press menu */
    const noScroll = (ev: TouchEvent) => { if (held) ev.preventDefault(); };
    const noMenu = (ev: Event) => { if (held || finger) ev.preventDefault(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") abort(); };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", abort);
    document.addEventListener("touchmove", noScroll, { passive: false });
    document.addEventListener("contextmenu", noMenu);
    document.addEventListener("keydown", key);
    cleanup.current = stop;
  }, [commit]);

  return { drag, press };
}

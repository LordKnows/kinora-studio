"use client";

import { useEffect, useRef } from "react";
import type Sortable from "sortablejs";

/* Sorting the shots of a scene by hand, with SortableJS (it was a hand-made
   drag at first; a library that has met every browser and every finger does
   it better). A card is picked up and dragged to its place in its scene:

   - a mouse presses and drags; a finger holds for a moment first, so a swipe
     still scrolls the page;
   - a copy of the card follows the pointer (st-shot--lifted), and the card
     itself, dimmed inside a dashed frame (st-shot--slot), sits where it would
     land and moves as the pointer does;
   - letting go keeps that order; the page scrolls when the card nears its edge.

   The cards are React's to draw, so when a drag ends the card SortableJS
   moved is put back where React left it, and the new order is handed to the
   page, which draws it. Anything marked data-no-drag (the button over the
   picture) does not start a drag. */

export function useShotSort(key: string, ids: string[], onSorted: (ids: string[]) => void) {
  const grid = useRef<HTMLDivElement>(null);
  const latest = useRef({ ids, onSorted });
  latest.current = { ids, onSorted };
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    let sortable: Sortable | undefined;
    let gone = false;
    /* loaded on the Board only, and only in the browser */
    void import("sortablejs").then(({ default: SortableJs }) => {
      if (gone) return;
      sortable = SortableJs.create(el, {
        draggable: "[data-shot-id]",
        filter: "[data-no-drag]",
        preventOnFilter: false,
        delay: 300,
        delayOnTouchOnly: true,
        touchStartThreshold: 6,
        /* its own drag, not the browser's: the same lifted card and the same feel everywhere */
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 6,
        animation: 160,
        ghostClass: "st-shot--slot",
        chosenClass: "st-shot--chosen",
        dragClass: "st-shot--lifted",
        scroll: true,
        bubbleScroll: true,
        scrollSensitivity: 110,
        scrollSpeed: 16,
        onEnd: (e) => {
          const from = e.oldDraggableIndex, to = e.newDraggableIndex;
          if (from === undefined || to === undefined || from === to) return;
          e.from.removeChild(e.item);
          e.from.insertBefore(e.item, e.from.children[from] ?? null);
          const next = [...latest.current.ids];
          const [moved] = next.splice(from, 1);
          if (moved === undefined) return;
          next.splice(to, 0, moved);
          latest.current.onSorted(next);
        },
      });
    });
    return () => {
      gone = true;
      sortable?.destroy();
    };
  }, [key]);
  return grid;
}

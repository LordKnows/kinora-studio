"use client";

import { useCallback, useSyncExternalStore } from "react";

import { board } from "./zh/board";
import { core } from "./zh/core";
import { cut } from "./zh/cut";
import { global } from "./zh/global";
import { pages } from "./zh/pages";

/* The interface language, per browser: English (the default) or Chinese.
   A string is translated by its English text, so a page that has not been
   translated yet simply stays English. Keys may carry {name} holes. The
   choice lives in localStorage; the page is rendered in English on the
   server and switches on the client. */

export type Lang = "en" | "zh";
const KEY = "studio.lang";
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

export function setLang(lang: Lang) {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode: the switch holds for this page only */
  }
  document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
  for (const f of listeners) f();
}

function subscribe(f: () => void) {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) f(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(f); window.removeEventListener("storage", onStorage); };
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, read, () => "en");
}

export type T = (s: string, vars?: Record<string, string | number>) => string;

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all)) : s);

export const translate = (lang: Lang): T => (s, vars) => fill(lang === "zh" ? ZH[s] ?? s : s, vars);

export function useT(): T {
  const lang = useLang();
  return useCallback<T>((s, vars) => translate(lang)(s, vars), [lang]);
}

/** English needs a plural; Chinese does not. */
export const plural = (t: T, n: number, one: string, many: string, vars?: Record<string, string | number>) => t(n === 1 ? one : many, { n, ...vars });

/* One dictionary per area of the interface, merged; a key in a later one wins. */
const ZH: Record<string, string> = { ...core, ...board, ...pages, ...cut, ...global };

/* One fetch wrapper for the studio pages. Every non-2xx body is
   { error: { code, message, details } } (§7.4); it surfaces as ApiError so a
   page can branch on needs_confirm / not_approved without string matching. */

export type ErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "not_approved"
  | "needs_confirm"
  | "budget_exceeded"
  | "backend_error";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined;
  }

  get estimateUsd(): number | undefined {
    const v = this.details?.estimateUsd;
    return typeof v === "number" ? v : undefined;
  }

  get checkpoint(): string | undefined {
    const v = this.details?.checkpoint;
    return typeof v === "string" ? v : undefined;
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: ErrorCode; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "backend_error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export function describe(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : String(caught);
}

export function usd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function when(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

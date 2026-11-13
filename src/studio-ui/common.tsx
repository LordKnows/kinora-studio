"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ArrowUpIcon, CheckIcon, CloseIcon, CopyIcon, UploadIcon, WarningIcon } from "./icons";
import { uploadMedia } from "./upload";

import { ApiError, describe, usd, when } from "./api";
import { type T, useT } from "./i18n";

/* Small shared controls for the studio pages. Every control carries its
   hover / focus / disabled / busy states in studio.css. */

/** A number field that can be typed into: what is typed is kept as text and
    clamped to min..max only on blur or Enter (clamping on every key turns
    "1" into the minimum before the "2" of "12" arrives). */
export function NumberInput({ value, min, max, onCommit, allowEmpty = false, integer = true, className = "st-input", placeholder, style, ariaLabel }: {
  value: number | null | undefined; min: number; max: number; onCommit: (v: number | null) => void; allowEmpty?: boolean; integer?: boolean;
  className?: string; placeholder?: string; style?: React.CSSProperties; ariaLabel?: string;
}) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text.trim() === "") {
      if (allowEmpty) onCommit(null);
      else setText(shown);
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) return setText(shown);
    const c = Math.max(min, Math.min(max, integer ? Math.round(n) : n));
    setText(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <input className={className} type="number" inputMode={integer ? "numeric" : "decimal"} min={min} max={max} step={integer ? 1 : "any"} value={text} placeholder={placeholder} style={style} aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}

export function Button({
  children,
  onClick,
  kind = "default",
  size,
  busy,
  disabled,
  type = "button",
  title,
  expanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** tally: the one red button of a page — the next step, or a spend.
      destroy: the button that confirms a deletion, inside its question. */
  kind?: "default" | "primary" | "quiet" | "danger" | "tally" | "destroy";
  size?: "sm";
  busy?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  /** set on a button that opens a popover: whether it is open */
  expanded?: boolean;
}) {
  const cls = ["st-btn", kind !== "default" ? `st-btn--${kind}` : "", size ? `st-btn--${size}` : ""].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled || busy} data-busy={busy ? "true" : undefined} title={title} {...(expanded === undefined ? {} : { "aria-expanded": expanded, "aria-haspopup": "dialog" as const })}>
      {children}
    </button>
  );
}

/** A state told by an icon in its colour and a word: green for done, amber for
    not yet, red for wrong, blue for a note (studio.css, --sig-*). */
export function Status({ tone, icon, children }: { tone: "ok" | "warn" | "err" | "info"; icon: ReactNode; children: ReactNode }) {
  return (
    <span className="st-status" data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

export function Lamp({ state, label }: { state: string; label: string }) {
  return (
    <span className="st-lamp" data-state={state}>
      {label}
    </span>
  );
}

/** A labelled control. `group` renders a <div> instead of a <label>, for
    content with buttons in it (Chips): a click anywhere on a <label> is
    forwarded to its first button, and would remove the first tag. */
export function Field({ label, children, hint, group }: { label: string; children: ReactNode; hint?: string; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="st-field" {...(group ? { role: "group", "aria-label": label } : {})}>
      <span className="st-label">{label}</span>
      {children}
      {hint && <span className="st-muted" style={{ marginTop: 4 }}>{hint}</span>}
    </Tag>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-section">
      <div className="st-section-title">
        <span>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="st-empty">
      <strong>{title}</strong>
      {hint}
      {children && <div className="st-row" style={{ justifyContent: "center", marginTop: 12 }}>{children}</div>}
    </div>
  );
}

/** Shows an API failure. needs_confirm gets a confirm button that re-runs the
    action with confirm: true; not_approved links to the page that unblocks. */
export function ErrorBanner({
  error,
  onConfirm,
  onDismiss,
  projectId,
}: {
  error: unknown;
  onConfirm?: () => void;
  onDismiss?: () => void;
  projectId?: string;
}) {
  const t = useT();
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  const checkpointHref = api?.checkpoint && projectId
    ? api.checkpoint === "script" ? `/p/${projectId}/story` : api.checkpoint === "shotlist" ? `/p/${projectId}/board` : `/p/${projectId}/cut`
    : null;
  const cls = api?.code === "needs_confirm" ? "st-alert st-alert--accent" : "st-alert";
  return (
    <div className={cls} role="alert">
      <WarningIcon size={14} />
      <span>
        {describe(error)}
        {api?.code === "needs_confirm" && api.estimateUsd !== undefined && (
          <>
            {" "}
            <strong className="st-num">{t("Estimated {usd}.", { usd: usd(api.estimateUsd) })}</strong>
          </>
        )}
        {checkpointHref && (
          <>
            {" "}
            <Link className="st-link" href={checkpointHref}>
              {t(`Open the ${api!.checkpoint} page`)}
            </Link>
          </>
        )}
      </span>
      {api?.code === "needs_confirm" && onConfirm && (
        <Button kind="primary" size="sm" onClick={onConfirm}>
          {t("Confirm and spend")}
        </Button>
      )}
      {onDismiss && (
        <button type="button" className="st-btn st-btn--quiet st-btn--sm" onClick={onDismiss} aria-label={t("Dismiss")}>
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}

/** A menu that drops from a button: the box (button + menu) takes `ref`; a
    press outside it or Escape closes it. pointerdown, not mousedown, so a tap
    on a phone closes it too. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** A button with a small panel that drops from it (or rises: `placement`),
    for a short form or a question asked where it was raised. `children` gets
    `close`. A press outside or Escape closes it, and only it: inside a
    drawer, Escape does not close the drawer as well. */
export function Popover({ label, children, kind, size, title, busy, disabled, placement = "below", align = "end", tip, panelLabel }: {
  label: ReactNode; children: (close: () => void) => ReactNode; kind?: "default" | "primary" | "quiet" | "danger"; size?: "sm"; title?: string; busy?: boolean; disabled?: boolean;
  placement?: "below" | "above"; align?: "start" | "end";
  /** a speech-bubble: narrow, with a notch toward the button */
  tip?: boolean; panelLabel?: string;
}) {
  const { open, setOpen, ref } = usePopover();
  const close = () => {
    setOpen(false);
    ref.current?.querySelector("button")?.focus();
  };
  return (
    <div className="st-pop-anchor" ref={ref} onKeyDown={(e) => { if (open && e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <Button kind={kind} size={size} busy={busy} disabled={disabled} title={open ? undefined : title} expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && (
        <div className="st-pop" role="dialog" aria-label={panelLabel ?? title} data-placement={placement} data-align={align} data-tip={tip ? "true" : undefined}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** A button that asks before it acts: the question opens in a bubble at the
    button, with the action and a way out. For deletions. */
export function ConfirmButton({ children, question, confirmLabel, onConfirm, kind = "quiet", size, busy, title, placement, align }: {
  children: ReactNode; question: ReactNode; confirmLabel: string; onConfirm: () => void; kind?: "quiet" | "danger" | "default"; size?: "sm"; busy?: boolean; title?: string;
  placement?: "below" | "above"; align?: "start" | "end";
}) {
  const t = useT();
  return (
    <Popover label={children} kind={kind} size={size} busy={busy} title={title} placement={placement} align={align} tip panelLabel={confirmLabel}>
      {(close) => (
        <div className="st-confirm">
          <p>{question}</p>
          <div className="st-row">
            <Button size="sm" kind="destroy" onClick={() => { close(); onConfirm(); }}>{confirmLabel}</Button>
            <Button size="sm" kind="quiet" onClick={close}>{t("Cancel")}</Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Back to the top of a long page: shows once the page has scrolled a screen or so. */
export function BackToTop() {
  const t = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  const still = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <button type="button" className="st-totop" onClick={() => window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" })}>
      <ArrowUpIcon size={13} />
      {t("Back to top")}
    </button>
  );
}

/** Runs an action; on needs_confirm the banner offers a retry with confirm. */
export function useAction<Args extends unknown[]>(run: (confirm: boolean, ...args: Args) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastArgs, setLastArgs] = useState<Args | null>(null);
  const fire = useCallback(
    async (...args: Args) => {
      setBusy(true);
      setError(null);
      setLastArgs(args);
      try {
        await run(false, ...args);
      } catch (caught) {
        setError(caught);
      } finally {
        setBusy(false);
      }
    },
    [run],
  );
  const confirm = useCallback(async () => {
    if (!lastArgs) return;
    setBusy(true);
    setError(null);
    try {
      await run(true, ...lastArgs);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }, [run, lastArgs]);
  const dismiss = useCallback(() => setError(null), []);
  return { fire, confirm, dismiss, busy, error };
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const tr = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <div className="st-field">
      <span className="st-label">{label}</span>
      <div className="st-copyrow">
        <input className="st-input" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setDone(true));
          }}
          title={tr("Copy")}
        >
          {done ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {done ? tr("Copied") : tr("Copy")}
        </Button>
      </div>
    </div>
  );
}

export function Chips({ values, onRemove, onAdd, placeholder }: { values: string[]; onRemove?: (i: number) => void; onAdd?: (v: string) => void; placeholder?: string }) {
  const t = useT();
  const [draft, setDraft] = useState("");
  return (
    <div className="st-stack st-stack--tight">
      <div className="st-chips">
        {values.length === 0 && <span className="st-muted">{t("None")}</span>}
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="st-chip">
            {v}
            {onRemove && (
              <button type="button" onClick={() => onRemove(i)} aria-label={t("Remove {v}", { v })}>
                <CloseIcon size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {onAdd && (
        <input
          className="st-input st-input--sm"
          placeholder={placeholder ?? t("Type and press Enter")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              onAdd(draft.trim());
              setDraft("");
            }
          }}
        />
      )}
    </div>
  );
}

export function Stars({ value, onChange }: { value?: number; onChange: (n: number) => void }) {
  const t = useT();
  return (
    <span className="st-stars" role="radiogroup" aria-label={t("Score||rating")}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className="st-star" aria-pressed={(value ?? 0) >= n} onClick={() => onChange(n)} aria-label={t("{n} of 5", { n })}>
          ★
        </button>
      ))}
    </span>
  );
}

/** A popup over everything (also over a drawer): Esc or a click outside closes it, and only it. */
export function Modal({ title, onClose, children, size = "md", head }: { title: ReactNode; onClose: () => void; children: ReactNode; size?: "md" | "lg" | "full"; head?: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="st-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="st-modal" data-size={size} role="dialog" aria-modal="true">
        <div className="st-modal-head">
          <div className="st-modal-title">{title}</div>
          {head}
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" onClick={onClose} aria-label={t("Close")}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="st-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, onClose, children, head }: { title: string; onClose: () => void; children: ReactNode; head?: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="st-drawer-back" onClick={onClose} />
      <aside className="st-drawer" role="dialog" aria-label={title}>
        <div className="st-drawer-head">
          <div className="st-drawer-title">{title}</div>
          {head}
          <button type="button" className="st-btn st-btn--quiet st-btn--sm" onClick={onClose} aria-label={t("Close")}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="st-drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="st-skeleton" style={{ height }} />;
}

/** A take's status in a word. English: the components that show it pass it through t(). */
export function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "GPU starting";
    case "running":
      return "Rendering";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "timeout":
      return "Timed out";
    default:
      return status;
  }
}

/** A file picker that uploads straight to R2 (presign → PUT → commit) and
    hands back the new asset. The caller decides what the asset becomes. */
export function UploadButton({
  accept,
  projectId,
  onUploaded,
  label = "Upload",
  size = "sm",
  purpose,
  disabled,
  title = "Upload from this device",
}: {
  accept: string;
  projectId: string;
  onUploaded: (asset: { assetId: string; url: string }) => Promise<void> | void;
  label?: string;
  size?: "sm";
  /** Recorded on the picture (an uploaded style frame is listed with the generated ones). */
  purpose?: "style_frame";
  disabled?: boolean;
  title?: string;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="st-row">
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            await onUploaded(await uploadMedia(file, projectId, purpose));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button size={size} busy={busy} disabled={disabled} onClick={() => input.current?.click()} title={t(title)}>
        <UploadIcon size={12} /> {busy ? t("Uploading…") : t(label)}
      </Button>
      {error && <span className="st-muted st-danger">{error}</span>}
    </span>
  );
}

/** `when` (api.ts) in the interface language: "just now", "5 min ago"… */
export function whenT(t: T, ts: number): string {
  const s = when(ts);
  const m = /^(\d+) (min|hr|d) ago$/.exec(s);
  return m ? t(`{n} ${m[2]} ago`, { n: m[1]! }) : t(s);
}

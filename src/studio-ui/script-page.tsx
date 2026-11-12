"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import type { StoredTreatment, TreatmentWarning } from "@/studio/treatment";
import type { Script } from "@/studio/types";

import { get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Lamp, Section, useAction, whenT } from "./common";
import { filmShots, shotPicture, tc } from "./film";
import { Markdown } from "./markdown";
import { coverage, normalize } from "@/studio/coverage";

import { plural, useLang, useT } from "./i18n";
import { diffSentences, scriptSections } from "./script-text";
import { BriefCard } from "./look-page";
import { useProjectContext } from "./shell";
import { lintLine } from "./zh/lint";

/* The Story page: the brief and running time the director reads first, then
   the script — its versions, the lined script beside the Board, the changes
   between versions — and the treatment that explains its shape. */
export function StoryPage() {
  return (
    <Suspense fallback={null}>
      <StoryPageInner />
    </Suspense>
  );
}

function StoryPageInner() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [treatment, setTreatment] = useState<StoredTreatment | null>(null);
  const [treatmentWarnings, setTreatmentWarnings] = useState<TreatmentWarning[]>([]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const params = useSearchParams();
  const [mode, setMode] = useState<"read" | "board" | "changes">(params.get("view") === "lined" ? "board" : "read");

  const load = useCallback(async () => {
    const { scripts, treatment, treatmentWarnings } = await get<{ scripts: Script[]; treatment?: StoredTreatment | null; treatmentWarnings?: TreatmentWarning[] }>(`/api/projects/${projectId}/scripts`);
    setScripts(scripts);
    setTreatment(treatment ?? null);
    setTreatmentWarnings(treatmentWarnings ?? []);
    setOpen((cur) => cur ?? scripts[0]?.id ?? null);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, view?.script?.id, view?.script?.approval]);

  const save = useAction(async () => {
    if (!draft.trim()) return;
    await post(`/api/projects/${projectId}/scripts`, { text: draft });
    setDraft("");
    await load();
    await reload();
  });

  const approve = useAction(async (_confirm, id: string) => {
    await post(`/api/scripts/${id}/approve`);
    await load();
    await reload();
  });

  const latest = scripts?.[0];
  const current = scripts?.find((s) => s.id === open) ?? latest;
  const look = view?.project.look;

  function promptPack() {
    const pack = [
      `You are the director of a short film project called "${view?.project.name ?? "Untitled"}".`,
      look ? `Look: ${[look.genre, look.palette, look.camera, look.lens, look.lighting].filter(Boolean).join("; ")}. Aspect ratio ${look.aspectRatio}.` : "",
      "Write a screenplay for it: scene headings, action, dialogue. Shots will be 5–15 seconds each and rendered by MiniMax H3 (768p, native audio), so keep every moment visual and concrete.",
      "Return only the screenplay text. I will paste it into the Story page.",
    ]
      .filter(Boolean)
      .join("\n\n");
    void navigator.clipboard.writeText(pack).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Story")}</h1>
          <p className="st-subtitle">{t("The brief, the script and its treatment. The script is checkpoint 1: every new version returns to draft; nothing renders until the latest version is approved.")}</p>
        </div>
        <div className="st-actions">
          <Button kind="quiet" onClick={promptPack}>
            {copied ? t("Copied") : t("Copy prompt pack")}
          </Button>
          {latest && latest.approval === "approved" && view?.delegated?.script && (
            <span className="st-chip" title={t("Approved under delegated approval; overturn it in the Director panel, under Decisions")}>{t("Approved by the director")}</span>
          )}
          {latest && latest.approval !== "approved" && (
            <Button kind="primary" busy={approve.busy} onClick={() => void approve.fire(latest.id)}>
              {t("Approve v{v}", { v: latest.version })}
            </Button>
          )}
        </div>
      </div>
      <ErrorBanner error={save.error ?? approve.error} onDismiss={() => { save.dismiss(); approve.dismiss(); }} />

      <div style={{ marginBottom: 20 }}>
        <BriefCard />
      </div>

      <div className="st-split st-split--wide-right">
        <div className="st-stack">
          <div className="st-card st-stack">
            <span className="st-label">{t("New version")}</span>
            <textarea className="st-textarea" rows={12} placeholder={t("Paste the screenplay here, or let the director agent call save_script.")} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="st-row st-row--between">
              <span className="st-muted st-num">{t("{n} chars", { n: draft.length.toLocaleString() })}</span>
              <Button kind="primary" busy={save.busy} disabled={!draft.trim()} onClick={() => void save.fire()}>
                {t("Save as v{v}", { v: (latest?.version ?? 0) + 1 })}
              </Button>
            </div>
          </div>
          <Section title={t("Versions")} aside={<small>{scripts?.length ?? 0}</small>}>
            {!scripts ? null : scripts.length === 0 ? (
              <Empty title={t("No script yet")} hint={t("Paste one above or ask your director agent for a draft.")} />
            ) : (
              <div className="st-card st-card--pad0">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>{t("Version")}</th>
                      <th>{t("State")}</th>
                      <th>{t("Saved||when")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scripts.map((s) => (
                      <tr key={s.id} style={{ cursor: "pointer", background: s.id === current?.id ? "var(--s2)" : undefined }} onClick={() => setOpen(s.id)}>
                        <td>v{s.version}</td>
                        <td>
                          <Lamp state={s.approval} label={t(s.approval)} />
                        </td>
                        <td>{whenT(t, s.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
        <div className="st-stack">
          <div className="st-card st-stack">
            <div className="st-row st-row--between">
              <span className="st-row">
                <span className="st-label" style={{ marginBottom: 0 }}>{current ? `v${current.version}` : t("Preview")}</span>
                {current && <Lamp state={current.approval} label={t(current.approval)} />}
              </span>
              {current && (
                <div className="st-seg" role="group" aria-label={t("How to show the script")}>
                  <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>{t("Read")}</button>
                  <button type="button" aria-pressed={mode === "board"} onClick={() => setMode("board")}>{t("Lined")}</button>
                  <button type="button" aria-pressed={mode === "changes"} disabled={!scripts?.some((x) => x.version < current.version)} onClick={() => setMode("changes")}>{t("Changes")}</button>
                </div>
              )}
            </div>
            {!current ? <span className="st-muted">{t("Select a version to read it.")}</span>
              : mode === "board" ? <BesideTheBoard text={current.text} latest={current.id === latest?.id} version={current.version} />
              : mode === "changes" ? <Changes before={scripts?.find((x) => x.version < current.version)} after={current} />
              : <div style={{ maxHeight: 720, overflow: "auto" }}><Markdown source={current.text} /></div>}
          </div>
          {scripts && scripts.length > 0 && <TreatmentPanel treatment={treatment} warnings={treatmentWarnings} />}
        </div>
      </div>
    </div>
  );
}

/* Why the film is shaped the way it is: what the director wrote down before
   the screenplay, and what the lint says is missing from it. */
function TreatmentPanel({ treatment, warnings }: { treatment: StoredTreatment | null; warnings: TreatmentWarning[] }) {
  const tr = useT();
  const lang = useLang();
  const t = treatment?.treatment;
  const sep = tr("; ||list");
  return (
    <Section title={tr("Treatment")} aside={treatment ? <small>{tr("for v{v}", { v: treatment.scriptVersion })}</small> : undefined}>
      <div className="st-stack">
      {warnings.length > 0 && (
        <div className="st-card st-stack" style={{ gap: 6 }}>
          {warnings.map((w, i) => (
            <div key={i} className="st-row" style={{ alignItems: "baseline", gap: 8 }}>
              <Lamp state={w.severity === "info" ? "draft" : "failed"} label={tr(`${w.severity}||severity`)} />
              {(() => {
                /* in Chinese: what the code means, and the server's own message beneath */
                const line = lintLine(lang, w);
                return <span className="st-muted" style={{ flex: 1 }}>{line.text}{line.detail && <span style={{ display: "block", fontSize: 12 }}>{line.detail}</span>}</span>;
              })()}
            </div>
          ))}
        </div>
      )}
      {!t ? (
        <Empty title={tr("No treatment yet")} hint={tr("The director sends it with save_script: logline, arc, the three structures it weighed, the sound design.")} />
      ) : (
        <div className="st-card st-stack">
          <div>
            <span className="st-label">{tr("Logline")}</span>
            <p style={{ margin: 0 }}>{t.logline}</p>
          </div>
          <div>
            <span className="st-label">{tr("Arc")}</span>
            <p className="st-muted" style={{ margin: 0 }}>{t.arc.setup} → {t.arc.turn} → {t.arc.ending}</p>
          </div>
          <div>
            <span className="st-label">{tr("Structure")}</span>
            {t.candidates.map((c) => (
              <p key={c.name} className={c.name === t.chosen ? undefined : "st-muted"} style={{ margin: "0 0 4px" }}>
                <strong>{c.name}{c.name === t.chosen ? tr(" (chosen)") : ""}.</strong> {c.shape}
              </p>
            ))}
            <p className="st-muted" style={{ margin: 0 }}>{t.whyChosen}</p>
          </div>
          <div>
            <span className="st-label">{tr("Hook, signature, ending")}</span>
            <p className="st-muted" style={{ margin: 0 }}>{tr("{s} s: {hook}. Signature shot: {signature}. Native move: {move}. The ending answers the opening: {echo}", { s: t.hook.atSecond, hook: t.hook.description, signature: t.signatureShot, move: t.nativeMove, echo: t.endingEcho })}</p>
          </div>
          <div>
            <span className="st-label">{tr("Benchmark")}</span>
            {t.benchmark.map((b) => (
              <p key={b.work} className="st-muted" style={{ margin: "0 0 4px" }}><strong>{b.work}.</strong>{tr(" Learn: {learn}. Leave: {leave}.", { learn: b.learn, leave: b.dontLearn })}</p>
            ))}
          </div>
          <div className="st-card st-card--pad0" style={{ overflowX: "auto" }}>
            <table className="st-table">
              <thead>
                <tr><th>{tr("Sequence")}</th><th>{tr("s||seconds")}</th><th>{tr("Pace")}</th><th>{tr("Ambience")}</th><th>{tr("Foley")}</th><th>{tr("Music")}</th></tr>
              </thead>
              <tbody>
                {t.sequences.map((s) => {
                  const sound = t.soundDesign.find((r) => r.sequence === s.name);
                  return (
                    <tr key={s.name}>
                      <td title={s.purpose}>{s.name}</td>
                      <td className="st-num">{s.seconds}</td>
                      <td>{s.pace}</td>
                      <td>{sound?.ambience ?? "—"}</td>
                      <td>{sound?.foley ?? "—"}</td>
                      <td>{sound?.music ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(t.silences.length > 0 || t.audioBridges.length > 0) && (
            <p className="st-muted" style={{ margin: 0 }}>
              {t.silences.length > 0 && tr("Silences: {list}. ", { list: t.silences.map((x) => tr("{s} s ({why})", { s: x.atSecond, why: x.why })).join(sep) })}
              {t.audioBridges.length > 0 && tr("Sound bridges: {list}.", { list: t.audioBridges.map((b) => tr("{s} s {kind} ({what})", { s: b.atSecond, kind: tr(b.kind === "j_cut" ? "J-cut" : "L-cut"), what: b.what })).join(sep) })}
            </p>
          )}
        </div>
      )}
      </div>
    </Section>
  );
}

/* The lined script: every sentence of the scenes beside the shots that show
   it. A shot names the lines it shows (spec.scriptLines, quoted from the
   script); each is drawn as a line in the margin, as a script supervisor
   lines a shooting script, and a sentence no shot shows is marked open. A
   sentence can be lined to a shot here, and a line taken off one. Sections
   pair with scenes by order when there are as many of each, for the board's
   seconds against the time a heading states. */
function BesideTheBoard({ text, latest, version }: { text: string; latest: boolean; version: number }) {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!view) return null;
  const { preamble, sections } = scriptSections(text);
  const shots = filmShots(view);
  const cov = coverage(text, shots.map((s) => ({ id: s.shot.id, slate: s.slate, scriptLines: s.shot.spec.scriptLines })));
  const bySlate = new Map(shots.map((s) => [s.shot.id, s]));
  const paired = sections.length > 0 && sections.length === view.scenes.length;
  const base = `/p/${projectId}`;
  const open = cov.lines.filter((l) => l.open).length;
  const quoted = new Set(cov.lines.flatMap((l) => l.shots));
  const silent = shots.filter((s) => !quoted.has(s.shot.id) && !(s.shot.spec.scriptLines ?? []).length);

  const write = async (shotId: string, next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/shots/${shotId}`, { scriptLines: next });
      await reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const lineTo = (shotId: string, sentence: string) => {
    const cur = bySlate.get(shotId)?.shot.spec.scriptLines ?? [];
    return write(shotId, [...cur, sentence.trim()]);
  };
  const unline = (shotId: string, sentence: string) => {
    const key = normalize(sentence);
    const cur = bySlate.get(shotId)?.shot.spec.scriptLines ?? [];
    return write(shotId, cur.filter((q) => { const k = normalize(q); return !(key.includes(k) || k.includes(key)); }));
  };

  if (sections.length === 0 && cov.lines.length === 0) return <p className="st-muted">{t("No scene headings or sentences were found in this version, so there is nothing to line.")}</p>;
  /* lanes: the shots that line something in a section, in film order; a lane draws a shot's line down the margin */
  return (
    <div className="scr-lined">
      <div className="scr-lined-sum st-num">
        {t("{c} of {n} lines on a shot", { c: cov.lines.length - open, n: cov.lines.length })}{open ? t(" · {n} open", { n: open }) : ""}{silent.length ? plural(t, silent.length, " · 1 shot names no line", " · {n} shots name no line") : ""}
      </div>
      {!latest && <div className="st-alert st-alert--info"><span>{t("Shots quote the latest version; lining is done there. This is v{v}.", { v: version })}</span></div>}
      {!paired && sections.length > 0 && <div className="st-alert st-alert--info"><span>{t("{sections} in the script, {scenes} on the board: the timings are not compared.", { sections: plural(t, sections.length, "1 section", "{n} sections"), scenes: plural(t, view.scenes.length, "1 scene", "{n} scenes") })}</span></div>}
      {cov.stale.map((x, i) => (
        <div key={i} className="st-alert">
          <span>{t("{slate} quotes “{quote}”, which this version does not have.", { slate: x.slate, quote: x.quote })}</span>
          {latest && <Button size="sm" busy={busy} onClick={() => void write(x.shotId, (bySlate.get(x.shotId)?.shot.spec.scriptLines ?? []).filter((q) => q !== x.quote))}>{t("Drop the quote")}</Button>}
        </div>
      ))}
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {preamble && sections.length > 0 && <p className="sc-song scr-lined-pre">{preamble}</p>}
      {(sections.length ? sections : [{ heading: "", body: preamble }]).map((sec, si) => {
        const scene = paired ? view.scenes[si] : undefined;
        const mine = scene ? shots.filter((s) => s.scene.id === scene.id) : [];
        const boardS = mine.reduce((n, s) => n + s.durationS, 0);
        const scriptS = "fromS" in sec && sec.fromS !== undefined && sec.toS !== undefined ? sec.toS - sec.fromS : undefined;
        const lines = cov.lines.filter((l) => l.section === si);
        const lanes = shots.filter((s) => lines.some((l) => l.shots.includes(s.shot.id)));
        const choices = [...mine, ...shots.filter((s) => !mine.includes(s))];
        return (
          <section key={si} className="scr-lined-sec">
            {sec.heading && (
              <div className="scr-lined-head">
                <span className="sc-slate">{si + 1}</span>
                <strong className="sc-song">{sec.heading}</strong>
                {scene && <span className="st-num">{t("script {script} · board {board} s", { script: scriptS !== undefined ? t("{n} s", { n: scriptS }) : t("no time"), board: boardS })}{scriptS !== undefined && scriptS !== boardS ? ` · ${boardS > scriptS ? "+" : "−"}${Math.abs(boardS - scriptS)} s` : ""}</span>}
              </div>
            )}
            <div className="lsr-rows" style={{ ["--lanes" as string]: Math.max(1, lanes.length) }}>
              {lines.map((l, li) => {
                const prev = lines[li - 1];
                return (
                  <div key={li} className="lsr-row" data-open={l.shots.length === 0 ? "true" : undefined}>
                    <div className="lsr-tram" aria-hidden="true">
                      {l.shots.length === 0 ? <span className="lsr-open-tram" /> : lanes.map((s) => (
                        <span key={s.shot.id} className="lsr-lane">
                          {l.shots.includes(s.shot.id) && <i />}
                          {l.shots.includes(s.shot.id) && !prev?.shots.includes(s.shot.id) && <b className="st-num">{s.slate}</b>}
                        </span>
                      ))}
                    </div>
                    <p className="sc-song lsr-text">{l.parts.map((part, pi) => (part.shots.length === 0 && l.shots.length > 0 ? <span key={pi} className="lsr-open" title={t("No shot shows this part")}>{part.text}</span> : <span key={pi}>{part.text}</span>))}</p>
                    <div className="lsr-act">
                      {l.shots.map((id) => {
                        const s = bySlate.get(id)!;
                        return (
                          <span key={id} className="lsr-shot">
                            <Link href={`${base}/board?shot=${id}`} className="st-num">{s.slate}</Link>
                            {latest && <button type="button" aria-label={t("Take this line off {slate}", { slate: s.slate })} title={t("Take this line off {slate}", { slate: s.slate })} disabled={busy} onClick={() => void unline(id, l.text)}>×</button>}
                          </span>
                        );
                      })}
                      {latest && (
                        <select className="st-select st-input--sm lsr-to" aria-label={t("Line this sentence to a shot")} value="" disabled={busy} onChange={(e) => { if (e.target.value) void lineTo(e.target.value, l.text); }}>
                          <option value="">{l.shots.length ? t("+ shot") : t("Line it to…")}</option>
                          {choices.filter((s) => !l.shots.includes(s.shot.id)).map((s) => <option key={s.shot.id} value={s.shot.id}>{s.slate} · {s.shot.spec.intent.slice(0, 48)}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {scene && mine.length > 0 && (
              <div className="scr-lined-shots">
                {mine.map((s) => {
                  const pic = shotPicture(s.shot);
                  const n = cov.lines.filter((x) => x.shots.includes(s.shot.id)).length;
                  return (
                    <Link key={s.shot.id} href={`${base}/board?shot=${s.shot.id}`} className="scr-lined-shot" title={s.shot.spec.intent} data-silent={n === 0 ? "true" : undefined}>
                      {pic ? <img src={pic} alt="" loading="lazy" /> : <span className="sc-frame-empty" />}
                      <span className="st-num"><b>{s.slate}</b> {s.durationS} s · {tc(s.startS)}<br />{n ? plural(t, n, "1 line", "{n} lines") : t("no line named")}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* What this version changed from the one before it, sentence by sentence. */
function Changes({ before, after }: { before?: Script; after: Script }) {
  const t = useT();
  if (!before) return <p className="st-muted">{t("This is the first version; there is nothing to compare it with.")}</p>;
  const parts = diffSentences(before.text, after.text);
  const added = parts.filter((p) => p.kind === "added" && p.text !== "\n").length;
  const removed = parts.filter((p) => p.kind === "removed" && p.text !== "\n").length;
  return (
    <div className="st-stack st-stack--tight">
      <span className="st-muted st-num">{t("v{a} against v{b}", { a: after.version, b: before.version })} · {plural(t, added, "1 passage added", "{n} passages added")}{t(" · {n} removed", { n: removed })}</span>
      <div className="sc-song scr-diff">
        {parts.map((p, i) => (p.text === "\n" ? <br key={i} /> : p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "added" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
      </div>
    </div>
  );
}

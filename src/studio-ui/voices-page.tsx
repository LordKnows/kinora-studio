"use client";

import { useCallback, useEffect, useState } from "react";

import type { VoiceCardInput } from "@/studio/schemas";
import type { Asset, VoiceCard } from "@/studio/types";

import { get, patch, post } from "./api";
import { Button, Empty, ErrorBanner, Field, Lamp, Loading, Modal, UploadButton, useAction } from "./common";
import { useT } from "./i18n";
import { PlusIcon } from "./icons";
import { useProjectContext } from "./shell";

/* The Design page's Voices tab: the voice cards this film can speak with.
   A card is a character's voice as one or more states (young, hoarse, an
   older self), each a sentence the model reads and the recordings that show
   it. Three things happen here: the cards are shown (the project's own and
   the library's, with their recordings to play), a card is imported from a
   description and a recording, and each character is given the card and the
   state it speaks in. Until now cards were only the director's to make. */

type State = VoiceCard["states"][number] & { refs: Asset[] };
type Card = Omit<VoiceCard, "states"> & { states: State[] };

/* what the upload takes (PresignRequest): MP3 and WAV */
const AUDIO = "audio/mpeg,audio/wav,audio/x-wav";

export function VoicesPage() {
  const t = useT();
  const { projectId, view, reload } = useProjectContext();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    setFailed(null);
    try {
      setCards((await get<{ voiceCards: Card[] }>(`/api/projects/${projectId}/voice-cards`)).voiceCards);
    } catch (caught) {
      setFailed(caught);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const characters = (view?.elements ?? []).filter((e) => e.kind === "character");
  /* a character is given a card and, on it, the state it speaks in; an empty card takes the voice away */
  const assign = useAction(async (_c, elementId: string, voiceCardId: string, voiceState?: string) => {
    await patch(`/api/elements/${elementId}`, { voiceCardId, voiceState: voiceState ?? "" });
    await reload();
  });

  return (
    <div className="st-page">
      <div className="st-page-head">
        <div>
          <h1 className="st-title">{t("Voices")}</h1>
          <p className="st-subtitle">{t("Voice cards: who speaks with which voice. A card's description goes into the prompt as written; its recordings are what the voice is matched to.")}</p>
        </div>
        <div className="st-actions">
          <Button kind="secondary" onClick={() => setImporting(true)}>
            <PlusIcon size={13} />
            {t("Import a voice card")}
          </Button>
        </div>
      </div>
      <ErrorBanner error={failed ?? assign.error} projectId={projectId} onDismiss={() => { setFailed(null); assign.dismiss(); }} />

      <section className="vc-part" aria-label={t("Who speaks with which")}>
        <div className="vc-part-head"><h2 className="st-h2">{t("Who speaks with which")}</h2><span className="st-num st-muted">{characters.length}</span></div>
        {characters.length === 0 ? (
          <p className="st-muted">{t("No characters yet. Add them on the Elements tab; each can then be given a voice here.")}</p>
        ) : (
          <div className="st-card st-card--pad0">
            <table className="st-table vc-cast">
              <thead><tr><th>{t("Character")}</th><th>{t("Voice card")}</th><th>{t("Speaks as||voice state")}</th><th>{t("Listen")}</th></tr></thead>
              <tbody>
                {characters.map((el) => {
                  const card = cards?.find((c) => c.id === el.voiceCardId);
                  const state = card?.states.find((s) => s.id === (el.voiceState || card.defaultState)) ?? card?.states[0];
                  return (
                    <tr key={el.id}>
                      <td><strong>{el.name}</strong></td>
                      <td>
                        <select className="st-select st-input--sm" aria-label={t("Voice card of {name}", { name: el.name })} value={el.voiceCardId ?? ""} disabled={!cards || assign.busy}
                          onChange={(e) => void assign.fire(el.id, e.target.value)}>
                          <option value="">{t("— no voice —")}</option>
                          {/* a card that was removed from view (another project's) still shows as chosen */}
                          {el.voiceCardId && !card && <option value={el.voiceCardId}>{el.voiceCardId}</option>}
                          {(cards ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.projectId === null ? t(" · library") : ""}</option>)}
                        </select>
                      </td>
                      <td>
                        {card && card.states.length > 1 ? (
                          <select className="st-select st-input--sm" aria-label={t("State {name} speaks in", { name: el.name })} value={state?.id ?? ""} disabled={assign.busy}
                            onChange={(e) => void assign.fire(el.id, card.id, e.target.value)}>
                            {card.states.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                          </select>
                        ) : (
                          <span className="st-muted">{state ? state.name || state.id : "—"}</span>
                        )}
                      </td>
                      <td>{state?.refs[0] ? <audio className="vc-audio" controls preload="none" src={state.refs[0].url} /> : <span className="st-muted">{card ? t("no recording") : "—"}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="vc-part" aria-label={t("Voice cards")}>
        <div className="vc-part-head"><h2 className="st-h2">{t("Voice cards")}</h2>{cards && <span className="st-num st-muted">{cards.length}</span>}</div>
        {!cards ? (
          failed ? <Button size="sm" onClick={() => void load()}>{t("Try again")}</Button> : <Loading big />
        ) : cards.length === 0 ? (
          <Empty title={t("No voice cards yet")} hint={t("Import one from a description and a recording, or ask the director to make one.")} />
        ) : (
          <div className="vc-cards">
            {cards.map((c) => {
              const usedBy = characters.filter((e) => e.voiceCardId === c.id);
              return (
                <article key={c.id} className="st-card st-stack st-stack--tight vc-card">
                  <div className="st-row st-row--between">
                    <strong className="vc-name">{c.name}</strong>
                    <span className="st-row">
                      <Lamp state={c.status === "locked" ? "ok" : c.status === "auditioning" ? "warn" : "draft"} label={t(`${c.status}||voice card status`)} />
                      <span className="st-chip">{c.projectId === null ? t("Library||voice cards") : t("This project")}</span>
                    </span>
                  </div>
                  <span className="st-muted">{usedBy.length ? t("Spoken by {names}", { names: usedBy.map((e) => e.name).join(", ") }) : t("No character of this film speaks with it yet.")}</span>
                  {c.states.map((s) => (
                    <div key={s.id} className="vc-state">
                      <div className="st-row"><strong>{s.name || s.id}</strong>{c.states.length > 1 && (c.defaultState ?? c.states[0]!.id) === s.id && <span className="st-chip">{t("default||voice state")}</span>}</div>
                      <p className="vc-says">{s.description}</p>
                      {s.refs.length === 0 ? <span className="st-muted">{t("no recording")}</span> : s.refs.map((a) => <audio key={a.id} className="vc-audio" controls preload="none" src={a.url} title={a.name ?? undefined} />)}
                    </div>
                  ))}
                  {c.source && <span className="st-muted">{t("Source: {kind}", { kind: t(`${c.source.kind}||voice source`) })}{c.source.detail ? ` · ${c.source.detail}` : ""}</span>}
                  {c.notes && <span className="st-muted">{c.notes}</span>}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {importing && <ImportCard characters={characters.map((e) => ({ id: e.id, name: e.name }))} onClose={() => setImporting(false)} onDone={async () => { setImporting(false); await load(); await reload(); }} />}
    </div>
  );
}

/* A new card for this project, from what the voice is like and, when there is one, a recording of it.
   A recording is someone's voice: the form asks whose it is before it will keep one. */
function ImportCard({ characters, onClose, onDone }: { characters: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => Promise<void> }) {
  const t = useT();
  const { projectId } = useProjectContext();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audio, setAudio] = useState<{ assetId: string; url: string } | null>(null);
  const [kind, setKind] = useState<"synthetic" | "licensed" | "recorded">("synthetic");
  const [detail, setDetail] = useState("");
  const [forElement, setForElement] = useState("");
  const save = useAction(async () => {
    const card: VoiceCardInput = {
      name: name.trim(), status: "draft",
      states: [{ id: "base", name: "Base", description: description.trim(), refAssetIds: audio ? [audio.assetId] : [], apiVoices: [] }],
      ...(detail.trim() ? { source: { kind, detail: detail.trim() } } : {}),
    };
    const { voiceCard } = await post<{ voiceCard: VoiceCard }>(`/api/projects/${projectId}/voice-cards`, card);
    if (forElement) await patch(`/api/elements/${forElement}`, { voiceCardId: voiceCard.id, voiceState: "" });
    await onDone();
  });
  const missing = !name.trim() ? t("Give the card a name.") : description.trim().length < 10 ? t("Describe the voice in a sentence.") : audio && !detail.trim() ? t("Say whose voice the recording is and why it may be used.") : null;
  return (
    <Modal title={t("Import a voice card")} onClose={onClose}>
      <form className="st-stack" onSubmit={(e) => { e.preventDefault(); if (!missing) void save.fire(); }}>
        <Field label={t("Name")} hint={t("Usually the character's name.")}>
          <input className="st-input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("The voice, in one English sentence")} hint={t("Gender, age, pitch, timbre, pace, accent, usual mood. It goes into the prompt as written.")}>
          <textarea className="st-textarea" rows={2} maxLength={400} placeholder="A woman in her thirties, low and dry, unhurried, a faint northern accent, wry" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t("Recording (optional)")} hint={t("MP3 or WAV: 10 to 15 seconds of the voice alone, no music. Only a voice you may use: synthetic, licensed, or a performer who agreed.")} group>
          <div className="st-row">
            <UploadButton accept={AUDIO} projectId={projectId} label={audio ? "Replace the recording" : "Upload a recording"} onUploaded={(a) => setAudio(a)} />
            {audio && <audio className="vc-audio" controls preload="none" src={audio.url} />}
            {audio && <Button size="sm" kind="quiet" onClick={() => setAudio(null)}>{t("Remove")}</Button>}
          </div>
        </Field>
        <div className="st-fields">
          <Field label={t("Whose voice it is")}>
            <select className="st-select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="synthetic">{t("synthetic||voice source")}</option>
              <option value="licensed">{t("licensed||voice source")}</option>
              <option value="recorded">{t("recorded||voice source")}</option>
            </select>
          </Field>
          <Field label={t("Where it comes from")} hint={t("The model and prompt, the library and licence, or the performer and their consent.")}>
            <input className="st-input" maxLength={500} value={detail} onChange={(e) => setDetail(e.target.value)} />
          </Field>
        </div>
        {characters.length > 0 && (
          <Field label={t("Give it to (optional)")}>
            <select className="st-select" value={forElement} onChange={(e) => setForElement(e.target.value)}>
              <option value="">{t("— nobody yet —")}</option>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <ErrorBanner error={save.error} projectId={projectId} onDismiss={save.dismiss} />
        <div className="st-row st-row--between">
          <span className="st-muted">{missing ?? ""}</span>
          <span className="st-row">
            <Button kind="quiet" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" kind="primary" busy={save.busy} disabled={Boolean(missing)}>{t("Import")}</Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}

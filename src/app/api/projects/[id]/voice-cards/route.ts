import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { VoiceCardInput } from "@/studio/schemas";

/* The voice cards a project can use: its own and the global library's, each state with its reference
   audio. POST makes a card in this project (the Design page's Voices tab imports one from a
   description and a recording); a card for every project is made in the library by the director. */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  await repo.getProject(params.id!);
  const cards = await repo.listVoiceCards(params.id!, true);
  const audio = await repo.getAssets(cards.flatMap((c) => c.states.flatMap((st) => st.refAssetIds)));
  return { voiceCards: cards.map((c) => ({ ...c, states: c.states.map((st) => ({ ...st, refs: st.refAssetIds.map((a) => audio.get(a)).filter(Boolean) })) })) };
});

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  return { voiceCard: await repo.createVoiceCard(params.id!, await body(req, VoiceCardInput)) };
});

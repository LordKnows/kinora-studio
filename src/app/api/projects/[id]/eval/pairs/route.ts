import { route } from "@/api/http";
import * as repo from "@/studio/repo";

/* Two completed takes of the same shot, in random order, for blind scoring. */
export const GET = route(["web"], async (_req, { params }) => {
  const takes = (await repo.listProjectTakes(params.id!)).filter((t) => t.status === "completed" && t.resultUrl);
  const byShot = new Map<string, typeof takes>();
  for (const t of takes) byShot.set(t.shotId, [...(byShot.get(t.shotId) ?? []), t]);
  const candidates = [...byShot.values()].filter((list) => list.length >= 2);
  if (candidates.length === 0) return { pair: null };
  const list = candidates[Math.floor(Math.random() * candidates.length)]!;
  const i = Math.floor(Math.random() * list.length);
  let j = Math.floor(Math.random() * (list.length - 1));
  if (j >= i) j++;
  const [a, b] = Math.random() < 0.5 ? [list[i]!, list[j]!] : [list[j]!, list[i]!];
  const shot = await repo.getShot(a.shotId);
  return { pair: { shotId: shot.id, intent: shot.spec.intent, a: { id: a.id, url: a.resultUrl }, b: { id: b.id, url: b.resultUrl } } };
});

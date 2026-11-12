import { redirect } from "next/navigation";

/* Finals moved into the Cut: the full-resolution pass sits in its export panel. */
export default async function FinalsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/p/${id}/timeline`);
}

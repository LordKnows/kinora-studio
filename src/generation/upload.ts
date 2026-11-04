/* Browser → R2 direct upload: ask the studio for a presigned PUT, send the
   bytes straight to the bucket, then commit so an Asset row exists. */

export async function uploadMedia(file: File, projectId?: string): Promise<{ url: string; assetId: string }> {
  const presign = await fetch("/api/uploads/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
  });
  if (!presign.ok) throw new Error(await errorText(presign, "Failed to get an upload URL"));
  const { url, key } = (await presign.json()) as { url: string; key: string };
  const put = await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file });
  if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);
  const commit = await fetch("/api/uploads/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, kind: file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image", projectId }),
  });
  if (!commit.ok) throw new Error(await errorText(commit, "Failed to record the upload"));
  const { asset } = (await commit.json()) as { asset: { id: string; url: string } };
  return { url: asset.url, assetId: asset.id };
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

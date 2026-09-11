// --- ATTACHMENTS — Card/job file uploads go to R2 (the same
// BACKUP_BUCKET, under an attachments/ prefix) instead of inline base64
// in the synced data, which would otherwise bloat the Durable Object's
// storage and every snapshot broadcast. The key prefix check on
// download/delete matters: it's what stops these endpoints from being
// used to read/delete backup files out of the same shared bucket.
//
// isSafeInlineImageType() is the one thing standing between an uploader
// and stored XSS: handleAttachmentDownload() serves attacker-controlled
// bytes back to every other teammate who opens the file, so nothing that
// could render/execute as a document (HTML, SVG with embedded <script>,
// anything else) is ever allowed to come back as Content-Disposition:
// inline. Deliberately matches the client's own isImage heuristic
// (file.type.startsWith('image/'), see index.html's attachment upload)
// minus svg+xml, rather than an arbitrary allowlist, so real photo
// attachments keep rendering as thumbnails exactly as before.
import { jsonResponse } from './http.ts';
import { resolveIdentityFromToken, resolveCaller } from './users.ts';

export function isSafeInlineImageType(type: unknown): boolean {
  return typeof type === "string" && type.indexOf("image/") === 0 && type !== "image/svg+xml";
}

export async function handleAttachmentUpload(request: Request, env: Env, corsHeaders: Record<string, string>, url: URL): Promise<Response> {
  // Credentials via headers, not query params — this request's body IS
  // the raw file (streamed straight into R2 below), so there's no JSON
  // body to put them in the way every other POST endpoint does, and a
  // query string would land in Worker access logs like the backup
  // endpoints used to.
  const identity = await resolveIdentityFromToken(env, request.headers.get("X-Aps-Token"));
  if (!identity) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const name = url.searchParams.get("name") || "file";
  // The uploader's claimed type is never trusted beyond the inline-image
  // check above — anything else is stored as a generic byte stream, which
  // handleAttachmentDownload() below always forces to download rather
  // than render, regardless of what a future upload claims to be.
  const claimedType = url.searchParams.get("type") || "";
  const storedType = isSafeInlineImageType(claimedType) ? claimedType : "application/octet-stream";
  const dotIdx = name.lastIndexOf(".");
  const ext = dotIdx > -1 ? name.slice(dotIdx) : "";
  const key = "attachments/" + crypto.randomUUID() + ext;

  await env.BACKUP_BUCKET.put(key, request.body, { httpMetadata: { contentType: storedType } });
  return jsonResponse({ key, name }, 200, corsHeaders);
}

export async function handleAttachmentDownload(request: Request, env: Env, corsHeaders: Record<string, string>, url: URL): Promise<Response> {
  const identity = await resolveIdentityFromToken(env, url.searchParams.get("token"));
  if (!identity) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("attachments/")) return new Response("Bad request", { status: 400, headers: corsHeaders });

  const obj = await env.BACKUP_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders });

  const storedType = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  return new Response(obj.body, {
    headers: Object.assign({}, corsHeaders, {
      "Content-Type": storedType,
      "X-Content-Type-Options": "nosniff",
      // Only ever render inline for the same narrow image check enforced
      // at upload time — everything else downloads instead of executing,
      // no matter what content-type ended up stored.
      "Content-Disposition": isSafeInlineImageType(storedType) ? "inline" : "attachment"
    })
  });
}

export async function handleAttachmentDelete(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; key?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const identity = await resolveCaller(env, body);
  if (!identity) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const key = body.key || "";
  if (!key.startsWith("attachments/")) return jsonResponse({ error: "Bad key" }, 400, corsHeaders);

  await env.BACKUP_BUCKET.delete(key);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

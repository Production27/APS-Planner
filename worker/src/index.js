// ==========================================
// APS Planner — Worker (Durable Objects backend) — entry point
// LIVE — this is what's actually deployed at aps-planner-staging
// (confirmed via `wrangler deployments list` against this file's own git
// history). This directory (worker/src/) is the sole source of truth for
// everything in it — the old pre-migration Liveblocks-based worker, its
// README, and a set of design-iteration reference files this used to
// point readers to were all removed in commit a4da847 ("Remove stale
// unused worker reference files"); deploys go through wrangler.jsonc's
// wrangler-based pipeline.
// ==========================================
//
// Replaces Liveblocks entirely with a single Durable Object (ApsRoom,
// defined in room-do.js and re-exported below). Cloudflare requires a
// Durable Object's class to live in the same DEPLOYED script as the
// binding that references it — but that's a bundling requirement, not a
// source-file one: wrangler bundles a Worker's local ES module imports
// into one script automatically (confirmed via Cloudflare's own Durable
// Objects docs). This file is just the URL router — see the git log for
// the rest of the worker split's history, and the sibling files in this
// directory for every other piece. users.js is carried over byte-for-byte
// unchanged from aps-liveblocks-worker.js — confirmed independent of
// Liveblocks by exploration before this migration started.
//
// Bindings this worker needs (configured in wrangler.jsonc/the dashboard):
//   APS_ROOM        Durable Object namespace, class name "ApsRoom",
//                    pointing at this same script.
//   ROOM_TOKEN_SECRET  Secret (Settings -> Variables and Secrets) — any
//                    long random string, used to sign/verify room
//                    connection tokens. Generate once, never reuse
//                    TEAM_PASSWORD or LIVEBLOCKS_SECRET_KEY for this.
//   BACKUP_BUCKET, USERS_KV, TEAM_PASSWORD — reused as-is from the
//                    original Liveblocks-era worker.
//
// Attachments (card/job file uploads) live in R2 under an attachments/
// prefix in the SAME BACKUP_BUCKET, rather than inline base64 in the
// synced data — see attachments.js. This was a late addition to the
// original Liveblocks migration, decided after noticing the original
// design (one JSON blob per room, broadcast on every change) would
// otherwise grow unboundedly with every photo/PDF someone attaches.

import { getRoomStub } from './room-stub.js';
import { handleAuth } from './auth.js';
import { runBackup, handleTriggerBackup, handleListBackups, handleDownloadBackup, handleRestoreBackup } from './backup.js';
import {
  handleUsersList, handleUsersRoster, handleUsersAdd,
  handleUsersUpdate, handleUsersRemove, handleUsersResetPassword
} from './users-admin.js';
import { handleAttachmentUpload, handleAttachmentDownload, handleAttachmentDelete } from './attachments.js';
import { handleReportError, handleErrorsList } from './errors.js';
export { ApsRoom } from './room-do.js';

// --- WORKER ENTRYPOINTS ---
export default {
  async scheduled(controller, env, ctx) {
    await runBackup(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      // X-Aps-Token — attachment upload sends the session token as a
      // header instead of a query param (its POST body is the raw file
      // bytes, not JSON, so there's no body field to put it in) — see
      // handleAttachmentUpload().
      "Access-Control-Allow-Headers": "Content-Type, X-Aps-Token",
      "Cache-Control": "no-store",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Realtime room connection — the client opens a WebSocket here with
    // ?token=... (minted by POST / below). Auth is checked by the
    // Durable Object itself on upgrade, not here; this just routes to
    // the one shared room instance.
    if (url.pathname === "/room" && request.headers.get("Upgrade") === "websocket") {
      return getRoomStub(env).fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/auth") {
      return handleAuth(request, env, corsHeaders, ctx);
    }

    if (url.pathname === "/trigger-backup" && request.method === "POST") {
      return handleTriggerBackup(request, env, corsHeaders);
    }
    if (url.pathname === "/list-backups" && request.method === "POST") {
      return handleListBackups(request, env, corsHeaders);
    }
    // POST-only, credentials in the JSON body — was GET with
    // username/password/key as query params, which lands verbatim in
    // Worker access logs on every download. The client now fetch()es this
    // (instead of window.open(), which can't send a POST body) and turns
    // the response into a local download itself.
    if (url.pathname === "/download-backup" && request.method === "POST") {
      return handleDownloadBackup(request, env, corsHeaders);
    }
    // Same reasoning as /download-backup above — POST + JSON body instead
    // of the admin password sitting in a GET query string.
    if (url.pathname === "/restore-backup" && request.method === "POST") {
      return handleRestoreBackup(request, env, corsHeaders);
    }

    if (url.pathname === "/users/list" && request.method === "POST") {
      return handleUsersList(request, env, corsHeaders);
    }
    if (url.pathname === "/users/roster" && request.method === "POST") {
      return handleUsersRoster(request, env, corsHeaders);
    }
    if (url.pathname === "/users/add" && request.method === "POST") {
      return handleUsersAdd(request, env, corsHeaders);
    }
    if (url.pathname === "/users/update" && request.method === "POST") {
      return handleUsersUpdate(request, env, corsHeaders);
    }
    if (url.pathname === "/users/remove" && request.method === "POST") {
      return handleUsersRemove(request, env, corsHeaders);
    }
    if (url.pathname === "/users/reset-password" && request.method === "POST") {
      return handleUsersResetPassword(request, env, corsHeaders);
    }

    if (url.pathname === "/report-error" && request.method === "POST") {
      return handleReportError(request, env, corsHeaders);
    }
    if (url.pathname === "/errors/list" && request.method === "POST") {
      return handleErrorsList(request, env, corsHeaders);
    }

    if (url.pathname === "/attachments/upload" && request.method === "POST") {
      return handleAttachmentUpload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/download") {
      return handleAttachmentDownload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/delete" && request.method === "POST") {
      return handleAttachmentDelete(request, env, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

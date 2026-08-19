# APS Planner Worker

Backend for the Liveblocks auth handoff, scheduled/manual backups, restore,
and per-user accounts. Deployed at
`https://lucky-snow-8179.production-db3.workers.dev/`.

## Deploy process

No build step, no wrangler — this is hand-pasted into the Cloudflare
dashboard:

1. Cloudflare dashboard → **Workers & Pages** → the worker
2. **Edit Code** (or "Quick Edit")
3. Select all, paste in the full contents of `aps-liveblocks-worker.js`
4. **Deploy**

`aps-liveblocks-worker.js` in this directory should always match what's
actually live — when the dashboard code changes, update this file in the
same commit so the two never drift.

## Bindings required

- **`BACKUP_BUCKET`** — R2 bucket, stores JSON backups under `backups/`.
- **`USERS_KV`** — KV namespace, stores per-user accounts
  (`user:<username>` → `{username, displayName, role, passwordHash, salt, createdAt}`).

## Secrets required

Set as **Secret** type (not plain text) under Settings → Variables and Secrets:

- **`TEAM_PASSWORD`** — legacy shared password; still works as a
  break-glass admin login (see `resolveIdentity()`), and is what the
  Backups modal in the app authenticates with directly.
- **`LIVEBLOCKS_SECRET_KEY`** — `sk_prod_...` from the Liveblocks
  dashboard (Project settings → API keys). Never put this in the HTML
  file — only here.

## Cron

Scheduled trigger runs `runBackup()` every 6 hours (configured in the
dashboard's Cron Triggers tab, not in code).

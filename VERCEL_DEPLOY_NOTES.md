# Vercel Deploy Notes — CoC Attack Tracker

## What changed

1. Header/navbar: one clean row on desktop (brand · nav links · clock+sync+refresh+settings),
   mobile bottom tab bar + compact status line, sticky header no longer hides content.
2. "Refresh now" syncs live data with no key anywhere: POST /api/refresh runs a
   full CoC sync when the last recorded sync is older than
   AUTO_SYNC_COOLDOWN_MIN (default 30) and otherwise returns the cached rows.
   A forced instant sync is shift/ctrl/cmd-click or the ⚙ gear, which use
   POST /api/sync with X-Admin-Key. Viewers never see an admin-key prompt.
3. Client-side auto-refresh every 5 minutes. It calls the same key-free
   endpoint; the server decides whether a sync is due, so the schedule is
   server-side and identical for every browser. Pauses when the tab is hidden,
   refreshes on return, cleans up on unload. This replaces the
   AUTO_SYNC_MINUTES background thread, which cannot run under serverless.
4. vercel.json declares a daily Vercel Cron job: `0 16 * * *` UTC (midnight
   Philippines). The Vercel **Hobby** plan rejects schedules that run more
   than once per day at deploy time, which is why the earlier every-30-min
   schedule was replaced. Cron endpoint logs whether it succeeded.

## Production refresh cadence

Nothing manual is needed any more — no key in the browser, no env change:

1. **Vercel Cron** — daily at midnight PH, runs with no browser open.
2. **`POST /api/refresh`** — the "Refresh now" button and the 5-minute
   auto-refresh call this. It runs one full CoC sync when the last recorded
   sync (durable `sync_log` row) is older than `AUTO_SYNC_COOLDOWN_MIN`
   (default 30) and otherwise returns the cached rows, which are never more
   than one cooldown old. Identical for every browser; the cooldown is
   server-side, so traffic cannot amplify CoC API usage beyond one sync per
   window. Failed attempts back off 5 minutes per process.
3. **Forced sync (owner only)** — shift/ctrl/cmd-click, or the ⚙ settings
   dialog, uses `POST /api/sync` with `X-Admin-Key`, which always runs.

For a guaranteed 30-minute *server-side* cadence with no browser open, the
Hobby plan is still not enough: upgrade to Pro (cron `*/30 * * * *`) or point a
free external pinger at `https://<project>.vercel.app/api/cron-sync` with
`Authorization: Bearer $CRON_SECRET`. Nothing else changes — the endpoint
already accepts Vercel's bearer format.

## Env vars to set/change on Vercel

- CRON_SECRET — new. Pick a secret; the cron job sends `Authorization: Bearer <CRON_SECRET>`.
- TZ=Asia/Manila — recommended so daily records bucket at PH midnight (the header warns if missing).
- COC_API_TOKEN, CLAN_TAG, CLAN_NAME, DATABASE_URL, ADMIN_KEY — already needed; confirm they're set.
- AUTO_SYNC_MINUTES — keep at 30 (local only; Vercel uses the cron job).
- ALLOW_LOCAL_SYNC=1 — fine for local; on Vercel only the cron secret matters for sync.
- AUTO_SYNC_COOLDOWN_MIN — optional, defaults to 30. Minimum age of the last
  sync before a viewer's refresh triggers a new one. Raise it to trim CoC API
  usage, lower it for fresher data (each window is at most one sync).

## How to confirm the sync is working

1. Deploy. Open the site and click **Refresh now**:
   - within the cooldown → "Data is up to date (synced within the last 30 min)."
   - after the cooldown → "Sync complete: members: …" with real numbers.
2. Vercel dashboard > Project > Cron Jobs — the job is listed as Enabled, with
   a "Run" button for a manual invocation.
3. Vercel dashboard > Project > Logs — filter by `api/cron-sync`. Look for
   `cron-sync ok: ...` or `cron-sync failed: ...`.
4. Visit https://<project>.vercel.app/api/status — `last_sync` and `recent`
   come from the durable sync_log, so they show the real last sync regardless
   of which serverless instance answers. `last_attempt` is in-memory and may
   be empty on a cold instance (that field is only there to explain failures
   when the database itself is down).

## Vercel cron limits

- Cron jobs only run on **production deployments** (preview deployments don't
  run crons), and Vercel does **not** retry failed cron invocations — check the
  function logs / `/api/status` instead.
- Official plan limits (vercel.com/docs/cron-jobs): the **Hobby** plan only
  allows schedules that run **once per day** — a more frequent expression such
  as `*/30 * * * *` fails at **deploy time** with "Hobby accounts are limited
  to daily cron jobs". **Pro** (and Enterprise) allow per-minute schedules.
- This project deploys `0 16 * * *` (once per day, midnight PH). The Hobby
  plan **enforces** the daily limit at deploy time: pushing `*/30 * * * *`
  fails deployment creation with `cron_jobs_limits_reached` (observed
  2026-10-11). If the plan is ever upgraded to Pro, the schedule can be
  changed back to `*/30 * * * *`.
- Cron runs are counted as function invocations. Very frequent cron + heavy
  sync can hit function-duration / invocation limits.
- Fallback if Vercel Cron is ever unusable: an external pinger such as
  cron-job.org hitting https://<project>.vercel.app/api/cron-sync
  with header `Authorization: Bearer <CRON_SECRET>`.

## CoC API IP whitelist (the 403 problem)

Supercell pins each API key to whitelisted IPs. Vercel serverless IPs rotate.
If cron sync returns 403:
- Check https://<project>.vercel.app/api/diagnostics?fresh=1 for
  "CoC API: 403 / accessDenied.invalidIp".
- Fix: whitelist Vercel's current egress IPs in the CoC developer portal, OR run
  `python scripts/refresh_key.py` from a machine whose IP you control (needs
  COC_DEV_EMAIL + COC_DEV_PASSWORD in .env; rewrites COC_API_TOKEN), OR route
  CoC API calls through a static-IP proxy.
- A proxy is the most reliable long-term fix for Vercel because egress IPs change.

## Admin key safety

- ADMIN_KEY is never embedded in client-side code or any NEXT_PUBLIC_/VITE_ variable.
- It lives only in Vercel env vars and (opt-in) in the visitor's browser localStorage
  after they open ⚙ and save it.
- Read endpoints (/api/clan, /api/members, /api/wars, /api/capital, /api/current-war,
  /api/status, /api/contributions, /api/capital/participation, etc.) are public.
- Write endpoints (/api/sync, /api/notes) require X-Admin-Key.
- /api/cron-sync accepts either X-Admin-Key or Authorization: Bearer <CRON_SECRET>.

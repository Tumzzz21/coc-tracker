# Vercel Deploy Notes — CoC Attack Tracker

## What changed

1. Header/navbar: one clean row on desktop (brand · nav links · clock+sync+refresh+settings),
   mobile bottom tab bar + compact status line, sticky header no longer hides content.
2. Viewers no longer see an admin-key prompt. "Refresh now" now **syncs live data** whenever
   this browser has ADMIN_KEY saved (the key dialog opens if not); without a key it still
   shows cached data, and shift/ctrl-click forces the real-sync path.
3. Client-side auto-refresh every 5 minutes. Browsers with ADMIN_KEY saved pull live data
   at most once every 30 minutes (throttled via localStorage); others re-read the cache.
   Pauses when the tab is hidden, refreshes on return, cleans up on unload. This replaces
   the AUTO_SYNC_MINUTES background thread, which cannot run under serverless.
4. vercel.json declares a daily Vercel Cron job: `0 16 * * *` UTC (midnight
   Philippines). The Vercel **Hobby** plan rejects schedules that run more
   than once per day at deploy time, which is why the earlier every-30-min
   schedule was replaced. Cron endpoint logs whether it succeeded.

## Production refresh cadence

Three autoscale paths now keep data moving, in order of independence:

1. **Vercel Cron** — daily at midnight PH. Runs with no browser open.
2. **Owner browser** — with ADMIN_KEY saved, opening the page or any 5-minute
   auto-refresh syncs live data (max one real sync per 30 min).
3. **Owner click** — "Refresh now" syncs immediately.

For a guaranteed 30-minute server-side cadence, the Hobby plan is not enough:
either upgrade to Pro (cron `*/30 * * * *`) or point a free external pinger at
`https://<project>.vercel.app/api/cron-sync` with `Authorization: Bearer $CRON_SECRET`.
Nothing else changes — `/api/cron-sync` already accepts Vercel's bearer format.

## Env vars to set/change on Vercel

- CRON_SECRET — new. Pick a secret; the cron job sends `Authorization: Bearer <CRON_SECRET>`.
- TZ=Asia/Manila — recommended so daily records bucket at PH midnight (the header warns if missing).
- COC_API_TOKEN, CLAN_TAG, CLAN_NAME, DATABASE_URL, ADMIN_KEY — already needed; confirm they're set.
- AUTO_SYNC_MINUTES — keep at 30 (local only; Vercel uses the cron job).
- ALLOW_LOCAL_SYNC=1 — fine for local; on Vercel only the cron secret matters for sync.

## How to confirm the cron is working

1. Deploy. Wait for the next 16:00 UTC mark (midnight PH), or trigger it
   manually: Vercel dashboard > Project > Cron Jobs > "Run" button.
2. Open Vercel dashboard > Project > Cron Jobs — you should see runs scheduled.
3. Open Vercel dashboard > Project > Logs — filter by `api/cron-sync`. Look for lines like:
   `cron-sync ok: ...` or `cron-sync failed: ...`.
4. Visit https://<project>.vercel.app/api/status - "auto-sync by Vercel Cron" should show,
   and "last:" should update once a day (after 16:00 UTC).

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

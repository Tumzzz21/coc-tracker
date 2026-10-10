# Vercel Deploy Notes — CoC Attack Tracker

## What changed

1. Header/navbar: one clean row on desktop (brand · nav links · clock+sync+refresh+settings),
   mobile bottom tab bar + compact status line, sticky header no longer hides content.
2. Viewers no longer see an admin-key prompt. The "Refresh now" button uses the public
   POST /api/refresh endpoint (cached data, server-side 60s cooldown, no key).
   Real sync still needs ADMIN_KEY (shift/ctrl-click "Refresh now", or the ⚙ gear icon).
3. Client-side auto-refresh every 5 minutes from the app's own cached API (not the CoC API),
   pauses when the tab is hidden, refreshes on return, cleans up on unload.
4. vercel.json cron schedule changed from "0 5 * * *" (daily 5am) to "*/30 * * * *"
   (every 30 minutes). Cron endpoint now logs whether it succeeded.

## Env vars to set/change on Vercel

- CRON_SECRET — new. Pick a secret; the cron job sends `Authorization: Bearer <CRON_SECRET>`.
- TZ=Asia/Manila — recommended so daily records bucket at PH midnight (the header warns if missing).
- COC_API_TOKEN, CLAN_TAG, CLAN_NAME, DATABASE_URL, ADMIN_KEY — already needed; confirm they're set.
- AUTO_SYNC_MINUTES — keep at 30 (local only; Vercel uses the cron job).
- ALLOW_LOCAL_SYNC=1 — fine for local; on Vercel only the cron secret matters for sync.

## How to confirm the cron is working

1. Deploy. Wait for the next 30-min mark.
2. Open Vercel dashboard > Project > Cron Jobs — you should see runs scheduled.
3. Open Vercel dashboard > Project > Logs — filter by `api/cron-sync`. Look for lines like:
   `cron-sync ok: ...` or `cron-sync failed: ...`.
4. Visit https://<project>.vercel.app/api/status — "auto-sync by Vercel Cron" should show,
   and "last:" should update every ~30 min.

## Vercel cron limits

- Cron jobs only run on **production deployments** (preview deployments don't
  run crons), and Vercel does **not** retry failed cron invocations — check the
  function logs / `/api/status` instead.
- Official plan limits (vercel.com/docs/cron-jobs): the **Hobby** plan only
  allows schedules that run **once per day** — a more frequent expression such
  as `*/30 * * * *` fails at **deploy time** with "Hobby accounts are limited
  to daily cron jobs". **Pro** (and Enterprise) allow per-minute schedules.
- This project deploys `*/30 * * * *` (every 30 min) and has already deployed
  that exact `crons` block successfully in production, so the current plan
  accepts it. If a deploy ever fails with the daily-limit error, either change
  the schedule to once daily (e.g. `"0 12 * * *"`) or move to a plan that
  allows frequent crons.
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

# Cron Sync Migration: Vercel Cron → GitHub Actions

## Why this change

Vercel Hobby does not support the frequent cron schedule this app needs
(`*/30 * * * *` — every 30 minutes). The existing `vercel.json` no longer
contains a `crons` block, so Vercel will no longer try to run or validate a
Vercel Cron job for `/api/cron-sync`.

The server-side sync now runs on a **GitHub Actions scheduled workflow** instead.

## What changed

- `vercel.json` — the `crons` block was removed. All other settings (builds,
  routes) are unchanged.
- `.github/workflows/cron-sync.yml` — new workflow that calls the production
  `/api/cron-sync` endpoint every 30 minutes (UTC) and supports manual dispatch.

The application code is otherwise unchanged:

- `/api/cron-sync` still requires authentication — either the admin key
  (`X-Admin-Key`) or the `CRON_SECRET` Bearer token.
- The browser auto-refresh / auto-sync UI in `static/js/main.js` is untouched.
- Local development auto-sync (when `ALLOW_LOCAL_SYNC` and `AUTO_SYNC_MINUTES`
  are configured) continues to work as before.

## How the replacement works

The workflow calls:

```
GET https://<PRODUCTION_URL>/api/cron-sync
Authorization: Bearer <CRON_SECRET>
```

If the HTTP response is successful (2xx), the workflow logs success and exits
cleanly. If the request fails (connection error, non-2xx response, timeout),
the workflow fails and logs the HTTP status and response body.

The log output prints the HTTP status and the response body, but it does **not**
print the `CRON_SECRET` value or the full Authorization header.

## Required configuration

### 1. GitHub Actions secret: `CRON_SECRET`

This must be the same value used by the app's `CRON_SECRET` environment
variable.

Add it under:

**GitHub repo → Settings → Secrets and variables → Actions → Secrets → New repository secret**

- Name: `CRON_SECRET`
- Value: the same secret string configured in the app's environment

Do not put this value in the workflow file, repository variables, or source
code. It stays in GitHub's secret store and is only injected at runtime.

### 2. GitHub repository variable: `PRODUCTION_URL`

This is a repository **variable** (not a secret) holding the production Vercel
URL, without a trailing slash.

Add it under:

**GitHub repo → Settings → Secrets and variables → Actions → Variables → New repository variable**

- Name: `PRODUCTION_URL`
- Value: e.g. `https://your-project.vercel.app`

If you would rather keep the URL in a secret, you can store it as a secret
named `PRODUCTION_URL_SECRET` and update the workflow to read
`${{ secrets.PRODUCTION_URL_SECRET }}` instead of `${{ vars.PRODUCTION_URL }}`.

## Schedule

The workflow runs on:

```yaml
schedule:
  - cron: '*/30 * * * *'
```

That is every 30 minutes, UTC.

A few practical notes:

- GitHub scheduled workflows run on UTC time.
- GitHub can delay scheduled runs. Short delays (a few minutes) are common;
  longer delays can happen during high load or service issues.
- Because of that, treat the schedule as "about every 30 minutes", not as an
  exact clock trigger.

## Manual runs

You can run the workflow manually at any time:

1. Open the repo on GitHub.
2. Go to the **Actions** tab.
3. Select **CoC Attack Tracker — Cron Sync**.
4. Click **Run workflow**.
5. Click the red **Run workflow** button to confirm.

Manual runs use the same secrets and repository variables as the scheduled
runs, so they hit the same production `/api/cron-sync` endpoint with the same
authentication.

## Current auth behavior on /api/cron-sync

The endpoint still accepts two valid auth paths:

1. **Admin key** — `X-Admin-Key` header with the app's `ADMIN_KEY` value.
2. **Cron secret** — `Authorization: Bearer <CRON_SECRET>`.

The GitHub Actions workflow uses the second path only. Nothing about the
endpoint's auth logic was changed, weakened, or made public.

## Verifying the change

Before deploying, confirm:

- `vercel.json` has no `crons` block.
- `.github/workflows/cron-sync.yml` is valid YAML and targets
  `/api/cron-sync`.
- The workflow uses `${{ secrets.CRON_SECRET }}` for auth.
- No secret value appears in the workflow file or source files.
- `/api/cron-sync` still returns `401 Unauthorized` without a valid token.
- The app still compiles/runs locally.

## If the workflow fails

Common causes:

- `PRODUCTION_URL` is missing, empty, or has a trailing slash.
- `CRON_SECRET` is missing, empty, or does not match the app's configured
  `CRON_SECRET`.
- The production deployment is not live at the configured URL.
- The `/api/cron-sync` call failed server-side (check app logs).

The workflow prints the HTTP status and response body on failure, which should
help narrow it down without exposing the secret.

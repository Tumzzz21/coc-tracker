# CoC Attack Tracker — Product Requirements Document

**Product:** Clash of Clans Attack Tracker
**Document status:** Approved for v1
**Version:** 1.1
**Date:** 2026-09-20
**Platform:** Web app (Flask + HTML/CSS/vanilla JS), runs locally and on Vercel
**Audience:** Product owner / developer (personal-use project)

## 1. Summary

A personal web application that keeps a record of what is happening in the
owner's Clash of Clans clan — specifically **Clan Wars** and **Clan Capital
raid weekends**.

The app automatically pulls data from the official Clash of Clans API and
stores historical snapshots in a database, so the owner can look back at past
wars and raid weekends and see per-member participation: stars, destruction
%, attacks used, loot raided, and hall levels.

The project must run **locally** (Python + MySQL via XAMPP) and be importable
to **Vercel** with **Supabase** as the production database.

## 2. Goals

### Primary goals

1. Track clan war history: every war, its result, and every member's attacks
   (stars, destruction %, attacks used).
2. Track Clan Capital raid weekend history: every member's raids, attacks,
   and loot per weekend.
3. Provide leaderboards (most stars, best participation) per war/raid and
   across history.
4. Sync data with one click using the official CoC API.
5. Run locally with `npm start` (Python + MySQL) and deploy to Vercel with
   Supabase without code changes.

### Non-goals (v1)

- Multi-user accounts / registration (single-owner, personal use).
- Clan War League (CWL) deep analytics beyond what the war log exposes (v1
  stores CWL wars that appear in data but no dedicated CWL dashboard).
- Chat, notifications, or Discord integration.
- Editing game data manually (the API is the source of truth; only freeform
  notes are manual).

## 3. Users and permissions

- **Owner (single user, v1):** full access — dashboard, history, sync, notes.
- Anyone with the deployed URL can **view** the dashboard in read-only mode;
  the **sync** action and note editing are protected by an admin key
  (`ADMIN_KEY` env var) so random visitors cannot trigger API calls or edits.

## 4. Tech stack

| Layer      | Local                    | Vercel production            |
|------------|--------------------------|------------------------------|
| Backend    | Python 3.14 + Flask      | Python serverless (Flask via `api/index.py`) |
| Frontend   | HTML (Jinja2) + CSS + vanilla JS, served by Flask | same, static assets served by Vercel |
| Database   | MySQL (XAMPP) via PyMySQL | Supabase PostgreSQL via psycopg2 |
| Data source| Official CoC API (developer.clashofclans.com) | same |
| Entry      | `npm start` → `python app.py` → http://localhost:5000 | GitHub import → Vercel |

## 5. Dual-database strategy

A single small DB layer (`config/db.py`) detects the environment:

- If `DATABASE_URL` is set (Vercel/Supabase) → connect with **psycopg2**
  (PostgreSQL SQL dialect).
- Otherwise → connect to local **MySQL** from `DB_HOST`, `DB_USER`,
  `DB_PASSWORD`, `DB_NAME` with **PyMySQL** (MySQL dialect).

Two schema files are kept in sync:

- `schema.mysql.sql` — run once against XAMPP MySQL (`coc_tracker` database).
- `schema.postgres.sql` — run once in the Supabase SQL editor.

Dialect differences are confined to the schema files and the small number of
parameter-placeholder / upsert helpers in `config/db.py`.

## 6. Data model

- **members** — clan roster snapshot: tag (PK), name, role, town hall level,
  trophies, last_seen.
- **wars** — one row per war: opponent name/tag, team size, start/end time,
  result (`win`/`lose`/`tie`/`inProgress`), stars for/against, destruction
  for/against, is_cwl, notes.
- **war_attacks** — per attack: war id, attacker tag/name, defender tag/name,
  stars, destruction %, order, duration, and a `side` column (`'clan'` or
  `'enemy'`, added in v1.1; older databases are migrated + backfilled on sync).
- **raid_weekends** — one row per raid weekend: start/end, raids completed,
  total loot (capital gold, raid medals), attacks, destroyed districts.
- **capital_raids** — per member per weekend: member tag/name, hall level,
  attacks, loot (capital gold + raid medals), districts destroyed.
- **member_contributions** — daily snapshot of each member's *cumulative*
  capital-coin contributions (tag+day unique). Daily donation = today's total
  minus yesterday's; the API only exposes lifetime totals, so history builds
  from the first day tracking starts.

v1.1 tracking additions:

- **Live current war** — the in-progress war (preparation/inWar) is stored in
  `wars` with `result='preparation'`/`'inProgress'`, and every attack as it
  lands is stored in `war_attacks`, refreshed on each sync. When the finished
  war appears in the warlog, the same row is adopted and updated with the
  final result (no duplicates; the live rows are keyed by end time + opponent,
  the same key the warlog uses).
  *API limit:* the warlog exposes no attack detail, so per-attack tables exist
  only for wars that were tracked while live.
- **Capital participation** — raiders from `capital_raids` are compared
  against the synced clan roster to produce "attacked" vs "didn't attack"
  lists per raid weekend (`capital_raids` has a unique `(raid_id, member_tag)`
  key so a member can never appear twice).

## 7. API endpoints (backend)

| Method | Path              | Description                                  |
|--------|-------------------|----------------------------------------------|
| GET    | `/`               | Dashboard (clan info, current war, current raid weekend) |
| GET    | `/wars`           | War history page                             |
| GET    | `/capital`        | Raid weekend history page                    |
| GET    | `/members`        | Members page (sortable roster)               |
| GET    | `/health`         | `{ "status": "ok" }` liveness + DB check     |
| GET    | `/api/clan`       | Current clan info                            |
| GET    | `/api/members`    | Roster                                       |
| GET    | `/api/wars`       | War history + attacks (JSON)                 |
| GET    | `/api/current-war`| Live war + live attack feed (JSON)           |
| GET    | `/api/capital`    | Raid weekend history (JSON)                  |
| GET    | `/api/capital/participation` | Attacked vs didn't-attack lists (`?raid_id=` optional) |
| GET    | `/api/capital/<raid_id>/raiders` | Per-member breakdown for one raid weekend |
| GET    | `/api/wars/<war_id>/attacks` | Attacks for one war (war history rows) |
| GET    | `/api/contributions` | Daily capital-coin donation deltas      |
| GET    | `/api/status`     | Auto-sync config + recent `sync_log` rows    |
| GET    | `/api/capital/leaderboard` | Clan Capital raid loot per member + weekend coverage |
| GET    | `/api/wars/<war_id>/leaderboard` | Stars for one specific war |
| POST   | `/api/sync`       | Pull fresh data from CoC API (requires `X-Admin-Key`) |
| GET/POST | `/api/cron-sync` | Scheduled sync for Vercel Cron (admin key or `CRON_SECRET`) |
| POST   | `/api/notes`      | Edit war/raid notes (requires `X-Admin-Key`) |
| GET    | `/api/inactivity` | Inactivity rollup: missed war attacks, skipped raid weekends, donation-less days (`?wars=&raids=&donation_days=`) |
| GET    | `/api/diagnostics` | Setup report: API key/IP match, DB, timezone, admin key (`?probe=0`, `?fresh=1`) |
| POST   | `/api/admin/verify` | Check an admin key without side effects |
| GET    | `/api/members/<tag>/profile` | One member's tracked history: wars, stars, perfects, missed attacks, capital loot |

## 8. Frontend

- Plain **HTML + CSS + vanilla JavaScript**; no framework, no build step.
- `templates/base.html` — shared dark "CoC-style" shell: header, tab nav
  (Dashboard / Wars / Clan Capital), responsive.
- `static/css/style.css` — single stylesheet, dark theme, card/table layout,
  mobile responsive.
- `static/js/main.js` — `fetch()`es the JSON API and renders tables; holds the
  Sync button (prompts for admin key, calls `POST /api/sync`, reloads data);
  renders the live current-war feed, capital participation, daily donation
  deltas, and the sortable member roster.
- Pages: `index.html` (dashboard incl. current war), `wars.html` (war list
  with expandable per-war attack tables), `capital.html` (raid weekend list,
  participation, daily donations), `members.html` (roster sortable A→Z,
  Z→A, by role Leader→Member / Member→Leader, and by trophies).
- **In-page tabs** keep long pages short. `main.js` turns any `.page-tab` /
  `.tab-panel` pair into a tab strip, stores the active tab in the URL hash
  (e.g. `/capital#tab-donations`) and only loads a tab's data when it is first
  opened. Long lists (war attacks, raid-weekend members) load lazily when a
  row is expanded. Tabs: Wars → *War History · Leaderboard*; Clan Capital →
  *Participation · History · Daily Donations · Leaderboards*. War stars stay on
  the Wars page and Clan Capital loot on the Clan Capital page, so neither page
  mixes the two domains.
- Header shows **auto-sync status** (interval + last sync time/status) from
  `/api/status`.
- **Member profiles** — each row on the Members page expands to the member's
  whole tracked history, loaded lazily on first open.
- **War notes** — an inline dialog on each expanded war row, saved via
  `/api/notes` with the admin key.
- **In-war sorting** — inside an expanded war, a *Sort members by* dropdown
  (stars / perfect attacks / used / unused-first / destruction / name)
  re-orders and re-numbers both sides' member rows client-side.

## 8b. Automatic sync

Manual syncing is never required: the app refreshes itself.

- **Local** — `npm start` runs `python app.py`; the app starts a background
  daemon thread on the first request (5s later, then every
  `AUTO_SYNC_MINUTES`, default 30; `0` disables). Running the app is all that
  is needed — no clicking Sync.
- **Vercel** — `vercel.json` declares a Cron job hitting `/api/cron-sync`
  daily (`0 5 * * *`); the endpoint accepts either `X-Admin-Key` or Vercel's
  `Authorization: Bearer <CRON_SECRET>`.
- Every sync is idempotent (upserts / unique keys), so overlapping runs are
  safe; results are recorded in `sync_log` and shown via `/api/status`.
- Daily capital-coin history depends on a sync happening at least once a day —
  the background thread / cron covers this automatically.
- **Stale IP whitelist (403)** — every Supercell key is pinned to the IPs it was
  created for, so a rotating public IP breaks all calls. `scripts/refresh_key.py`
  creates a key for the current IP (and rewrites `COC_API_TOKEN` atomically after
  verifying it), `scripts/diagnose.py` and `/api/diagnostics` explain any
  remaining failure, and `AUTO_REFRESH_KEY=1` lets the background loop self-heal
  after a 403. See the README section *When sync returns 403*.

## 9. Configuration / environment variables

| Variable | Where required | Purpose |
|----------|----------------|---------|
| `COC_API_TOKEN` | both | Official CoC API JWT key |
| `CLAN_TAG` | both | e.g. `#2PP` — URL-encoded by the client |
| `DATABASE_URL` | Vercel only | Supabase Postgres connection string (pooler) |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | local only | XAMPP MySQL |
| `ADMIN_KEY` | both | Protects sync + notes endpoints |
| `AUTO_SYNC_MINUTES` | local | Background sync interval in minutes (default 30; `0` disables) |
| `CRON_SECRET` | Vercel | Vercel Cron authenticates `/api/cron-sync` with it |
| `PORT` | provided | Local default 5000; Vercel sets it |
| `ALLOW_LOCAL_SYNC` | local | `1` (default) trusts loopback requests, so local refreshes never ask for `ADMIN_KEY`; set `0` when exposing the app beyond localhost |
| `COC_DEV_EMAIL` | local, optional | Developer-portal login used by `scripts/refresh_key.py` |
| `COC_DEV_PASSWORD` | local, optional | Developer-portal password (an account password — never deploy it) |
| `AUTO_REFRESH_KEY` | local, optional | `1` runs `scripts/refresh_key.py` from the background loop after a 403 |
| `EGRESS_CHECK` / `EGRESS_IP_LOOKUP_URL` / `DIAGNOSTICS_TTL` | both | Diagnostics: enable + endpoint + cache seconds |
| `COC_KEY_CIDRS` / `COC_KEY_REFRESHED_AT` | local | Written by the rotator; informational |

`.env` is gitignored; `.env.example` documents the names.

## 10. Deployment (Vercel)

1. Push the project folder to a GitHub repository.
2. Create a Supabase project, run `schema.postgres.sql` in the SQL editor,
   copy the **connection pooler** string into `DATABASE_URL`.
3. On vercel.com: **Add New → Project → Import Git Repository**.
4. Framework preset: **Other**; Vercel detects `vercel.json` and builds
   `api/index.py` with the Python runtime.
5. Add environment variables (`COC_API_TOKEN`, `CLAN_TAG`, `DATABASE_URL`,
   `ADMIN_KEY`) in **Settings → Environment Variables**.
6. Deploy; verify `https://<project>.vercel.app/health`.

### API IP-whitelisting caveat

The CoC API only accepts requests from IP addresses whitelisted in the
developer portal. Local development requires the developer's current public
IP to be whitelisted. Vercel serverless IPs are not static — if the deployed
app receives IP-blocked responses, update the whitelist in the CoC developer
portal (Supercell permits whitelisting deployment IPs) or route API calls
through a proxy with a static IP. The app surfaces API errors on the
dashboard rather than showing empty success states.

## 11. Security

- Never commit `.env`, database passwords, or the API token.
- The CoC API token is treated as a secret; if exposed, regenerate it in the
  developer portal.
- Sync/notes endpoints require `ADMIN_KEY`; read-only endpoints are public.
- All SQL uses parameterized queries.

## 12. Acceptance criteria (v1)

1. `npm start` runs the app locally at http://localhost:5000 using XAMPP MySQL.
2. `GET /health` returns `{"status":"ok"}` locally and on Vercel.
3. `POST /api/sync` fetches clan, war log, and raid weekends from the CoC API
   and stores them in the database.
4. Dashboard, Wars, and Clan Capital pages render real synced data.
5. The same codebase deploys to Vercel using Supabase with only env-var changes.
6. `python scripts/diagnose.py` (and `GET /api/diagnostics`) report the state of
   the API key/IP match, the database, the timezone and the admin key, each with
   an actionable fix; a failed sync is visible in the UI and in `/api/status`
   even when the database is unreachable.

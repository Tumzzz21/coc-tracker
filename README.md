# CoC Attack Tracker

Personal tracker for Clash of Clans **Clan Wars** and **Clan Capital raid
weekends**, powered by the official CoC API. Runs locally with Python +
XAMPP MySQL; deploys to Vercel with Supabase.

See [PRD.md](PRD.md) for the full product requirements.

## Quick start (local)

1. Start MySQL from XAMPP (or `C:\xampp\mysql_start.bat`).
2. Create the schema (once):

   ```powershell
   Get-Content schema.mysql.sql -Raw | & 'C:\xampp\mysql\bin\mysql.exe' -u root
   ```

3. Configure environment:

   ```powershell
   copy .env.example .env
   # edit .env: COC_API_TOKEN, CLAN_TAG, DB_PASSWORD, ADMIN_KEY
   ```

4. Run:

   ```
   npm start
   ```

   (equivalent to `python app.py`) — open http://localhost:5000

5. Just run the app — data syncs automatically (background thread, default
   every 30 minutes). **Refresh now** is there for an immediate refresh; on this
   machine it needs no key (`ALLOW_LOCAL_SYNC=1`), elsewhere it uses the admin
   key you save once through the ⚙ dialog. The header shows the auto-sync status
   and the last sync time, and a **setup check** card appears whenever the CoC
   API, the database or the timezone config cannot be used.

## Automatic sync

- **Local**: `python app.py` (or `npm start`) starts a background thread that
  syncs shortly after boot and then every `AUTO_SYNC_MINUTES` minutes
  (default 30, set `0` in `.env` to disable). No manual syncing needed.
- **Vercel**: `vercel.json` registers a **daily** Cron job that calls
  `/api/cron-sync` — daily schedules are supported on Vercel's free (Hobby)
  tier. Set `CRON_SECRET` on Vercel if you enable cron authentication (the
  endpoint also accepts the admin key).
- Every sync is idempotent, so repeated runs never duplicate rows. Results are
  recorded in `sync_log` and surfaced through `/api/status`.
- **Why it matters for donations:** the game only reports *lifetime* capital
  coin contributions, so one sync per day is what builds the day-by-day
  donation history. The local thread (every 30 min) and the Vercel daily cron
  both satisfy this automatically.

Verify it is on: `http://localhost:5000/api/status` shows
`"auto_sync_enabled": true` with `"auto_sync_minutes": 30`, and the header
displays `auto-sync every 30m · last: …`. The first sync fires ~5 seconds after
the first page load.

The admin key is an app password that you choose yourself in `.env` as
`ADMIN_KEY`; it is not provided by Clash of Clans or the CoC developer portal.
It guards **Refresh now** and note editing. Requests from this machine are
trusted automatically while `ALLOW_LOCAL_SYNC=1`, so locally you are never
prompted; from another device click ⚙ and paste the key once (it is kept in that
browser's localStorage only). Pick something long — the app logs and reports a
warning when `ADMIN_KEY` looks guessable.

## When sync returns 403: the key is tied to an IP

Supercell pins every API key to the IP addresses you whitelist, and allows one
key per IP (max 10 keys per account). A rotating home IP therefore breaks every
call with `403 accessDenied.invalidIp` — which is exactly what the setup-check
card reports, including the IP the key allows and the command that fixes it.

```powershell
python scripts\diagnose.py                 # what is broken, and how to fix it
python scripts\refresh_key.py --dry-run    # show what the rotator would do
python scripts\refresh_key.py              # create a key for the current IP
```

`refresh_key.py` reads `COC_DEV_EMAIL` / `COC_DEV_PASSWORD` (your Supercell
developer-portal login) from `.env`, creates a key for the current public IP,
**verifies it with a live clan call**, revokes the oldest key when the account is
at the 10-key cap, and rewrites `COC_API_TOKEN` in `.env` atomically — without
ever printing the secret. Restart the app afterwards so the new token loads.

Prefer one key for a whole subnet (so rotation becomes rare), and protect keys
you do not want touched:

```powershell
python scripts\refresh_key.py --cidr 136.158.10.0/24 --keep my-other-app
```

Exit codes: `0` ok/unchanged · `2` login failed · `3` create failed ·
`4` verification failed · `5` missing credentials. `--json` gives a
machine-readable report; `--quiet` silences the happy path.

Make it self-healing:

- **Windows Task Scheduler** (no app involvement):
  `schtasks /Create /TN "CoC API key refresh" /SC MINUTE /MO 30 /TR "E:\CODING FILE\coc-attack-tracker\scripts\refresh_key.cmd" /F`
- **From the app**: set `AUTO_REFRESH_KEY=1` and the background sync runs the
  script once after a 403 and then retries.
- **No credentials configured?** Fix it by hand at
  [developer.clashofclans.com](https://developer.clashofclans.com/#/account) —
  `diagnose.py` prints the exact IP to add. The portal API used by the script is
  undocumented and can change; the manual route always works.

`COC_DEV_PASSWORD` is your **account** password, not the API key: keep `.env`
out of git (the script refuses to write a `.env` that git does not ignore),
never put it on Vercel, and rotate it if it ever leaks.

## Other things that break sync

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Database: (2003, "Can't connect to MySQL ...")` | XAMPP MySQL is not running | `C:\xampp\mysql_start.bat` (or `scripts\dev.cmd`, which checks for you) |
| `Table 'coc_tracker.members' doesn't exist` | schema never applied | `Get-Content schema.mysql.sql -Raw \| & 'C:\xampp\mysql\bin\mysql.exe' -u root` |
| Setup check flags `TZ_MISMATCH` | server clock is UTC (Vercel) while days are labelled +08:00 | set `APP_UTC_OFFSET=+08:00` (or `TZ=Asia/Manila`) in the server environment |
| Setup check flags `WEAK_ADMIN_KEY` | `ADMIN_KEY` is short or guessable | `python -c "import secrets; print(secrets.token_urlsafe(24))"` |
| Nothing at all on the dashboard | that is what the setup check card is for — it names the failing layer | read the card, run the printed `fix` command |

## Pages

Long pages use in-page tabs (the active tab is kept in the URL hash, e.g.
`/capital#tab-donations`), and detail lists load only when expanded.

| Page | Tabs / content |
|------|----------------|
| Dashboard | Live **Current war** card (state, stars, every attack as it lands), clan info, recent wars/raids, top members, **Inactivity** alerts |
| Inactivity (dashboard tab) | Who missed war attacks, skipped raid weekends, or donated nothing on recent scored days — one ranked table + per-war/per-raid detail (`/api/inactivity`, tunable with `?wars=&raids=&donation_days=`) |
| Wars | *War History* (numbered `#1…#N`, sortable: newest/oldest/result/stars/destruction/opponent — expand a war for our attacks vs the enemy's, grouped per member and numbered/sortable in place) · *Leaderboard* (stars for the one selected war) |
| Clan Capital | *Participation* (attacked vs didn't attack, choose the weekend) · *History* (expandable per-member breakdown) · *Daily Donations* (coins donated per member per day + clan totals per day) · *Leaderboards* (raid loot per member) |
| Members | Roster with a sort dropdown: name, role, trophies, Town Hall. Expand **Profile** under any member for their whole tracked history: wars played, attacks used/missed, stars, perfect attacks (3★), avg destruction and capital raid loot (`/api/members/profile?tag=...`) |

### Sorting

Every data table has a **Sort by** dropdown (no rows of buttons): Members,
War History, the War Leaderboard, Capital Leaderboards, Participation and the
Inactivity report. Sorting is client-side over the rows already loaded, so
changing it never triggers another request. War History rows are numbered in
display order (`#1` is always the top row), so the numbers follow the sort.

Expanding a war adds its own **Sort members by** dropdown — *stars earned*,
*perfect attacks (3★)*, *attacks used*, *unused attacks first*, *avg
destruction* and *name* — applied to both the clan and enemy attack lists. The
member rows are re-numbered as you sort, so `#1` is always the top row and
"perfect attacks" answers *who hit 3★?* in one click, while *unused attacks
first* pushes anyone who left attacks on the table to the top. The same control
appears on the dashboard **Current war** card.

The Wars **Leaderboard** tab is deliberately scoped to **one war at a time**:
the war picker drives both the summary line (opponent, result, stars,
destruction, date) and the table below it, with a checkbox to show the enemy
side instead. There is no combined all-wars board, so there is nothing for it to
be confused with. The old combined `GET /api/leaderboard` endpoint was removed when that board was retired.

### War notes

Expand any war in War History and use the **📝 Add note** button to record
context the API cannot know (a missed war, a close call, CWL prep). Notes are
freeform, up to 500 characters, saved through `POST /api/notes` with the admin
key, and shown on the war's summary line. Deleting the text and saving clears
the note.

### Data hygiene

- **Sync guard** — warlog entries without an opponent tag or with an impossible
  star count (more than teamSize × 3) are skipped and counted as `wars_skipped`
  in the sync summary. This is the guard against the junk war row that once
  showed up as `#1` on every stars/destruction sort.
- **sync_log retention** — every full sync prunes `sync_log` rows older than
  30 days; the UI only ever reads the most recent 20.

### Tests

```powershell
python -m pip install pytest
python -m pytest tests/ -q
```

The suite covers the timezone helpers, the war key/implausible-war guard and
the daily donation scoring math (the last one against the real database,
inserting `#TESTSYN*` rows and deleting them afterwards — it never touches
recorded days). DB tests skip automatically when MySQL is not running, or set
`SKIP_DB_TESTS=1` to force-skip.

### Clan vs enemy attacks

A war's attack list is split into **⚔ Our attacks** and **🛡 Enemy attacks**,
with the enemy list muted so it can never be mistaken for your own members.
Inside each side the attacks are grouped **one row per member** (best
performance first, or in whatever order you pick): the row itself reads
`2 / 2 attacks · 6★ · 2 perfect · 100.0%`, so
unused attacks are obvious at a glance (flagged with a red *n unused* badge),
and clicking the member reveals just their own hits — order, defender, stars,
destruction and duration — instead of scanning a flat table of every attack.
Each row in `war_attacks` carries a `side` column (`'clan'` or `'enemy'`); the
war leaderboards and the inactivity "missed attacks" count use clan-side rows
only, so enemy attacks cannot inflate a member's numbers. Existing databases
are migrated automatically on the next sync (the column is added and backfilled
from the members roster).

### Layout

The UI is responsive down to phone widths: the header collapses to a compact
bar with a horizontally scrollable nav, tables scroll sideways inside their
cards, and sort/filter controls wrap into thumb-friendly widths.

## CoC API setup

1. Create an account at https://developer.clashofclans.com and create a key.
2. Whitelist your **current public IP** on the key (required; the API rejects
   other IPs). Find it via `curl ifconfig.me` or a "what is my IP" search.
3. Put the key in `.env` as `COC_API_TOKEN` and your clan tag as `CLAN_TAG`.

## Deploying to Vercel with Supabase

1. Push this folder to GitHub.
2. Create a Supabase project → SQL Editor → run `schema.postgres.sql`.
3. Copy the **connection pooler** string (Project Settings → Database).
4. On vercel.com: **Add New → Project → Import** the GitHub repo
   (framework preset: Other).
5. Add environment variables: `COC_API_TOKEN`, `CLAN_TAG`, `DATABASE_URL`
   (the Supabase pooler string), `ADMIN_KEY`. For Vercel, `ADMIN_KEY` is also
   a secret you choose yourself; it does not come from Clash of Clans. Also
   whitelist your deployment IP with Supercell if API calls return 403.
6. Deploy; verify `https://<project>.vercel.app/health`.

## Project layout

```
coc-attack-tracker/
├── PRD.md                  # product requirements
├── README.md               # quick start + troubleshooting
├── app.py                  # Flask app (local entrypoint, npm start)
├── api/index.py            # Vercel serverless entrypoint
├── coc_api.py              # official CoC API client (retry + token claims)
├── coc_portal.py           # developer-portal client (create/list/revoke keys)
├── sync.py                 # API → database sync logic
├── diagnostics.py          # the setup report behind /api/diagnostics
├── runtime_state.py        # last sync attempt, kept in memory
├── config/db.py            # MySQL (local) / PostgreSQL (Supabase) layer
├── schema.mysql.sql        # local schema (XAMPP)
├── schema.postgres.sql     # Supabase schema
├── templates/              # Jinja2 HTML pages (dashboard, wars, capital, members)
├── static/css, static/js   # stylesheet + vanilla JS
├── tests/                  # pytest suite (logic + scoring)
├── scripts/
│   ├── refresh_key.py      # create a CoC API key for the current public IP
│   ├── refresh_key.cmd     # Task Scheduler wrapper (self-healing IP whitelist)
│   ├── diagnose.py         # one-page setup report (why sync fails)
│   └── dev.cmd             # start MySQL if needed, print the report, run the app
├── requirements.txt
├── package.json            # npm start → python app.py
├── vercel.json
└── .env.example
```

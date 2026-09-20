# Clash of Clans Clan Activity Tracker

A lightweight clan management dashboard built with HTML5, CSS3, vanilla JavaScript, Node.js, Express, and PostgreSQL.

## Features

- Admin registration, simulated email confirmation, login, and logout
- Protected clan member roster management
- War attack activity tracking
- Clan Capital raid-weekend participation logging
- Configurable background image
- Responsive dashboard interface

## Requirements

- Node.js 18 or newer
- PostgreSQL 14+ (Supabase is recommended for production)
- npm

## Installation

1. Enter the project directory:

   ```bash
   cd coc-clan-tracker
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a local PostgreSQL database and tables:

   ```bash
   psql -U postgres -d postgres -f schema.sql
   ```

4. Copy `.env.example` to `.env` and update the PostgreSQL credentials:

   ```bash
   copy .env.example .env
   ```

   On macOS or Linux, use:

   ```bash
   cp .env.example .env
   ```

5. Start the server:

   ```bash
   npm start
   ```

6. Open [http://localhost:3000](http://localhost:3000).

## Running locally without PostgreSQL

The app normally needs PostgreSQL (locally or via Supabase). If no PostgreSQL
server is reachable, it automatically falls back to an embedded SQLite database
stored in `data/coc-tracker.sqlite` (created on first start, no installation
needed), so `npm start` works on any machine. A notice is printed on the console
when the fallback is active. The administrator account listed in `ADMIN_EMAILS`
is created automatically on first start using `ADMIN_PASSWORD`.

To force a backend, set `DB_CLIENT=sqlite` or `DB_CLIENT=postgres` in `.env`.
To use PostgreSQL again, set `DATABASE_URL` (Supabase) and restart; the SQLite
file is only used while PostgreSQL is unreachable. The fallback is disabled on
Vercel so a missing `DATABASE_URL` there always surfaces as an error.

For development with Node’s file watcher:

```bash
npm run dev
```

## Deploying to Vercel with Supabase

The app is configured as a Vercel serverless Express function and uses
Supabase PostgreSQL. Vercel and Supabase accounts must be created by you;
never commit `.env`, passwords, or database dumps.

### 1. Push the project to GitHub

From PowerShell:

```powershell
cd E:\CODING FILE\coc-clan-tracker
git init
git add .
git commit -m "Prepare app for deployment"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

If this repository already has a remote, use `git remote -v` and skip
`git init` and `git remote add`.

### 2. Create the Supabase database

1. Create a free Supabase project.
2. Open **SQL Editor**, paste the contents of `schema.sql`, and run it.
3. Open **Project Settings > Database** and copy the connection string.
   Prefer the pooler connection string for serverless workloads.
4. Keep the connection string private. It contains the database password.

Set `DATABASE_URL` to that connection string. The app also supports individual
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` variables for
local PostgreSQL, but `DATABASE_URL` takes precedence.

### 3. Migrate existing data

The old XAMPP database is MySQL and cannot be imported directly into Supabase
PostgreSQL. For a small roster, use the Supabase schema and re-enter data.
For a full migration, export CSV files from phpMyAdmin and import them in
foreign-key order: `users`, `members`, logs, sessions, attendance, then
`settings`. Review MySQL-to-PostgreSQL type changes before importing.

### 4. Deploy from the Vercel website

1. Push the project to GitHub. The repository must contain `package.json`,
   `api/index.js`, `vercel.json`, and `public/`.
2. Open [vercel.com](https://vercel.com), sign in, and select **Add New...
   > Project**.
3. Under **Import Git Repository**, find `Tumzzz21/coc-tracker` and select
   **Import**.
4. In **Configure Project**, use:
   - **Framework Preset:** Other
   - **Root Directory:** `./` if `package.json` is at the repository root
   - **Build Command:** `npm run vercel-build` (or leave Vercel's default)
   - **Output Directory:** leave empty
   - **Install Command:** `npm install` or `npm ci`
5. Expand **Environment Variables** and add each variable for the
   **Production** environment:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase PostgreSQL connection string |
   | `ADMIN_EMAILS` | Your administrator email |
   | `ADMIN_PASSWORD` | A temporary password of at least 8 characters |
   | `ALLOW_REGISTRATION` | `false` |
   | `CONFIRMATION_CODE_EXPIRY_MINUTES` | `30` |

   Do not add `PORT`; Vercel provides it automatically. If Vercel or a database
   integration already created `POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or
   `POSTGRES_URL_NON_POOLING`, the app can use those as fallbacks, but
   `DATABASE_URL` is preferred. Do not add the local
   `DB_HOST`, `DB_USER`, or XAMPP values when using `DATABASE_URL`.
6. Select **Deploy**. Vercel installs dependencies from `package.json` and
   uses `api/index.js` as the serverless Express entrypoint.
7. When deployment finishes, open the generated `.vercel.app` URL.
8. Test the database connection at:

   ```text
   https://<your-project>.vercel.app/health
   ```

   A working deployment returns `{"status":"ok"}`.

To change variables later, open **Vercel Project > Settings > Environment
Variables**, edit the value, then create a new deployment from **Deployments >
Redeploy**. Environment variable changes do not affect an already-running
deployment until it is redeployed.

Vercel does not import `.env` files from the Git repository. This is
intentional: database passwords must not be committed to source control.
Use `.env.example` as the list of required names, then paste the real values
into Vercel's Environment Variables form.

```text
https://<your-vercel-domain>/health
```

Vercel provides a free `vercel.app` HTTPS URL. Add a custom domain under
**Vercel Project > Settings > Domains**; Vercel provisions HTTPS after DNS
verification.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `3000` |
| `DATABASE_URL` | Supabase PostgreSQL connection string | — |
| `DB_HOST` | Local PostgreSQL host when `DATABASE_URL` is empty | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USER` | PostgreSQL username | — |
| `DB_PASSWORD` | PostgreSQL password | — |
| `DB_NAME` | PostgreSQL database name | `postgres` |
| `CONFIRMATION_CODE_EXPIRY_MINUTES` | Simulated confirmation-code lifetime | `30` |

## Authentication flow

1. Open **Admin login**.
2. Register an email and password.
3. The simulated confirmation code is displayed in the response message.
4. Enter the email and six-digit code in the confirmation form.
5. Log in to access roster and activity-management features.

Authentication tokens are stored in browser local storage and tracked in server memory. Restarting the server invalidates active sessions.

## API overview

All protected endpoints require:

```http
Authorization: Bearer <token>
```

### Authentication

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Register an admin account |
| `POST` | `/api/auth/confirm` | Confirm the simulated email code |
| `POST` | `/api/auth/forgot-password` | Generate a simulated password-reset code |
| `POST` | `/api/auth/reset-password` | Set a new password using the reset code |
| `POST` | `/api/auth/login` | Log in and receive a token |
| `GET` | `/api/auth/me` | Return the current admin |
| `POST` | `/api/auth/logout` | Invalidate the current token |

### Members

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/members` | List roster members |
| `POST` | `/api/members` | Add a member |
| `PATCH` | `/api/members/:id` | Update a member |
| `DELETE` | `/api/members/:id` | Remove a member and related logs |

Member fields:

```json
{
  "playerTag": "#ABC123",
  "playerName": "Player Name",
  "townHallLevel": 12,
  "role": "member"
}
```

### Persistent sessions

War and Clan Capital sessions are stored in PostgreSQL and require a name and date.
Use `/api/sessions/war` or `/api/sessions/capital` to create/list sessions,
`GET /api/sessions/:type/:id` to load a roster, `PUT
/api/sessions/:type/:id/attendance` to save selection, status, and attack
counts, and `POST /api/sessions/:type/:id/finish` to finish a session. War
attendance accepts 0-2 attacks per member; Capital accepts 0-6.

Valid roles are `leader`, `co-leader`, `elder`, and `member`.

### War activity

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/wars` | List war logs |
| `GET` | `/api/wars?date=YYYY-MM-DD` | Filter war logs by date |
| `POST` | `/api/wars` | Create or update a member’s war log |
| `DELETE` | `/api/wars/:id` | Delete a war log |

War payload:

```json
{
  "memberId": 1,
  "warDate": "2026-09-04",
  "attacksUsed": 2,
  "missedAttack": false
}
```

### Clan Capital activity

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/capital` | List Capital logs |
| `GET` | `/api/capital?date=YYYY-MM-DD` | Filter Capital logs by date |
| `POST` | `/api/capital` | Create or update a Capital log |
| `DELETE` | `/api/capital/:id` | Delete a Capital log |

Capital payload:

```json
{
  "memberId": 1,
  "raidWeekendDate": "2026-09-04",
  "attacksUsed": 6,
  "capitalGoldLooted": 15000
}
```

### Settings

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/settings` | Read the current background image |
| `PUT` | `/api/settings` | Update or clear the background image |

Settings payload:

```json
{
  "bgImageUrl": "https://example.com/clan-background.jpg"
}
```

Send `null` to clear the background.

## Project structure

```text
coc-clan-tracker/
├── public/
│   ├── index.html
│   ├── login.html
│   ├── css/style.css
│   └── js/main.js
├── config/db.js
├── api/index.js
├── routes/
│   ├── auth.js
│   ├── members.js
│   └── wars.js
├── .env.example
├── package.json
├── README.md
├── schema.sql
├── server.js
└── vercel.json
```

## Production notes

- Use HTTPS in production.
- Store sessions in a persistent server-side store instead of the in-memory token map.
- Do not expose simulated confirmation codes in a production response.
- Use a dedicated Supabase database role with only the permissions required by this application.

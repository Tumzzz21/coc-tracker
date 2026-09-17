# Clash of Clans Clan Activity Tracker

A lightweight clan management dashboard built with HTML5, CSS3, vanilla JavaScript, Node.js, Express, and MySQL.

## Features

- Admin registration, simulated email confirmation, login, and logout
- Protected clan member roster management
- War attack activity tracking
- Clan Capital raid-weekend participation logging
- Configurable background image
- Responsive dashboard interface

## Requirements

- Node.js 18 or newer
- MySQL 8 or compatible MySQL server
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

3. Create the database and tables:

   ```bash
   mysql -u root -p < schema.sql
   ```

4. Copy `.env.example` to `.env` and update the MySQL credentials:

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

For development with Node’s file watcher:

```bash
npm run dev
```

## Deploying to Railway or Render

The app is ready to deploy as a Node.js web service. You must create the
hosting and database accounts yourself; never commit `.env` or paste database
passwords into Git.

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

### 2. Create the cloud MySQL database

Railway can provision a MySQL service in the same project. Create a Railway
project, add **MySQL**, and copy its connection variables. Alternatively, use
any managed MySQL provider that supplies a host, port, database name, user,
and password. Render does not provide the Node service's database credentials;
use a separate managed MySQL provider when deploying the web service there.

### 3. Import the local XAMPP database

Export the local database using the XAMPP shell or PowerShell. Adjust the
path if XAMPP is installed elsewhere:

```powershell
& "C:\xampp\mysql\bin\mysqldump.exe" -u root -p --single-transaction --routines --triggers coc_clan_tracker > "$env:USERPROFILE\Desktop\coc_clan_tracker.sql"
```

For a new hosted database, remove the first `CREATE DATABASE` and `USE`
statements from the dump if the provider gives you a different database name.
Then import the dump using the provider's host, port, user, and database:

```powershell
& "C:\xampp\mysql\bin\mysql.exe" `
  --host=<cloud-host> --port=<cloud-port> `
  --user=<cloud-user> --password `
  <cloud-database> < "$env:USERPROFILE\Desktop\coc_clan_tracker.sql"
```

The password prompt is intentionally interactive so it is not saved in shell
history. If you only need empty tables, run `schema.sql` instead of importing
a data dump.

### 4. Deploy on Railway

1. In Railway, choose **New project > Deploy from GitHub repo**.
2. Select this repository and the Node service.
3. Set the service root directory to `coc-clan-tracker` if the repository
   contains the app in a subdirectory.
4. Set the following service variables under **Variables**:

   ```text
   DB_HOST=<cloud-host>
   DB_PORT=<cloud-port>
   DB_USER=<cloud-user>
   DB_PASSWORD=<cloud-password>
   DB_NAME=<cloud-database>
   CONFIRMATION_CODE_EXPIRY_MINUTES=30
   ```

   Do not set `PORT`; Railway supplies it automatically.
5. Deploy. The start command is `npm start`.
6. Verify `https://<railway-domain>/health` returns `{"status":"ok"}`.

If the MySQL service is in the same Railway project, use the MySQL service's
private connection values where supported. Use its public connection values
for an externally hosted app or local migration.

### 5. Deploy on Render

1. Choose **New > Web Service**, connect the GitHub repository, and set the
   root directory to `coc-clan-tracker` when needed.
2. Use:
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/health`
3. Add the same `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
   `DB_NAME`, and `CONFIRMATION_CODE_EXPIRY_MINUTES` variables in Render's
   Environment settings.
4. Deploy and confirm the generated `https://<service>.onrender.com/health`
   URL returns `{"status":"ok"}`.

## Free public URL and HTTPS

Railway and Render provide a generated public `https://` subdomain at no
extra domain-registration cost (subject to each provider's current free-tier
limits). In the service's **Domains** settings, generate or copy the default
domain and share that URL.

For a custom domain, buy or use a domain you control, add it in the provider's
Domains page, create the DNS CNAME record it gives you, and wait for DNS
propagation. Both providers provision HTTPS certificates automatically after
DNS verification. Do not create a password-protected tunnel or expose the
XAMPP machine as the production database.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `3000` |
| `DB_HOST` | MySQL host | `localhost` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL username | — |
| `DB_PASSWORD` | MySQL password | — |
| `DB_NAME` | MySQL database name | `coc_clan_tracker` |
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

War and Clan Capital sessions are stored in MySQL and require a name and date.
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
├── routes/
│   ├── auth.js
│   ├── members.js
│   └── wars.js
├── .env.example
├── package.json
├── README.md
├── schema.sql
└── server.js
```

## Production notes

- Use HTTPS in production.
- Store sessions in a persistent server-side store instead of the in-memory token map.
- Do not expose simulated confirmation codes in a production response.
- Use a dedicated MySQL user with only the permissions required by this application.

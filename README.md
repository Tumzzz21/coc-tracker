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

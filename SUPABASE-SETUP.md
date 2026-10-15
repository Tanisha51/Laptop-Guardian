# Laptop Guardian — Supabase cloud database setup

This build stores users, devices, activity events, and queued/reported commands in Supabase. Local JSON files remain as a backup mirror. The backend and Windows Agent still run locally in this build; Supabase persistence does **not** by itself make the dashboard or device agent internet-accessible.

## 1. Create the table and restricted RPC

1. Open your Supabase project.
2. Open **SQL Editor** → **New query**.
3. Open `backend/supabase-schema.sql` from this project, copy its full contents into the editor, and click **Run**.
4. In **Table Editor**, verify the `lg_records` table exists.

The table has Row Level Security enabled and blocks `anon`/`authenticated` access. The backend uses a server-side service-role/secret key; never put that key in frontend files or share it.

## 2. Configure backend environment variables

Open `backend/.env` (create it by copying `.env.example` if it does not exist). Keep your existing `JWT_SECRET`, `RESEND_API_KEY`, and `EMAIL_FROM` values if already configured. Add/update these two lines using values from Supabase **Project Settings → API**:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_SIDE_SERVICE_ROLE_OR_SECRET_KEY
```

Do not commit `.env`. Do not use the public/anon key for `SUPABASE_SERVICE_ROLE_KEY`. Never share the service-role/secret key in chat or screenshots.

## 3. Migrate existing local data

If this is a fresh copy and `node_modules` is missing, run `npm.cmd install` first. Before starting the backend in cloud mode for the first time, stop any running backend (`Ctrl+C`). Open PowerShell in the `backend` folder and run:

```powershell
npm.cmd run migrate:supabase
```

The migration imports local `users.json`, `devices.json`, and `events.json` only when the matching cloud collection is empty. It will not overwrite a collection that already contains cloud records. Local JSON files are retained as backup. Read the command output and make sure the records you expected are imported.

If a collection says it was skipped because cloud already has records, inspect that collection in Supabase before proceeding. Do not empty cloud tables just to force a migration.

## 4. Start and verify

In the same backend folder:

```powershell
npm.cmd start
```

When configured correctly, the terminal should print `Storage mode: Supabase cloud database`. Then open `http://localhost:8787/api/health`. Its JSON should include `"storage":"supabase"`.

Open `http://localhost:8787` and test owner login, dashboard, device online status, and command results. Keep the backend terminal open. In a second terminal, start the paired Windows Agent with `node agent.js` from `windows-agent`.

## Notes

- Existing local owner password hashes and device token hashes are migrated as records; passwords and tokens are not converted to Supabase Auth users.
- Pairing codes remain short-lived in backend memory and must be generated again after a backend restart.
- Supabase stores persistent records, but the backend currently binds to `127.0.0.1`; remote internet access needs a separate secure backend deployment and HTTPS design.
- Do not delete `backend/data` after migration. It is a useful local backup.

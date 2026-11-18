# Bete Metsahaf - Library & Attendance Management System

Library inventory, circulation (issue / renew / return with fines) and librarian attendance.
Node.js + Express backend, plain HTML/JS frontend, and either **Supabase (PostgreSQL)** or a local **MySQL / MariaDB** (XAMPP).

The project ships with **no data at all**: no sample books, no default accounts, no passwords.

## Quick start

1. Install Node.js 18 or newer, then in this folder run:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill it in:
   - `JWT_SECRET` (required): generate with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `APP_TIMEZONE`: your library's timezone (e.g. `Africa/Addis_Ababa`). Needed for correct "late" and "overdue" decisions.
   - Database: **either** `DATABASE_URL` (Supabase) **or** the `DB_*` values (MySQL).
3. Create the tables (works for both databases, inserts no data):
   ```
   npm run setup-db
   ```
4. Create the first administrator (asks for name, email, password):
   ```
   npm run create-admin
   ```
5. Start:
   ```
   npm start
   ```
   Open http://localhost:3000 and sign in.

`npm run test-db` checks the connection and that every table exists.

### Supabase notes
- Use the connection string from *Project Settings -> Database -> Connection string -> URI*. URL-encode special characters in the password.
- Row-level security is enabled on every table by `setup-db`, so nothing is readable through Supabase's public REST API. The app connects directly as `postgres`, which is unaffected.
- `DB_SSL=require` (default) encrypts the connection but does not verify the server certificate. For full verification download the CA certificate from the Supabase dashboard and set `DB_SSL=verify` and `DB_SSL_CA_PATH=/path/to/ca.crt`.

### MySQL / XAMPP notes
- Start MySQL in the XAMPP control panel; leave `DB_PASSWORD` empty for a default XAMPP root user.
- Tables use `utf8mb4`, so Amharic (Ge'ez) text in titles and names is stored correctly.

## How it works

| Role | Can do |
| --- | --- |
| Administrator | Everything: librarians, settings, attendance corrections (audited), deleting books, reports |
| Librarian | Check in / out, add and edit books, issue / renew / return, search and shelf locator |

- There is **no public sign-up**. Administrators create librarian accounts under *Librarians*; extra administrators are created with `npm run create-admin`.
- Deactivating a librarian blocks them immediately, even if they are signed in. A librarian with attendance or transaction history can be deactivated but not deleted.
- Settings (shift start, grace period, half-day threshold, loan days, fine per day, low-stock level) have built-in defaults and are only stored once an administrator changes them.
- All timestamps are stored in UTC and displayed in `APP_TIMEZONE`.
- Renewing an overdue loan does **not** erase the fine already accrued; it is carried and charged on return.

## Security measures
- Only the `public/` folder is served; source, schema and `.env` files are not reachable over HTTP.
- `JWT_SECRET` is mandatory; the server refuses to start without a strong one.
- Accounts are re-checked on every request; login attempts are rate limited (in memory, per process: use a reverse proxy rate limit if you run several instances); security headers incl. a Content-Security-Policy are set.
- Passwords are hashed with bcrypt; all SQL uses parameters.
- Never commit `.env` (it is in `.gitignore`).

## Optional: first admin without a terminal
If you deploy somewhere without shell access you can set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (and `ADMIN_NAME`) once; the admin is created on first start only if none exists. Remove `ADMIN_PASSWORD` afterwards.

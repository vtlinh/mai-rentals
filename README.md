# mai-rentals

Web app for tracking how much each rental unit owes in shared utility bills. A bill covers a date range and is assigned to one or more units; the cost is split across units in proportion to **person-days of occupancy that overlap the bill period** (tenants × overlapping days).

Live at https://mai-rentals.fly.dev (Google sign-in, allowlist-gated).

## Features

- Add / edit / remove **units**.
- Track **occupancies** per unit (tenant count + start/end date, end inclusive).
- Add **bills** (water, electric, gas, or combinations) with a period and one or more assigned units.
- **Dashboard** groups bills by due month (latest first, empty months hidden), showing per-unit totals broken down by utility kind plus a single A→Z list of bills due that month.
- **Due date** is derived automatically — first of the month following the bill's end date.
- **Google OAuth** sign-in; only emails on a DB-backed allowlist can view the site.
- **Admin** (`ADMIN_EMAIL` env var) gets a Users tab to manage the allowlist.

## Stack

Python 3.12 · Flask · **Google Sheets (gspread)** as the DB · Authlib (Google OIDC) · uv · gunicorn · Fly.io

## Sheets-backed storage

All data lives in a Google Sheet (one tab per "table") so you can view and hand-edit rows directly. The columns are plain — no JSON cells — and IDs are visible so you can edit foreign keys. Direct edits show up in the app within ~10 seconds (the cache TTL).

Tabs and columns:

| Tab | Columns |
|---|---|
| `units` | id, name, note |
| `occupancies` | id, unit_id, tenant_count, start_date, end_date |
| `bills` | id, kind, amount, start_date, end_date, note, recurring_bill_id |
| `bill_units` | id, bill_id, unit_id |
| `recurring_bills` | id, kind, amount, note, recurrence, recurrence_config, start_date, end_date, active, is_credit |
| `recurring_bill_units` | id, recurring_bill_id, unit_id |
| `payments` | id, unit_id, year, month, kind, amount |
| `categories` | id, name |
| `authorized_users` | id, email |

Conventions: dates as `YYYY-MM-DD`, booleans as `TRUE`/`FALSE`, `recurrence_config` as a CSV like `1,15`. Empty cell = NULL.

### One-time setup

1. **Create a service account** in Google Cloud Console → IAM → Service Accounts. Download a JSON key. Enable the **Google Sheets API** for the project.
2. **Create an empty Google Sheet** and **share it with the service account's email** (Editor access). Copy the spreadsheet ID from its URL (the long string between `/d/` and `/edit`).
3. **Set two Fly secrets**:
   ```bash
   flyctl secrets set GOOGLE_SHEETS_ID=<your spreadsheet id>
   flyctl secrets set GOOGLE_SHEETS_CREDENTIALS_JSON="$(cat path/to/service-account.json)"
   ```
4. On the next deploy, the app calls `init_db()`, which creates each tab with its header row.

### Migrating existing SQLite data

If you're moving from the previous SQLite backend, copy `rental.db` from your Fly volume to local, then run the one-shot migration:

```bash
export GOOGLE_SHEETS_ID=<your sheet id>
export GOOGLE_SHEETS_CREDENTIALS_JSON="$(cat path/to/service-account.json)"
uv run python scripts/migrate_sqlite_to_sheets.py /path/to/rental.db
```

The script wipes the sheet's data rows (keeping headers) before re-writing, so it's safe to re-run.

## Local development

```bash
uv sync
cp .env.example .env  # then fill in values
uv run python run.py  # http://localhost:5000
uv run pytest -q
```

`.env` keys:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
FLASK_SECRET_KEY=...
ADMIN_EMAIL=you@example.com

# Sheets-backed DB (optional locally — if unset, an in-memory backend
# is used, so data evaporates on restart):
GOOGLE_SHEETS_ID=...
GOOGLE_SHEETS_CREDENTIALS_JSON={ "type": "service_account", ... }
```

The OAuth client (Google Cloud console → Credentials) needs `http://localhost:5000/auth/callback` and `https://mai-rentals.fly.dev/auth/callback` as authorized redirect URIs.

## How the split works

For each bill assigned to a set of units:

1. For every unit, compute its **person-days** = sum over the unit's occupancies of `tenant_count × (inclusive days overlapping the bill period)`.
2. Total person-days = sum across all assigned units.
3. Each unit owes `bill.amount × unit_person_days / total_person_days`.

Example: a $100 bill for Feb 5 – Mar 4 shared between Unit 1 (3 tenants, Feb 1 – May 31) and Unit 2 (5 tenants, Feb 15 – May 31):

- Unit 1: 28 overlap days × 3 tenants = **84 person-days** → $48.28
- Unit 2: 18 overlap days × 5 tenants = **90 person-days** → $51.72

The bill is then surfaced in the **April** column of the dashboard (due date = 1st of the month after Mar 4).

## Deployment

Pushes to `main` trigger `.github/workflows/fly-deploy.yml`, which runs `flyctl deploy --remote-only` against `mai-rentals` using the `FLY_API_TOKEN` repo secret.

App configuration:

- Region `sjc`, shared 256 MB VM.
- Data lives in Google Sheets (see "Sheets-backed storage" above). The old `/data/rental.db` volume is no longer used and can be detached after the SQLite-to-Sheets migration has run.
- App secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FLASK_SECRET_KEY`, `ADMIN_EMAIL`, `GOOGLE_SHEETS_ID`, `GOOGLE_SHEETS_CREDENTIALS_JSON`) are stored as Fly secrets — not in the repo.

Manual deploy: `flyctl deploy`.

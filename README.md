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

Python 3.12 · Flask · SQLAlchemy 2.0 · SQLite · Authlib (Google OIDC) · uv · gunicorn · Fly.io

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
- Persistent SQLite at `/data/rental.db` on the `rental_data` volume (1 GB).
- App secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FLASK_SECRET_KEY`, `ADMIN_EMAIL`) are stored as Fly secrets — not in the repo.

Manual deploy: `flyctl deploy`.

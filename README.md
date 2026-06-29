# mai-rentals

Tracks how much each rental unit owes in shared utility bills. A bill covers a date range and is assigned to one or more units; the cost is split across units in proportion to **person-days of occupancy that overlap the bill period** (tenants × overlapping days).

> **Status — in transit.** Currently a Flask app on Fly (live at https://mai-rentals.fly.dev) backed by SQLite. We're moving to a **static frontend on GitHub Pages** that talks directly to **Google Sheets** as its DB. The Flask app stays running until the static version is fully ported; new code lives under `/docs/`. Privacy in the new model is enforced by the Sheet's own share list — Google rejects requests from accounts that aren't shared on the sheet.

## Static frontend (under `/docs/`)

```
docs/
  index.html                ← page shell
  css/style.css             ← shared styles (light + dark)
  js/
    config.js               ← OAuth client id + sheet id (PUBLIC; edit and commit)
    auth.js                 ← Google Identity Services sign-in
    sheets.js               ← REST client + TTL-cached batchGet
    util.js                 ← date math, coercion, DOM helpers, flash
    billing.js              ← split / recurring-instance math (port of billing.py)
    main.js                 ← hash router, nav, sign-in shell
    pages/                  ← one module per page (mount(container))
      dashboard.js
```

### Setup (do this BEFORE enabling Pages):

1. **OAuth Web Client ID** — Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID, type "Web application". Add `https://vtlinh.github.io` and `http://localhost:8000` as **authorized JavaScript origins** (no redirect URIs needed). Enable the **Google Sheets API** on the same project.
2. **Sheet** — create an empty Google Sheet, copy its ID from the URL. Share it with every Google account that should have access (Editor for read+write, Viewer for read-only).
3. **Fill in `docs/js/config.js`** with `OAUTH_CLIENT_ID` and `SHEET_ID`, commit.
4. **Initialize tabs** — open the site, sign in, then in the browser console run `await window._ensureTabs()` once. This creates all 8 tabs with the right header rows.
5. **Migrate existing data** (optional, only if you have a `rental.db`):
   ```bash
   pip install gspread
   export GOOGLE_SHEETS_ID=<sheet id>
   export GOOGLE_SHEETS_CREDENTIALS_JSON="$(cat path/to/service-account.json)"
   python scripts/migrate_sqlite_to_sheets.py /path/to/rental.db
   ```
   *(The migration script uses a service-account JSON; the frontend uses your personal Google sign-in. The two are independent.)*
6. **Enable GitHub Pages** — repo Settings → Pages → Source: `Deploy from a branch` → `main` / `/docs`. The site appears at `https://vtlinh.github.io/mai-rentals/`.

### Local dev for the static frontend

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

Add `http://localhost:8000` to the OAuth client's authorized JS origins, then sign in normally.

---

(Below: the existing Flask app, still the source of truth until the static version is fully ported.)

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

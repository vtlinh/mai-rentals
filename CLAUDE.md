# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow

After completing a feature or fix, commit it, push the branch, open a PR, and merge it to `main` (which auto-deploys via Fly) without asking for approval first.

## What this app does

Flask web app that tracks how much each rental unit owes the landlord in shared utility bills. A bill covers a date range and is assigned to one or more units; the cost is split across units proportionally to **person-days of occupancy that overlap the bill period** (tenants × overlapping days).

## Running

```
uv run python run.py     # http://localhost:5000
uv run pytest -q
```

Google OAuth requires three env vars before the server can authenticate anyone:

```
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FLASK_SECRET_KEY
```

Without them `/login` renders a "missing config" message instead of redirecting to Google. The OAuth redirect URI is `http://localhost:5000/auth/callback`.

Two more env vars wire the Sheets-backed DB (see README for setup). When unset, an in-memory backend is used (lost on restart — convenient for tests/local hacking):

```
GOOGLE_SHEETS_ID, GOOGLE_SHEETS_CREDENTIALS_JSON
```

## Architecture

- **`app/__init__.py`** — Flask app factory. Calls `init_db()` then `seed_authorized_users()` and `seed_billing_kinds()` on every startup (idempotent). Registers Jinja globals (`bill_due_date`, `current_email`, `is_admin`, `admin_email`).
- **`app/sheets.py`** — Pluggable storage backend. `GSpreadBackend` talks to Google Sheets via a service account; `InMemoryBackend` is used when the env vars aren't set. Reads are TTL-cached (~10s) so a single page render doesn't make N API calls.
- **`app/db.py`** — Dataclasses (`Unit`, `Occupancy`, `Bill`, `BillUnit`, `RecurringBill`, `RecurringBillUnit`, `Payment`, `BillingKind`, `AuthorizedUser`) + module-level CRUD functions (`units_all`, `unit_create`, `bill_update`, `recurring_with_assignments`, etc.). Each table is one tab in the sheet with a human-readable header row; IDs are visible integers so you can edit the sheet by hand. `recurrence_config` is stored as a CSV string like `"1,15"`, not JSON. Booleans are `TRUE`/`FALSE`.
- **`app/billing.py`** — Pure functions, no storage. The split algorithm lives here. **End dates are inclusive** (`_overlap_days` adds `+1`), which the spec example test pins down (2/5–3/4 = 28 days). `bill_due_date(end)` returns the 1st of the following month — due date is never stored, always derived.
- **`app/auth.py`** — Authlib + Google OIDC. Auth state lives in `flask.session` keyed by `email`. `is_admin(email)` is a simple equality check against `ADMIN_EMAIL`.
- **`app/routes.py`** — Single blueprint `main`. **Auth is enforced at the blueprint level** via `@bp.before_request`. Admin-only routes additionally call `_require_admin()`. The `auth` blueprint is registered separately so its routes bypass this guard.

## Bill-splitting invariants

When changing the split logic, keep these facts true (the tests in `tests/test_billing.py` will catch regressions):

- A unit's contribution to a bill is `tenant_count × inclusive overlap days` between each of the unit's occupancies and the bill period, summed.
- The bill amount is distributed **proportionally to those person-day totals across all assigned units** — the unit-level total person-days is the denominator, not the bill's full date range.
- Per-unit amounts are rounded to 2 decimals; the sum should reconcile to the bill amount up to rounding (the spec example reconciles exactly).
- If a unit has no overlap, it owes $0 and is hidden on the dashboard.

## Dashboard rendering

The dashboard groups bills by the month of their derived due date, sorted latest-first, with empty months omitted entirely. Each month shows one combined totals table (rows = units, columns = utility kinds A→Z) and a single A→Z bulleted list of bills due that month. Units with $0 totals are filtered out.

## Schema changes

The "schema" is just the header row of each tab in the sheet. `init_db()` calls `ensure_tab(...)` on startup for every tab in `TABS`, which creates the tab if missing and overwrites the header row to match the declared columns. To add a column: append the column name to the right entry in `TABS`, restart the app, and the header row gains the new column (existing rows have a blank value there). To rename a column: change the entry and rename the column in the sheet by hand — there is no automatic rename.

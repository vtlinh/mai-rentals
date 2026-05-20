# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Architecture

- **`app/__init__.py`** — Flask app factory. Calls `init_db()` then `seed_authorized_users()` on every startup, so the allowlist is self-healing. Registers Jinja globals (`bill_due_date`, `current_email`, `is_admin`, `admin_email`) so templates can use them without per-route context.
- **`app/db.py`** — SQLAlchemy 2.0 models: `Unit`, `Occupancy` (per-unit headcount × date range), `Bill`, `BillUnit` (M2M assignment), `AuthorizedUser`. `ADMIN_EMAIL` is hardcoded; `SEED_EMAILS` defines the initial allowlist. Uses a single SQLite file `rental.db` next to the package. `get_session()` is a contextmanager that **auto-commits on exit** — don't call `session.commit()` inside the `with` block.
- **`app/billing.py`** — Pure functions, no DB. The split algorithm lives here. **End dates are inclusive** (`_overlap_days` adds `+1`), which the spec example test pins down (2/5–3/4 = 28 days). `bill_due_date(end)` returns the 1st of the following month — due date is never stored, always derived.
- **`app/auth.py`** — Authlib + Google OIDC. Auth state lives in `flask.session` keyed by `email`. `is_admin(email)` is a simple equality check against `ADMIN_EMAIL`.
- **`app/routes.py`** — Single blueprint `main`. **Auth is enforced at the blueprint level** via `@bp.before_request`, which redirects to `/login` if the session email isn't on the allowlist. Admin-only routes additionally call `_require_admin()`. The `auth` blueprint is registered separately so its routes bypass this guard.

## Bill-splitting invariants

When changing the split logic, keep these facts true (the tests in `tests/test_billing.py` will catch regressions):

- A unit's contribution to a bill is `tenant_count × inclusive overlap days` between each of the unit's occupancies and the bill period, summed.
- The bill amount is distributed **proportionally to those person-day totals across all assigned units** — the unit-level total person-days is the denominator, not the bill's full date range.
- Per-unit amounts are rounded to 2 decimals; the sum should reconcile to the bill amount up to rounding (the spec example reconciles exactly).
- If a unit has no overlap, it owes $0 and is hidden on the dashboard.

## Dashboard rendering

The dashboard groups bills by the month of their derived due date, sorted latest-first, with empty months omitted entirely. Each month shows one combined totals table (rows = units, columns = utility kinds A→Z) and a single A→Z bulleted list of bills due that month. Units with $0 totals are filtered out.

## Schema changes

There are no migrations. `Base.metadata.create_all()` is additive — new tables/columns on existing tables won't be applied. When changing an existing column, delete `rental.db` (it's gitignored) and restart; the seed function will repopulate the allowlist.

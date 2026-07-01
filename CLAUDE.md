# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow

After completing a feature or fix, commit it, push the branch, open a PR, and merge it to `main` without asking for approval first. `main` / `/docs` is published by GitHub Pages, so a merge is the deploy.

## What this app does

A **static frontend** (plain ES modules under `docs/`, no build step) that tracks
how much each rental unit owes in shared utility bills. A bill covers a date
range and is assigned to one or more units; the cost is split across units
proportionally to **person-days of occupancy that overlap the bill period**
(tenants × overlapping days). There is **no backend** — the browser talks
directly to a **Google Sheet** as its database via the Sheets REST API, using
the signed-in user's own Google token. A Google account can only read/write if
the sheet is shared with it.

> History: this was a Flask + SQLite app on Fly.io. That backend has been
> decommissioned — data migrated into the Google Sheet, Fly app + volume
> destroyed. Don't reintroduce server-side code.

## Running

```
python -m http.server 8000 --directory docs   # http://localhost:8000
```

`http://localhost:8000` must be an authorized JavaScript origin on the OAuth
client (Google Cloud Console). There is no test suite and no package manager.

## Architecture (`docs/js/`)

- **`config.js`** — `OAUTH_CLIENT_ID`, `SHEET_ID` (both public; the privacy
  boundary is the Sheet's share list). `TABS` defines the sheet schema: one tab
  per "table", column order matching the header row. New `window._ensureTabs()`
  creates any missing tabs from this.
- **`auth.js`** — Google Identity Services sign-in; holds the access token.
- **`sheets.js`** — REST client over the Sheets API with TTL-cached `batchGet`.
  All reads/writes go through here.
- **`util.js`** — date math, type coercion, DOM helpers, flash messages.
- **`billing.js`** — pure split / recurring-instance math (no I/O). **End dates
  are inclusive** (overlap adds `+1`; 2/5–3/4 = 28 days). Due date is the 1st of
  the month after the bill's end date — always derived, never stored.
- **`main.js`** — hash router, nav, sign-in shell.
- **`pages/*.js`** — one module per page, each exporting `mount(container)`.

## Bill-splitting invariants

Keep these true when changing the split logic in `billing.js`:

- A unit's **actual** person-days for a bill is `tenant_count × inclusive
  overlap days` between each of the unit's occupancies and the bill period,
  summed.
- Charges are **pro-rated against the full bill period**. The denominator is
  the **full-occupancy reference** person-days = Σ over assigned units of
  `(unit's peak tenant_count over the period × full bill-period length)`. Each
  unit owes `amount × actual_person_days / reference_total`.
- Consequence: a tenant present for only part of the period pays only that
  fraction (mid-month move-in/out → pro-rated), and the vacant remainder is
  **not** billed — it is neither charged to that unit nor redistributed to the
  other assigned units. The landlord absorbs vacancy.
- When every assigned unit occupies the entire bill period, reference ==
  actual, so the full amount is recovered and it reduces to a plain
  person-day split.
- Per-unit amounts are rounded to 2 decimals.
- If a unit has no overlap, it owes $0 and is hidden on the dashboard.

## Dashboard rendering

The dashboard groups bills by the month of their derived due date, sorted
latest-first, with empty months omitted entirely. Each month shows one combined
totals table (rows = units, columns = utility kinds A→Z) and a single A→Z
bulleted list of bills due that month. Units with $0 totals are filtered out.

## Sheet schema changes

The schema is the `TABS` map in `config.js`. To add a column, append it to the
right list there **and** add the header cell in the sheet by hand. The frontend
tolerates missing columns (empty cells). A brand-new sheet is initialized to
match `TABS` the first time `window._ensureTabs()` runs.

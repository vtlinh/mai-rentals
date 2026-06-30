# mai-rentals

Tracks how much each rental unit owes in shared utility bills. A bill covers a
date range and is assigned to one or more units; the cost is split across units
in proportion to **person-days of occupancy that overlap the bill period**
(tenants × overlapping days).

A static frontend hosted on **GitHub Pages** that talks directly to a
**Google Sheet** as its database. There is no backend server. Privacy is
enforced by the Sheet's own share list — Google rejects Sheets API requests
from any account that isn't shared on the sheet.

> Previously a Flask + SQLite app on Fly.io. That backend has been
> decommissioned; the live data was migrated into the Google Sheet and the
> Fly app and volume were destroyed.

## Layout

```
docs/
  index.html                ← page shell
  css/style.css             ← shared styles (light + dark)
  js/
    config.js               ← OAuth client id + sheet id (PUBLIC; edit and commit)
    auth.js                 ← Google Identity Services sign-in
    sheets.js               ← REST client + TTL-cached batchGet
    util.js                 ← date math, coercion, DOM helpers, flash
    billing.js              ← split / recurring-instance math
    main.js                 ← hash router, nav, sign-in shell
    pages/                  ← one module per page (mount(container))
      dashboard.js  units.js  manage_units.js  manage_occupancy.js
      bills.js  bill_form.js  recurring_form.js  categories.js
      payment_form.js  pdf.js
```

## Google setup

1. **OAuth Web Client ID** — Google Cloud Console → APIs & Services →
   Credentials → Create OAuth client ID, type "Web application". Add
   `https://vtlinh.github.io` and `http://localhost:8000` as **authorized
   JavaScript origins** (no redirect URIs needed). Enable the **Google Sheets
   API** on the same project.
2. **Sheet** — create a Google Sheet, copy its ID from the URL. Share it with
   every Google account that should have access (Editor for read+write, Viewer
   for read-only).
3. **Fill in `docs/js/config.js`** with `OAUTH_CLIENT_ID` and `SHEET_ID`, commit.
4. **Initialize tabs** — open the site, sign in, then in the browser console run
   `await window._ensureTabs()` once. This creates all tabs with the right
   header rows. The expected tabs/columns are defined by `TABS` in `config.js`.
5. **Enable GitHub Pages** — repo Settings → Pages → Source: `Deploy from a
   branch` → `main` / `/docs`. The site appears at
   `https://vtlinh.github.io/mai-rentals/`.

## Local dev

```bash
python -m http.server 8000 --directory docs
# open http://localhost:8000
```

Add `http://localhost:8000` to the OAuth client's authorized JS origins, then
sign in normally. No build step, no dependencies.

## How the split works

For each bill assigned to a set of units:

1. For every unit, compute its **person-days** = sum over the unit's occupancies
   of `tenant_count × (inclusive days overlapping the bill period)`.
2. Total person-days = sum across all assigned units.
3. Each unit owes `bill.amount × unit_person_days / total_person_days`.

Example: a $100 bill for Feb 5 – Mar 4 shared between Unit 1 (3 tenants, Feb 1 –
May 31) and Unit 2 (5 tenants, Feb 15 – May 31):

- Unit 1: 28 overlap days × 3 tenants = **84 person-days** → $48.28
- Unit 2: 18 overlap days × 5 tenants = **90 person-days** → $51.72

The bill is then surfaced in the **April** column of the dashboard (due date =
1st of the month after Mar 4). End dates are **inclusive**.

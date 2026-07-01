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

Charges are **pro-rated against the full bill period**, so partial occupancy
(a mid-month move-in or move-out) is charged proportionally.

For each bill assigned to a set of units:

1. For every unit, compute its **actual person-days** = sum over the unit's
   occupancies of `tenant_count × (inclusive days overlapping the bill period)`.
2. Compute the **full-occupancy reference** = sum over assigned units of
   `(unit's tenant_count × the full bill-period length in days)`.
3. Each unit owes `bill.amount × actual_person_days / reference`.

Because the denominator is the *full-period* reference (not the sum of actual
person-days), a unit that was only occupied part of the period pays only that
fraction, and the vacant remainder is simply not billed (it is not shifted onto
the other units).

**Example — pro-rating:** a $100 bill for a 30-day month, assigned to one unit
with 2 tenants who move in on the 16th (occupies 15 of 30 days):

- actual person-days = 2 × 15 = **30**
- reference = 2 tenants × 30 days = **60**
- owes `100 × 30 / 60` = **$50** (the other $50 is unbilled vacancy)

**Example — full occupancy** (reduces to a plain person-day split): a $100 bill
for a month shared between Unit 1 (2 tenants, whole month) and Unit 2 (3 tenants,
whole month) → reference = 2×30 + 3×30 = 150; Unit 1 owes `100 × 60/150` = **$40**,
Unit 2 owes `100 × 90/150` = **$60**, fully recovered.

Bills are surfaced on the dashboard in the month of their **due date** = the 1st
of the month after the bill's end date. End dates are **inclusive**.

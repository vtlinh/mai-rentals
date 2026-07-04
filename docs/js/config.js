/**
 * Frontend configuration. Both values are public — the privacy boundary is
 * the Sheet's own share list, enforced by Google. Anyone whose Google
 * account isn't shared on the sheet will get 403s from the Sheets API.
 *
 * Setup:
 *   1. Create an OAuth Web Client ID in Google Cloud Console:
 *      Console → APIs & Services → Credentials → Create OAuth client ID
 *      Type: Web application
 *      Authorized JavaScript origins:
 *        - https://vtlinh.github.io
 *        - http://localhost:8000   (for local dev)
 *      No redirect URIs needed (we use the implicit token model).
 *   2. Enable Google Sheets API on the same project.
 *   3. Create a Google Sheet, copy the ID from its URL.
 *   4. Share the sheet with each Google account that should have access
 *      (Editor for write, Viewer for read-only).
 *   5. Fill in the two strings below and commit.
 */
export const OAUTH_CLIENT_ID = "248940613032-ot4a9a6mktg8flg6kn95coqvn9do3lj3.apps.googleusercontent.com";
export const SHEET_ID = "1mOdFEWetY0uKC6G_qgUxIBB9MGshnVIhxLP7EOMS3NU";

/**
 * Sheet schema — one tab per "table", column order matches the header row.
 * Add a column by appending to the right list AND adding the column header
 * in the sheet by hand. The frontend tolerates missing columns (empty cells),
 * but a brand-new sheet will be initialized to match this exactly the first
 * time you visit /init.
 */
export const TABS = {
  units: ["id", "name", "note"],
  // covered_kinds: CSV of category names ("water, gas") whose bills are
  // auto-counted as paid for this tenancy (e.g. a fixed-fee contract).
  occupancies: ["id", "unit_id", "tenant_count", "start_date", "end_date", "covered_kinds"],
  // due_date is optional: empty → derived as the 1st of the month after end_date.
  bills: ["id", "kind", "amount", "start_date", "end_date", "note", "recurring_bill_id", "due_date"],
  // split_percent: optional fixed share (0–100) of the bill for this unit,
  // pro-rated by its occupied fraction of the period; empty → headcount split.
  bill_units: ["id", "bill_id", "unit_id", "split_percent"],
  // bill_timing: "end" (default; due the following month) | "start" (due within the period).
  // skip_dates: CSV of periods to skip — "YYYY-MM-DD" skips the period
  // containing that day, "YYYY-MM" skips periods beginning in that month.
  recurring_bills: [
    "id", "kind", "amount", "note", "recurrence", "recurrence_config",
    "start_date", "end_date", "active", "is_credit", "bill_timing",
    "skip_dates",
  ],
  recurring_bill_units: ["id", "recurring_bill_id", "unit_id", "split_percent"],
  payments: ["id", "unit_id", "year", "month", "kind", "amount"],
  categories: ["id", "name"],
};

export const DEFAULT_CATEGORIES = ["water", "electric", "gas", "combined"];

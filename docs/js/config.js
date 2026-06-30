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
  occupancies: ["id", "unit_id", "tenant_count", "start_date", "end_date"],
  bills: ["id", "kind", "amount", "start_date", "end_date", "note", "recurring_bill_id"],
  bill_units: ["id", "bill_id", "unit_id"],
  recurring_bills: [
    "id", "kind", "amount", "note", "recurrence", "recurrence_config",
    "start_date", "end_date", "active", "is_credit",
  ],
  recurring_bill_units: ["id", "recurring_bill_id", "unit_id"],
  payments: ["id", "unit_id", "year", "month", "kind", "amount"],
  categories: ["id", "name"],
};

export const DEFAULT_CATEGORIES = ["water", "electric", "gas", "combined"];

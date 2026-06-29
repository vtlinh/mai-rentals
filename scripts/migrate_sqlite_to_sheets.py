"""One-shot migration: copy an existing SQLite rental.db into the Google Sheet.

Standalone — does NOT depend on the Flask app. Requires only `gspread` plus
the sqlite3 stdlib module.

Setup:
    pip install gspread
    export GOOGLE_SHEETS_ID=<spreadsheet id from the sheet URL>
    export GOOGLE_SHEETS_CREDENTIALS_JSON="$(cat path/to/service-account.json)"

Usage:
    python scripts/migrate_sqlite_to_sheets.py /path/to/rental.db

The target sheet is wiped tab-by-tab (header re-written) before re-import, so
the script is safe to re-run.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import gspread


TABS: dict[str, list[str]] = {
    "units": ["id", "name", "note"],
    "occupancies": ["id", "unit_id", "tenant_count", "start_date", "end_date"],
    "bills": ["id", "kind", "amount", "start_date", "end_date", "note", "recurring_bill_id"],
    "bill_units": ["id", "bill_id", "unit_id"],
    "recurring_bills": [
        "id", "kind", "amount", "note", "recurrence", "recurrence_config",
        "start_date", "end_date", "active", "is_credit",
    ],
    "recurring_bill_units": ["id", "recurring_bill_id", "unit_id"],
    "payments": ["id", "unit_id", "year", "month", "kind", "amount"],
    "categories": ["id", "name"],
}


def main(sqlite_path: str) -> None:
    sheet_id = os.environ.get("GOOGLE_SHEETS_ID")
    creds_json = os.environ.get("GOOGLE_SHEETS_CREDENTIALS_JSON")
    if not sheet_id:
        raise SystemExit("GOOGLE_SHEETS_ID env var is required")
    if not creds_json:
        raise SystemExit("GOOGLE_SHEETS_CREDENTIALS_JSON env var is required")
    if not Path(sqlite_path).exists():
        raise SystemExit(f"sqlite file not found: {sqlite_path}")

    gc = gspread.service_account_from_dict(json.loads(creds_json))
    sh = gc.open_by_key(sheet_id)

    # Ensure each tab exists with the right header row.
    existing_titles = {ws.title for ws in sh.worksheets()}
    for tab, cols in TABS.items():
        if tab not in existing_titles:
            sh.add_worksheet(title=tab, rows=200, cols=max(len(cols), 5))
        ws = sh.worksheet(tab)
        ws.clear()
        ws.update("A1", [cols], value_input_option="RAW")

    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    def _table_exists(name: str) -> bool:
        cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        )
        return cur.fetchone() is not None

    def _append(tab: str, rows: list[list]) -> None:
        if not rows:
            return
        ws = sh.worksheet(tab)
        ws.append_rows(rows, value_input_option="USER_ENTERED")

    print("units...")
    rows = []
    for r in cur.execute("SELECT id, name, COALESCE(note,'') AS note FROM units"):
        rows.append([str(r["id"]), r["name"], r["note"]])
    _append("units", rows)

    print("occupancies...")
    rows = []
    for r in cur.execute("SELECT id, unit_id, tenant_count, start_date, end_date FROM occupancies"):
        rows.append([
            str(r["id"]), str(r["unit_id"]), str(r["tenant_count"]),
            r["start_date"], r["end_date"],
        ])
    _append("occupancies", rows)

    print("recurring_bills...")
    if _table_exists("recurring_bills"):
        cur.execute("PRAGMA table_info(recurring_bills)")
        rb_cols = {c[1] for c in cur.fetchall()}
        select_extra = (
            ", COALESCE(end_date, '') AS end_date" if "end_date" in rb_cols else
            ", '' AS end_date"
        ) + (
            ", COALESCE(is_credit, 0) AS is_credit" if "is_credit" in rb_cols else
            ", 0 AS is_credit"
        )
        rows = []
        for r in cur.execute(
            "SELECT id, kind, amount, COALESCE(note,'') AS note, recurrence, "
            "COALESCE(recurrence_config,'[]') AS recurrence_config, start_date, "
            "active" + select_extra + " FROM recurring_bills"
        ):
            try:
                cfg_list = json.loads(r["recurrence_config"] or "[]")
            except Exception:
                cfg_list = []
            cfg_csv = ",".join(str(int(x)) for x in cfg_list)
            rows.append([
                str(r["id"]), r["kind"], str(r["amount"]), r["note"],
                r["recurrence"], cfg_csv, r["start_date"],
                r["end_date"] or "",
                "TRUE" if r["active"] else "FALSE",
                "TRUE" if r["is_credit"] else "FALSE",
            ])
        _append("recurring_bills", rows)

    print("recurring_bill_units...")
    if _table_exists("recurring_bill_units"):
        rows = []
        for r in cur.execute("SELECT id, recurring_bill_id, unit_id FROM recurring_bill_units"):
            rows.append([
                str(r["id"]), str(r["recurring_bill_id"]), str(r["unit_id"]),
            ])
        _append("recurring_bill_units", rows)

    print("bills...")
    cur.execute("PRAGMA table_info(bills)")
    has_rb_fk = any(c[1] == "recurring_bill_id" for c in cur.fetchall())
    query = ("SELECT id, kind, amount, start_date, end_date, COALESCE(note,'') AS note"
             + (", recurring_bill_id" if has_rb_fk else "")
             + " FROM bills")
    rows = []
    for r in cur.execute(query):
        rows.append([
            str(r["id"]), r["kind"], str(r["amount"]), r["start_date"],
            r["end_date"], r["note"],
            (str(r["recurring_bill_id"]) if has_rb_fk and r["recurring_bill_id"] is not None else ""),
        ])
    _append("bills", rows)

    print("bill_units...")
    rows = []
    for r in cur.execute("SELECT id, bill_id, unit_id FROM bill_units"):
        rows.append([str(r["id"]), str(r["bill_id"]), str(r["unit_id"])])
    _append("bill_units", rows)

    print("payments...")
    if _table_exists("payments"):
        rows = []
        for r in cur.execute("SELECT id, unit_id, year, month, kind, amount FROM payments"):
            rows.append([
                str(r["id"]), str(r["unit_id"]), str(r["year"]),
                str(r["month"]), r["kind"], str(r["amount"]),
            ])
        _append("payments", rows)

    print("categories...")
    if _table_exists("billing_kinds"):
        rows = []
        for r in cur.execute("SELECT id, name FROM billing_kinds"):
            rows.append([str(r["id"]), r["name"]])
        _append("categories", rows)

    print("done.")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "rental.db"
    main(path)

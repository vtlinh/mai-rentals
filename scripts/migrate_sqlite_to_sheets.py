"""One-shot migration: copy an existing SQLite rental.db into the Google Sheet.

Usage (locally, after copying rental.db down from Fly):

    export GOOGLE_SHEETS_ID=<your sheet id>
    export GOOGLE_SHEETS_CREDENTIALS_JSON="$(cat path/to/service-account.json)"
    uv run python scripts/migrate_sqlite_to_sheets.py /path/to/rental.db

The target sheet is wiped first (per-tab clear then re-headered), so this is
safe to re-run. The script is read-only on the SQLite file.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def _connect(sqlite_path: Path) -> sqlite3.Connection:
    if not sqlite_path.exists():
        raise SystemExit(f"sqlite file not found: {sqlite_path}")
    conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def main(sqlite_path: str = "rental.db") -> None:
    # Import lazily so the script fails fast on env-var problems with a clear
    # error rather than a backend-construction traceback.
    import os
    if not os.environ.get("GOOGLE_SHEETS_ID"):
        raise SystemExit("GOOGLE_SHEETS_ID env var is required")
    if not os.environ.get("GOOGLE_SHEETS_CREDENTIALS_JSON"):
        raise SystemExit("GOOGLE_SHEETS_CREDENTIALS_JSON env var is required")

    from app import db
    from app.sheets import get_backend

    conn = _connect(Path(sqlite_path))
    cur = conn.cursor()
    backend = get_backend()
    db.init_db()

    def _wipe(tab: str) -> None:
        for row in backend.read_table(tab):
            try:
                backend.delete_row(tab, int(row["id"]))
            except (KeyError, ValueError):
                continue

    def _table_exists(name: str) -> bool:
        cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        )
        return cur.fetchone() is not None

    # ----- Units -----
    print("units...")
    _wipe("units")
    for r in cur.execute("SELECT id, name, COALESCE(note, '') AS note FROM units"):
        backend.append_row("units", {
            "id": str(r["id"]), "name": r["name"], "note": r["note"],
        })

    # ----- Occupancies -----
    print("occupancies...")
    _wipe("occupancies")
    for r in cur.execute("SELECT id, unit_id, tenant_count, start_date, end_date FROM occupancies"):
        backend.append_row("occupancies", {
            "id": str(r["id"]), "unit_id": str(r["unit_id"]),
            "tenant_count": str(r["tenant_count"]),
            "start_date": r["start_date"], "end_date": r["end_date"],
        })

    # ----- Recurring bills -----
    print("recurring_bills...")
    _wipe("recurring_bills")
    if _table_exists("recurring_bills"):
        # recurrence_config was stored as JSON in SQLite (e.g. "[1, 15]"); rewrite
        # as the new human-readable CSV (e.g. "1,15").
        import json
        for r in cur.execute(
            "SELECT id, kind, amount, COALESCE(note,'') as note, recurrence, "
            "COALESCE(recurrence_config,'[]') as recurrence_config, "
            "start_date, end_date, active, COALESCE(is_credit, 0) as is_credit "
            "FROM recurring_bills"
        ):
            try:
                cfg_list = json.loads(r["recurrence_config"] or "[]")
            except Exception:
                cfg_list = []
            cfg_csv = ",".join(str(int(x)) for x in cfg_list)
            backend.append_row("recurring_bills", {
                "id": str(r["id"]), "kind": r["kind"], "amount": str(r["amount"]),
                "note": r["note"], "recurrence": r["recurrence"],
                "recurrence_config": cfg_csv,
                "start_date": r["start_date"],
                "end_date": r["end_date"] or "",
                "active": "TRUE" if r["active"] else "FALSE",
                "is_credit": "TRUE" if r["is_credit"] else "FALSE",
            })

    # ----- Recurring bill units -----
    print("recurring_bill_units...")
    _wipe("recurring_bill_units")
    if _table_exists("recurring_bill_units"):
        for r in cur.execute("SELECT id, recurring_bill_id, unit_id FROM recurring_bill_units"):
            backend.append_row("recurring_bill_units", {
                "id": str(r["id"]),
                "recurring_bill_id": str(r["recurring_bill_id"]),
                "unit_id": str(r["unit_id"]),
            })

    # ----- Bills -----
    print("bills...")
    _wipe("bills")
    has_recurring_fk = False
    cur.execute("PRAGMA table_info(bills)")
    has_recurring_fk = any(c[1] == "recurring_bill_id" for c in cur.fetchall())
    query = (
        "SELECT id, kind, amount, start_date, end_date, COALESCE(note,'') AS note"
        + (", recurring_bill_id" if has_recurring_fk else "")
        + " FROM bills"
    )
    for r in cur.execute(query):
        backend.append_row("bills", {
            "id": str(r["id"]), "kind": r["kind"], "amount": str(r["amount"]),
            "start_date": r["start_date"], "end_date": r["end_date"],
            "note": r["note"],
            "recurring_bill_id": (
                str(r["recurring_bill_id"])
                if has_recurring_fk and r["recurring_bill_id"] is not None else ""
            ),
        })

    # ----- BillUnit -----
    print("bill_units...")
    _wipe("bill_units")
    for r in cur.execute("SELECT id, bill_id, unit_id FROM bill_units"):
        backend.append_row("bill_units", {
            "id": str(r["id"]), "bill_id": str(r["bill_id"]),
            "unit_id": str(r["unit_id"]),
        })

    # ----- Payments -----
    print("payments...")
    _wipe("payments")
    if _table_exists("payments"):
        for r in cur.execute("SELECT id, unit_id, year, month, kind, amount FROM payments"):
            backend.append_row("payments", {
                "id": str(r["id"]), "unit_id": str(r["unit_id"]),
                "year": str(r["year"]), "month": str(r["month"]),
                "kind": r["kind"], "amount": str(r["amount"]),
            })

    # ----- Categories (was billing_kinds) -----
    print("categories...")
    _wipe("categories")
    if _table_exists("billing_kinds"):
        for r in cur.execute("SELECT id, name FROM billing_kinds"):
            backend.append_row("categories", {
                "id": str(r["id"]), "name": r["name"],
            })

    # ----- Authorized users -----
    print("authorized_users...")
    _wipe("authorized_users")
    for r in cur.execute("SELECT id, email FROM authorized_users"):
        backend.append_row("authorized_users", {
            "id": str(r["id"]), "email": r["email"],
        })

    print("done.")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "rental.db"
    main(path)

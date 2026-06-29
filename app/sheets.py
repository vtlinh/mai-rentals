"""Sheets-backed storage layer.

Each "table" is a tab in a Google Sheet with a header row that names columns.
Values are stored as strings; callers handle type coercion (see db.py).

Two interchangeable backends:
- GSpreadBackend: real Google Sheets via gspread + service-account creds
- InMemoryBackend: dict-based, for tests & local dev when creds aren't set

Both expose: ensure_tab, read_table, append_row, update_row, delete_row,
invalidate.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Iterable, Protocol


# ---------------- Backend protocol ----------------


class Backend(Protocol):
    def ensure_tab(self, tab: str, columns: list[str]) -> None: ...
    def read_table(self, tab: str) -> list[dict[str, str]]: ...
    def append_row(self, tab: str, row: dict[str, str]) -> None: ...
    def update_row(self, tab: str, row_id: int, fields: dict[str, str]) -> None: ...
    def delete_row(self, tab: str, row_id: int) -> None: ...
    def invalidate(self, tab: str | None = None) -> None: ...


# ---------------- In-memory backend (tests / no-creds dev) ----------------


class InMemoryBackend:
    """Test/dev backend matching the Backend protocol.

    Rows are stored as ordered list[dict[str, str]] keyed by tab name. Mutation
    helpers preserve insertion order so test assertions are stable.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tabs: dict[str, list[dict[str, str]]] = {}
        self._headers: dict[str, list[str]] = {}

    def ensure_tab(self, tab: str, columns: list[str]) -> None:
        with self._lock:
            self._headers.setdefault(tab, list(columns))
            self._tabs.setdefault(tab, [])

    def read_table(self, tab: str) -> list[dict[str, str]]:
        with self._lock:
            return [dict(r) for r in self._tabs.get(tab, [])]

    def append_row(self, tab: str, row: dict[str, str]) -> None:
        with self._lock:
            self._tabs.setdefault(tab, []).append(dict(row))

    def update_row(self, tab: str, row_id: int, fields: dict[str, str]) -> None:
        with self._lock:
            for r in self._tabs.get(tab, []):
                if str(r.get("id")) == str(row_id):
                    r.update(fields)
                    return

    def delete_row(self, tab: str, row_id: int) -> None:
        with self._lock:
            rows = self._tabs.get(tab, [])
            self._tabs[tab] = [r for r in rows if str(r.get("id")) != str(row_id)]

    def invalidate(self, tab: str | None = None) -> None:
        pass  # No cache in memory backend.


# ---------------- Google Sheets backend ----------------


_CACHE_TTL_SECONDS = 10


class GSpreadBackend:
    """Sheets-backed implementation using gspread + a service account.

    Reads are cached for a short TTL to amortize repeated reads within a single
    request, while still picking up direct sheet edits within ~10s.
    """

    def __init__(self, sheet_id: str, credentials_dict: dict) -> None:
        # Imported lazily so test environments without gspread don't crash.
        import gspread

        self._gc = gspread.service_account_from_dict(credentials_dict)
        self._sh = self._gc.open_by_key(sheet_id)
        self._lock = threading.Lock()
        self._cache: dict[str, list[dict[str, str]]] = {}
        self._cache_ts: dict[str, float] = {}

    # ----- Setup -----

    def ensure_tab(self, tab: str, columns: list[str]) -> None:
        try:
            ws = self._sh.worksheet(tab)
        except Exception:
            ws = self._sh.add_worksheet(title=tab, rows=200, cols=max(len(columns), 5))
        # Always make sure the header row matches.
        existing = ws.row_values(1) if ws.row_count > 0 else []
        if existing[: len(columns)] != columns:
            ws.update("A1", [columns])
        self.invalidate(tab)

    # ----- Reads -----

    def read_table(self, tab: str) -> list[dict[str, str]]:
        now = time.time()
        with self._lock:
            ts = self._cache_ts.get(tab, 0)
            if now - ts < _CACHE_TTL_SECONDS and tab in self._cache:
                return [dict(r) for r in self._cache[tab]]
        ws = self._sh.worksheet(tab)
        raw = ws.get_all_values()
        rows: list[dict[str, str]] = []
        if raw:
            headers = [h.strip() for h in raw[0]]
            for raw_row in raw[1:]:
                if not any((c or "").strip() for c in raw_row):
                    continue  # skip fully-blank rows so users can leave gaps
                row = {h: (raw_row[i].strip() if i < len(raw_row) else "")
                       for i, h in enumerate(headers) if h}
                rows.append(row)
        with self._lock:
            self._cache[tab] = [dict(r) for r in rows]
            self._cache_ts[tab] = now
        return rows

    # ----- Writes -----

    def append_row(self, tab: str, row: dict[str, str]) -> None:
        ws = self._sh.worksheet(tab)
        headers = ws.row_values(1)
        values = [str(row.get(h, "")) for h in headers]
        ws.append_row(values, value_input_option="USER_ENTERED")
        self.invalidate(tab)

    def update_row(self, tab: str, row_id: int, fields: dict[str, str]) -> None:
        ws = self._sh.worksheet(tab)
        headers = ws.row_values(1)
        id_col_idx = headers.index("id") if "id" in headers else None
        if id_col_idx is None:
            raise ValueError(f"tab {tab!r} has no 'id' column")
        rows = ws.get_all_values()
        target_row_index = None  # 1-based row number in sheet
        for i, raw in enumerate(rows[1:], start=2):
            if i and str(raw[id_col_idx]).strip() == str(row_id):
                target_row_index = i
                break
        if target_row_index is None:
            return
        existing = {h: (rows[target_row_index - 1][i] if i < len(rows[target_row_index - 1]) else "")
                    for i, h in enumerate(headers)}
        existing.update({k: str(v) for k, v in fields.items()})
        values = [existing.get(h, "") for h in headers]
        ws.update(f"A{target_row_index}", [values], value_input_option="USER_ENTERED")
        self.invalidate(tab)

    def delete_row(self, tab: str, row_id: int) -> None:
        ws = self._sh.worksheet(tab)
        headers = ws.row_values(1)
        id_col_idx = headers.index("id") if "id" in headers else None
        if id_col_idx is None:
            return
        rows = ws.get_all_values()
        for i, raw in enumerate(rows[1:], start=2):
            if str(raw[id_col_idx]).strip() == str(row_id):
                ws.delete_rows(i)
                break
        self.invalidate(tab)

    def invalidate(self, tab: str | None = None) -> None:
        with self._lock:
            if tab is None:
                self._cache.clear()
                self._cache_ts.clear()
            else:
                self._cache.pop(tab, None)
                self._cache_ts.pop(tab, None)


# ---------------- Singleton selector ----------------


_backend: Backend | None = None
_backend_lock = threading.Lock()


def get_backend() -> Backend:
    """Return the configured backend.

    Uses GSpread when GOOGLE_SHEETS_ID + GOOGLE_SHEETS_CREDENTIALS_JSON env vars
    are set, otherwise falls back to InMemoryBackend (useful for tests and
    local dev). Override with set_backend() if needed.
    """
    global _backend
    if _backend is not None:
        return _backend
    with _backend_lock:
        if _backend is not None:
            return _backend
        sheet_id = os.environ.get("GOOGLE_SHEETS_ID", "").strip()
        creds_raw = os.environ.get("GOOGLE_SHEETS_CREDENTIALS_JSON", "").strip()
        if sheet_id and creds_raw:
            _backend = GSpreadBackend(sheet_id, json.loads(creds_raw))
        else:
            _backend = InMemoryBackend()
        return _backend


def set_backend(backend: Backend) -> None:
    """Replace the singleton (used by tests)."""
    global _backend
    with _backend_lock:
        _backend = backend


def reset_backend() -> None:
    """Forget the singleton — next get_backend() reads env again."""
    global _backend
    with _backend_lock:
        _backend = None


# ---------------- Helpers used by db.py ----------------


def to_str(value) -> str:
    """Coerce a Python value to a Sheets-friendly string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def from_bool(value: str) -> bool:
    v = (value or "").strip().lower()
    return v in {"true", "yes", "1", "y", "t"}


def next_id(rows: Iterable[dict[str, str]]) -> int:
    """Next integer ID, picking max(existing)+1 (or 1 if empty)."""
    best = 0
    for r in rows:
        try:
            n = int((r.get("id") or "").strip())
            if n > best:
                best = n
        except (ValueError, AttributeError):
            continue
    return best + 1

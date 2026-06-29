"""Sheets-backed data layer.

Each entity lives in its own tab of a Google Sheet. Tabs are plain rows-and-
columns with a header row matching the field names (no JSON blobs in cells).
The IDs are visible integers so foreign keys can be edited by hand.

Public API: dataclasses for type hints + module-level CRUD functions:
  units_all() / unit_by_id / unit_create / unit_update / unit_delete
  (same pattern for occupancies, bills, recurring_bills, payments, etc.)

bills_loaded() and recurring_loaded() pre-attach assignments so callers don't
have to manually wire M2M lookups everywhere.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from app.sheets import from_bool, get_backend, next_id, to_str

# ---------------- Tab/column schemas ----------------

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
    "authorized_users": ["id", "email"],
}

DEFAULT_CATEGORIES = ["water", "electric", "gas", "combined"]
SEED_EMAILS = ("nguyenmaihuong282@gmail.com",)


# ---------------- Type-coercion helpers ----------------


def _parse_date(s: str) -> Optional[date]:
    s = (s or "").strip()
    if not s:
        return None
    # Accept ISO date or full datetime prefix.
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def _int(s: str, default: int = 0) -> int:
    try:
        return int(float((s or "").strip()))
    except (ValueError, AttributeError):
        return default


def _float(s: str, default: float = 0.0) -> float:
    try:
        return float((s or "").strip())
    except (ValueError, AttributeError):
        return default


def _opt_int(s: str) -> Optional[int]:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _config_to_csv(v) -> str:
    """Recurrence config stored as human-friendly CSV like '1,15'.

    Accepts a list[int] or an already-formatted string.
    """
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    return ",".join(str(int(x)) for x in v)


def parse_recurrence_config(raw: str) -> list[int]:
    """Parse recurrence_config from sheet cell back to list[int]."""
    raw = (raw or "").strip()
    if not raw:
        return []
    out: list[int] = []
    for piece in raw.split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            out.append(int(float(piece)))
        except ValueError:
            continue
    return out


# ---------------- Dataclasses ----------------


@dataclass
class Unit:
    id: int
    name: str
    note: str = ""
    occupancies: list["Occupancy"] = field(default_factory=list)


@dataclass
class Occupancy:
    id: int
    unit_id: int
    tenant_count: int
    start_date: date
    end_date: date
    unit: Optional[Unit] = None


@dataclass
class BillUnit:
    id: int
    bill_id: int
    unit_id: int
    unit: Optional[Unit] = None


@dataclass
class Bill:
    id: int
    kind: str
    amount: float
    start_date: date
    end_date: date
    note: str = ""
    recurring_bill_id: Optional[int] = None
    assignments: list[BillUnit] = field(default_factory=list)


@dataclass
class RecurringBillUnit:
    id: int
    recurring_bill_id: int
    unit_id: int
    unit: Optional[Unit] = None


@dataclass
class RecurringBill:
    id: int
    kind: str
    amount: float
    recurrence: str
    recurrence_config: str = ""  # CSV in storage; parse via parse_recurrence_config
    start_date: date = field(default_factory=lambda: date.today())
    end_date: Optional[date] = None
    note: str = ""
    active: bool = True
    is_credit: bool = False
    assignments: list[RecurringBillUnit] = field(default_factory=list)


@dataclass
class Payment:
    id: int
    unit_id: int
    year: int
    month: int
    kind: str
    amount: float


@dataclass
class BillingKind:
    id: int
    name: str


@dataclass
class AuthorizedUser:
    id: int
    email: str


# ---------------- Row → dataclass converters ----------------


def _row_to_unit(r) -> Unit:
    return Unit(id=_int(r["id"]), name=r.get("name", ""), note=r.get("note", ""))


def _row_to_occupancy(r) -> Occupancy:
    return Occupancy(
        id=_int(r["id"]),
        unit_id=_int(r.get("unit_id", "")),
        tenant_count=_int(r.get("tenant_count", "0")),
        start_date=_parse_date(r.get("start_date", "")) or date.today(),
        end_date=_parse_date(r.get("end_date", "")) or date.today(),
    )


def _row_to_bill(r) -> Bill:
    return Bill(
        id=_int(r["id"]),
        kind=r.get("kind", ""),
        amount=_float(r.get("amount", "0")),
        start_date=_parse_date(r.get("start_date", "")) or date.today(),
        end_date=_parse_date(r.get("end_date", "")) or date.today(),
        note=r.get("note", ""),
        recurring_bill_id=_opt_int(r.get("recurring_bill_id", "")),
    )


def _row_to_bill_unit(r) -> BillUnit:
    return BillUnit(
        id=_int(r["id"]),
        bill_id=_int(r.get("bill_id", "")),
        unit_id=_int(r.get("unit_id", "")),
    )


def _row_to_recurring(r) -> RecurringBill:
    return RecurringBill(
        id=_int(r["id"]),
        kind=r.get("kind", ""),
        amount=_float(r.get("amount", "0")),
        note=r.get("note", ""),
        recurrence=r.get("recurrence", "monthly"),
        recurrence_config=(r.get("recurrence_config", "") or "").strip(),
        start_date=_parse_date(r.get("start_date", "")) or date.today(),
        end_date=_parse_date(r.get("end_date", "")),
        active=from_bool(r.get("active", "TRUE")),
        is_credit=from_bool(r.get("is_credit", "FALSE")),
    )


def _row_to_recurring_unit(r) -> RecurringBillUnit:
    return RecurringBillUnit(
        id=_int(r["id"]),
        recurring_bill_id=_int(r.get("recurring_bill_id", "")),
        unit_id=_int(r.get("unit_id", "")),
    )


def _row_to_payment(r) -> Payment:
    return Payment(
        id=_int(r["id"]),
        unit_id=_int(r.get("unit_id", "")),
        year=_int(r.get("year", "0")),
        month=_int(r.get("month", "0")),
        kind=r.get("kind", ""),
        amount=_float(r.get("amount", "0")),
    )


def _row_to_category(r) -> BillingKind:
    return BillingKind(id=_int(r["id"]), name=r.get("name", ""))


def _row_to_user(r) -> AuthorizedUser:
    return AuthorizedUser(id=_int(r["id"]), email=r.get("email", ""))


# ---------------- Setup / seeding ----------------


def admin_email() -> str:
    return os.environ.get("ADMIN_EMAIL", "").strip().lower()


def init_db() -> None:
    """Ensure every tab exists with the right header row."""
    b = get_backend()
    for tab, cols in TABS.items():
        b.ensure_tab(tab, cols)


def seed_authorized_users() -> None:
    rows = get_backend().read_table("authorized_users")
    existing = {(r.get("email") or "").strip().lower() for r in rows}
    for email in (admin_email(), *SEED_EMAILS):
        e = (email or "").strip().lower()
        if e and e not in existing:
            authorized_user_create(e)


def seed_billing_kinds() -> None:
    """Seed default categories only on a brand-new sheet (no rows)."""
    rows = get_backend().read_table("categories")
    if rows:
        return
    for name in DEFAULT_CATEGORIES:
        category_create(name)


# ---------------- Units ----------------


def units_all() -> list[Unit]:
    rows = get_backend().read_table("units")
    units = [_row_to_unit(r) for r in rows]
    units.sort(key=lambda u: (u.name or "").lower())
    return units


def units_with_occupancies() -> list[Unit]:
    units = units_all()
    by_id = {u.id: u for u in units}
    for o in occupancies_all():
        u = by_id.get(o.unit_id)
        if u is not None:
            u.occupancies.append(o)
    for u in units:
        u.occupancies.sort(key=lambda o: o.start_date)
    return units


def unit_by_id(uid: int) -> Optional[Unit]:
    for r in get_backend().read_table("units"):
        if _int(r["id"]) == uid:
            return _row_to_unit(r)
    return None


def unit_create(name: str, note: str = "") -> Unit:
    rows = get_backend().read_table("units")
    new_id = next_id(rows)
    get_backend().append_row("units", {
        "id": to_str(new_id), "name": to_str(name), "note": to_str(note),
    })
    return Unit(id=new_id, name=name, note=note)


def unit_update(uid: int, **fields) -> None:
    get_backend().update_row("units", uid, {k: to_str(v) for k, v in fields.items()})


def unit_delete(uid: int) -> None:
    # Cascade: remove the unit's occupancies, BillUnit + RecurringBillUnit rows,
    # and payments. Bills themselves remain (they may have other units too).
    for o in occupancies_for_unit(uid):
        occupancy_delete(o.id)
    for bu in bill_units_all():
        if bu.unit_id == uid:
            get_backend().delete_row("bill_units", bu.id)
    for rbu in recurring_bill_units_all():
        if rbu.unit_id == uid:
            get_backend().delete_row("recurring_bill_units", rbu.id)
    for p in payments_all():
        if p.unit_id == uid:
            get_backend().delete_row("payments", p.id)
    get_backend().delete_row("units", uid)


# ---------------- Occupancies ----------------


def occupancies_all() -> list[Occupancy]:
    return [_row_to_occupancy(r) for r in get_backend().read_table("occupancies")]


def occupancies_for_unit(uid: int) -> list[Occupancy]:
    return [o for o in occupancies_all() if o.unit_id == uid]


def occupancies_for_units(uids: set[int]) -> dict[int, list[Occupancy]]:
    out: dict[int, list[Occupancy]] = {uid: [] for uid in uids}
    for o in occupancies_all():
        if o.unit_id in out:
            out[o.unit_id].append(o)
    return out


def occupancy_by_id(oid: int) -> Optional[Occupancy]:
    for r in get_backend().read_table("occupancies"):
        if _int(r["id"]) == oid:
            o = _row_to_occupancy(r)
            o.unit = unit_by_id(o.unit_id)
            return o
    return None


def occupancy_create(unit_id: int, tenant_count: int, start_date: date, end_date: date) -> Occupancy:
    rows = get_backend().read_table("occupancies")
    new_id = next_id(rows)
    get_backend().append_row("occupancies", {
        "id": to_str(new_id),
        "unit_id": to_str(unit_id),
        "tenant_count": to_str(tenant_count),
        "start_date": to_str(start_date),
        "end_date": to_str(end_date),
    })
    return Occupancy(id=new_id, unit_id=unit_id, tenant_count=tenant_count,
                     start_date=start_date, end_date=end_date)


def occupancy_update(oid: int, **fields) -> None:
    get_backend().update_row("occupancies", oid, {k: to_str(v) for k, v in fields.items()})


def occupancy_delete(oid: int) -> None:
    get_backend().delete_row("occupancies", oid)


# ---------------- Bills ----------------


def bills_all() -> list[Bill]:
    return [_row_to_bill(r) for r in get_backend().read_table("bills")]


def bills_one_off() -> list[Bill]:
    return [b for b in bills_all() if b.recurring_bill_id is None]


def bills_with_assignments() -> list[Bill]:
    """Return every bill with .assignments[].unit fully populated."""
    bills = bills_all()
    units_by_id = {u.id: u for u in units_all()}
    by_bill: dict[int, list[BillUnit]] = {}
    for r in get_backend().read_table("bill_units"):
        bu = _row_to_bill_unit(r)
        bu.unit = units_by_id.get(bu.unit_id)
        by_bill.setdefault(bu.bill_id, []).append(bu)
    for b in bills:
        b.assignments = by_bill.get(b.id, [])
    return bills


def bill_by_id(bid: int, with_assignments: bool = False) -> Optional[Bill]:
    for r in get_backend().read_table("bills"):
        if _int(r["id"]) == bid:
            bill = _row_to_bill(r)
            if with_assignments:
                units_by_id = {u.id: u for u in units_all()}
                for br in get_backend().read_table("bill_units"):
                    bu = _row_to_bill_unit(br)
                    if bu.bill_id == bid:
                        bu.unit = units_by_id.get(bu.unit_id)
                        bill.assignments.append(bu)
            return bill
    return None


def bills_for_unit(uid: int, with_assignments: bool = False) -> list[Bill]:
    bill_ids = {
        _int(r.get("bill_id", "")) for r in get_backend().read_table("bill_units")
        if _int(r.get("unit_id", "")) == uid
    }
    bills = [_row_to_bill(r) for r in get_backend().read_table("bills")
             if _int(r["id"]) in bill_ids]
    if with_assignments:
        units_by_id = {u.id: u for u in units_all()}
        by_bill: dict[int, list[BillUnit]] = {}
        for br in get_backend().read_table("bill_units"):
            bu = _row_to_bill_unit(br)
            bu.unit = units_by_id.get(bu.unit_id)
            by_bill.setdefault(bu.bill_id, []).append(bu)
        for b in bills:
            b.assignments = by_bill.get(b.id, [])
    return bills


def bill_create(*, kind: str, amount: float, start_date: date, end_date: date,
                note: str = "", recurring_bill_id: Optional[int] = None,
                unit_ids: list[int] | None = None) -> Bill:
    rows = get_backend().read_table("bills")
    new_id = next_id(rows)
    get_backend().append_row("bills", {
        "id": to_str(new_id),
        "kind": to_str(kind),
        "amount": to_str(amount),
        "start_date": to_str(start_date),
        "end_date": to_str(end_date),
        "note": to_str(note),
        "recurring_bill_id": to_str(recurring_bill_id) if recurring_bill_id is not None else "",
    })
    if unit_ids:
        for uid in unit_ids:
            bill_unit_create(new_id, uid)
    return Bill(id=new_id, kind=kind, amount=amount, start_date=start_date,
                end_date=end_date, note=note, recurring_bill_id=recurring_bill_id)


def bill_update(bid: int, *, unit_ids: list[int] | None = None, **fields) -> None:
    if "recurring_bill_id" in fields and fields["recurring_bill_id"] is None:
        fields["recurring_bill_id"] = ""
    get_backend().update_row("bills", bid, {k: to_str(v) for k, v in fields.items()})
    if unit_ids is not None:
        bill_units_replace(bid, unit_ids)


def bill_delete(bid: int) -> None:
    for bu in bill_units_all():
        if bu.bill_id == bid:
            get_backend().delete_row("bill_units", bu.id)
    get_backend().delete_row("bills", bid)


# ---------------- BillUnit (M2M) ----------------


def bill_units_all() -> list[BillUnit]:
    return [_row_to_bill_unit(r) for r in get_backend().read_table("bill_units")]


def bill_unit_create(bill_id: int, unit_id: int) -> None:
    rows = get_backend().read_table("bill_units")
    new_id = next_id(rows)
    get_backend().append_row("bill_units", {
        "id": to_str(new_id), "bill_id": to_str(bill_id), "unit_id": to_str(unit_id),
    })


def bill_units_replace(bid: int, unit_ids: list[int]) -> None:
    for bu in bill_units_all():
        if bu.bill_id == bid:
            get_backend().delete_row("bill_units", bu.id)
    for uid in unit_ids:
        bill_unit_create(bid, uid)


# ---------------- Recurring bills ----------------


def recurring_all() -> list[RecurringBill]:
    return [_row_to_recurring(r) for r in get_backend().read_table("recurring_bills")]


def recurring_with_assignments() -> list[RecurringBill]:
    rbs = recurring_all()
    units_by_id = {u.id: u for u in units_all()}
    by_rb: dict[int, list[RecurringBillUnit]] = {}
    for r in get_backend().read_table("recurring_bill_units"):
        rbu = _row_to_recurring_unit(r)
        rbu.unit = units_by_id.get(rbu.unit_id)
        by_rb.setdefault(rbu.recurring_bill_id, []).append(rbu)
    for rb in rbs:
        rb.assignments = by_rb.get(rb.id, [])
    return rbs


def recurring_by_id(rid: int) -> Optional[RecurringBill]:
    for r in get_backend().read_table("recurring_bills"):
        if _int(r["id"]) == rid:
            return _row_to_recurring(r)
    return None


def recurring_unit_ids(rid: int) -> list[int]:
    return [
        _int(r.get("unit_id", ""))
        for r in get_backend().read_table("recurring_bill_units")
        if _int(r.get("recurring_bill_id", "")) == rid
    ]


def recurring_create(*, kind: str, amount: float, recurrence: str,
                     recurrence_config, start_date: date,
                     end_date: Optional[date] = None,
                     note: str = "", active: bool = True,
                     is_credit: bool = False,
                     unit_ids: list[int] | None = None) -> RecurringBill:
    rows = get_backend().read_table("recurring_bills")
    new_id = next_id(rows)
    get_backend().append_row("recurring_bills", {
        "id": to_str(new_id),
        "kind": to_str(kind),
        "amount": to_str(amount),
        "note": to_str(note),
        "recurrence": to_str(recurrence),
        "recurrence_config": _config_to_csv(recurrence_config),
        "start_date": to_str(start_date),
        "end_date": to_str(end_date) if end_date else "",
        "active": to_str(active),
        "is_credit": to_str(is_credit),
    })
    if unit_ids:
        for uid in unit_ids:
            recurring_unit_create(new_id, uid)
    return RecurringBill(
        id=new_id, kind=kind, amount=amount, recurrence=recurrence,
        recurrence_config=_config_to_csv(recurrence_config),
        start_date=start_date, end_date=end_date, note=note,
        active=active, is_credit=is_credit,
    )


def recurring_update(rid: int, *, unit_ids: list[int] | None = None, **fields) -> None:
    if "recurrence_config" in fields:
        fields["recurrence_config"] = _config_to_csv(fields["recurrence_config"])
    if "end_date" in fields and fields["end_date"] is None:
        fields["end_date"] = ""
    get_backend().update_row("recurring_bills", rid, {k: to_str(v) for k, v in fields.items()})
    if unit_ids is not None:
        recurring_unit_ids_replace(rid, unit_ids)


def recurring_delete(rid: int) -> None:
    # Cascade: remove its generated bills and unit assignments.
    for b in bills_all():
        if b.recurring_bill_id == rid:
            bill_delete(b.id)
    for rbu in recurring_bill_units_all():
        if rbu.recurring_bill_id == rid:
            get_backend().delete_row("recurring_bill_units", rbu.id)
    get_backend().delete_row("recurring_bills", rid)


# ---------------- RecurringBillUnit (M2M) ----------------


def recurring_bill_units_all() -> list[RecurringBillUnit]:
    return [_row_to_recurring_unit(r) for r in get_backend().read_table("recurring_bill_units")]


def recurring_unit_create(recurring_bill_id: int, unit_id: int) -> None:
    rows = get_backend().read_table("recurring_bill_units")
    new_id = next_id(rows)
    get_backend().append_row("recurring_bill_units", {
        "id": to_str(new_id),
        "recurring_bill_id": to_str(recurring_bill_id),
        "unit_id": to_str(unit_id),
    })


def recurring_unit_ids_replace(rid: int, unit_ids: list[int]) -> None:
    for rbu in recurring_bill_units_all():
        if rbu.recurring_bill_id == rid:
            get_backend().delete_row("recurring_bill_units", rbu.id)
    for uid in unit_ids:
        recurring_unit_create(rid, uid)


# ---------------- Payments ----------------


def payments_all() -> list[Payment]:
    return [_row_to_payment(r) for r in get_backend().read_table("payments")]


def payment_lookup(unit_id: int, year: int, month: int, kind: str) -> Optional[Payment]:
    for p in payments_all():
        if (p.unit_id == unit_id and p.year == year
                and p.month == month and p.kind == kind):
            return p
    return None


def payment_upsert(unit_id: int, year: int, month: int, kind: str, amount: float) -> None:
    existing = payment_lookup(unit_id, year, month, kind)
    if existing is not None:
        get_backend().update_row("payments", existing.id, {"amount": to_str(amount)})
        return
    rows = get_backend().read_table("payments")
    new_id = next_id(rows)
    get_backend().append_row("payments", {
        "id": to_str(new_id),
        "unit_id": to_str(unit_id),
        "year": to_str(year),
        "month": to_str(month),
        "kind": to_str(kind),
        "amount": to_str(amount),
    })


# ---------------- Categories (billing kinds) ----------------


def categories_all() -> list[BillingKind]:
    cats = [_row_to_category(r) for r in get_backend().read_table("categories")]
    cats.sort(key=lambda c: (c.name or "").lower())
    return cats


def category_names() -> list[str]:
    return [c.name for c in categories_all()]


def category_by_id(cid: int) -> Optional[BillingKind]:
    for r in get_backend().read_table("categories"):
        if _int(r["id"]) == cid:
            return _row_to_category(r)
    return None


def category_by_name(name: str) -> Optional[BillingKind]:
    name = name.strip().lower()
    for r in get_backend().read_table("categories"):
        if (r.get("name") or "").strip().lower() == name:
            return _row_to_category(r)
    return None


def category_create(name: str) -> BillingKind:
    rows = get_backend().read_table("categories")
    new_id = next_id(rows)
    get_backend().append_row("categories", {"id": to_str(new_id), "name": to_str(name)})
    return BillingKind(id=new_id, name=name)


def category_delete(cid: int) -> None:
    get_backend().delete_row("categories", cid)


# ---------------- Authorized users ----------------


def authorized_users_all() -> list[AuthorizedUser]:
    rows = [_row_to_user(r) for r in get_backend().read_table("authorized_users")]
    rows.sort(key=lambda u: (u.email or "").lower())
    return rows


def authorized_user_by_id(uid: int) -> Optional[AuthorizedUser]:
    for r in get_backend().read_table("authorized_users"):
        if _int(r["id"]) == uid:
            return _row_to_user(r)
    return None


def authorized_user_by_email(email: str) -> Optional[AuthorizedUser]:
    email = email.strip().lower()
    for r in get_backend().read_table("authorized_users"):
        if (r.get("email") or "").strip().lower() == email:
            return _row_to_user(r)
    return None


def authorized_user_create(email: str) -> AuthorizedUser:
    rows = get_backend().read_table("authorized_users")
    new_id = next_id(rows)
    get_backend().append_row("authorized_users", {
        "id": to_str(new_id), "email": to_str(email.strip().lower()),
    })
    return AuthorizedUser(id=new_id, email=email.strip().lower())


def authorized_user_update(uid: int, email: str) -> None:
    get_backend().update_row("authorized_users", uid,
                              {"email": to_str(email.strip().lower())})


def authorized_user_delete(uid: int) -> None:
    get_backend().delete_row("authorized_users", uid)

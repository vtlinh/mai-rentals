import calendar
import json
from dataclasses import dataclass
from datetime import date, timedelta

from app.db import Bill, Occupancy


def _overlap_days(a_start: date, a_end: date, b_start: date, b_end: date) -> int:
    start = max(a_start, b_start)
    end = min(a_end, b_end)
    if start > end:
        return 0
    return (end - start).days + 1


def unit_person_days(unit_occupancies: list[Occupancy], bill: Bill) -> int:
    total = 0
    for occ in unit_occupancies:
        days = _overlap_days(occ.start_date, occ.end_date, bill.start_date, bill.end_date)
        total += days * occ.tenant_count
    return total


@dataclass
class UnitShare:
    unit_id: int
    unit_name: str
    person_days: int
    amount: float


def split_bill(bill: Bill, unit_occupancies_map: dict[int, list[Occupancy]]) -> list[UnitShare]:
    """Split bill by person-days across its assigned units.

    unit_occupancies_map: unit_id -> list of Occupancy rows for that unit.
    """
    shares: list[UnitShare] = []
    person_days_by_unit: dict[int, int] = {}
    for assignment in bill.assignments:
        uid = assignment.unit_id
        occs = unit_occupancies_map.get(uid, [])
        person_days_by_unit[uid] = unit_person_days(occs, bill)

    total = sum(person_days_by_unit.values())
    for assignment in bill.assignments:
        uid = assignment.unit_id
        pd = person_days_by_unit[uid]
        amount = (pd / total * bill.amount) if total > 0 else 0.0
        shares.append(
            UnitShare(
                unit_id=uid,
                unit_name=assignment.unit.name,
                person_days=pd,
                amount=round(amount, 2),
            )
        )
    return shares


def bill_due_date(bill_end: date) -> date:
    """First day of the month following the bill's end date."""
    if bill_end.month == 12:
        return date(bill_end.year + 1, 1, 1)
    return date(bill_end.year, bill_end.month + 1, 1)


def month_bounds(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return start, next_month - timedelta(days=1)


def next_month(today: date) -> tuple[int, int]:
    if today.month == 12:
        return today.year + 1, 1
    return today.year, today.month + 1


def recurring_instances(rb, today: date) -> list[tuple[date, date]]:
    """Return (start, end) date pairs for all bill periods that should exist up to today.

    Deduplication key per recurrence type:
      daily   → (rb.id, that day)           — 1-day period
      weekly  → (rb.id, Monday of week)     — Mon–Sun period
      monthly → (rb.id, 1st of month)       — full-month period
      yearly  → (rb.id, 1st of that month)  — full-month period
    """
    start = rb.start_date
    recurrence = rb.recurrence
    config: list[int] = json.loads(rb.recurrence_config or "[]")
    instances: list[tuple[date, date]] = []

    # Optional cap: never generate periods that begin after the template's end_date.
    end_cap = getattr(rb, "end_date", None)
    if end_cap is not None and end_cap < today:
        today = end_cap

    if recurrence == "daily":
        d = start
        while d <= today:
            instances.append((d, d))
            d += timedelta(days=1)

    elif recurrence == "weekly":
        # config = weekday indices [0=Mon..6=Sun]; default Monday
        active_days = sorted(config) if config else [0]
        # Walk week by week (Monday-anchored); emit one bill per week when any
        # selected weekday falls on or after start_date and on or before today.
        monday = start - timedelta(days=start.weekday())
        while monday <= today:
            sunday = monday + timedelta(days=6)
            for wd in active_days:
                trigger = monday + timedelta(days=wd)
                if trigger >= start and trigger <= today:
                    instances.append((monday, sunday))
                    break
            monday += timedelta(days=7)

    elif recurrence == "monthly":
        # config = day-of-month list [1-31]; default 1st
        active_days = sorted(config) if config else [1]
        y, m = start.year, start.month
        while (y, m) <= (today.year, today.month):
            _, last = calendar.monthrange(y, m)
            for day in active_days:
                trigger = date(y, m, min(day, last))
                if trigger >= start and trigger <= today:
                    instances.append((date(y, m, 1), date(y, m, last)))
                    break
            m += 1
            if m > 12:
                y, m = y + 1, 1

    elif recurrence == "yearly":
        # config = month numbers [1-12]; default January
        active_months = sorted(config) if config else [1]
        for y in range(start.year, today.year + 1):
            for month in active_months:
                _, last = calendar.monthrange(y, month)
                bill_start = date(y, month, 1)
                if bill_start >= start and bill_start <= today:
                    instances.append((bill_start, date(y, month, last)))

    return instances

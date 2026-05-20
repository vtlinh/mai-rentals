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

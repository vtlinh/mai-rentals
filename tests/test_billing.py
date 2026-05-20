from datetime import date
from types import SimpleNamespace

from app.billing import bill_due_date, month_bounds, next_month, split_bill, unit_person_days


def _occ(start, end, count):
    return SimpleNamespace(start_date=start, end_date=end, tenant_count=count)


def _bill(start, end, amount, assignments):
    return SimpleNamespace(start_date=start, end_date=end, amount=amount, assignments=assignments)


def _assignment(unit_id, name):
    return SimpleNamespace(unit_id=unit_id, unit=SimpleNamespace(id=unit_id, name=name))


def test_overlap_person_days_full_period():
    occ = _occ(date(2026, 2, 1), date(2026, 5, 31), 3)
    bill = _bill(date(2026, 2, 5), date(2026, 3, 4), 100.0, [])
    # 2/5 .. 3/4 inclusive = 28 days; 3 tenants -> 84
    assert unit_person_days([occ], bill) == 28 * 3


def test_example_from_spec():
    """Spec example: bill 2/5-3/4 = $100.
    Unit 1: 3 tenants, occupies 2/1-5/31 -> overlap 2/5-3/4 (28 days) -> 84 person-days.
    Unit 2: 5 tenants, occupies 2/15-5/31 -> overlap 2/15-3/4 (18 days) -> 90 person-days.
    Total = 174. Unit 1 = 100*84/174, Unit 2 = 100*90/174.
    """
    bill = _bill(
        date(2026, 2, 5),
        date(2026, 3, 4),
        100.0,
        [_assignment(1, "Unit 1"), _assignment(2, "Unit 2")],
    )
    occ_map = {
        1: [_occ(date(2026, 2, 1), date(2026, 5, 31), 3)],
        2: [_occ(date(2026, 2, 15), date(2026, 5, 31), 5)],
    }
    shares = split_bill(bill, occ_map)
    by_name = {s.unit_name: s for s in shares}
    assert by_name["Unit 1"].person_days == 84
    assert by_name["Unit 2"].person_days == 90
    assert by_name["Unit 1"].amount == round(100 * 84 / 174, 2)
    assert by_name["Unit 2"].amount == round(100 * 90 / 174, 2)
    assert round(by_name["Unit 1"].amount + by_name["Unit 2"].amount, 2) == 100.00


def test_no_overlap_yields_zero():
    bill = _bill(date(2026, 2, 1), date(2026, 2, 28), 50.0, [_assignment(1, "U1")])
    occ_map = {1: [_occ(date(2026, 3, 1), date(2026, 3, 31), 2)]}
    shares = split_bill(bill, occ_map)
    assert shares[0].amount == 0.0


def test_bill_due_date_is_first_of_next_month():
    assert bill_due_date(date(2026, 3, 4)) == date(2026, 4, 1)
    assert bill_due_date(date(2026, 3, 31)) == date(2026, 4, 1)
    assert bill_due_date(date(2026, 12, 15)) == date(2027, 1, 1)


def test_month_bounds_and_next_month():
    assert month_bounds(2026, 2) == (date(2026, 2, 1), date(2026, 2, 28))
    assert month_bounds(2024, 2) == (date(2024, 2, 1), date(2024, 2, 29))
    assert month_bounds(2026, 12) == (date(2026, 12, 1), date(2026, 12, 31))
    assert next_month(date(2026, 5, 20)) == (2026, 6)
    assert next_month(date(2026, 12, 15)) == (2027, 1)

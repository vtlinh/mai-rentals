import json
from collections import defaultdict
from datetime import date, datetime

from flask import Blueprint, flash, redirect, render_template, request, url_for
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.auth import current_email, is_admin, is_authorized
from app.billing import bill_due_date, recurring_instances, split_bill
from app.db import (
    AuthorizedUser,
    Bill,
    BillingKind,
    BillUnit,
    Occupancy,
    Payment,
    RecurringBill,
    RecurringBillUnit,
    Unit,
    admin_email,
    get_session,
)

bp = Blueprint("main", __name__)

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


@bp.before_request
def _require_login():
    email = current_email()
    if not email or not is_authorized(email):
        return redirect(url_for("auth.login", next=request.path))


def _require_admin():
    if not is_admin(current_email()):
        from flask import abort
        abort(403)


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _kind_names(s) -> list[str]:
    return [k.name for k in s.scalars(select(BillingKind).order_by(BillingKind.name)).all()]


@bp.route("/")
def index():
    return redirect(url_for("main.dashboard"))


@bp.route("/dashboard")
def dashboard():
    with get_session() as s:
        all_bills = s.scalars(
            select(Bill)
            .options(selectinload(Bill.assignments).selectinload(BillUnit.unit))
        ).all()

        unit_ids = {a.unit_id for b in all_bills for a in b.assignments}
        occ_map: dict[int, list[Occupancy]] = defaultdict(list)
        if unit_ids:
            occs = s.scalars(
                select(Occupancy).where(Occupancy.unit_id.in_(unit_ids))
            ).all()
            for o in occs:
                occ_map[o.unit_id].append(o)

        # Group bills by (year, month) of their due date.
        by_month: dict[tuple[int, int], list[Bill]] = defaultdict(list)
        for b in all_bills:
            due = bill_due_date(b.end_date)
            by_month[(due.year, due.month)].append(b)

        # unit name -> id (for payment lookups)
        units_by_id = {u.id: u for u in s.scalars(select(Unit)).all()}
        name_to_id = {u.name: u.id for u in units_by_id.values()}

        # All payments keyed by (unit_id, year, month, kind).
        all_payments = s.scalars(select(Payment)).all()
        pay_map: dict[tuple[int, int, int, str], Payment] = {
            (p.unit_id, p.year, p.month, p.kind): p for p in all_payments
        }

        # Outstanding-by-unit totals across all months.
        outstanding: dict[str, float] = defaultdict(float)

        months = []
        for key in sorted(by_month.keys(), reverse=True):
            year, month = key
            bills = sorted(by_month[key], key=lambda b: (b.kind.lower(), b.end_date))
            bill_rows = []
            # totals[unit_name][kind] = amount
            totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
            kinds_present: set[str] = set()
            for b in bills:
                shares = split_bill(b, occ_map)
                bill_total = sum(sh.amount for sh in shares)
                bill_rows.append({"bill": b, "total": bill_total})
                kinds_present.add(b.kind)
                for sh in shares:
                    totals[sh.unit_name][b.kind] += sh.amount

            kinds_sorted = sorted(kinds_present)
            unit_rows = []
            for unit_name in sorted(totals.keys()):
                by_kind = totals[unit_name]
                row_total = sum(by_kind.values())
                if round(row_total, 2) == 0:
                    continue
                uid = name_to_id.get(unit_name)
                cells = []
                for k in kinds_sorted:
                    owed = round(by_kind.get(k, 0.0), 2)
                    payment = pay_map.get((uid, year, month, k)) if uid else None
                    paid = round(payment.amount, 2) if payment else 0.0
                    remaining = round(owed - paid, 2)
                    cells.append(
                        {
                            "kind": k,
                            "amount": owed,
                            "paid": paid,
                            "remaining": remaining,
                            "has_payment": payment is not None,
                        }
                    )
                    if owed > 0:
                        outstanding[unit_name] += max(remaining, 0.0)
                unit_rows.append(
                    {
                        "unit_name": unit_name,
                        "unit_id": uid,
                        "cells": cells,
                        "total": round(row_total, 2),
                    }
                )

            months.append(
                {
                    "year": year,
                    "month": month,
                    "kinds": kinds_sorted,
                    "unit_rows": unit_rows,
                    "bill_rows": bill_rows,
                }
            )

        outstanding_rows = [
            (name, round(amt, 2)) for name, amt in sorted(outstanding.items()) if round(amt, 2) > 0
        ]
        return render_template(
            "dashboard.html", months=months, outstanding_rows=outstanding_rows
        )


# ---------------- Units ----------------


@bp.route("/units")
def units_list():
    with get_session() as s:
        units = s.scalars(
            select(Unit).options(selectinload(Unit.occupancies)).order_by(Unit.name)
        ).all()
        return render_template("units.html", units=units)


@bp.route("/units/new", methods=["GET", "POST"])
def units_new():
    if request.method == "POST":
        name = request.form["name"].strip()
        note = request.form.get("note", "").strip()
        with get_session() as s:
            s.add(Unit(name=name, note=note))
        flash(f"Unit '{name}' added.")
        return redirect(url_for("main.units_list"))
    return render_template("unit_form.html", unit=None)


@bp.route("/units/<int:uid>/edit", methods=["GET", "POST"])
def units_edit(uid: int):
    with get_session() as s:
        unit = s.get(Unit, uid)
        if unit is None:
            flash("Unit not found.")
            return redirect(url_for("main.units_list"))
        if request.method == "POST":
            unit.name = request.form["name"].strip()
            unit.note = request.form.get("note", "").strip()
            flash("Unit updated.")
            return redirect(url_for("main.units_list"))
        return render_template("unit_form.html", unit=unit)


@bp.route("/units/<int:uid>/delete", methods=["POST"])
def units_delete(uid: int):
    with get_session() as s:
        unit = s.get(Unit, uid)
        if unit:
            s.delete(unit)
            flash(f"Unit '{unit.name}' removed.")
    return redirect(url_for("main.units_list"))


# ---------------- Occupancies ----------------


@bp.route("/units/<int:uid>/occupancies/new", methods=["GET", "POST"])
def occ_new(uid: int):
    with get_session() as s:
        unit = s.get(Unit, uid)
        if unit is None:
            return redirect(url_for("main.units_list"))
        if request.method == "POST":
            s.add(
                Occupancy(
                    unit_id=uid,
                    tenant_count=int(request.form["tenant_count"]),
                    start_date=_parse_date(request.form["start_date"]),
                    end_date=_parse_date(request.form["end_date"]),
                )
            )
            flash("Occupancy added.")
            return redirect(url_for("main.units_edit", uid=uid))
        # The add form lives inline on the unit edit page.
        return redirect(url_for("main.units_edit", uid=uid))


@bp.route("/occupancies/<int:oid>/edit", methods=["GET", "POST"])
def occ_edit(oid: int):
    with get_session() as s:
        occ = s.get(Occupancy, oid)
        if occ is None:
            return redirect(url_for("main.units_list"))
        uid = occ.unit_id
        if request.method == "POST":
            occ.tenant_count = int(request.form["tenant_count"])
            occ.start_date = _parse_date(request.form["start_date"])
            occ.end_date = _parse_date(request.form["end_date"])
            flash("Occupancy updated.")
            return redirect(url_for("main.units_edit", uid=uid))
        # Editing happens inline on the unit edit page.
        return redirect(url_for("main.units_edit", uid=uid))


@bp.route("/occupancies/<int:oid>/delete", methods=["POST"])
def occ_delete(oid: int):
    with get_session() as s:
        occ = s.get(Occupancy, oid)
        uid = occ.unit_id if occ else None
        if occ:
            s.delete(occ)
            flash("Occupancy removed.")
    if uid:
        return redirect(url_for("main.units_edit", uid=uid))
    return redirect(url_for("main.units_list"))


# ---------------- Bills ----------------


@bp.route("/bills")
def bills_list():
    with get_session() as s:
        bills = s.scalars(
            select(Bill)
            .options(selectinload(Bill.assignments).selectinload(BillUnit.unit))
            .order_by(Bill.end_date.desc())
        ).all()
        return render_template("bills.html", bills=bills)


@bp.route("/bills/new", methods=["GET", "POST"])
def bills_new():
    with get_session() as s:
        units = s.scalars(select(Unit).order_by(Unit.name)).all()
        kinds = _kind_names(s)
        if request.method == "POST":
            bill = Bill(
                kind=request.form["kind"],
                amount=float(request.form["amount"]),
                start_date=_parse_date(request.form["start_date"]),
                end_date=_parse_date(request.form["end_date"]),
                note=request.form.get("note", "").strip(),
            )
            s.add(bill)
            s.flush()
            for uid in request.form.getlist("unit_ids"):
                s.add(BillUnit(bill_id=bill.id, unit_id=int(uid)))
            flash("Bill added.")
            return redirect(url_for("main.bills_list"))
        return render_template("bill_form.html", bill=None, units=units, selected_ids=set(), kinds=kinds)


@bp.route("/bills/<int:bid>/edit", methods=["GET", "POST"])
def bills_edit(bid: int):
    with get_session() as s:
        bill = s.get(Bill, bid)
        if bill is None:
            return redirect(url_for("main.bills_list"))
        units = s.scalars(select(Unit).order_by(Unit.name)).all()
        kinds = _kind_names(s)
        if request.method == "POST":
            bill.kind = request.form["kind"]
            bill.amount = float(request.form["amount"])
            bill.start_date = _parse_date(request.form["start_date"])
            bill.end_date = _parse_date(request.form["end_date"])
            bill.note = request.form.get("note", "").strip()
            for a in list(bill.assignments):
                s.delete(a)
            s.flush()
            for uid in request.form.getlist("unit_ids"):
                s.add(BillUnit(bill_id=bill.id, unit_id=int(uid)))
            flash("Bill updated.")
            return redirect(url_for("main.bills_list"))
        selected = {a.unit_id for a in bill.assignments}
        return render_template("bill_form.html", bill=bill, units=units, selected_ids=selected, kinds=kinds)


@bp.route("/bills/<int:bid>/delete", methods=["POST"])
def bills_delete(bid: int):
    with get_session() as s:
        bill = s.get(Bill, bid)
        if bill:
            s.delete(bill)
            flash("Bill removed.")
    return redirect(url_for("main.bills_list"))


@bp.route("/bills/<int:bid>")
def bills_detail(bid: int):
    with get_session() as s:
        bill = s.get(
            Bill,
            bid,
            options=[selectinload(Bill.assignments).selectinload(BillUnit.unit)],
        )
        if bill is None:
            return redirect(url_for("main.bills_list"))
        unit_ids = {a.unit_id for a in bill.assignments}
        occ_map: dict[int, list[Occupancy]] = defaultdict(list)
        if unit_ids:
            occs = s.scalars(
                select(Occupancy).where(Occupancy.unit_id.in_(unit_ids))
            ).all()
            for o in occs:
                occ_map[o.unit_id].append(o)
        shares = split_bill(bill, occ_map)
        return render_template("bill_detail.html", bill=bill, shares=shares)


# ---------------- Billing Kinds (admin only) ----------------


@bp.route("/kinds")
def kinds_list():
    _require_admin()
    with get_session() as s:
        kinds = s.scalars(select(BillingKind).order_by(BillingKind.name)).all()
        return render_template("billing_kinds.html", kinds=kinds)


@bp.route("/kinds/new", methods=["GET", "POST"])
def kinds_new():
    _require_admin()
    if request.method == "POST":
        name = request.form["name"].strip().lower()
        if not name:
            flash("Name is required.")
            return render_template("billing_kind_form.html")
        with get_session() as s:
            existing = s.scalar(select(BillingKind).where(BillingKind.name == name))
            if existing:
                flash(f"'{name}' already exists.")
            else:
                s.add(BillingKind(name=name))
                flash(f"Added billing kind '{name}'.")
        return redirect(url_for("main.kinds_list"))
    return render_template("billing_kind_form.html")


@bp.route("/kinds/<int:kid>/delete", methods=["POST"])
def kinds_delete(kid: int):
    _require_admin()
    with get_session() as s:
        kind = s.get(BillingKind, kid)
        if kind:
            s.delete(kind)
            flash(f"Removed billing kind '{kind.name}'.")
    return redirect(url_for("main.kinds_list"))


# ---------------- Recurring Bills ----------------


def _apply_recurring_bills(s) -> int:
    """Generate missing Bill instances for all active recurring bills up to today.
    Returns count of new bills created."""
    today = date.today()
    active_rbs = s.scalars(
        select(RecurringBill).where(RecurringBill.active == True)  # noqa: E712
    ).all()

    created = 0
    for rb in active_rbs:
        existing_starts: set[date] = set(
            s.scalars(select(Bill.start_date).where(Bill.recurring_bill_id == rb.id)).all()
        )
        unit_ids = [
            rbu.unit_id
            for rbu in s.scalars(
                select(RecurringBillUnit).where(RecurringBillUnit.recurring_bill_id == rb.id)
            ).all()
        ]
        for start, end in recurring_instances(rb, today):
            if start in existing_starts:
                continue
            bill = Bill(
                kind=rb.kind,
                amount=rb.amount,
                start_date=start,
                end_date=end,
                note=rb.note,
                recurring_bill_id=rb.id,
            )
            s.add(bill)
            s.flush()
            for uid in unit_ids:
                s.add(BillUnit(bill_id=bill.id, unit_id=uid))
            existing_starts.add(start)
            created += 1

    return created


@bp.route("/recurring")
def recurring_list():
    with get_session() as s:
        created = _apply_recurring_bills(s)
        if created:
            flash(f"Generated {created} new bill{'s' if created != 1 else ''} from recurring templates.")

        rbs = s.scalars(
            select(RecurringBill).order_by(RecurringBill.kind, RecurringBill.id)
        ).all()
        # Attach unit names
        rb_units: dict[int, list[str]] = defaultdict(list)
        for rbu in s.scalars(
            select(RecurringBillUnit).options(selectinload(RecurringBillUnit.unit))
        ).all():
            rb_units[rbu.recurring_bill_id].append(rbu.unit.name)

        # Count generated bills per template (single query, keyed by recurring_bill_id)
        from sqlalchemy import func
        count_rows = s.execute(
            select(Bill.recurring_bill_id, func.count(Bill.id).label("cnt"))
            .where(Bill.recurring_bill_id.is_not(None))
            .group_by(Bill.recurring_bill_id)
        ).all()
        rb_counts: dict[int, int] = {row[0]: row[1] for row in count_rows}

        rows = []
        for rb in rbs:
            cfg = json.loads(rb.recurrence_config or "[]")
            rows.append({
                "rb": rb,
                "unit_names": sorted(rb_units.get(rb.id, [])),
                "config_display": _config_display(rb.recurrence, cfg),
                "generated_count": rb_counts[rb.id],
            })
        return render_template(
            "recurring_bills.html",
            rows=rows,
        )


def _config_display(recurrence: str, config: list[int]) -> str:
    if recurrence == "daily":
        return "every day"
    if recurrence == "weekly":
        days = [WEEKDAY_NAMES[i] for i in config if 0 <= i <= 6]
        return "every " + (", ".join(days) if days else "week")
    if recurrence == "monthly":
        def ordinal(n: int) -> str:
            s = {1: "st", 2: "nd", 3: "rd"}
            return f"{n}{s.get(n if n < 20 else n % 10, 'th')}"
        days = [ordinal(d) for d in config if 1 <= d <= 31]
        return "monthly on the " + (", ".join(days) if days else "1st")
    if recurrence == "yearly":
        months = [MONTH_NAMES[m - 1] for m in config if 1 <= m <= 12]
        return "yearly in " + (", ".join(months) if months else "January")
    return recurrence


@bp.route("/recurring/new", methods=["GET", "POST"])
def recurring_new():
    with get_session() as s:
        units = s.scalars(select(Unit).order_by(Unit.name)).all()
        kinds = _kind_names(s)
        if request.method == "POST":
            rb = _build_recurring_bill(request.form)
            s.add(rb)
            s.flush()
            for uid in request.form.getlist("unit_ids"):
                s.add(RecurringBillUnit(recurring_bill_id=rb.id, unit_id=int(uid)))
            flash("Recurring bill added.")
            return redirect(url_for("main.recurring_list"))
        return render_template(
            "recurring_bill_form.html",
            rb=None,
            units=units,
            kinds=kinds,
            selected_ids=set(),
            weekday_names=WEEKDAY_NAMES,
            month_names=MONTH_NAMES,
            selected_config=[],
        )


@bp.route("/recurring/<int:rid>/edit", methods=["GET", "POST"])
def recurring_edit(rid: int):
    with get_session() as s:
        rb = s.get(RecurringBill, rid)
        if rb is None:
            return redirect(url_for("main.recurring_list"))
        units = s.scalars(select(Unit).order_by(Unit.name)).all()
        kinds = _kind_names(s)
        if request.method == "POST":
            rb.kind = request.form["kind"]
            rb.amount = float(request.form["amount"])
            rb.note = request.form.get("note", "").strip()
            rb.recurrence = request.form["recurrence"]
            rb.recurrence_config = _parse_recurrence_config(request.form)
            rb.start_date = _parse_date(request.form["start_date"])
            rb.active = "active" in request.form
            for rbu in list(s.scalars(
                select(RecurringBillUnit).where(RecurringBillUnit.recurring_bill_id == rid)
            ).all()):
                s.delete(rbu)
            s.flush()
            for uid in request.form.getlist("unit_ids"):
                s.add(RecurringBillUnit(recurring_bill_id=rid, unit_id=int(uid)))
            flash("Recurring bill updated.")
            return redirect(url_for("main.recurring_list"))
        selected_ids = {
            rbu.unit_id
            for rbu in s.scalars(
                select(RecurringBillUnit).where(RecurringBillUnit.recurring_bill_id == rid)
            ).all()
        }
        selected_config = json.loads(rb.recurrence_config or "[]")
        return render_template(
            "recurring_bill_form.html",
            rb=rb,
            units=units,
            kinds=kinds,
            selected_ids=selected_ids,
            weekday_names=WEEKDAY_NAMES,
            month_names=MONTH_NAMES,
            selected_config=selected_config,
        )


@bp.route("/recurring/<int:rid>/delete", methods=["POST"])
def recurring_delete(rid: int):
    with get_session() as s:
        rb = s.get(RecurringBill, rid)
        if rb:
            s.delete(rb)
            flash("Recurring bill removed.")
    return redirect(url_for("main.recurring_list"))


@bp.route("/recurring/<int:rid>/toggle", methods=["POST"])
def recurring_toggle(rid: int):
    with get_session() as s:
        rb = s.get(RecurringBill, rid)
        if rb:
            rb.active = not rb.active
            flash(f"Recurring bill {'activated' if rb.active else 'paused'}.")
    return redirect(url_for("main.recurring_list"))


def _parse_recurrence_config(form) -> str:
    recurrence = form.get("recurrence", "daily")
    if recurrence == "daily":
        return "[]"
    if recurrence == "weekly":
        values = [int(v) for v in form.getlist("config_weekly") if v.isdigit()]
        return json.dumps(sorted(values))
    if recurrence == "monthly":
        values = [int(v) for v in form.getlist("config_monthly") if v.isdigit()]
        return json.dumps(sorted(values))
    if recurrence == "yearly":
        values = [int(v) for v in form.getlist("config_yearly") if v.isdigit()]
        return json.dumps(sorted(values))
    return "[]"


def _build_recurring_bill(form) -> RecurringBill:
    return RecurringBill(
        kind=form["kind"],
        amount=float(form["amount"]),
        note=form.get("note", "").strip(),
        recurrence=form["recurrence"],
        recurrence_config=_parse_recurrence_config(form),
        start_date=_parse_date(form["start_date"]),
        active="active" in form,
    )


# ---------------- Users (admin only) ----------------


@bp.route("/users")
def users_list():
    _require_admin()
    with get_session() as s:
        users = s.scalars(select(AuthorizedUser).order_by(AuthorizedUser.email)).all()
        return render_template("users.html", users=users, admin_email=admin_email())


@bp.route("/users/new", methods=["GET", "POST"])
def users_new():
    _require_admin()
    if request.method == "POST":
        email = request.form["email"].strip().lower()
        with get_session() as s:
            existing = s.scalar(select(AuthorizedUser).where(AuthorizedUser.email == email))
            if existing:
                flash(f"{email} is already authorized.")
            else:
                s.add(AuthorizedUser(email=email))
                flash(f"Added {email}.")
        return redirect(url_for("main.users_list"))
    return render_template("user_form.html", user=None)


@bp.route("/users/<int:uid>/edit", methods=["GET", "POST"])
def users_edit(uid: int):
    _require_admin()
    with get_session() as s:
        user = s.get(AuthorizedUser, uid)
        if user is None:
            return redirect(url_for("main.users_list"))
        if request.method == "POST":
            new_email = request.form["email"].strip().lower()
            admin = admin_email()
            if user.email == admin and new_email != admin:
                flash("Cannot change the admin's email.")
                return redirect(url_for("main.users_list"))
            user.email = new_email
            flash("User updated.")
            return redirect(url_for("main.users_list"))
        return render_template("user_form.html", user=user)


@bp.route("/users/<int:uid>/delete", methods=["POST"])
def users_delete(uid: int):
    _require_admin()
    with get_session() as s:
        user = s.get(AuthorizedUser, uid)
        if user is None:
            return redirect(url_for("main.users_list"))
        if user.email == admin_email():
            flash("Cannot remove the admin.")
            return redirect(url_for("main.users_list"))
        s.delete(user)
        flash(f"Removed {user.email}.")
    return redirect(url_for("main.users_list"))


# ---------------- Payments ----------------


@bp.route("/payments/<int:uid>/<int:year>/<int:month>/<kind>", methods=["GET", "POST"])
def payment_edit(uid: int, year: int, month: int, kind: str):
    """Create or edit a payment for a (unit, year, month, kind) cell."""
    with get_session() as s:
        unit = s.get(Unit, uid)
        if unit is None:
            return redirect(url_for("main.dashboard"))
        payment = s.scalar(
            select(Payment).where(
                Payment.unit_id == uid,
                Payment.year == year,
                Payment.month == month,
                Payment.kind == kind,
            )
        )
        if request.method == "POST":
            amount = float(request.form["amount"])
            if payment is None:
                s.add(
                    Payment(unit_id=uid, year=year, month=month, kind=kind, amount=amount)
                )
                flash(f"Recorded ${amount:.2f} payment for {unit.name} ({kind}).")
            else:
                payment.amount = amount
                flash(f"Updated payment for {unit.name} ({kind}).")
            return redirect(url_for("main.dashboard"))
        # Owed amount for pre-fill: recompute from bills.
        owed = _compute_cell_amount(s, uid, year, month, kind)
        return render_template(
            "payment_form.html",
            unit=unit,
            year=year,
            month=month,
            kind=kind,
            owed=owed,
            payment=payment,
        )


def _compute_cell_amount(s, unit_id: int, year: int, month: int, kind: str) -> float:
    """Recompute what `unit_id` owes for (year, month, kind) from current bills + occupancies."""
    bills = s.scalars(
        select(Bill)
        .where(Bill.kind == kind)
        .options(selectinload(Bill.assignments).selectinload(BillUnit.unit))
    ).all()
    bills = [b for b in bills if bill_due_date(b.end_date).year == year
             and bill_due_date(b.end_date).month == month]
    if not bills:
        return 0.0
    unit_ids = {a.unit_id for b in bills for a in b.assignments}
    occ_map: dict[int, list[Occupancy]] = defaultdict(list)
    if unit_ids:
        for o in s.scalars(select(Occupancy).where(Occupancy.unit_id.in_(unit_ids))).all():
            occ_map[o.unit_id].append(o)
    total = 0.0
    for b in bills:
        for sh in split_bill(b, occ_map):
            if sh.unit_id == unit_id:
                total += sh.amount
    return round(total, 2)

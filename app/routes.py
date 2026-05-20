from collections import defaultdict
from datetime import date, datetime

from flask import Blueprint, flash, redirect, render_template, request, url_for
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.auth import current_email, is_admin, is_authorized
from app.billing import bill_due_date, split_bill
from app.db import AuthorizedUser, Bill, BillUnit, Occupancy, Unit, admin_email, get_session

bp = Blueprint("main", __name__)


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

        months = []
        for key in sorted(by_month.keys(), reverse=True):
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
                unit_rows.append(
                    {
                        "unit_name": unit_name,
                        "by_kind": [round(by_kind.get(k, 0.0), 2) for k in kinds_sorted],
                        "total": round(row_total, 2),
                    }
                )

            months.append(
                {
                    "year": key[0],
                    "month": key[1],
                    "kinds": kinds_sorted,
                    "unit_rows": unit_rows,
                    "bill_rows": bill_rows,
                }
            )
        return render_template("dashboard.html", months=months)


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
            return redirect(url_for("main.units_list"))
        return render_template("occ_form.html", unit=unit, occ=None)


@bp.route("/occupancies/<int:oid>/edit", methods=["GET", "POST"])
def occ_edit(oid: int):
    with get_session() as s:
        occ = s.get(Occupancy, oid)
        if occ is None:
            return redirect(url_for("main.units_list"))
        if request.method == "POST":
            occ.tenant_count = int(request.form["tenant_count"])
            occ.start_date = _parse_date(request.form["start_date"])
            occ.end_date = _parse_date(request.form["end_date"])
            flash("Occupancy updated.")
            return redirect(url_for("main.units_list"))
        return render_template("occ_form.html", unit=occ.unit, occ=occ)


@bp.route("/occupancies/<int:oid>/delete", methods=["POST"])
def occ_delete(oid: int):
    with get_session() as s:
        occ = s.get(Occupancy, oid)
        if occ:
            s.delete(occ)
            flash("Occupancy removed.")
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
        return render_template("bill_form.html", bill=None, units=units, selected_ids=set())


@bp.route("/bills/<int:bid>/edit", methods=["GET", "POST"])
def bills_edit(bid: int):
    with get_session() as s:
        bill = s.get(Bill, bid)
        if bill is None:
            return redirect(url_for("main.bills_list"))
        units = s.scalars(select(Unit).order_by(Unit.name)).all()
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
        return render_template("bill_form.html", bill=bill, units=units, selected_ids=selected)


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

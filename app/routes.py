from collections import defaultdict
from datetime import date, datetime

from flask import Blueprint, Response, flash, redirect, render_template, request, url_for

from app import db
from app.auth import current_email, is_admin, is_authorized
from app.billing import bill_due_date, recurring_instances, split_bill
from app.db import admin_email
from app.pdf import build_section_for_occupancy, build_statement_pdf

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


def _parse_optional_date(value):
    if not value or not value.strip():
        return None
    return _parse_date(value.strip())


@bp.route("/")
def index():
    return redirect(url_for("main.dashboard"))


@bp.route("/dashboard")
def dashboard():
    # Apply any recurring templates on dashboard view too, so the dashboard
    # reflects bills due as of today even if the Bills page hasn't been hit.
    _apply_recurring_bills()

    all_bills = db.bills_with_assignments()

    unit_ids = {a.unit_id for b in all_bills for a in b.assignments}
    occ_map = db.occupancies_for_units(unit_ids) if unit_ids else {}

    # Group bills by (year, month) of their due date.
    by_month: dict[tuple[int, int], list] = defaultdict(list)
    for b in all_bills:
        due = bill_due_date(b.end_date)
        by_month[(due.year, due.month)].append(b)

    units_by_id = {u.id: u for u in db.units_all()}
    name_to_id = {u.name: u.id for u in units_by_id.values()}

    pay_map: dict[tuple[int, int, int, str], db.Payment] = {
        (p.unit_id, p.year, p.month, p.kind): p for p in db.payments_all()
    }

    outstanding: dict[str, float] = defaultdict(float)
    months = []
    for key in sorted(by_month.keys(), reverse=True):
        year, month = key
        bills = sorted(by_month[key], key=lambda b: (b.kind.lower(), b.end_date))
        bill_rows = []
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
                cells.append({
                    "kind": k, "amount": owed, "paid": paid,
                    "remaining": remaining, "has_payment": payment is not None,
                })
                if owed > 0:
                    outstanding[unit_name] += max(remaining, 0.0)
            unit_rows.append({
                "unit_name": unit_name, "unit_id": uid,
                "cells": cells, "total": round(row_total, 2),
            })

        months.append({
            "year": year, "month": month, "kinds": kinds_sorted,
            "unit_rows": unit_rows, "bill_rows": bill_rows,
        })

    outstanding_rows = [
        (name, round(amt, 2))
        for name, amt in sorted(outstanding.items())
        if round(amt, 2) > 0
    ]
    return render_template(
        "dashboard.html", months=months, outstanding_rows=outstanding_rows
    )


# ---------------- PDF statements ----------------


@bp.route("/pdf")
def pdf_picker():
    return render_template("pdf_picker.html", units=db.units_with_occupancies())


@bp.route("/pdf/generate", methods=["POST"])
def pdf_generate():
    raw = request.form.getlist("selection")
    pairs: list[tuple[int, int]] = []
    for value in raw:
        try:
            uid_str, oid_str = value.split(":", 1)
            pairs.append((int(uid_str), int(oid_str)))
        except (ValueError, AttributeError):
            continue
    if not pairs:
        flash("Pick at least one unit/tenant set to generate a PDF.")
        return redirect(url_for("main.pdf_picker"))

    sections = []
    by_unit: dict[int, list[int]] = defaultdict(list)
    for uid, oid in pairs:
        by_unit[uid].append(oid)

    for uid, occ_ids in by_unit.items():
        unit = db.unit_by_id(uid)
        if unit is None:
            continue
        bills_for_unit = db.bills_for_unit(uid, with_assignments=True)
        related_unit_ids = {uid} | {a.unit_id for b in bills_for_unit for a in b.assignments}
        occ_map = db.occupancies_for_units(related_unit_ids)
        payments_for_unit = {
            (p.year, p.month, p.kind): p.amount
            for p in db.payments_all() if p.unit_id == uid
        }
        for oid in occ_ids:
            occ = next((o for o in occ_map.get(uid, []) if o.id == oid), None)
            if occ is None:
                continue
            sections.append(
                build_section_for_occupancy(
                    unit, occ, bills_for_unit, occ_map, payments_for_unit,
                )
            )

    pdf_bytes = build_statement_pdf(sections)
    filename = f"statement-{date.today().isoformat()}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------- Units ----------------


@bp.route("/units")
def units_list():
    return render_template("units.html", units=db.units_with_occupancies())


@bp.route("/units/manage", methods=["GET", "POST"])
def units_manage():
    if request.method == "POST":
        existing_ids = request.form.getlist("existing_id")
        existing_names = request.form.getlist("existing_name")
        new_names = request.form.getlist("new_name")
        renamed, added = 0, 0
        for sid, raw_name in zip(existing_ids, existing_names):
            name = raw_name.strip()
            if not name or not sid.isdigit():
                continue
            unit = db.unit_by_id(int(sid))
            if unit and unit.name != name:
                db.unit_update(unit.id, name=name)
                renamed += 1
        for raw_name in new_names:
            name = raw_name.strip()
            if not name:
                continue
            db.unit_create(name=name, note="")
            added += 1
        if renamed or added:
            parts = []
            if added:
                parts.append(f"added {added} unit{'s' if added != 1 else ''}")
            if renamed:
                parts.append(f"renamed {renamed}")
            flash("Units: " + ", ".join(parts) + ".")
        return redirect(url_for("main.units_manage"))

    return render_template("manage_units.html", units=db.units_all())


@bp.route("/units/new", methods=["GET", "POST"])
def units_new():
    if request.method == "POST":
        name = request.form["name"].strip()
        note = request.form.get("note", "").strip()
        db.unit_create(name=name, note=note)
        flash(f"Unit '{name}' added.")
        return redirect(url_for("main.units_manage"))
    return render_template("unit_form.html", unit=None)


@bp.route("/units/<int:uid>/edit", methods=["GET", "POST"])
def units_edit(uid: int):
    units_with_occs = db.units_with_occupancies()
    unit = next((u for u in units_with_occs if u.id == uid), None)
    if unit is None:
        flash("Unit not found.")
        return redirect(url_for("main.units_list"))
    if request.method == "POST":
        db.unit_update(
            uid,
            name=request.form["name"].strip(),
            note=request.form.get("note", "").strip(),
        )
        flash("Unit updated.")
        return redirect(url_for("main.units_manage"))
    return render_template("unit_form.html", unit=unit)


@bp.route("/units/<int:uid>/delete", methods=["POST"])
def units_delete(uid: int):
    unit = db.unit_by_id(uid)
    if unit:
        db.unit_delete(uid)
        flash(f"Unit '{unit.name}' removed.")
    return redirect(url_for("main.units_list"))


# ---------------- Occupancies ----------------


@bp.route("/units/<int:uid>/occupancies/new", methods=["GET", "POST"])
def occ_new(uid: int):
    unit = db.unit_by_id(uid)
    if unit is None:
        return redirect(url_for("main.units_list"))
    if request.method == "POST":
        db.occupancy_create(
            unit_id=uid,
            tenant_count=int(request.form["tenant_count"]),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_date(request.form["end_date"]),
        )
        flash("Occupancy added.")
        return redirect(url_for("main.units_edit", uid=uid))
    return redirect(url_for("main.units_edit", uid=uid))


@bp.route("/occupancies/<int:oid>/edit", methods=["GET", "POST"])
def occ_edit(oid: int):
    occ = db.occupancy_by_id(oid)
    if occ is None:
        return redirect(url_for("main.units_list"))
    uid = occ.unit_id
    if request.method == "POST":
        db.occupancy_update(
            oid,
            tenant_count=int(request.form["tenant_count"]),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_date(request.form["end_date"]),
        )
        flash("Occupancy updated.")
        return redirect(url_for("main.units_edit", uid=uid))
    return redirect(url_for("main.units_edit", uid=uid))


@bp.route("/occupancies/<int:oid>/delete", methods=["POST"])
def occ_delete(oid: int):
    occ = db.occupancy_by_id(oid)
    uid = occ.unit_id if occ else None
    if occ:
        db.occupancy_delete(oid)
        flash("Occupancy removed.")
    if uid:
        return redirect(url_for("main.units_edit", uid=uid))
    return redirect(url_for("main.units_list"))


# ---------------- Bills ----------------


@bp.route("/bills")
def bills_list():
    _apply_recurring_bills()
    bills = [b for b in db.bills_with_assignments() if b.recurring_bill_id is None]
    bills.sort(key=lambda b: b.end_date, reverse=True)
    recurring_rows = _recurring_summary_rows()
    return render_template("bills.html", bills=bills, recurring_rows=recurring_rows)


@bp.route("/bills/new", methods=["GET", "POST"])
def bills_new():
    units = db.units_all()
    kinds = db.category_names()
    if request.method == "POST":
        unit_ids = [int(x) for x in request.form.getlist("unit_ids")]
        db.bill_create(
            kind=request.form["kind"],
            amount=float(request.form["amount"]),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_date(request.form["end_date"]),
            note=request.form.get("note", "").strip(),
            unit_ids=unit_ids,
        )
        flash("Bill added.")
        return redirect(url_for("main.bills_list"))
    return render_template("bill_form.html", bill=None, units=units,
                            selected_ids=set(), kinds=kinds)


@bp.route("/bills/<int:bid>/edit", methods=["GET", "POST"])
def bills_edit(bid: int):
    bill = db.bill_by_id(bid, with_assignments=True)
    if bill is None:
        return redirect(url_for("main.bills_list"))
    units = db.units_all()
    kinds = db.category_names()
    if request.method == "POST":
        unit_ids = [int(x) for x in request.form.getlist("unit_ids")]
        db.bill_update(
            bid,
            kind=request.form["kind"],
            amount=float(request.form["amount"]),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_date(request.form["end_date"]),
            note=request.form.get("note", "").strip(),
            unit_ids=unit_ids,
        )
        flash("Bill updated.")
        return redirect(url_for("main.bills_list"))
    selected = {a.unit_id for a in bill.assignments}
    return render_template("bill_form.html", bill=bill, units=units,
                            selected_ids=selected, kinds=kinds)


@bp.route("/bills/<int:bid>/delete", methods=["POST"])
def bills_delete(bid: int):
    if db.bill_by_id(bid):
        db.bill_delete(bid)
        flash("Bill removed.")
    return redirect(url_for("main.bills_list"))


@bp.route("/bills/<int:bid>")
def bills_detail(bid: int):
    bill = db.bill_by_id(bid, with_assignments=True)
    if bill is None:
        return redirect(url_for("main.bills_list"))
    unit_ids = {a.unit_id for a in bill.assignments}
    occ_map = db.occupancies_for_units(unit_ids) if unit_ids else {}
    shares = split_bill(bill, occ_map)
    return render_template("bill_detail.html", bill=bill, shares=shares)


# ---------------- Categories (admin only; managed from the Bills page) ----------------


@bp.route("/categories")
def categories_list():
    _require_admin()
    return render_template("categories.html", categories=db.categories_all())


@bp.route("/categories/new", methods=["POST"])
def categories_new():
    _require_admin()
    name = request.form["name"].strip().lower()
    if not name:
        flash("Category name is required.")
        return redirect(url_for("main.categories_list"))
    if db.category_by_name(name):
        flash(f"'{name}' already exists.")
    else:
        db.category_create(name)
        flash(f"Added category '{name}'.")
    return redirect(url_for("main.categories_list"))


@bp.route("/categories/<int:cid>/delete", methods=["POST"])
def categories_delete(cid: int):
    _require_admin()
    cat = db.category_by_id(cid)
    if cat:
        db.category_delete(cid)
        flash(f"Removed category '{cat.name}'.")
    return redirect(url_for("main.categories_list"))


# ---------------- Recurring Bills ----------------


def _apply_recurring_bills() -> int:
    """Generate missing Bill instances for all active recurring templates up to
    today. Returns count of new bills created."""
    today = date.today()
    created = 0
    for rb in db.recurring_all():
        if not rb.active:
            continue
        existing_starts: set[date] = {
            b.start_date for b in db.bills_all() if b.recurring_bill_id == rb.id
        }
        unit_ids = db.recurring_unit_ids(rb.id)
        amount = -rb.amount if rb.is_credit else rb.amount
        for start, end in recurring_instances(rb, today):
            if start in existing_starts:
                continue
            db.bill_create(
                kind=rb.kind, amount=amount,
                start_date=start, end_date=end,
                note=rb.note, recurring_bill_id=rb.id,
                unit_ids=unit_ids,
            )
            existing_starts.add(start)
            created += 1
    return created


def _recurring_summary_rows() -> list[dict]:
    """Build display rows for all recurring templates — used by both the
    Bills-page section and the dedicated Recurring page."""
    rbs = db.recurring_with_assignments()
    bills_by_rid: dict[int, int] = defaultdict(int)
    for b in db.bills_all():
        if b.recurring_bill_id is not None:
            bills_by_rid[b.recurring_bill_id] += 1
    rows = []
    for rb in sorted(rbs, key=lambda r: (r.kind, r.id)):
        cfg = db.parse_recurrence_config(rb.recurrence_config)
        unit_names = sorted({a.unit.name for a in rb.assignments if a.unit})
        rows.append({
            "rb": rb,
            "is_credit": rb.is_credit,
            "unit_names": unit_names,
            "config_display": _config_display(rb.recurrence, cfg),
            "generated_count": bills_by_rid.get(rb.id, 0),
        })
    return rows


@bp.route("/recurring")
def recurring_list():
    created = _apply_recurring_bills()
    if created:
        flash(f"Generated {created} new bill{'s' if created != 1 else ''} from recurring templates.")
    rows = _recurring_summary_rows()
    return render_template("recurring_bills.html", rows=rows)


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
    units = db.units_all()
    kinds = db.category_names()
    if request.method == "POST":
        unit_ids = [int(x) for x in request.form.getlist("unit_ids")]
        rb = db.recurring_create(
            kind=request.form["kind"],
            amount=float(request.form["amount"]),
            note=request.form.get("note", "").strip(),
            recurrence=request.form["recurrence"],
            recurrence_config=_parse_recurrence_config(request.form),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_optional_date(request.form.get("end_date")),
            active="active" in request.form,
            is_credit=request.form.get("is_credit") == "1",
            unit_ids=unit_ids,
        )
        flash(f"Recurring {'credit' if rb.is_credit else 'bill'} added.")
        return redirect(url_for("main.recurring_list"))
    is_credit = request.args.get("credit") == "1"
    return render_template(
        "recurring_bill_form.html",
        rb=None, is_credit=is_credit,
        units=units, kinds=kinds,
        selected_ids=set(),
        weekday_names=WEEKDAY_NAMES, month_names=MONTH_NAMES,
        selected_config=[],
    )


@bp.route("/recurring/<int:rid>/edit", methods=["GET", "POST"])
def recurring_edit(rid: int):
    rb = db.recurring_by_id(rid)
    if rb is None:
        return redirect(url_for("main.recurring_list"))
    units = db.units_all()
    kinds = db.category_names()
    if request.method == "POST":
        new_is_credit = request.form.get("is_credit") == "1"
        unit_ids = [int(x) for x in request.form.getlist("unit_ids")]
        new_amount = float(request.form["amount"])
        update_fields = dict(
            kind=request.form["kind"],
            amount=new_amount,
            note=request.form.get("note", "").strip(),
            recurrence=request.form["recurrence"],
            recurrence_config=_parse_recurrence_config(request.form),
            start_date=_parse_date(request.form["start_date"]),
            end_date=_parse_optional_date(request.form.get("end_date")),
            active="active" in request.form,
            is_credit=new_is_credit,
        )
        db.recurring_update(rid, unit_ids=unit_ids, **update_fields)
        # If credit flag flipped, re-sign already-generated bills so totals
        # stay consistent with the new sign.
        if new_is_credit != rb.is_credit:
            signed = -abs(new_amount) if new_is_credit else abs(new_amount)
            for existing in db.bills_all():
                if existing.recurring_bill_id == rid:
                    db.bill_update(existing.id, amount=signed)
        flash(f"Recurring {'credit' if new_is_credit else 'bill'} updated.")
        return redirect(url_for("main.recurring_list"))
    selected_ids = set(db.recurring_unit_ids(rid))
    selected_config = db.parse_recurrence_config(rb.recurrence_config)
    return render_template(
        "recurring_bill_form.html",
        rb=rb, is_credit=rb.is_credit,
        units=units, kinds=kinds,
        selected_ids=selected_ids,
        weekday_names=WEEKDAY_NAMES, month_names=MONTH_NAMES,
        selected_config=selected_config,
    )


@bp.route("/recurring/<int:rid>/delete", methods=["POST"])
def recurring_delete(rid: int):
    if db.recurring_by_id(rid):
        db.recurring_delete(rid)
        flash("Recurring bill removed.")
    return redirect(url_for("main.recurring_list"))


@bp.route("/recurring/<int:rid>/toggle", methods=["POST"])
def recurring_toggle(rid: int):
    rb = db.recurring_by_id(rid)
    if rb:
        db.recurring_update(rid, active=not rb.active)
        flash(f"Recurring bill {'paused' if rb.active else 'activated'}.")
    return redirect(url_for("main.recurring_list"))


def _parse_recurrence_config(form) -> list[int]:
    recurrence = form.get("recurrence", "daily")
    if recurrence == "daily":
        return []
    field_name = {"weekly": "config_weekly", "monthly": "config_monthly",
                  "yearly": "config_yearly"}.get(recurrence)
    if not field_name:
        return []
    return sorted({int(v) for v in form.getlist(field_name) if v.isdigit()})


# ---------------- Users (admin only) ----------------


@bp.route("/users")
def users_list():
    _require_admin()
    return render_template("users.html", users=db.authorized_users_all(),
                            admin_email=admin_email())


@bp.route("/users/new", methods=["GET", "POST"])
def users_new():
    _require_admin()
    if request.method == "POST":
        email = request.form["email"].strip().lower()
        if db.authorized_user_by_email(email):
            flash(f"{email} is already authorized.")
        else:
            db.authorized_user_create(email)
            flash(f"Added {email}.")
        return redirect(url_for("main.users_list"))
    return render_template("user_form.html", user=None)


@bp.route("/users/<int:uid>/edit", methods=["GET", "POST"])
def users_edit(uid: int):
    _require_admin()
    user = db.authorized_user_by_id(uid)
    if user is None:
        return redirect(url_for("main.users_list"))
    if request.method == "POST":
        new_email = request.form["email"].strip().lower()
        admin = admin_email()
        if user.email == admin and new_email != admin:
            flash("Cannot change the admin's email.")
            return redirect(url_for("main.users_list"))
        db.authorized_user_update(uid, new_email)
        flash("User updated.")
        return redirect(url_for("main.users_list"))
    return render_template("user_form.html", user=user)


@bp.route("/users/<int:uid>/delete", methods=["POST"])
def users_delete(uid: int):
    _require_admin()
    user = db.authorized_user_by_id(uid)
    if user is None:
        return redirect(url_for("main.users_list"))
    if user.email == admin_email():
        flash("Cannot remove the admin.")
        return redirect(url_for("main.users_list"))
    db.authorized_user_delete(uid)
    flash(f"Removed {user.email}.")
    return redirect(url_for("main.users_list"))


# ---------------- Payments ----------------


@bp.route("/payments/<int:uid>/<int:year>/<int:month>/<kind>", methods=["GET", "POST"])
def payment_edit(uid: int, year: int, month: int, kind: str):
    unit = db.unit_by_id(uid)
    if unit is None:
        return redirect(url_for("main.dashboard"))
    payment = db.payment_lookup(uid, year, month, kind)
    if request.method == "POST":
        amount = float(request.form["amount"])
        db.payment_upsert(uid, year, month, kind, amount)
        if payment is None:
            flash(f"Recorded ${amount:.2f} payment for {unit.name} ({kind}).")
        else:
            flash(f"Updated payment for {unit.name} ({kind}).")
        return redirect(url_for("main.dashboard"))
    owed = _compute_cell_amount(uid, year, month, kind)
    return render_template(
        "payment_form.html",
        unit=unit, year=year, month=month, kind=kind,
        owed=owed, payment=payment,
    )


def _compute_cell_amount(unit_id: int, year: int, month: int, kind: str) -> float:
    """Recompute what `unit_id` owes for (year, month, kind) from current bills + occupancies."""
    bills = [
        b for b in db.bills_with_assignments()
        if b.kind == kind
        and bill_due_date(b.end_date).year == year
        and bill_due_date(b.end_date).month == month
    ]
    if not bills:
        return 0.0
    unit_ids = {a.unit_id for b in bills for a in b.assignments}
    occ_map = db.occupancies_for_units(unit_ids)
    total = 0.0
    for b in bills:
        for sh in split_bill(b, occ_map):
            if sh.unit_id == unit_id:
                total += sh.amount
    return round(total, 2)
